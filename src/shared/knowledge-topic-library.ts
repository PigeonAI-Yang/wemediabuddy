// WMB-5212 M3：主题与资料库后端读模型共享契约（本 worker：ImplementKnowledgeSurfaceBackend）。
// Design: docs/spark/2026-08-12-wmb-existing-knowledge-surfaces-retrofit-design.md §3–§4、§6–§10。
// 定位：LibraryTopicsView（Topic Wiki 详情）与 LibraryView（Source 详情/Inbox/Health）的
// 单一后端投影契约。全部为 v56/v57 既有表 + 既有 dossier 的组合只读投影，不新建身份/表。
// 约束：
// - 通道名固定为 'knowledge:topic-wiki-detail' / 'knowledge:source-knowledge-detail' /
//   'knowledge:deep-link'（业务通道，与 canvas 投影同一模式）；list* 过滤走既有 flywheel 通道；
// - 分页统一信封 {items,total,limit,offset,hasMore}；get* 返回单对象或 null；
// - body 由主进程解析为 TopicWikiBody（编译器正文 shape，见 knowledge-compiler.ts），渲染端零解析；
// - 正式对象 ID（topic.id / source.id / wiki page id）与画布/健康/回执投影同一 ID 空间。

import type {
  KnowledgeChangeType,
  KnowledgeCompileStatus,
  KnowledgeConclusionStatus,
  KnowledgeEvidenceLevel,
  KnowledgeEvidenceLinkRecord,
  KnowledgeFlywheelListResult,
  KnowledgeHealthIssueRecord,
  KnowledgeNoteKind,
  KnowledgeUpdateReceiptRecord,
  KnowledgeUsageRecordRecord,
  KnowledgeWikiPageRecord,
  KnowledgeWikiPageVersionRecord
} from './knowledge-flywheel.ts';

// ===== Topic Wiki 正文（编译器 knowledge-compiler.ts 冻结 shape；主进程解析） =====

export type TopicWikiKeyConclusion = Readonly<{
  noteId: string;
  statement: string;
  conclusionStatus: KnowledgeConclusionStatus;
  evidenceLevel: KnowledgeEvidenceLevel;
  appliesTo: string | null;
  changeType: KnowledgeChangeType;
  kind: KnowledgeNoteKind;
}>;

export type TopicWikiRecentChange = Readonly<{
  noteId: string;
  versionId: string;
  canonicalKey: string;
  changeType: KnowledgeChangeType;
}>;

export type TopicWikiBody = Readonly<{
  kind: 'topic-wiki';
  title: string;
  summary: string;
  asOf: string;
  scope: string;
  topicId: string;
  compiledSourceIds: readonly string[];
  sourceRevision: number;
  keyConclusions: readonly TopicWikiKeyConclusion[];
  retainedDisputes: readonly TopicWikiKeyConclusion[];
  pendingQuestions: readonly string[];
  recentChanges: readonly TopicWikiRecentChange[];
  versionCount: number;
}>;

/** 证据条目：EvidenceLink + 所支持固定 Note 版本的一句话（渲染端免二次查询）。 */
export type TopicEvidenceEntry = KnowledgeEvidenceLinkRecord & Readonly<{
  noteStatement: string;
  noteConclusionStatus: KnowledgeConclusionStatus;
}>;

/** Topic Wiki 详情风险汇总（stale/failed/disputed/inference 读回）。 */
export type TopicWikiRisks = Readonly<{
  disputed: number;
  contradicted: number;
  inference: number;
  /** compile_status 显式 stale/failed（页面级）。 */
  stale: boolean;
  failed: boolean;
}>;

export type TopicWikiDossierCounts = Readonly<{
  sources: number;
  judgments: number;
  audience_demands: number;
  counter_evidence: number;
  content_history: number;
  metrics: number;
  reviews: number;
  method_findings: number;
}>;

export type TopicWikiDetailInput = Readonly<{
  /** 既有业务 Topic ID（topics.id）；同一 ID 全链路一致。 */
  topicId: string;
  versionsLimit?: number;
  receiptsLimit?: number;
  evidenceLimit?: number;
  questionsLimit?: number;
  healthLimit?: number;
  usageLimit?: number;
}>;

export type TopicWikiDetail = Readonly<{
  topicId: string;
  /** 既有业务 Topic 行（不存在/已归档 → null）。 */
  topic: Readonly<{
    id: string;
    title: string;
    canonicalKey: string | null;
    kind: string | null;
    summary: string | null;
    status: string;
    firstSeenAt: string;
    lastSeenAt: string;
    revision: number;
    sourceCount: number;
    opportunityCount: number;
    contentCount: number;
    publicationCount: number;
  }> | null;
  wiki: Readonly<{
    page: KnowledgeWikiPageRecord | null;
    current: KnowledgeWikiPageVersionRecord | null;
    /** 编译器正文（已解析；无版本 → null）。 */
    body: TopicWikiBody | null;
    compileStatus: KnowledgeCompileStatus | null;
    compileNote: string | null;
  }> | null;
  /** 版本时间线（有界，version_number DESC）。 */
  versions: KnowledgeFlywheelListResult<KnowledgeWikiPageVersionRecord>;
  /** 最近变化：回执按 affectedTopics 命中（有界，created_at DESC）。 */
  receipts: KnowledgeFlywheelListResult<KnowledgeUpdateReceiptRecord>;
  /** 当前认识采纳 Note 版本上挂的证据（有界；noteVersionId 命中 adoptedNoteVersionIds）。 */
  evidence: KnowledgeFlywheelListResult<TopicEvidenceEntry>;
  /** 待研究：当前 Wiki 正文 pendingQuestions（有界）。 */
  questions: readonly string[];
  /** 创作影响：Usage Record 固定引用当前 Wiki 版本或采纳 Note 版本（有界，created_at DESC）。 */
  creationImpact: KnowledgeFlywheelListResult<KnowledgeUsageRecordRecord>;
  /** 健康：受影响对象为本 Topic 或本 Topic Wiki 页面（有界）。 */
  healthIssues: KnowledgeFlywheelListResult<KnowledgeHealthIssueRecord>;
  /** 既有八类 dossier 计数（getKnowledgeTopicDossier 同源口径；Topic 不存在 → null）。 */
  dossierCounts: TopicWikiDossierCounts | null;
  risks: TopicWikiRisks;
}>;

// ===== Source 详情（资料库投影） =====

/** 证据条目：Source 贡献的证据链 + 被支持 Note 版本一句话。 */
export type SourceEvidenceEntry = KnowledgeEvidenceLinkRecord & Readonly<{
  noteStatement: string;
  noteConclusionStatus: KnowledgeConclusionStatus;
}>;

export type SourceKnowledgeDetailInput = Readonly<{
  sourceId: string;
  evidenceLimit?: number;
  receiptLimit?: number;
  healthLimit?: number;
  annotationLimit?: number;
}>;

export type SourceKnowledgeDetail = Readonly<{
  sourceId: string;
  /** source_items 既有行（不存在/已移出 → null）。 */
  source: Readonly<{
    id: string;
    title: string;
    originalUrl: string | null;
    summary: string | null;
    priority: number | null;
    verificationStatus: string;
    managementStatus: string;
    revision: number;
    collectedAt: string | null;
    updatedAt: string | null;
  }> | null;
  /** 关联 Topic（topic_source_links 既有关联）。 */
  topics: ReadonlyArray<Readonly<{ id: string; title: string; status: string }>>;
  /** 证据贡献：evidence_object_type='source' AND evidence_object_id=sourceId（有界）。 */
  evidence: KnowledgeFlywheelListResult<SourceEvidenceEntry>;
  /** Ingest/重编译回执：impact.sourceId 命中（有界，created_at DESC）。 */
  receipts: KnowledgeFlywheelListResult<KnowledgeUpdateReceiptRecord>;
  /** 健康：affectedObjectType='source' AND affectedObjectId=sourceId（有界）。 */
  healthIssues: KnowledgeFlywheelListResult<KnowledgeHealthIssueRecord>;
  /** 批注：本 Source 证据链涉及的固定 Note 版本上的用户批注（有界）。 */
  annotations: KnowledgeFlywheelListResult<Readonly<{
    id: string;
    targetType: string;
    targetId: string;
    intent: string;
    body: string;
    processingState: string;
    createdBy: string;
    createdAt: string;
  }>>;
}>;

// ===== 深链 payload（准确 topic/source 跳转；与画布节点深链同一对象 ID 空间） =====

export type KnowledgeDeepLinkInput = Readonly<{
  objectType: string;
  objectId: string;
}>;

export type KnowledgeDeepLinkPayload = Readonly<{
  objectType: string;
  objectId: string;
  title: string;
  route: 'topic' | 'library' | 'object';
  targetType: 'topic_wiki' | 'source' | 'knowledge_object';
  /** 实际跳转目标 ID：topic → wiki page id（无编译页 → topicId，hasWiki=false）；source → sourceId；知识对象 → 对象 id。 */
  targetId: string;
  /** topic 已有编译 Wiki 页。 */
  hasWiki: boolean;
  formalObjectType: 'wiki_page' | 'knowledge_note' | 'knowledge_entity' | 'free_note' | null;
  formalObjectId: string | null;
  /** 对象在当前工作空间存在（topic/source 业务行或知识对象存在）。 */
  exists: boolean;
}>;

// ===== Inbox（待处理）投影：rediscovery 三池 + 每项最新知识回执 =====

export type KnowledgeInboxPool = Readonly<{
  id: string;
  title: string;
  priority: number | null;
  collectedAt: string | null;
  reason: string;
  /** 该 Source 最近一次知识回执（证据变化摘要；无 → null）。 */
  latestReceipt: KnowledgeUpdateReceiptRecord | null;
}>;

export type KnowledgeInboxResult = Readonly<{
  unused: readonly KnowledgeInboxPool[];
  watching: readonly KnowledgeInboxPool[];
  pending: readonly KnowledgeInboxPool[];
}>;

/** 业务通道名（主进程注册 + preload 消费同一常量，避免第二套命名）。 */
export const KNOWLEDGE_TOPIC_WIKI_DETAIL_IPC_CHANNEL = 'knowledge:topic-wiki-detail' as const;
export const KNOWLEDGE_SOURCE_KNOWLEDGE_DETAIL_IPC_CHANNEL = 'knowledge:source-knowledge-detail' as const;
export const KNOWLEDGE_DEEP_LINK_IPC_CHANNEL = 'knowledge:deep-link' as const;
