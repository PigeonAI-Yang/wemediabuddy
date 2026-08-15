/**
 * WMB-5216 M7：知识健康（Health owner slice）。
 * Design: docs/spark/2026-08-12-wmb-outcome-feedback-knowledge-health-design.md §6–§9/§12–§13
 * 契约: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md §26/§27
 *
 * 本模块提供：
 * - 有界局部 Lint（runLocalLint）：只检查调用方指定的受影响对象及有限邻域，单 ChangeSet 原子写；
 * - 可恢复周期 Lint（beginPeriodicLint / runPeriodicLintStep / getPeriodicLintCheckpoint /
 *   cancelPeriodicLint）：按 id 分页扫描，checkpoint 存 app_meta 既有 KV（v56 表可承载，
 *   无需 migration），中断后续跑续扫不重复 Issue；每步一个原子 ChangeSet，崩溃后重试要么
 *   原样重放要么零写（不产生 REQUEST_REPLAY_CONFLICT）；
 * - Issue 生命周期：open → repairing → resolved / accepted_risk / false_positive 全部经
 *   applyKnowledgeChangeSet 的既有契约流转；条件消除时自动解决，可审计；
 * - 自动修复仅限确定性 broken reference（formal relation 端点不存在 → 终止关系）；
 *   可信冲突（unresolved_contradiction 等）恒保持 open，机器强制 allowlist 边界；
 * - 稳定 requestId（lint:local:* / lint:periodic:{runId}:step:{n}）、workspace/lane/data-root
 *   隔离（store 原生 assertWorkspaceMatches/assertScopeAllowed + 扫描按 scope 过滤）、
 *   受影响范围上限（maxAffectedObjects / maxIssuesPerRun / pageSize）与 dataChanged 广播。
 *
 * WMB-5237（知识完整性七类补齐）：新增检测器 orphan_knowledge / missing_wiki_page /
 * unsupported_claim / stale_claim / duplicate_knowledge / duplicate_entity / cross_reference /
 * data_gap，全部为确定性 SQLite 判定（正式对象/版本/证据关系），并入局部与周期 Lint：
 * - 每类计划带稳定 fingerprint（对象 id + anchor），重复扫描不重复 Issue；
 * - 条件消除（对象被连接/修复/归档/重新编译）时确定性 Issue 自动 resolved；
 *   disputed/contradicted 等真实争议恒保持 open，不自动裁决；
 * - cross_reference 复用 issueType=broken_reference（affectedObjectType='wiki_page' 区分），
 *   只校验 Wiki 页面当前版本的结构化正式引用（adopted_note_version_ids / business_object_refs），
 *   不做自由文本猜测；data_gap 新增 issue_type（v60 migration 重建表追加 CHECK 取值）；
 * - 扫描 phase 扩展为 14 个（每 phase 一个查询 + 一个 id 游标），checkpoint 键升级
 *   knowledge_lint_checkpoint_v2（旧 v1 游标语义与新 phase 集不对齐），检测器版本升至 '2'。
 *
 * 不修改：Review/Publication/Metric 保存链、结果回流模块（outcome-feedback.ts）、编译器。
 * 正式知识写只经 applyKnowledgeChangeSet；不新增表（checkpoint 复用 app_meta 既有 KV：
 * v56 无专用 lint 状态表，且「可暂停恢复的扫描游标」不是知识对象，不属 knowledge_health_issues
 * 语义，故用与 agent_avatars_v1 同模式的 app_meta KV 承载，无需 migration）。
 *
 * 写上下文契约：与编译器一致，本模块的正式写（ChangeSet）与 checkpoint（app_meta）在激活
 * 运行时的 write-guard 下都要求授权写上下文（dispatchBusinessCommand 内）——调用方（周期
 * 调度/job pool，WMB-5218 接线）必须把 runLocalLint / runPeriodicLintStep 包进已授权命令；
 * 本模块只面向 DB 句柄，不自己打开 dispatch。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  applyKnowledgeChangeSet,
  assertScopeAllowed,
  getHealthIssue,
  setKnowledgeChangeSetLintTrigger,
  type ApplyChangeSetResult,
  type CreatorNature,
  type HealthIssueSeverity,
  type HealthIssueType,
  type HealthIssueWrite,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type KnowledgeHealthIssueRecord,
  type KnowledgeScope,
  type KnowledgeUpdateReceiptRecord,
  type RelationWrite
} from './knowledge-flywheel.ts';

// ============================================================
// 错误与常量
// ============================================================

export class KnowledgeHealthError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'KnowledgeHealthError';
    this.code = code;
    this.details = details;
  }
}

export const KNOWLEDGE_HEALTH_ERROR_CODES = Object.freeze([
  'HEALTH_LINT_INPUT_INVALID',
  'HEALTH_LINT_SCOPE_EXCEEDED',
  'HEALTH_LINT_WORKSPACE_MISMATCH',
  'HEALTH_LINT_NO_CHECKPOINT',
  'HEALTH_LINT_DETECTOR_INVALID',
  'HEALTH_LINT_REPAIR_NOT_ALLOWED'
] as const);

/** 检测器版本：false_positive 防重复报警按此版本识别；语义变化时递增。 */
export const KNOWLEDGE_HEALTH_DETECTOR_VERSION = '2' as const;

export const KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON = 'knowledge_health.lint' as const;

// WMB-5237：检测器集合/扫描阶段已扩展，旧 checkpoint（v1 游标语义）不与新阶段对齐 → 换新键，
// 旧 running checkpoint 自然失效（readCheckpoint 返回 null），新一轮周期从头扫描且不重复旧 Issue。
const CHECKPOINT_META_KEY = 'knowledge_lint_checkpoint_v2';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const DEFAULT_MAX_AFFECTED_OBJECTS = 100;
const DEFAULT_MAX_ISSUES_PER_RUN = 50;
const LANE_PREFIX = 'lane:';

/** data_gap 业务阈值：captured FreeNote 超过该天数仍未处理即视为知识管线数据缺口。 */
export const DATA_GAP_FREE_NOTE_MAX_AGE_DAYS = 14 as const;

/** data-gap 检测/复查共用的确定性截止时间（captured 且 created_at 早于该值才构成缺口）。 */
function dataGapCutoffIso(): string {
  return new Date(Date.now() - DATA_GAP_FREE_NOTE_MAX_AGE_DAYS * 86_400_000).toISOString();
}

export type HealthLintDetector =
  | 'broken_reference'
  | 'unreturned_review'
  | 'unresolved_contradiction'
  | 'stale_wiki_page'
  | 'orphan_knowledge'
  | 'missing_wiki_page'
  | 'unsupported_claim'
  | 'stale_claim'
  | 'duplicate_knowledge'
  | 'duplicate_entity'
  | 'cross_reference'
  | 'data_gap';

export const KNOWLEDGE_HEALTH_DETECTORS: Readonly<Record<HealthLintDetector, HealthIssueType>> = Object.freeze({
  broken_reference: 'broken_reference',
  unreturned_review: 'unreturned_review',
  unresolved_contradiction: 'unresolved_contradiction',
  stale_wiki_page: 'stale_wiki_page',
  orphan_knowledge: 'orphan_knowledge',
  missing_wiki_page: 'missing_wiki_page',
  unsupported_claim: 'unsupported_claim',
  stale_claim: 'stale_claim',
  duplicate_knowledge: 'duplicate_knowledge',
  duplicate_entity: 'duplicate_entity',
  // Wiki 正文/结构中的不可解析正式引用（cross-reference）是 broken_reference 的一种：
  // 以 affectedObjectType='wiki_page' 区分，不新增 issue_type。
  cross_reference: 'broken_reference',
  data_gap: 'data_gap'
});

const ALL_DETECTORS: readonly HealthLintDetector[] = Object.keys(KNOWLEDGE_HEALTH_DETECTORS) as HealthLintDetector[];

/** 自动修复 allowlist：只有列出的 issueType 允许自动 ChangeSet 修复（契约 §8 边界）。 */
const AUTO_REPAIR_ALLOWLIST: Readonly<Record<HealthIssueType, boolean>> = Object.freeze({
  broken_reference: true,
  stale_claim: false,
  unresolved_contradiction: false,
  unsupported_claim: false,
  duplicate_entity: false,
  duplicate_knowledge: false,
  orphan_knowledge: false,
  missing_wiki_page: false,
  stale_wiki_page: false,
  unreturned_review: false,
  underperforming_method: false,
  overgeneralized_global: false,
  unanswered_high_value_question: false,
  data_gap: false
});

export type HealthLintPhase =
  | 'relations'
  | 'evidence_links'
  | 'reviews'
  | 'notes'
  | 'wiki_pages'
  | 'missing_entity_pages'
  | 'missing_topic_pages'
  | 'orphan_notes'
  | 'unsupported_claims'
  | 'stale_claims'
  | 'duplicate_notes'
  | 'duplicate_entities'
  | 'cross_references'
  | 'data_gaps';

/** 每个 phase 恰好一个扫描查询 + 一个 id 游标（游标跨查询混用会漏扫，故按查询拆 phase）。 */
const PHASE_ORDER: readonly HealthLintPhase[] = [
  'relations', 'evidence_links', 'reviews', 'notes', 'wiki_pages',
  'missing_entity_pages', 'missing_topic_pages', 'orphan_notes',
  'unsupported_claims', 'stale_claims', 'duplicate_notes', 'duplicate_entities',
  'cross_references', 'data_gaps'
];

/** 正式关系端点存在性检查的目标表（与 store ENDPOINT_TABLES 对齐；全 schema 下恒存在）。 */
const ENDPOINT_TABLES: Readonly<Record<string, string>> = Object.freeze({
  knowledge_note: 'knowledge_notes',
  knowledge_note_version: 'knowledge_note_versions',
  knowledge_entity: 'knowledge_entities',
  wiki_page: 'knowledge_wiki_pages',
  free_note: 'knowledge_free_notes',
  source: 'source_items',
  topic: 'topics',
  content_project: 'content_projects',
  review: 'reviews',
  method_finding: 'method_findings'
});

/** 证据对象存在性检查的目标表（与 store EVIDENCE_OBJECT_TABLES 对齐）。 */
const EVIDENCE_OBJECT_TABLES: Readonly<Record<string, string>> = Object.freeze({
  source: 'source_items',
  free_note: 'knowledge_free_notes',
  review: 'reviews',
  publication: 'publications',
  metric_snapshot: 'publication_metric_snapshots',
  knowledge_note_version: 'knowledge_note_versions',
  wiki_page_version: 'knowledge_wiki_page_versions',
  content_version: 'content_versions',
  platform_version: 'platform_versions'
});

/**
 * Wiki 正文/结构可解析正式引用的对象表（cross-reference 检测）。
 * 引用形态来自既有写方：`source:<id>:r<rev>`（compiler）、`topic:<id>`（legacy-init）、
 * `review:<id>`（outcome-feedback）、`wiki_version:<id>` / `note_version:<id>`（query-writeback），
 * 以及 adopted_note_version_ids_json。只认已知 type；未知形态不做自由文本猜测（放行）。
 * 注意：`source:<id>:r<rev>` 的 revision 段属 Source revision slice 的表，本切片不依赖未提交符号，
 * 只校验对象 id 存在性（对象整体删除才算坏引用）。
 */
const WIKI_REF_TABLES: Readonly<Record<string, string>> = Object.freeze({
  source: 'source_items',
  topic: 'topics',
  review: 'reviews',
  wiki_version: 'knowledge_wiki_page_versions',
  note_version: 'knowledge_note_versions',
  knowledge_note: 'knowledge_notes',
  knowledge_entity: 'knowledge_entities',
  free_note: 'knowledge_free_notes',
  publication: 'publications'
});

// ============================================================
// 工具
// ============================================================

function lintError(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KnowledgeHealthError(code, message, details);
}

function now(): string {
  return new Date().toISOString();
}

/** 确定性对象 id（幂等关键）：同 seed → 同 id。 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

/** 存在性检查（全 schema 下表恒存在；缺表视为无法验证放行，与 store objectExists 语义一致）。 */
function objectExists(database: DatabaseSync, table: string, id: string): boolean {
  try {
    return database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  } catch {
    return true;
  }
}

function parseEvidence(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(String(row.evidenceJson ?? '{}')) as Record<string, unknown>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function normalizeDetectors(raw: readonly HealthLintDetector[] | undefined): readonly HealthLintDetector[] {
  if (raw === undefined || raw === null) return ALL_DETECTORS;
  const out: HealthLintDetector[] = [];
  for (const item of raw) {
    if (!(item in KNOWLEDGE_HEALTH_DETECTORS)) {
      lintError('HEALTH_LINT_DETECTOR_INVALID', `非法检测器：${String(item)}。`, { detector: item });
    }
    if (!out.includes(item)) out.push(item);
  }
  return out.length ? out : ALL_DETECTORS;
}

function validateScope(scope: unknown): KnowledgeScope {
  if (scope === 'global') return 'global';
  if (typeof scope === 'string' && scope.startsWith(LANE_PREFIX) && scope.length > LANE_PREFIX.length) {
    return scope as KnowledgeScope;
  }
  lintError('HEALTH_LINT_INPUT_INVALID', `非法 scope：${String(scope)}（必须为 global 或 lane:<key>）。`, { scope });
}

function validateWorkspace(workspaceId: unknown): string {
  if (typeof workspaceId === 'string' && workspaceId.trim()) return workspaceId.trim();
  lintError('HEALTH_LINT_INPUT_INVALID', 'Lint 必须携带 workspaceId。');
}

function validateRequestId(requestId: unknown): string {
  if (typeof requestId === 'string' && requestId.trim()) return requestId.trim();
  lintError('HEALTH_LINT_INPUT_INVALID', 'Lint 必须携带 requestId（幂等键）。');
}

/** 受影响对象去重（同 objectType+objectId 只扫一次）。 */
function uniqueRefs(refs: readonly HealthLintObjectRef[]): HealthLintObjectRef[] {
  const seen = new Set<string>();
  const out: HealthLintObjectRef[] = [];
  for (const ref of refs) {
    const type = String(ref?.objectType ?? '').trim();
    const id = String(ref?.objectId ?? '').trim();
    if (!type || !id) lintError('HEALTH_LINT_INPUT_INVALID', '受影响对象必须携带 objectType 与 objectId。');
    const key = `${type}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ objectType: type, objectId: id });
  }
  return out;
}

// ============================================================
// 计划与指纹
// ============================================================

export type HealthLintObjectRef = Readonly<{
  objectType: string;
  objectId: string;
}>;

export type HealthLintIssuePlan = Readonly<{
  issueType: HealthIssueType;
  affectedObjectType: string;
  affectedObjectId: string;
  severity: HealthIssueSeverity;
  /** 稳定问题指纹（同一问题重扫相同；跨投影/跨 run 同 id）。 */
  anchor: string;
  detail: string;
  suggestedAction: string;
  autoRepair?: Readonly<{ kind: 'end_relation'; relationId: string }>;
}>;

function issueFingerprint(scope: KnowledgeScope, plan: HealthLintIssuePlan): string {
  return JSON.stringify({
    issueType: plan.issueType,
    scope,
    affectedObjectType: plan.affectedObjectType,
    affectedObjectId: plan.affectedObjectId,
    anchor: plan.anchor
  });
}

function buildEvidence(
  scope: KnowledgeScope,
  plan: HealthLintIssuePlan,
  detectors: readonly HealthLintDetector[]
): Readonly<Record<string, unknown>> {
  return {
    fingerprint: issueFingerprint(scope, plan),
    anchor: plan.anchor,
    detail: plan.detail,
    detectorVersion: KNOWLEDGE_HEALTH_DETECTOR_VERSION,
    lint: { scope, detectors: [...detectors].sort() }
  };
}

function nextIssueId(existingCount: number, fingerprint: string): string {
  const base = deterministicId('health', fingerprint);
  return existingCount === 0 ? base : `${base}-e${existingCount + 1}`;
}

/** 同指纹既有 Issue（含终态；用于去重/重开新事件/修复定位）。 */
function findIssuesForPlan(
  database: DatabaseSync,
  scope: KnowledgeScope,
  plan: HealthLintIssuePlan
): Array<{ id: string; status: string; revision: number; evidence: Readonly<Record<string, unknown>> }> {
  const rows = database.prepare(
    `SELECT id, status, revision, evidence_json AS evidenceJson
     FROM knowledge_health_issues
     WHERE scope = ? AND issue_type = ? AND affected_object_type = ? AND affected_object_id = ?`
  ).all(scope, plan.issueType, plan.affectedObjectType, plan.affectedObjectId) as Array<Record<string, unknown>>;
  const fp = issueFingerprint(scope, plan);
  const out: Array<{ id: string; status: string; revision: number; evidence: Readonly<Record<string, unknown>> }> = [];
  for (const row of rows) {
    const evidence = parseEvidence(row);
    if (evidence.fingerprint !== fp) continue;
    out.push({ id: String(row.id), status: String(row.status), revision: Number(row.revision), evidence });
  }
  return out;
}

// ============================================================
// 检测器（只读；scope 内过滤）
// ============================================================

type DetectorContext = Readonly<{
  database: DatabaseSync;
  workspaceId: string;
  scope: KnowledgeScope;
  detectors: readonly HealthLintDetector[];
}>;

/** 有界读：活动关系分页行。 */
function listActiveRelationRows(
  database: DatabaseSync,
  scope: KnowledgeScope,
  cursor: string,
  limit: number
): Array<Record<string, unknown>> {
  const scopeValue: string = scope;
  return database.prepare(
    `SELECT id, scope, relation_key AS relationKey, from_object_type AS fromObjectType, from_object_id AS fromObjectId,
       to_object_type AS toObjectType, to_object_id AS toObjectId
     FROM knowledge_formal_relations
     WHERE ended_change_set_id IS NULL AND scope = ? AND id > ?
     ORDER BY id LIMIT ?`
  ).all(scopeValue, cursor, limit) as Array<Record<string, unknown>>;
}

function relationGhostEndpoints(database: DatabaseSync, row: Record<string, unknown>): Array<{ type: string; id: string }> {
  const ghosts: Array<{ type: string; id: string }> = [];
  const pairs: Array<[string, string]> = [
    [String(row.fromObjectType), String(row.fromObjectId)],
    [String(row.toObjectType), String(row.toObjectId)]
  ];
  for (const [type, id] of pairs) {
    const table = ENDPOINT_TABLES[type];
    if (!table) continue;
    if (!objectExists(database, table, id)) ghosts.push({ type, id });
  }
  return ghosts;
}

function brokenRelationPlan(ctx: DetectorContext, row: Record<string, unknown>): HealthLintIssuePlan | null {
  if (String(row.scope) !== ctx.scope) return null; // lane 隔离：不越 scope 检查
  const ghosts = relationGhostEndpoints(ctx.database, row);
  if (!ghosts.length) return null;
  const relationId = String(row.id);
  return Object.freeze({
    issueType: 'broken_reference',
    affectedObjectType: 'knowledge_relation',
    affectedObjectId: relationId,
    severity: 'high',
    anchor: `relation:${relationId}:${String(row.fromObjectType)}:${String(row.fromObjectId)}->${String(row.toObjectType)}:${String(row.toObjectId)}`,
    detail: `活动关系 ${String(row.relationKey)} 端点不存在：${ghosts.map((g) => `${g.type}:${g.id}`).join('、')}。`,
    suggestedAction: '确定性修复：自动终止该关系。',
    autoRepair: Object.freeze({ kind: 'end_relation' as const, relationId })
  });
}

/** 有界读：证据链接分页行（按 Note 的 scope 过滤；证据链接本身无 scope 列）。 */
function listEvidenceLinkRows(
  database: DatabaseSync,
  scope: KnowledgeScope,
  cursor: string,
  limit: number
): Array<Record<string, unknown>> {
  return database.prepare(
    `SELECT e.id, e.knowledge_note_version_id AS noteVersionId, e.evidence_object_type AS evidenceObjectType,
       e.evidence_object_id AS evidenceObjectId
     FROM knowledge_evidence_links e
     JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
     JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.scope = ? AND e.id > ?
     ORDER BY e.id LIMIT ?`
  ).all(scope, cursor, limit) as Array<Record<string, unknown>>;
}

function brokenEvidencePlan(ctx: DetectorContext, row: Record<string, unknown>): HealthLintIssuePlan | null {
  const type = String(row.evidenceObjectType);
  const id = String(row.evidenceObjectId);
  const table = EVIDENCE_OBJECT_TABLES[type];
  if (!table) return null;
  if (objectExists(ctx.database, table, id)) return null;
  const linkId = String(row.id);
  const noteVersionId = String(row.noteVersionId);
  return Object.freeze({
    issueType: 'broken_reference',
    affectedObjectType: 'knowledge_note_version',
    affectedObjectId: noteVersionId,
    severity: 'medium',
    anchor: `evidence:${linkId}:${type}:${id}`,
    detail: `证据链接 ${linkId} 指向不存在的 ${type}:${id}（源对象已被删除）。`,
    suggestedAction: '证据链接不可变不可删除；请人工更新 Note 版本或接受风险。'
  });
}

/** outcome 回流检测键（与 ImplementOutcomeFeedback 约定：`outcome:review:{reviewId}`）。 */
export function reviewOutcomeRequestId(reviewId: string): string {
  return `outcome:review:${reviewId}`;
}

function reviewFlowbackExists(database: DatabaseSync, workspaceId: string, reviewId: string): boolean {
  const row = database.prepare(
    `SELECT 1 FROM knowledge_change_sets
     WHERE workspace_id = ? AND request_id = ? AND trigger_source = 'review'`
  ).get(workspaceId, reviewOutcomeRequestId(reviewId));
  return row !== undefined;
}

function unreturnedReviewPlan(
  ctx: DetectorContext,
  reviewId: string,
  status: string
): HealthLintIssuePlan | null {
  if (ctx.scope !== 'global') return null; // 业务对象（Review）只在 global 层 lint
  if (status !== 'final') return null;
  if (reviewFlowbackExists(ctx.database, ctx.workspaceId, reviewId)) return null;
  return Object.freeze({
    issueType: 'unreturned_review',
    affectedObjectType: 'review',
    affectedObjectId: reviewId,
    severity: 'medium',
    anchor: `review:${reviewId}`,
    detail: 'final Review 尚未按发布时 Usage 回流。',
    suggestedAction: '等待 Review 回流；回流 ChangeSet 出现后自动解决。'
  });
}

function unresolvedContradictionPlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('unresolved_contradiction')) return null;
  const row = ctx.database.prepare(
    `SELECT n.lifecycle AS lifecycle, v.conclusion_status AS conclusionStatus
     FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     WHERE n.id = ? AND n.scope = ?`
  ).get(noteId, ctx.scope) as Record<string, unknown> | undefined;
  if (!row || String(row.lifecycle) !== 'active' || String(row.conclusionStatus) !== 'disputed') return null;
  return Object.freeze({
    issueType: 'unresolved_contradiction',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `note:${noteId}:current-disputed`,
    detail: '当前认识版本为 disputed：可信证据仍存在实质分歧。',
    suggestedAction: '保留争议，不自动裁决；需人工或 AI 评估后再决定强化/限域/拆分。'
  });
}

function staleWikiPagePlan(ctx: DetectorContext, pageId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('stale_wiki_page')) return null;
  const row = ctx.database.prepare(
    `SELECT compile_status AS compileStatus, lifecycle FROM knowledge_wiki_pages WHERE id = ? AND scope = ?`
  ).get(pageId, ctx.scope) as Record<string, unknown> | undefined;
  if (!row || String(row.lifecycle) !== 'active' || String(row.compileStatus) !== 'stale') return null;
  return Object.freeze({
    issueType: 'stale_wiki_page',
    affectedObjectType: 'wiki_page',
    affectedObjectId: pageId,
    severity: 'low',
    anchor: `page:${pageId}:stale`,
    detail: 'Wiki 页面 compile_status=stale 但仍为当前页面。',
    suggestedAction: '有新资料待整理；整理后自动解决。'
  });
}

// ============================================================
// WMB-5237 知识完整性检测器（确定性；全部基于正式 SQLite 对象/版本/证据关系）
// ============================================================
// 七类：orphan（orphan_knowledge）、missing-page（missing_wiki_page）、duplicate
// （duplicate_knowledge / duplicate_entity）、unsupported（unsupported_claim）、
// stale-claim（stale_claim）、cross-reference（broken_reference@wiki_page）、
// data-gap（data_gap）。每类条件函数同时充当「problem 判定」，供计划与自动解决复用：
// 条件消除（对象被连接/修复/归档/重新编译）→ 确定性 Issue 自动 resolved；
// disputed/contradicted 等真实争议恒保持 open，不自动裁决。

/** 孤立条件：活动 Note（非 question）无任何证据链接、无任何活动正式关系、未被活动 Wiki 页面采纳。 */
function orphanNoteCondition(ctx: DetectorContext, noteId: string): boolean {
  const database = ctx.database;
  const row = database.prepare(
    `SELECT n.id FROM knowledge_notes n
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active' AND n.kind != 'question'
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_evidence_links e
         JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
         WHERE v.note_id = n.id)
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_formal_relations r
         WHERE r.scope = n.scope AND r.ended_change_set_id IS NULL
           AND (r.from_object_id = n.id OR r.to_object_id = n.id))`
  ).get(noteId, ctx.scope);
  if (!row) return false;
  // 采纳按不可变版本 id 判定（adopted_note_version_ids_json 为 JSON 数组字符串；id 无引号安全）
  const versions = database.prepare('SELECT id FROM knowledge_note_versions WHERE note_id = ?').all(noteId) as Array<{ id: string }>;
  for (const version of versions) {
    const adopted = database.prepare(
      `SELECT 1 FROM knowledge_wiki_page_versions w
       JOIN knowledge_wiki_pages p ON p.id = w.page_id
       WHERE p.scope = ? AND p.lifecycle = 'active' AND w.adopted_note_version_ids_json LIKE ? LIMIT 1`
    ).get(ctx.scope, `%"${version.id}"%`);
    if (adopted) return false;
  }
  return true;
}

function orphanKnowledgePlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('orphan_knowledge')) return null;
  if (!orphanNoteCondition(ctx, noteId)) return null;
  return Object.freeze({
    issueType: 'orphan_knowledge',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'low',
    anchor: `note:${noteId}:orphan`,
    detail: '活动知识 Note 完全孤立：无证据链接、无正式关系、未被任何 Wiki 页面采纳。',
    suggestedAction: '人工复核：补充证据/关系或并入当前认识；确认无意义可归档。'
  });
}

/** unsupported 条件：当前认识版本宣称 supported/contradicted，但没有任何有效 EvidenceLink。 */
function noteUnsupportedCondition(ctx: DetectorContext, noteId: string): boolean {
  const row = ctx.database.prepare(
    `SELECT 1 FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active'
       AND v.conclusion_status IN ('supported','contradicted')
       AND NOT EXISTS (SELECT 1 FROM knowledge_evidence_links e WHERE e.knowledge_note_version_id = v.id)`
  ).get(noteId, ctx.scope);
  return row !== undefined;
}

function unsupportedClaimPlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('unsupported_claim')) return null;
  if (!noteUnsupportedCondition(ctx, noteId)) return null;
  return Object.freeze({
    issueType: 'unsupported_claim',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `note:${noteId}:unsupported`,
    detail: '当前认识版本结论为 supported/contradicted，但没有任何有效 EvidenceLink 支撑。',
    suggestedAction: '人工复核：补充证据链接，或把结论降级为 unverified/inference。'
  });
}

/** stale 条件：当前认识版本带明确 valid_until 且已过时（确定性阈值 = 既有时间字段本身）。 */
function noteStaleCondition(ctx: DetectorContext, noteId: string, nowIso: string): boolean {
  const row = ctx.database.prepare(
    `SELECT 1 FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active'
       AND v.valid_until IS NOT NULL AND v.valid_until < ?`
  ).get(noteId, ctx.scope, nowIso);
  return row !== undefined;
}

function staleClaimPlan(ctx: DetectorContext, noteId: string, nowIso: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('stale_claim')) return null;
  if (!noteStaleCondition(ctx, noteId, nowIso)) return null;
  return Object.freeze({
    issueType: 'stale_claim',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `note:${noteId}:stale-claim`,
    detail: '当前认识版本已过明确有效期（valid_until 已到期）。',
    suggestedAction: '人工复核：更新该 Claim 的有效期/内容，或将其归档。'
  });
}

/** 重复知识条件：同 scope 存在另一活动 Note，当前陈述逐字相同（同 kind）。 */
function duplicateKnowledgePartner(ctx: DetectorContext, noteId: string): string | null {
  const row = ctx.database.prepare(
    `SELECT MIN(n2.id) AS partnerId FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     JOIN knowledge_notes n2 ON n2.scope = n.scope AND n2.lifecycle = 'active' AND n2.id != n.id
     JOIN knowledge_note_versions v2 ON v2.id = n2.current_version_id
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active'
       AND n2.kind = n.kind AND trim(lower(v2.statement)) = trim(lower(v.statement))`
  ).get(noteId, ctx.scope) as { partnerId: string | null } | undefined;
  return row?.partnerId ?? null;
}

function duplicateKnowledgePlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('duplicate_knowledge')) return null;
  const partnerId = duplicateKnowledgePartner(ctx, noteId);
  if (!partnerId) return null;
  const pairKey = [noteId, partnerId].sort().join(':');
  return Object.freeze({
    issueType: 'duplicate_knowledge',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `duplicate-note:${pairKey}`,
    detail: `活动 Note 与 ${partnerId} 的当前认识版本陈述逐字相同（同 kind），疑似重复知识。`,
    suggestedAction: '人工复核：合并/限域，或确认并存理由（不自动裁决）。'
  });
}

/** 重复实体条件：同 scope 存在另一活动 Entity，强外部身份（external_identity_json）完全相同。 */
function duplicateEntityPartner(ctx: DetectorContext, entityId: string): string | null {
  const row = ctx.database.prepare(
    `SELECT MIN(e2.id) AS partnerId FROM knowledge_entities e
     JOIN knowledge_entities e2 ON e2.scope = e.scope AND e2.lifecycle = 'active' AND e2.id != e.id
     WHERE e.id = ? AND e.scope = ? AND e.lifecycle = 'active' AND e.external_identity_json != '{}'
       AND e2.external_identity_json = e.external_identity_json`
  ).get(entityId, ctx.scope) as { partnerId: string | null } | undefined;
  return row?.partnerId ?? null;
}

function duplicateEntityPlan(ctx: DetectorContext, entityId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('duplicate_entity')) return null;
  const partnerId = duplicateEntityPartner(ctx, entityId);
  if (!partnerId) return null;
  const pairKey = [entityId, partnerId].sort().join(':');
  return Object.freeze({
    issueType: 'duplicate_entity',
    affectedObjectType: 'knowledge_entity',
    affectedObjectId: entityId,
    severity: 'high',
    anchor: `duplicate-entity:${pairKey}`,
    detail: `活动 Entity 与 ${partnerId} 具有完全相同的强外部身份（external_identity_json），疑似同一现实身份。`,
    suggestedAction: '人工复核：合并实体或确认为不同语境身份（强身份重复为确定性信号，但仍不自动裁决）。'
  });
}

/** 实体/主题被当前知识引用：被活动 Note 版本采纳（JSON id 数组）或作为活动正式关系目标。 */
function entityReferencedInScope(ctx: DetectorContext, entityId: string): boolean {
  const database = ctx.database;
  const adopted = database.prepare(
    `SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.scope = ? AND v.adopted_entity_ids_json LIKE ? LIMIT 1`
  ).get(ctx.scope, `%"${entityId}"%`);
  if (adopted) return true;
  const related = database.prepare(
    `SELECT 1 FROM knowledge_formal_relations r
     WHERE r.scope = ? AND r.ended_change_set_id IS NULL
       AND r.to_object_type = 'knowledge_entity' AND r.to_object_id = ? LIMIT 1`
  ).get(ctx.scope, entityId);
  return related !== undefined;
}

function topicReferencedInScope(ctx: DetectorContext, topicId: string): boolean {
  const database = ctx.database;
  const adopted = database.prepare(
    `SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.scope = ? AND v.adopted_topic_ids_json LIKE ? LIMIT 1`
  ).get(ctx.scope, `%"${topicId}"%`);
  if (adopted) return true;
  const related = database.prepare(
    `SELECT 1 FROM knowledge_formal_relations r
     WHERE r.scope = ? AND r.ended_change_set_id IS NULL
       AND r.to_object_type = 'topic' AND r.to_object_id = ? LIMIT 1`
  ).get(ctx.scope, topicId);
  return related !== undefined;
}

/** missing-page 条件：活动实体/主题被当前知识引用，但同 scope 没有活动 Wiki 页面。 */
function entityMissingPageCondition(ctx: DetectorContext, entityId: string): boolean {
  const database = ctx.database;
  const active = database.prepare(
    'SELECT 1 FROM knowledge_entities WHERE id = ? AND scope = ? AND lifecycle = ? LIMIT 1'
  ).get(entityId, ctx.scope, 'active');
  if (!active) return false;
  const page = database.prepare(
    `SELECT 1 FROM knowledge_wiki_pages
     WHERE scope = ? AND subject_type = 'entity' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
  ).get(ctx.scope, entityId);
  if (page) return false;
  return entityReferencedInScope(ctx, entityId);
}

function topicMissingPageCondition(ctx: DetectorContext, topicId: string): boolean {
  const database = ctx.database;
  const topic = database.prepare('SELECT 1 FROM topics WHERE id = ?').get(topicId);
  if (!topic) return false;
  const page = database.prepare(
    `SELECT 1 FROM knowledge_wiki_pages
     WHERE scope = ? AND subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
  ).get(ctx.scope, topicId);
  if (page) return false;
  return topicReferencedInScope(ctx, topicId);
}

function missingEntityPagePlan(ctx: DetectorContext, entityId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('missing_wiki_page')) return null;
  if (!entityMissingPageCondition(ctx, entityId)) return null;
  return Object.freeze({
    issueType: 'missing_wiki_page',
    affectedObjectType: 'knowledge_entity',
    affectedObjectId: entityId,
    severity: 'medium',
    anchor: `entity:${entityId}:missing-page`,
    detail: '活动 Entity 被当前知识引用（Note 采纳/正式关系），但没有活动 Wiki 页面。',
    suggestedAction: '人工复核：为该实体整理出当前认识，或移除其引用。'
  });
}

function missingTopicPagePlan(ctx: DetectorContext, topicId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('missing_wiki_page')) return null;
  if (!topicMissingPageCondition(ctx, topicId)) return null;
  return Object.freeze({
    issueType: 'missing_wiki_page',
    affectedObjectType: 'topic',
    affectedObjectId: topicId,
    severity: 'medium',
    anchor: `topic:${topicId}:missing-page`,
    detail: 'Topic 被当前知识引用（Note 采纳/正式关系），但没有活动 Wiki 页面。',
    suggestedAction: '人工复核：为该主题整理出当前认识，或确认已并入其他页面。'
  });
}

/** 解析 business_object_refs 形式化引用；未知形态放行（不做自由文本猜测）。 */
function parseWikiRef(ref: unknown): { type: string; id: string } | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length < 2) return null;
  const type = parts[0]!.trim();
  const id = parts[1]!.trim();
  if (!type || !id) return null;
  return { type, id };
}

/** 当前 Wiki 页面版本中不可解析的正式引用（结构字段：adopted_note_version_ids / business_object_refs）。 */
function pageCurrentBrokenRefs(ctx: DetectorContext, pageId: string): Array<{ kind: string; type: string; id: string }> {
  const database = ctx.database;
  const page = database.prepare(
    'SELECT current_version_id AS versionId, lifecycle, scope FROM knowledge_wiki_pages WHERE id = ?'
  ).get(pageId) as Record<string, unknown> | undefined;
  if (!page || String(page.scope) !== ctx.scope || String(page.lifecycle) !== 'active') return [];
  const versionId = String(page.versionId ?? '');
  if (!versionId) return [];
  const version = database.prepare(
    `SELECT adopted_note_version_ids_json AS adopted, business_object_refs_json AS refs
     FROM knowledge_wiki_page_versions WHERE id = ?`
  ).get(versionId) as Record<string, unknown> | undefined;
  if (!version) return [];
  const broken: Array<{ kind: string; type: string; id: string }> = [];
  let adopted: unknown[] = [];
  let refs: unknown[] = [];
  try {
    adopted = JSON.parse(String(version.adopted ?? '[]')) as unknown[];
  } catch {
    adopted = [];
  }
  try {
    refs = JSON.parse(String(version.refs ?? '[]')) as unknown[];
  } catch {
    refs = [];
  }
  for (const adoptedId of adopted) {
    if (typeof adoptedId !== 'string' || !adoptedId) continue;
    if (!objectExists(database, WIKI_REF_TABLES.note_version!, adoptedId)) {
      broken.push({ kind: 'adopted_note_version', type: 'note_version', id: adoptedId });
    }
  }
  for (const ref of refs) {
    const parsed = parseWikiRef(ref);
    if (!parsed) continue;
    const table = WIKI_REF_TABLES[parsed.type];
    if (!table) continue; // 未知类型不做猜测
    if (!objectExists(database, table, parsed.id)) {
      broken.push({ kind: 'business_object_ref', type: parsed.type, id: parsed.id });
    }
  }
  return broken;
}

function crossReferencePlan(ctx: DetectorContext, pageId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('cross_reference')) return null;
  const broken = pageCurrentBrokenRefs(ctx, pageId);
  if (!broken.length) return null;
  return Object.freeze({
    issueType: 'broken_reference',
    affectedObjectType: 'wiki_page',
    affectedObjectId: pageId,
    severity: 'medium',
    anchor: `page-ref:${pageId}`,
    detail: `Wiki 页面当前版本包含不可解析的正式引用：${broken.map((b) => `${b.kind}:${b.type}:${b.id}`).join('、')}。`,
    suggestedAction: '人工复核：重新整理当前认识（清除失效引用）或恢复被引用对象。'
  });
}

/** data-gap 条件：captured FreeNote 超过业务阈值天数仍未处理（原始观察未进入知识管线）。 */
function dataGapCondition(ctx: DetectorContext, freeNoteId: string, cutoffIso: string): boolean {
  const row = ctx.database.prepare(
    `SELECT 1 FROM knowledge_free_notes
     WHERE id = ? AND scope = ? AND processing_state = 'captured' AND created_at < ?`
  ).get(freeNoteId, ctx.scope, cutoffIso);
  return row !== undefined;
}

function dataGapPlan(ctx: DetectorContext, freeNoteId: string, cutoffIso: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('data_gap')) return null;
  if (!dataGapCondition(ctx, freeNoteId, cutoffIso)) return null;
  return Object.freeze({
    issueType: 'data_gap',
    affectedObjectType: 'knowledge_free_note',
    affectedObjectId: freeNoteId,
    severity: 'low',
    anchor: `free-note:${freeNoteId}:unprocessed`,
    detail: `captured FreeNote 超过 ${DATA_GAP_FREE_NOTE_MAX_AGE_DAYS} 天仍未处理，原始观察未进入知识管线。`,
    suggestedAction: '人工复核：处理该原始记录（晋升/忽略/归档），或确认延迟原因。'
  });
}

// ============================================================
// 条件复查（自动解决判定；只读）
// ============================================================

type OpenIssueRow = Readonly<{
  id: string;
  revision: number;
  issueType: HealthIssueType;
  affectedObjectType: string;
  affectedObjectId: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

function verdictForIssue(ctx: DetectorContext, issue: OpenIssueRow): 'problem' | 'cleared' {
  const database = ctx.database;
  switch (issue.issueType) {
    case 'broken_reference': {
      if (issue.affectedObjectType === 'knowledge_relation') {
        const row = database.prepare(
          `SELECT id, from_object_type AS fromObjectType, from_object_id AS fromObjectId,
             to_object_type AS toObjectType, to_object_id AS toObjectId
           FROM knowledge_formal_relations WHERE id = ? AND ended_change_set_id IS NULL AND scope = ?`
        ).get(issue.affectedObjectId, ctx.scope) as Record<string, unknown> | undefined;
        if (!row) return 'cleared'; // 已终结
        return relationGhostEndpoints(database, row).length ? 'problem' : 'cleared';
      }
      // WMB-5237 cross-reference：Wiki 页面当前版本仍含不可解析正式引用 → problem；重新编译干净 → cleared
      if (issue.affectedObjectType === 'wiki_page') {
        return pageCurrentBrokenRefs(ctx, issue.affectedObjectId).length ? 'problem' : 'cleared';
      }
      // 证据链接坏引用：Note 版本仍存在任意坏证据 → problem
      const links = database.prepare(
        `SELECT id, evidence_object_type AS evidenceObjectType, evidence_object_id AS evidenceObjectId
         FROM knowledge_evidence_links WHERE knowledge_note_version_id = ?`
      ).all(issue.affectedObjectId) as Array<Record<string, unknown>>;
      for (const link of links) {
        const table = EVIDENCE_OBJECT_TABLES[String(link.evidenceObjectType)];
        if (table && !objectExists(database, table, String(link.evidenceObjectId))) return 'problem';
      }
      return 'cleared';
    }
    case 'unreturned_review': {
      const review = database.prepare('SELECT status FROM reviews WHERE id = ?').get(issue.affectedObjectId) as
        | { status: string }
        | undefined;
      if (!review || review.status !== 'final') return 'cleared';
      return reviewFlowbackExists(database, ctx.workspaceId, issue.affectedObjectId) ? 'cleared' : 'problem';
    }
    case 'unresolved_contradiction': {
      const row = database.prepare(
        `SELECT n.lifecycle AS lifecycle, v.conclusion_status AS conclusionStatus
         FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.id = ? AND n.scope = ?`
      ).get(issue.affectedObjectId, ctx.scope) as Record<string, unknown> | undefined;
      if (!row || String(row.lifecycle) !== 'active' || String(row.conclusionStatus) !== 'disputed') return 'cleared';
      return 'problem';
    }
    case 'stale_wiki_page': {
      const row = database.prepare(
        `SELECT lifecycle, compile_status AS compileStatus FROM knowledge_wiki_pages WHERE id = ? AND scope = ?`
      ).get(issue.affectedObjectId, ctx.scope) as Record<string, unknown> | undefined;
      if (!row || String(row.lifecycle) !== 'active' || String(row.compileStatus) !== 'stale') return 'cleared';
      return 'problem';
    }
    case 'orphan_knowledge':
      return orphanNoteCondition(ctx, issue.affectedObjectId) ? 'problem' : 'cleared';
    case 'missing_wiki_page':
      return (issue.affectedObjectType === 'knowledge_entity'
        ? entityMissingPageCondition(ctx, issue.affectedObjectId)
        : topicMissingPageCondition(ctx, issue.affectedObjectId)) ? 'problem' : 'cleared';
    case 'unsupported_claim':
      return noteUnsupportedCondition(ctx, issue.affectedObjectId) ? 'problem' : 'cleared';
    case 'stale_claim':
      return noteStaleCondition(ctx, issue.affectedObjectId, now()) ? 'problem' : 'cleared';
    case 'duplicate_knowledge':
      return duplicateKnowledgePartner(ctx, issue.affectedObjectId) !== null ? 'problem' : 'cleared';
    case 'duplicate_entity':
      return duplicateEntityPartner(ctx, issue.affectedObjectId) !== null ? 'problem' : 'cleared';
    case 'data_gap':
      return dataGapCondition(ctx, issue.affectedObjectId, dataGapCutoffIso()) ? 'problem' : 'cleared';
    default:
      // 未知类型保守保持 open（不自动裁决）
      return 'problem';
  }
}

function listOpenIssuesForDetectors(
  database: DatabaseSync,
  ctx: DetectorContext,
  extraWhere: string,
  extraArgs: readonly string[],
  limit: number
): OpenIssueRow[] {
  const issueTypes = ctx.detectors.map((d) => KNOWLEDGE_HEALTH_DETECTORS[d]);
  const placeholders = issueTypes.map(() => '?').join(',');
  const scopeValue: string = ctx.scope;
  const rows = database.prepare(
    `SELECT id, revision, issue_type AS issueType, affected_object_type AS affectedObjectType,
       affected_object_id AS affectedObjectId, evidence_json AS evidenceJson
     FROM knowledge_health_issues
     WHERE status IN ('open','repairing') AND scope = ? AND issue_type IN (${placeholders}) ${extraWhere}
     ORDER BY id LIMIT ?`
  ).all(scopeValue, ...issueTypes, ...extraArgs, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.freeze({
    id: String(row.id), revision: Number(row.revision),
    issueType: String(row.issueType) as HealthIssueType,
    affectedObjectType: String(row.affectedObjectType),
    affectedObjectId: String(row.affectedObjectId),
    evidence: parseEvidence(row)
  }));
}

/** 周期 lint 每步的有界自动解决扫描（按 id cursor 翻页；扫完一轮后清零循环）。 */
function collectClearSweep(
  database: DatabaseSync,
  ctx: DetectorContext,
  cursor: string,
  limit: number
): { clears: Array<{ issue: OpenIssueRow; note: string }>; nextCursor: string } {
  const issues = listOpenIssuesForDetectors(database, ctx, 'AND id > ?', [cursor], limit);
  const clears: Array<{ issue: OpenIssueRow; note: string }> = [];
  for (const issue of issues) {
    if (verdictForIssue(ctx, issue) !== 'cleared') continue;
    clears.push({ issue, note: `条件已消除：${issue.issueType}（${issue.affectedObjectType}:${issue.affectedObjectId}）不再成立。` });
  }
  const nextCursor = issues.length < limit ? '' : issues[issues.length - 1]!.id;
  return { clears, nextCursor };
}

/** 局部 lint 的自动解决：只复查指定受影响对象上的 open Issue。 */
function collectClearsForObjects(
  database: DatabaseSync,
  ctx: DetectorContext,
  refs: readonly HealthLintObjectRef[]
): Array<{ issue: OpenIssueRow; note: string }> {
  const ids = [...new Set(refs.map((ref) => ref.objectId))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const issues = listOpenIssuesForDetectors(database, ctx, `AND affected_object_id IN (${placeholders})`, ids, MAX_PAGE_SIZE * 4);
  const clears: Array<{ issue: OpenIssueRow; note: string }> = [];
  for (const issue of issues) {
    if (verdictForIssue(ctx, issue) !== 'cleared') continue;
    clears.push({ issue, note: `条件已消除：${issue.issueType}（${issue.affectedObjectType}:${issue.affectedObjectId}）不再成立。` });
  }
  return clears;
}

// ============================================================
// 局部 Lint 检测入口（有界对象）
// ============================================================

function detectBrokenEvidenceForNote(ctx: DetectorContext, noteId: string): HealthLintIssuePlan[] {
  const rows = ctx.database.prepare(
    `SELECT e.id, e.knowledge_note_version_id AS noteVersionId, e.evidence_object_type AS evidenceObjectType,
       e.evidence_object_id AS evidenceObjectId
     FROM knowledge_evidence_links e
     JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
     JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.id = ? AND n.scope = ?`
  ).all(noteId, ctx.scope) as Array<Record<string, unknown>>;
  const plans: HealthLintIssuePlan[] = [];
  for (const row of rows) {
    const plan = brokenEvidencePlan(ctx, row);
    if (plan) plans.push(plan);
  }
  return plans;
}

function detectBrokenEvidenceForSource(ctx: DetectorContext, sourceId: string): HealthLintIssuePlan[] {
  if (ctx.scope !== 'global') return [];
  const table = EVIDENCE_OBJECT_TABLES.source!;
  if (objectExists(ctx.database, table, sourceId)) return []; // 源仍存在 → 无坏引用
  const rows = ctx.database.prepare(
    `SELECT e.id, e.knowledge_note_version_id AS noteVersionId, e.evidence_object_type AS evidenceObjectType,
       e.evidence_object_id AS evidenceObjectId
     FROM knowledge_evidence_links e
     WHERE e.evidence_object_type = 'source' AND e.evidence_object_id = ?`
  ).all(sourceId) as Array<Record<string, unknown>>;
  const plans: HealthLintIssuePlan[] = [];
  for (const row of rows) {
    const plan = brokenEvidencePlan(ctx, row);
    if (plan) plans.push(plan);
  }
  return plans;
}

/** 对单个受影响对象运行适用检测器（scope 内）。 */
function detectForObject(ctx: DetectorContext, ref: HealthLintObjectRef): HealthLintIssuePlan[] {
  const plans: HealthLintIssuePlan[] = [];
  switch (ref.objectType) {
    case 'knowledge_relation': {
      if (!ctx.detectors.includes('broken_reference')) return plans;
      const row = ctx.database.prepare(
        `SELECT id, scope, relation_key AS relationKey, from_object_type AS fromObjectType,
           from_object_id AS fromObjectId, to_object_type AS toObjectType, to_object_id AS toObjectId
         FROM knowledge_formal_relations
         WHERE id = ? AND ended_change_set_id IS NULL`
      ).get(ref.objectId) as Record<string, unknown> | undefined;
      const plan = row ? brokenRelationPlan(ctx, row) : null;
      if (plan) plans.push(plan);
      return plans;
    }
    case 'knowledge_note': {
      if (ctx.detectors.includes('unresolved_contradiction')) {
        const plan = unresolvedContradictionPlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('broken_reference')) plans.push(...detectBrokenEvidenceForNote(ctx, ref.objectId));
      if (ctx.detectors.includes('unsupported_claim')) {
        const plan = unsupportedClaimPlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('stale_claim')) {
        const plan = staleClaimPlan(ctx, ref.objectId, now());
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('orphan_knowledge')) {
        const plan = orphanKnowledgePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('duplicate_knowledge')) {
        const plan = duplicateKnowledgePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'wiki_page': {
      if (ctx.detectors.includes('stale_wiki_page')) {
        const plan = staleWikiPagePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('cross_reference')) {
        const plan = crossReferencePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'topic': {
      if (ctx.detectors.includes('stale_wiki_page')) {
        const page = ctx.database.prepare(
          `SELECT id FROM knowledge_wiki_pages
           WHERE subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' AND scope = ? LIMIT 1`
        ).get(ref.objectId, ctx.scope) as { id: string } | undefined;
        const plan = page ? staleWikiPagePlan(ctx, page.id) : null;
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('missing_wiki_page')) {
        const plan = missingTopicPagePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'knowledge_entity': {
      if (ctx.detectors.includes('duplicate_entity')) {
        const plan = duplicateEntityPlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('missing_wiki_page')) {
        const plan = missingEntityPagePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'knowledge_free_note': {
      if (ctx.detectors.includes('data_gap')) {
        const plan = dataGapPlan(ctx, ref.objectId, dataGapCutoffIso());
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'source': {
      if (ctx.detectors.includes('broken_reference')) plans.push(...detectBrokenEvidenceForSource(ctx, ref.objectId));
      return plans;
    }
    case 'review': {
      if (ctx.detectors.includes('unreturned_review')) {
        const review = ctx.database.prepare('SELECT status FROM reviews WHERE id = ?').get(ref.objectId) as
          | { status: string }
          | undefined;
        const plan = review ? unreturnedReviewPlan(ctx, ref.objectId, review.status) : null;
        if (plan) plans.push(plan);
      }
      return plans;
    }
    default:
      return plans;
  }
}

// ============================================================
// 运行装配：计划 → ChangeSet 段（含去重 / 自动修复 / 自动解决）
// ============================================================

export type HealthLintCounts = Readonly<{
  scannedObjects: number;
  issuesCreated: number;
  issuesDeduplicated: number;
  issuesAutoResolved: number;
  repairsApplied: number;
}>;

const ZERO_COUNTS: HealthLintCounts = Object.freeze({ scannedObjects: 0, issuesCreated: 0, issuesDeduplicated: 0, issuesAutoResolved: 0, repairsApplied: 0 });

type BuiltOps = Readonly<{
  relationOps: RelationWrite[];
  healthIssueOps: HealthIssueWrite[];
  counts: HealthLintCounts;
  touchedIssueIds: readonly string[];
}>;

function buildRunOps(
  database: DatabaseSync,
  ctx: DetectorContext,
  plans: readonly HealthLintIssuePlan[],
  clears: ReadonlyArray<{ issue: OpenIssueRow; note: string }>,
  maxIssuesPerRun: number
): BuiltOps {
  const relationOps: RelationWrite[] = [];
  const healthIssueOps: HealthIssueWrite[] = [];
  const touchedIssueIds: string[] = [];
  let issuesCreated = 0;
  let issuesDeduplicated = 0;
  let issuesAutoResolved = 0;
  let repairsApplied = 0;

  for (const plan of plans) {
    const existing = findIssuesForPlan(database, ctx.scope, plan);
    const fingerprint = issueFingerprint(ctx.scope, plan);

    if (plan.autoRepair) {
      if (!AUTO_REPAIR_ALLOWLIST[plan.issueType]) {
        lintError('HEALTH_LINT_REPAIR_NOT_ALLOWED', `issueType=${plan.issueType} 不允许自动修复。`, { issueType: plan.issueType });
      }
      const open = existing.find((e) => e.status === 'open' || e.status === 'repairing');
      const issueId = open ? open.id : nextIssueId(existing.length, fingerprint);
      const beforeRevision = open ? open.revision : 1;
      if (!open) {
        issuesCreated += 1;
        healthIssueOps.push(Object.freeze({
          op: 'create',
          id: issueId,
          scope: ctx.scope,
          issueType: plan.issueType,
          affectedObjectType: plan.affectedObjectType,
          affectedObjectId: plan.affectedObjectId,
          severity: plan.severity,
          evidence: buildEvidence(ctx.scope, plan, ctx.detectors),
          suggestedAction: plan.suggestedAction
        }));
      } else {
        issuesDeduplicated += 1;
      }
      repairsApplied += 1;
      relationOps.push(Object.freeze({ op: 'end', id: plan.autoRepair.relationId, reason: 'lint:broken_reference:auto-repair' }));
      healthIssueOps.push(Object.freeze({
        op: 'update',
        id: issueId,
        beforeRevision,
        status: 'resolved',
        resolutionNote: `确定性修复：${plan.detail} 已自动终止关系。`
      }));
      touchedIssueIds.push(issueId);
      if (issuesCreated + repairsApplied > maxIssuesPerRun) {
        lintError('HEALTH_LINT_SCOPE_EXCEEDED', `本轮 Lint 新建/修复 Issue 超过上限 ${maxIssuesPerRun}，零写。`, { maxIssuesPerRun });
      }
      continue;
    }

    if (existing.some((e) => e.status === 'open' || e.status === 'repairing')) {
      issuesDeduplicated += 1; // 重复扫描不重复 Issue
      continue;
    }
    if (
      existing.some(
        (e) => e.status === 'false_positive' && e.evidence.detectorVersion === KNOWLEDGE_HEALTH_DETECTOR_VERSION
      )
    ) {
      issuesDeduplicated += 1; // 同检测器版本的 false_positive 不重复报警
      continue;
    }
    issuesCreated += 1;
    if (issuesCreated > maxIssuesPerRun) {
      lintError('HEALTH_LINT_SCOPE_EXCEEDED', `本轮 Lint 新建 Issue 超过上限 ${maxIssuesPerRun}，零写。`, { maxIssuesPerRun });
    }
    const issueId = nextIssueId(existing.length, fingerprint);
    healthIssueOps.push(Object.freeze({
      op: 'create',
      id: issueId,
      scope: ctx.scope,
      issueType: plan.issueType,
      affectedObjectType: plan.affectedObjectType,
      affectedObjectId: plan.affectedObjectId,
      severity: plan.severity,
      evidence: buildEvidence(ctx.scope, plan, ctx.detectors),
      suggestedAction: plan.suggestedAction
    }));
    touchedIssueIds.push(issueId);
  }

  for (const clear of clears) {
    issuesAutoResolved += 1;
    healthIssueOps.push(Object.freeze({
      op: 'update',
      id: clear.issue.id,
      beforeRevision: clear.issue.revision,
      status: 'resolved',
      resolutionNote: clear.note
    }));
    touchedIssueIds.push(clear.issue.id);
  }

  return Object.freeze({
    relationOps,
    healthIssueOps,
    counts: Object.freeze({ scannedObjects: 0, issuesCreated, issuesDeduplicated, issuesAutoResolved, repairsApplied }),
    touchedIssueIds
  });
}

function buildLintChangeSetInput(
  built: BuiltOps,
  requestId: string,
  summary: string,
  counts: HealthLintCounts,
  impact: Readonly<Record<string, unknown>>
): KnowledgeChangeSetInput {
  return Object.freeze({
    relations: built.relationOps,
    healthIssues: built.healthIssueOps,
    receipts: [Object.freeze({
      triggerType: 'lint' as const,
      requestId,
      summary,
      counts,
      impact
    })]
  });
}

function lintMeta(
  workspaceId: string,
  requestId: string,
  reason: string,
  createdBy: CreatorNature
): KnowledgeChangeSetMeta {
  return Object.freeze({
    workspaceId,
    requestId,
    reason,
    triggerSource: 'lint' as const,
    resolutionMode: 'none' as const,
    createdBy
  });
}

/**
 * Lint 自己的原子提交：SAVEPOINT + transaction=false 适用于两种上下文——
 * 顶层（SAVEPOINT 自动开启事务，RELEASE 提交）与既有事务内（嵌套；失败 ROLLBACK TO
 * 只回滚 lint 自己的写，绝不回滚已成功的业务 ChangeSet）。
 */
function applyLintChangeSet(database: DatabaseSync, meta: KnowledgeChangeSetMeta, input: KnowledgeChangeSetInput): ApplyChangeSetResult {
  database.exec('SAVEPOINT wmb_knowledge_lint');
  try {
    const result = applyKnowledgeChangeSet(database, meta, input, false);
    database.exec('RELEASE wmb_knowledge_lint');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK TO wmb_knowledge_lint');
      database.exec('RELEASE wmb_knowledge_lint');
    } catch {
      // 嵌套回滚失败不掩盖原始错误
    }
    throw error;
  }
}

function readBackIssues(database: DatabaseSync, ids: readonly string[]): KnowledgeHealthIssueRecord[] {
  const out: KnowledgeHealthIssueRecord[] = [];
  for (const id of ids) {
    const issue = getHealthIssue(database, id);
    if (issue) out.push(issue);
  }
  return out;
}

// ============================================================
// 局部 Lint
// ============================================================

export type KnowledgeHealthLintInput = Readonly<{
  /** 幂等键：同 requestId + 同输入重放零写。 */
  requestId: string;
  workspaceId: string;
  reason?: string;
  scope?: KnowledgeScope;
  createdBy?: CreatorNature;
  detectors?: readonly HealthLintDetector[];
  affectedObjects: readonly HealthLintObjectRef[];
  maxAffectedObjects?: number;
  maxIssuesPerRun?: number;
}>;

export type KnowledgeHealthLintResult = Readonly<{
  ok: boolean;
  /** 同 requestId 且输入一致时 store 幂等重放（零新增行）。 */
  replay: boolean;
  changeSetId: string | null;
  requestId: string;
  counts: HealthLintCounts;
  issues: readonly KnowledgeHealthIssueRecord[];
  receipt: KnowledgeUpdateReceiptRecord | null;
}>;

/** 局部 Lint 的稳定幂等键（调用方可自定义，此为推荐约定）。 */
export function localLintRequestId(trigger: string, objectType: string, objectId: string): string {
  return `lint:local:${trigger}:${objectType}:${objectId}`;
}

export function runLocalLint(database: DatabaseSync, rawInput: KnowledgeHealthLintInput): KnowledgeHealthLintResult {
  const requestId = validateRequestId(rawInput.requestId);
  const workspaceId = validateWorkspace(rawInput.workspaceId);
  const scope = validateScope(rawInput.scope ?? 'global');
  // lane 注册门（与 store 写面同源）：未注册 lane 在运行开始即拒绝，零写
  assertScopeAllowed(database, scope);
  const createdBy: CreatorNature = rawInput.createdBy ?? 'background_agent';
  const reason = (rawInput.reason ?? `知识健康局部 Lint（${requestId}）`).trim();
  const detectors = normalizeDetectors(rawInput.detectors);
  const maxAffectedObjects = Math.min(Math.max(rawInput.maxAffectedObjects ?? DEFAULT_MAX_AFFECTED_OBJECTS, 1), 1000);
  const maxIssuesPerRun = Math.min(Math.max(rawInput.maxIssuesPerRun ?? DEFAULT_MAX_ISSUES_PER_RUN, 1), 500);
  const refs = uniqueRefs(rawInput.affectedObjects);
  if (refs.length > maxAffectedObjects) {
    lintError('HEALTH_LINT_SCOPE_EXCEEDED', `局部 Lint 受影响对象 ${refs.length} 超过上限 ${maxAffectedObjects}，零写。`, {
      affectedObjects: refs.length,
      maxAffectedObjects
    });
  }

  const ctx: DetectorContext = Object.freeze({ database, workspaceId, scope, detectors });

  // 1. 检测（纯读）
  const plans: HealthLintIssuePlan[] = [];
  for (const ref of refs) plans.push(...detectForObject(ctx, ref));
  // 2. 受影响对象上的条件消除自动解决（纯读）
  const clears = collectClearsForObjects(database, ctx, refs);
  // 3. 装配（去重/修复/解决；上限检查；零写直至 apply）
  const built = buildRunOps(database, ctx, plans, clears, maxIssuesPerRun);
  const counts: HealthLintCounts = Object.freeze({ ...built.counts, scannedObjects: refs.length });

  if (!built.relationOps.length && !built.healthIssueOps.length) {
    return Object.freeze({
      ok: true,
      replay: false,
      changeSetId: null,
      requestId,
      counts,
      issues: Object.freeze([]),
      receipt: null
    });
  }

  const summary =
    `知识健康 Lint：扫描 ${counts.scannedObjects} 个对象，新建 Issue ${counts.issuesCreated}、去重 ${counts.issuesDeduplicated}、` +
    `自动解决 ${counts.issuesAutoResolved}、确定性修复 ${counts.repairsApplied}。`;
  const input = buildLintChangeSetInput(built, requestId, summary, counts, { lint: { scope, detectors: [...detectors].sort() } });
  const result = applyLintChangeSet(database, lintMeta(workspaceId, requestId, reason, createdBy), input);
  broadcastDataChanged({
    scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library'],
    reason: KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON
  });
  const issues = readBackIssues(database, built.touchedIssueIds);
  return Object.freeze({
    ok: true,
    replay: result.replay,
    changeSetId: result.changeSetId,
    requestId,
    counts,
    issues,
    receipt: result.receipt
  });
}

// ============================================================
// 可恢复周期 Lint（checkpoint 存 app_meta，v56 KV 承载，无 migration）
// ============================================================

export type KnowledgeHealthCheckpoint = Readonly<{
  schemaVersion: 1;
  runId: string;
  workspaceId: string;
  scope: KnowledgeScope;
  detectors: readonly HealthLintDetector[];
  createdBy: CreatorNature;
  status: 'running' | 'completed';
  phase: HealthLintPhase;
  cursor: string;
  clearCursor: string;
  step: number;
  pageSize: number;
  counts: HealthLintCounts;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type BeginPeriodicLintInput = Readonly<{
  workspaceId: string;
  reason?: string;
  scope?: KnowledgeScope;
  createdBy?: CreatorNature;
  detectors?: readonly HealthLintDetector[];
  pageSize?: number;
  /** true（默认）：已有 running checkpoint 则续跑；false：强制开始新一轮。 */
  resume?: boolean;
}>;

export type KnowledgeHealthPeriodicStepResult = KnowledgeHealthLintResult &
  Readonly<{
    done: boolean;
    checkpoint: KnowledgeHealthCheckpoint;
  }>;

function readCheckpoint(database: DatabaseSync): KnowledgeHealthCheckpoint | null {
  let row: { value: string } | undefined;
  try {
    row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(CHECKPOINT_META_KEY) as { value: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as KnowledgeHealthCheckpoint;
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.runId) return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function saveCheckpoint(database: DatabaseSync, checkpoint: KnowledgeHealthCheckpoint): void {
  const value = JSON.stringify(checkpoint);
  const nowIso = now();
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(CHECKPOINT_META_KEY) as
    | { revision: number }
    | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(value, nowIso, CHECKPOINT_META_KEY);
  } else {
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
      .run(CHECKPOINT_META_KEY, value, nowIso, nowIso);
  }
}

export function getPeriodicLintCheckpoint(database: DatabaseSync): KnowledgeHealthCheckpoint | null {
  return readCheckpoint(database);
}

export function beginPeriodicLint(database: DatabaseSync, rawInput: BeginPeriodicLintInput): { checkpoint: KnowledgeHealthCheckpoint; resumed: boolean } {
  const workspaceId = validateWorkspace(rawInput.workspaceId);
  const scope = validateScope(rawInput.scope ?? 'global');
  assertScopeAllowed(database, scope);
  const createdBy: CreatorNature = rawInput.createdBy ?? 'background_agent';
  const detectors = normalizeDetectors(rawInput.detectors);
  const pageSize = Math.min(Math.max(rawInput.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const resume = rawInput.resume !== false;

  const existing = readCheckpoint(database);
  if (existing && resume && existing.status === 'running') {
    if (existing.workspaceId !== workspaceId) {
      lintError('HEALTH_LINT_WORKSPACE_MISMATCH', `周期 Lint checkpoint 属于工作空间 ${existing.workspaceId}，与当前 ${workspaceId} 不一致。`, {
        checkpointWorkspaceId: existing.workspaceId,
        workspaceId
      });
    }
    return { checkpoint: existing, resumed: true };
  }

  const checkpoint: KnowledgeHealthCheckpoint = Object.freeze({
    schemaVersion: 1,
    runId: `lint-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId,
    scope,
    detectors,
    createdBy,
    status: 'running',
    phase: PHASE_ORDER[0]!,
    cursor: '',
    clearCursor: '',
    step: 0,
    pageSize,
    counts: ZERO_COUNTS,
    startedAt: now(),
    updatedAt: now(),
    completedAt: null
  });
  saveCheckpoint(database, checkpoint);
  return { checkpoint, resumed: false };
}

export function cancelPeriodicLint(database: DatabaseSync): boolean {
  const existing = readCheckpoint(database);
  if (!existing) return false;
  database.prepare('DELETE FROM app_meta WHERE key = ?').run(CHECKPOINT_META_KEY);
  return true;
}

function nextPhase(phase: HealthLintPhase): HealthLintPhase | null {
  const index = PHASE_ORDER.indexOf(phase);
  return index < 0 || index + 1 >= PHASE_ORDER.length ? null : PHASE_ORDER[index + 1]!;
}

function scanPhasePage(
  database: DatabaseSync,
  ctx: DetectorContext,
  cp: KnowledgeHealthCheckpoint
): { scanned: number; plans: HealthLintIssuePlan[]; lastId: string } {
  const limit = cp.pageSize;
  const plans: HealthLintIssuePlan[] = [];
  switch (cp.phase) {
    case 'relations': {
      const rows = listActiveRelationRows(database, ctx.scope, cp.cursor, limit);
      for (const row of rows) {
        const plan = brokenRelationPlan(ctx, row);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'evidence_links': {
      const rows = listEvidenceLinkRows(database, ctx.scope, cp.cursor, limit);
      for (const row of rows) {
        const plan = brokenEvidencePlan(ctx, row);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'reviews': {
      if (ctx.scope !== 'global') return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare('SELECT id, status FROM reviews WHERE status = ? AND id > ? ORDER BY id LIMIT ?')
        .all('final', cp.cursor, limit) as Array<{ id: string; status: string }>;
      for (const row of rows) {
        const plan = unreturnedReviewPlan(ctx, row.id, row.status);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'notes': {
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active' AND v.conclusion_status = 'disputed' AND n.id > ?
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = unresolvedContradictionPlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'wiki_pages': {
      const rows = database.prepare(
        `SELECT id FROM knowledge_wiki_pages
         WHERE scope = ? AND lifecycle = 'active' AND compile_status = 'stale' AND id > ?
         ORDER BY id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = staleWikiPagePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'missing_entity_pages': {
      if (!ctx.detectors.includes('missing_wiki_page')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT e.id FROM knowledge_entities e
         WHERE e.scope = ? AND e.lifecycle = 'active' AND e.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_wiki_pages p
             WHERE p.scope = e.scope AND p.subject_type = 'entity' AND p.subject_id = e.id AND p.lifecycle = 'active')
           AND (EXISTS (
                  SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
                  WHERE n.scope = e.scope AND v.adopted_entity_ids_json LIKE '%"' || e.id || '"%')
                OR EXISTS (
                  SELECT 1 FROM knowledge_formal_relations r
                  WHERE r.scope = e.scope AND r.ended_change_set_id IS NULL
                    AND r.to_object_type = 'knowledge_entity' AND r.to_object_id = e.id))
         ORDER BY e.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = missingEntityPagePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'missing_topic_pages': {
      if (!ctx.detectors.includes('missing_wiki_page')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT t.id FROM topics t
         WHERE t.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_wiki_pages p
             WHERE p.scope = ? AND p.subject_type = 'topic' AND p.subject_id = t.id AND p.lifecycle = 'active')
           AND (EXISTS (
                  SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
                  WHERE n.scope = ? AND v.adopted_topic_ids_json LIKE '%"' || t.id || '"%')
                OR EXISTS (
                  SELECT 1 FROM knowledge_formal_relations r
                  WHERE r.scope = ? AND r.ended_change_set_id IS NULL
                    AND r.to_object_type = 'topic' AND r.to_object_id = t.id))
         ORDER BY t.id LIMIT ?`
      ).all(cp.cursor, ctx.scope, ctx.scope, ctx.scope, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = missingTopicPagePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'orphan_notes': {
      if (!ctx.detectors.includes('orphan_knowledge')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         WHERE n.scope = ? AND n.lifecycle = 'active' AND n.kind != 'question' AND n.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_evidence_links e
             JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
             WHERE v.note_id = n.id)
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_formal_relations r
             WHERE r.scope = n.scope AND r.ended_change_set_id IS NULL
               AND (r.from_object_id = n.id OR r.to_object_id = n.id))
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = orphanKnowledgePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'unsupported_claims': {
      if (!ctx.detectors.includes('unsupported_claim')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active'
           AND v.conclusion_status IN ('supported','contradicted')
           AND NOT EXISTS (SELECT 1 FROM knowledge_evidence_links e WHERE e.knowledge_note_version_id = v.id)
           AND n.id > ?
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = unsupportedClaimPlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'stale_claims': {
      if (!ctx.detectors.includes('stale_claim')) return { scanned: 0, plans, lastId: '' };
      const nowIso = now();
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active' AND v.valid_until IS NOT NULL AND v.valid_until < ?
           AND n.id > ?
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, nowIso, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = staleClaimPlan(ctx, row.id, nowIso);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'duplicate_notes': {
      if (!ctx.detectors.includes('duplicate_knowledge')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active' AND n.id > ?
           AND EXISTS (
             SELECT 1 FROM knowledge_notes n2
             JOIN knowledge_note_versions v2 ON v2.id = n2.current_version_id
             WHERE n2.scope = n.scope AND n2.lifecycle = 'active' AND n2.id != n.id
               AND n2.kind = n.kind AND trim(lower(v2.statement)) = trim(lower(v.statement)))
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = duplicateKnowledgePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'duplicate_entities': {
      if (!ctx.detectors.includes('duplicate_entity')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT e.id FROM knowledge_entities e
         WHERE e.scope = ? AND e.lifecycle = 'active' AND e.external_identity_json != '{}' AND e.id > ?
           AND EXISTS (
             SELECT 1 FROM knowledge_entities e2
             WHERE e2.scope = e.scope AND e2.lifecycle = 'active' AND e2.id != e.id
               AND e2.external_identity_json = e.external_identity_json)
         ORDER BY e.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = duplicateEntityPlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'cross_references': {
      if (!ctx.detectors.includes('cross_reference')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT id FROM knowledge_wiki_pages
         WHERE scope = ? AND lifecycle = 'active' AND id > ?
         ORDER BY id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = crossReferencePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'data_gaps': {
      if (!ctx.detectors.includes('data_gap')) return { scanned: 0, plans, lastId: '' };
      const cutoffIso = dataGapCutoffIso();
      const rows = database.prepare(
        `SELECT id FROM knowledge_free_notes
         WHERE scope = ? AND processing_state = 'captured' AND created_at < ? AND id > ?
         ORDER BY id LIMIT ?`
      ).all(ctx.scope, cutoffIso, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = dataGapPlan(ctx, row.id, cutoffIso);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
  }
}

function advanceCheckpoint(
  database: DatabaseSync,
  cp: KnowledgeHealthCheckpoint,
  scanned: number,
  lastId: string,
  nextClearCursor: string,
  delta: HealthLintCounts
): KnowledgeHealthCheckpoint {
  const pageExhausted = scanned < cp.pageSize;
  let phase = cp.phase;
  let cursor = cp.cursor;
  let status: 'running' | 'completed' = 'running';
  let completedAt: string | null = null;

  if (pageExhausted) {
    // 本页未满 → 当前 phase 已扫完，前进到下一 phase（或完成）
    const next = nextPhase(phase);
    if (!next) {
      status = 'completed';
      completedAt = now();
    } else {
      phase = next;
      cursor = '';
    }
  } else {
    // 本页扫满 → 停在当前 phase，cursor 推进到本页最后一个对象 id
    cursor = lastId;
  }

  const next: KnowledgeHealthCheckpoint = Object.freeze({
    ...cp,
    status,
    phase,
    cursor,
    clearCursor: nextClearCursor,
    step: cp.step + 1,
    counts: Object.freeze({
      scannedObjects: cp.counts.scannedObjects + delta.scannedObjects,
      issuesCreated: cp.counts.issuesCreated + delta.issuesCreated,
      issuesDeduplicated: cp.counts.issuesDeduplicated + delta.issuesDeduplicated,
      issuesAutoResolved: cp.counts.issuesAutoResolved + delta.issuesAutoResolved,
      repairsApplied: cp.counts.repairsApplied + delta.repairsApplied
    }),
    updatedAt: now(),
    completedAt
  });
  saveCheckpoint(database, next);
  return next;
}

export function runPeriodicLintStep(database: DatabaseSync): KnowledgeHealthPeriodicStepResult {
  const cp = readCheckpoint(database);
  if (!cp) {
    lintError('HEALTH_LINT_NO_CHECKPOINT', '没有周期 Lint checkpoint；请先 beginPeriodicLint。');
  }
  if (cp!.status === 'completed') {
    return Object.freeze({
      ok: true,
      replay: false,
      changeSetId: null,
      requestId: `lint:periodic:${cp!.runId}:step:${cp!.step}`,
      counts: cp!.counts,
      issues: Object.freeze([]),
      receipt: null,
      done: true,
      checkpoint: cp!
    });
  }

  const ctx: DetectorContext = Object.freeze({
    database,
    workspaceId: cp!.workspaceId,
    scope: cp!.scope,
    detectors: cp!.detectors
  });
  const pageSize = cp!.pageSize;
  const maxIssuesPerRun = Math.min(Math.max(pageSize * 4, 1), MAX_PAGE_SIZE * 4);

  // 1. 本 phase 分页扫描（纯读）
  const { scanned, plans, lastId } = scanPhasePage(database, ctx, cp!);
  // 2. 有界自动解决扫描（按 clearCursor 翻页；扫完一轮清零循环）
  const { clears, nextCursor } = collectClearSweep(database, ctx, cp!.clearCursor, pageSize);
  // 3. 装配
  const built = buildRunOps(database, ctx, plans, clears, maxIssuesPerRun);
  const stepCounts: HealthLintCounts = Object.freeze({ ...built.counts, scannedObjects: scanned });
  const requestId = `lint:periodic:${cp!.runId}:step:${cp!.step}`;
  const countsAfter: HealthLintCounts = Object.freeze({
    scannedObjects: cp!.counts.scannedObjects + stepCounts.scannedObjects,
    issuesCreated: cp!.counts.issuesCreated + stepCounts.issuesCreated,
    issuesDeduplicated: cp!.counts.issuesDeduplicated + stepCounts.issuesDeduplicated,
    issuesAutoResolved: cp!.counts.issuesAutoResolved + stepCounts.issuesAutoResolved,
    repairsApplied: cp!.counts.repairsApplied + stepCounts.repairsApplied
  });

  let resultChangeSetId: string | null = null;
  let replay = false;
  let receipt: KnowledgeUpdateReceiptRecord | null = null;
  if (built.relationOps.length || built.healthIssueOps.length) {
    const summary =
      `周期 Lint 步 ${cp!.step}（${cp!.phase}）：扫描 ${stepCounts.scannedObjects} 个对象，` +
      `新建 Issue ${stepCounts.issuesCreated}、去重 ${stepCounts.issuesDeduplicated}、` +
      `自动解决 ${stepCounts.issuesAutoResolved}、确定性修复 ${stepCounts.repairsApplied}。`;
    const input = buildLintChangeSetInput(built, requestId, summary, stepCounts, {
      lint: { scope: cp!.scope, detectors: [...cp!.detectors].sort(), runId: cp!.runId, step: cp!.step }
    });
    const result = applyLintChangeSet(database, lintMeta(cp!.workspaceId, requestId, cp!.phase, cp!.createdBy), input);
    broadcastDataChanged({
      scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library'],
      reason: KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON
    });
    resultChangeSetId = result.changeSetId;
    replay = result.replay;
    receipt = result.receipt;
  }

  // 4. 推进 checkpoint（ChangeSet 提交成功后才推进；崩溃后重试原样重放或零写）
  const next = advanceCheckpoint(database, cp!, scanned, lastId, nextCursor, stepCounts);
  const issues = readBackIssues(database, built.touchedIssueIds);

  return Object.freeze({
    ok: true,
    replay,
    changeSetId: resultChangeSetId,
    requestId,
    counts: countsAfter,
    issues,
    receipt,
    done: next.status === 'completed',
    checkpoint: next
  });
}

// ============================================================
// 统一 ChangeSet 提交后局部 Lint 触发（生产接线：Ingest/Query/Review/恢复/合并/晋升）
// ============================================================

/** 触发派生的受影响对象上限（超出则本轮跳过，交由周期 Lint 覆盖；有界）。 */
export const KNOWLEDGE_HEALTH_HOOK_MAX_OBJECTS_PER_SCOPE = 50 as const;

function noteIdByKey(database: DatabaseSync, scope: KnowledgeScope, canonicalKey: string): string | null {
  if (!canonicalKey?.trim()) return null;
  const row = database.prepare('SELECT id FROM knowledge_notes WHERE scope = ? AND canonical_key = ? LIMIT 1')
    .get(scope, canonicalKey.trim().toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

function pageIdByKey(database: DatabaseSync, scope: KnowledgeScope, canonicalKey: string): string | null {
  if (!canonicalKey?.trim()) return null;
  const row = database.prepare('SELECT id FROM knowledge_wiki_pages WHERE scope = ? AND canonical_key = ? LIMIT 1')
    .get(scope, canonicalKey.trim().toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

function noteIdByVersion(database: DatabaseSync, versionId: string): string | null {
  if (!versionId) return null;
  const row = database.prepare('SELECT note_id AS noteId FROM knowledge_note_versions WHERE id = ?').get(versionId) as
    | { noteId: string }
    | undefined;
  return row?.noteId ?? null;
}

/** 从 ChangeSet 输入派生有界受影响对象（按 scope 分组；含 requestId 约定的 Review 回流对象）。 */
function affectedObjectsFromChangeSet(
  database: DatabaseSync,
  meta: KnowledgeChangeSetMeta,
  input: KnowledgeChangeSetInput
): Map<KnowledgeScope, HealthLintObjectRef[]> {
  const byScope = new Map<KnowledgeScope, HealthLintObjectRef[]>();
  const push = (scope: string, objectType: string, objectId: string | null | undefined) => {
    if (!objectId) return;
    const s = validateScope(scope);
    const list = byScope.get(s) ?? [];
    list.push({ objectType, objectId });
    byScope.set(s, list);
  };
  for (const note of input.notes ?? []) {
    if (note.id) push(note.scope, 'knowledge_note', note.id);
    else push(note.scope, 'knowledge_note', noteIdByKey(database, note.scope, note.canonicalKey));
  }
  for (const freeNote of input.freeNotes ?? []) {
    push(freeNote.scope, 'knowledge_free_note', freeNote.id);
  }
  for (const page of input.wikiPages ?? []) {
    if (page.id) push(page.scope, 'wiki_page', page.id);
    else push(page.scope, 'wiki_page', pageIdByKey(database, page.scope, page.canonicalKey));
  }
  for (const rel of input.relations ?? []) {
    if (rel.op === 'create') push(rel.scope, 'knowledge_relation', rel.id);
  }
  for (const evidence of input.evidenceLinks ?? []) {
    push('global', 'knowledge_note', noteIdByVersion(database, evidence.knowledgeNoteVersionId));
  }
  // Review 回流 ChangeSet（requestId 约定 outcome:review:{reviewId}）→ 对 Review 对象局部 Lint
  const reviewRequestIdPrefix = 'outcome:review:';
  if (typeof meta.requestId === 'string' && meta.requestId.startsWith(reviewRequestIdPrefix)) {
    const reviewId = meta.requestId.slice(reviewRequestIdPrefix.length);
    if (reviewId) push('global', 'review', reviewId);
  }
  for (const [scope, refs] of byScope) {
    byScope.set(scope, uniqueRefs(refs).slice(0, KNOWLEDGE_HEALTH_HOOK_MAX_OBJECTS_PER_SCOPE));
  }
  return byScope;
}

/**
 * 注册统一的知识变更后局部 Lint 触发（幂等；应在应用启动时调用一次）。
 * 每个成功提交的业务 ChangeSet（非 lint 自身、非重放）后，对受影响的有限对象
 * （按 scope 分组、有界）运行 runLocalLint；lint 失败被 store 侧捕获，绝不回滚业务 ChangeSet。
 */
export function registerKnowledgeChangeSetLintTrigger(): void {
  setKnowledgeChangeSetLintTrigger((ctx) => {
    const byScope = affectedObjectsFromChangeSet(ctx.database, ctx.meta, ctx.input);
    for (const [scope, refs] of byScope) {
      if (!refs.length) continue;
      runLocalLint(ctx.database, {
        requestId: `lint:local:postcommit:${ctx.result.changeSetId}`,
        workspaceId: ctx.meta.workspaceId,
        reason: `知识变更后局部 Lint（ChangeSet ${ctx.result.changeSetId}）`,
        scope,
        affectedObjects: refs
      });
    }
  });
}

// ============================================================
// 周期 Lint 生产接线：复用既有 jobs 表（kind='knowledge_lint'），不新建调度系统
// ============================================================

export const KNOWLEDGE_LINT_JOB_KIND = 'knowledge_lint' as const;
/** 计划窗：每轮 job 的步数预算。 */
export const PERIODIC_LINT_STEP_BUDGET = 20 as const;
/** 一轮预算耗尽后滚动到下一轮的计划窗（可用 WMB_LINT_INTERVAL_MS 覆盖）。 */
export const PERIODIC_LINT_INTERVAL_MS = (() => {
  const raw = Number(process.env.WMB_LINT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 12 * 3_600_000;
})();
/** 应用启动后首轮延迟（可用 WMB_LINT_FIRST_DELAY_MS 覆盖）。 */
export const PERIODIC_LINT_FIRST_DELAY_MS = (() => {
  const raw = Number(process.env.WMB_LINT_FIRST_DELAY_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : 5 * 60_000;
})();
/** 失败 job 的重试窗口。 */
export const PERIODIC_LINT_RETRY_AFTER_MS = 30 * 60_000;

function lintJobDedupeKey(scope: KnowledgeScope): string {
  return `lint:periodic:${scope}:rolling`;
}

function lintJobPayload(scope: KnowledgeScope): string {
  return JSON.stringify({ scope });
}

/** 计划（或重置）一轮周期 Lint job（幂等：pending/running 不重复入队；终态行重置续排）。 */
export function schedulePeriodicLintJob(database: DatabaseSync, input: { scope?: KnowledgeScope; delayMs?: number } = {}): { scheduled: boolean; dueAt: string } {
  const scope = validateScope(input.scope ?? 'global');
  const dedupeKey = lintJobDedupeKey(scope);
  const nowIso = now();
  const dueAt = new Date(Date.now() + Math.max(input.delayMs ?? PERIODIC_LINT_FIRST_DELAY_MS, 0)).toISOString();
  const existing = database.prepare('SELECT id, status FROM jobs WHERE dedupe_key = ?').get(dedupeKey) as
    | { id: string; status: string }
    | undefined;
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'running') return { scheduled: false, dueAt };
    database.prepare(
      `UPDATE jobs SET status = 'pending', due_at = ?, attempts = 0, last_error = NULL, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`
    ).run(dueAt, nowIso, existing.id);
    return { scheduled: true, dueAt };
  }
  database.prepare(
    `INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, 'pending', ?, 0, ?, ?, NULL, ?, ?, NULL, NULL)`
  ).run(randomUUID(), KNOWLEDGE_LINT_JOB_KIND, dueAt, dedupeKey, lintJobPayload(scope), nowIso, nowIso);
  return { scheduled: true, dueAt };
}

/** 崩溃恢复（running → pending）与失败重试（终态超过重试窗口 → pending）。 */
export function recoverOrRetryPeriodicLintJobs(database: DatabaseSync, input: { retryAfterMs?: number } = {}): { recovered: number } {
  const nowIso = now();
  const retryAfterMs = input.retryAfterMs ?? PERIODIC_LINT_RETRY_AFTER_MS;
  const recovered = database.prepare(
    `UPDATE jobs SET status = 'pending', started_at = NULL, updated_at = ? WHERE kind = ? AND status = 'running'`
  ).run(nowIso, KNOWLEDGE_LINT_JOB_KIND).changes ?? 0;
  const retried = database.prepare(
    `UPDATE jobs SET status = 'pending', attempts = 0, last_error = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
     WHERE kind = ? AND status = 'failed' AND finished_at IS NOT NULL AND finished_at <= ?`
  ).run(nowIso, KNOWLEDGE_LINT_JOB_KIND, new Date(Date.now() - retryAfterMs).toISOString()).changes ?? 0;
  return { recovered: Number(recovered) + Number(retried) };
}

type LintJobRow = Readonly<{
  id: string;
  status: string;
  dueAt: string;
  attempts: number;
  scope: KnowledgeScope;
}>;

function listDueLintJobs(database: DatabaseSync, limit: number): LintJobRow[] {
  const rows = database.prepare(
    `SELECT id, status, due_at AS dueAt, attempts, payload_json AS payloadJson
     FROM jobs WHERE kind = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?`
  ).all(KNOWLEDGE_LINT_JOB_KIND, now(), limit) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.freeze({
    id: String(row.id),
    status: String(row.status),
    dueAt: String(row.dueAt),
    attempts: Number(row.attempts),
    scope: (((JSON.parse(String(row.payloadJson ?? '{}')) as Record<string, unknown>)?.scope as string) ?? 'global') as KnowledgeScope
  }));
}

/** 单个 job 轮次：claim → 确保 checkpoint → 有界步数 → finish（+ 未完成则滚动下一轮）。 */
function runOneLintJob(database: DatabaseSync, job: LintJobRow, budgetSteps: number, workspaceId: string): { skipped: boolean; steps: number; done: boolean; status: string; error: string | null } {
  const claim = database.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?`
  ).run(now(), now(), job.id, job.attempts);
  if (Number(claim.changes ?? 0) !== 1) return { skipped: true, steps: 0, done: false, status: 'skipped', error: null };

  const checkpoint = getPeriodicLintCheckpoint(database);
  if (!checkpoint || checkpoint.status === 'completed') {
    beginPeriodicLint(database, { workspaceId, scope: job.scope, resume: false });
  }

  let steps = 0;
  let done = false;
  let failed = false;
  let errorMessage: string | null = null;
  while (steps < budgetSteps && !done) {
    try {
      const step = runPeriodicLintStep(database);
      steps += 1;
      done = step.done;
    } catch (error) {
      failed = true;
      errorMessage = `${(error as { code?: string })?.code ?? 'LINT_STEP_FAILED'}: ${(error as Error)?.message ?? String(error)}`;
      break;
    }
  }

  const finishStatus = failed ? 'failed' : 'succeeded';
  database.prepare(`UPDATE jobs SET status = ?, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(finishStatus, errorMessage, now(), now(), job.id);
  if (!done && !failed) {
    // 预算耗尽但未完成 → 滚动到下一计划窗（checkpoint 保留，续跑不重复 Issue）
    schedulePeriodicLintJob(database, { scope: job.scope, delayMs: PERIODIC_LINT_INTERVAL_MS });
  }
  return { skipped: false, steps, done, status: finishStatus, error: errorMessage };
}

/**
 * 处理到期的周期 Lint jobs（复用既有 jobs 表；依赖联合模式与 x-observation 一致）：
 * - DatabaseSync：测试/直连模式，同步执行（无 dispatcher/授权层）；
 * - ActiveWorkspaceRuntime：生产模式，claim/finish/步进经 dispatchBusinessCommand 授权执行。
 */
export async function runDuePeriodicLintJobs(
  dependency: ActiveWorkspaceRuntime | DatabaseSync,
  input: { isCurrent?: () => boolean; budgetSteps?: number; dueLimit?: number } = {}
): Promise<{ processed: number; stepsRun: number }> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const budgetSteps = Math.min(Math.max(input.budgetSteps ?? PERIODIC_LINT_STEP_BUDGET, 1), 100);
  // 确保滚动 job 存在（幂等；无 pending/running 行才创建）——调度器首个 tick 即完成初始计划
  const rollingExists = database.prepare('SELECT id FROM jobs WHERE kind = ? AND dedupe_key = ?')
    .get(KNOWLEDGE_LINT_JOB_KIND, lintJobDedupeKey('global'));
  if (!rollingExists) {
    if (!('database' in dependency)) {
      schedulePeriodicLintJob(database, { scope: 'global' });
    } else {
      await dispatchBusinessCommand(dependency, {
        command: 'knowledge_lint.schedule',
        requestId: `knowledge-lint:schedule:${Date.now()}`,
        actor: lintSchedulerActor,
        input: { scope: 'global' },
        boundIdentity: dependency.identity,
        entityType: 'knowledge_lint_job',
        execute: (runtimeDatabase) => ({ data: schedulePeriodicLintJob(runtimeDatabase, { scope: 'global' }) })
      }).catch((error) => console.error('[knowledge-lint] initial schedule failed', error));
    }
  }
  const due = listDueLintJobs(database, input.dueLimit ?? 2);
  let processed = 0;
  let stepsRun = 0;
  for (const job of due) {
    if (input.isCurrent && !input.isCurrent()) break;
    if (!('database' in dependency)) {
      // 直连模式（测试）：同步执行，无 dispatcher/授权层
      const result = runOneLintJob(database, job, budgetSteps, boundWorkspaceId(database));
      if (!result.skipped) {
        processed += 1;
        stepsRun += result.steps;
      }
      continue;
    }
    // 生产模式：claim/finish/步进经 dispatchBusinessCommand 授权执行
    const runtime = dependency;
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'knowledge_lint.run_job',
      requestId: `knowledge-lint:${job.id}:${job.attempts}`,
      actor: lintSchedulerActor,
      input: { jobId: job.id, expectedAttempts: job.attempts, scope: job.scope, budgetSteps, workspaceId: runtime.identity.workspaceId },
      boundIdentity: runtime.identity,
      entityType: 'knowledge_lint_job',
      execute: (runtimeDatabase) => {
        const result = runOneLintJob(runtimeDatabase, job, budgetSteps, runtime.identity.workspaceId);
        return { data: result, entityId: job.id };
      }
    });
    const data = requireReceiptData(receipt);
    if (!data.skipped) {
      processed += 1;
      stepsRun += data.steps;
    }
  }
  return { processed, stepsRun };
}

function boundWorkspaceId(database: DatabaseSync): string {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId?: string } | undefined;
    return row?.workspaceId ?? '';
  } catch {
    return '';
  }
}

const lintSchedulerActor = Object.freeze({ type: 'scheduler', id: 'knowledge-lint', label: 'knowledge-lint' }) as {
  type: 'scheduler';
  id: string;
  label: string;
};

/** 周期 Lint 驱动（与 XObservationScheduler 同构：轮询到期 job + 到期唤醒；不新建调度基础设施）。 */
export class KnowledgeLintScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private rerun = false;
  private generation = 0;
  private recovered = false;
  private readonly options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number };

  constructor(options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number }) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.recovered = false;
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.current) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.rerun = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    await this.current?.catch(() => {});
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.current) return;
    this.timer = null;
    const generation = this.generation;
    const runtime = this.options.runtime;
    const intervalMs = this.options.intervalMs ?? PERIODIC_LINT_INTERVAL_MS;
    this.current = (async () => {
      if (this.stopped || generation !== this.generation || !runtime.isActive || (this.options.isCurrent && !this.options.isCurrent())) return;
      if (!this.recovered) {
        recoverOrRetryPeriodicLintJobs(runtime.database, {});
        this.recovered = true;
      }
      await runDuePeriodicLintJobs(runtime, { isCurrent: () => !this.stopped && generation === this.generation && runtime.isActive && (!this.options.isCurrent || this.options.isCurrent()) });
    })().catch((error) => {
      console.error('[knowledge-lint] periodic scheduler tick failed', error);
    });
    await this.current;
    this.current = null;
    if (this.stopped || (this.options.isCurrent && !this.options.isCurrent())) return;
    if (this.rerun) {
      this.rerun = false;
      this.wake();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
}
