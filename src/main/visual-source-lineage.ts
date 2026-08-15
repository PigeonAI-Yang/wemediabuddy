/**
 * WMB-5237：网页/本地图片可追溯视觉理解管线（visual source lineage）。
 *
 * 职责：把 Source 中的图片（网页远程图或本地图）落为 asset，创建带完整血缘
 * （sourceId + sourceRevisionId + assetId + schemaVersion）的视觉处理记录，
 * 驱动真实模型调用（注入 modelCall，模式与 WMB-5228 knowledge-candidates 一致），
 * 把成功的结构化 observation 转为 compiler 可消费的知识候选——候选的
 * Evidence/locator 必须绑定具体 assetId + sourceRevisionId，禁止仅 URL/自由文本。
 *
 * 契约（WMB-5237）：
 * - 记录输入身份必须包含 sourceId、sourceRevisionId（字符串契约；运行时只校验非空，
 *   与 revision slice 表的存在性校验由 Main 衔接）、assetId；
 * - 状态机 queued → running → completed / failed；失败保留错误，绝不伪造 fallback observation；
 * - 同一三元组 + schemaVersion 幂等（attempt=1 同一行；失败重试创建新 attempt 行，旧行不可变保留）；
 * - 不同 sourceRevisionId 产生新 run（UNIQUE 键含 source_revision_id）；
 * - 成功输出（model/provider/prompt_version/observation_json/completed_at）不可变
 *   （completed 行禁止任何 UPDATE，DB 触发器 + 应用层状态门双重强制）；
 * - observation → 知识候选：locator 采用 `asset:<assetId>|sourceRevision:<sourceRevisionId>`
 *   结构化格式（可解析回三元组血缘），由既有被授权编译事务 compileSourceKnowledge 落库。
 *
 * WMB-5245 区域扩展（设计 §9 图片理解）：
 * - schemaVersion 2 起支持区域：可选 `region={x,y,width,height}`，四值均 ∈ [0,1] 有限数；
 *   非法区域 fail-closed（入队抛错 / locator 解析返回 null，绝不猜测）。
 * - locator 保持旧版兼容：整图 `asset|sourceRevision`（region 缺省）；区域追加
 *   `|region={x,y,width,height}`（逐字兼容旧解析器）。
 * - 区域是 run 的输入属性（region_json 列；NULL = 整图），不是幂等键的一部分——
 *   入队键保持 sourceId/sourceRevisionKey/assetId/schemaVersion。
 * - 生产接线：归档 worker 在 preserved 图片 binding 提交后经
 *   enqueuePreservedSourceImage（≤12/Source revision 有界自动入队，复用 binding asset_id 不二次下载）。
 *
 * 模型入口：默认模型 id 复用 src/main/pi-model.ts 的 WMB_VISION_MODEL；
 * 实际调用由调用方注入 `modelCall({ imagePath, imageMimeType, schemaVersion, prompt })`，
 * 模型不可用/抛错 → 记录真实 failed 并保留错误信息。
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAsset, guessImageMime, importAsset, importAssetBytes, type AssetRecord } from './assets.ts';
import {
  compileSourceKnowledge,
  type KnowledgeCompileResult,
  type KnowledgeCompilerInput,
  type KnowledgeCompilerNoteCandidate
} from './knowledge-compiler.ts';
import type {
  ConclusionStatus,
  NoteKind,
  SourceNature,
  TriggerSource
} from './knowledge-flywheel.ts';
import { listSourceMediaBindings } from './db/media-archive-store.ts';
import { MEDIA_LIMITS_DEFAULT } from '../shared/media-limits.ts';
import { WMB_VISION_MODEL } from './pi-model.ts';
import { getSource } from './sources.ts';

// ============================================================
// 常量与固定矩阵
// ============================================================

/** 观察 manifest 根键（与 knowledge-candidates 的 manifest 命名风格一致）。 */
export const VISUAL_OBSERVATION_MANIFEST_KEY = 'wmb_visual_observation' as const;

/** 当前 observation JSON 结构版本（参与幂等键：同 schemaVersion 重放零新 run）。 */
export const VISUAL_SCHEMA_VERSION = 2;

/** 当前 prompt 模板版本（随 prompt 变化递增；记录在 run 上，不参与幂等键）。 */
export const VISUAL_PROMPT_VERSION = 2;

/** 默认视觉模型 provider 标识（与 index.ts 的 wmb-api provider 一致）。 */
export const VISUAL_DEFAULT_PROVIDER = 'wmb-api' as const;

/** observation item 允许的 kind：与 compiler NoteKind 对齐（可转知识候选）。 */
const NOTE_KINDS: Readonly<Record<string, true>> = Object.freeze({
  claim: true, insight: true, concept: true, case: true, method: true, question: true, creative_pattern: true
});

/** manifest 允许的 item 键（未知键 → 整批失败，fail-closed）。 */
const ITEM_KEYS: Readonly<Record<string, true>> = Object.freeze({
  kind: true, canonicalKey: true, statement: true, excerpt: true, valueRationale: true
});

const MANIFEST_KEYS: Readonly<Record<string, true>> = Object.freeze({
  reason: true, items: true
});

/** 视觉 locator 格式：asset:<assetId>|sourceRevision:<sourceRevisionId>（sourceRevisionId 不得包含 '|'）；区域可选追加 |region={x,y,width,height}。 */
const LOCATOR_PREFIX_ASSET = 'asset' as const;
const LOCATOR_PREFIX_REVISION = 'sourceRevision' as const;
const LOCATOR_PREFIX_REGION = 'region' as const;

const IMAGE_FETCH_TIMEOUT_MS = 20_000;

// ============================================================
// 错误与记录类型
// ============================================================

export type VisualRunStatus = 'queued' | 'running' | 'completed' | 'failed';

/**
 * 图片理解区域（设计 §9）：归一化矩形 `{x,y,width,height}`，四值均 ∈ [0,1] 有限数。
 * 与 shared/media-bindings.ts CropRegion 同语义（width/height>0、x+width<=1、y+height<=1）。
 * 非法区域 fail-closed：入队抛错、locator 解析返回 null，绝不猜测。
 */
export type VisualRegion = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export function isValidVisualRegion(region: unknown): region is VisualRegion {
  if (!region || typeof region !== 'object') return false;
  // 结构必须恰好 {x,y,width,height} 四键（fail-closed：多余键 → 非法，绝不猜测）。
  const keys = Object.keys(region as Record<string, unknown>);
  if (keys.length !== 4 || keys.some((key) => key !== 'x' && key !== 'y' && key !== 'width' && key !== 'height')) {
    return false;
  }
  const { x, y, width, height } = region as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return false;
  return width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 1 && y + height <= 1;
}

export type VisualRunRecord = Readonly<{
  id: string;
  sourceId: string;
  sourceRevisionId: string;
  assetId: string;
  schemaVersion: number;
  attempt: number;
  status: VisualRunStatus;
  model: string | null;
  provider: string | null;
  promptVersion: number;
  /** 理解区域（schemaVersion>=2 可携带；NULL = 整图）。 */
  region: VisualRegion | null;
  observation: VisualObservation | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}>;

export type VisualObservationItem = Readonly<{
  kind: NoteKind;
  canonicalKey: string;
  statement: string;
  /** 图中可观察到的细节（视觉证据 excerpt；与 locator 共同构成证据，禁止仅自由文本）。 */
  excerpt: string;
  valueRationale: string;
}>;

export type VisualObservation = Readonly<{
  reason: string;
  items: ReadonlyArray<VisualObservationItem>;
}>;

/** 模型调用注入接口：接收本地图片绝对路径 + 冻结 prompt，返回原始文本（含 ```json manifest 围栏块）。 */
export type VisualModelCall = (input: {
  imagePath: string;
  imageMimeType: string;
  schemaVersion: number;
  prompt: string;
}) => Promise<string>;

export type VisualRunExecutionDeps = Readonly<{
  /** dataRoot：asset.relativePath 据此解析为本地绝对路径。 */
  dataRoot: string;
  modelCall: VisualModelCall;
  /** 实际使用的模型 id（缺省 = run 记录的 model，再缺省 = WMB_VISION_MODEL）。 */
  model?: string;
  /** 实际使用的 provider（缺省 = run 记录的 provider，再缺省 = wmb-api）。 */
  provider?: string;
}>;

export type VisualSourceImageInput =
  | { kind: 'local'; localPath: string; mimeType?: string }
  | { kind: 'remote'; url: string; mimeType?: string };

export type VisualKnowledgeInput = Readonly<{
  workspaceId: string;
  /** 已关联 Topic（compiler 要求 topicId 必须真实存在）。 */
  topicId: string;
  reason?: string;
  sourceNature?: SourceNature;
  triggerSource?: TriggerSource;
}>;

export type VisualPlanResult =
  | { ok: true; plan: KnowledgeCompilerInput }
  | { ok: false; error: Readonly<{ code: string; message: string }> };

/** 模块错误：带稳定 code，便于调用方判定/重试。 */
export class VisualSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VisualSourceError';
    this.code = code;
  }
}

function runError(code: string, message: string): VisualSourceError {
  return new VisualSourceError(code, message);
}

function failure(code: string, message: string): VisualPlanResult {
  return { ok: false, error: Object.freeze({ code, message }) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 有限数值窄化（Number.isFinite 自身不窄化 unknown；显式 typeof + isFinite 后参与算术）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeCanonicalKey(value: string): string {
  return value.trim().toLowerCase();
}

/** 码元序比较（跨 ICU 稳定，保证字节确定性）。 */
function compareCanonicalKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ============================================================
// 视觉 locator（Evidence/locator 血缘绑定；禁止仅 URL/自由文本）
// ============================================================

/**
 * 构造结构化视觉 locator：`asset:<assetId>|sourceRevision:<sourceRevisionId>`，
 * 可选区域追加 `|region={x,y,width,height}`（设计 §9；旧 locator 逐字兼容）。
 * 约束：sourceRevisionId 不得包含 '|'；assetId 为 assets.id（UUID）；region 非法 → 抛错（fail-closed）。
 */
export function visualEvidenceLocator(assetId: string, sourceRevisionId: string, region?: VisualRegion | null): string {
  if (!assetId || assetId.includes('|')) throw runError('LOCATOR_INVALID', 'assetId 不能为空且不得包含 "|"。');
  if (!sourceRevisionId || sourceRevisionId.includes('|')) {
    throw runError('LOCATOR_INVALID', 'sourceRevisionId 不能为空且不得包含 "|"。');
  }
  let locator = `${LOCATOR_PREFIX_ASSET}:${assetId}|${LOCATOR_PREFIX_REVISION}:${sourceRevisionId}`;
  if (region != null) {
    if (!isValidVisualRegion(region)) throw runError('REGION_INVALID', 'region 必须为 {x,y,width,height} 且四值均 ∈ [0,1] 有限数、width/height>0、x+width<=1、y+height<=1。');
    locator += `|${LOCATOR_PREFIX_REGION}={${region.x},${region.y},${region.width},${region.height}}`;
  }
  return locator;
}

/**
 * 解析视觉 locator；格式不符 / region 非法 → null（严格，绝不猜测）。
 * - 旧格式（2 段）：`asset:<assetId>|sourceRevision:<sourceRevisionId>` → region=null；
 * - 区域格式（3 段）：追加 `|region={x,y,width,height}` → region 解析为 VisualRegion。
 */
export function parseVisualEvidenceLocator(locator: string): { assetId: string; sourceRevisionId: string; region: VisualRegion | null } | null {
  const parts = locator.split('|');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [left, right] = parts;
  const leftColon = left.indexOf(':');
  const rightColon = right.indexOf(':');
  if (leftColon < 1 || rightColon < 1) return null;
  if (left.slice(0, leftColon) !== LOCATOR_PREFIX_ASSET) return null;
  if (right.slice(0, rightColon) !== LOCATOR_PREFIX_REVISION) return null;
  const assetId = left.slice(leftColon + 1);
  const sourceRevisionId = right.slice(rightColon + 1);
  if (!assetId || !sourceRevisionId) return null;
  let region: VisualRegion | null = null;
  if (parts.length === 3) {
    const regionPart = parts[2]!;
    if (!regionPart.startsWith(`${LOCATOR_PREFIX_REGION}={`) || !regionPart.endsWith('}')) return null;
    const inner = regionPart.slice(LOCATOR_PREFIX_REGION.length + 2, -1);
    const tokens = inner.split(',');
    if (tokens.length !== 4) return null;
    const values = tokens.map((token) => {
      const trimmed = token.trim();
      if (!trimmed || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return NaN;
      return Number(trimmed);
    });
    if (values.some((value) => !Number.isFinite(value))) return null;
    const candidate = Object.freeze({ x: values[0], y: values[1], width: values[2], height: values[3] });
    if (!isValidVisualRegion(candidate)) return null;
    region = candidate;
  }
  return { assetId, sourceRevisionId, region };
}

// ============================================================
// observation 严格解析（fail-closed：未知键/缺必填/枚举非法/重复 key → 整批失败）
// ============================================================

type NormalizeIssue = Readonly<{ path: string; code: string; reason: string }>;

type NormalizeResult = { ok: true; observation: VisualObservation } | { ok: false; issues: readonly NormalizeIssue[] };

function pushIssue(issues: NormalizeIssue[], path: string, code: string, reason: string): void {
  issues.push(Object.freeze({ path, code, reason }));
}

function checkUnknownKeys(
  issues: NormalizeIssue[],
  value: Record<string, unknown>,
  allowed: Readonly<Record<string, true>>,
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) pushIssue(issues, `${path}.${key}`, 'UNKNOWN_KEY', `未知字段 ${key}。`);
  }
}

function requiredString(
  issues: NormalizeIssue[],
  value: Record<string, unknown>,
  key: string,
  path: string
): string | undefined {
  const raw = value[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    pushIssue(issues, `${path}.${key}`, 'REQUIRED_STRING', `${key} 必须为非空字符串。`);
    return undefined;
  }
  return raw.trim();
}

function normalizeObservation(raw: unknown): NormalizeResult {
  const issues: NormalizeIssue[] = [];
  if (!isPlainObject(raw)) {
    pushIssue(issues, '$', 'NOT_OBJECT', 'observation 必须是 JSON 对象。');
    return { ok: false, issues };
  }
  const body = raw as Record<string, unknown>;
  checkUnknownKeys(issues, body, MANIFEST_KEYS, '$');
  const reason = requiredString(issues, body, 'reason', '$');
  const rawItems = body.items;
  if (!Array.isArray(rawItems)) {
    pushIssue(issues, '$.items', 'REQUIRED_ARRAY', 'items 必须为数组。');
    return { ok: false, issues };
  }
  const items: VisualObservationItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawItems.length; index += 1) {
    const rawItem = rawItems[index];
    const itemPath = `$.items[${index}]`;
    if (!isPlainObject(rawItem)) {
      pushIssue(issues, itemPath, 'NOT_OBJECT', 'item 必须是 JSON 对象。');
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    checkUnknownKeys(issues, item, ITEM_KEYS, itemPath);
    const kind = requiredString(issues, item, 'kind', itemPath);
    const canonicalKey = requiredString(issues, item, 'canonicalKey', itemPath);
    const statement = requiredString(issues, item, 'statement', itemPath);
    const excerpt = requiredString(issues, item, 'excerpt', itemPath);
    const valueRationale = requiredString(issues, item, 'valueRationale', itemPath);
    if (!kind || !canonicalKey || !statement || !excerpt || !valueRationale) continue;
    if (!NOTE_KINDS[kind]) {
      pushIssue(issues, `${itemPath}.kind`, 'INVALID_ENUM', `kind ${kind} 非法。`);
      continue;
    }
    const normalized = normalizeCanonicalKey(canonicalKey);
    if (seen.has(normalized)) {
      pushIssue(issues, `${itemPath}.canonicalKey`, 'DUPLICATE_KEY', `canonicalKey ${canonicalKey} 重复。`);
      continue;
    }
    seen.add(normalized);
    items.push(Object.freeze({
      kind: kind as NoteKind,
      canonicalKey,
      statement,
      excerpt,
      valueRationale
    }));
  }
  if (issues.length) return { ok: false, issues };
  if (!reason) return { ok: false, issues };
  // 确定性：items 按 canonicalKey 码元序排序（同输入 → 同字节）。
  const sorted = [...items].sort((left, right) => compareCanonicalKey(left.canonicalKey, right.canonicalKey));
  return {
    ok: true,
    observation: Object.freeze({ reason, items: Object.freeze(sorted) })
  };
}

/**
 * 从模型输出文本中提取**唯一** ```json 围栏块声明的 `wmb_visual_observation`。
 * 无围栏 / 无合法 JSON / 无 manifest 键 / 多个 manifest 块 → 解析失败（fail-closed，绝不猜测）。
 */
export function extractVisualObservation(text: string): { ok: true; observation: VisualObservation } | { ok: false; error: string } {
  const fences: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    fences.push(match[1]);
  }
  if (!fences.length) return { ok: false, error: '模型输出缺少 ```json 围栏块。' };
  const parsed: unknown[] = [];
  for (const fence of fences) {
    try {
      parsed.push(JSON.parse(fence.trim()));
    } catch {
      return { ok: false, error: '```json 围栏块不是合法 JSON。' };
    }
  }
  const manifestBodies = parsed.filter(isPlainObject)
    .map((value) => (value as Record<string, unknown>)[VISUAL_OBSERVATION_MANIFEST_KEY])
    .filter((value): value is Record<string, unknown> => isPlainObject(value));
  if (manifestBodies.length !== 1) {
    return { ok: false, error: `必须恰好声明一个 ${VISUAL_OBSERVATION_MANIFEST_KEY} manifest（实际 ${manifestBodies.length} 个）。` };
  }
  const normalized = normalizeObservation(manifestBodies[0]);
  if (!normalized.ok) {
    return { ok: false, error: `observation manifest 非法：${normalized.issues.map((issue) => `${issue.path} ${issue.reason}`).join('；')}` };
  }
  return { ok: true, observation: normalized.observation };
}

// ============================================================
// prompt 构造（确定性：无时间戳/随机数；同输入 → 同字节）
// ============================================================

export function buildVisualPrompt(input: {
  sourceTitle: string;
  sourceUrl: string | null;
  reason: string;
  schemaVersion: number;
  promptVersion: number;
  /** 图片理解区域（归一化 0..1；缺省 = 整图）。 */
  region?: VisualRegion | null;
}): string {
  const regionLine = input.region != null
    ? `分析区域（归一化坐标，x/y 为左上角）：x=${input.region.x}，y=${input.region.y}，width=${input.region.width}，height=${input.region.height}。只观察该区域内内容。`
    : '';
  return [
    '你是 WeMediaBuddy 的知识视觉观察员。你将收到一张来自资料正文/附件的图片，',
    '请只输出你真实观察到的内容，禁止推测、禁止编造、禁止填充占位。',
    '',
    `来源标题：${input.sourceTitle || '(无标题)'}`,
    `来源链接：${input.sourceUrl || '(无链接)'}`,
    `观察原因：${input.reason || '(未说明)'}`,
    ...(regionLine ? ['', regionLine] : []),
    '',
    `schemaVersion=${input.schemaVersion}；promptVersion=${input.promptVersion}。`,
    '',
    '输出要求（严格）：',
    '1. 输出恰好一个 ```json 围栏块，声明 `wmb_visual_observation` 对象；',
    '2. 对象结构：{ "wmb_visual_observation": { "reason": "一句话说明这张图为什么值得记录", "items": [ ... ] } }；',
    '3. items 每项结构：{ "kind": "claim|insight|concept|case|method|question|creative_pattern", "canonicalKey": "稳定唯一英文键", "statement": "一句话陈述", "excerpt": "图中可观察到的细节原文（OCR 文字/视觉细节）", "valueRationale": "为什么这条值得入库" }；',
    '4. 只允许上述字段；canonicalKey 全局唯一；没有可观察内容时 items 可以为空数组；',
    '5. 不确定的内容不要写入；无法分析图片时直接输出空 items。',
    ''
  ].join('\n');
}

// ============================================================
// 记录读取
// ============================================================

type VisualRunRow = {
  id: string;
  sourceId: string;
  sourceRevisionId: string;
  assetId: string;
  schemaVersion: number;
  attempt: number;
  status: VisualRunStatus;
  model: string | null;
  provider: string | null;
  promptVersion: number;
  regionJson: string | null;
  observationJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function parseRegionJson(regionJson: string | null): VisualRegion | null {
  if (!regionJson) return null;
  try {
    const parsed = JSON.parse(regionJson) as unknown;
    return isValidVisualRegion(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapVisualRunRow(row: VisualRunRow): VisualRunRecord {
  let observation: VisualObservation | null = null;
  if (row.observationJson) {
    try {
      observation = JSON.parse(row.observationJson) as VisualObservation;
    } catch {
      observation = null;
    }
  }
  return Object.freeze({
    id: row.id,
    sourceId: row.sourceId,
    sourceRevisionId: row.sourceRevisionId,
    assetId: row.assetId,
    schemaVersion: row.schemaVersion,
    attempt: row.attempt,
    status: row.status,
    model: row.model,
    provider: row.provider,
    promptVersion: row.promptVersion,
    region: parseRegionJson(row.regionJson),
    observation,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt
  });
}

const VISUAL_RUN_SELECT = `SELECT id, source_id AS sourceId, source_revision_id AS sourceRevisionId, asset_id AS assetId,
  schema_version AS schemaVersion, attempt, status, model, provider, prompt_version AS promptVersion,
  region_json AS regionJson, observation_json AS observationJson, error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
  FROM knowledge_visual_runs`;

export function getVisualRun(database: DatabaseSync, runId: string): VisualRunRecord | null {
  const row = database.prepare(`${VISUAL_RUN_SELECT} WHERE id = ?`).get(runId) as VisualRunRow | undefined;
  return row ? mapVisualRunRow(row) : null;
}

/** 同一（三元组 + schemaVersion）的最新 attempt 记录；无 → null。 */
export function getLatestVisualRun(
  database: DatabaseSync,
  input: { sourceId: string; sourceRevisionId: string; assetId: string; schemaVersion: number }
): VisualRunRecord | null {
  const row = database.prepare(
    `${VISUAL_RUN_SELECT} WHERE source_id = ? AND source_revision_id = ? AND asset_id = ? AND schema_version = ?
     ORDER BY attempt DESC LIMIT 1`
  ).get(input.sourceId, input.sourceRevisionId, input.assetId, input.schemaVersion) as VisualRunRow | undefined;
  return row ? mapVisualRunRow(row) : null;
}

export function listVisualRuns(
  database: DatabaseSync,
  input: { sourceId?: string; sourceRevisionId?: string; status?: VisualRunStatus; limit?: number } = {}
): VisualRunRecord[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (input.sourceId) {
    clauses.push('source_id = ?');
    args.push(input.sourceId);
  }
  if (input.sourceRevisionId) {
    clauses.push('source_revision_id = ?');
    args.push(input.sourceRevisionId);
  }
  if (input.status) {
    clauses.push('status = ?');
    args.push(input.status);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = database.prepare(`${VISUAL_RUN_SELECT}${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit) as VisualRunRow[];
  return rows.map(mapVisualRunRow);
}

/** 同一（三元组 + schemaVersion）的完整 attempt 历史（按 attempt 升序；旧失败行保留审计）。 */
export function listVisualRunAttempts(
  database: DatabaseSync,
  input: { sourceId: string; sourceRevisionId: string; assetId: string; schemaVersion: number }
): VisualRunRecord[] {
  const rows = database.prepare(
    `${VISUAL_RUN_SELECT} WHERE source_id = ? AND source_revision_id = ? AND asset_id = ? AND schema_version = ?
     ORDER BY attempt ASC`
  ).all(input.sourceId, input.sourceRevisionId, input.assetId, input.schemaVersion) as VisualRunRow[];
  return rows.map(mapVisualRunRow);
}

// ============================================================
// 入队 / 重试（幂等）
// ============================================================

export type EnqueueVisualRunInput = Readonly<{
  sourceId: string;
  sourceRevisionId: string;
  assetId: string;
  schemaVersion?: number;
  promptVersion?: number;
  model?: string;
  provider?: string;
  /** 图片理解区域（设计 §9；schemaVersion>=2 携带；缺省 = 整图）。非法 → REGION_INVALID（fail-closed）。 */
  region?: VisualRegion | null;
  /** true：最新 attempt 为 failed 时创建新 attempt（旧行保留审计）；非 failed 状态幂等返回现有行。 */
  retry?: boolean;
}>;

export function enqueueVisualRun(database: DatabaseSync, input: EnqueueVisualRunInput): { run: VisualRunRecord; created: boolean } {
  const sourceId = input.sourceId?.trim();
  const sourceRevisionId = input.sourceRevisionId?.trim();
  const assetId = input.assetId?.trim();
  if (!sourceId) throw runError('INPUT_INVALID', 'sourceId 不能为空。');
  if (!sourceRevisionId) throw runError('INPUT_INVALID', 'sourceRevisionId 不能为空（字符串契约，由 revision slice 提供）。');
  if (!assetId) throw runError('INPUT_INVALID', 'assetId 不能为空。');
  const schemaVersion = input.schemaVersion ?? VISUAL_SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw runError('INPUT_INVALID', 'schemaVersion 必须为正整数。');
  }
  const promptVersion = input.promptVersion ?? VISUAL_PROMPT_VERSION;
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    throw runError('INPUT_INVALID', 'promptVersion 必须为正整数。');
  }
  const region = input.region ?? null;
  if (region != null && !isValidVisualRegion(region)) {
    throw runError('REGION_INVALID', 'region 必须为 {x,y,width,height} 且四值均 ∈ [0,1] 有限数、width/height>0、x+width<=1、y+height<=1。');
  }
  if (!getSource(database, sourceId)) throw runError('SOURCE_NOT_FOUND', `Source ${sourceId} 不存在。`);
  if (!getAsset(database, assetId)) throw runError('ASSET_NOT_FOUND', `Asset ${assetId} 不存在。`);

  const latest = getLatestVisualRun(database, { sourceId, sourceRevisionId, assetId, schemaVersion });
  if (latest) {
    if (latest.status === 'failed' && input.retry) {
      return { run: createRunRow(database, { sourceId, sourceRevisionId, assetId, schemaVersion, promptVersion, model: input.model, provider: input.provider, region, attempt: latest.attempt + 1 }), created: true };
    }
    return { run: latest, created: false };
  }
  return { run: createRunRow(database, { sourceId, sourceRevisionId, assetId, schemaVersion, promptVersion, model: input.model, provider: input.provider, region, attempt: 1 }), created: true };
}

/** 重试指定 run 对应的（三元组 + schemaVersion）：创建新 attempt 行；最新已 completed → 幂等返回现有行。 */
export function retryVisualRun(database: DatabaseSync, runId: string): { run: VisualRunRecord; created: boolean } {
  const existing = getVisualRun(database, runId);
  if (!existing) throw runError('VISUAL_RUN_NOT_FOUND', `视觉 run ${runId} 不存在。`);
  return enqueueVisualRun(database, {
    sourceId: existing.sourceId,
    sourceRevisionId: existing.sourceRevisionId,
    assetId: existing.assetId,
    schemaVersion: existing.schemaVersion,
    promptVersion: existing.promptVersion,
    model: existing.model ?? undefined,
    provider: existing.provider ?? undefined,
    region: existing.region,
    retry: true
  });
}

function createRunRow(
  database: DatabaseSync,
  input: {
    sourceId: string;
    sourceRevisionId: string;
    assetId: string;
    schemaVersion: number;
    promptVersion: number;
    attempt: number;
    model?: string;
    provider?: string;
    region?: VisualRegion | null;
  }
): VisualRunRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const model = input.model?.trim() || WMB_VISION_MODEL;
  const provider = input.provider?.trim() || VISUAL_DEFAULT_PROVIDER;
  const region = input.region ?? null;
  if (region != null && !isValidVisualRegion(region)) {
    throw runError('REGION_INVALID', 'region 必须为 {x,y,width,height} 且四值均 ∈ [0,1] 有限数、width/height>0、x+width<=1、y+height<=1。');
  }
  try {
    database.prepare(`INSERT INTO knowledge_visual_runs (
      id, source_id, source_revision_id, asset_id, schema_version, attempt, status,
      model, provider, prompt_version, region_json, observation_json, error_code, error_message,
      created_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)`)
      .run(id, input.sourceId, input.sourceRevisionId, input.assetId, input.schemaVersion, input.attempt,
        model, provider, input.promptVersion, region == null ? null : JSON.stringify(region), now);
  } catch (error) {
    // UNIQUE 竞争：另一连接刚写入同键 → 幂等返回。
    const latest = getLatestVisualRun(database, {
      sourceId: input.sourceId, sourceRevisionId: input.sourceRevisionId, assetId: input.assetId, schemaVersion: input.schemaVersion
    });
    if (latest) return latest;
    throw error;
  }
  const run = getVisualRun(database, id);
  if (!run) throw runError('VISUAL_RUN_WRITE_FAILED', '视觉 run 写入后读取失败。');
  return run;
}

// ============================================================
// 状态机（应用层状态门；completed 行另有 DB 触发器禁止 UPDATE）
// ============================================================

function requireRun(database: DatabaseSync, runId: string): VisualRunRecord {
  const run = getVisualRun(database, runId);
  if (!run) throw runError('VISUAL_RUN_NOT_FOUND', `视觉 run ${runId} 不存在。`);
  return run;
}

export function markVisualRunRunning(database: DatabaseSync, runId: string): VisualRunRecord {
  const run = requireRun(database, runId);
  if (run.status !== 'queued') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 状态为 ${run.status}，不能转为 running。`);
  const now = new Date().toISOString();
  database.prepare(`UPDATE knowledge_visual_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
    .run(now, runId);
  const updated = requireRun(database, runId);
  if (updated.status !== 'running') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 未能转为 running。`);
  return updated;
}

export function markVisualRunCompleted(
  database: DatabaseSync,
  runId: string,
  input: { model: string; provider: string; promptVersion: number; observation: VisualObservation }
): VisualRunRecord {
  const run = requireRun(database, runId);
  if (run.status !== 'running') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 状态为 ${run.status}，不能标记 completed。`);
  const now = new Date().toISOString();
  database.prepare(`UPDATE knowledge_visual_runs SET
    status = 'completed', model = ?, provider = ?, prompt_version = ?, observation_json = ?,
    error_code = NULL, error_message = NULL, completed_at = ?
    WHERE id = ? AND status = 'running'`)
    .run(input.model, input.provider, input.promptVersion, JSON.stringify(input.observation), now, runId);
  const updated = requireRun(database, runId);
  if (updated.status !== 'completed') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 未能标记 completed。`);
  return updated;
}

export function markVisualRunFailed(
  database: DatabaseSync,
  runId: string,
  input: { errorCode: string; errorMessage: string }
): VisualRunRecord {
  const run = requireRun(database, runId);
  if (run.status === 'completed') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 已 completed，不可改为 failed。`);
  if (run.status !== 'queued' && run.status !== 'running') {
    throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 状态为 ${run.status}，不能标记 failed。`);
  }
  const now = new Date().toISOString();
  database.prepare(`UPDATE knowledge_visual_runs SET
    status = 'failed', error_code = ?, error_message = ?,
    completed_at = COALESCE(completed_at, ?)
    WHERE id = ? AND status IN ('queued', 'running')`)
    .run(input.errorCode, input.errorMessage, now, runId);
  const updated = requireRun(database, runId);
  if (updated.status !== 'failed') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 未能标记 failed。`);
  return updated;
}

// ============================================================
// 执行（真实模型调用；失败 → failed 保留错误，绝不伪造）
// ============================================================

export async function executeVisualRun(
  database: DatabaseSync,
  runId: string,
  deps: VisualRunExecutionDeps
): Promise<VisualRunRecord> {
  const run = requireRun(database, runId);
  if (run.status !== 'queued') throw runError('VISUAL_RUN_STATUS_INVALID', `run ${runId} 状态为 ${run.status}，只能执行 queued run。`);
  const asset = getAsset(database, run.assetId);
  if (!asset) {
    return markVisualRunFailed(database, runId, {
      errorCode: 'ASSET_NOT_FOUND',
      errorMessage: `执行时 asset ${run.assetId} 不存在。`
    });
  }
  const source = getSource(database, run.sourceId);
  const imagePath = path.join(deps.dataRoot, ...asset.relativePath.split('/'));
  const prompt = buildVisualPrompt({
    sourceTitle: source?.title ?? '',
    sourceUrl: source?.canonicalUrl ?? source?.originalUrl ?? null,
    reason: run.observation?.reason ?? '',
    schemaVersion: run.schemaVersion,
    promptVersion: run.promptVersion,
    region: run.region
  });

  markVisualRunRunning(database, runId);
  let text: string;
  try {
    text = await deps.modelCall({
      imagePath,
      imageMimeType: asset.mimeType,
      schemaVersion: run.schemaVersion,
      prompt
    });
  } catch (error) {
    return markVisualRunFailed(database, runId, {
      errorCode: 'MODEL_CALL_FAILED',
      errorMessage: `模型调用失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
  const extracted = extractVisualObservation(text);
  if (!extracted.ok) {
    return markVisualRunFailed(database, runId, {
      errorCode: 'OBSERVATION_PARSE_FAILED',
      errorMessage: extracted.error
    });
  }
  return markVisualRunCompleted(database, runId, {
    model: deps.model ?? run.model ?? WMB_VISION_MODEL,
    provider: deps.provider ?? run.provider ?? VISUAL_DEFAULT_PROVIDER,
    promptVersion: run.promptVersion,
    observation: extracted.observation
  });
}

// ============================================================
// 图片发现/导入：本地文件或远程 URL → asset（可追溯血缘的前提）
// ============================================================

/** 网页远程图/本地图片统一入口：确保图片已保存为 asset（sha256 去重复用）。 */
export async function ensureSourceImageAsset(
  database: DatabaseSync,
  dataRoot: string,
  input: { sourceId: string; image: VisualSourceImageInput; origin?: string; fetchImpl?: typeof fetch }
): Promise<{ asset: AssetRecord; imported: boolean }> {
  const origin = input.origin?.trim() || `source-visual:${input.sourceId}`;
  if (input.image.kind === 'local') {
    const mimeType = input.image.mimeType?.trim() || guessImageMime(input.image.localPath);
    if (!mimeType.startsWith('image/')) {
      throw runError('ASSET_NOT_IMAGE', `本地文件不是图片（mime ${mimeType}）。`);
    }
    const imported = await importAsset(database, dataRoot, {
      sourcePath: input.image.localPath,
      mimeType,
      origin
    });
    const asset = getAsset(database, imported.id);
    if (!asset) throw runError('ASSET_WRITE_FAILED', '图片 asset 写入后读取失败。');
    return { asset, imported: !imported.reused };
  }
  const bytes = await fetchRemoteImageBytes(input.image.url, input.fetchImpl ?? globalThis.fetch);
  const mimeType = input.image.mimeType?.trim() || guessImageMime(imageUrlPath(input.image.url), 'image/png');
  if (!mimeType.startsWith('image/')) throw runError('ASSET_NOT_IMAGE', `远程内容不是图片（mime ${mimeType}）。`);
  const imported = await importAssetBytes(database, dataRoot, {
    bytes,
    fileName: imageUrlFileName(input.image.url),
    mimeType,
    origin
  });
  const asset = getAsset(database, imported.id);
  if (!asset) throw runError('ASSET_WRITE_FAILED', '图片 asset 写入后读取失败。');
  return { asset, imported: !imported.reused };
}

async function fetchRemoteImageBytes(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'WeMediaBuddyVisualSource/1.0',
        accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,*/*;q=0.5'
      }
    });
    if (!response.ok) {
      throw runError('IMAGE_FETCH_FAILED', `远程图片抓取失败 HTTP ${response.status}。`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.byteLength) throw runError('IMAGE_FETCH_FAILED', '远程图片内容为空。');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

function imageUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function imageUrlFileName(url: string): string {
  const fileName = path.basename(imageUrlPath(url));
  return /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(fileName) ? fileName : 'image.bin';
}

// ============================================================
// WMB-5245 生产接线：preserved 图片自动入队（设计 §9）
// - 归档 worker 在 preserved 图片 binding 提交后调用 enqueuePreservedSourceImage：
//   复用 binding.asset_id（不二次下载），每 Source revision 自动理解 ≤12 张（MEDIA_LIMITS_DEFAULT），
//   超限图片保持已保存但显式未理解（unprocessed），用户可手动入队。
// - 幂等：同一 sourceId/sourceRevisionKey/assetId/schemaVersion 自动入队一次。
// ============================================================

/** 每 Source revision 自动图片理解上限（设计 §8 实施合同；与 shared/media-limits.ts 一致）。 */
export const VISUAL_AUTO_ENQUEUE_LIMIT = MEDIA_LIMITS_DEFAULT.maxImageUnderstandingPerRevision;

export type PreservedImageEnqueueResult = Readonly<{
  run: VisualRunRecord | null;
  enqueued: boolean;
  reason: 'image' | 'not_image' | 'limit' | 'already' | 'no_binding';
}>;

/** 单 binding 入队（ArchiveWorker hook 契约：db + {sourceId, sourceRevisionKey, assetId, kind}）。 */
export function enqueuePreservedSourceImage(
  database: DatabaseSync,
  input: { sourceId: string; sourceRevisionKey: string; assetId: string; kind: string }
): PreservedImageEnqueueResult {
  if (input.kind !== 'image') return { run: null, enqueued: false, reason: 'not_image' };
  const bindings = listSourceMediaBindings(database, input.sourceRevisionKey)
    .filter((row) => row.kind === 'image' && !row.archivedAt)
    .sort((left, right) => left.ordinal - right.ordinal);
  const index = bindings.findIndex((row) => row.assetId === input.assetId);
  if (index === -1) return { run: null, enqueued: false, reason: 'no_binding' };
  // 有界自动入队（设计 §8/§9）：前 ≤12 张（按 ordinal）可经 hook 自动入队；
  // 硬上限：该 revision 已存在的 run 总数 < 12（下载并发下 binding 按完成序提交，ordinal rank 单独不足）。
  // 超限图片保持已保存但显式未理解（unprocessed），用户可经 enqueueVisualRun 手动入队。
  const existingRuns = Number(database.prepare(
    'SELECT COUNT(*) AS count FROM knowledge_visual_runs WHERE source_revision_id = ?'
  ).get(input.sourceRevisionKey)?.count ?? 0);
  if (index >= VISUAL_AUTO_ENQUEUE_LIMIT || existingRuns >= VISUAL_AUTO_ENQUEUE_LIMIT) {
    return { run: null, enqueued: false, reason: 'limit' };
  }
  const result = enqueueVisualRun(database, {
    sourceId: input.sourceId,
    sourceRevisionId: input.sourceRevisionKey,
    assetId: input.assetId
  });
  return { run: result.run, enqueued: true, reason: result.created ? 'image' : 'already' };
}

/** 某 Source revision 的图片理解状态（设计 §8/§9 UI 计数口径）：preserved 图片逐项 + 是否自动入队。 */
export type SourceRevisionVisualStatusItem = Readonly<{
  assetId: string;
  ordinal: number;
  caption: string | null;
  run: VisualRunRecord | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unprocessed';
  autoEnqueued: boolean;
}>;

export type SourceRevisionVisualStatus = Readonly<{
  sourceId: string;
  sourceRevisionKey: string;
  limit: number;
  preservedImages: number;
  autoEnqueued: number;
  unprocessed: number;
  items: ReadonlyArray<SourceRevisionVisualStatusItem>;
}>;

/** 某 asset 在该 revision 的最新 run（任意 schemaVersion；同 asset 理解一次即非 unprocessed）。 */
function latestVisualRunForBinding(database: DatabaseSync, sourceRevisionKeyValue: string, assetId: string): VisualRunRecord | null {
  const row = database.prepare(
    `${VISUAL_RUN_SELECT} WHERE source_revision_id = ? AND asset_id = ?
     ORDER BY schema_version DESC, attempt DESC LIMIT 1`
  ).get(sourceRevisionKeyValue, assetId) as VisualRunRow | undefined;
  return row ? mapVisualRunRow(row) : null;
}

/** 读模型：preserved 图片 binding 逐项状态；无 run 的 binding 显式为 unprocessed（已保存、尚未理解）。 */
export function readSourceRevisionVisualStatus(
  database: DatabaseSync,
  sourceRevisionKeyValue: string,
  sourceId?: string
): SourceRevisionVisualStatus {
  const bindings = listSourceMediaBindings(database, sourceRevisionKeyValue)
    .filter((row) => row.kind === 'image' && !row.archivedAt)
    .sort((left, right) => left.ordinal - right.ordinal);
  const items: SourceRevisionVisualStatusItem[] = bindings.map((binding, rank) => {
    const run = latestVisualRunForBinding(database, sourceRevisionKeyValue, binding.assetId);
    const status = run ? run.status : 'unprocessed';
    return Object.freeze({
      assetId: binding.assetId,
      ordinal: binding.ordinal,
      caption: binding.caption,
      run,
      status,
      autoEnqueued: rank < VISUAL_AUTO_ENQUEUE_LIMIT && status !== 'unprocessed'
    });
  });
  return Object.freeze({
    sourceId: sourceId ?? bindings[0]?.sourceId ?? '',
    sourceRevisionKey: sourceRevisionKeyValue,
    limit: VISUAL_AUTO_ENQUEUE_LIMIT,
    preservedImages: bindings.length,
    autoEnqueued: items.filter((item) => item.autoEnqueued).length,
    unprocessed: items.filter((item) => item.status === 'unprocessed').length,
    items: Object.freeze(items)
  });
}

/** 批量自动入队（≤limit/ Source revision）：读取 preserved 图片 binding，按 ordinal 顺序补齐缺失 run。 */
export function autoEnqueuePreservedSourceImages(
  database: DatabaseSync,
  input: { sourceId: string; sourceRevisionKey: string; limit?: number }
): { enqueued: VisualRunRecord[]; skippedLimit: number; totalPreserved: number } {
  const limit = Math.max(1, Math.min(input.limit ?? VISUAL_AUTO_ENQUEUE_LIMIT, VISUAL_AUTO_ENQUEUE_LIMIT));
  const bindings = listSourceMediaBindings(database, input.sourceRevisionKey)
    .filter((row) => row.kind === 'image' && !row.archivedAt)
    .sort((left, right) => left.ordinal - right.ordinal);
  const enqueued: VisualRunRecord[] = [];
  let skippedLimit = 0;
  bindings.forEach((binding, index) => {
    if (index >= limit) {
      skippedLimit += 1;
      return;
    }
    const result = enqueuePreservedSourceImage(database, {
      sourceId: input.sourceId,
      sourceRevisionKey: input.sourceRevisionKey,
      assetId: binding.assetId,
      kind: binding.kind
    });
    if (result.run) enqueued.push(result.run);
  });
  return { enqueued, skippedLimit, totalPreserved: bindings.length };
}

// ============================================================
// observation → 知识候选（Evidence/locator 绑定 assetId + sourceRevisionId）
// ============================================================

/**
 * 把已 completed 的视觉 run 转为 compileSourceKnowledge 可消费的候选计划。
 * - locator = `asset:<assetId>|sourceRevision:<sourceRevisionId>`，run 携带区域时追加
 *   `|region={x,y,width,height}`（结构化血缘，非 URL/自由文本）；
 * - claim → unverified，其余 kind → inference（与 WMB-5228 证据状态机一致：视觉观察未达 supported）；
 * - evidenceLevel = single（单一视觉观察）；
 * - requestId = `visual_source:<runId>`：同 run 重放零增量（compiler 幂等）。
 * 不写库；落库必须经既有被授权编译事务（compileSourceKnowledge）。
 */
export function visualRunToKnowledgeInput(database: DatabaseSync, runId: string, input: VisualKnowledgeInput): VisualPlanResult {
  const run = requireRun(database, runId);
  if (run.status !== 'completed') {
    return failure('VISUAL_RUN_NOT_COMPLETED', `run ${runId} 状态为 ${run.status}，只有 completed 才能转知识候选。`);
  }
  if (!run.observation) return failure('VISUAL_RUN_NO_OBSERVATION', `run ${runId} 没有 observation（不可转知识候选）。`);
  const source = getSource(database, run.sourceId);
  if (!source) return failure('SOURCE_NOT_FOUND', `Source ${run.sourceId} 不存在。`);
  if (!input.workspaceId?.trim() || !input.topicId?.trim()) {
    return failure('INPUT_INVALID', '转知识候选需要 workspaceId 与已关联 topicId。');
  }
  let locator: string;
  try {
    locator = visualEvidenceLocator(run.assetId, run.sourceRevisionId, run.region);
  } catch (error) {
    return failure('LOCATOR_INVALID', error instanceof Error ? error.message : String(error));
  }
  // 自校验：locator 必须能解析回同一血缘（防格式漂移）。
  const parsed = parseVisualEvidenceLocator(locator);
  if (!parsed || parsed.assetId !== run.assetId || parsed.sourceRevisionId !== run.sourceRevisionId) {
    return failure('LOCATOR_INVALID', '视觉 locator 无法解析回 assetId + sourceRevisionId 血缘。');
  }
  if (run.region != null && (parsed.region == null || !isValidVisualRegion(parsed.region) || parsed.region.x !== run.region.x || parsed.region.y !== run.region.y || parsed.region.width !== run.region.width || parsed.region.height !== run.region.height)) {
    return failure('LOCATOR_INVALID', '视觉 locator 区域无法解析回 run.region 血缘。');
  }
  const notes: KnowledgeCompilerNoteCandidate[] = run.observation.items.map((item) => {
    const conclusionStatus: ConclusionStatus = item.kind === 'claim' ? 'unverified' : 'inference';
    return Object.freeze({
      kind: item.kind,
      canonicalKey: item.canonicalKey,
      statement: item.statement,
      conclusionStatus,
      evidenceLevel: 'single' as const,
      locator,
      excerpt: item.excerpt,
      relation: 'supports' as const,
      valueRationale: item.valueRationale
    });
  });
  const plan: KnowledgeCompilerInput = Object.freeze({
    requestId: `visual_source:${run.id}`,
    workspaceId: input.workspaceId,
    sourceId: run.sourceId,
    sourceRevision: source.revision,
    topicId: input.topicId,
    triggerSource: input.triggerSource ?? 'ingest',
    sourceNature: input.sourceNature ?? 'primary_source',
    reason: input.reason?.trim()
      || `视觉观察：asset ${run.assetId}（Source ${run.sourceId} revision ${run.sourceRevisionId}）`,
    entities: Object.freeze([]),
    notes: Object.freeze(notes)
  });
  return { ok: true, plan };
}

/** 便捷入口：completed 视觉 run → 既有被授权编译事务落库（compileSourceKnowledge 原子 ChangeSet）。 */
export function compileVisualRunKnowledge(
  database: DatabaseSync,
  runId: string,
  input: VisualKnowledgeInput
): KnowledgeCompileResult {
  const planResult = visualRunToKnowledgeInput(database, runId, input);
  if (!planResult.ok) throw runError(planResult.error.code, planResult.error.message);
  return compileSourceKnowledge(database, planResult.plan);
}

/** 供外部断言确定性的稳定摘要（可选；不参与计划字节本身）。 */
export function visualRunPlanHash(plan: KnowledgeCompilerInput): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
