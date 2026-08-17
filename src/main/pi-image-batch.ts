import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getContentProject, type ContentProjectDetail } from './content.ts';
import { getAsset, linkProjectAsset, registerStagedAsset, stageAssetBytes, type AssetRecord, type StagedAsset } from './assets.ts';
import {
  contentBindingKey,
  normalizeContentMediaBindings,
  type ContentMediaBinding,
  type ContentMediaBindingDraft,
  type MediaAlign,
  type MediaWidthPreset
} from '../shared/media-bindings.ts';
import { parseAssetImages, type StudioAssetImageRef } from '../shared/media-token.ts';
import {
  isPiImageAttachmentPayload,
  isPiImageMimeType,
  MAX_PI_IMAGE_ATTACHMENTS,
  MAX_PI_IMAGE_BYTES,
  MAX_PI_IMAGE_TOTAL_BYTES,
  normalizePiImageBatchMessage,
  piImageBatchManifestFence,
  PI_IMAGE_BATCH_MANIFEST_KEY,
  PI_IMAGE_MIME_TYPES,
  type PiImageAttachmentPayload,
  type PiImageBatchAttachmentDecision,
  type PiImageBatchAttachmentRecord,
  type PiImageBatchAttachmentState,
  type PiImageBatchChatInput,
  type PiImageBatchFailureStage,
  type PiImageBatchRecord,
  type PiImageBatchStatus,
  type PiImagePlacementManifest
} from '../shared/pi-image-batch.ts';


export type PreparedPiImageAttachment = Readonly<{
  ordinal: number;
  sourceFileName: string;
  sourceMimeType: PiImageAttachmentPayload['mimeType'];
  bytes: Buffer;
  byteCount: number;
  width: number | null;
  height: number | null;
  sourceSha256: string;
}>;

export type PiImageBatchBaseline = Readonly<{
  project: ContentProjectDetail;
  versionId: string | null;
  expectedRevision: number;
  body: string;
  bindings: readonly ContentMediaBinding[];
}>;

const BATCH_STATUS_RANK: Record<PiImageBatchStatus, number> = {
  queued: 0,
  importing: 1,
  analyzing: 2,
  saving: 3,
  completed: 4,
  failed_import: 4,
  failed_analysis: 4,
  conflicted: 4,
  failed_save: 4,
  canceled: 4
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeFileName(value: string): string {
  const normalized = value.replace(/[\\/\0]/g, '_').trim();
  return (normalized || 'image').slice(0, 240);
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error('图片数据编码无效。');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Error('图片数据编码无效。');
  return bytes;
}

function imageSignatureMatches(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') return bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a');
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function validDimension(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100_000 ? value as number : null;
}

export function preparePiImageAttachments(input: PiImageBatchChatInput): PreparedPiImageAttachment[] {
  if (!isPiImageBatchChatInputShape(input)) throw new Error('图片批次输入结构无效。');
  if (input.attachments.length > MAX_PI_IMAGE_ATTACHMENTS) throw new Error(`最多只能提交 ${MAX_PI_IMAGE_ATTACHMENTS} 张图片。`);
  const prepared: PreparedPiImageAttachment[] = [];
  let total = 0;
  for (let ordinal = 0; ordinal < input.attachments.length; ordinal += 1) {
    const item = input.attachments[ordinal];
    if (!isPiImageAttachmentPayload(item) || !isPiImageMimeType(item.mimeType)) throw new Error(`第 ${ordinal + 1} 张图片类型不受支持。`);
    const bytes = decodeBase64(item.bytesBase64);
    if (bytes.byteLength !== item.byteCount) throw new Error(`第 ${ordinal + 1} 张图片字节数不一致。`);
    if (bytes.byteLength > MAX_PI_IMAGE_BYTES) throw new Error(`第 ${ordinal + 1} 张图片超过单文件大小限制。`);
    if (!imageSignatureMatches(bytes, item.mimeType)) throw new Error(`第 ${ordinal + 1} 张图片内容无法按 ${item.mimeType} 解码。`);
    total += bytes.byteLength;
    if (total > MAX_PI_IMAGE_TOTAL_BYTES) throw new Error('本批图片总大小超过安全限制。');
    prepared.push({
      ordinal,
      sourceFileName: safeFileName(item.fileName),
      sourceMimeType: item.mimeType,
      bytes,
      byteCount: bytes.byteLength,
      width: validDimension(item.width),
      height: validDimension(item.height),
      sourceSha256: createHash('sha256').update(bytes).digest('hex')
    });
  }
  return prepared;
}

function isPiImageBatchChatInputShape(input: unknown): input is PiImageBatchChatInput {
  if (!input || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  return typeof value.message === 'string'
    && typeof value.requestId === 'string' && value.requestId.trim().length > 0
    && typeof value.projectId === 'string' && value.projectId.trim().length > 0
    && Array.isArray(value.attachments) && value.attachments.length > 0;
}

export function piImageBatchInputHash(input: { projectId: string; userMessage: string; attachments: readonly PreparedPiImageAttachment[] }): string {
  const canonical = JSON.stringify({
    projectId: input.projectId,
    message: normalizePiImageBatchMessage(input.userMessage),
    attachments: input.attachments.map((item) => ({
      ordinal: item.ordinal,
      fileName: item.sourceFileName,
      mimeType: item.sourceMimeType,
      byteCount: item.byteCount,
      width: item.width,
      height: item.height,
      sha256: item.sourceSha256
    }))
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function readPiImageBatch(database: DatabaseSync, batchId: string): PiImageBatchRecord | null {
  const row = database.prepare(`SELECT id, request_id AS requestId, project_id AS projectId,
    baseline_version_id AS baselineVersionId, expected_revision AS expectedRevision, input_hash AS inputHash,
    user_message AS userMessage, status, failure_stage AS failureStage, failure_code AS failureCode,
    failure_message AS failureMessage, placement_json AS placementJson, target_version_id AS targetVersionId, used_count AS usedCount,
    unused_count AS unusedCount, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt,
    revision FROM pi_image_batches WHERE id = ?`).get(batchId) as PiImageBatchRecord | undefined;
  if (!row) return null;
  return { ...row, attachments: readPiImageBatchAttachments(database, batchId) };
}

export function readPiImageBatchByRequest(database: DatabaseSync, projectId: string, requestId: string): PiImageBatchRecord | null {
  const row = database.prepare('SELECT id FROM pi_image_batches WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as { id: string } | undefined;
  return row ? readPiImageBatch(database, row.id) : null;
}

export function listPiImageBatches(database: DatabaseSync, projectId: string, limit = 20): PiImageBatchRecord[] {
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
  return (database.prepare('SELECT id FROM pi_image_batches WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?').all(projectId, safeLimit) as Array<{ id: string }>).map((row) => readPiImageBatch(database, row.id)!).filter(Boolean);
}

function readPiImageBatchAttachments(database: DatabaseSync, batchId: string): PiImageBatchAttachmentRecord[] {
  return database.prepare(`SELECT id, batch_id AS batchId, ordinal, source_file_name AS sourceFileName,
    source_mime_type AS sourceMimeType, byte_count AS byteCount, width, height, source_sha256 AS sourceSha256,
    asset_id AS assetId, state, decision_reason AS decisionReason, alt, caption, width_preset AS widthPreset,
    align, core_version_id AS coreVersionId, failure_code AS failureCode, failure_message AS failureMessage,
    created_at AS createdAt, updated_at AS updatedAt, revision
    FROM pi_image_batch_attachments WHERE batch_id = ? ORDER BY ordinal`).all(batchId) as PiImageBatchAttachmentRecord[];
}

export function createPiImageBatch(
  database: DatabaseSync,
  input: { requestId: string; projectId: string; userMessage: string; expectedRevision: number; baselineVersionId: string | null; inputHash: string; attachments: readonly PreparedPiImageAttachment[] }
): PiImageBatchRecord {
  const prior = readPiImageBatchByRequest(database, input.projectId, input.requestId);
  if (prior) {
    if (prior.inputHash !== input.inputHash) throw new Error('同一 requestId 已绑定不同的图片批次输入。');
    return prior;
  }
  const id = randomUUID();
  const createdAt = nowIso();
  database.prepare(`INSERT INTO pi_image_batches (
    id, request_id, project_id, baseline_version_id, expected_revision, input_hash, user_message, status,
    created_at, updated_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 1)`).run(
    id, input.requestId, input.projectId, input.baselineVersionId, input.expectedRevision, input.inputHash,
    normalizePiImageBatchMessage(input.userMessage), createdAt, createdAt
  );
  const statement = database.prepare(`INSERT INTO pi_image_batch_attachments (
    id, batch_id, ordinal, source_file_name, source_mime_type, byte_count, width, height, source_sha256,
    state, created_at, updated_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`);
  for (const attachment of input.attachments) statement.run(
    randomUUID(), id, attachment.ordinal, attachment.sourceFileName, attachment.sourceMimeType,
    attachment.byteCount, attachment.width, attachment.height, attachment.sourceSha256, createdAt, createdAt
  );
  return readPiImageBatch(database, id)!;
}

export function transitionPiImageBatch(
  database: DatabaseSync,
  input: { batchId: string; status: PiImageBatchStatus; failureStage?: PiImageBatchFailureStage | null; failureCode?: string | null; failureMessage?: string | null; placementJson?: string | null; targetVersionId?: string | null; usedCount?: number; unusedCount?: number }
): PiImageBatchRecord {
  const current = readPiImageBatch(database, input.batchId);
  if (!current) throw new Error('图片批次不存在。');
  const immutable = current.status === 'completed' || current.status === 'conflicted' || current.status === 'canceled';
  if (immutable && current.status !== input.status) return current;
  const restarting = current.status === 'failed_import' || current.status === 'failed_analysis' || current.status === 'failed_save';
  if (current.status !== input.status && BATCH_STATUS_RANK[input.status] < BATCH_STATUS_RANK[current.status] && !restarting) throw new Error('图片批次状态不可回退。');
  const terminal = input.status === 'completed' || input.status === 'conflicted' || input.status === 'canceled';
  const updatedAt = nowIso();
  database.prepare(`UPDATE pi_image_batches SET status = ?, failure_stage = ?, failure_code = ?, failure_message = ?, placement_json = COALESCE(?, placement_json),
    target_version_id = COALESCE(?, target_version_id), used_count = COALESCE(?, used_count), unused_count = COALESCE(?, unused_count),
    updated_at = ?, completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END, revision = revision + 1
    WHERE id = ?`).run(
    input.status,
    input.failureStage === undefined ? current.failureStage : input.failureStage,
    input.failureCode === undefined ? current.failureCode : input.failureCode,
    input.failureMessage === undefined ? current.failureMessage : input.failureMessage,
    input.placementJson ?? null,
    input.targetVersionId ?? null,
    input.usedCount ?? null,
    input.unusedCount ?? null,
    updatedAt,
    terminal ? 1 : 0,
    updatedAt,
    input.batchId
  );
  return readPiImageBatch(database, input.batchId)!;
}

export function markPiImageBatchAttachmentImport(
  database: DatabaseSync,
  input: { batchId: string; ordinal: number; state: 'importing' | 'imported' | 'failed'; assetId?: string | null; failureCode?: string | null; failureMessage?: string | null }
): PiImageBatchRecord {
  const existing = database.prepare('SELECT state FROM pi_image_batch_attachments WHERE batch_id = ? AND ordinal = ?').get(input.batchId, input.ordinal) as { state: PiImageBatchAttachmentState } | undefined;
  if (!existing) throw new Error('图片批次附件不存在。');
  if (existing.state === 'imported' || existing.state === 'used' || existing.state === 'unused') return readPiImageBatch(database, input.batchId)!;
  const updatedAt = nowIso();
  database.prepare(`UPDATE pi_image_batch_attachments SET state = ?, asset_id = COALESCE(?, asset_id),
    failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1
    WHERE batch_id = ? AND ordinal = ?`).run(
    input.state,
    input.assetId ?? null,
    input.failureCode ?? null,
    input.failureMessage ?? null,
    updatedAt,
    input.batchId,
    input.ordinal
  );
  return readPiImageBatch(database, input.batchId)!;
}

export function recordPiImageBatchDecisions(
  database: DatabaseSync,
  input: { batchId: string; decisions: readonly PiImageBatchAttachmentDecision[]; body?: string; mediaBindings?: readonly ContentMediaBindingDraft[]; coreVersionId?: string | null }
): PiImageBatchRecord {
  const batch = readPiImageBatch(database, input.batchId);
  if (!batch) throw new Error('图片批次不存在。');
  const byOrder = new Map(input.decisions.map((decision) => [decision.order, decision]));
  const update = database.prepare(`UPDATE pi_image_batch_attachments SET state = ?, decision_reason = ?, alt = ?, caption = ?,
    width_preset = ?, align = ?, core_version_id = ?, updated_at = ?, revision = revision + 1
    WHERE batch_id = ? AND ordinal = ?`);
  const updatedAt = nowIso();
  for (const attachment of batch.attachments) {
    const decision = byOrder.get(attachment.ordinal);
    if (!decision) throw new Error(`缺少第 ${attachment.ordinal + 1} 张图片的排图决策。`);
    update.run(
      decision.decision,
      decision.reason ?? null,
      decision.alt ?? null,
      decision.caption ?? null,
      decision.widthPreset ?? null,
      decision.align ?? null,
      input.coreVersionId ?? null,
      updatedAt,
      batch.id,
      attachment.ordinal
    );
  }
  const usedCount = input.decisions.filter((decision) => decision.decision === 'used').length;
  const placementJson = input.body === undefined || input.mediaBindings === undefined ? null : JSON.stringify({ body: input.body, decisions: input.decisions, mediaBindings: input.mediaBindings });
  return transitionPiImageBatch(database, { batchId: batch.id, status: batch.status, placementJson, usedCount, unusedCount: input.decisions.length - usedCount });
}

export function getPiImageBatchBaseline(database: DatabaseSync, projectId: string): PiImageBatchBaseline {
  const project = getContentProject(database, projectId);
  if (!project) throw new Error('内容项目不存在。');
  const latest = project.revisions[0] ?? null;
  return {
    project,
    versionId: latest?.id ?? null,
    expectedRevision: project.revision,
    body: latest?.body ?? '',
    bindings: latest?.bindings ?? []
  };
}

export async function stagePiImageAttachment(dataRoot: string, attachment: PreparedPiImageAttachment): Promise<StagedAsset> {
  return stageAssetBytes(dataRoot, {
    bytes: attachment.bytes,
    fileName: attachment.sourceFileName,
    mimeType: attachment.sourceMimeType,
    origin: 'pi-batch-image',
    width: attachment.width,
    height: attachment.height
  });
}

export function registerPiImageAttachment(database: DatabaseSync, projectId: string, staged: StagedAsset): { assetId: string; reused: boolean } {
  const registered = registerStagedAsset(database, staged);
  linkProjectAsset(database, projectId, registered.id);
  return { assetId: registered.id, reused: registered.reused };
}

function readAssetBytesFromRoot(dataRoot: string, asset: AssetRecord): Promise<Buffer> {
  const root = path.resolve(dataRoot);
  const absolute = path.resolve(root, ...asset.relativePath.split('/'));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('项目素材路径无效。');
  return readFile(absolute);
}

export async function readPiImageAssetBytes(dataRoot: string, database: DatabaseSync, assetId: string): Promise<{ asset: AssetRecord; bytes: Buffer }> {
  const asset = getAsset(database, assetId);
  if (!asset) throw new Error(`项目素材不存在：${assetId}`);
  if (!PI_IMAGE_MIME_TYPES.includes(asset.mimeType as typeof PI_IMAGE_MIME_TYPES[number])) throw new Error('批次素材 MIME 类型无效。');
  const bytes = await readAssetBytesFromRoot(dataRoot, asset);
  if (bytes.byteLength !== asset.byteCount) throw new Error('项目素材字节数与登记不一致。');
  return { asset, bytes };
}

export function buildPiImagePlacementPrompt(input: { batch: PiImageBatchRecord; baseline: PiImageBatchBaseline }): string {
  const existing = parseAssetImages(input.baseline.body).map((ref) => ({ assetId: ref.assetId, occurrence: ref.occurrence, alt: ref.alt }));
  const attachments = input.batch.attachments.map((attachment) => ({
    order: attachment.ordinal,
    assetId: attachment.assetId,
    fileName: attachment.sourceFileName,
    mimeType: attachment.sourceMimeType,
    width: attachment.width,
    height: attachment.height
  }));
  return [
    '你正在执行 WMB-5307 当前创作项目的批量图片排图任务。只能基于本条消息提供的正文和图片视觉内容判断，不得调用发布、平台适配或图片生成能力。',
    `projectId=${input.batch.projectId}`,
    `requestId=${input.batch.requestId}`,
    `baselineVersionId=${input.baseline.versionId ?? ''}`,
    `expectedRevision=${input.baseline.expectedRevision}`,
    `ownerMessage=${input.batch.userMessage}`,
    '',
    '# 当前完整核心正文（必须保留原有结构、文字和已有图片）',
    input.baseline.body,
    '',
    `# 当前正文已有图片引用（必须保留）：${JSON.stringify(existing)}`,
    `# 当前正文已有 mediaBindings（必须保留）：${JSON.stringify(input.baseline.bindings)}`,
    `# 本批次已持久化图片（视觉内容通过同一请求的 image 内容提供）：${JSON.stringify(attachments)}`,
    '',
    '请按正文语义选择图片。无关、重复、信息不足或会误导的图片必须 unused 并给出简短原因；不要为了用完素材而插图。每张本批图片默认最多采用一次。',
    'used 图片必须在完整目标 body 中以独占段落的 Markdown `![alt](wmb-asset://assetId)` 出现，并提供准确 alt、可选 caption、widthPreset（small/medium/large/full）与 align（left/center/right）。图片不得进入标题、代码围栏、表格或已有 token 内部。',
    '输出必须只包含一个 ```json 围栏块，不要输出解释文字。manifest 必须包含完整目标 body 和完整 mediaBindings；existing 图片 occurrence 与绑定不得丢失或改位。',
    '```json',
    JSON.stringify({
      [PI_IMAGE_BATCH_MANIFEST_KEY]: {
        requestId: input.batch.requestId,
        projectId: input.batch.projectId,
        baselineVersionId: input.baseline.versionId,
        expectedRevision: input.baseline.expectedRevision,
        body: '<完整目标 Markdown>',
        decisions: attachments.map((attachment) => ({ order: attachment.order, assetId: attachment.assetId, decision: 'used', reason: '', alt: '', caption: null, widthPreset: 'medium', align: 'center' })),
        mediaBindings: input.baseline.bindings
      }
    }),
    '```'
  ].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parsePiImagePlacementManifest(text: string): PiImagePlacementManifest[typeof PI_IMAGE_BATCH_MANIFEST_KEY] {
  const source = piImageBatchManifestFence(text);
  if (!source) throw new Error('Pi 未输出唯一的批量图片 JSON 清单。');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Pi 批量图片 JSON 清单格式无效。'); }
  const root = asRecord(value);
  const manifest = root ? asRecord(root[PI_IMAGE_BATCH_MANIFEST_KEY]) : null;
  if (!manifest) throw new Error('Pi 输出缺少批量图片清单。');
  if (typeof manifest.requestId !== 'string' || typeof manifest.projectId !== 'string' || typeof manifest.body !== 'string'
    || !Array.isArray(manifest.decisions) || !Array.isArray(manifest.mediaBindings)
    || !Number.isSafeInteger(manifest.expectedRevision)) throw new Error('Pi 批量图片清单字段不完整。');
  return manifest as unknown as PiImagePlacementManifest[typeof PI_IMAGE_BATCH_MANIFEST_KEY];
}

function sameBinding(a: ContentMediaBinding | ContentMediaBindingDraft, b: ContentMediaBinding | ContentMediaBindingDraft): boolean {
  return a.assetId === b.assetId && a.occurrence === b.occurrence && a.widthPreset === b.widthPreset && a.align === b.align
    && (a.caption ?? null) === (b.caption ?? null) && (a.linkUrl ?? null) === (b.linkUrl ?? null)
    && (a.mediaKind ?? 'image') === (b.mediaKind ?? 'image');
}

function sameKeySequence(refs: readonly StudioAssetImageRef[], expected: readonly StudioAssetImageRef[]): boolean {
  if (refs.length < expected.length) return false;
  let index = 0;
  for (const ref of refs) {
    const target = expected[index];
    if (target && ref.assetId === target.assetId && ref.occurrence === target.occurrence && ref.raw === target.raw) index += 1;
  }
  return index === expected.length;
}

function newImageIsStandaloneParagraph(body: string, ref: StudioAssetImageRef): boolean {
  const lineStart = body.lastIndexOf('\n', ref.start - 1) + 1;
  const lineEnd = body.indexOf('\n', ref.end);
  const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim();
  return line === ref.raw;
}
function nonImageContentLines(body: string, insertedRefs: readonly StudioAssetImageRef[]): string[] {
  const insertedTokens = new Set(insertedRefs.map((ref) => ref.raw));
  return body.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim() && !insertedTokens.has(line.trim()));
}

export function validatePiImagePlacement(
  manifest: PiImagePlacementManifest[typeof PI_IMAGE_BATCH_MANIFEST_KEY],
  input: { batch: PiImageBatchRecord; baseline: PiImageBatchBaseline }
): { body: string; decisions: PiImageBatchAttachmentDecision[]; mediaBindings: ContentMediaBindingDraft[] } {
  if (manifest.requestId !== input.batch.requestId || manifest.projectId !== input.batch.projectId) throw new Error('Pi 排图清单与冻结批次身份不一致。');
  if ((manifest.baselineVersionId ?? null) !== input.baseline.versionId || manifest.expectedRevision !== input.baseline.expectedRevision) throw new Error('Pi 排图清单基线已变化。');
  if (!manifest.body.trim()) throw new Error('Pi 排图结果正文为空。');
  if (manifest.decisions.length !== input.batch.attachments.length) throw new Error('Pi 未逐张返回图片决策。');
  const decisions: PiImageBatchAttachmentDecision[] = [];
  const batchAssetIds = new Set<string>();
  for (const attachment of input.batch.attachments) {
    if (!attachment.assetId) throw new Error('批次存在尚未导入的图片。');
    batchAssetIds.add(attachment.assetId);
    const raw = manifest.decisions.find((item) => asRecord(item)?.order === attachment.ordinal) as PiImageBatchAttachmentDecision | undefined;
    if (!raw || raw.order !== attachment.ordinal || raw.assetId !== attachment.assetId || (raw.decision !== 'used' && raw.decision !== 'unused')) throw new Error(`第 ${attachment.ordinal + 1} 张图片决策无效。`);
    if (raw.decision === 'unused') {
      if (typeof raw.reason !== 'string' || !raw.reason.trim()) throw new Error(`第 ${attachment.ordinal + 1} 张未采用图片缺少原因。`);
      decisions.push({ order: raw.order, assetId: raw.assetId, decision: 'unused', reason: raw.reason.trim().slice(0, 500) });
    } else {
      if (typeof raw.alt !== 'string' || !raw.alt.trim()) throw new Error(`第 ${attachment.ordinal + 1} 张采用图片缺少 alt。`);
      if (!raw.widthPreset || !['small', 'medium', 'large', 'full'].includes(raw.widthPreset) || !raw.align || !['left', 'center', 'right'].includes(raw.align)) throw new Error(`第 ${attachment.ordinal + 1} 张采用图片布局无效。`);
      decisions.push({ order: raw.order, assetId: raw.assetId, decision: 'used', reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 500) : undefined, alt: raw.alt.trim().slice(0, 500), caption: raw.caption == null ? null : String(raw.caption).trim().slice(0, 500), widthPreset: raw.widthPreset, align: raw.align });
    }
  }
  const refs = parseAssetImages(manifest.body);
  const baselineRefs = parseAssetImages(input.baseline.body);
  if (!sameKeySequence(refs, baselineRefs)) throw new Error('Pi 排图结果丢失或改写了既有图片 occurrence。');
  const baselineAssetIds = new Set(baselineRefs.map((ref) => ref.assetId));
  for (const ref of refs) if (!baselineAssetIds.has(ref.assetId) && !batchAssetIds.has(ref.assetId)) throw new Error('Pi 排图结果引用了未授权项目素材。');
  for (const decision of decisions) {
    const count = refs.filter((ref) => ref.assetId === decision.assetId && !baselineAssetIds.has(ref.assetId)).length;
    if (decision.decision === 'unused' && count !== 0) throw new Error(`未采用图片 ${decision.assetId} 不应出现在正文。`);
    if (decision.decision === 'used' && count !== 1) throw new Error(`采用图片 ${decision.assetId} 必须且只能出现一次。`);
    if (decision.decision === 'used') {
      const ref = refs.find((item) => item.assetId === decision.assetId && !baselineAssetIds.has(item.assetId));
      if (ref && !newImageIsStandaloneParagraph(manifest.body, ref)) throw new Error(`采用图片 ${decision.assetId} 必须独占一个正文段落。`);
    }
  }
  const insertedRefs = refs.filter((ref) => batchAssetIds.has(ref.assetId) && !baselineAssetIds.has(ref.assetId));
  if (JSON.stringify(nonImageContentLines(manifest.body, insertedRefs)) !== JSON.stringify(nonImageContentLines(input.baseline.body, []))) {
    throw new Error('Pi 排图只能插入图片，不能改写现有正文内容或格式。');
  }
  const normalizedBindings = normalizeContentMediaBindings([...manifest.mediaBindings]);
  const finalBindingKeys = new Set(normalizedBindings.map((binding) => contentBindingKey(binding.assetId, binding.occurrence)));
  const refKeys = new Set(refs.map((ref) => contentBindingKey(ref.assetId, ref.occurrence)));
  if (finalBindingKeys.size !== refKeys.size || [...finalBindingKeys].some((key) => !refKeys.has(key))) throw new Error('正文图片与 mediaBindings 不一致。');
  for (const baselineBinding of input.baseline.bindings) {
    const next = normalizedBindings.find((binding) => contentBindingKey(binding.assetId, binding.occurrence) === contentBindingKey(baselineBinding.assetId, baselineBinding.occurrence));
    if (!next || !sameBinding(next, baselineBinding)) throw new Error('既有图片 mediaBindings 被改写。');
  }
  for (const decision of decisions.filter((item) => item.decision === 'used')) {
    const ref = refs.find((item) => item.assetId === decision.assetId && !baselineAssetIds.has(item.assetId));
    if (!ref) throw new Error(`采用图片 ${decision.assetId} 缺少正文 token。`);
    const binding = normalizedBindings.find((item) => item.assetId === ref.assetId && item.occurrence === ref.occurrence);
    if (!binding || binding.widthPreset !== decision.widthPreset || binding.align !== decision.align || (binding.caption ?? null) !== (decision.caption ?? null)) throw new Error(`图片 ${decision.assetId} 的布局绑定不一致。`);
  }
  return { body: manifest.body, decisions, mediaBindings: normalizedBindings };
}

export function buildPiImageBatchResultText(input: { batch: PiImageBatchRecord; versionNumber?: number | null }): string {
  if (input.batch.status === 'completed') {
    const version = input.versionNumber == null ? '新核心版本' : `核心正文 v${input.versionNumber}`;
    const unused = input.batch.attachments.filter((item) => item.state === 'unused');
    const reasons = unused.length ? ` 未采用：${unused.map((item) => `${item.sourceFileName}（${item.decisionReason ?? '不适合当前正文'}）`).join('；')}` : '';
    return `已保存${version}，采用 ${input.batch.usedCount} 张图片，未采用 ${input.batch.unusedCount} 张。${reasons}`;
  }
  if (input.batch.status === 'failed_import') return `图片已进入当前项目的部分素材，但导入阶段未完成：${input.batch.failureMessage ?? '请移除失败图片后重试。'}`;
  if (input.batch.status === 'failed_analysis') return `原图已保存到当前项目，但排图分析未完成：${input.batch.failureMessage ?? '请稍后用同一批次重试。'}`;
  if (input.batch.status === 'conflicted') return `原图和排图决策已保留，但保存时发现正文版本已变化，未覆盖新正文。请重新加载后重新排图。`;
  if (input.batch.status === 'failed_save') return `排图结果已保留，但核心正文保存未完成：${input.batch.failureMessage ?? '请用同一批次重试，避免重复创建版本。'}`;
  return `图片批次未完成（${input.batch.failureMessage ?? input.batch.status}）。`;
}
