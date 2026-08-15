/**
 * WMB-5228：生产知识候选生成上游（candidate plan service）。
 * Design: docs/spark/2026-08-12-wmb-ai-knowledge-compilation-protocol-design.md §2/§3/§9
 *         2026-08-12-wmb-knowledge-object-version-contract-design.md §25
 *
 * 职责：把冻结 Source（source_items 当前 revision + 正文缓存/摘要）与既有 Topic 上下文
 * 转换为 `compileSourceKnowledge` 可直接消费的严格 typed candidate plan。
 * 本模块只生成计划：不写数据库、不触达编译器、不改 schema、不含模型供应商。
 *
 * - 冻结：sourceId → 当前 revision 的 SourceRecord + 正文（body_cache ready 优先，否则
 *   summary 兜底）；topicId → topics 行；requestId = sourceCompileRequestId(sourceId,
 *   revision)（同 source revision 幂等键，与编译器一致）；
 * - 模型调用注入：调用方提供 `modelCall(prompt) => Promise<string>`；
 * - 严格 manifest：模型输出中**恰好一个** ```json 围栏块声明 `wmb_knowledge_candidates`。
 *   未知字段 / 缺失必填 / 枚举非法 / 重复 canonicalKey / 乱序 locator / 多个 manifest 块
 *   → 整批失败（fail-closed，零计划）；
 * - locator 门：每个晋升候选必须能精确回指冻结正文。Note 的 locator（L<行> 或
 *   L<起>-<止>，起≤止且不超过正文行数）必须成立；带 excerpt 时 excerpt 必须落在定位行内。
 *   Entity（compiler schema 无 locator 字段）要求 manifest 携带正文原句 excerpt 且能在
 *   正文中匹配。不可定位候选不进计划，返回结构化原因（skipped）；
 * - 证据状态机（compiler §8.2 前置）：supported/disputed/contradicted + 证据等级
 *   none/insufficient → 机器降级：claim → unverified，其余 kind → inference（记录 downgraded）；
 * - 价值门：纯复述（changeType=no_change）不晋升；全部候选被滤除 → 返回合法空计划
 *   （entities/notes 为空数组，编译器仍可接受并持久 receipt）；
 * - 确定性：同冻结输入 + 同模型输出 → 完全相同的 plan。实体/笔记数组按 canonicalKey
 *   （码元序）排序，prompt 无时间戳/随机数，JSON 序列化字节稳定。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ConclusionStatus,
  CreatorNature,
  EntityType,
  EvidenceLevel,
  KnowledgeScope,
  NoteKind,
  NoteVersionChangeType,
  SourceNature,
  TriggerSource
} from './knowledge-flywheel.ts';
import type {
  KnowledgeCompilerEntityCandidate,
  KnowledgeCompilerInput,
  KnowledgeCompilerNoteCandidate
} from './knowledge-compiler.ts';
import { sourceCompileRequestId } from './knowledge-compiler.ts';
import { getKnowledgeContext } from './knowledge.ts';
import { getSourceBodyCache } from './source-body-cache.ts';
import { getSource, type SourceRecord } from './sources.ts';

// ============================================================
// 错误与固定矩阵（与 compiler/knowledge-flywheel 对齐；本模块只做前置校验）
// ============================================================

export const KNOWLEDGE_CANDIDATES_MANIFEST_KEY = 'wmb_knowledge_candidates' as const;

const ENTITY_TYPES: Readonly<Record<string, true>> = Object.freeze({
  person: true, organization: true, product: true, platform: true, policy: true,
  institution: true, place: true, publication_channel: true, other: true
});

const NOTE_KINDS: Readonly<Record<string, true>> = Object.freeze({
  claim: true, insight: true, concept: true, case: true, method: true, question: true, creative_pattern: true
});

const CONCLUSION_STATUSES: Readonly<Record<string, true>> = Object.freeze({
  unverified: true, supported: true, disputed: true, contradicted: true,
  superseded: true, not_applicable: true, inference: true
});

const EVIDENCE_LEVELS: Readonly<Record<string, true>> = Object.freeze({
  none: true, single: true, corroborated: true, primary: true, outcome_observed: true, mixed: true, insufficient: true
});

const EVIDENCE_RELATIONS: Readonly<Record<string, true>> = Object.freeze({
  supports: true, contradicts: true, qualifies: true
});

/** manifest 允许的 changeType：与 compiler validateCompilerInput 的允许集一致。 */
const CHANGE_TYPES: Readonly<Record<string, true>> = Object.freeze({
  created: true, no_change: true,
  strengthened: true, weakened: true, qualified: true, contradicted: true, superseded: true, recompiled: true
});

/** 证据状态机：这些状态需要足够证据（§5.4 / compiler §8.2）。 */
const NON_SUPPORTABLE_STATUSES: Readonly<Record<string, true>> = Object.freeze({
  supported: true, contradicted: true, disputed: true
});

const WEAK_EVIDENCE_LEVELS: Readonly<Record<string, true>> = Object.freeze({
  none: true, insufficient: true
});

const QUESTION_KINDS: Readonly<Record<string, true>> = Object.freeze({ question: true });

const ENTITY_MANIFEST_KEYS: Readonly<Record<string, true>> = Object.freeze({
  entityType: true, canonicalKey: true, canonicalName: true, aliases: true,
  externalIdentity: true, excerpt: true, valueRationale: true
});

const NOTE_MANIFEST_KEYS: Readonly<Record<string, true>> = Object.freeze({
  kind: true, canonicalKey: true, statement: true, title: true, body: true,
  conclusionStatus: true, evidenceLevel: true, appliesTo: true, validFrom: true, validUntil: true,
  changeType: true, changeReason: true, locator: true, excerpt: true, relation: true,
  entityKeys: true, valueRationale: true
});

const TOPIC_COMPILE_KEYS: Readonly<Record<string, true>> = Object.freeze({ title: true, summary: true });

const MANIFEST_ROOT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  reason: true, topicCompile: true, entities: true, notes: true
});

/** 有界检索（设计 §3.4）：候选提取只携带 Topic 上下文的前 N 条知识，禁止无界扫描。 */
export const KNOWLEDGE_CANDIDATES_CONTEXT_LIMIT = 10;

const LOCATOR_PATTERN = /^L(\d+)(?:-(\d+))?$/;

// ============================================================
// 冻结输入类型（全部 Readonly；编译前冻结，与 compiler freezeInput 同向）
// ============================================================

export type FrozenKnowledgeBodyKind = 'body_cache' | 'summary' | 'none';

export type FrozenKnowledgeSource = Readonly<{
  source: SourceRecord;
  /** 冻结正文：body_cache ready 的 extractedText 优先，否则 Source summary 兜底。 */
  body: string;
  bodyKind: FrozenKnowledgeBodyKind;
}>;

export type FrozenKnowledgeTopic = Readonly<{
  id: string;
  title: string;
  canonicalKey: string | null;
  kind: string | null;
  summary: string | null;
  status: string | null;
}>;

/** getKnowledgeContext 返回值的窄化快照（本模块只消费 topics/sources/knowledge 三段）。 */
export type KnowledgeContextSnapshot = Readonly<{
  topics: ReadonlyArray<unknown>;
  sources: ReadonlyArray<unknown>;
  knowledge: Readonly<{ noteVersions: ReadonlyArray<unknown> }>;
}>;

export type FrozenKnowledgeContext = Readonly<{
  topics: ReadonlyArray<{
    id: string; title: string; kind: string | null; summary: string | null; status: string | null;
  }>;
  sources: ReadonlyArray<{
    id: string; title: string; originalUrl: string | null; summary: string | null;
  }>;
  noteVersions: ReadonlyArray<{
    versionId: string; noteId: string; kind: string; title: string | null; statement: string;
    conclusionStatus: string; evidenceLevel: string; appliesTo: string | null;
  }>;
}>;

/** 模型调用注入接口：输入冻结 prompt，返回原始文本（含 ```json manifest 围栏块）。 */
export type KnowledgeCandidatesModelCall = (prompt: string) => Promise<string>;

// ============================================================
// 严格 manifest（模型输出；解析失败 → 整批失败，绝不猜测）
// ============================================================

export type KnowledgeCandidatesEntityManifest = Readonly<{
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases?: readonly string[];
  externalIdentity?: Readonly<Record<string, unknown>>;
  /** 可定位正文原句（Entity 晋升门；compiler schema 无 locator 字段，故只在此校验）。 */
  excerpt?: string;
  valueRationale: string;
}>;

export type KnowledgeCandidatesNoteManifest = Readonly<{
  kind: NoteKind;
  canonicalKey: string;
  statement: string;
  title?: string;
  body?: string;
  conclusionStatus: ConclusionStatus;
  evidenceLevel: EvidenceLevel;
  appliesTo?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  changeType?: NoteVersionChangeType | 'no_change';
  changeReason?: string;
  locator: string;
  excerpt?: string;
  relation?: 'supports' | 'contradicts' | 'qualifies';
  entityKeys?: readonly string[];
  valueRationale: string;
}>;

export type KnowledgeCandidatesManifest = Readonly<{
  reason: string;
  topicCompile?: Readonly<{ title?: string; summary?: string }>;
  entities: readonly KnowledgeCandidatesEntityManifest[];
  notes: readonly KnowledgeCandidatesNoteManifest[];
}>;

export type ManifestIssue = Readonly<{
  path: string;
  code: 'unknown_field' | 'missing' | 'type' | 'enum' | 'duplicate' | 'invalid';
  reason: string;
}>;

export type KnowledgeCandidateErrorInfo = Readonly<{
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type KnowledgeCandidatesFailure = Readonly<{ ok: false; error: KnowledgeCandidateErrorInfo }>;

export type ManifestExtractResult = { ok: true; manifest: KnowledgeCandidatesManifest } | KnowledgeCandidatesFailure;

type NormalizeResult = | { ok: true; manifest: KnowledgeCandidatesManifest } | { ok: false; issues: readonly ManifestIssue[] };

// ============================================================
// 工具
// ============================================================

function failure(code: string, message: string, details?: Readonly<Record<string, unknown>>): KnowledgeCandidatesFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message, ...(details ? { details: Object.freeze(details) } : {}) }) });
}

function normalizeCanonicalKey(value: string): string {
  return value?.trim().toLowerCase() ?? '';
}

/** 码元序比较（跨 ICU 稳定，保证字节确定性）。 */
function compareCanonicalKey(left: string, right: string): number {
  const a = normalizeCanonicalKey(left);
  const b = normalizeCanonicalKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ============================================================
// 冻结辅助（只读 DB 快照；不写库）
// ============================================================

/** 冻结 Source：source_items 当前行 + 正文（body_cache ready → summary 兜底 → 空）。 */
export function freezeKnowledgeSource(database: DatabaseSync, sourceId: string): FrozenKnowledgeSource | null {
  const source = getSource(database, sourceId);
  if (!source) return null;
  const cache = getSourceBodyCache(database, sourceId);
  if (cache && cache.status === 'ready' && cache.extractedText.trim()) {
    return Object.freeze({ source, body: cache.extractedText, bodyKind: 'body_cache' as const });
  }
  if (source.summary?.trim()) {
    return Object.freeze({ source, body: source.summary, bodyKind: 'summary' as const });
  }
  return Object.freeze({ source, body: '', bodyKind: 'none' as const });
}

/** 冻结 Topic（与 compiler 的 topics 读取口径一致，不做状态过滤）。 */
export function freezeKnowledgeTopic(database: DatabaseSync, topicId: string): FrozenKnowledgeTopic | null {
  const row = database.prepare(
    `SELECT id, title, canonical_key AS canonicalKey, kind, summary, status FROM topics WHERE id = ?`
  ).get(topicId) as FrozenKnowledgeTopic | undefined;
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    title: row.title,
    canonicalKey: row.canonicalKey ?? null,
    kind: row.kind ?? null,
    summary: row.summary ?? null,
    status: row.status ?? null
  });
}

/** 有界冻结 Topic 上下文（设计 §3.4 Stage D）：固定字段构造，保证 prompt 字节稳定。 */
function freezeKnowledgeContext(context: KnowledgeContextSnapshot): FrozenKnowledgeContext {
  const topics = (context.topics as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id), title: String(row.title),
    kind: row.kind == null ? null : String(row.kind),
    summary: row.summary == null ? null : String(row.summary),
    status: row.status == null ? null : String(row.status)
  }));
  const sources = (context.sources as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id), title: String(row.title),
    originalUrl: row.originalUrl == null ? null : String(row.originalUrl),
    summary: row.summary == null ? null : String(row.summary)
  }));
  const noteVersions = (context.knowledge.noteVersions as Array<Record<string, unknown>>).map((row) => ({
    versionId: String(row.versionId), noteId: String(row.noteId), kind: String(row.kind),
    title: row.title == null ? null : String(row.title), statement: String(row.statement),
    conclusionStatus: String(row.conclusionStatus), evidenceLevel: String(row.evidenceLevel),
    appliesTo: row.appliesTo == null ? null : String(row.appliesTo)
  }));
  return Object.freeze({ topics, sources, noteVersions });
}

// ============================================================
// prompt 构造（确定性：无时间戳/随机数；同冻结输入 → 同字节）
// ============================================================

export function buildCandidatesPrompt(input: {
  source: SourceRecord;
  body: string;
  bodyKind: FrozenKnowledgeBodyKind;
  topic: FrozenKnowledgeTopic;
  context: FrozenKnowledgeContext;
  scope: KnowledgeScope;
}): string {
  const enumLines = [
    `entityType: ${Object.keys(ENTITY_TYPES).join('|')}`,
    `kind: ${Object.keys(NOTE_KINDS).join('|')}`,
    `conclusionStatus: ${Object.keys(CONCLUSION_STATUSES).join('|')}`,
    `evidenceLevel: ${Object.keys(EVIDENCE_LEVELS).join('|')}`,
    `changeType: ${Object.keys(CHANGE_TYPES).join('|')}`,
    `relation: ${Object.keys(EVIDENCE_RELATIONS).join('|')}`
  ];
  return [
    '执行 WeMediaBuddy 生产知识候选提取任务（WMB-5228 协议）。',
    '',
    '# 任务',
    '基于下方冻结 Source 与 Topic 上下文，把本 Source 相对既有知识的增量提取为可晋升候选。',
    `scope=${input.scope}`,
    '只输出一个 ```json 围栏块声明 wmb_knowledge_candidates；除该围栏块外不要输出任何其它文字。',
    '',
    '# 冻结 Source',
    `sourceId=${input.source.id}`,
    `revision=${input.source.revision}`,
    `title=${input.source.title}`,
    `author=${input.source.author ?? ''}`,
    `publishedAt=${input.source.publishedAt ?? ''}`,
    `summary=${input.source.summary ?? ''}`,
    `keywords=${JSON.stringify(input.source.keywords ?? [])}`,
    `正文（${input.bodyKind}）：`,
    '```',
    input.body,
    '```',
    '',
    '# 冻结 Topic 上下文',
    JSON.stringify(input.context, null, 2),
    '',
    '# manifest 结构（严格；字段名全小写下划线；未知字段/缺失必填/枚举非法/重复 canonicalKey/乱序 locator/多个 manifest 块会导致整批失败）',
    '```json',
    '{ "wmb_knowledge_candidates": {',
    '  "reason": "总体变化原因（必填）",',
    '  "topicCompile": { "title": "...", "summary": "..." },',
    '  "entities": [{ "entityType": "...", "canonicalKey": "...", "canonicalName": "...", "aliases": ["..."], "externalIdentity": {}, "excerpt": "正文原句（必填）", "valueRationale": "..." }],',
    '  "notes": [{ "kind": "...", "canonicalKey": "...", "statement": "...", "title": "...", "conclusionStatus": "...", "evidenceLevel": "...", "appliesTo": "...", "validFrom": "...", "validUntil": "...", "changeType": "...", "changeReason": "...", "locator": "L12-18", "excerpt": "正文原句", "relation": "supports", "entityKeys": ["..."], "valueRationale": "..." }]',
    '} }',
    '```',
    '',
    '枚举：',
    ...enumLines,
    '',
    '硬性规则：',
    '1. locator 必须回指冻结正文：L<行号> 或 L<起行>-<止行>（如 L3 或 L12-18，起≤止，行号从 1 开始，不得超出正文行数）。',
    '2. excerpt（如果有）必须是冻结正文原句（空白可折叠，但逐字可匹配），且必须落在 locator 定位的行内。',
    '3. 证据不足（evidenceLevel=none/insufficient）时不得标记 supported/disputed/contradicted（系统会降级为 unverified/inference）。',
    '4. 纯复述、无未来复用价值、无法定位依据的模型联想一律不要列入；changeType=no_change 表示纯复述（不会晋升）。',
    '5. canonicalKey 全 manifest 唯一（entities 与 notes 各自唯一，且不得为空）。',
    '6. kind=question 不得标记 conclusionStatus=supported。'
  ].join('\n');
}

// ============================================================
// locator 门（纯函数；正文为冻结 Source 正文）
// ============================================================

export type LocatorSkipReasonCode =
  | 'LOCATOR_MALFORMED'
  | 'LOCATOR_OUT_OF_RANGE'
  | 'LOCATOR_NO_BODY'
  | 'EXCERPT_NOT_IN_LOCATOR_LINES';

export type LocatorVerdict =
  | { ok: true }
  | { ok: false; reasonCode: LocatorSkipReasonCode; reason: string };

/**
 * 校验 locator/excerpt 能否在冻结正文中精确定位。
 * - locator 必须匹配 L<N> 或 L<M>-<N>（1 起、起≤止、不超正文行数）；
 * - excerpt 提供时：空白折叠后必须完整出现在定位行内。
 */
export function verifyCandidateLocator(body: string, locator: string, excerpt: string | undefined): LocatorVerdict {
  const trimmed = locator.trim();
  const match = LOCATOR_PATTERN.exec(trimmed);
  if (!match) {
    return { ok: false, reasonCode: 'LOCATOR_MALFORMED', reason: `locator 不匹配 L<行号> 或 L<起>-<止>：${locator}` };
  }
  if (!body.trim()) {
    return { ok: false, reasonCode: 'LOCATOR_NO_BODY', reason: '冻结 Source 无可定位正文（无正文缓存且无摘要）。' };
  }
  const start = Number(match[1]);
  const end = match[2] !== undefined ? Number(match[2]) : start;
  if (start < 1 || end < 1 || end < start) {
    return { ok: false, reasonCode: 'LOCATOR_MALFORMED', reason: `locator 行序非法（1 起、起≤止）：${locator}` };
  }
  const bodyLines = body.split(/\r?\n/);
  if (end > bodyLines.length) {
    return { ok: false, reasonCode: 'LOCATOR_OUT_OF_RANGE', reason: `locator 超出正文行数（正文共 ${bodyLines.length} 行）：${locator}` };
  }
  const excerptText = excerpt?.trim() ? normalizeForMatch(excerpt) : '';
  if (excerptText) {
    const target = normalizeForMatch(bodyLines.slice(start - 1, end).join('\n'));
    if (!target.includes(excerptText)) {
      return { ok: false, reasonCode: 'EXCERPT_NOT_IN_LOCATOR_LINES', reason: `excerpt 无法在 locator 定位行内精确匹配：${locator}` };
    }
  }
  return { ok: true };
}

// ============================================================
// 证据状态机（compiler §8.2 前置：证据不足不得宣称 supported/disputed/contradicted）
// ============================================================

export type EvidenceDowngradeResult = Readonly<{
  status: ConclusionStatus;
  downgraded: boolean;
}>;

/** claim → unverified；其余 kind（insight/concept/case/method/question/creative_pattern）→ inference。 */
export function downgradeConclusionStatus(
  kind: NoteKind,
  status: ConclusionStatus,
  evidenceLevel: EvidenceLevel
): EvidenceDowngradeResult {
  if (NON_SUPPORTABLE_STATUSES[status] && WEAK_EVIDENCE_LEVELS[evidenceLevel]) {
    return { status: kind === 'claim' ? 'unverified' : 'inference', downgraded: true };
  }
  return { status, downgraded: false };
}

// ============================================================
// 严格 manifest 解析（唯一 ```json 围栏块；解析失败 → 整批失败）
// ============================================================

function pushIssue(issues: ManifestIssue[], path: string, code: ManifestIssue['code'], reason: string): void {
  issues.push(Object.freeze({ path, code, reason }));
}

function checkUnknownKeys(
  issues: ManifestIssue[],
  value: Record<string, unknown>,
  allowed: Readonly<Record<string, true>>,
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) pushIssue(issues, `${path}.${key}`, 'unknown_field', `未知字段：${key}`);
  }
}

function requiredString(
  issues: ManifestIssue[],
  value: Record<string, unknown>,
  key: string,
  path: string
): string | undefined {
  const raw = value[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    pushIssue(issues, `${path}.${key}`, raw === undefined ? 'missing' : 'type', `${key} 必填且为非空字符串`);
    return undefined;
  }
  return raw.trim();
}

function optionalString(
  issues: ManifestIssue[],
  value: Record<string, unknown>,
  key: string,
  path: string
): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    pushIssue(issues, `${path}.${key}`, 'type', `${key} 必须为字符串`);
    return undefined;
  }
  return raw.trim();
}

function optionalNullableString(
  issues: ManifestIssue[],
  value: Record<string, unknown>,
  key: string,
  path: string
): string | null | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    pushIssue(issues, `${path}.${key}`, 'type', `${key} 必须为字符串或 null`);
    return undefined;
  }
  return raw.trim();
}

function optionalStringArray(
  issues: ManifestIssue[],
  value: Record<string, unknown>,
  key: string,
  path: string
): readonly string[] | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    pushIssue(issues, `${path}.${key}`, 'type', `${key} 必须为字符串数组`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      pushIssue(issues, `${path}.${key}`, 'type', `${key} 数组项必须为非空字符串`);
      return undefined;
    }
    out.push(item.trim());
  }
  return out;
}

function enumOf(
  issues: ManifestIssue[],
  value: Record<string, unknown>,
  key: string,
  table: Readonly<Record<string, true>>,
  path: string
): string | undefined {
  const raw = value[key];
  if (typeof raw !== 'string' || !table[raw]) {
    pushIssue(issues, `${path}.${key}`, raw === undefined ? 'missing' : 'enum', `${key} 枚举非法：${String(raw)}`);
    return undefined;
  }
  return raw;
}

/** 严格规范化 manifest（结构形状；fail-closed）。未知键/缺必填/类型错/枚举非法/重复键 → issues。 */
export function normalizeKnowledgeCandidatesManifest(raw: unknown): NormalizeResult {
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [Object.freeze({ path: '$', code: 'type', reason: 'manifest 必须是 JSON 对象' })] };
  }
  const issues: ManifestIssue[] = [];
  checkUnknownKeys(issues, raw, MANIFEST_ROOT_KEYS, '$');

  const reason = requiredString(issues, raw, 'reason', '$');
  const topicCompileRaw = raw.topicCompile;
  let topicCompile: KnowledgeCandidatesManifest['topicCompile'] = undefined;
  if (topicCompileRaw !== undefined && topicCompileRaw !== null) {
    if (!isPlainObject(topicCompileRaw)) {
      pushIssue(issues, '$.topicCompile', 'type', 'topicCompile 必须为对象');
    } else {
      checkUnknownKeys(issues, topicCompileRaw, TOPIC_COMPILE_KEYS, '$.topicCompile');
      const title = optionalString(issues, topicCompileRaw, 'title', '$.topicCompile');
      const summary = optionalString(issues, topicCompileRaw, 'summary', '$.topicCompile');
      if (title !== undefined || summary !== undefined) {
        topicCompile = Object.freeze({
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary } : {})
        });
      }
    }
  }

  const entitiesRaw = raw.entities;
  if (entitiesRaw !== undefined && !Array.isArray(entitiesRaw)) pushIssue(issues, '$.entities', 'type', 'entities 必须为数组');
  const notesRaw = raw.notes;
  if (notesRaw !== undefined && !Array.isArray(notesRaw)) pushIssue(issues, '$.notes', 'type', 'notes 必须为数组');

  const entityIssues: ManifestIssue[] = [];
  const entities: KnowledgeCandidatesEntityManifest[] = [];
  const entityKeys = new Set<string>();
  for (const [index, item] of (Array.isArray(entitiesRaw) ? entitiesRaw : []).entries()) {
    const path = `$.entities[${index}]`;
    if (!isPlainObject(item)) {
      pushIssue(entityIssues, path, 'type', 'entity 必须是对象');
      continue;
    }
    checkUnknownKeys(entityIssues, item, ENTITY_MANIFEST_KEYS, path);
    const entityType = enumOf(entityIssues, item, 'entityType', ENTITY_TYPES, path);
    const canonicalKey = requiredString(entityIssues, item, 'canonicalKey', path);
    const canonicalName = requiredString(entityIssues, item, 'canonicalName', path);
    const valueRationale = requiredString(entityIssues, item, 'valueRationale', path);
    const aliases = optionalStringArray(entityIssues, item, 'aliases', path);
    const excerpt = optionalString(entityIssues, item, 'excerpt', path);
    const externalIdentityRaw = item.externalIdentity;
    let externalIdentity: Readonly<Record<string, unknown>> | undefined;
    if (externalIdentityRaw !== undefined) {
      if (!isPlainObject(externalIdentityRaw)) {
        pushIssue(entityIssues, `${path}.externalIdentity`, 'type', 'externalIdentity 必须为对象');
      } else {
        externalIdentity = Object.freeze({ ...externalIdentityRaw });
      }
    }
    if (entityType && canonicalKey && canonicalName && valueRationale) {
      const key = normalizeCanonicalKey(canonicalKey);
      if (entityKeys.has(key)) {
        pushIssue(entityIssues, `${path}.canonicalKey`, 'duplicate', `Entity canonicalKey 重复：${canonicalKey}`);
      } else {
        entityKeys.add(key);
        entities.push(Object.freeze({
          entityType: entityType as EntityType,
          canonicalKey,
          canonicalName,
          valueRationale,
          ...(aliases?.length ? { aliases: Object.freeze(aliases) } : {}),
          ...(externalIdentity ? { externalIdentity } : {}),
          ...(excerpt ? { excerpt } : {})
        }));
      }
    }
  }

  const noteIssues: ManifestIssue[] = [];
  const notes: KnowledgeCandidatesNoteManifest[] = [];
  const noteKeys = new Set<string>();
  for (const [index, item] of (Array.isArray(notesRaw) ? notesRaw : []).entries()) {
    const path = `$.notes[${index}]`;
    if (!isPlainObject(item)) {
      pushIssue(noteIssues, path, 'type', 'note 必须是对象');
      continue;
    }
    checkUnknownKeys(noteIssues, item, NOTE_MANIFEST_KEYS, path);
    const kind = enumOf(noteIssues, item, 'kind', NOTE_KINDS, path);
    const canonicalKey = requiredString(noteIssues, item, 'canonicalKey', path);
    const statement = requiredString(noteIssues, item, 'statement', path);
    const conclusionStatus = enumOf(noteIssues, item, 'conclusionStatus', CONCLUSION_STATUSES, path);
    const evidenceLevel = enumOf(noteIssues, item, 'evidenceLevel', EVIDENCE_LEVELS, path);
    const locator = requiredString(noteIssues, item, 'locator', path);
    const valueRationale = requiredString(noteIssues, item, 'valueRationale', path);
    const title = optionalString(noteIssues, item, 'title', path);
    const body = optionalString(noteIssues, item, 'body', path);
    const appliesTo = optionalString(noteIssues, item, 'appliesTo', path);
    const validFrom = optionalNullableString(noteIssues, item, 'validFrom', path);
    const validUntil = optionalNullableString(noteIssues, item, 'validUntil', path);
    const changeReason = optionalString(noteIssues, item, 'changeReason', path);
    const excerpt = optionalString(noteIssues, item, 'excerpt', path);
    const changeType = optionalString(noteIssues, item, 'changeType', path);
    if (changeType !== undefined && !CHANGE_TYPES[changeType]) {
      pushIssue(noteIssues, `${path}.changeType`, 'enum', `changeType 枚举非法：${changeType}`);
    }
    const relation = optionalString(noteIssues, item, 'relation', path);
    if (relation !== undefined && !EVIDENCE_RELATIONS[relation]) {
      pushIssue(noteIssues, `${path}.relation`, 'enum', `relation 枚举非法：${relation}`);
    }
    const entityKeysRef = optionalStringArray(noteIssues, item, 'entityKeys', path);
    if (kind && canonicalKey && statement && conclusionStatus && evidenceLevel && locator && valueRationale) {
      // 契约 §8.1：Question 不能标记 supported
      if (QUESTION_KINDS[kind] && conclusionStatus === 'supported') {
        pushIssue(noteIssues, `${path}.conclusionStatus`, 'invalid', 'kind=question 不能标记 conclusionStatus=supported');
      }
      const key = normalizeCanonicalKey(canonicalKey);
      if (noteKeys.has(key)) {
        pushIssue(noteIssues, `${path}.canonicalKey`, 'duplicate', `Note canonicalKey 重复：${canonicalKey}`);
      } else {
        noteKeys.add(key);
        notes.push(Object.freeze({
          kind: kind as NoteKind,
          canonicalKey,
          statement,
          conclusionStatus: conclusionStatus as ConclusionStatus,
          evidenceLevel: evidenceLevel as EvidenceLevel,
          locator,
          valueRationale,
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          ...(appliesTo ? { appliesTo } : {}),
          ...(validFrom !== undefined ? { validFrom } : {}),
          ...(validUntil !== undefined ? { validUntil } : {}),
          ...(changeType ? { changeType: changeType as NoteVersionChangeType | 'no_change' } : {}),
          ...(changeReason ? { changeReason } : {}),
          ...(excerpt ? { excerpt } : {}),
          ...(relation ? { relation: relation as 'supports' | 'contradicts' | 'qualifies' } : {}),
          ...(entityKeysRef?.length ? { entityKeys: Object.freeze(entityKeysRef) } : {})
        }));
      }
    }
  }

  const allIssues = [...issues, ...entityIssues, ...noteIssues];
  if (allIssues.length > 0) return { ok: false, issues: Object.freeze(allIssues) };
  return {
    ok: true,
    manifest: Object.freeze({
      reason: reason as string,
      ...(topicCompile ? { topicCompile } : {}),
      entities: Object.freeze(entities),
      notes: Object.freeze(notes)
    })
  };
}

/**
 * 从模型输出文本中提取**唯一** ```json 围栏块声明的 `wmb_knowledge_candidates`。
 * 无围栏 / 无合法 JSON / 无 manifest 键 / 多个 manifest 块 → 整批失败（fail-closed）。
 */
export function extractKnowledgeCandidatesManifest(text: string): ManifestExtractResult {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) {
    return failure('MANIFEST_NOT_FOUND', '模型未输出 ```json 围栏块。');
  }
  let parsedAny = false;
  let manifestCount = 0;
  let envelope: Record<string, unknown> | null = null;
  let manifestRaw: unknown = null;
  for (const fence of fences) {
    let value: unknown;
    try {
      value = JSON.parse(fence[1]!);
    } catch {
      continue;
    }
    parsedAny = true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (!(KNOWLEDGE_CANDIDATES_MANIFEST_KEY in record)) continue;
    manifestCount += 1;
    manifestRaw = record[KNOWLEDGE_CANDIDATES_MANIFEST_KEY];
    envelope = record;
  }
  if (!parsedAny) {
    return failure('MANIFEST_JSON_INVALID', '```json 围栏块不是合法 JSON。');
  }
  if (manifestCount === 0) {
    return failure('MANIFEST_KEY_MISSING', `围栏块未声明 ${KNOWLEDGE_CANDIDATES_MANIFEST_KEY}。`);
  }
  if (manifestCount > 1) {
    return failure('MANIFEST_AMBIGUOUS', `模型输出了 ${manifestCount} 个 manifest 块，必须恰好一个。`, { count: manifestCount });
  }
  // envelope 严格：除 manifest 键外不允许其它兄弟字段
  const envelopeIssues: ManifestIssue[] = [];
  checkUnknownKeys(envelopeIssues, envelope as Record<string, unknown>, { [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: true }, '$');
  if (envelopeIssues.length > 0) {
    return failure('MANIFEST_INVALID', 'manifest 外层存在未知字段。', { issues: envelopeIssues });
  }
  const normalized = normalizeKnowledgeCandidatesManifest(manifestRaw);
  if (!normalized.ok) {
    const duplicates = normalized.issues.filter((issue) => issue.code === 'duplicate');
    if (duplicates.length > 0) {
      return failure('MANIFEST_DUPLICATE_KEY', 'manifest 包含重复 canonicalKey。', {
        keys: duplicates.map((issue) => issue.path)
      });
    }
    return failure('MANIFEST_INVALID', `manifest 结构非法（${normalized.issues.length} 处）。`, { issues: normalized.issues });
  }
  return { ok: true, manifest: normalized.manifest };
}

// ============================================================
// 计划构造（确定性：数组按 canonicalKey 排序；同输入 → 同字节）
// ============================================================

export type KnowledgeCandidateSkip = Readonly<{
  objectType: 'note' | 'entity';
  canonicalKey: string;
  stage: 'locator' | 'value';
  reasonCode: string;
  reason: string;
}>;

export type KnowledgeCandidateDowngrade = Readonly<{
  canonicalKey: string;
  from: ConclusionStatus;
  to: ConclusionStatus;
  reason: string;
}>;

function buildCandidatePlan(input: {
  requestId: string;
  workspaceId: string;
  sourceId: string;
  sourceRevision: number;
  topicId: string;
  scope: KnowledgeScope;
  createdBy?: CreatorNature;
  triggerSource?: TriggerSource;
  sourceNature?: SourceNature;
  manifest: KnowledgeCandidatesManifest;
  notes: readonly KnowledgeCandidatesNoteManifest[];
  entities: readonly KnowledgeCandidatesEntityManifest[];
}): KnowledgeCompilerInput {
  const entityCandidates: KnowledgeCompilerEntityCandidate[] = [...input.entities]
    .sort((left, right) => compareCanonicalKey(left.canonicalKey, right.canonicalKey))
    .map((entity) => Object.freeze({
      entityType: entity.entityType,
      canonicalKey: entity.canonicalKey,
      canonicalName: entity.canonicalName,
      valueRationale: entity.valueRationale,
      ...(entity.aliases?.length ? { aliases: entity.aliases } : {}),
      ...(entity.externalIdentity ? { externalIdentity: entity.externalIdentity } : {})
    }));
  const noteCandidates: KnowledgeCompilerNoteCandidate[] = [...input.notes]
    .sort((left, right) => compareCanonicalKey(left.canonicalKey, right.canonicalKey))
    .map((note) => Object.freeze({
      kind: note.kind,
      canonicalKey: note.canonicalKey,
      statement: note.statement,
      conclusionStatus: note.conclusionStatus,
      evidenceLevel: note.evidenceLevel,
      locator: note.locator,
      valueRationale: note.valueRationale,
      ...(note.title ? { title: note.title } : {}),
      ...(note.body ? { body: note.body } : {}),
      ...(note.appliesTo ? { appliesTo: note.appliesTo } : {}),
      ...(note.validFrom !== undefined ? { validFrom: note.validFrom } : {}),
      ...(note.validUntil !== undefined ? { validUntil: note.validUntil } : {}),
      ...(note.changeType ? { changeType: note.changeType } : {}),
      ...(note.changeReason ? { changeReason: note.changeReason } : {}),
      ...(note.excerpt ? { excerpt: note.excerpt } : {}),
      ...(note.relation ? { relation: note.relation } : {}),
      ...(note.entityKeys?.length ? { entityKeys: note.entityKeys } : {})
    }));
  return Object.freeze({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    topicId: input.topicId,
    scope: input.scope,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
    ...(input.sourceNature ? { sourceNature: input.sourceNature } : {}),
    reason: input.manifest.reason,
    entities: Object.freeze(entityCandidates),
    notes: Object.freeze(noteCandidates),
    ...(input.manifest.topicCompile ? { topicCompile: input.manifest.topicCompile } : {})
  });
}

// ============================================================
// 编排入口（冻结 → prompt → 模型调用 → 严格解析 → locator/证据/价值门 → 计划）
// ============================================================

export type KnowledgeCandidatePlanInput = Readonly<{
  workspaceId: string;
  sourceId: string;
  topicId: string;
  scope?: KnowledgeScope;
  createdBy?: CreatorNature;
  triggerSource?: TriggerSource;
  sourceNature?: SourceNature;
  /** 模型调用注入：输入冻结 prompt，返回原始输出文本。失败抛错 → MODEL_CALL_FAILED。 */
  modelCall: KnowledgeCandidatesModelCall;
}>;

export type KnowledgeCandidatePlan = Readonly<{
  ok: true;
  /** 可直接传给 compileSourceKnowledge 的严格 typed plan。 */
  plan: KnowledgeCompilerInput;
  /** 冻结 prompt（审计/重放用；同冻结输入字节稳定）。 */
  prompt: string;
  /** 严格规范化后的 manifest（不参与计划的部分仍保留，供审计）。 */
  manifest: KnowledgeCandidatesManifest;
  /** 未进入计划的候选及结构化原因。 */
  skipped: readonly KnowledgeCandidateSkip[];
  /** 机器降级的证据状态（compiler §8.2 前置）。 */
  downgraded: readonly KnowledgeCandidateDowngrade[];
  frozen: Readonly<{
    sourceId: string;
    sourceRevision: number;
    bodyKind: FrozenKnowledgeBodyKind;
    topicId: string;
  }>;
}>;

export type KnowledgeCandidatePlanResult = KnowledgeCandidatePlan | KnowledgeCandidatesFailure;

export async function generateKnowledgeCandidatePlan(
  database: DatabaseSync,
  input: KnowledgeCandidatePlanInput
): Promise<KnowledgeCandidatePlanResult> {
  const workspaceId = input.workspaceId?.trim();
  const sourceId = input.sourceId?.trim();
  const topicId = input.topicId?.trim();
  const scope: KnowledgeScope = input.scope ?? 'global';
  if (!workspaceId || !sourceId || !topicId) {
    return failure('INPUT_INVALID', 'workspaceId/sourceId/topicId 必填。');
  }
  if (scope !== 'global' && !scope.startsWith('lane:')) {
    return failure('INPUT_INVALID', 'scope 必须为 global 或 lane:<key>。', { scope });
  }
  if (typeof input.modelCall !== 'function') {
    return failure('INPUT_INVALID', '必须注入 modelCall（模型调用接口）。');
  }

  // ---- 冻结 Source + Topic（只读快照；写库由 WMB-5229 触发 compileSavedSource 完成） ----
  const frozenSource = freezeKnowledgeSource(database, sourceId);
  if (!frozenSource) {
    return failure('SOURCE_NOT_FOUND', `冻结 Source ${sourceId} 不存在（必须为真实已保存 Source）。`, { sourceId });
  }
  const frozenTopic = freezeKnowledgeTopic(database, topicId);
  if (!frozenTopic) {
    return failure('TOPIC_NOT_FOUND', `冻结 Topic ${topicId} 不存在。`, { topicId });
  }
  const context = getKnowledgeContext(database, { topicId, limit: KNOWLEDGE_CANDIDATES_CONTEXT_LIMIT });
  const frozenContext = freezeKnowledgeContext(context);
  const requestId = sourceCompileRequestId(frozenSource.source.id, frozenSource.source.revision);

  // ---- 确定性 prompt + 模型调用注入 ----
  const prompt = buildCandidatesPrompt({
    source: frozenSource.source,
    body: frozenSource.body,
    bodyKind: frozenSource.bodyKind,
    topic: frozenTopic,
    context: frozenContext,
    scope
  });
  let modelText: string;
  try {
    modelText = await input.modelCall(prompt);
  } catch (error) {
    return failure('MODEL_CALL_FAILED', `模型调用失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof modelText !== 'string' || !modelText.trim()) {
    return failure('MODEL_CALL_FAILED', '模型未返回文本。');
  }

  // ---- 严格 manifest（整批失败；零计划） ----
  const extracted = extractKnowledgeCandidatesManifest(modelText);
  if (!extracted.ok) return extracted;
  const manifest = extracted.manifest;

  // ---- locator 门 + 证据状态机 + 价值门（逐候选；结构化原因） ----
  const skipped: KnowledgeCandidateSkip[] = [];
  const downgraded: KnowledgeCandidateDowngrade[] = [];
  const notes: KnowledgeCandidatesNoteManifest[] = [];
  const entities: KnowledgeCandidatesEntityManifest[] = [];

  for (const note of manifest.notes) {
    // 价值门：纯复述不晋升（compiler 对既有 Note 的 no_change 也零晋升；新 Note 声明 no_change 会被编译器拒绝）
    if (note.changeType === 'no_change') {
      skipped.push(Object.freeze({
        objectType: 'note',
        canonicalKey: note.canonicalKey,
        stage: 'value',
        reasonCode: 'LOW_VALUE_RESTATEMENT',
        reason: '纯复述（changeType=no_change）不晋升。'
      }));
      continue;
    }
    const verdict = verifyCandidateLocator(frozenSource.body, note.locator, note.excerpt);
    if (!verdict.ok) {
      skipped.push(Object.freeze({
        objectType: 'note',
        canonicalKey: note.canonicalKey,
        stage: 'locator',
        reasonCode: verdict.reasonCode,
        reason: verdict.reason
      }));
      continue;
    }
    const machine = downgradeConclusionStatus(note.kind, note.conclusionStatus, note.evidenceLevel);
    if (machine.downgraded) {
      downgraded.push(Object.freeze({
        canonicalKey: note.canonicalKey,
        from: note.conclusionStatus,
        to: machine.status,
        reason: `证据等级 ${note.evidenceLevel} 不足以宣称 ${note.conclusionStatus}，机器降级。`
      }));
    }
    notes.push(Object.freeze({ ...note, conclusionStatus: machine.status }));
  }

  for (const entity of manifest.entities) {
    const excerptText = entity.excerpt?.trim() ?? '';
    if (!excerptText) {
      skipped.push(Object.freeze({
        objectType: 'entity',
        canonicalKey: entity.canonicalKey,
        stage: 'locator',
        reasonCode: 'ENTITY_EXCERPT_MISSING',
        reason: 'Entity 候选缺少可定位正文原句 excerpt。'
      }));
      continue;
    }
    const excerptInBody = frozenSource.body.trim()
      && normalizeForMatch(frozenSource.body).includes(normalizeForMatch(excerptText));
    if (!excerptInBody) {
      skipped.push(Object.freeze({
        objectType: 'entity',
        canonicalKey: entity.canonicalKey,
        stage: 'locator',
        reasonCode: 'ENTITY_EXCERPT_NOT_IN_BODY',
        reason: 'Entity excerpt 无法在冻结正文中匹配。'
      }));
      continue;
    }
    entities.push(entity);
  }

  const plan = buildCandidatePlan({
    requestId,
    workspaceId,
    sourceId: frozenSource.source.id,
    sourceRevision: frozenSource.source.revision,
    topicId,
    scope,
    createdBy: input.createdBy,
    triggerSource: input.triggerSource,
    sourceNature: input.sourceNature,
    manifest,
    notes,
    entities
  });

  return Object.freeze({
    ok: true,
    plan,
    prompt,
    manifest,
    skipped: Object.freeze([...skipped].sort((l, r) => compareCanonicalKey(l.canonicalKey, r.canonicalKey))),
    downgraded: Object.freeze([...downgraded].sort((l, r) => compareCanonicalKey(l.canonicalKey, r.canonicalKey))),
    frozen: Object.freeze({
      sourceId: frozenSource.source.id,
      sourceRevision: frozenSource.source.revision,
      bodyKind: frozenSource.bodyKind,
      topicId
    })
  });
}

// 供外部断言确定性的稳定摘要（可选；不参与计划字节本身）。
export function knowledgeCandidatePlanHash(plan: KnowledgeCompilerInput): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
