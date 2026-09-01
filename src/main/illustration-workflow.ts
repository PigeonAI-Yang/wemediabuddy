import { app, ipcMain } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  getContentProject,
  saveCoreVersion,
  type ContentProjectDetail
} from './content.ts';
import {
  getAsset,
  linkProjectAsset,
  markdownImageForAsset,
  registerStagedAsset,
  stageAssetBytes,
  type StagedAsset
} from './assets.ts';
import { readContentMediaBindings } from './media-bindings.ts';
import { generateMediaRecommendations, proposeMediaRecommendations } from './media-recommendations.ts';
import { listSourceMediaBindings, type SourceMediaBindingRecord } from './db/media-archive-store.ts';
import { sourceRevisionKey } from '../shared/media-candidates.ts';
import { splitContentClaims, type MediaClaimSegment, type MediaRecommendation } from '../shared/media-recommendations.ts';
import type { ContentMediaBindingDraft } from '../shared/media-bindings.ts';
import {
  ILLUSTRATION_IPC,
  ILLUSTRATION_RATIOS,
  type IllustrationCommandResult,
  type IllustrationImageConfig,
  type IllustrationItem,
  type IllustrationItemRetryInput,
  type IllustrationRegenerateInput,
  type IllustrationRun,
  type IllustrationRatio,
  type IllustrationStartInput,
  type IllustrationUndoInput
} from '../shared/illustration-workflow.ts';
import { readPiConfig, resolvePiConfigChain } from './pi-config.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies, ownerUiActor, freshRequestId } from './ipc-business-context.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { pngDimensionsFromBytes } from './png-dimensions.ts';

const IMAGE_CONFIG_VERSION = 1;
const MAX_GENERATED_ITEMS = 6;
const DEFAULT_RATIO: IllustrationRatio = '16:9';
const IMAGE_CONFIG_FILE = 'illustration-image-config.json';
const IMAGE_ENDPOINT_SUFFIX = '/images/generations';
const ALLOWED_RATIOS = new Set<string>(ILLUSTRATION_RATIOS);

type IllustrationPlanItem = {
  itemKey: string;
  kind: 'source' | 'generated';
  claimKey: string;
  purpose: 'direct_evidence' | 'demonstration' | 'comparison' | 'background' | 'cover' | 'decoration';
  ratio: IllustrationRatio;
  requestText: string;
  contextSummary: string;
  sourceRevisionKey: string | null;
  sourceBindingId: string | null;
  sourceAssetId: string | null;
};

type IllustrationPlan = { items: IllustrationPlanItem[] };

type ImageConfigFile = { version: 1; profileId: string; model: string };
type ResolvedImageConfig = {
  profileId: string;
  provider: string;
  baseUrl: string;
  api: 'openai-responses' | 'openai-completions';
  model: string;
  apiKey: string;
};

type WorkflowDependencies = BusinessIpcDependencies & {
  getImageConfigPath?: () => string;
};

class IllustrationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'IllustrationError';
    this.code = code;
    this.details = details;
  }
}

function nowIso(): string { return new Date().toISOString(); }
function bodyHash(body: string): string { return createHash('sha256').update(body, 'utf8').digest('hex'); }
function asJson(value: unknown): string { return JSON.stringify(value ?? {}); }
function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value ?? '')) as T; } catch { return fallback; }
}
function imageConfigPath(dependencies: WorkflowDependencies): string {
  return dependencies.getImageConfigPath?.() ?? path.join(app.getPath('userData'), IMAGE_CONFIG_FILE);
}
function validRatio(value: unknown): value is IllustrationRatio { return typeof value === 'string' && ALLOWED_RATIOS.has(value); }
function ratioToSize(ratio: IllustrationRatio): string {
  switch (ratio) {
    case '1:1': return '1024x1024';
    case '4:3': return '1152x864';
    case '3:4': return '864x1152';
    case '16:9': return '1536x864';
    case '9:16': return '864x1536';
    case '21:9': return '1536x658';
    case '9:21': return '658x1536';
  }
}
function errorValue(error: unknown): IllustrationError {
  if (error instanceof IllustrationError) return error;
  const value = error as { code?: unknown; details?: unknown; message?: unknown };
  return new IllustrationError(typeof value?.code === 'string' ? value.code : 'ILLUSTRATION_FAILED', error instanceof Error ? error.message : String(error), value?.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : undefined);
}

function mapItem(row: Record<string, unknown>): IllustrationItem {
  return Object.freeze({
    id: String(row.id), ordinal: Number(row.ordinal), itemKey: String(row.itemKey), kind: row.kind as IllustrationItem['kind'],
    claimKey: String(row.claimKey), purpose: row.purpose as IllustrationItem['purpose'], ratio: row.ratio as IllustrationRatio,
    requestText: String(row.requestText ?? ''), contextSummary: String(parseJson<{ summary?: string }>(row.contextJson, {}).summary ?? ''),
    sourceRevisionKey: (row.sourceRevisionKey as string | null) ?? null, sourceBindingId: (row.sourceBindingId as string | null) ?? null,
    sourceAssetId: (row.sourceAssetId as string | null) ?? null, assetId: (row.assetId as string | null) ?? null,
    previousAssetId: (row.previousAssetId as string | null) ?? null, state: row.state as IllustrationItem['state'], attempt: Number(row.attempt),
    errorCode: (row.errorCode as string | null) ?? null, errorMessage: (row.errorMessage as string | null) ?? null,
    contentVersionId: (row.contentVersionId as string | null) ?? null
  });
}

function readItems(database: DatabaseSync, runId: string): IllustrationItem[] {
  const rows = database.prepare(`SELECT id, ordinal, item_key AS itemKey, kind, claim_key AS claimKey, purpose, ratio,
    request_text AS requestText, context_json AS contextJson, source_revision_key AS sourceRevisionKey,
    source_binding_id AS sourceBindingId, source_asset_id AS sourceAssetId, asset_id AS assetId,
    previous_asset_id AS previousAssetId, state, attempt, error_code AS errorCode, error_message AS errorMessage,
    content_version_id AS contentVersionId FROM illustration_items WHERE run_id = ? ORDER BY ordinal`).all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapItem);
}

function mapRun(database: DatabaseSync, row: Record<string, unknown>): IllustrationRun {
  return Object.freeze({
    id: String(row.id), requestId: String(row.requestId), projectId: String(row.projectId), sourceVersionId: String(row.sourceVersionId),
    sourceRevision: Number(row.sourceRevision), sourceBodyHash: String(row.sourceBodyHash), sourceTitle: String(row.sourceTitle),
    sourceIds: parseJson<string[]>(row.sourceIdsJson, []), sourceRevisionKeys: parseJson<string[]>(row.sourceRevisionKeysJson, []),
    imageProfileId: (row.imageProfileId as string | null) ?? null, imageModel: (row.imageModel as string | null) ?? null,
    defaultRatio: validRatio(row.defaultRatio) ? row.defaultRatio : DEFAULT_RATIO, maxGenerated: Number.isInteger(Number(row.maxGenerated)) ? Math.min(MAX_GENERATED_ITEMS, Math.max(0, Number(row.maxGenerated))) : MAX_GENERATED_ITEMS,
    status: row.status as IllustrationRun['status'], targetVersionId: (row.targetVersionId as string | null) ?? null,
    failureCode: (row.failureCode as string | null) ?? null, failureMessage: (row.failureMessage as string | null) ?? null,
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), completedAt: (row.completedAt as string | null) ?? null,
    revision: Number(row.revision), items: readItems(database, String(row.id))
  });
}

function getRun(database: DatabaseSync, runId: string): IllustrationRun | null {
  const row = database.prepare(`SELECT id, request_id AS requestId, project_id AS projectId, source_version_id AS sourceVersionId,
    source_revision AS sourceRevision, source_body_hash AS sourceBodyHash, source_title AS sourceTitle,
    source_ids_json AS sourceIdsJson, source_revision_keys_json AS sourceRevisionKeysJson,
    image_profile_id AS imageProfileId, image_model AS imageModel, default_ratio AS defaultRatio, max_generated AS maxGenerated,
    status, target_version_id AS targetVersionId,
    failure_code AS failureCode, failure_message AS failureMessage, created_at AS createdAt, updated_at AS updatedAt,
    completed_at AS completedAt, revision FROM illustration_runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
  return row ? mapRun(database, row) : null;
}
function getRunRow(database: DatabaseSync, runId: string): Record<string, unknown> | null {
  return database.prepare('SELECT * FROM illustration_runs WHERE id = ?').get(runId) as Record<string, unknown> | null;
}
function getItemRow(database: DatabaseSync, itemId: string): Record<string, unknown> | null {
  return database.prepare('SELECT * FROM illustration_items WHERE id = ?').get(itemId) as Record<string, unknown> | null;
}

function projectSourceSnapshot(database: DatabaseSync, projectId: string): { sourceIds: string[]; sourceRevisionKeys: string[] } {
  const rows = database.prepare(`SELECT s.id, s.revision FROM content_project_sources cps
    JOIN source_items s ON s.id = cps.source_id WHERE cps.project_id = ? ORDER BY s.id`).all(projectId) as Array<{ id: string; revision: number }>;
  return { sourceIds: rows.map((row) => row.id), sourceRevisionKeys: rows.map((row) => sourceRevisionKey(row.id, row.revision)) };
}

function sourceBindings(database: DatabaseSync, revisionKeys: readonly string[]): SourceMediaBindingRecord[] {
  const rows: SourceMediaBindingRecord[] = [];
  for (const key of revisionKeys) rows.push(...listSourceMediaBindings(database, key).filter((row) => row.archivedAt == null && row.rightsStatus !== 'restricted' && row.kind !== 'video'));
  return rows.sort((a, b) => a.ordinal - b.ordinal || a.assetId.localeCompare(b.assetId));
}
function claimSupportsIllustration(claim: MediaClaimSegment): boolean {
  const semantic = claim.text
    .replace(/[`*_>#~|=\-—─]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...semantic].filter((character) => /[\p{L}\p{N}]/u.test(character)).length >= 2;
}

function illustrationStateFingerprint(run: Record<string, unknown>, items: readonly IllustrationItem[]): string {
  return createHash('sha256').update(JSON.stringify({
    targetVersionId: run.target_version_id ?? null,
    items: items.map((item) => ({ id: item.id, state: item.state, attempt: item.attempt, assetId: item.assetId, errorCode: item.errorCode }))
  })).digest('hex').slice(0, 16);
}

function buildDeterministicPlan(database: DatabaseSync, run: Record<string, unknown>, recommendations: readonly MediaRecommendation[]): IllustrationPlan {
  const body = String(run.source_body);
  const claims = splitContentClaims(body);
  const revisionKeys = parseJson<string[]>(run.source_revision_keys_json, []);
  const bindings = sourceBindings(database, revisionKeys);
  const recommendationByClaim = new Map<string, MediaRecommendation>();
  for (const recommendation of recommendations) if (!recommendationByClaim.has(recommendation.claimKey)) recommendationByClaim.set(recommendation.claimKey, recommendation);
  const usedAssets = new Set<string>();
  let generatedCount = 0;
  const items: IllustrationPlanItem[] = [];
  const defaultRatio = validRatio(run.default_ratio) ? run.default_ratio : DEFAULT_RATIO;
  const requestedMaxGenerated = Number(run.max_generated);
  const maxGenerated = Number.isInteger(requestedMaxGenerated) ? Math.min(MAX_GENERATED_ITEMS, Math.max(0, requestedMaxGenerated)) : MAX_GENERATED_ITEMS;
  for (const claim of claims) {
    if (!claimSupportsIllustration(claim)) continue;

    const recommended = recommendationByClaim.get(claim.key);
    const candidate = recommended ? bindings.find((binding) => binding.id === recommended.bindingId && !usedAssets.has(binding.assetId)) : undefined;
    if (candidate) {
      const asset = getAsset(database, candidate.assetId);
      if (asset) {
        usedAssets.add(candidate.assetId);
        items.push({ itemKey: `source:${claim.key}:${candidate.id}`, kind: 'source', claimKey: claim.key, purpose: recommended?.purpose ?? 'direct_evidence', ratio: defaultRatio, requestText: '', contextSummary: claim.excerpt, sourceRevisionKey: candidate.sourceRevisionKey, sourceBindingId: candidate.id, sourceAssetId: candidate.assetId });
        continue;
      }
    }
    if (generatedCount >= maxGenerated || !claim.text.trim()) continue;
    generatedCount += 1;
    items.push({ itemKey: `generated:${claim.key}`, kind: 'generated', claimKey: claim.key, purpose: claim.heading ? 'demonstration' : 'background', ratio: defaultRatio, requestText: `为“${claim.heading || '正文段落'}”制作有助于理解正文的配图：${claim.excerpt}`, contextSummary: claim.excerpt, sourceRevisionKey: null, sourceBindingId: null, sourceAssetId: null });
  }
  return { items };
}

function insertAfterAnchor(body: string, claim: MediaClaimSegment | undefined, markdown: string): string {
  if (!claim) return body.trimEnd() + `\n\n${markdown}\n`;
  const anchor = claim.text.trim();
  const start = anchor ? body.indexOf(anchor) : -1;
  if (start < 0) return body.trimEnd() + `\n\n${markdown}\n`;
  const paragraphEnd = body.indexOf('\n\n', start + anchor.length);
  const at = paragraphEnd < 0 ? body.length : paragraphEnd;
  return `${body.slice(0, at).trimEnd()}\n\n${markdown}${body.slice(at)}`;
}

function bodyWithImages(body: string, items: readonly IllustrationItem[], database: DatabaseSync): string {
  let next = body;
  const claims = new Map(splitContentClaims(body).map((claim) => [claim.key, claim]));
  for (const item of [...items].filter((item) => item.state === 'completed' && item.assetId).sort((a, b) => a.ordinal - b.ordinal)) {
    const asset = getAsset(database, item.assetId!);
    if (!asset) continue;
    const token = `wmb-asset://${asset.id}`;
    if (next.includes(token)) continue;
    next = insertAfterAnchor(next, claims.get(item.claimKey), markdownImageForAsset(asset, item.contextSummary || '配图'));
  }
  return next;
}

function imageDraftsForBody(body: string, items: readonly IllustrationItem[], existing: readonly ContentMediaBindingDraft[]): ContentMediaBindingDraft[] {
  const drafts: ContentMediaBindingDraft[] = existing.map((draft) => ({ ...draft }));
  const occurrence = new Map<string, number>();
  for (const draft of drafts) occurrence.set(draft.assetId, Math.max(occurrence.get(draft.assetId) ?? 0, draft.occurrence + 1));
  for (const item of [...items].filter((item) => item.state === 'completed' && item.assetId).sort((a, b) => a.ordinal - b.ordinal)) {
    const assetId = item.assetId!;
    if (!body.includes(`wmb-asset://${assetId}`)) continue;
    const nextOccurrence = occurrence.get(assetId) ?? 0;
    if (drafts.some((draft) => draft.assetId === assetId && draft.occurrence === nextOccurrence)) continue;
    drafts.push({ assetId, occurrence: nextOccurrence, widthPreset: 'full', align: 'center', caption: item.contextSummary || null, mediaKind: 'image' });
    occurrence.set(assetId, nextOccurrence + 1);
  }
  return drafts;
}

function readImageConfigFile(filePath: string): ImageConfigFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ImageConfigFile>;
    if (parsed.version !== IMAGE_CONFIG_VERSION || typeof parsed.profileId !== 'string' || typeof parsed.model !== 'string' || !parsed.profileId.trim() || !parsed.model.trim()) return null;
    return { version: IMAGE_CONFIG_VERSION, profileId: parsed.profileId.trim(), model: parsed.model.trim() };
  } catch { return null; }
}

export function readIllustrationImageConfig(dependencies: WorkflowDependencies): IllustrationImageConfig | null {
  const file = readImageConfigFile(imageConfigPath(dependencies));
  if (!file) return null;
  const profile = readPiConfig().profiles.find((candidate) => candidate.id === file.profileId);
  return { profileId: file.profileId, model: file.model, configured: Boolean(profile?.configured) };
}

export function saveIllustrationImageConfig(dependencies: WorkflowDependencies, input: { profileId: string; model: string }): IllustrationImageConfig {
  const profileId = String(input.profileId ?? '').trim();
  const model = String(input.model ?? '').trim();
  if (!profileId || !model) throw new IllustrationError('VALIDATION_ERROR', '请选择已配置的图像模型预设并填写模型名。');
  const profile = readPiConfig().profiles.find((candidate) => candidate.id === profileId);
  if (!profile || !profile.configured) throw new IllustrationError('IMAGE_PROFILE_NOT_CONFIGURED', '图像模型预设尚未配置 API。');
  if (!profile.capabilities.imageGeneration) throw new IllustrationError('IMAGE_PROFILE_NOT_CONFIGURED', '该 Provider 未声明图像生成能力。');
  const target = imageConfigPath(dependencies);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: IMAGE_CONFIG_VERSION, profileId, model }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
  return { profileId, model, configured: true };
}

function resolveImageConfig(dependencies: WorkflowDependencies, run: Record<string, unknown>): ResolvedImageConfig {
  const file = readImageConfigFile(imageConfigPath(dependencies));
  if (!file) throw new IllustrationError('IMAGE_MODEL_NOT_CONFIGURED', '尚未配置独立图像生成模型。');
  const profileId = String(run.image_profile_id ?? file.profileId).trim();
  const model = String(run.image_model ?? file.model).trim();
  const config = resolvePiConfigChain().find((candidate) => candidate.id === profileId);
  if (!config) throw new IllustrationError('IMAGE_PROFILE_NOT_FOUND', '图像模型预设不存在。');
  if (!config.apiKey) throw new IllustrationError('IMAGE_MODEL_NOT_CONFIGURED', '图像模型预设缺少 API 配置。');
  if (config.api === 'anthropic-messages') throw new IllustrationError('IMAGE_MODEL_NOT_CONFIGURED', 'Anthropic Messages 预设不能用于图像生成。');
  if (!config.capabilities.imageGeneration) throw new IllustrationError('IMAGE_MODEL_NOT_CONFIGURED', '该 Provider 未声明图像生成能力。');
  if (!model) throw new IllustrationError('IMAGE_MODEL_NOT_CONFIGURED', '图像模型名不能为空。');
  return { profileId, provider: config.name, baseUrl: config.baseUrl, api: config.api, model, apiKey: config.apiKey };
}

function imageEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}${IMAGE_ENDPOINT_SUFFIX}` : `${base}/v1${IMAGE_ENDPOINT_SUFFIX}`;
}

async function providerImage(config: ResolvedImageConfig, input: { prompt: string; ratio: IllustrationRatio; requestId: string }): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
  const response = await fetch(imageEndpoint(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: input.prompt, ratio: input.ratio, aspect_ratio: input.ratio, size: ratioToSize(input.ratio), n: 1, response_format: 'b64_json' })
  });
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'IMAGE_PROVIDER_AUTH' : response.status === 429 ? 'IMAGE_PROVIDER_RATE_LIMIT' : response.status >= 500 ? 'IMAGE_PROVIDER_UNAVAILABLE' : response.status === 400 ? 'IMAGE_REQUEST_REJECTED' : 'IMAGE_PROVIDER_ERROR';
    throw new IllustrationError(code, `图像生成服务返回 HTTP ${response.status}。`);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new IllustrationError('IMAGE_PROVIDER_INVALID_RESPONSE', '图像生成服务返回了无法解析的响应。'); }
  const payloadRecord = payload && typeof payload === 'object' ? payload as { data?: unknown } : {};
  const first = Array.isArray(payloadRecord.data) ? (payloadRecord.data[0] as Record<string, unknown> | undefined) : undefined;
  const b64 = typeof first?.b64_json === 'string' ? first.b64_json : typeof first?.base64 === 'string' ? first.base64 : null;
  const url = typeof first?.url === 'string' ? first.url : null;
  let bytes: Buffer;
  let mimeType = 'image/png';
  if (b64) {
    const normalized = b64.replace(/^data:[^;]+;base64,/, '');
    bytes = Buffer.from(normalized, 'base64');
  } else if (url) {
    const image = await fetch(url);
    if (!image.ok) throw new IllustrationError('IMAGE_PROVIDER_INVALID_RESPONSE', '图像生成服务图片地址不可读取。');
    mimeType = image.headers.get('content-type')?.split(';')[0]?.trim() || mimeType;
    bytes = Buffer.from(await image.arrayBuffer());
  } else {
    throw new IllustrationError('IMAGE_PROVIDER_INVALID_RESPONSE', '图像生成服务没有返回图片。');
  }
  if (bytes.byteLength === 0) throw new IllustrationError('IMAGE_PROVIDER_INVALID_RESPONSE', '图像生成服务返回空图片。');
  const extension = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  return { bytes, mimeType, fileName: `illustration-${input.requestId}${extension}` };
}

function insertGeneratedProvenance(database: DatabaseSync, assetId: string, input: { profileId: string; provider: string; model: string; prompt: string; requestId: string; ratio: IllustrationRatio }): void {
  const now = nowIso();
  database.prepare(`INSERT INTO asset_provenance (id, asset_id, kind, origin, generator, generation_prompt, generation_model, request_id, created_at)
    VALUES (?, ?, 'generated', ?, ?, ?, ?, ?, ?)`).run(randomUUID(), assetId, 'illustration-workflow', input.provider,
    JSON.stringify({ prompt: input.prompt, ratio: input.ratio }), input.model, input.requestId, now);
}

function classifyAssetDimensions(bytes: Buffer, mimeType: string): { width: number | null; height: number | null } {
  if (mimeType !== 'image/png') return { width: null, height: null };
  const dimensions = pngDimensionsFromBytes(bytes);
  return { width: dimensions?.width ?? null, height: dimensions?.height ?? null };
}

function insertRun(database: DatabaseSync, input: {
  id: string; requestId: string; projectId: string; sourceVersionId: string; sourceRevision: number; sourceBodyHash: string;
  sourceBody: string; sourceTitle: string; sourceIds: readonly string[]; sourceRevisionKeys: readonly string[]; imageProfileId: string | null; imageModel: string | null;
  defaultRatio: IllustrationRatio; maxGenerated: number;
}): void {
  const now = nowIso();
  database.prepare(`INSERT INTO illustration_runs (id, request_id, project_id, source_version_id, source_revision, source_body_hash,
    source_body, source_title, source_ids_json, source_revision_keys_json, image_profile_id, image_model, default_ratio, max_generated, status, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`).run(input.id, input.requestId, input.projectId,
    input.sourceVersionId, input.sourceRevision, input.sourceBodyHash, input.sourceBody, input.sourceTitle,
    asJson(input.sourceIds), asJson(input.sourceRevisionKeys), input.imageProfileId, input.imageModel, input.defaultRatio, input.maxGenerated, now, now);
}

function updateRun(database: DatabaseSync, runId: string, patch: Record<string, SQLInputValue | undefined>): void {
  const allowed = new Map<string, string>([
    ['status', 'status'], ['planJson', 'plan_json'], ['targetVersionId', 'target_version_id'], ['failureCode', 'failure_code'],
    ['failureMessage', 'failure_message'], ['completedAt', 'completed_at']
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const now = nowIso();
  const set = entries.map(([key]) => `${allowed.get(key)} = ?`).join(', ');
  database.prepare(`UPDATE illustration_runs SET ${set}, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(...entries.map(([, value]) => value ?? null), now, runId);
}

function updateItem(database: DatabaseSync, itemId: string, patch: Record<string, SQLInputValue | undefined>): void {
  const allowed = new Map<string, string>([
    ['ratio', 'ratio'], ['requestText', 'request_text'], ['assetId', 'asset_id'], ['previousAssetId', 'previous_asset_id'], ['state', 'state'],
    ['attempt', 'attempt'], ['errorCode', 'error_code'], ['errorMessage', 'error_message'], ['contentVersionId', 'content_version_id']
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const now = nowIso();
  const set = entries.map(([key]) => `${allowed.get(key)} = ?`).join(', ');
  database.prepare(`UPDATE illustration_items SET ${set}, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(...entries.map(([, value]) => value ?? null), now, itemId);
}

function insertPlan(database: DatabaseSync, runId: string, plan: IllustrationPlan): void {
  const run = getRunRow(database, runId);
  if (!run) throw new IllustrationError('NOT_FOUND', '配图运行不存在。');
  if (run.plan_json) return;
  const now = nowIso();
  const insert = database.prepare(`INSERT OR IGNORE INTO illustration_items (id, run_id, ordinal, item_key, kind, claim_key, purpose, ratio,
    request_text, context_json, source_revision_key, source_binding_id, source_asset_id, state, attempt, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, 1)`);
  plan.items.forEach((item, ordinal) => insert.run(randomUUID(), runId, ordinal, item.itemKey, item.kind, item.claimKey, item.purpose,
    item.ratio, item.requestText, asJson({ summary: item.contextSummary }), item.sourceRevisionKey, item.sourceBindingId, item.sourceAssetId, now, now));
  database.prepare('UPDATE illustration_runs SET plan_json = ?, status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(asJson(plan), 'running', now, runId);
}

function reconcilePlan(database: DatabaseSync, runId: string): IllustrationPlan {
  const run = getRunRow(database, runId);
  if (!run) throw new IllustrationError('NOT_FOUND', '配图运行不存在。');
  return parseJson<IllustrationPlan>(run.plan_json, { items: [] });
}

function latestVersion(database: DatabaseSync, projectId: string): { id: string; body: string } | null {
  return (database.prepare('SELECT id, body FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(projectId) as { id: string; body: string } | undefined) ?? null;
}

function finalizeRun(database: DatabaseSync, runId: string): IllustrationRun | null {
  const run = getRunRow(database, runId);
  if (!run) throw new IllustrationError('NOT_FOUND', '配图运行不存在。');
  const items = readItems(database, runId);
  const completed = items.filter((item) => item.state === 'completed' && item.assetId);
  const failed = items.filter((item) => item.state === 'failed');
  const pending = items.filter((item) => item.state === 'pending' || item.state === 'generating');
  if (pending.length) return getRun(database, runId);
  // A failed retry/regeneration must leave the already committed version untouched.
  if (run.target_version_id && failed.length) return getRun(database, runId);
  const latest = latestVersion(database, String(run.project_id));
  const expectedVersionId = run.target_version_id ? String(run.target_version_id) : String(run.source_version_id);
  if (!latest || latest.id !== expectedVersionId) {
    updateRun(database, runId, { status: 'conflicted', failureCode: 'STALE_CONTENT_VERSION', failureMessage: '正文已变化，旧配图结果未覆盖新版正文。', completedAt: nowIso() });
    return getRun(database, runId);
  }
  if (!completed.length) {
    updateRun(database, runId, { status: 'failed', failureCode: failed[0]?.errorCode ?? 'NO_SUCCESSFUL_ITEMS', failureMessage: failed[0]?.errorMessage ?? '没有成功配图项。', completedAt: nowIso() });
    return getRun(database, runId);
  }
  const sourceBindings = readContentMediaBindings(database, String(run.source_version_id));
  const body = bodyWithImages(String(run.source_body), items, database);
  if (run.target_version_id && latest.body === body) {
    updateRun(database, runId, { status: 'completed', failureCode: null, failureMessage: null, completedAt: nowIso() });
    return getRun(database, runId);
  }
  const drafts = imageDraftsForBody(body, items, sourceBindings.map((binding) => ({ assetId: binding.assetId, occurrence: binding.occurrence, widthPreset: binding.widthPreset, align: binding.align, caption: binding.caption, linkUrl: binding.linkUrl, mediaKind: binding.mediaKind })));
  const saved = saveCoreVersion(database, { projectId: String(run.project_id), body, expectedRevision: Number((database.prepare('SELECT revision FROM content_projects WHERE id = ?').get(String(run.project_id)) as { revision: number }).revision), author: 'ai', title: String(run.source_title), mediaBindings: drafts }, false);
  if (!saved.ok || !saved.data) throw new IllustrationError(saved.error?.code ?? 'SAVE_FAILED', saved.error?.message ?? '配图正文保存失败。');
  const versionId = saved.data.id;
  for (const item of completed) {
    updateItem(database, item.id, { contentVersionId: versionId, ...(run.target_version_id ? {} : { previousAssetId: null }) });
    linkProjectAsset(database, String(run.project_id), item.assetId!);
  }
  updateRun(database, runId, { targetVersionId: versionId, status: failed.length ? 'partial' : 'completed', failureCode: failed[0]?.errorCode ?? null, failureMessage: failed[0]?.errorMessage ?? null, completedAt: nowIso() });
  return getRun(database, runId);
}

function sourceItemComplete(database: DatabaseSync, itemId: string): void {
  const item = getItemRow(database, itemId);
  if (!item) throw new IllustrationError('NOT_FOUND', '配图项不存在。');
  const assetId = String(item.source_asset_id ?? '');
  if (!assetId || !getAsset(database, assetId)) throw new IllustrationError('SOURCE_ASSET_NOT_FOUND', '归档来源图片资产不存在。');
  updateItem(database, itemId, { assetId, state: 'completed', errorCode: null, errorMessage: null });
}

function generatedItemComplete(database: DatabaseSync, input: { itemId: string; staged: StagedAsset; provider: ResolvedImageConfig; prompt: string; requestId: string; ratio: IllustrationRatio }): void {
  const item = getItemRow(database, input.itemId);
  if (!item) throw new IllustrationError('NOT_FOUND', '配图项不存在。');
  const registered = registerStagedAsset(database, input.staged);
  const previous = item.asset_id ? String(item.asset_id) : null;
  insertGeneratedProvenance(database, registered.id, { profileId: input.provider.profileId, provider: input.provider.provider, model: input.provider.model, prompt: input.prompt, requestId: input.requestId, ratio: input.ratio });
  updateItem(database, input.itemId, { assetId: registered.id, previousAssetId: previous, state: 'completed', errorCode: null, errorMessage: null });
}

function itemFailed(database: DatabaseSync, itemId: string, error: IllustrationError): void {
  const item = getItemRow(database, itemId);
  if (!item) return;
  updateItem(database, itemId, { state: 'failed', errorCode: error.code, errorMessage: error.message });
}

async function readResponseImage(body: Buffer): Promise<Buffer> { return body; }

export class IllustrationWorkflow {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly dependencies: WorkflowDependencies;
  constructor(dependencies: WorkflowDependencies) { this.dependencies = dependencies; }

  async start(input: IllustrationStartInput): Promise<IllustrationRun> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const requestId = String(input.requestId ?? freshRequestId()).trim();
    if (!requestId) throw new IllustrationError('VALIDATION_ERROR', '缺少配图请求标识。');
    const existing = getRunByRequest(runtime.database, input.projectId, requestId);
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'planning' || existing.status === 'running') void this.resume(existing.id);
      return existing;
    }
    const project = getContentProject(runtime.database, input.projectId);
    if (!project || !project.revisions.length) throw new IllustrationError('CONTENT_VERSION_NOT_FOUND', '请先保存正文版本。');
    if (input.expectedRevision !== undefined && input.expectedRevision !== project.revision) throw new IllustrationError('REVISION_CONFLICT', '正文已更新，请重新加载后再定稿。');
    const latest = project.revisions[0]!;
    const ratio = input.ratio ?? DEFAULT_RATIO;
    const maxGenerated = input.maxGenerated ?? MAX_GENERATED_ITEMS;
    if (!validRatio(ratio)) throw new IllustrationError('VALIDATION_ERROR', '不支持的图片比例。');
    if (!Number.isInteger(maxGenerated) || maxGenerated < 0 || maxGenerated > MAX_GENERATED_ITEMS) throw new IllustrationError('VALIDATION_ERROR', '生成图片数量必须是 0 到 6。');
    const sources = projectSourceSnapshot(runtime.database, input.projectId);
    const config = readIllustrationImageConfig(this.dependencies);
    const runId = randomUUID();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'illustration.start', requestId, actor: ownerUiActor, input: { runId, projectId: input.projectId, sourceVersionId: latest.id },
      boundIdentity: { projectId: input.projectId, sourceVersionId: latest.id, sourceRevision: project.revision }, entityType: 'illustration_run',
      execute: (database) => { insertRun(database, { id: runId, requestId, projectId: input.projectId, sourceVersionId: latest.id, sourceRevision: project.revision,
        sourceBodyHash: bodyHash(latest.body), sourceBody: latest.body, sourceTitle: project.title, sourceIds: sources.sourceIds, sourceRevisionKeys: sources.sourceRevisionKeys,
        imageProfileId: input.imageProfileId ?? config?.profileId ?? null, imageModel: input.imageModel ?? config?.model ?? null, defaultRatio: ratio, maxGenerated }); return { data: runId, entityId: runId, afterRevision: 1 }; }
    });
    requireReceiptData(receipt);
    const result = getRun(runtime.database, runId);
    if (!result) throw new IllustrationError('READBACK_FAILED', '配图运行创建后无法读取。');
    void this.resume(runId);
    broadcastDataChanged({ scopes: ['studio'], reason: 'illustration.start' });
    return result;
  }

  async retry(input: IllustrationItemRetryInput): Promise<IllustrationRun> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRun(runtime.database, input.runId); const item = getItemRow(runtime.database, input.itemId);
    if (!run || !item || String(item.run_id) !== input.runId) throw new IllustrationError('NOT_FOUND', '配图运行或配图项不存在。');
    const requestId = String(input.requestId ?? `${run.requestId}:retry:${item.id}:${Number(item.attempt) + 1}`);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'illustration.item.retry', requestId, actor: ownerUiActor, input: { runId: input.runId, itemId: input.itemId },
      boundIdentity: { runId: input.runId, itemId: input.itemId }, entityType: 'illustration_item',
      execute: (database) => { const current = getItemRow(database, input.itemId); if (!current) throw new IllustrationError('NOT_FOUND', '配图项不存在。'); if (current.state !== 'failed') return { data: input.itemId, entityId: input.itemId };
        updateItem(database, input.itemId, { state: 'pending', attempt: Number(current.attempt) + 1, errorCode: null, errorMessage: null });
        updateRun(database, input.runId, { status: 'running', failureCode: null, failureMessage: null, completedAt: null }); return { data: input.itemId, entityId: input.itemId }; }
    });
    requireReceiptData(receipt); void this.resume(input.runId); return getRun(runtime.database, input.runId)!;
  }

  async regenerate(input: IllustrationRegenerateInput): Promise<IllustrationRun> {
    if (!validRatio(input.ratio)) throw new IllustrationError('VALIDATION_ERROR', '不支持的图片比例。');
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRun(runtime.database, input.runId); const item = getItemRow(runtime.database, input.itemId);
    if (!run || !item || String(item.run_id) !== input.runId) throw new IllustrationError('NOT_FOUND', '配图运行或配图项不存在。');
    if (item.kind !== 'generated' || !item.asset_id) throw new IllustrationError('VALIDATION_ERROR', '只有已生成配图可以原位重新生成。');
    const requestId = String(input.requestId ?? `${run.requestId}:regenerate:${item.id}:${Number(item.attempt) + 1}`);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'illustration.item.regenerate', requestId, actor: ownerUiActor, input: { runId: input.runId, itemId: input.itemId, ratio: input.ratio, request: String(input.request ?? '') },
      boundIdentity: { runId: input.runId, itemId: input.itemId }, entityType: 'illustration_item',
      execute: (database) => { const current = getItemRow(database, input.itemId); if (!current) throw new IllustrationError('NOT_FOUND', '配图项不存在。');
        updateItem(database, input.itemId, { state: 'pending', ratio: input.ratio, requestText: String(input.request ?? current.request_text ?? ''), attempt: Number(current.attempt) + 1, errorCode: null, errorMessage: null });
        updateRun(database, input.runId, { status: 'running', failureCode: null, failureMessage: null, completedAt: null }); return { data: input.itemId, entityId: input.itemId }; }
    });
    requireReceiptData(receipt); void this.resume(input.runId); return getRun(runtime.database, input.runId)!;
  }

  async undo(input: IllustrationUndoInput): Promise<IllustrationRun> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRun(runtime.database, input.runId); const item = getItemRow(runtime.database, input.itemId);
    if (!run || !item || String(item.run_id) !== input.runId) throw new IllustrationError('NOT_FOUND', '配图运行或配图项不存在。');
    if (!item.previous_asset_id) throw new IllustrationError('UNDO_NOT_AVAILABLE', '该配图没有可撤销的上一张图片。');
    const requestId = String(input.requestId ?? `${run.requestId}:undo:${item.id}:${Number(item.attempt) + 1}`);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'illustration.item.undo', requestId, actor: ownerUiActor, input: { runId: input.runId, itemId: input.itemId },
      boundIdentity: { runId: input.runId, itemId: input.itemId }, entityType: 'illustration_item',
      execute: (database) => { const current = getItemRow(database, input.itemId); if (!current?.previous_asset_id) return { data: input.itemId, entityId: input.itemId };
        updateItem(database, input.itemId, { assetId: String(current.previous_asset_id), previousAssetId: null, state: 'completed', errorCode: null, errorMessage: null });
        updateRun(database, input.runId, { status: 'running', failureCode: null, failureMessage: null, completedAt: null }); return { data: input.itemId, entityId: input.itemId }; }
    });
    requireReceiptData(receipt); const result = await this.finalize(input.runId); return result;
  }

  private async plan(runId: string): Promise<void> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRunRow(runtime.database, runId); if (!run || run.plan_json) return;
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'illustration.plan', requestId: `${run.request_id}:plan`, actor: ownerUiActor, input: { runId }, boundIdentity: { runId }, entityType: 'illustration_run',
      execute: (database) => {
        const drafts = generateMediaRecommendations(database, { contentVersionId: String(run.source_version_id), projectId: String(run.project_id), sourceRevisionKeys: parseJson<string[]>(run.source_revision_keys_json, []), allowGeneratedCover: false });
        const recommendations = proposeMediaRecommendations(database, { contentVersionId: String(run.source_version_id), projectId: String(run.project_id), requestId: `${run.request_id}:recommendations`, drafts });
        const plan = buildDeterministicPlan(database, run, recommendations);
        insertPlan(database, runId, plan);
        return { data: runId, entityId: runId };
      }
    });
    requireReceiptData(receipt);
  }
  private async recoverInterruptedItems(runId: string): Promise<void> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRunRow(runtime.database, runId);
    if (!run) return;
    for (const item of readItems(runtime.database, runId).filter((candidate) => candidate.state === 'generating')) {
      const receipt = await dispatchBusinessCommand(runtime, {
        command: 'illustration.item.recover',
        requestId: `${String(run.request_id)}:item:${item.id}:recover:${item.attempt}`,
        actor: ownerUiActor,
        input: { runId, itemId: item.id, interruptedAttempt: item.attempt },
        boundIdentity: { runId, itemId: item.id },
        entityType: 'illustration_item',
        execute: (database) => {
          const current = getItemRow(database, item.id);
          if (!current || current.state !== 'generating') return { data: item.id, entityId: item.id };
          updateItem(database, item.id, { state: 'pending', attempt: Number(current.attempt) + 1, errorCode: null, errorMessage: null });
          return { data: item.id, entityId: item.id };
        }
      });
      requireReceiptData(receipt);
    }
  }


  private async processItem(runId: string, item: IllustrationItem): Promise<void> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRunRow(runtime.database, runId);
    if (!run) return;
    const current = getItemRow(runtime.database, item.id);
    if (!current || current.state === 'completed' || current.state === 'generating') return;
    const attempt = Number(current.attempt);
    const startRequestId = `${run.request_id}:item:${item.id}:start:${attempt}`;
    const started = await dispatchBusinessCommand(runtime, {
      command: 'illustration.item.start', requestId: startRequestId, actor: ownerUiActor, input: { runId, itemId: item.id }, boundIdentity: { runId, itemId: item.id }, entityType: 'illustration_item',
      execute: (database) => { const row = getItemRow(database, item.id); if (!row) throw new IllustrationError('NOT_FOUND', '配图项不存在。'); if (row.state === 'completed') return { data: item.id, entityId: item.id };
        updateItem(database, item.id, { state: 'generating', errorCode: null, errorMessage: null }); return { data: item.id, entityId: item.id }; }
    });
    requireReceiptData(started);
    try {
      const row = getItemRow(runtime.database, item.id); if (!row) return;
      if (row.kind === 'source') {
        const receipt = await dispatchBusinessCommand(runtime, { command: 'illustration.item.source-complete', requestId: `${run.request_id}:item:${item.id}:source:${attempt}`, actor: ownerUiActor, input: { runId, itemId: item.id }, boundIdentity: { runId, itemId: item.id }, entityType: 'illustration_item', execute: (database) => { sourceItemComplete(database, item.id); return { data: item.id, entityId: item.id }; } });
        requireReceiptData(receipt); return;
      }
      const config = resolveImageConfig(this.dependencies, run);
      const prompt = [String(row.request_text ?? ''), `文章标题：${String(run.source_title)}`, `图片用途：${String(row.purpose ?? '')}`, `目标比例：${String(row.ratio ?? '')}`, `文章上下文：${String(parseJson<{ summary?: string }>(row.context_json, {}).summary ?? '')}`].filter(Boolean).join('\n');
      const providerRequestId = `${run.request_id}:item:${item.id}:attempt:${attempt}`;
      const generated = await providerImage(config, { prompt, ratio: row.ratio as IllustrationRatio, requestId: providerRequestId });
      const dimensions = classifyAssetDimensions(generated.bytes, generated.mimeType);
      const staged = await stageAssetBytes((await this.dependencies.loadSelectedDataRoot())!.path, { bytes: generated.bytes, fileName: generated.fileName, mimeType: generated.mimeType, origin: 'illustration-workflow', ...dimensions });
      try {
        const receipt = await dispatchBusinessCommand(runtime, { command: 'illustration.item.generated-complete', requestId: `${providerRequestId}:import`, actor: ownerUiActor, input: { runId, itemId: item.id, staged, provider: { profileId: config.profileId, provider: config.provider, model: config.model }, prompt, ratio: row.ratio, requestId: providerRequestId }, boundIdentity: { runId, itemId: item.id }, entityType: 'illustration_item', execute: (database) => { generatedItemComplete(database, { itemId: item.id, staged, provider: config, prompt, requestId: providerRequestId, ratio: row.ratio as IllustrationRatio }); return { data: item.id, entityId: item.id }; } });
        requireReceiptData(receipt);
      } catch (error) { await rm(path.join((await this.dependencies.loadSelectedDataRoot())!.path, ...staged.relativePath.split('/')), { force: true }).catch(() => {}); throw error; }
    } catch (error) {
      const failure = errorValue(error);
      const receipt = await dispatchBusinessCommand(runtime, { command: 'illustration.item.failed', requestId: `${run.request_id}:item:${item.id}:failed:${attempt}`, actor: ownerUiActor, input: { runId, itemId: item.id, code: failure.code, message: failure.message }, boundIdentity: { runId, itemId: item.id }, entityType: 'illustration_item', execute: (database) => { itemFailed(database, item.id, failure); if (getRunRow(database, runId)?.target_version_id) updateRun(database, runId, { status: 'partial', failureCode: failure.code, failureMessage: failure.message, completedAt: null }); return { data: item.id, entityId: item.id }; } });
      requireReceiptData(receipt);
    }
  }

  private async finalize(runId: string): Promise<IllustrationRun> {
    const runtime = await requireBusinessRuntime(this.dependencies);
    const run = getRunRow(runtime.database, runId);
    if (!run) throw new IllustrationError('NOT_FOUND', '配图运行不存在。');
    const fingerprint = illustrationStateFingerprint(run, readItems(runtime.database, runId));
    const receipt = await dispatchBusinessCommand(runtime, { command: 'illustration.finalize', requestId: `${String(run.request_id)}:finalize:${fingerprint}`, actor: ownerUiActor, input: { runId }, boundIdentity: { runId }, entityType: 'illustration_run', execute: (database) => { const value = finalizeRun(database, runId); return { data: value?.id ?? runId, entityId: runId }; } });
    requireReceiptData(receipt);
    const result = getRun(runtime.database, runId); if (!result) throw new IllustrationError('READBACK_FAILED', '配图运行读回失败。');
    broadcastDataChanged({ scopes: ['studio'], reason: 'illustration.finalize' });
    return result;
  }

  async resume(runId: string): Promise<IllustrationRun | null> {
    const existing = this.inflight.get(runId);
    if (existing) {
      await existing;
      const current = this.read(runId);
      return current?.items.some((item) => item.state === 'pending' || item.state === 'generating') ? this.resume(runId) : current;
    }
    const task = (async () => {
      await this.plan(runId);
      await this.recoverInterruptedItems(runId);
      while (true) {
        const runtime = await requireBusinessRuntime(this.dependencies);
        const run = getRun(runtime.database, runId);
        if (!run) return;
        const pending = run.items.filter((item) => item.state === 'pending');
        if (!pending.length) break;
        for (const item of pending) await this.processItem(runId, item);
      }
      await this.finalize(runId);
    })().catch(async (error) => {
      const failure = errorValue(error);
      await this.markRunFailed(runId, failure);
    }).finally(() => this.inflight.delete(runId));
    this.inflight.set(runId, task);
    await task;
    return this.read(runId);
  }


  private async markRunFailed(runId: string, failure: IllustrationError): Promise<void> {
    try {
      const runtime = await requireBusinessRuntime(this.dependencies);
      const fingerprint = createHash('sha256').update(`${failure.code}\0${failure.message}`).digest('hex').slice(0, 16);
      const receipt = await dispatchBusinessCommand(runtime, { command: 'illustration.run.failed', requestId: `${runId}:failed:${fingerprint}`, actor: ownerUiActor, input: { runId, code: failure.code, message: failure.message }, boundIdentity: { runId }, entityType: 'illustration_run', execute: (database) => { updateRun(database, runId, { status: 'failed', failureCode: failure.code, failureMessage: failure.message, completedAt: nowIso() }); return { data: runId, entityId: runId }; } });
      requireReceiptData(receipt);
    } catch { /* the original failure is retained by the caller's command result */ }
  }

  read(runId: string): IllustrationRun | null {
    const runtime = this.dependencies.getActiveRuntime(); return runtime ? getRun(runtime.database, runId) : null;
  }

  list(projectId: string): IllustrationRun[] {
    const runtime = this.dependencies.getActiveRuntime(); if (!runtime) return [];
    const rows = runtime.database.prepare('SELECT id, request_id AS requestId, project_id AS projectId, source_version_id AS sourceVersionId, source_revision AS sourceRevision, source_body_hash AS sourceBodyHash, source_title AS sourceTitle, source_ids_json AS sourceIdsJson, source_revision_keys_json AS sourceRevisionKeysJson, image_profile_id AS imageProfileId, image_model AS imageModel, default_ratio AS defaultRatio, max_generated AS maxGenerated, status, target_version_id AS targetVersionId, failure_code AS failureCode, failure_message AS failureMessage, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt, revision FROM illustration_runs WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapRun(runtime.database, row));
  }
}

function getRunByRequest(database: DatabaseSync, projectId: string, requestId: string): IllustrationRun | null {
  const row = database.prepare('SELECT id FROM illustration_runs WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as { id: string } | undefined;
  return row ? getRun(database, row.id) : null;
}

let registeredWorkflow: IllustrationWorkflow | null = null;

export function registerIllustrationWorkflowIpc(dependencies: WorkflowDependencies): IllustrationWorkflow {
  const workflow = new IllustrationWorkflow(dependencies);
  registeredWorkflow = workflow;
  ipcMain.handle(ILLUSTRATION_IPC.list, async (_event, projectId: string) => workflow.list(projectId));
  ipcMain.handle(ILLUSTRATION_IPC.get, async (_event, runId: string) => workflow.read(runId));
  ipcMain.handle(ILLUSTRATION_IPC.start, async (_event, input: IllustrationStartInput) => commandResult(() => workflow.start(input)));
  ipcMain.handle(ILLUSTRATION_IPC.retry, async (_event, input: IllustrationItemRetryInput) => commandResult(() => workflow.retry(input)));
  ipcMain.handle(ILLUSTRATION_IPC.regenerate, async (_event, input: IllustrationRegenerateInput) => commandResult(() => workflow.regenerate(input)));
  ipcMain.handle(ILLUSTRATION_IPC.undo, async (_event, input: IllustrationUndoInput) => commandResult(() => workflow.undo(input)));
  ipcMain.handle(ILLUSTRATION_IPC.imageConfigGet, () => readIllustrationImageConfig(dependencies));
  ipcMain.handle(ILLUSTRATION_IPC.imageConfigSave, (_event, input: { profileId: string; model: string }) => commandResult(() => saveIllustrationImageConfig(dependencies, input)));
  return workflow;
}

async function commandResult<T>(work: () => Promise<T> | T): Promise<IllustrationCommandResult<T>> {
  try { return { ok: true, data: await work(), error: null }; }
  catch (error) { const value = errorValue(error); return { ok: false, data: null, error: { code: value.code, message: value.message, details: value.details ?? null } }; }
}

export function illustrationWorkflow(): IllustrationWorkflow | null { return registeredWorkflow; }

export async function resumePendingIllustrationRuns(dependencies: WorkflowDependencies): Promise<void> {
  const runtime = dependencies.getActiveRuntime(); if (!runtime) return;
  const workflow = registeredWorkflow ?? new IllustrationWorkflow(dependencies);
  const rows = runtime.database.prepare("SELECT id FROM illustration_runs WHERE status IN ('pending', 'planning', 'running', 'partial') ORDER BY created_at").all() as Array<{ id: string }>;
  await Promise.all(rows.map((row) => workflow.resume(row.id)));
}
