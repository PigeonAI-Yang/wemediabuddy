/**
 * WMB-5210 M1：知识飞轮核心 typed store/service（共享契约与持久化；无编译器/UI）。
 * Design: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md
 *
 * 单一原子写入口：applyKnowledgeChangeSet —— 一个 ChangeSet 内全部业务写在同一个
 * BEGIN IMMEDIATE 事务中全部成功或零写；requestId 幂等（同 (workspaceId, requestId,
 * inputHash) 重放返回原结果与同一回执）；每个被修改的当前对象必须携带 beforeRevision
 * （不匹配抛 REVISION_CONFLICT）；版本号按对象连续递增；恢复是追加版本；merge/supersede
 * 防循环；跨 data-root 拒绝（workspace 身份列 + lane 注册校验 + 同库 FK）。
 * 只读 API 全部有界（limit ≤ 100）。
 *
 * 正式知识关系表为 knowledge_formal_relations：既有 v18/v21 knowledge_relations 是
 * 画布可视化投影（from_node_id/to_node_id），不得同名/冒充正式知识关系（契约 §2 / §16）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ============================================================
// 领域类型
// ============================================================

export type KnowledgeScope = 'global' | `lane:${string}`;

export type CreatorNature = 'user' | 'pi' | 'background_agent' | 'system' | 'migration';
export type Lifecycle = 'active' | 'archived' | 'superseded' | 'merged' | 'rejected';
export type NoteKind = 'claim' | 'insight' | 'concept' | 'case' | 'method' | 'question' | 'creative_pattern';
export type EntityType = 'person' | 'organization' | 'product' | 'platform' | 'policy' | 'institution' | 'place' | 'publication_channel' | 'other';
export type ConclusionStatus = 'unverified' | 'supported' | 'disputed' | 'contradicted' | 'superseded' | 'not_applicable' | 'inference';
export type EvidenceLevel = 'none' | 'single' | 'corroborated' | 'primary' | 'outcome_observed' | 'mixed' | 'insufficient';
export type NoteVersionChangeType = 'created' | 'strengthened' | 'weakened' | 'contradicted' | 'qualified' | 'superseded' | 'merged' | 'promoted' | 'archived' | 'rejected' | 'restored' | 'recompiled';
export type WikiPageType = 'map' | 'topic' | 'entity' | 'method' | 'synthesis';
export type CompileStatus = 'current' | 'stale' | 'compiling' | 'failed';
export type FreeNoteSourceNature = 'user_quick_note' | 'page_note' | 'pi_dialogue' | 'user_approval_reason' | 'observation' | 'system_capture';
export type FreeNoteProcessingState = 'captured' | 'processed' | 'partially_processed' | 'ignored' | 'archived';
export type TriggerSource = 'ingest' | 'query' | 'lint' | 'creation' | 'review' | 'user' | 'migration';
export type ResolutionMode = 'replaced_current' | 'time_bounded' | 'scope_split' | 'kept_disputed' | 'insufficient' | 'manual_correction' | 'none';
export type RelationEndpointType = 'knowledge_note' | 'knowledge_note_version' | 'knowledge_entity' | 'wiki_page' | 'free_note' | 'source' | 'topic' | 'content_project' | 'review' | 'method_finding';
export type EvidenceObjectType = 'source' | 'free_note' | 'review' | 'publication' | 'metric_snapshot' | 'knowledge_note_version' | 'wiki_page_version' | 'content_version' | 'platform_version';
export type EvidenceRelation = 'supports' | 'contradicts' | 'qualifies' | 'derived_from';
export type SourceNature = 'primary_source' | 'secondary_source' | 'user_statement' | 'user_experience' | 'business_record' | 'performance_observation' | 'review' | 'derived_knowledge' | 'ai_inference';
export type AnnotationTargetType = 'free_note' | 'knowledge_entity' | 'knowledge_note_version' | 'wiki_page' | 'wiki_page_version' | 'knowledge_change_set';
export type AnnotationIntent = 'correction' | 'qualify' | 'downgrade' | 'emphasize' | 'research_request' | 'merge' | 'split' | 'restore' | 'comment';
export type AnnotationMigrationState = 'none' | 'migrated' | 'deleted' | 'ambiguous' | 'user_removed';
export type AnnotationProcessingState = 'open' | 'processed';
export type HealthIssueType = 'stale_claim' | 'unresolved_contradiction' | 'unsupported_claim' | 'duplicate_entity' | 'duplicate_knowledge' | 'orphan_knowledge' | 'missing_wiki_page' | 'stale_wiki_page' | 'broken_reference' | 'unreturned_review' | 'underperforming_method' | 'overgeneralized_global' | 'unanswered_high_value_question' | 'data_gap';
export type HealthIssueSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type HealthIssueStatus = 'open' | 'repairing' | 'resolved' | 'accepted_risk' | 'false_positive';
export type ReceiptTriggerType = 'ingest' | 'query' | 'lint' | 'creation' | 'review' | 'migration';
export type QueryWriteBackDecision = 'created' | 'updated' | 'skipped_repetition' | 'skipped_low_value' | 'skipped_transient' | 'no_write_back';

// ============================================================
// 枚举与固定矩阵
// ============================================================

const ALL_STATUSES: readonly ConclusionStatus[] = ['unverified', 'supported', 'disputed', 'contradicted', 'superseded', 'not_applicable', 'inference'];
const QUESTION_STATUSES: readonly ConclusionStatus[] = ['unverified', 'disputed', 'contradicted', 'superseded', 'not_applicable', 'inference'];
const NOTE_KIND_STATUSES: Readonly<Record<NoteKind, readonly ConclusionStatus[]>> = Object.freeze({
  claim: ALL_STATUSES,
  insight: ALL_STATUSES,
  concept: ALL_STATUSES,
  case: ALL_STATUSES,
  method: ALL_STATUSES,
  creative_pattern: ALL_STATUSES,
  // 契约 §8.1：Question 不能标记为 supported
  question: QUESTION_STATUSES
});

const RELATION_ENDPOINT_TYPES: readonly RelationEndpointType[] = [
  'knowledge_note', 'knowledge_note_version', 'knowledge_entity', 'wiki_page', 'free_note',
  'source', 'topic', 'content_project', 'review', 'method_finding'
];

const LANE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EXTENSION_RELATION_PATTERN = /^extension:[a-z0-9_]+:[a-z0-9_]+$/;

/** 关系端点存在性检查的目标表（精简 fixture 缺表时跳过，full schema 下强制）。 */
const ENDPOINT_TABLES: Readonly<Record<RelationEndpointType, string>> = Object.freeze({
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

const EVIDENCE_OBJECT_TABLES: Readonly<Record<EvidenceObjectType, string>> = Object.freeze({
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

const ANNOTATION_TARGET_TABLES: Readonly<Record<AnnotationTargetType, string>> = Object.freeze({
  free_note: 'knowledge_free_notes',
  knowledge_entity: 'knowledge_entities',
  knowledge_note_version: 'knowledge_note_versions',
  wiki_page: 'knowledge_wiki_pages',
  wiki_page_version: 'knowledge_wiki_page_versions',
  knowledge_change_set: 'knowledge_change_sets'
});

// ============================================================
// 错误与工具
// ============================================================

export class KnowledgeFlywheelError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'KnowledgeFlywheelError';
    this.code = code;
    this.details = details;
  }
}

function fail(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KnowledgeFlywheelError(code, message, details);
}

export const KNOWLEDGE_FLYWHEEL_ERROR_CODES = Object.freeze([
  'WORKSPACE_MISMATCH',
  'SCOPE_NOT_REGISTERED',
  'REQUEST_REPLAY_CONFLICT',
  'REVISION_CONFLICT',
  'OBJECT_NOT_FOUND',
  'LIFECYCLE_CYCLE',
  'LIFECYCLE_INVALID',
  'RELATION_NOT_IN_REGISTRY',
  'RELATION_ENDPOINT_INVALID',
  'RELATION_ENDPOINT_NOT_FOUND',
  'VERSION_STATUS_INVALID',
  'INVALID_INPUT'
] as const);

export function createKnowledgeChangeSetInputHash(requestId: string, input: unknown): string {
  return createHash('sha256').update(stableJson({ requestId, input })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function bounds(input?: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(input?.limit ?? 50, 1), 100),
    offset: Math.max(input?.offset ?? 0, 0)
  };
}

function now(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string | null | undefined, label: string): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fail('INVALID_INPUT', `${label} 应为 JSON 数组`);
  } catch {
    return fail('INVALID_INPUT', `${label} 不是合法 JSON`);
  }
}

function normalizeCanonicalKey(value: string): string {
  return value?.trim().toLowerCase() ?? '';
}

function nextVersionNumber(database: DatabaseSync, table: string, parentColumn: string, parentId: string): number {
  const row = database.prepare(`SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM ${table} WHERE ${parentColumn} = ?`).get(parentId) as { next: number };
  return Number(row.next);
}

// ============================================================
// data-root / scope 隔离
// ============================================================

/**
 * 跨 data-root 拒绝（workspace 维度）：ChangeSet 必须属于当前数据库绑定的工作空间。
 * app_meta.workspace_id 缺失时（未激活的精简 fixture）放行；存在且不匹配 → WORKSPACE_MISMATCH。
 */
export function assertWorkspaceMatches(database: DatabaseSync, workspaceId: string): void {
  let bound: string | null = null;
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    bound = row?.value ?? null;
  } catch {
    // 精简 fixture 无 app_meta → 放行
  }
  if (bound !== null && bound !== workspaceId) {
    fail('WORKSPACE_MISMATCH', `ChangeSet 工作空间 ${workspaceId} 与当前 data-root（${bound}）不一致。`, { boundWorkspaceId: bound, changeSetWorkspaceId: workspaceId });
  }
}

/**
 * Scope 合法性：'global' 恒合法；'lane:<key>' 必须命中本工作空间既有赛道身份
 * （source_lane_judgments.workspace_lane / workspace_profiles 的 intelligence_pack_id|profile_id），
 * 不复制外部根对象规避 data-root 边界（契约 §3 / §19）。
 */
export function assertScopeAllowed(database: DatabaseSync, scope: string): void {
  if (scope === 'global') return;
  if (typeof scope !== 'string' || !scope.startsWith('lane:')) {
    fail('INVALID_INPUT', `非法 scope：${String(scope)}（必须为 global 或 lane:<key>）。`);
  }
  const laneKey = scope.slice('lane:'.length);
  if (!LANE_KEY_PATTERN.test(laneKey)) {
    fail('INVALID_INPUT', `非法 lane scope key：${laneKey}。`);
  }
  if (!isRegisteredLane(database, laneKey)) {
    fail('SCOPE_NOT_REGISTERED', `lane:<${laneKey}> 未在本工作空间注册，拒绝跨 data-root/lane 写入。`, { laneKey });
  }
}

function isRegisteredLane(database: DatabaseSync, laneKey: string): boolean {
  try {
    const rows = database.prepare(`
      SELECT lane FROM (
        SELECT workspace_lane AS lane FROM source_lane_judgments
        UNION SELECT intelligence_pack_id AS lane FROM workspace_profiles
        UNION SELECT profile_id AS lane FROM workspace_profiles
      ) WHERE lane = ? LIMIT 1
    `).all(laneKey) as Array<{ lane: string }>;
    return rows.length > 0;
  } catch {
    // 精简 fixture 缺表 → 无法验证，退回格式校验（full schema 下强制注册）
    return true;
  }
}

function objectExists(database: DatabaseSync, table: string, id: string): boolean {
  try {
    const row = database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
    return row !== undefined;
  } catch {
    // 精简 fixture 缺表 → 视为无法验证（FK/存在性由 full schema 强制）
    return true;
  }
}

// ============================================================
// ChangeSet 输入类型
// ============================================================

export type FreeNoteWrite = Readonly<{
  id?: string;
  scope: KnowledgeScope;
  sourceNature: FreeNoteSourceNature;
  body: string;
  processingState?: FreeNoteProcessingState;
  processingReason?: string;
  workspaceLane?: string | null;
  pageRef?: string | null;
  sessionRef?: string | null;
  taskRef?: string | null;
  linkedObjectType?: string | null;
  linkedObjectId?: string | null;
}>;

export type FreeNoteTransitionWrite = Readonly<{
  id: string;
  beforeRevision: number;
  processingState: FreeNoteProcessingState;
  processingReason: string;
}>;

export type EntityWrite = Readonly<{
  id?: string;
  scope: KnowledgeScope;
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases?: readonly string[];
  externalIdentity?: Readonly<Record<string, unknown>>;
  lifecycle?: Lifecycle;
  mergedIntoEntityId?: string;
  supersededByEntityId?: string;
  /** 更新既有实体必填；创建不带。 */
  beforeRevision?: number;
}>;

export type NoteVersionWrite = Readonly<{
  versionId?: string;
  title?: string;
  statement: string;
  body?: string;
  conclusionStatus: ConclusionStatus;
  evidenceLevel: EvidenceLevel;
  appliesTo?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  adoptedEntityIds?: readonly string[];
  adoptedTopicIds?: readonly string[];
  adoptedKnowledgeVersionIds?: readonly string[];
  changeType?: NoteVersionChangeType;
  changeReason?: string;
  /** 恢复：内容从该不可变版本复制，追加新版本号（契约 §15.2）。 */
  restoreFromVersionId?: string;
}>;

export type NoteWrite = Readonly<{
  id?: string;
  scope: KnowledgeScope;
  kind: NoteKind;
  canonicalKey: string;
  title?: string;
  lifecycle?: Lifecycle;
  mergedIntoNoteId?: string;
  supersededByNoteId?: string;
  /** 追加版本/生命周期变化必填；创建不带。 */
  beforeRevision?: number;
  version: NoteVersionWrite;
}>;

export type WikiPageVersionWrite = Readonly<{
  versionId?: string;
  title?: string;
  body: Readonly<Record<string, unknown>>;
  adoptedNoteVersionIds?: readonly string[];
  businessObjectRefs?: readonly string[];
  flags?: readonly string[];
  changeSummary: string;
  readableDiff?: string;
  compileReason: string;
  /** 恢复：内容从该不可变版本复制（契约 §15.2）。 */
  restoreFromVersionId?: string;
}>;

export type WikiPageWrite = Readonly<{
  id?: string;
  scope: KnowledgeScope;
  pageType: WikiPageType;
  canonicalKey: string;
  title?: string;
  subjectType?: 'scope' | 'topic' | 'entity' | 'method_note';
  subjectId?: string;
  lifecycle?: Lifecycle;
  mergedIntoPageId?: string;
  supersededByPageId?: string;
  compileStatus?: CompileStatus;
  compileNote?: string | null;
  /** 更新既有页面必填；创建不带。 */
  beforeRevision?: number;
  /** 生成新页面版本；与 markStaleInstead 互斥。 */
  version?: WikiPageVersionWrite;
  /** 知识变化无法编译时显式标记 stale 并记录原因（契约 §15.3）。 */
  markStaleInstead?: Readonly<{ reason: string }>;
}>;

export type RelationCreateWrite = Readonly<{
  op: 'create';
  id?: string;
  scope: KnowledgeScope;
  relationKey: string;
  fromObjectType: RelationEndpointType;
  fromObjectId: string;
  toObjectType: RelationEndpointType;
  toObjectId: string;
}>;

export type RelationEndWrite = Readonly<{
  op: 'end';
  id: string;
  reason: string;
}>;

export type RelationWrite = RelationCreateWrite | RelationEndWrite;

export type EvidenceLinkWrite = Readonly<{
  id?: string;
  knowledgeNoteVersionId: string;
  evidenceObjectType: EvidenceObjectType;
  evidenceObjectId: string;
  relation: EvidenceRelation;
  sourceNature: SourceNature;
  excerpt?: string | null;
  locator?: string | null;
  observedAt?: string | null;
}>;

export type AnnotationCreateWrite = Readonly<{
  op: 'create';
  id?: string;
  scope: KnowledgeScope;
  targetType: AnnotationTargetType;
  targetId: string;
  quotedText?: string;
  prefixContext?: string;
  suffixContext?: string;
  anchor?: Readonly<Record<string, unknown>>;
  intent: AnnotationIntent;
  body?: string;
  userIdentity: string;
}>;

export type AnnotationTransitionWrite = Readonly<{
  op: 'process';
  id: string;
  processingState?: AnnotationProcessingState;
  migrationState?: AnnotationMigrationState;
}>;

export type AnnotationWrite = AnnotationCreateWrite | AnnotationTransitionWrite;

export type HealthIssueCreateWrite = Readonly<{
  op: 'create';
  id?: string;
  scope: KnowledgeScope;
  issueType: HealthIssueType;
  affectedObjectType?: string | null;
  affectedObjectId?: string | null;
  severity: HealthIssueSeverity;
  evidence?: Readonly<Record<string, unknown>>;
  suggestedAction?: string;
}>;

export type HealthIssueUpdateWrite = Readonly<{
  op: 'update';
  id: string;
  beforeRevision: number;
  status: HealthIssueStatus;
  resolutionNote?: string;
}>;

export type HealthIssueWrite = HealthIssueCreateWrite | HealthIssueUpdateWrite;

export type ReceiptWrite = Readonly<{
  id?: string;
  triggerType: ReceiptTriggerType;
  requestId: string;
  summary: string;
  counts: Readonly<Record<string, number>>;
  affectedTopics?: readonly string[];
  affectedEntities?: readonly string[];
  affectedMethods?: readonly string[];
  affectedSyntheses?: readonly string[];
  wikiPageVersions?: readonly string[];
  impact?: Readonly<Record<string, unknown>>;
  autoResolutions?: readonly string[];
  retainedDisputes?: readonly string[];
  failures?: readonly string[];
}>;

export type QueryArtifactWrite = Readonly<{
  id?: string;
  scope: KnowledgeScope;
  requestId?: string;
  question: string;
  answerSummary?: string;
  readWikiVersionIds?: readonly string[];
  readNoteVersionIds?: readonly string[];
  readEvidenceIds?: readonly string[];
  candidates?: readonly unknown[];
  writeBackDecision: QueryWriteBackDecision;
  skipReason?: string | null;
  receiptId?: string;
}>;

export type ExtensionRelationRegistration = Readonly<{
  relationKey: string;
  displayName: string;
  description?: string;
  fromTypes: readonly RelationEndpointType[];
  toTypes: readonly RelationEndpointType[];
  reason: string;
}>;

export type KnowledgeChangeSetInput = Readonly<{
  freeNotes?: readonly FreeNoteWrite[];
  freeNoteTransitions?: readonly FreeNoteTransitionWrite[];
  entities?: readonly EntityWrite[];
  notes?: readonly NoteWrite[];
  relations?: readonly RelationWrite[];
  evidenceLinks?: readonly EvidenceLinkWrite[];
  annotations?: readonly AnnotationWrite[];
  wikiPages?: readonly WikiPageWrite[];
  healthIssues?: readonly HealthIssueWrite[];
  receipts?: readonly ReceiptWrite[];
  queryArtifacts?: readonly QueryArtifactWrite[];
  extensionRelations?: readonly ExtensionRelationRegistration[];
}>;

export type KnowledgeChangeSetMeta = Readonly<{
  workspaceId: string;
  requestId: string;
  reason: string;
  triggerSource: TriggerSource;
  resolutionMode: ResolutionMode;
  createdBy: CreatorNature;
  /** 缺省时按 stableJson({requestId, input}) 自算；dispatcher 可传入 envelope.inputHash。 */
  inputHash?: string;
}>;

export type ApplyChangeSetResult = Readonly<{
  changeSetId: string;
  /** true = 同 (workspaceId, requestId, inputHash) 幂等重放，零新增行。 */
  replay: boolean;
  changeSet: KnowledgeChangeSetRecord | null;
  /** 本 ChangeSet 生成的回执；重放时返回同一回执（契约 §24）。 */
  receipt: KnowledgeUpdateReceiptRecord | null;
  /** 被修改当前对象 id → afterRevision（逐对象 revision 明细）。 */
  revisions: Readonly<Record<string, number>>;
}>;

// ============================================================
// 读模型记录类型
// ============================================================

export type KnowledgeChangeSetRecord = Readonly<{
  id: string;
  workspaceId: string;
  requestId: string;
  inputHash: string;
  reason: string;
  triggerSource: TriggerSource;
  resolutionMode: ResolutionMode;
  createdBy: CreatorNature;
  createdAt: string;
}>;

export type KnowledgeFreeNoteRecord = Readonly<{
  id: string;
  scope: string;
  sourceNature: FreeNoteSourceNature;
  body: string;
  processingState: FreeNoteProcessingState;
  processingReason: string;
  workspaceLane: string | null;
  pageRef: string | null;
  sessionRef: string | null;
  taskRef: string | null;
  linkedObjectType: string | null;
  linkedObjectId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}>;

export type KnowledgeEntityRecord = Readonly<{
  id: string;
  scope: string;
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases: readonly string[];
  externalIdentity: Readonly<Record<string, unknown>>;
  lifecycle: Lifecycle;
  mergedIntoEntityId: string | null;
  supersededByEntityId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}>;

export type KnowledgeNoteRecord = Readonly<{
  id: string;
  scope: string;
  kind: NoteKind;
  canonicalKey: string;
  title: string;
  lifecycle: Lifecycle;
  currentVersionId: string | null;
  mergedIntoNoteId: string | null;
  supersededByNoteId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}>;

export type KnowledgeNoteVersionRecord = Readonly<{
  id: string;
  noteId: string;
  versionNumber: number;
  title: string;
  statement: string;
  body: string;
  conclusionStatus: ConclusionStatus;
  evidenceLevel: EvidenceLevel;
  appliesTo: string;
  validFrom: string | null;
  validUntil: string | null;
  adoptedEntityIds: readonly string[];
  adoptedTopicIds: readonly string[];
  adoptedKnowledgeVersionIds: readonly string[];
  changeType: NoteVersionChangeType;
  changeReason: string;
  creatorNature: CreatorNature;
  changeSetId: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}>;

export type KnowledgeWikiPageRecord = Readonly<{
  id: string;
  scope: string;
  pageType: WikiPageType;
  canonicalKey: string;
  title: string;
  subjectType: string | null;
  subjectId: string | null;
  lifecycle: Lifecycle;
  currentVersionId: string | null;
  mergedIntoPageId: string | null;
  supersededByPageId: string | null;
  compileStatus: CompileStatus;
  compileNote: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}>;

export type KnowledgeWikiPageVersionRecord = Readonly<{
  id: string;
  pageId: string;
  versionNumber: number;
  title: string;
  body: Readonly<Record<string, unknown>>;
  adoptedNoteVersionIds: readonly string[];
  businessObjectRefs: readonly string[];
  flags: readonly string[];
  changeSummary: string;
  readableDiff: string;
  compileReason: string;
  creatorNature: CreatorNature;
  changeSetId: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}>;

export type KnowledgeRelationRecord = Readonly<{
  id: string;
  scope: string;
  relationKey: string;
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  createdChangeSetId: string;
  endedChangeSetId: string | null;
  endReason: string;
  createdAt: string;
  endedAt: string | null;
}>;

export type KnowledgeEvidenceLinkRecord = Readonly<{
  id: string;
  knowledgeNoteVersionId: string;
  evidenceObjectType: EvidenceObjectType;
  evidenceObjectId: string;
  relation: EvidenceRelation;
  sourceNature: SourceNature;
  excerpt: string | null;
  locator: string | null;
  observedAt: string | null;
  creatorNature: CreatorNature;
  changeSetId: string;
  createdAt: string;
}>;

export type KnowledgeAnnotationRecord = Readonly<{
  id: string;
  scope: string;
  targetType: AnnotationTargetType;
  targetId: string;
  quotedText: string;
  prefixContext: string;
  suffixContext: string;
  anchor: Readonly<Record<string, unknown>>;
  intent: AnnotationIntent;
  body: string;
  migrationState: AnnotationMigrationState;
  processingState: AnnotationProcessingState;
  processedChangeSetId: string | null;
  userIdentity: string;
  createdBy: CreatorNature;
  createdAt: string;
  updatedAt: string;
}>;

export type KnowledgeUpdateReceiptRecord = Readonly<{
  id: string;
  workspaceId: string;
  changeSetId: string;
  triggerType: ReceiptTriggerType;
  requestId: string;
  summary: string;
  counts: Readonly<Record<string, number>>;
  affectedTopics: readonly string[];
  affectedEntities: readonly string[];
  affectedMethods: readonly string[];
  affectedSyntheses: readonly string[];
  wikiPageVersions: readonly string[];
  impact: Readonly<Record<string, unknown>>;
  autoResolutions: readonly string[];
  retainedDisputes: readonly string[];
  failures: readonly string[];
  createdBy: CreatorNature;
  createdAt: string;
}>;

export type KnowledgeQueryArtifactRecord = Readonly<{
  id: string;
  scope: string;
  workspaceId: string;
  requestId: string;
  question: string;
  answerSummary: string;
  readWikiVersionIds: readonly string[];
  readNoteVersionIds: readonly string[];
  readEvidenceIds: readonly string[];
  candidates: readonly unknown[];
  writeBackDecision: QueryWriteBackDecision;
  skipReason: string | null;
  changeSetId: string | null;
  receiptId: string | null;
  createdBy: CreatorNature;
  createdAt: string;
}>;

export type KnowledgeHealthIssueRecord = Readonly<{
  id: string;
  scope: string;
  issueType: HealthIssueType;
  affectedObjectType: string | null;
  affectedObjectId: string | null;
  severity: HealthIssueSeverity;
  evidence: Readonly<Record<string, unknown>>;
  suggestedAction: string;
  status: HealthIssueStatus;
  resolutionNote: string | null;
  resolvedChangeSetId: string | null;
  detectedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  revision: number;
}>;

export type KnowledgeRelationRegistryRecord = Readonly<{
  relationKey: string;
  displayName: string;
  description: string;
  directional: boolean;
  allowsDuplicate: boolean;
  participatesInJudgment: boolean;
  inCreationRecall: boolean;
  reverseName: string;
  fromTypes: readonly string[];
  toTypes: readonly string[];
  extension: boolean;
}>;

export type KnowledgeResolution = Readonly<{
  originalId: string;
  resolvedId: string;
  hops: readonly string[];
  terminated: boolean;
}>;

// ============================================================
// ChangeSet 应用（单一原子写入口）
// ============================================================

export function applyKnowledgeChangeSet(
  database: DatabaseSync,
  meta: KnowledgeChangeSetMeta,
  input: KnowledgeChangeSetInput,
  transaction = true
): ApplyChangeSetResult {
  if (!meta.workspaceId || !meta.requestId) fail('INVALID_INPUT', 'ChangeSet 必须携带 workspaceId 与 requestId。');
  if (!meta.reason?.trim()) fail('INVALID_INPUT', 'ChangeSet 必须有人类可读的总体原因。');
  assertWorkspaceMatches(database, meta.workspaceId);
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const result = applyInsideTransaction(database, meta, input);
    if (transaction) database.exec('COMMIT');
    fireKnowledgeChangeSetLintTrigger(database, meta, input, result, !transaction);
    fireKnowledgeChangeSetIndexTrigger(database, meta, input, result, !transaction);
    return result;
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

// ============================================================
// 知识变更后局部 Lint 触发点（WMB-5216；默认 no-op，不改变既有契约）
// ============================================================

export type KnowledgeChangeSetLintTriggerContext = Readonly<{
  database: DatabaseSync;
  meta: KnowledgeChangeSetMeta;
  input: KnowledgeChangeSetInput;
  result: ApplyChangeSetResult;
  /** true = 调用方在既有事务内（transaction=false 路径），lint 必须以 SAVEPOINT 嵌套提交。 */
  nestedTransaction: boolean;
}>;

let knowledgeChangeSetLintTrigger: ((ctx: KnowledgeChangeSetLintTriggerContext) => void) | null = null;
let knowledgeChangeSetLintTriggerDepth = 0;

/**
 * 注册统一的知识变更后局部 Lint 触发点（WMB-5216 健康侧）。默认 null = 零行为变化。
 * 触发语义（对既有 ChangeSet 契约零侵入）：
 * - 只在非重放、非 lint 自身（triggerSource='lint'）的 ChangeSet 提交后触发；
 * - 深度守卫防止 lint 内部 ChangeSet 递归触发；
 * - 触发回调异常被捕获并记录，绝不回滚已成功提交的业务 ChangeSet
 *   （lint 自身以 SAVEPOINT 提交，失败只回滚 lint 自己的写）。
 */
export function setKnowledgeChangeSetLintTrigger(trigger: ((ctx: KnowledgeChangeSetLintTriggerContext) => void) | null): void {
  knowledgeChangeSetLintTrigger = trigger;
}

export function fireKnowledgeChangeSetLintTrigger(
  database: DatabaseSync,
  meta: KnowledgeChangeSetMeta,
  input: KnowledgeChangeSetInput,
  result: ApplyChangeSetResult,
  nestedTransaction: boolean
): void {
  if (!knowledgeChangeSetLintTrigger || knowledgeChangeSetLintTriggerDepth > 0) return;
  if (result.replay) return;
  if (meta.triggerSource === 'lint') return;
  knowledgeChangeSetLintTriggerDepth += 1;
  try {
    knowledgeChangeSetLintTrigger({ database, meta, input, result, nestedTransaction });
  } catch (error) {
    // 可观察：局部 Lint 失败不阻断/不回滚已成功业务 ChangeSet（lint 自己的 SAVEPOINT 已回滚）。
    console.error('[knowledge-lint] post-commit local lint failed', error);
  } finally {
    knowledgeChangeSetLintTriggerDepth -= 1;
  }
}

// ============================================================
// 知识变更后索引/日志增量投影触发点（WMB-5238；默认 no-op，不改变既有契约）
// ============================================================

/**
 * 与局部 Lint 触发点同构的 ChangeSet 提交后投影触发点（wiki-index-triggers.ts 注册）。
 * 与 Lint 触发点的差异：
 * - 对全部 ChangeSet 触发（含 triggerSource='lint' 的 Lint/维护写，事件同样要进索引/日志）；
 * - 只在非重放（replay=零新增行）后触发，重复 requestId/同一输入重放不重复投影；
 * - 深度守卫防止投影回调内部触发 ChangeSet 造成递归；
 * - 回调异常被捕获并记录，绝不回滚已成功提交的业务 ChangeSet
 *   （投影自身以 SAVEPOINT 嵌套提交，失败只回滚投影自己的写）。
 */
export type KnowledgeChangeSetIndexTriggerContext = Readonly<{
  database: DatabaseSync;
  meta: KnowledgeChangeSetMeta;
  input: KnowledgeChangeSetInput;
  result: ApplyChangeSetResult;
  /** true = 调用方在既有事务内（transaction=false 路径），投影必须以 SAVEPOINT 嵌套提交。 */
  nestedTransaction: boolean;
}>;

let knowledgeChangeSetIndexTrigger: ((ctx: KnowledgeChangeSetIndexTriggerContext) => void) | null = null;
let knowledgeChangeSetIndexTriggerDepth = 0;

export function setKnowledgeChangeSetIndexTrigger(trigger: ((ctx: KnowledgeChangeSetIndexTriggerContext) => void) | null): void {
  knowledgeChangeSetIndexTrigger = trigger;
}

export function fireKnowledgeChangeSetIndexTrigger(
  database: DatabaseSync,
  meta: KnowledgeChangeSetMeta,
  input: KnowledgeChangeSetInput,
  result: ApplyChangeSetResult,
  nestedTransaction: boolean
): void {
  if (!knowledgeChangeSetIndexTrigger || knowledgeChangeSetIndexTriggerDepth > 0) return;
  if (result.replay) return;
  knowledgeChangeSetIndexTriggerDepth += 1;
  try {
    knowledgeChangeSetIndexTrigger({ database, meta, input, result, nestedTransaction });
  } catch (error) {
    // 可观察：索引/日志投影失败不阻断/不回滚已成功业务 ChangeSet（投影 SAVEPOINT 已回滚；
    // 索引可通过 rebuildWikiIndex 自愈重建）。
    console.error('[wiki-index] post-commit index projection failed', error);
  } finally {
    knowledgeChangeSetIndexTriggerDepth -= 1;
  }
}

function applyInsideTransaction(database: DatabaseSync, meta: KnowledgeChangeSetMeta, input: KnowledgeChangeSetInput): ApplyChangeSetResult {
  const inputHash = meta.inputHash ?? createKnowledgeChangeSetInputHash(meta.requestId, input);
  const prior = database.prepare(
    'SELECT id, input_hash AS inputHash FROM knowledge_change_sets WHERE workspace_id = ? AND request_id = ?'
  ).get(meta.workspaceId, meta.requestId) as { id: string; inputHash: string } | undefined;
  if (prior) {
    if (prior.inputHash !== inputHash) {
      fail('REQUEST_REPLAY_CONFLICT', '相同 requestId 已绑定不同输入。', { requestId: meta.requestId });
    }
    // 幂等重放：零新增行，返回原 ChangeSet 与同一回执（契约 §14.3 / §24）
    return Object.freeze({
      changeSetId: prior.id,
      replay: true,
      changeSet: getChangeSet(database, prior.id),
      receipt: getUpdateReceiptByChangeSet(database, prior.id),
      revisions: Object.freeze({})
    });
  }

  const changeSetId = randomUUID();
  database.prepare(`INSERT INTO knowledge_change_sets
    (id, workspace_id, request_id, input_hash, reason, trigger_source, resolution_mode, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(changeSetId, meta.workspaceId, meta.requestId, inputHash, meta.reason.trim(), meta.triggerSource,
      meta.resolutionMode, meta.createdBy, now());

  const revisions: Record<string, number> = {};

  if (input.extensionRelations?.length) {
    for (const registration of input.extensionRelations) insertExtensionRelation(database, registration);
  }
  for (const write of input.freeNotes ?? []) insertFreeNote(database, write);
  for (const transition of input.freeNoteTransitions ?? []) {
    revisions[transition.id] = transitionFreeNote(database, transition);
  }
  for (const write of input.entities ?? []) {
    const { id, revision } = writeEntity(database, meta, write);
    revisions[id] = revision;
  }
  for (const write of input.notes ?? []) {
    const { id, revision } = writeNote(database, changeSetId, meta, write);
    revisions[id] = revision;
  }
  for (const write of input.wikiPages ?? []) {
    const { id, revision } = writeWikiPage(database, changeSetId, meta, write);
    revisions[id] = revision;
  }
  for (const write of input.relations ?? []) {
    if (write.op === 'create') insertRelation(database, changeSetId, write);
    else endRelation(database, changeSetId, write);
  }
  for (const write of input.evidenceLinks ?? []) insertEvidenceLink(database, changeSetId, meta, write);
  for (const write of input.annotations ?? []) {
    if (write.op === 'create') insertAnnotation(database, changeSetId, meta, write);
    else transitionAnnotation(database, changeSetId, write);
  }
  for (const write of input.healthIssues ?? []) {
    if (write.op === 'create') insertHealthIssue(database, write);
    else {
      const id = updateHealthIssue(database, changeSetId, write);
      revisions[id] = write.beforeRevision + 1;
    }
  }
  for (const write of input.receipts ?? []) recordReceipt(database, changeSetId, meta, write);
  for (const write of input.queryArtifacts ?? []) recordQueryArtifact(database, changeSetId, meta, write);

  return Object.freeze({
    changeSetId,
    replay: false,
    changeSet: getChangeSet(database, changeSetId),
    receipt: getUpdateReceiptByChangeSet(database, changeSetId),
    revisions: Object.freeze({ ...revisions })
  });
}

// ============================================================
// 段处理器：FreeNote
// ============================================================

function insertFreeNote(database: DatabaseSync, write: FreeNoteWrite): void {
  assertScopeAllowed(database, write.scope);
  const body = write.body?.trim();
  if (!body) fail('INVALID_INPUT', 'FreeNote 原文不能为空。');
  const id = write.id ?? randomUUID();
  const timestamp = now();
  database.prepare(`INSERT INTO knowledge_free_notes
    (id, scope, source_nature, body, processing_state, processing_reason, workspace_lane, page_ref, session_ref, task_ref,
     linked_object_type, linked_object_id, revision, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, write.scope, write.sourceNature, body, write.processingState ?? 'captured', write.processingReason?.trim() ?? '',
      write.workspaceLane ?? null, write.pageRef ?? null, write.sessionRef ?? null, write.taskRef ?? null,
      write.linkedObjectType ?? null, write.linkedObjectId ?? null, timestamp, timestamp,
      write.processingState === 'archived' ? timestamp : null);
}

function transitionFreeNote(database: DatabaseSync, transition: FreeNoteTransitionWrite): number {
  const current = database.prepare('SELECT revision FROM knowledge_free_notes WHERE id = ?').get(transition.id) as { revision: number } | undefined;
  if (!current) fail('OBJECT_NOT_FOUND', `FreeNote ${transition.id} 不存在。`);
  if (current.revision !== transition.beforeRevision) fail('REVISION_CONFLICT', `FreeNote ${transition.id} revision 冲突（期望 ${transition.beforeRevision}，当前 ${current.revision}）。`);
  const timestamp = now();
  database.prepare(`UPDATE knowledge_free_notes
    SET processing_state = ?, processing_reason = ?, updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END, revision = revision + 1
    WHERE id = ?`)
    .run(transition.processingState, transition.processingReason?.trim() ?? '', timestamp, transition.processingState, timestamp, transition.id);
  return current.revision + 1;
}

// ============================================================
// 段处理器：KnowledgeEntity
// ============================================================

function writeEntity(database: DatabaseSync, meta: KnowledgeChangeSetMeta, write: EntityWrite): { id: string; revision: number } {
  assertScopeAllowed(database, write.scope);
  const canonicalKey = normalizeCanonicalKey(write.canonicalKey);
  const canonicalName = write.canonicalName?.trim();
  if (!canonicalKey || !canonicalName) fail('INVALID_INPUT', 'Entity 需要规范键与规范名称。');
  const timestamp = now();

  if (write.beforeRevision !== undefined) {
    const id = write.id ?? '';
    if (!id) fail('INVALID_INPUT', '更新 Entity 必须提供 id。');
    const current = database.prepare(
      'SELECT revision, scope FROM knowledge_entities WHERE id = ?'
    ).get(id) as { revision: number; scope: string } | undefined;
    if (!current) fail('OBJECT_NOT_FOUND', `Entity ${id} 不存在。`);
    if (current.scope !== write.scope) fail('SCOPE_NOT_REGISTERED', `Entity ${id} 属于 ${current.scope}，不能跨 scope 改写。`);
    if (current.revision !== write.beforeRevision) fail('REVISION_CONFLICT', `Entity ${id} revision 冲突（期望 ${write.beforeRevision}，当前 ${current.revision}）。`);
    const lifecycle = write.lifecycle ?? null;
    validateLifecycleTargets(database, 'knowledge_entities', ['merged_into_entity_id', 'superseded_by_entity_id'], id, lifecycle,
      { merged: write.mergedIntoEntityId ?? null, superseded: write.supersededByEntityId ?? null });
    const next = current.revision + 1;
    database.prepare(`UPDATE knowledge_entities SET
      canonical_name = ?, aliases_json = ?, external_identity_json = ?,
      lifecycle = CASE WHEN ? IS NULL THEN lifecycle ELSE ? END,
      merged_into_entity_id = CASE WHEN ? = 1 THEN ? ELSE merged_into_entity_id END,
      superseded_by_entity_id = CASE WHEN ? = 1 THEN ? ELSE superseded_by_entity_id END,
      updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END,
      revision = ?
      WHERE id = ?`)
      .run(canonicalName, JSON.stringify(write.aliases ?? []), JSON.stringify(write.externalIdentity ?? {}),
        lifecycle, lifecycle,
        write.mergedIntoEntityId !== undefined ? 1 : 0, write.mergedIntoEntityId ?? null,
        write.supersededByEntityId !== undefined ? 1 : 0, write.supersededByEntityId ?? null,
        timestamp, lifecycle, timestamp, next, id);
    return { id, revision: next };
  }

  if (write.lifecycle && write.lifecycle !== 'active') fail('LIFECYCLE_INVALID', '新建 Entity 只能以 active 生命周期创建。');
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_entities
    (id, scope, entity_type, canonical_key, canonical_name, aliases_json, external_identity_json, lifecycle, revision, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`)
    .run(id, write.scope, write.entityType, canonicalKey, canonicalName, JSON.stringify(write.aliases ?? []),
      JSON.stringify(write.externalIdentity ?? {}), timestamp, timestamp);
  return { id, revision: 1 };
}

// ============================================================
// 段处理器：KnowledgeNote + KnowledgeNoteVersion
// ============================================================

function writeNote(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, write: NoteWrite): { id: string; revision: number } {
  assertScopeAllowed(database, write.scope);
  const canonicalKey = normalizeCanonicalKey(write.canonicalKey);
  if (!canonicalKey) fail('INVALID_INPUT', 'Note 需要规范键。');
  validateNoteVersionWrite(database, write.kind, write.version);
  const timestamp = now();

  if (write.beforeRevision !== undefined) {
    const id = write.id ?? '';
    if (!id) fail('INVALID_INPUT', '追加 Note 版本必须提供 note id。');
    const current = database.prepare(
      'SELECT revision, scope, kind FROM knowledge_notes WHERE id = ?'
    ).get(id) as { revision: number; scope: string; kind: NoteKind } | undefined;
    if (!current) fail('OBJECT_NOT_FOUND', `KnowledgeNote ${id} 不存在。`);
    if (current.scope !== write.scope) fail('SCOPE_NOT_REGISTERED', `KnowledgeNote ${id} 属于 ${current.scope}，不能跨 scope 改写。`);
    if (current.revision !== write.beforeRevision) fail('REVISION_CONFLICT', `KnowledgeNote ${id} revision 冲突（期望 ${write.beforeRevision}，当前 ${current.revision}）。`);
    const lifecycle = write.lifecycle ?? null;
    validateLifecycleTargets(database, 'knowledge_notes', ['merged_into_note_id', 'superseded_by_note_id'], id, lifecycle,
      { merged: write.mergedIntoNoteId ?? null, superseded: write.supersededByNoteId ?? null });
    const versionId = insertNoteVersion(database, changeSetId, meta, id, write.kind, write.version);
    const next = current.revision + 1;
    database.prepare(`UPDATE knowledge_notes SET
      title = coalesce(?, title),
      lifecycle = CASE WHEN ? IS NULL THEN lifecycle ELSE ? END,
      merged_into_note_id = CASE WHEN ? = 1 THEN ? ELSE merged_into_note_id END,
      superseded_by_note_id = CASE WHEN ? = 1 THEN ? ELSE superseded_by_note_id END,
      current_version_id = ?, updated_at = ?,
      archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END,
      revision = ?
      WHERE id = ?`)
      .run(write.title?.trim() ?? null, lifecycle, lifecycle,
        write.mergedIntoNoteId !== undefined ? 1 : 0, write.mergedIntoNoteId ?? null,
        write.supersededByNoteId !== undefined ? 1 : 0, write.supersededByNoteId ?? null,
        versionId, timestamp, lifecycle, timestamp, next, id);
    return { id, revision: next };
  }

  if (write.lifecycle && write.lifecycle !== 'active') fail('LIFECYCLE_INVALID', '新建 KnowledgeNote 只能以 active 生命周期创建。');
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_notes
    (id, scope, kind, canonical_key, title, lifecycle, revision, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`)
    .run(id, write.scope, write.kind, canonicalKey, write.title?.trim() ?? write.version.title?.trim() ?? canonicalKey, timestamp, timestamp);
  const versionId = insertNoteVersion(database, changeSetId, meta, id, write.kind, write.version);
  database.prepare('UPDATE knowledge_notes SET current_version_id = ? WHERE id = ?').run(versionId, id);
  return { id, revision: 1 };
}

function validateNoteVersionWrite(database: DatabaseSync, kind: NoteKind, version: NoteVersionWrite): void {
  if (version.restoreFromVersionId) {
    // 恢复复制目标不可变版本内容，不要求新 statement/状态矩阵（契约 §15.2）
    if (!objectExists(database, 'knowledge_note_versions', version.restoreFromVersionId)) {
      fail('OBJECT_NOT_FOUND', `被恢复版本 ${version.restoreFromVersionId} 不存在。`);
    }
    return;
  }
  if (!version.statement?.trim()) fail('INVALID_INPUT', 'Note 版本必须包含核心 statement。');
  const allowed = NOTE_KIND_STATUSES[kind];
  if (!allowed.includes(version.conclusionStatus)) {
    fail('VERSION_STATUS_INVALID', `kind=${kind} 不允许 conclusionStatus=${version.conclusionStatus}。`);
  }
}

function insertNoteVersion(
  database: DatabaseSync,
  changeSetId: string,
  meta: KnowledgeChangeSetMeta,
  noteId: string,
  kind: NoteKind,
  version: NoteVersionWrite
): string {
  const versionNumber = nextVersionNumber(database, 'knowledge_note_versions', 'note_id', noteId);
  let fields: {
    title: string; statement: string; body: string; conclusionStatus: ConclusionStatus; evidenceLevel: EvidenceLevel;
    appliesTo: string; validFrom: string | null; validUntil: string | null;
    adoptedEntityIds: string; adoptedTopicIds: string; adoptedKnowledgeVersionIds: string;
    changeType: NoteVersionChangeType; changeReason: string; restoredFromVersionId: string | null;
  };
  if (version.restoreFromVersionId) {
    const target = database.prepare(
      'SELECT title, statement, body, conclusion_status AS conclusionStatus, evidence_level AS evidenceLevel, applies_to AS appliesTo, valid_from AS validFrom, valid_until AS validUntil, adopted_entity_ids_json AS adoptedEntityIds, adopted_topic_ids_json AS adoptedTopicIds, adopted_knowledge_version_ids_json AS adoptedKnowledgeVersionIds FROM knowledge_note_versions WHERE id = ?'
    ).get(version.restoreFromVersionId) as Record<string, unknown> | undefined;
    if (!target) fail('OBJECT_NOT_FOUND', `被恢复版本 ${version.restoreFromVersionId} 不存在。`);
    fields = {
      title: String(target.title), statement: String(target.statement), body: String(target.body),
      conclusionStatus: target.conclusionStatus as ConclusionStatus, evidenceLevel: target.evidenceLevel as EvidenceLevel,
      appliesTo: String(target.appliesTo), validFrom: (target.validFrom as string | null) ?? null, validUntil: (target.validUntil as string | null) ?? null,
      adoptedEntityIds: String(target.adoptedEntityIds), adoptedTopicIds: String(target.adoptedTopicIds),
      adoptedKnowledgeVersionIds: String(target.adoptedKnowledgeVersionIds),
      changeType: 'restored', changeReason: version.changeReason?.trim() || '恢复旧版本', restoredFromVersionId: version.restoreFromVersionId
    };
  } else {
    for (const entityId of version.adoptedEntityIds ?? []) {
      if (!objectExists(database, 'knowledge_entities', entityId)) fail('OBJECT_NOT_FOUND', `采用的 Entity ${entityId} 不存在。`);
    }
    for (const topicId of version.adoptedTopicIds ?? []) {
      if (!objectExists(database, 'topics', topicId)) fail('OBJECT_NOT_FOUND', `采用的 Topic ${topicId} 不存在。`);
    }
    for (const adoptedVersionId of version.adoptedKnowledgeVersionIds ?? []) {
      if (!objectExists(database, 'knowledge_note_versions', adoptedVersionId)) fail('OBJECT_NOT_FOUND', `采用的知识版本 ${adoptedVersionId} 不存在。`);
    }
    fields = {
      title: version.title?.trim() ?? version.statement.trim().slice(0, 120),
      statement: version.statement.trim(), body: version.body ?? '',
      conclusionStatus: version.conclusionStatus, evidenceLevel: version.evidenceLevel,
      appliesTo: version.appliesTo ?? '', validFrom: version.validFrom ?? null, validUntil: version.validUntil ?? null,
      adoptedEntityIds: JSON.stringify(version.adoptedEntityIds ?? []),
      adoptedTopicIds: JSON.stringify(version.adoptedTopicIds ?? []),
      adoptedKnowledgeVersionIds: JSON.stringify(version.adoptedKnowledgeVersionIds ?? []),
      changeType: version.changeType ?? 'created', changeReason: version.changeReason?.trim() ?? '', restoredFromVersionId: null
    };
  }
  const versionId = version.versionId ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_note_versions
    (id, note_id, version_number, title, statement, body, conclusion_status, evidence_level, applies_to, valid_from, valid_until,
     adopted_entity_ids_json, adopted_topic_ids_json, adopted_knowledge_version_ids_json, change_type, change_reason, creator_nature,
     change_set_id, restored_from_version_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(versionId, noteId, versionNumber, fields.title, fields.statement, fields.body, fields.conclusionStatus, fields.evidenceLevel,
      fields.appliesTo, fields.validFrom, fields.validUntil, fields.adoptedEntityIds, fields.adoptedTopicIds, fields.adoptedKnowledgeVersionIds,
      fields.changeType, fields.changeReason, meta.createdBy, changeSetId, fields.restoredFromVersionId, now());
  return versionId;
}

// ============================================================
// 段处理器：WikiPage + WikiPageVersion
// ============================================================

function writeWikiPage(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, write: WikiPageWrite): { id: string; revision: number } {
  assertScopeAllowed(database, write.scope);
  const canonicalKey = normalizeCanonicalKey(write.canonicalKey);
  if (!canonicalKey) fail('INVALID_INPUT', 'WikiPage 需要规范键。');
  if (write.version && write.markStaleInstead) fail('INVALID_INPUT', 'WikiPage 不能同时生成新版本与标记 stale。');
  validateWikiPageSubject(database, write);
  const timestamp = now();

  if (write.beforeRevision !== undefined) {
    const id = write.id ?? '';
    if (!id) fail('INVALID_INPUT', '更新 WikiPage 必须提供 id。');
    const current = database.prepare(
      'SELECT revision, scope FROM knowledge_wiki_pages WHERE id = ?'
    ).get(id) as { revision: number; scope: string } | undefined;
    if (!current) fail('OBJECT_NOT_FOUND', `WikiPage ${id} 不存在。`);
    if (current.scope !== write.scope) fail('SCOPE_NOT_REGISTERED', `WikiPage ${id} 属于 ${current.scope}，不能跨 scope 改写。`);
    if (current.revision !== write.beforeRevision) fail('REVISION_CONFLICT', `WikiPage ${id} revision 冲突（期望 ${write.beforeRevision}，当前 ${current.revision}）。`);
    const lifecycle = write.lifecycle ?? null;
    validateLifecycleTargets(database, 'knowledge_wiki_pages', ['merged_into_page_id', 'superseded_by_page_id'], id, lifecycle,
      { merged: write.mergedIntoPageId ?? null, superseded: write.supersededByPageId ?? null });
    let next = current.revision + 1;
    let newVersionId: string | null = null;
    if (write.version) {
      newVersionId = insertWikiPageVersion(database, changeSetId, meta, id, write);
    }
    const markCompileRuntime = write.compileStatus === 'compiling' || write.compileStatus === 'failed';
    database.prepare(`UPDATE knowledge_wiki_pages SET
      title = coalesce(?, title),
      lifecycle = CASE WHEN ? IS NULL THEN lifecycle ELSE ? END,
      merged_into_page_id = CASE WHEN ? = 1 THEN ? ELSE merged_into_page_id END,
      superseded_by_page_id = CASE WHEN ? = 1 THEN ? ELSE superseded_by_page_id END,
      current_version_id = CASE WHEN ? IS NULL THEN current_version_id ELSE ? END,
      compile_status = CASE WHEN ? = 1 THEN 'current' WHEN ? = 1 THEN 'stale' WHEN ? = 1 THEN ? ELSE compile_status END,
      compile_note = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN ? ELSE compile_note END,
      updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END,
      revision = ?
      WHERE id = ?`)
      .run(write.title?.trim() ?? null, lifecycle, lifecycle,
        write.mergedIntoPageId !== undefined ? 1 : 0, write.mergedIntoPageId ?? null,
        write.supersededByPageId !== undefined ? 1 : 0, write.supersededByPageId ?? null,
        newVersionId, newVersionId,
        write.version ? 1 : 0,
        write.markStaleInstead ? 1 : 0,
        markCompileRuntime ? 1 : 0, write.compileStatus ?? null,
        write.markStaleInstead ? 1 : 0, write.markStaleInstead?.reason ?? null,
        markCompileRuntime ? 1 : 0, write.compileNote ?? null,
        timestamp, lifecycle, timestamp, next, id);
    return { id, revision: next };
  }

  if (write.lifecycle && write.lifecycle !== 'active') fail('LIFECYCLE_INVALID', '新建 WikiPage 只能以 active 生命周期创建。');
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_wiki_pages
    (id, scope, page_type, canonical_key, title, subject_type, subject_id, lifecycle, compile_status, compile_note, revision, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'compiling', ?, 1, ?, ?, NULL)`)
    .run(id, write.scope, write.pageType, canonicalKey, write.title?.trim() ?? canonicalKey,
      write.subjectType ?? null, write.subjectId ?? null, write.compileNote ?? null, timestamp, timestamp);
  let revision = 1;
  if (write.version) {
    const versionId = insertWikiPageVersion(database, changeSetId, meta, id, write);
    database.prepare(`UPDATE knowledge_wiki_pages SET current_version_id = ?, compile_status = 'current' WHERE id = ?`).run(versionId, id);
  } else if (write.compileStatus && write.compileStatus !== 'compiling') {
    database.prepare(`UPDATE knowledge_wiki_pages SET compile_status = ?, compile_note = ?, revision = revision + 1 WHERE id = ?`)
      .run(write.compileStatus, write.compileNote ?? null, id);
    revision = 2;
  }
  return { id, revision };
}

function validateWikiPageSubject(database: DatabaseSync, write: WikiPageWrite): void {
  if (write.pageType === 'synthesis') {
    if (write.subjectType || write.subjectId) fail('INVALID_INPUT', 'synthesis 页面不能携带 Subject。');
    return;
  }
  if (!write.subjectType || write.subjectId === undefined) fail('INVALID_INPUT', `pageType=${write.pageType} 必须携带 Subject。`);
  const expected: Record<string, string> = { map: 'scope', topic: 'topic', entity: 'entity', method: 'method_note' };
  if (expected[write.pageType] !== write.subjectType) fail('INVALID_INPUT', `pageType=${write.pageType} 要求 subjectType=${expected[write.pageType]}。`);
  if (write.subjectType === 'scope') {
    assertScopeAllowed(database, write.subjectId);
  } else if (write.subjectType === 'entity') {
    if (!objectExists(database, 'knowledge_entities', write.subjectId)) fail('OBJECT_NOT_FOUND', `Subject Entity ${write.subjectId} 不存在。`);
  } else if (write.subjectType === 'topic') {
    if (!objectExists(database, 'topics', write.subjectId)) fail('OBJECT_NOT_FOUND', `Subject Topic ${write.subjectId} 不存在。`);
  } else if (write.subjectType === 'method_note') {
    if (!objectExists(database, 'knowledge_notes', write.subjectId)) fail('OBJECT_NOT_FOUND', `Subject Method Note ${write.subjectId} 不存在。`);
  }
}

function insertWikiPageVersion(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, pageId: string, write: WikiPageWrite): string {
  const version = write.version as WikiPageVersionWrite;
  const versionNumber = nextVersionNumber(database, 'knowledge_wiki_page_versions', 'page_id', pageId);
  let body: string;
  let title: string;
  let adoptedNoteVersionIds: string;
  let businessObjectRefs: string;
  let flags: string;
  let restoredFromVersionId: string | null;
  if (version.restoreFromVersionId) {
    const target = database.prepare(
      'SELECT title, body_json AS bodyJson, adopted_note_version_ids_json AS adopted, business_object_refs_json AS refs, flags_json AS flags FROM knowledge_wiki_page_versions WHERE id = ?'
    ).get(version.restoreFromVersionId) as Record<string, unknown> | undefined;
    if (!target) fail('OBJECT_NOT_FOUND', `被恢复 Wiki 版本 ${version.restoreFromVersionId} 不存在。`);
    title = String(target.title); body = String(target.bodyJson); adoptedNoteVersionIds = String(target.adopted);
    businessObjectRefs = String(target.refs); flags = String(target.flags);
    restoredFromVersionId = version.restoreFromVersionId;
  } else {
    title = version.title?.trim() ?? write.title?.trim() ?? write.canonicalKey;
    body = JSON.stringify(version.body ?? {});
    adoptedNoteVersionIds = JSON.stringify(version.adoptedNoteVersionIds ?? []);
    businessObjectRefs = JSON.stringify(version.businessObjectRefs ?? []);
    flags = JSON.stringify(version.flags ?? []);
    restoredFromVersionId = null;
    for (const adoptedId of version.adoptedNoteVersionIds ?? []) {
      if (!objectExists(database, 'knowledge_note_versions', adoptedId)) fail('OBJECT_NOT_FOUND', `页面采用的 Note 版本 ${adoptedId} 不存在。`);
    }
  }
  const versionId = version.versionId ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_wiki_page_versions
    (id, page_id, version_number, title, body_json, adopted_note_version_ids_json, business_object_refs_json, flags_json,
     change_summary, readable_diff, compile_reason, creator_nature, change_set_id, restored_from_version_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(versionId, pageId, versionNumber, title, body, adoptedNoteVersionIds, businessObjectRefs, flags,
      version.changeSummary?.trim() || (version.restoreFromVersionId ? '恢复旧版本' : '编译更新'),
      version.readableDiff ?? '', version.compileReason?.trim() || 'compiled', meta.createdBy, changeSetId, restoredFromVersionId, now());
  return versionId;
}

// ============================================================
// 段处理器：KnowledgeFormalRelation
// ============================================================

function insertRelation(database: DatabaseSync, changeSetId: string, write: RelationCreateWrite): void {
  assertScopeAllowed(database, write.scope);
  if (!RELATION_ENDPOINT_TYPES.includes(write.fromObjectType) || !RELATION_ENDPOINT_TYPES.includes(write.toObjectType)) {
    fail('RELATION_ENDPOINT_INVALID', `非法关系端点类型：${write.fromObjectType} → ${write.toObjectType}。`);
  }
  const registry = getRelationRegistryEntry(database, write.relationKey);
  if (!registry) fail('RELATION_NOT_IN_REGISTRY', `关系 ${write.relationKey} 不在注册词典。`);
  if (!registry.fromTypes.includes(write.fromObjectType) || !registry.toTypes.includes(write.toObjectType)) {
    fail('RELATION_ENDPOINT_INVALID', `关系 ${write.relationKey} 不允许端点 ${write.fromObjectType} → ${write.toObjectType}。`);
  }
  if (!objectExists(database, ENDPOINT_TABLES[write.fromObjectType], write.fromObjectId)) {
    fail('RELATION_ENDPOINT_NOT_FOUND', `起点 ${write.fromObjectType}:${write.fromObjectId} 不存在。`);
  }
  if (!objectExists(database, ENDPOINT_TABLES[write.toObjectType], write.toObjectId)) {
    fail('RELATION_ENDPOINT_NOT_FOUND', `终点 ${write.toObjectType}:${write.toObjectId} 不存在。`);
  }
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_formal_relations
    (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id, created_change_set_id, end_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`)
    .run(id, write.scope, write.relationKey, write.fromObjectType, write.fromObjectId, write.toObjectType, write.toObjectId, changeSetId, now());
}

function endRelation(database: DatabaseSync, changeSetId: string, write: RelationEndWrite): void {
  const current = database.prepare('SELECT id FROM knowledge_formal_relations WHERE id = ? AND ended_change_set_id IS NULL').get(write.id) as { id: string } | undefined;
  if (!current) fail('OBJECT_NOT_FOUND', `活动关系 ${write.id} 不存在。`);
  database.prepare('UPDATE knowledge_formal_relations SET ended_change_set_id = ?, end_reason = ?, ended_at = ? WHERE id = ?')
    .run(changeSetId, write.reason?.trim() ?? '', now(), write.id);
}

function getRelationRegistryEntry(database: DatabaseSync, relationKey: string): KnowledgeRelationRegistryRecord | null {
  const row = database.prepare(`SELECT relation_key AS relationKey, display_name AS displayName, description, directional,
    allows_duplicate AS allowsDuplicate, participates_in_judgment AS participatesInJudgment, in_creation_recall AS inCreationRecall,
    reverse_name AS reverseName, from_types_json AS fromTypes, to_types_json AS toTypes, extension
    FROM knowledge_relation_registry WHERE relation_key = ?`).get(relationKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRelationRegistryRow(row);
}

function insertExtensionRelation(database: DatabaseSync, registration: ExtensionRelationRegistration): void {
  if (!EXTENSION_RELATION_PATTERN.test(registration.relationKey)) {
    fail('RELATION_NOT_IN_REGISTRY', `扩展关系 key 必须形如 extension:<namespace>:<name>。`);
  }
  if (!registration.displayName?.trim() || !registration.reason?.trim()) fail('INVALID_INPUT', '扩展关系必须有人类可读名称与创建理由。');
  const fromTypes = [...new Set(registration.fromTypes)];
  const toTypes = [...new Set(registration.toTypes)];
  if (fromTypes.some((type) => !RELATION_ENDPOINT_TYPES.includes(type)) || toTypes.some((type) => !RELATION_ENDPOINT_TYPES.includes(type))) {
    fail('RELATION_ENDPOINT_INVALID', '扩展关系类型边界只能取注册端点类型。');
  }
  database.prepare(`INSERT INTO knowledge_relation_registry
    (relation_key, display_name, description, directional, allows_duplicate, participates_in_judgment, in_creation_recall, reverse_name, from_types_json, to_types_json, extension)
    VALUES (?, ?, ?, 1, 1, 0, 0, ?, ?, ?, 1)
    ON CONFLICT(relation_key) DO UPDATE SET display_name = excluded.display_name, description = excluded.description,
      from_types_json = excluded.from_types_json, to_types_json = excluded.to_types_json`)
    .run(registration.relationKey, registration.displayName.trim(), registration.description?.trim() ?? '', '',
      JSON.stringify(fromTypes), JSON.stringify(toTypes));
}

// ============================================================
// 段处理器：EvidenceLink
// ============================================================

function insertEvidenceLink(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, write: EvidenceLinkWrite): void {
  if (!objectExists(database, 'knowledge_note_versions', write.knowledgeNoteVersionId)) {
    fail('OBJECT_NOT_FOUND', `证据指向的 Note 版本 ${write.knowledgeNoteVersionId} 不存在。`);
  }
  if (!objectExists(database, EVIDENCE_OBJECT_TABLES[write.evidenceObjectType], write.evidenceObjectId)) {
    fail('OBJECT_NOT_FOUND', `证据对象 ${write.evidenceObjectType}:${write.evidenceObjectId} 不存在。`);
  }
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_evidence_links
    (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature, excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, write.knowledgeNoteVersionId, write.evidenceObjectType, write.evidenceObjectId, write.relation, write.sourceNature,
      write.excerpt ?? null, write.locator ?? null, write.observedAt ?? null, meta.createdBy, changeSetId, now());
}

// ============================================================
// 段处理器：KnowledgeAnnotation
// ============================================================

function insertAnnotation(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, write: AnnotationCreateWrite): void {
  assertScopeAllowed(database, write.scope);
  if (!objectExists(database, ANNOTATION_TARGET_TABLES[write.targetType], write.targetId)) {
    fail('OBJECT_NOT_FOUND', `批注目标 ${write.targetType}:${write.targetId} 不存在。`);
  }
  const id = write.id ?? randomUUID();
  const timestamp = now();
  database.prepare(`INSERT INTO knowledge_annotations
    (id, scope, target_type, target_id, quoted_text, prefix_context, suffix_context, anchor_json, intent, body,
     migration_state, processing_state, processed_change_set_id, user_identity, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'open', NULL, ?, ?, ?, ?)`)
    .run(id, write.scope, write.targetType, write.targetId, write.quotedText ?? '', write.prefixContext ?? '', write.suffixContext ?? '',
      JSON.stringify(write.anchor ?? {}), write.intent, write.body ?? '', write.userIdentity, meta.createdBy, timestamp, timestamp);
}

function transitionAnnotation(database: DatabaseSync, changeSetId: string, write: AnnotationTransitionWrite): void {
  const current = database.prepare('SELECT id FROM knowledge_annotations WHERE id = ?').get(write.id) as { id: string } | undefined;
  if (!current) fail('OBJECT_NOT_FOUND', `批注 ${write.id} 不存在。`);
  database.prepare(`UPDATE knowledge_annotations SET
    processing_state = CASE WHEN ? IS NULL THEN processing_state ELSE ? END,
    migration_state = CASE WHEN ? IS NULL THEN migration_state ELSE ? END,
    processed_change_set_id = CASE WHEN ? = 'processed' THEN ? ELSE processed_change_set_id END,
    updated_at = ? WHERE id = ?`)
    .run(write.processingState ?? null, write.processingState ?? null,
      write.migrationState ?? null, write.migrationState ?? null,
      write.processingState ?? null, write.processingState === 'processed' ? changeSetId : null,
      now(), write.id);
}

// ============================================================
// 段处理器：HealthIssue
// ============================================================

function insertHealthIssue(database: DatabaseSync, write: HealthIssueCreateWrite): void {
  assertScopeAllowed(database, write.scope);
  const id = write.id ?? randomUUID();
  const timestamp = now();
  database.prepare(`INSERT INTO knowledge_health_issues
    (id, scope, issue_type, affected_object_type, affected_object_id, severity, evidence_json, suggested_action, status,
     detected_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`)
    .run(id, write.scope, write.issueType, write.affectedObjectType ?? null, write.affectedObjectId ?? null, write.severity,
      JSON.stringify(write.evidence ?? {}), write.suggestedAction ?? '', timestamp, timestamp);
}

function updateHealthIssue(database: DatabaseSync, changeSetId: string, write: HealthIssueUpdateWrite): string {
  const current = database.prepare('SELECT revision, status FROM knowledge_health_issues WHERE id = ?').get(write.id) as { revision: number; status: HealthIssueStatus } | undefined;
  if (!current) fail('OBJECT_NOT_FOUND', `HealthIssue ${write.id} 不存在。`);
  if (current.revision !== write.beforeRevision) fail('REVISION_CONFLICT', `HealthIssue ${write.id} revision 冲突。`);
  const resolving = write.status === 'resolved' || write.status === 'accepted_risk' || write.status === 'false_positive';
  const timestamp = now();
  database.prepare(`UPDATE knowledge_health_issues SET
    status = ?, resolution_note = CASE WHEN ? IS NULL THEN resolution_note ELSE ? END,
    resolved_change_set_id = CASE WHEN ? = 1 THEN ? ELSE resolved_change_set_id END,
    resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END,
    updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(write.status, write.resolutionNote ?? null, write.resolutionNote ?? null,
      resolving ? 1 : 0, resolving ? changeSetId : null,
      resolving ? 1 : 0, timestamp, timestamp, write.id);
  return write.id;
}

// ============================================================
// 段处理器：Receipt + QueryArtifact
// ============================================================

function recordReceipt(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, write: ReceiptWrite): void {
  const existing = database.prepare('SELECT id FROM knowledge_update_receipts WHERE workspace_id = ? AND request_id = ?')
    .get(meta.workspaceId, write.requestId) as { id: string } | undefined;
  if (existing) return; // 幂等：同一触发 requestId 不生成第二条回执（契约 §24）
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_update_receipts
    (id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json, affected_topics_json, affected_entities_json,
     affected_methods_json, affected_syntheses_json, wiki_page_versions_json, impact_json, auto_resolutions_json, retained_disputes_json,
     failures_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, meta.workspaceId, changeSetId, write.triggerType, write.requestId, write.summary.trim(),
      JSON.stringify(write.counts ?? {}),
      JSON.stringify(write.affectedTopics ?? []), JSON.stringify(write.affectedEntities ?? []),
      JSON.stringify(write.affectedMethods ?? []), JSON.stringify(write.affectedSyntheses ?? []),
      JSON.stringify(write.wikiPageVersions ?? []), JSON.stringify(write.impact ?? {}),
      JSON.stringify(write.autoResolutions ?? []), JSON.stringify(write.retainedDisputes ?? []),
      JSON.stringify(write.failures ?? []), meta.createdBy, now());
}

function recordQueryArtifact(database: DatabaseSync, changeSetId: string, meta: KnowledgeChangeSetMeta, write: QueryArtifactWrite): void {
  const existing = database.prepare('SELECT id FROM knowledge_query_artifacts WHERE request_id = ?').get(write.requestId ?? meta.requestId) as { id: string } | undefined;
  if (existing) return; // 幂等：同一查询不重复产生处理记录（契约 §25）
  assertScopeAllowed(database, write.scope);
  const id = write.id ?? randomUUID();
  database.prepare(`INSERT INTO knowledge_query_artifacts
    (id, scope, workspace_id, request_id, question, answer_summary, read_wiki_version_ids_json, read_note_version_ids_json,
     read_evidence_ids_json, candidates_json, write_back_decision, skip_reason, change_set_id, receipt_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, write.scope, meta.workspaceId, write.requestId ?? meta.requestId, write.question.trim(), write.answerSummary ?? '',
      JSON.stringify(write.readWikiVersionIds ?? []), JSON.stringify(write.readNoteVersionIds ?? []),
      JSON.stringify(write.readEvidenceIds ?? []), JSON.stringify(write.candidates ?? []),
      write.writeBackDecision, write.skipReason ?? null, changeSetId, write.receiptId ?? null, meta.createdBy, now());
}

// ============================================================
// 生命周期 / 循环防护
// ============================================================

function validateLifecycleTargets(
  database: DatabaseSync,
  table: string,
  targetColumns: readonly string[],
  id: string,
  lifecycle: Lifecycle | null,
  targets: Readonly<{ merged: string | null; superseded: string | null }>
): void {
  if (lifecycle === 'merged') {
    if (!targets.merged) fail('LIFECYCLE_INVALID', 'lifecycle=merged 必须指向保留对象。');
    if (targets.merged === id) fail('LIFECYCLE_CYCLE', '对象不能合并到自身。');
    if (!objectExists(database, table, targets.merged)) fail('OBJECT_NOT_FOUND', `合并目标 ${targets.merged} 不存在。`);
    assertNoLifecycleCycle(database, table, targetColumns, id, targets.merged);
  } else if (lifecycle === 'superseded') {
    if (!targets.superseded) fail('LIFECYCLE_INVALID', 'lifecycle=superseded 必须指向替代目标。');
    if (targets.superseded === id) fail('LIFECYCLE_CYCLE', '对象不能替代自身。');
    if (!objectExists(database, table, targets.superseded)) fail('OBJECT_NOT_FOUND', `替代目标 ${targets.superseded} 不存在。`);
    assertNoLifecycleCycle(database, table, targetColumns, id, targets.superseded);
  } else if (lifecycle !== null && (targets.merged || targets.superseded)) {
    fail('LIFECYCLE_INVALID', `lifecycle=${lifecycle} 不允许携带合并/替代目标。`);
  }
}

function assertNoLifecycleCycle(
  database: DatabaseSync,
  table: string,
  targetColumns: readonly string[],
  id: string,
  targetId: string
): void {
  // 从 target 出发沿链走，若回到 id → 循环。有界深度 32（契约 §17.2）。
  let cursor = targetId;
  const visited = new Set<string>([id, targetId]);
  for (let depth = 0; depth < 32; depth += 1) {
    const row = database.prepare(`SELECT ${targetColumns[0]} AS a, ${targetColumns[1]} AS b FROM ${table} WHERE id = ?`).get(cursor) as { a: string | null; b: string | null } | undefined;
    if (!row || (row.a === null && row.b === null)) return;
    const next = row.a ?? row.b;
    if (next === null) return;
    if (next === id) fail('LIFECYCLE_CYCLE', `${table} 合并/替代链将形成循环。`, { id, targetId });
    if (visited.has(next)) fail('LIFECYCLE_CYCLE', `${table} 合并/替代链已存在循环。`, { id, cursor: next });
    visited.add(next);
    cursor = next;
  }
  fail('LIFECYCLE_CYCLE', `${table} 合并/替代链超过有界深度。`, { id, targetId });
}

/**
 * 默认业务读取解析 merged/superseded 链（契约 §17.1/§17.2）：
 * 返回解析信息（原始 id、解析后 id、跳数、是否终结）；循环/超深抛 LIFECYCLE_CYCLE。
 */
export function resolveKnowledgeEntity(database: DatabaseSync, entityId: string): KnowledgeResolution {
  return resolveLifecycleChain(database, 'knowledge_entities', ['merged_into_entity_id', 'superseded_by_entity_id'], entityId);
}

export function resolveKnowledgeNote(database: DatabaseSync, noteId: string): KnowledgeResolution {
  return resolveLifecycleChain(database, 'knowledge_notes', ['merged_into_note_id', 'superseded_by_note_id'], noteId);
}

export function resolveWikiPage(database: DatabaseSync, pageId: string): KnowledgeResolution {
  return resolveLifecycleChain(database, 'knowledge_wiki_pages', ['merged_into_page_id', 'superseded_by_page_id'], pageId);
}

function resolveLifecycleChain(database: DatabaseSync, table: string, targetColumns: readonly string[], id: string): KnowledgeResolution {
  const hops: string[] = [];
  let cursor = id;
  const visited = new Set<string>([id]);
  for (let depth = 0; depth < 32; depth += 1) {
    const row = database.prepare(`SELECT ${targetColumns[0]} AS a, ${targetColumns[1]} AS b FROM ${table} WHERE id = ?`).get(cursor) as { a: string | null; b: string | null } | undefined;
    if (!row) return Object.freeze({ originalId: id, resolvedId: cursor, hops: Object.freeze(hops), terminated: false });
    const next = row.a ?? row.b;
    if (next === null) return Object.freeze({ originalId: id, resolvedId: cursor, hops: Object.freeze(hops), terminated: false });
    if (visited.has(next)) fail('LIFECYCLE_CYCLE', `${table} 合并/替代链循环。`, { id, cursor: next });
    visited.add(next);
    hops.push(next);
    cursor = next;
  }
  fail('LIFECYCLE_CYCLE', `${table} 合并/替代链超过有界深度。`, { id });
}

// ============================================================
// 只读 API（有界）
// ============================================================

function mapChangeSetRow(row: Record<string, unknown>): KnowledgeChangeSetRecord {
  return Object.freeze({
    id: String(row.id), workspaceId: String(row.workspaceId), requestId: String(row.requestId),
    inputHash: String(row.inputHash), reason: String(row.reason), triggerSource: row.triggerSource as TriggerSource,
    resolutionMode: row.resolutionMode as ResolutionMode, createdBy: row.createdBy as CreatorNature, createdAt: String(row.createdAt)
  });
}

function mapFreeNoteRow(row: Record<string, unknown>): KnowledgeFreeNoteRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), sourceNature: row.sourceNature as FreeNoteSourceNature, body: String(row.body),
    processingState: row.processingState as FreeNoteProcessingState, processingReason: String(row.processingReason),
    workspaceLane: (row.workspaceLane as string | null) ?? null, pageRef: (row.pageRef as string | null) ?? null,
    sessionRef: (row.sessionRef as string | null) ?? null, taskRef: (row.taskRef as string | null) ?? null,
    linkedObjectType: (row.linkedObjectType as string | null) ?? null, linkedObjectId: (row.linkedObjectId as string | null) ?? null,
    revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string | null) ?? null
  });
}

function mapEntityRow(row: Record<string, unknown>): KnowledgeEntityRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), entityType: row.entityType as EntityType,
    canonicalKey: String(row.canonicalKey), canonicalName: String(row.canonicalName),
    aliases: parseJsonArray(String(row.aliasesJson), 'aliases') as readonly string[],
    externalIdentity: JSON.parse(String(row.externalIdentityJson)) as Readonly<Record<string, unknown>>,
    lifecycle: row.lifecycle as Lifecycle, mergedIntoEntityId: (row.mergedIntoEntityId as string | null) ?? null,
    supersededByEntityId: (row.supersededByEntityId as string | null) ?? null, revision: Number(row.revision),
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), archivedAt: (row.archivedAt as string | null) ?? null
  });
}

function mapNoteRow(row: Record<string, unknown>): KnowledgeNoteRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), kind: row.kind as NoteKind, canonicalKey: String(row.canonicalKey),
    title: String(row.title), lifecycle: row.lifecycle as Lifecycle, currentVersionId: (row.currentVersionId as string | null) ?? null,
    mergedIntoNoteId: (row.mergedIntoNoteId as string | null) ?? null, supersededByNoteId: (row.supersededByNoteId as string | null) ?? null,
    revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string | null) ?? null
  });
}

function mapNoteVersionRow(row: Record<string, unknown>): KnowledgeNoteVersionRecord {
  return Object.freeze({
    id: String(row.id), noteId: String(row.noteId), versionNumber: Number(row.versionNumber), title: String(row.title),
    statement: String(row.statement), body: String(row.body), conclusionStatus: row.conclusionStatus as ConclusionStatus,
    evidenceLevel: row.evidenceLevel as EvidenceLevel, appliesTo: String(row.appliesTo),
    validFrom: (row.validFrom as string | null) ?? null, validUntil: (row.validUntil as string | null) ?? null,
    adoptedEntityIds: parseJsonArray(String(row.adoptedEntityIds), 'adoptedEntityIds') as readonly string[],
    adoptedTopicIds: parseJsonArray(String(row.adoptedTopicIds), 'adoptedTopicIds') as readonly string[],
    adoptedKnowledgeVersionIds: parseJsonArray(String(row.adoptedKnowledgeVersionIds), 'adoptedKnowledgeVersionIds') as readonly string[],
    changeType: row.changeType as NoteVersionChangeType, changeReason: String(row.changeReason),
    creatorNature: row.creatorNature as CreatorNature, changeSetId: String(row.changeSetId),
    restoredFromVersionId: (row.restoredFromVersionId as string | null) ?? null, createdAt: String(row.createdAt)
  });
}

function mapWikiPageRow(row: Record<string, unknown>): KnowledgeWikiPageRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), pageType: row.pageType as WikiPageType, canonicalKey: String(row.canonicalKey),
    title: String(row.title), subjectType: (row.subjectType as string | null) ?? null, subjectId: (row.subjectId as string | null) ?? null,
    lifecycle: row.lifecycle as Lifecycle, currentVersionId: (row.currentVersionId as string | null) ?? null,
    mergedIntoPageId: (row.mergedIntoPageId as string | null) ?? null, supersededByPageId: (row.supersededByPageId as string | null) ?? null,
    compileStatus: row.compileStatus as CompileStatus, compileNote: (row.compileNote as string | null) ?? null,
    revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string | null) ?? null
  });
}

function mapWikiPageVersionRow(row: Record<string, unknown>): KnowledgeWikiPageVersionRecord {
  return Object.freeze({
    id: String(row.id), pageId: String(row.pageId), versionNumber: Number(row.versionNumber), title: String(row.title),
    body: JSON.parse(String(row.bodyJson)) as Readonly<Record<string, unknown>>,
    adoptedNoteVersionIds: parseJsonArray(String(row.adoptedNoteVersionIds), 'adoptedNoteVersionIds') as readonly string[],
    businessObjectRefs: parseJsonArray(String(row.businessObjectRefs), 'businessObjectRefs') as readonly string[],
    flags: parseJsonArray(String(row.flags), 'flags') as readonly string[],
    changeSummary: String(row.changeSummary), readableDiff: String(row.readableDiff), compileReason: String(row.compileReason),
    creatorNature: row.creatorNature as CreatorNature, changeSetId: String(row.changeSetId),
    restoredFromVersionId: (row.restoredFromVersionId as string | null) ?? null, createdAt: String(row.createdAt)
  });
}

function mapRelationRow(row: Record<string, unknown>): KnowledgeRelationRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), relationKey: String(row.relationKey),
    fromObjectType: String(row.fromObjectType), fromObjectId: String(row.fromObjectId),
    toObjectType: String(row.toObjectType), toObjectId: String(row.toObjectId),
    createdChangeSetId: String(row.createdChangeSetId), endedChangeSetId: (row.endedChangeSetId as string | null) ?? null,
    endReason: String(row.endReason), createdAt: String(row.createdAt), endedAt: (row.endedAt as string | null) ?? null
  });
}

function mapEvidenceLinkRow(row: Record<string, unknown>): KnowledgeEvidenceLinkRecord {
  return Object.freeze({
    id: String(row.id), knowledgeNoteVersionId: String(row.knowledgeNoteVersionId),
    evidenceObjectType: row.evidenceObjectType as EvidenceObjectType, evidenceObjectId: String(row.evidenceObjectId),
    relation: row.relation as EvidenceRelation, sourceNature: row.sourceNature as SourceNature,
    excerpt: (row.excerpt as string | null) ?? null, locator: (row.locator as string | null) ?? null,
    observedAt: (row.observedAt as string | null) ?? null, creatorNature: row.creatorNature as CreatorNature,
    changeSetId: String(row.changeSetId), createdAt: String(row.createdAt)
  });
}

function mapAnnotationRow(row: Record<string, unknown>): KnowledgeAnnotationRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), targetType: row.targetType as AnnotationTargetType, targetId: String(row.targetId),
    quotedText: String(row.quotedText), prefixContext: String(row.prefixContext), suffixContext: String(row.suffixContext),
    anchor: JSON.parse(String(row.anchorJson)) as Readonly<Record<string, unknown>>, intent: row.intent as AnnotationIntent,
    body: String(row.body), migrationState: row.migrationState as AnnotationMigrationState,
    processingState: row.processingState as AnnotationProcessingState,
    processedChangeSetId: (row.processedChangeSetId as string | null) ?? null, userIdentity: String(row.userIdentity),
    createdBy: row.createdBy as CreatorNature, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt)
  });
}

function mapReceiptRow(row: Record<string, unknown>): KnowledgeUpdateReceiptRecord {
  return Object.freeze({
    id: String(row.id), workspaceId: String(row.workspaceId), changeSetId: String(row.changeSetId),
    triggerType: row.triggerType as ReceiptTriggerType, requestId: String(row.requestId), summary: String(row.summary),
    counts: JSON.parse(String(row.countsJson)) as Readonly<Record<string, number>>,
    affectedTopics: parseJsonArray(String(row.affectedTopics), 'affectedTopics') as readonly string[],
    affectedEntities: parseJsonArray(String(row.affectedEntities), 'affectedEntities') as readonly string[],
    affectedMethods: parseJsonArray(String(row.affectedMethods), 'affectedMethods') as readonly string[],
    affectedSyntheses: parseJsonArray(String(row.affectedSyntheses), 'affectedSyntheses') as readonly string[],
    wikiPageVersions: parseJsonArray(String(row.wikiPageVersions), 'wikiPageVersions') as readonly string[],
    impact: JSON.parse(String(row.impactJson)) as Readonly<Record<string, unknown>>,
    autoResolutions: parseJsonArray(String(row.autoResolutions), 'autoResolutions') as readonly string[],
    retainedDisputes: parseJsonArray(String(row.retainedDisputes), 'retainedDisputes') as readonly string[],
    failures: parseJsonArray(String(row.failures), 'failures') as readonly string[],
    createdBy: row.createdBy as CreatorNature, createdAt: String(row.createdAt)
  });
}

function mapQueryArtifactRow(row: Record<string, unknown>): KnowledgeQueryArtifactRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), workspaceId: String(row.workspaceId), requestId: String(row.requestId),
    question: String(row.question), answerSummary: String(row.answerSummary),
    readWikiVersionIds: parseJsonArray(String(row.readWikiVersionIds), 'readWikiVersionIds') as readonly string[],
    readNoteVersionIds: parseJsonArray(String(row.readNoteVersionIds), 'readNoteVersionIds') as readonly string[],
    readEvidenceIds: parseJsonArray(String(row.readEvidenceIds), 'readEvidenceIds') as readonly string[],
    candidates: parseJsonArray(String(row.candidates), 'candidates') as readonly unknown[],
    writeBackDecision: row.writeBackDecision as QueryWriteBackDecision, skipReason: (row.skipReason as string | null) ?? null,
    changeSetId: (row.changeSetId as string | null) ?? null, receiptId: (row.receiptId as string | null) ?? null,
    createdBy: row.createdBy as CreatorNature, createdAt: String(row.createdAt)
  });
}

function mapHealthIssueRow(row: Record<string, unknown>): KnowledgeHealthIssueRecord {
  return Object.freeze({
    id: String(row.id), scope: String(row.scope), issueType: row.issueType as HealthIssueType,
    affectedObjectType: (row.affectedObjectType as string | null) ?? null, affectedObjectId: (row.affectedObjectId as string | null) ?? null,
    severity: row.severity as HealthIssueSeverity, evidence: JSON.parse(String(row.evidenceJson)) as Readonly<Record<string, unknown>>,
    suggestedAction: String(row.suggestedAction), status: row.status as HealthIssueStatus,
    resolutionNote: (row.resolutionNote as string | null) ?? null, resolvedChangeSetId: (row.resolvedChangeSetId as string | null) ?? null,
    detectedAt: String(row.detectedAt), updatedAt: String(row.updatedAt), resolvedAt: (row.resolvedAt as string | null) ?? null,
    revision: Number(row.revision)
  });
}

function mapRelationRegistryRow(row: Record<string, unknown>): KnowledgeRelationRegistryRecord {
  return Object.freeze({
    relationKey: String(row.relationKey), displayName: String(row.displayName), description: String(row.description),
    directional: Number(row.directional) === 1, allowsDuplicate: Number(row.allowsDuplicate) === 1,
    participatesInJudgment: Number(row.participatesInJudgment) === 1, inCreationRecall: Number(row.inCreationRecall) === 1,
    reverseName: String(row.reverseName),
    fromTypes: parseJsonArray(String(row.fromTypes), 'fromTypes') as readonly string[],
    toTypes: parseJsonArray(String(row.toTypes), 'toTypes') as readonly string[],
    extension: Number(row.extension) === 1
  });
}

const CHANGE_SET_SELECT = `SELECT id, workspace_id AS workspaceId, request_id AS requestId, input_hash AS inputHash,
  reason, trigger_source AS triggerSource, resolution_mode AS resolutionMode, created_by AS createdBy, created_at AS createdAt
  FROM knowledge_change_sets`;

export function getChangeSet(database: DatabaseSync, id: string): KnowledgeChangeSetRecord | null {
  const row = database.prepare(`${CHANGE_SET_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapChangeSetRow(row) : null;
}

export function listChangeSets(database: DatabaseSync, input: { limit?: number; offset?: number } = {}): { items: KnowledgeChangeSetRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const total = Number((database.prepare('SELECT count(*) AS count FROM knowledge_change_sets').get() as { count: number }).count);
  const items = (database.prepare(`${CHANGE_SET_SELECT} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[])
    .map(mapChangeSetRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function listKnowledgeFreeNotes(database: DatabaseSync, input: { scope?: string; processingState?: FreeNoteProcessingState; limit?: number; offset?: number } = {}): { items: KnowledgeFreeNoteRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.processingState) { where.push('processing_state = ?'); args.push(input.processingState); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_free_notes${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, source_nature AS sourceNature, body, processing_state AS processingState,
    processing_reason AS processingReason, workspace_lane AS workspaceLane, page_ref AS pageRef, session_ref AS sessionRef,
    task_ref AS taskRef, linked_object_type AS linkedObjectType, linked_object_id AS linkedObjectId, revision,
    created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_free_notes${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapFreeNoteRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getKnowledgeFreeNote(database: DatabaseSync, id: string): KnowledgeFreeNoteRecord | null {
  const row = database.prepare(`SELECT id, scope, source_nature AS sourceNature, body, processing_state AS processingState,
    processing_reason AS processingReason, workspace_lane AS workspaceLane, page_ref AS pageRef, session_ref AS sessionRef,
    task_ref AS taskRef, linked_object_type AS linkedObjectType, linked_object_id AS linkedObjectId, revision,
    created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_free_notes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapFreeNoteRow(row) : null;
}

export function listKnowledgeEntities(database: DatabaseSync, input: { scope?: string; entityType?: EntityType; lifecycle?: Lifecycle; query?: string; limit?: number; offset?: number } = {}): { items: KnowledgeEntityRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.entityType) { where.push('entity_type = ?'); args.push(input.entityType); }
  if (input.lifecycle) { where.push('lifecycle = ?'); args.push(input.lifecycle); }
  if (input.query?.trim()) {
    where.push('(canonical_name LIKE ? OR canonical_key LIKE ? OR aliases_json LIKE ?)');
    const pattern = `%${input.query.trim()}%`;
    args.push(pattern, pattern, pattern);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_entities${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, entity_type AS entityType, canonical_key AS canonicalKey, canonical_name AS canonicalName,
    aliases_json AS aliasesJson, external_identity_json AS externalIdentityJson, lifecycle,
    merged_into_entity_id AS mergedIntoEntityId, superseded_by_entity_id AS supersededByEntityId, revision,
    created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_entities${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapEntityRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getKnowledgeEntity(database: DatabaseSync, id: string): { entity: KnowledgeEntityRecord; resolution: KnowledgeResolution } | null {
  const row = database.prepare(`SELECT id, scope, entity_type AS entityType, canonical_key AS canonicalKey, canonical_name AS canonicalName,
    aliases_json AS aliasesJson, external_identity_json AS externalIdentityJson, lifecycle,
    merged_into_entity_id AS mergedIntoEntityId, superseded_by_entity_id AS supersededByEntityId, revision,
    created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_entities WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.freeze({ entity: mapEntityRow(row), resolution: resolveKnowledgeEntity(database, id) });
}

export function listKnowledgeNotes(database: DatabaseSync, input: { scope?: string; kind?: NoteKind; lifecycle?: Lifecycle; query?: string; limit?: number; offset?: number } = {}): { items: KnowledgeNoteRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.kind) { where.push('kind = ?'); args.push(input.kind); }
  if (input.lifecycle) { where.push('lifecycle = ?'); args.push(input.lifecycle); }
  if (input.query?.trim()) {
    where.push('(title LIKE ? OR canonical_key LIKE ?)');
    const pattern = `%${input.query.trim()}%`;
    args.push(pattern, pattern);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_notes${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, kind, canonical_key AS canonicalKey, title, lifecycle,
    current_version_id AS currentVersionId, merged_into_note_id AS mergedIntoNoteId, superseded_by_note_id AS supersededByNoteId,
    revision, created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_notes${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapNoteRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getKnowledgeNote(database: DatabaseSync, id: string): { note: KnowledgeNoteRecord; version: KnowledgeNoteVersionRecord | null; resolution: KnowledgeResolution } | null {
  const row = database.prepare(`SELECT id, scope, kind, canonical_key AS canonicalKey, title, lifecycle,
    current_version_id AS currentVersionId, merged_into_note_id AS mergedIntoNoteId, superseded_by_note_id AS supersededByNoteId,
    revision, created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_notes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const note = mapNoteRow(row);
  const version = note.currentVersionId ? getKnowledgeNoteVersion(database, note.currentVersionId) : null;
  return Object.freeze({ note, version, resolution: resolveKnowledgeNote(database, id) });
}

export function getKnowledgeNoteVersion(database: DatabaseSync, versionId: string): KnowledgeNoteVersionRecord | null {
  const row = database.prepare(`SELECT id, note_id AS noteId, version_number AS versionNumber, title, statement, body,
    conclusion_status AS conclusionStatus, evidence_level AS evidenceLevel, applies_to AS appliesTo, valid_from AS validFrom,
    valid_until AS validUntil, adopted_entity_ids_json AS adoptedEntityIds, adopted_topic_ids_json AS adoptedTopicIds,
    adopted_knowledge_version_ids_json AS adoptedKnowledgeVersionIds, change_type AS changeType, change_reason AS changeReason,
    creator_nature AS creatorNature, change_set_id AS changeSetId, restored_from_version_id AS restoredFromVersionId, created_at AS createdAt
    FROM knowledge_note_versions WHERE id = ?`).get(versionId) as Record<string, unknown> | undefined;
  return row ? mapNoteVersionRow(row) : null;
}

export function listKnowledgeNoteVersions(database: DatabaseSync, noteId: string, input: { limit?: number; offset?: number } = {}): { items: KnowledgeNoteVersionRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const total = Number((database.prepare('SELECT count(*) AS count FROM knowledge_note_versions WHERE note_id = ?').get(noteId) as { count: number }).count);
  const items = (database.prepare(`SELECT id, note_id AS noteId, version_number AS versionNumber, title, statement, body,
    conclusion_status AS conclusionStatus, evidence_level AS evidenceLevel, applies_to AS appliesTo, valid_from AS validFrom,
    valid_until AS validUntil, adopted_entity_ids_json AS adoptedEntityIds, adopted_topic_ids_json AS adoptedTopicIds,
    adopted_knowledge_version_ids_json AS adoptedKnowledgeVersionIds, change_type AS changeType, change_reason AS changeReason,
    creator_nature AS creatorNature, change_set_id AS changeSetId, restored_from_version_id AS restoredFromVersionId, created_at AS createdAt
    FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number DESC LIMIT ? OFFSET ?`).all(noteId, limit, offset) as Record<string, unknown>[])
    .map(mapNoteVersionRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function listWikiPages(database: DatabaseSync, input: { scope?: string; pageType?: WikiPageType; lifecycle?: Lifecycle; compileStatus?: CompileStatus; subjectType?: string; subjectId?: string; query?: string; limit?: number; offset?: number } = {}): { items: KnowledgeWikiPageRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.pageType) { where.push('page_type = ?'); args.push(input.pageType); }
  if (input.lifecycle) { where.push('lifecycle = ?'); args.push(input.lifecycle); }
  if (input.compileStatus) { where.push('compile_status = ?'); args.push(input.compileStatus); }
  if (input.subjectType) { where.push('subject_type = ?'); args.push(input.subjectType); }
  if (input.subjectId !== undefined) { where.push('subject_id = ?'); args.push(input.subjectId); }
  if (input.query?.trim()) {
    where.push('(title LIKE ? OR canonical_key LIKE ?)');
    const pattern = `%${input.query.trim()}%`;
    args.push(pattern, pattern);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_wiki_pages${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, page_type AS pageType, canonical_key AS canonicalKey, title, subject_type AS subjectType,
    subject_id AS subjectId, lifecycle, current_version_id AS currentVersionId, merged_into_page_id AS mergedIntoPageId,
    superseded_by_page_id AS supersededByPageId, compile_status AS compileStatus, compile_note AS compileNote, revision,
    created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_wiki_pages${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapWikiPageRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getWikiPage(database: DatabaseSync, id: string): { page: KnowledgeWikiPageRecord; version: KnowledgeWikiPageVersionRecord | null; resolution: KnowledgeResolution } | null {
  const row = database.prepare(`SELECT id, scope, page_type AS pageType, canonical_key AS canonicalKey, title, subject_type AS subjectType,
    subject_id AS subjectId, lifecycle, current_version_id AS currentVersionId, merged_into_page_id AS mergedIntoPageId,
    superseded_by_page_id AS supersededByPageId, compile_status AS compileStatus, compile_note AS compileNote, revision,
    created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
    FROM knowledge_wiki_pages WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const page = mapWikiPageRow(row);
  const version = page.currentVersionId ? getWikiPageVersion(database, page.currentVersionId) : null;
  return Object.freeze({ page, version, resolution: resolveWikiPage(database, id) });
}

export function getWikiPageVersion(database: DatabaseSync, versionId: string): KnowledgeWikiPageVersionRecord | null {
  const row = database.prepare(`SELECT id, page_id AS pageId, version_number AS versionNumber, title, body_json AS bodyJson,
    adopted_note_version_ids_json AS adoptedNoteVersionIds, business_object_refs_json AS businessObjectRefs, flags_json AS flags,
    change_summary AS changeSummary, readable_diff AS readableDiff, compile_reason AS compileReason,
    creator_nature AS creatorNature, change_set_id AS changeSetId, restored_from_version_id AS restoredFromVersionId, created_at AS createdAt
    FROM knowledge_wiki_page_versions WHERE id = ?`).get(versionId) as Record<string, unknown> | undefined;
  return row ? mapWikiPageVersionRow(row) : null;
}

export function listWikiPageVersions(database: DatabaseSync, pageId: string, input: { limit?: number; offset?: number } = {}): { items: KnowledgeWikiPageVersionRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const total = Number((database.prepare('SELECT count(*) AS count FROM knowledge_wiki_page_versions WHERE page_id = ?').get(pageId) as { count: number }).count);
  const items = (database.prepare(`SELECT id, page_id AS pageId, version_number AS versionNumber, title, body_json AS bodyJson,
    adopted_note_version_ids_json AS adoptedNoteVersionIds, business_object_refs_json AS businessObjectRefs, flags_json AS flags,
    change_summary AS changeSummary, readable_diff AS readableDiff, compile_reason AS compileReason,
    creator_nature AS creatorNature, change_set_id AS changeSetId, restored_from_version_id AS restoredFromVersionId, created_at AS createdAt
    FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number DESC LIMIT ? OFFSET ?`).all(pageId, limit, offset) as Record<string, unknown>[])
    .map(mapWikiPageVersionRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function listKnowledgeRelations(database: DatabaseSync, input: { scope?: string; relationKey?: string; fromObjectType?: string; fromObjectId?: string; limit?: number; offset?: number } = {}): { items: KnowledgeRelationRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.relationKey) { where.push('relation_key = ?'); args.push(input.relationKey); }
  if (input.fromObjectType) { where.push('from_object_type = ?'); args.push(input.fromObjectType); }
  if (input.fromObjectId) { where.push('from_object_id = ?'); args.push(input.fromObjectId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_formal_relations${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, relation_key AS relationKey, from_object_type AS fromObjectType, from_object_id AS fromObjectId,
    to_object_type AS toObjectType, to_object_id AS toObjectId, created_change_set_id AS createdChangeSetId,
    ended_change_set_id AS endedChangeSetId, end_reason AS endReason, created_at AS createdAt, ended_at AS endedAt
    FROM knowledge_formal_relations${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapRelationRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getKnowledgeRelation(database: DatabaseSync, id: string): KnowledgeRelationRecord | null {
  const row = database.prepare(`SELECT id, scope, relation_key AS relationKey, from_object_type AS fromObjectType, from_object_id AS fromObjectId,
    to_object_type AS toObjectType, to_object_id AS toObjectId, created_change_set_id AS createdChangeSetId,
    ended_change_set_id AS endedChangeSetId, end_reason AS endReason, created_at AS createdAt, ended_at AS endedAt
    FROM knowledge_formal_relations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapRelationRow(row) : null;
}

export function listKnowledgeEvidenceLinks(database: DatabaseSync, input: { noteVersionId?: string; evidenceObjectType?: EvidenceObjectType; evidenceObjectId?: string; relation?: EvidenceRelation; sourceNature?: SourceNature; limit?: number; offset?: number } = {}): { items: KnowledgeEvidenceLinkRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.noteVersionId) { where.push('knowledge_note_version_id = ?'); args.push(input.noteVersionId); }
  if (input.evidenceObjectType) { where.push('evidence_object_type = ?'); args.push(input.evidenceObjectType); }
  if (input.evidenceObjectId) { where.push('evidence_object_id = ?'); args.push(input.evidenceObjectId); }
  if (input.relation) { where.push('relation = ?'); args.push(input.relation); }
  if (input.sourceNature) { where.push('source_nature = ?'); args.push(input.sourceNature); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_evidence_links${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, knowledge_note_version_id AS knowledgeNoteVersionId, evidence_object_type AS evidenceObjectType,
    evidence_object_id AS evidenceObjectId, relation, source_nature AS sourceNature, excerpt, locator, observed_at AS observedAt,
    creator_nature AS creatorNature, change_set_id AS changeSetId, created_at AS createdAt
    FROM knowledge_evidence_links${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapEvidenceLinkRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function listKnowledgeAnnotations(database: DatabaseSync, input: { targetType?: AnnotationTargetType; targetId?: string; scope?: string; limit?: number; offset?: number } = {}): { items: KnowledgeAnnotationRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.targetType) { where.push('target_type = ?'); args.push(input.targetType); }
  if (input.targetId) { where.push('target_id = ?'); args.push(input.targetId); }
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_annotations${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, target_type AS targetType, target_id AS targetId, quoted_text AS quotedText,
    prefix_context AS prefixContext, suffix_context AS suffixContext, anchor_json AS anchorJson, intent, body,
    migration_state AS migrationState, processing_state AS processingState, processed_change_set_id AS processedChangeSetId,
    user_identity AS userIdentity, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
    FROM knowledge_annotations${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapAnnotationRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getKnowledgeAnnotation(database: DatabaseSync, id: string): KnowledgeAnnotationRecord | null {
  const row = database.prepare(`SELECT id, scope, target_type AS targetType, target_id AS targetId, quoted_text AS quotedText,
    prefix_context AS prefixContext, suffix_context AS suffixContext, anchor_json AS anchorJson, intent, body,
    migration_state AS migrationState, processing_state AS processingState, processed_change_set_id AS processedChangeSetId,
    user_identity AS userIdentity, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
    FROM knowledge_annotations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapAnnotationRow(row) : null;
}

export function getUpdateReceipt(database: DatabaseSync, id: string): KnowledgeUpdateReceiptRecord | null {
  const row = database.prepare(`SELECT id, workspace_id AS workspaceId, change_set_id AS changeSetId, trigger_type AS triggerType,
    request_id AS requestId, summary, counts_json AS countsJson, affected_topics_json AS affectedTopics,
    affected_entities_json AS affectedEntities, affected_methods_json AS affectedMethods, affected_syntheses_json AS affectedSyntheses,
    wiki_page_versions_json AS wikiPageVersions, impact_json AS impactJson, auto_resolutions_json AS autoResolutions,
    retained_disputes_json AS retainedDisputes, failures_json AS failures, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_update_receipts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapReceiptRow(row) : null;
}

export function getUpdateReceiptByRequest(database: DatabaseSync, workspaceId: string, requestId: string): KnowledgeUpdateReceiptRecord | null {
  const row = database.prepare(`SELECT id, workspace_id AS workspaceId, change_set_id AS changeSetId, trigger_type AS triggerType,
    request_id AS requestId, summary, counts_json AS countsJson, affected_topics_json AS affectedTopics,
    affected_entities_json AS affectedEntities, affected_methods_json AS affectedMethods, affected_syntheses_json AS affectedSyntheses,
    wiki_page_versions_json AS wikiPageVersions, impact_json AS impactJson, auto_resolutions_json AS autoResolutions,
    retained_disputes_json AS retainedDisputes, failures_json AS failures, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_update_receipts WHERE workspace_id = ? AND request_id = ?`).get(workspaceId, requestId) as Record<string, unknown> | undefined;
  return row ? mapReceiptRow(row) : null;
}

function getUpdateReceiptByChangeSet(database: DatabaseSync, changeSetId: string): KnowledgeUpdateReceiptRecord | null {
  const row = database.prepare(`SELECT id, workspace_id AS workspaceId, change_set_id AS changeSetId, trigger_type AS triggerType,
    request_id AS requestId, summary, counts_json AS countsJson, affected_topics_json AS affectedTopics,
    affected_entities_json AS affectedEntities, affected_methods_json AS affectedMethods, affected_syntheses_json AS affectedSyntheses,
    wiki_page_versions_json AS wikiPageVersions, impact_json AS impactJson, auto_resolutions_json AS autoResolutions,
    retained_disputes_json AS retainedDisputes, failures_json AS failures, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_update_receipts WHERE change_set_id = ? LIMIT 1`).get(changeSetId) as Record<string, unknown> | undefined;
  return row ? mapReceiptRow(row) : null;
}

export function listUpdateReceipts(database: DatabaseSync, input: { requestId?: string; triggerType?: ReceiptTriggerType; topicId?: string; sourceId?: string; limit?: number; offset?: number } = {}): { items: KnowledgeUpdateReceiptRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.requestId) { where.push('request_id = ?'); args.push(input.requestId); }
  if (input.triggerType) { where.push('trigger_type = ?'); args.push(input.triggerType); }
  if (input.topicId) { where.push("EXISTS (SELECT 1 FROM json_each(affected_topics_json) WHERE json_each.value = ?)"); args.push(input.topicId); }
  if (input.sourceId) { where.push("json_extract(impact_json, '$.sourceId') = ?"); args.push(input.sourceId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_update_receipts${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, workspace_id AS workspaceId, change_set_id AS changeSetId, trigger_type AS triggerType,
    request_id AS requestId, summary, counts_json AS countsJson, affected_topics_json AS affectedTopics,
    affected_entities_json AS affectedEntities, affected_methods_json AS affectedMethods, affected_syntheses_json AS affectedSyntheses,
    wiki_page_versions_json AS wikiPageVersions, impact_json AS impactJson, auto_resolutions_json AS autoResolutions,
    retained_disputes_json AS retainedDisputes, failures_json AS failures, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_update_receipts${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapReceiptRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getQueryArtifact(database: DatabaseSync, id: string): KnowledgeQueryArtifactRecord | null {
  const row = database.prepare(`SELECT id, scope, workspace_id AS workspaceId, request_id AS requestId, question,
    answer_summary AS answerSummary, read_wiki_version_ids_json AS readWikiVersionIds, read_note_version_ids_json AS readNoteVersionIds,
    read_evidence_ids_json AS readEvidenceIds, candidates_json AS candidates, write_back_decision AS writeBackDecision,
    skip_reason AS skipReason, change_set_id AS changeSetId, receipt_id AS receiptId, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_query_artifacts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapQueryArtifactRow(row) : null;
}

export function getQueryArtifactByRequest(database: DatabaseSync, requestId: string): KnowledgeQueryArtifactRecord | null {
  const row = database.prepare(`SELECT id, scope, workspace_id AS workspaceId, request_id AS requestId, question,
    answer_summary AS answerSummary, read_wiki_version_ids_json AS readWikiVersionIds, read_note_version_ids_json AS readNoteVersionIds,
    read_evidence_ids_json AS readEvidenceIds, candidates_json AS candidates, write_back_decision AS writeBackDecision,
    skip_reason AS skipReason, change_set_id AS changeSetId, receipt_id AS receiptId, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_query_artifacts WHERE request_id = ?`).get(requestId) as Record<string, unknown> | undefined;
  return row ? mapQueryArtifactRow(row) : null;
}

export function listQueryArtifacts(database: DatabaseSync, input: { scope?: string; limit?: number; offset?: number } = {}): { items: KnowledgeQueryArtifactRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where = input.scope ? ' WHERE scope = ?' : '';
  const args = input.scope ? [input.scope] : [];
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_query_artifacts${where}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, workspace_id AS workspaceId, request_id AS requestId, question,
    answer_summary AS answerSummary, read_wiki_version_ids_json AS readWikiVersionIds, read_note_version_ids_json AS readNoteVersionIds,
    read_evidence_ids_json AS readEvidenceIds, candidates_json AS candidates, write_back_decision AS writeBackDecision,
    skip_reason AS skipReason, change_set_id AS changeSetId, receipt_id AS receiptId, created_by AS createdBy, created_at AS createdAt
    FROM knowledge_query_artifacts${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapQueryArtifactRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function getHealthIssue(database: DatabaseSync, id: string): KnowledgeHealthIssueRecord | null {
  const row = database.prepare(`SELECT id, scope, issue_type AS issueType, affected_object_type AS affectedObjectType,
    affected_object_id AS affectedObjectId, severity, evidence_json AS evidenceJson, suggested_action AS suggestedAction, status,
    resolution_note AS resolutionNote, resolved_change_set_id AS resolvedChangeSetId, detected_at AS detectedAt,
    updated_at AS updatedAt, resolved_at AS resolvedAt, revision
    FROM knowledge_health_issues WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapHealthIssueRow(row) : null;
}

export function listHealthIssues(database: DatabaseSync, input: { scope?: string; issueType?: HealthIssueType; status?: HealthIssueStatus; severity?: HealthIssueSeverity; affectedObjectType?: string; affectedObjectId?: string; limit?: number; offset?: number } = {}): { items: KnowledgeHealthIssueRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.scope) { where.push('scope = ?'); args.push(input.scope); }
  if (input.issueType) { where.push('issue_type = ?'); args.push(input.issueType); }
  if (input.status) { where.push('status = ?'); args.push(input.status); }
  if (input.severity) { where.push('severity = ?'); args.push(input.severity); }
  if (input.affectedObjectType) { where.push('affected_object_type = ?'); args.push(input.affectedObjectType); }
  if (input.affectedObjectId) { where.push('affected_object_id = ?'); args.push(input.affectedObjectId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_health_issues${clause}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, issue_type AS issueType, affected_object_type AS affectedObjectType,
    affected_object_id AS affectedObjectId, severity, evidence_json AS evidenceJson, suggested_action AS suggestedAction, status,
    resolution_note AS resolutionNote, resolved_change_set_id AS resolvedChangeSetId, detected_at AS detectedAt,
    updated_at AS updatedAt, resolved_at AS resolvedAt, revision
    FROM knowledge_health_issues${clause} ORDER BY detected_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapHealthIssueRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function listRelationRegistry(database: DatabaseSync, input: { extension?: boolean; limit?: number; offset?: number } = {}): { items: KnowledgeRelationRegistryRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const { limit, offset } = bounds(input);
  const where = input.extension === undefined ? '' : ' WHERE extension = ?';
  const args = input.extension === undefined ? [] : [input.extension ? 1 : 0];
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_relation_registry${where}`).get(...args) as { count: number }).count);
  const items = (database.prepare(`SELECT relation_key AS relationKey, display_name AS displayName, description, directional,
    allows_duplicate AS allowsDuplicate, participates_in_judgment AS participatesInJudgment, in_creation_recall AS inCreationRecall,
    reverse_name AS reverseName, from_types_json AS fromTypes, to_types_json AS toTypes, extension
    FROM knowledge_relation_registry${where} ORDER BY extension, relation_key LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[])
    .map(mapRelationRegistryRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

// ============================================================
// 接线元数据（供 WireKnowledgeCommands / ExposeKnowledgeBoundary 消费，不在此接线）
// ============================================================

export const KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND = 'knowledge_flywheel.change_set_apply' as const;

/** WMB-5217：历史初始化命令（scheduler actor 经启动钩子派发；不暴露给 Agent，复用既有能力域）。 */
export const KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND = 'knowledge_flywheel.legacy_init' as const;

export const KNOWLEDGE_FLYWHEEL_COMMANDS: readonly string[] = Object.freeze([
  KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
  KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND
]);

/**
 * 能力注册元数据。默认推荐走最窄路径：把 KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND 追加到既有
 * agentGrantable 能力（cap.knowledge_curate）的 commands（TASKS 能力锁 2026-08-07 未立法新
 * 能力 id）。若 Owner 立法新能力 id，可用本元数据（agentGrantable + desk 绑定，符合 WMB-5182）。
 */
export const KNOWLEDGE_FLYWHEEL_CAPABILITY = Object.freeze({
  id: 'cap.knowledge_flywheel',
  displayName: '知识飞轮',
  description: '知识对象/版本原子 ChangeSet 维护（M1 共享契约与持久化；无编译器/UI）',
  commands: KNOWLEDGE_FLYWHEEL_COMMANDS,
  readProfiles: Object.freeze(['knowledge'] as const),
  defaultRoleBindings: Object.freeze({ desk: true }),
  grantKinds: Object.freeze({ task: Object.freeze([] as const), page: Object.freeze([] as const) }),
  precise: false,
  agentGrantable: true,
  owner: 'knowledge',
  since: '2026-08-12'
});

/** 只读 IPC 通道清单（主进程注册 + preload 暴露共用同一命名，避免第二套）。 */
export const KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS: readonly string[] = Object.freeze([
  'knowledge-flywheel:list-entities',
  'knowledge-flywheel:get-entity',
  'knowledge-flywheel:list-notes',
  'knowledge-flywheel:get-note',
  'knowledge-flywheel:get-note-version',
  'knowledge-flywheel:list-note-versions',
  'knowledge-flywheel:list-pages',
  'knowledge-flywheel:get-page',
  'knowledge-flywheel:get-page-version',
  'knowledge-flywheel:list-page-versions',
  'knowledge-flywheel:list-relations',
  'knowledge-flywheel:get-relation',
  'knowledge-flywheel:list-evidence',
  'knowledge-flywheel:list-annotations',
  'knowledge-flywheel:get-annotation',
  'knowledge-flywheel:list-free-notes',
  'knowledge-flywheel:get-free-note',
  'knowledge-flywheel:get-change-set',
  'knowledge-flywheel:list-change-sets',
  'knowledge-flywheel:get-receipt',
  'knowledge-flywheel:get-receipt-by-request',
  'knowledge-flywheel:list-receipts',
  'knowledge-flywheel:get-query-artifact',
  'knowledge-flywheel:get-query-artifact-by-request',
  'knowledge-flywheel:list-query-artifacts',
  'knowledge-flywheel:get-health-issue',
  'knowledge-flywheel:list-health-issues',
  'knowledge-flywheel:list-relation-registry',
  // WMB-5215 M6 usage 血缘只读通道（UsageStore owner 落通道，编译器只消费）
  'knowledge-flywheel:get-usage-package',
  'knowledge-flywheel:get-usage-package-by-request',
  'knowledge-flywheel:list-usage-packages',
  'knowledge-flywheel:get-usage-record',
  'knowledge-flywheel:list-usage-records'
]);

/** 写通道名（唯一写入口）。 */
export const KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL = 'knowledge-flywheel:change-set-apply' as const;
