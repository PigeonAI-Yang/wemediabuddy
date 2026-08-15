// WMB-5238：全局知识时间日志（global knowledge timeline log）的 preload ↔ main IPC 公共契约。
// Design: WMB-5238 SQLite 内建 Wiki 索引 + 全局时间日志；本文件 = 统一时间日志读模型契约。
// 定位：主进程投影服务（src/main/knowledge-global-log.ts）的纯 JSON 边界类型与通道常量；
//   主进程注册与 preload/renderer 均消费本文件常量，不得造第二套命名（同
//   src/shared/knowledge-flywheel.ts 模式）。
// 关键语义（与主进程实现对齐）：
// - 日志是「派生读模型」：不新增表、不写任何行；条目由既有正式表（knowledge_change_sets /
//   knowledge_update_receipts / knowledge_wiki_page_versions / knowledge_health_issues /
//   knowledge_query_artifacts / source_body_revisions / app_meta 维护 run KV）实时投影，
//   因此可重建、幂等、非独立真源；历史锚点取自各源不可变时间列（created_at/detected_at/
//   resolved_at/startedAt/completedAt），后续更新不会改写既有条目。
// - 稳定分页：全局序 = (time DESC, id DESC)，id = `事件类型:对象ID` 全局唯一；
//   游标为不透明字符串（encode/decode 见下），按 (time,id) keyset 前进，跨页插入不重不丢。
// - 每条携带：对象类型、稳定对象 ID、固定版本/修订引用、标题、摘要/命中片段、更新时间、可导航定位。

export const KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS = {
  list: 'knowledge-global-log:list',
  get: 'knowledge-global-log:get'
} as const;

export type KnowledgeGlobalLogReadChannel =
  (typeof KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS)[keyof typeof KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS];

/** 全局时间日志事件类型（与主进程投影源一一对应）。 */
export type KnowledgeLogEventType =
  | 'change_set'            // knowledge_change_sets（知识变更集）
  | 'receipt'               // knowledge_update_receipts（更新回执）
  | 'compile'               // knowledge_wiki_page_versions（Wiki 编译/版本提交）
  | 'lint_detected'         // knowledge_health_issues 检测锚点（detected_at）
  | 'lint_resolved'         // knowledge_health_issues 解决锚点（resolved_at）
  | 'maintenance_started'   // app_meta 维护 run 启动锚点（startedAt）
  | 'maintenance_completed' // app_meta 维护 run 完成锚点（completedAt）
  | 'query'                 // knowledge_query_artifacts（问答写回）
  | 'source';               // source_body_revisions（来源正文摄取，不可变）

/** 日志条目承载的稳定对象类型（可导航定位 kind 与此对齐）。 */
export type KnowledgeLogObjectType =
  | 'change_set'
  | 'receipt'
  | 'wiki_page_version'
  | 'health_issue'
  | 'maintenance_run'
  | 'query_artifact'
  | 'source_revision';

/** 可导航定位（UI 跳转到对象详情的最小凭证）。 */
export type KnowledgeLogLocator = Readonly<{
  kind: KnowledgeLogObjectType;
  id: string;
}>;

/** 固定版本/修订引用（事件发生时已冻结，不随后续更新漂移）。 */
export type KnowledgeLogVersionRefs = Readonly<{
  changeSetId: string | null;
  receiptId: string | null;
  wikiPageId: string | null;
  /** 固定 Wiki 版本引用（compile/query 条目；change_set 条目为该变更集创建的版本全集）。 */
  wikiPageVersionIds: readonly string[];
  /** 固定 Knowledge Note 版本引用（change_set/query 条目）。 */
  noteVersionIds: readonly string[];
  healthIssueId: string | null;
  /** 固定 Source 正文版本引用（source 条目：source_body_revisions.id）。 */
  sourceId: string | null;
  sourceRevisionId: string | null;
  previousSourceRevisionId: string | null;
  maintenanceRunId: string | null;
  reportId: string | null;
}>;

/** 对象关联引用（与统一搜索索引的对象覆盖对齐：Wiki/Note/Entity/Topic/Source）。 */
export type KnowledgeLogRefs = Readonly<{
  topicIds: readonly string[];
  entityIds: readonly string[];
  sourceIds: readonly string[];
  noteIds: readonly string[];
  wikiPageIds: readonly string[];
}>;

/** 统一时间日志条目（camelCase 纯 JSON；id = `${eventType}:${objectId}` 全局唯一稳定）。 */
export type KnowledgeLogEntry = Readonly<{
  id: string;
  eventType: KnowledgeLogEventType;
  /** ISO-8601 UTC 事件锚（取自不可变时间列；分页键之一）。 */
  time: string;
  objectType: KnowledgeLogObjectType;
  objectId: string;
  title: string;
  /** 用户可读摘要 / 命中片段。 */
  summary: string;
  scope: string | null;
  workspaceId: string | null;
  actor: string | null;
  versionRefs: KnowledgeLogVersionRefs;
  refs: KnowledgeLogRefs;
  locator: KnowledgeLogLocator;
}>;

/** 日志读过滤（纯 JSON；非法/缺失字段由主进程 boundary 拒绝；limit 有界 ≤ 100）。 */
export type KnowledgeLogReadFilter = Readonly<{
  eventType?: KnowledgeLogEventType;
  topicId?: string;
  objectType?: KnowledgeLogObjectType;
  objectId?: string;
  scope?: string;
  /** 默认 50；最大 100。 */
  limit?: number;
  /** keyset 游标：取比该条目更旧的一页（本页最旧条目的游标）。 */
  before?: string;
  /** keyset 游标：取比该条目更新的一页（向后导航用）。 */
  after?: string;
}>;

/** 统一时间日志分页信封（keyset；总条数 = 全量过滤计数，游标只约束本页窗口）。 */
export type KnowledgeLogPage = Readonly<{
  items: readonly KnowledgeLogEntry[];
  total: number;
  limit: number;
  /** 本页最旧条目的游标（传 before 取更旧页）；空页为 null。 */
  before: string | null;
  /** 本页最新条目的游标（传 after 取更新页）；空页为 null。 */
  after: string | null;
  /** 查询方向（默认/新页 = 更旧；after = 更新）仍有更多条目。 */
  hasMore: boolean;
  /** 存在比本页更旧的条目（before 导航可用）。 */
  hasMoreBefore: boolean;
  /** 存在比本页更新的条目（after 导航可用）。 */
  hasMoreAfter: boolean;
}>;

/**
 * 编码分页游标：`encodeURIComponent(time)|encodeURIComponent(id)`。
 * 纯函数、无 Node 依赖，renderer 可直接构造/解码；'|' 在两端均被编码，解码以首个 '|' 切分。
 */
export function encodeKnowledgeLogCursor(time: string, id: string): string {
  return `${encodeURIComponent(time)}|${encodeURIComponent(id)}`;
}

/** 解码分页游标；非法输入返回 null（主进程拒绝并报 KNOWLEDGE_LOG_CURSOR_INVALID）。 */
export function decodeKnowledgeLogCursor(cursor: string): { time: string; id: string } | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  const sep = cursor.indexOf('|');
  if (sep < 0) return null;
  try {
    const time = decodeURIComponent(cursor.slice(0, sep));
    const id = decodeURIComponent(cursor.slice(sep + 1));
    if (!time || !id) return null;
    return { time, id };
  } catch {
    return null;
  }
}
