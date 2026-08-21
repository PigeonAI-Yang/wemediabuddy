// extracted from src/main/knowledge-health.ts (structural split)
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CreatorNature,
  HealthIssueSeverity,
  HealthIssueType,
  HealthIssueWrite,
  KnowledgeHealthIssueRecord,
  KnowledgeScope,
  KnowledgeUpdateReceiptRecord,
  RelationWrite,
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

/** 触发派生的受影响对象上限（超出则本轮跳过，交由周期 Lint 覆盖；有界）。 */
export const KNOWLEDGE_HEALTH_HOOK_MAX_OBJECTS_PER_SCOPE = 50 as const;

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
export const CHECKPOINT_META_KEY = 'knowledge_lint_checkpoint_v2';
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_MAX_AFFECTED_OBJECTS = 100;
export const DEFAULT_MAX_ISSUES_PER_RUN = 50;
export const LANE_PREFIX = 'lane:';

/** data_gap 业务阈值：captured FreeNote 超过该天数仍未处理即视为知识管线数据缺口。 */
export const DATA_GAP_FREE_NOTE_MAX_AGE_DAYS = 14 as const;

/** data-gap 检测/复查共用的确定性截止时间（captured 且 created_at 早于该值才构成缺口）。 */
export function dataGapCutoffIso(): string {
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

export const ALL_DETECTORS: readonly HealthLintDetector[] = Object.keys(KNOWLEDGE_HEALTH_DETECTORS) as HealthLintDetector[];

/** 自动修复 allowlist：只有列出的 issueType 允许自动 ChangeSet 修复（契约 §8 边界）。 */
export const AUTO_REPAIR_ALLOWLIST: Readonly<Record<HealthIssueType, boolean>> = Object.freeze({
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
export const PHASE_ORDER: readonly HealthLintPhase[] = [
  'relations', 'evidence_links', 'reviews', 'notes', 'wiki_pages',
  'missing_entity_pages', 'missing_topic_pages', 'orphan_notes',
  'unsupported_claims', 'stale_claims', 'duplicate_notes', 'duplicate_entities',
  'cross_references', 'data_gaps'
];

/** 正式关系端点存在性检查的目标表（与 store ENDPOINT_TABLES 对齐；全 schema 下恒存在）。 */
export const ENDPOINT_TABLES: Readonly<Record<string, string>> = Object.freeze({
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
export const EVIDENCE_OBJECT_TABLES: Readonly<Record<string, string>> = Object.freeze({
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
export const WIKI_REF_TABLES: Readonly<Record<string, string>> = Object.freeze({
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

export function lintError(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KnowledgeHealthError(code, message, details);
}

export function now(): string {
  return new Date().toISOString();
}

/** 确定性对象 id（幂等关键）：同 seed → 同 id。 */
export function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

/** 存在性检查（全 schema 下表恒存在；缺表视为无法验证放行，与 store objectExists 语义一致）。 */
export function objectExists(database: DatabaseSync, table: string, id: string): boolean {
  try {
    return database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  } catch {
    return true;
  }
}

export function parseEvidence(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(String(row.evidenceJson ?? '{}')) as Record<string, unknown>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function normalizeDetectors(raw: readonly HealthLintDetector[] | undefined): readonly HealthLintDetector[] {
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

export function validateScope(scope: unknown): KnowledgeScope {
  if (scope === 'global') return 'global';
  if (typeof scope === 'string' && scope.startsWith(LANE_PREFIX) && scope.length > LANE_PREFIX.length) {
    return scope as KnowledgeScope;
  }
  lintError('HEALTH_LINT_INPUT_INVALID', `非法 scope：${String(scope)}（必须为 global 或 lane:<key>）。`, { scope });
}

export function validateWorkspace(workspaceId: unknown): string {
  if (typeof workspaceId === 'string' && workspaceId.trim()) return workspaceId.trim();
  lintError('HEALTH_LINT_INPUT_INVALID', 'Lint 必须携带 workspaceId。');
}

export function validateRequestId(requestId: unknown): string {
  if (typeof requestId === 'string' && requestId.trim()) return requestId.trim();
  lintError('HEALTH_LINT_INPUT_INVALID', 'Lint 必须携带 requestId（幂等键）。');
}

/** 受影响对象去重（同 objectType+objectId 只扫一次）。 */
export function uniqueRefs(refs: readonly HealthLintObjectRef[]): HealthLintObjectRef[] {
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

export function issueFingerprint(scope: KnowledgeScope, plan: HealthLintIssuePlan): string {
  return JSON.stringify({
    issueType: plan.issueType,
    scope,
    affectedObjectType: plan.affectedObjectType,
    affectedObjectId: plan.affectedObjectId,
    anchor: plan.anchor
  });
}

export function buildEvidence(
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

export function nextIssueId(existingCount: number, fingerprint: string): string {
  const base = deterministicId('health', fingerprint);
  return existingCount === 0 ? base : `${base}-e${existingCount + 1}`;
}

/** 同指纹既有 Issue（含终态；用于去重/重开新事件/修复定位）。 */
export function findIssuesForPlan(
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

export type HealthLintCounts = Readonly<{
  scannedObjects: number;
  issuesCreated: number;
  issuesDeduplicated: number;
  issuesAutoResolved: number;
  repairsApplied: number;
}>;

export const ZERO_COUNTS: HealthLintCounts = Object.freeze({ scannedObjects: 0, issuesCreated: 0, issuesDeduplicated: 0, issuesAutoResolved: 0, repairsApplied: 0 });

export type BuiltOps = Readonly<{
  relationOps: import('./knowledge-flywheel.ts').RelationWrite[];
  healthIssueOps: import('./knowledge-flywheel.ts').HealthIssueWrite[];
  counts: HealthLintCounts;
  touchedIssueIds: readonly string[];
}>;

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
  resume?: boolean;
}>;

export type KnowledgeHealthLintInput = Readonly<{
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
  replay: boolean;
  changeSetId: string | null;
  requestId: string;
  counts: HealthLintCounts;
  issues: readonly KnowledgeHealthIssueRecord[];
  receipt: KnowledgeUpdateReceiptRecord | null;
}>;

export type KnowledgeHealthPeriodicStepResult = KnowledgeHealthLintResult &
  Readonly<{
    done: boolean;
    checkpoint: KnowledgeHealthCheckpoint;
  }>;
