// WMB-5210 M1：知识飞轮 preload ↔ main IPC 公共契约（本 worker：ExposeKnowledgeBoundary）。
// Design: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md + migration design M1。
// 定位：preload/renderer 侧的唯一通道清单与纯 JSON 边界类型（camelCase 记录，序列化友好）。
// 约束：
// - 不暴露内部 DB 或任意 SQL：通道集合固定为下方 35 个，无 execute/query/raw 通道；
// - preload 对入参只做透传，非法/缺失参数由 main boundary 拒绝（schema 真源 src/main/knowledge-flywheel.ts）；
// - 通道名已与 ImplementWmb5210 冻结 + WMB-5215 usage 追加 + WMB-5214 query 摘要追加
//   （store 导出的 canonical 数组，34 只读 + 1 写）；
//   主进程注册与 preload 均消费本文件常量，不得造第二套命名。
// - list* 统一返回分页信封 {items,total,limit,offset,hasMore}；get* 返回单对象 T|null。
// 主进程 store 类型真源在 src/main/knowledge-flywheel.ts，本文件字段与其保持对齐。

export const KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL = 'knowledge-flywheel:change-set-apply' as const;

/** 全部只读通道（冻结清单 34 个：M1 28 + WMB-5215 usage 5 + WMB-5214 query 摘要 1；主进程注册与 preload 均消费本常量）。 */
export const KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS = {
  listEntities: 'knowledge-flywheel:list-entities',
  getEntity: 'knowledge-flywheel:get-entity',
  listNotes: 'knowledge-flywheel:list-notes',
  getNote: 'knowledge-flywheel:get-note',
  getNoteVersion: 'knowledge-flywheel:get-note-version',
  listNoteVersions: 'knowledge-flywheel:list-note-versions',
  listPages: 'knowledge-flywheel:list-pages',
  getPage: 'knowledge-flywheel:get-page',
  getPageVersion: 'knowledge-flywheel:get-page-version',
  listPageVersions: 'knowledge-flywheel:list-page-versions',
  listRelations: 'knowledge-flywheel:list-relations',
  getRelation: 'knowledge-flywheel:get-relation',
  listEvidence: 'knowledge-flywheel:list-evidence',
  listAnnotations: 'knowledge-flywheel:list-annotations',
  getAnnotation: 'knowledge-flywheel:get-annotation',
  listFreeNotes: 'knowledge-flywheel:list-free-notes',
  getFreeNote: 'knowledge-flywheel:get-free-note',
  getChangeSet: 'knowledge-flywheel:get-change-set',
  listChangeSets: 'knowledge-flywheel:list-change-sets',
  getReceipt: 'knowledge-flywheel:get-receipt',
  getReceiptByRequest: 'knowledge-flywheel:get-receipt-by-request',
  listReceipts: 'knowledge-flywheel:list-receipts',
  getQueryArtifact: 'knowledge-flywheel:get-query-artifact',
  getQueryArtifactByRequest: 'knowledge-flywheel:get-query-artifact-by-request',
  getQueryWritebackSummary: 'knowledge-flywheel:get-query-writeback-summary',
  listQueryArtifacts: 'knowledge-flywheel:list-query-artifacts',
  getHealthIssue: 'knowledge-flywheel:get-health-issue',
  listHealthIssues: 'knowledge-flywheel:list-health-issues',
  listRelationRegistry: 'knowledge-flywheel:list-relation-registry',
  // WMB-5215 M6 创作知识调用血缘（UsageStore owner 落通道；编译器只消费不扩写）。
  getUsagePackage: 'knowledge-flywheel:get-usage-package',
  getUsagePackageByRequest: 'knowledge-flywheel:get-usage-package-by-request',
  listUsagePackages: 'knowledge-flywheel:list-usage-packages',
  getUsageRecord: 'knowledge-flywheel:get-usage-record',
  listUsageRecords: 'knowledge-flywheel:list-usage-records'
} as const;

export type KnowledgeFlywheelReadChannel = (typeof KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS)[keyof typeof KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS];

/** list* 读通道的统一分页信封（与主进程 read API 对齐）。 */
export type KnowledgeFlywheelListResult<T> = Readonly<{
  items: readonly T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}>;

// ===== 正式词典（与契约 §5–§26 / schema CHECK 对齐） =====

export type KnowledgeScope = 'global' | `lane:${string}`;

export type KnowledgeLifecycle = 'active' | 'archived' | 'superseded' | 'merged' | 'rejected';

export type KnowledgeCreatorNature = 'user' | 'pi' | 'background_agent' | 'system' | 'migration';

export type KnowledgeTriggerSource = 'ingest' | 'query' | 'lint' | 'creation' | 'review' | 'user' | 'migration';

export type KnowledgeResolutionMode =
  | 'replaced_current' | 'time_bounded' | 'scope_split' | 'kept_disputed' | 'insufficient' | 'manual_correction' | 'none';

export type KnowledgeChangeType =
  | 'created' | 'strengthened' | 'weakened' | 'contradicted' | 'qualified' | 'superseded'
  | 'merged' | 'promoted' | 'archived' | 'rejected' | 'restored' | 'recompiled';

export type KnowledgeConclusionStatus =
  | 'unverified' | 'supported' | 'disputed' | 'contradicted' | 'superseded' | 'not_applicable' | 'inference';

export type KnowledgeEvidenceLevel =
  | 'none' | 'single' | 'corroborated' | 'primary' | 'outcome_observed' | 'mixed' | 'insufficient';

export type KnowledgeNoteKind =
  | 'claim' | 'insight' | 'concept' | 'case' | 'method' | 'question' | 'creative_pattern';

export type KnowledgeEntityType =
  | 'person' | 'organization' | 'product' | 'platform' | 'policy' | 'institution' | 'place' | 'publication_channel' | 'other';

export type KnowledgeWikiPageType = 'map' | 'topic' | 'entity' | 'method' | 'synthesis';

export type KnowledgeCompileStatus = 'current' | 'stale' | 'compiling' | 'failed';

export type KnowledgeFreeNoteProcessingState = 'captured' | 'processed' | 'partially_processed' | 'ignored' | 'archived';

export type KnowledgeFreeNoteSourceNature =
  | 'user_quick_note' | 'page_note' | 'pi_dialogue' | 'user_approval_reason' | 'observation' | 'system_capture';

export type KnowledgeEvidenceRelation = 'supports' | 'contradicts' | 'qualifies' | 'derived_from';

export type KnowledgeEvidenceSourceNature =
  | 'primary_source' | 'secondary_source' | 'user_statement' | 'user_experience' | 'business_record'
  | 'performance_observation' | 'review' | 'derived_knowledge' | 'ai_inference';

export type KnowledgeEvidenceObjectType =
  | 'source' | 'free_note' | 'review' | 'publication' | 'metric_snapshot'
  | 'knowledge_note_version' | 'wiki_page_version' | 'content_version' | 'platform_version';

export type KnowledgeAnnotationTargetType =
  | 'free_note' | 'knowledge_entity' | 'knowledge_note_version' | 'wiki_page' | 'wiki_page_version' | 'knowledge_change_set';

export type KnowledgeAnnotationIntent =
  | 'correction' | 'qualify' | 'downgrade' | 'emphasize' | 'research_request' | 'merge' | 'split' | 'restore' | 'comment';

export type KnowledgeReceiptTriggerType = 'ingest' | 'query' | 'lint' | 'creation' | 'review' | 'migration';

export type KnowledgeQueryWriteBackDecision =
  | 'created' | 'updated' | 'skipped_repetition' | 'skipped_low_value' | 'skipped_transient' | 'no_write_back';

export type KnowledgeHealthIssueType =
  | 'stale_claim' | 'unresolved_contradiction' | 'unsupported_claim' | 'duplicate_entity' | 'duplicate_knowledge'
  | 'orphan_knowledge' | 'missing_wiki_page' | 'stale_wiki_page' | 'broken_reference' | 'unreturned_review'
  | 'underperforming_method' | 'overgeneralized_global' | 'unanswered_high_value_question';

export type KnowledgeHealthIssueStatus = 'open' | 'repairing' | 'resolved' | 'accepted_risk' | 'false_positive';

export type KnowledgeHealthSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

// ===== ChangeSet 写入边界（knowledge-flywheel:change-set-apply） =====

export type KnowledgeChangeSetApplyInput = Readonly<{
  /** 工作空间内幂等键；同 requestId 重放返回原结果，相同 requestId 配不同输入被拒绝。 */
  requestId: string;
  /** 人类可读的总体原因。 */
  reason: string;
  triggerSource: KnowledgeTriggerSource;
  resolutionMode?: KnowledgeResolutionMode;
  createdBy: KnowledgeCreatorNature;
  /**
   * 对象段（段形状真源：src/main/knowledge-flywheel.ts 的 KnowledgeChangeSetInput ——
   * freeNotes/freeNoteTransitions/entities/notes/relations/evidenceLinks/wikiPages/
   * annotations/healthIssues/receipts/queryArtifacts，至少一个非空段）。
   * 主进程 normalizeChangeSetApplyInput 只读本字段并按段逐项校验；恢复（restore）=
   * wikiPages[].version.restoreFromVersionId 追加新版本。
   */
  input: Readonly<Record<string, unknown>>;
}>;

export type KnowledgeChangeSetApplyResult = Readonly<{
  ok: boolean;
  changeSetId: string;
  /** 回执仅在 ingest/query/lint/creation/review 触发源下生成；user/migration 为 null。 */
  receipt: KnowledgeUpdateReceiptRecord | null;
  error: Readonly<{ code: string; message: string; details?: Readonly<Record<string, unknown>> }> | null;
}>;

// ===== 只读过滤（纯 JSON 有界过滤；非法/缺失字段由 main boundary 拒绝） =====

export type KnowledgeFlywheelReadFilter = Readonly<{
  scope?: KnowledgeScope;
  query?: string;
  limit?: number;
  offset?: number;
}>;

export type KnowledgeObjectIdRead = Readonly<{ id: string; scope?: KnowledgeScope }>;

export type KnowledgeRequestIdRead = Readonly<{ requestId: string }>;

export type KnowledgeNoteVersionIdRead = Readonly<{ id?: string; noteId?: string; versionNumber?: number; scope?: KnowledgeScope }>;

export type KnowledgeEntityReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  entityType?: KnowledgeEntityType;
  lifecycle?: KnowledgeLifecycle;
}>;

export type KnowledgeNoteReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  kind?: KnowledgeNoteKind;
  lifecycle?: KnowledgeLifecycle;
}>;

export type KnowledgeNoteVersionReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  noteId?: string;
  conclusionStatus?: KnowledgeConclusionStatus;
  evidenceLevel?: KnowledgeEvidenceLevel;
}>;

export type KnowledgeWikiPageReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  pageType?: KnowledgeWikiPageType;
  lifecycle?: KnowledgeLifecycle;
  compileStatus?: KnowledgeCompileStatus;
  /** WMB-5212：按正式 Subject 解析（topic → subject_type='topic' + subject_id=topicId）。 */
  subjectType?: 'scope' | 'topic' | 'entity' | 'method_note' | string;
  subjectId?: string;
}>;

export type KnowledgeWikiPageVersionReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  pageId?: string;
}>;

export type KnowledgeRelationReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  relationKey?: string;
  fromObjectType?: string;
  fromObjectId?: string;
  toObjectType?: string;
  toObjectId?: string;
  includeEnded?: boolean;
}>;

export type KnowledgeEvidenceReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  noteVersionId?: string;
  evidenceObjectType?: KnowledgeEvidenceObjectType;
  evidenceObjectId?: string;
  relation?: KnowledgeEvidenceRelation;
  sourceNature?: KnowledgeEvidenceSourceNature;
}>;

export type KnowledgeAnnotationReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  targetType?: KnowledgeAnnotationTargetType;
  targetId?: string;
  intent?: KnowledgeAnnotationIntent;
  processingState?: 'open' | 'processed';
}>;

export type KnowledgeFreeNoteReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  sourceNature?: KnowledgeFreeNoteSourceNature;
  processingState?: KnowledgeFreeNoteProcessingState;
}>;

export type KnowledgeChangeSetReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  requestId?: string;
  triggerSource?: KnowledgeTriggerSource;
  createdBy?: KnowledgeCreatorNature;
}>;

export type KnowledgeReceiptReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  requestId?: string;
  triggerType?: KnowledgeReceiptTriggerType;
  /** WMB-5212：回执按受影响 Topic（affectedTopics_json 包含 topicId）。 */
  topicId?: string;
  /** WMB-5212：回执按触发 Source（impact.sourceId）。 */
  sourceId?: string;
}>;

export type KnowledgeQueryArtifactReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  writeBackDecision?: KnowledgeQueryWriteBackDecision;
}>;

/**
 * WMB-5214：Query 写回 requestId 约定（单源，main hook 与 renderer 面板共用）。
 * `query:{conversationId}:{questionHash}` —— 同一会话同一问题 → 同键（幂等）；
 * 面板从 transcript 的会话 id + 用户消息文本即可推导同一键，无需后端回读。
 * 纯 JS 确定性散列（djb2/xor），无 node:crypto 依赖，shared 保持零依赖。
 */
function queryQuestionHash(value: string): string {
  let hash = 5381;
  const text = value ?? '';
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function knowledgeQueryWritebackRequestId(conversationId: string, question: string): string {
  const normalized = String(question ?? '').trim();
  return `query:${conversationId}:${queryQuestionHash(normalized)}`;
}

/** WMB-5214：Query 读面风险标记（复用 usage 风险种类；disputed/contradicted/stale/inference/unverified）。 */
export type KnowledgeQueryRiskFlag = Readonly<{
  kind: KnowledgeUsageRiskKind;
  versionKind: KnowledgeUsageVersionKind | null;
  versionId: string | null;
  note: string | null;
}>;

/** WMB-5214：每轮 Query 写回的可读摘要（面板消费；artifact 为 null 表示该轮无写回）。 */
export type KnowledgeQueryWritebackSummaryRecord = Readonly<{
  artifact: KnowledgeQueryArtifactRecord | null;
  riskFlags: readonly KnowledgeQueryRiskFlag[];
  receipt: KnowledgeUpdateReceiptRecord | null;
}>;

export type KnowledgeHealthIssueReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  issueType?: KnowledgeHealthIssueType;
  status?: KnowledgeHealthIssueStatus;
  severity?: KnowledgeHealthSeverity;
  affectedObjectType?: string;
  affectedObjectId?: string;
}>;

export type KnowledgeRelationRegistryReadFilter = Readonly<{
  participatesInJudgment?: boolean;
  inCreationRecall?: boolean;
  extension?: boolean;
}>;

// ===== 只读记录（camelCase JSON；字段与 schema 列对齐） =====

export type KnowledgeChangeSetRecord = Readonly<{
  id: string;
  workspaceId: string;
  requestId: string;
  inputHash: string;
  reason: string;
  triggerSource: KnowledgeTriggerSource;
  resolutionMode: KnowledgeResolutionMode;
  createdBy: KnowledgeCreatorNature;
  createdAt: string;
}>;

export type KnowledgeFreeNoteRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  sourceNature: KnowledgeFreeNoteSourceNature;
  body: string;
  processingState: KnowledgeFreeNoteProcessingState;
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
  scope: KnowledgeScope;
  entityType: KnowledgeEntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases: string[];
  externalIdentity: Readonly<Record<string, unknown>>;
  lifecycle: KnowledgeLifecycle;
  mergedIntoEntityId: string | null;
  supersededByEntityId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}>;

export type KnowledgeNoteRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  kind: KnowledgeNoteKind;
  canonicalKey: string;
  title: string;
  lifecycle: KnowledgeLifecycle;
  mergedIntoNoteId: string | null;
  supersededByNoteId: string | null;
  currentVersionId: string | null;
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
  conclusionStatus: KnowledgeConclusionStatus;
  evidenceLevel: KnowledgeEvidenceLevel;
  appliesTo: string;
  validFrom: string | null;
  validUntil: string | null;
  adoptedEntityIds: string[];
  adoptedTopicIds: string[];
  adoptedKnowledgeVersionIds: string[];
  changeType: KnowledgeChangeType;
  changeReason: string;
  creatorNature: KnowledgeCreatorNature;
  changeSetId: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}>;

export type KnowledgeWikiPageRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  pageType: KnowledgeWikiPageType;
  canonicalKey: string;
  title: string;
  subjectType: 'scope' | 'topic' | 'entity' | 'method_note' | null;
  subjectId: string | null;
  lifecycle: KnowledgeLifecycle;
  mergedIntoPageId: string | null;
  supersededByPageId: string | null;
  compileStatus: KnowledgeCompileStatus;
  compileNote: string | null;
  currentVersionId: string | null;
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
  body: unknown;
  adoptedNoteVersionIds: string[];
  businessObjectRefs: ReadonlyArray<Readonly<Record<string, unknown>>>;
  flags: string[];
  changeSummary: string;
  readableDiff: string;
  compileReason: string;
  creatorNature: KnowledgeCreatorNature;
  changeSetId: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}>;

export type KnowledgeRelationRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
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
  evidenceObjectType: KnowledgeEvidenceObjectType;
  evidenceObjectId: string;
  relation: KnowledgeEvidenceRelation;
  sourceNature: KnowledgeEvidenceSourceNature;
  excerpt: string | null;
  locator: string | null;
  observedAt: string | null;
  creatorNature: KnowledgeCreatorNature;
  changeSetId: string;
  createdAt: string;
}>;

export type KnowledgeAnnotationRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  targetType: KnowledgeAnnotationTargetType;
  targetId: string;
  quotedText: string;
  prefixContext: string;
  suffixContext: string;
  anchor: Readonly<Record<string, unknown>>;
  intent: KnowledgeAnnotationIntent;
  body: string;
  migrationState: 'none' | 'migrated' | 'deleted' | 'ambiguous' | 'user_removed';
  processingState: 'open' | 'processed';
  processedChangeSetId: string | null;
  userIdentity: string;
  createdBy: KnowledgeCreatorNature;
  createdAt: string;
  updatedAt: string;
}>;

export type KnowledgeUpdateReceiptRecord = Readonly<{
  id: string;
  workspaceId: string;
  changeSetId: string;
  triggerType: KnowledgeReceiptTriggerType;
  requestId: string;
  summary: string;
  counts: Readonly<Record<string, number>>;
  affectedTopics: readonly string[];
  affectedEntities: ReadonlyArray<Readonly<Record<string, unknown>>>;
  affectedMethods: ReadonlyArray<Readonly<Record<string, unknown>>>;
  affectedSyntheses: ReadonlyArray<Readonly<Record<string, unknown>>>;
  wikiPageVersions: ReadonlyArray<Readonly<Record<string, unknown>>>;
  impact: Readonly<Record<string, unknown>>;
  autoResolutions: ReadonlyArray<Readonly<Record<string, unknown>>>;
  retainedDisputes: ReadonlyArray<Readonly<Record<string, unknown>>>;
  failures: ReadonlyArray<Readonly<Record<string, unknown>>>;
  createdBy: KnowledgeCreatorNature;
  createdAt: string;
}>;

export type KnowledgeQueryArtifactRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  workspaceId: string;
  requestId: string;
  question: string;
  answerSummary: string;
  readWikiVersionIds: string[];
  readNoteVersionIds: string[];
  readEvidenceIds: string[];
  candidates: ReadonlyArray<Readonly<Record<string, unknown>>>;
  writeBackDecision: KnowledgeQueryWriteBackDecision;
  skipReason: string | null;
  changeSetId: string | null;
  receiptId: string | null;
  createdBy: KnowledgeCreatorNature;
  createdAt: string;
}>;

export type KnowledgeHealthIssueRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  issueType: KnowledgeHealthIssueType;
  affectedObjectType: string | null;
  affectedObjectId: string | null;
  severity: KnowledgeHealthSeverity;
  evidence: Readonly<Record<string, unknown>>;
  suggestedAction: string;
  status: KnowledgeHealthIssueStatus;
  resolutionNote: string | null;
  resolvedChangeSetId: string | null;
  detectedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  revision: number;
}>;

export type KnowledgeRelationRegistryEntry = Readonly<{
  relationKey: string;
  displayName: string;
  description: string;
  directional: boolean;
  allowsDuplicate: boolean;
  participatesInJudgment: boolean;
  inCreationRecall: boolean;
  reverseName: string;
  fromTypes: string[];
  toTypes: string[];
  extension: boolean;
}>;

// ===== WMB-5215 M6 创作知识调用血缘（UsageStore owner；主进程类型真源 src/main/knowledge-usage.ts） =====
// 不可变 Usage Package/Record：固定 Wiki/Note/Evidence 版本引用，不复制正式知识；
// used/consulted 由 usageKind 派生（六种用途 = actual used；'consulted' = 仅读取）。

export type KnowledgeUsageStage =
  | 'source_judgment' | 'topic_proposal' | 'creative_brief'
  | 'core_draft' | 'platform_adaptation' | 'review';

export type KnowledgeUsageKind =
  | 'quoted' | 'paraphrased' | 'reasoning_basis' | 'structure_pattern'
  | 'avoided_due_to_risk' | 'rejected_by_user' | 'consulted';

export type KnowledgeUsageRiskKind =
  | 'disputed' | 'contradicted' | 'inference' | 'stale' | 'unverified' | 'scope_mismatch';

export type KnowledgeUsageCutReasonKind =
  | 'budget' | 'low_relevance' | 'superseded' | 'duplicate' | 'scope_mismatch' | 'stale';

export type KnowledgeUsageOutputType =
  | 'source_item' | 'topic_proposal' | 'creative_brief' | 'plan_item' | 'content_version' | 'platform_version' | 'review' | 'publication';

export type KnowledgeUsageVersionKind = 'note' | 'wiki_page';

export type KnowledgeUsageRiskFlag = Readonly<{
  kind: KnowledgeUsageRiskKind;
  versionKind?: KnowledgeUsageVersionKind;
  versionId?: string;
  note?: string;
}>;

export type KnowledgeUsageCutReason = Readonly<{
  kind: KnowledgeUsageCutReasonKind;
  versionKind?: KnowledgeUsageVersionKind;
  versionId?: string;
  reason?: string;
}>;

export type KnowledgeUsagePackageRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  workspaceId: string;
  stage: KnowledgeUsageStage;
  requestId: string;
  inputHash: string;
  topicId: string | null;
  sourceIds: string[];
  planItemId: string | null;
  projectId: string | null;
  platform: string | null;
  audience: string;
  format: string;
  wikiPageVersionIds: string[];
  noteVersionIds: string[];
  evidenceIds: string[];
  freeNoteIds: string[];
  riskFlags: ReadonlyArray<Readonly<KnowledgeUsageRiskFlagRecord>>;
  selectionReasons: string[];
  cutReasons: ReadonlyArray<Readonly<KnowledgeUsageCutReasonRecord>>;
  compilerSchemaVersion: string;
  createdBy: KnowledgeCreatorNature;
  createdAt: string;
}>;

export type KnowledgeUsageRiskFlagRecord = Readonly<{
  kind: KnowledgeUsageRiskKind;
  versionKind: KnowledgeUsageVersionKind | null;
  versionId: string | null;
  note: string | null;
}>;

export type KnowledgeUsageCutReasonRecord = Readonly<{
  kind: KnowledgeUsageCutReasonKind;
  versionKind: KnowledgeUsageVersionKind | null;
  versionId: string | null;
  reason: string | null;
}>;

export type KnowledgeUsageRecordRecord = Readonly<{
  id: string;
  scope: KnowledgeScope;
  workspaceId: string;
  packageId: string;
  outputObjectType: KnowledgeUsageOutputType;
  outputObjectId: string;
  /** 固定知识版本 id（note_version_id XOR wiki_page_version_id 之一）。 */
  knowledgeVersionId: string;
  knowledgeVersionKind: KnowledgeUsageVersionKind;
  usageKind: KnowledgeUsageKind;
  /** true = actual used（六种用途之一）；false = 仅 consulted。 */
  used: boolean;
  locator: string | null;
  reason: string;
  actor: string;
  evidenceId: string | null;
  createdBy: KnowledgeCreatorNature;
  createdAt: string;
}>;

export type KnowledgeUsagePackageReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  stage?: KnowledgeUsageStage;
  topicId?: string;
  projectId?: string;
}>;

export type KnowledgeUsageRecordReadFilter = KnowledgeFlywheelReadFilter & Readonly<{
  packageId?: string;
  outputObjectType?: KnowledgeUsageOutputType;
  outputObjectId?: string;
  used?: boolean;
  /** WMB-5212：创作影响按固定 Wiki 版本（wiki_page_version_id）。 */
  wikiPageVersionId?: string;
  /** WMB-5212：创作影响按固定 Note 版本（note_version_id）。 */
  noteVersionId?: string;
}>;
