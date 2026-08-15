// WMB-5238：统一全文搜索 + 索引摘要 + 有界 hot cache 只读契约（本 worker：ImplementWikiUnifiedSearch）。
// Design: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md + WMB-5238 施工许可
//  （M-5240：SQLite 内建 Wiki 索引 / 全局时间日志 / 统一全文搜索，覆盖 Wiki 正文、Knowledge Note、
//   Entity、Topic、Source 与固定版本引用；提供 index/log/hot-cache 等价读模型，不制造 Markdown 真源）。
// 定位：preload ↔ main 的统一搜索只读通道清单与纯 JSON 边界类型（camelCase，序列化友好）。
// 约束：
// - 只读：本契约不暴露任何写通道（无 rebuild/execute/raw）；hot cache 重建是 main 侧内部行为，
//   IPC 侧 hotCache 通道读取时按指纹惰性刷新，不产生 DB 写面；
// - 搜索 LIKE 只打预压平索引表 knowledge_index_entries（migration 63，每对象一行，searchable_text 有界），
//   绝不打源表（source_body_cache / knowledge_wiki_page_versions.body_json 可能很大）——索引即读模型，非第二真源；
// - 空查询语义固定：query 空/纯空白 → 空结果 { items:[], total:0, ... }（契约写明，非全量分页）；
// - 分页信封 = {items,total,limit,offset,hasMore,cursor}；limit 有界 1..100 默认 20；
//   排序 = (title LIKE) DESC, updated_at DESC, object_type ASC, object_id ASC —— 完全确定可复现；
//   游标 = base64url(JSON {h,u,t,i})（h=titleHit 0|1, u=updatedAt, t=objectType, i=objectId）；
//   非法/损坏/越界游标 → INVALID_CURSOR fail-closed（与既有 boundary 一致，不回退为空页）；
// - workspace 隔离为结构性（每个 data-root 独立 DB 文件）；store 只读当前传入数据库，不做跨库访问；
// - 主进程 store 类型真源在 src/main/knowledge-search.ts，本文件字段与其保持对齐。

import type { KnowledgeScope } from './knowledge-flywheel.ts';
import type { KnowledgeDeepLinkPayload } from './knowledge-topic-library.ts';

/** 统一搜索只读通道（main handler + preload 消费同一常量，不得造第二套命名）。 */
export const WIKI_SEARCH_READ_IPC_CHANNELS = {
  search: 'knowledge-index:search',
  summary: 'knowledge-index:summary',
  hotCache: 'knowledge-index:hot-cache'
} as const;

export type WikiSearchReadChannel = (typeof WIKI_SEARCH_READ_IPC_CHANNELS)[keyof typeof WIKI_SEARCH_READ_IPC_CHANNELS];

/** 六类可搜索对象（与迁移 63 CHECK 对齐；固定版本引用 = 指向不可变版本的引用行）。 */
export type WikiSearchObjectType =
  | 'wiki_page'
  | 'knowledge_note'
  | 'entity'
  | 'topic'
  | 'source'
  | 'fixed_version_reference';

export const WIKI_SEARCH_OBJECT_TYPES: readonly WikiSearchObjectType[] = Object.freeze([
  'wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference'
]);

/** 固定版本/修订引用字符串（IndexStore 写入）。
 * - wiki_page / knowledge_note / fixed_version_reference → 不可变版本 id（如 'wiki_page:<pageId>:<versionId>'）；
 * - entity / topic / source → revision 数值（无版本表；如 'topic:<id>:<revision>'）。 */
export type WikiSearchVersionRef = string;

/** 搜索结果载荷：对象类型 + 稳定对象 ID + 固定版本/修订引用 + 标题 + 命中片段 + 更新时间 + 可导航定位。 */
export type WikiSearchResult = Readonly<{
  objectType: WikiSearchObjectType;
  /** 稳定对象 ID（同一 ID 空间：topic.id / source.id / wiki page id / note id / entity id / 版本引用行 id）。 */
  objectId: string;
  /** 固定版本/修订锚（当前命中仍返回不可变版本 id 或 revision，绝不返回无版本锚点的裸对象 ID）。 */
  versionRef: WikiSearchVersionRef;
  title: string;
  /** 摘要/命中片段：命中词前后 ±60 字符（标题命中优先展示标题/摘要）。 */
  snippet: string;
  updatedAt: string;
  /** 可导航定位：与 resolveKnowledgeDeepLink 同源载荷 shape（topic→topic_wiki、source→library、其余→object）。 */
  navigation: KnowledgeDeepLinkPayload;
}>;

/** 搜索过滤输入（严格校验；非法字段/未知类型/非法游标 fail-closed）。 */
export type WikiSearchFilter = Readonly<{
  /** 搜索词；空/纯空白 → 空结果 total 0（契约语义）。 */
  query: string;
  /** 对象类型过滤（可选；未知类型 → INVALID_INPUT）。 */
  objectTypes?: readonly WikiSearchObjectType[];
  /** Topic scope：仅返回该 topic 关联的索引行（可选）。 */
  topicId?: string;
  /** 可选 scope：'global' | 'lane:<key>'；格式非法 → INVALID_INPUT。 */
  scope?: KnowledgeScope;
  /** 稳定游标（上一页返回的 cursor；非法 → INVALID_CURSOR）。 */
  cursor?: string | null;
  /** 页大小 1..100（默认 20）。 */
  limit?: number;
}>;

/** 统一搜索分页信封（与 knowledge-flywheel list* 信封对齐 + cursor 稳定分页）。 */
export type WikiSearchPage = Readonly<{
  items: readonly WikiSearchResult[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** 下一页游标；hasMore=false 时为 null。 */
  cursor: string | null;
}>;

/** 索引摘要：按类型 counts + 总量 + 索引最新更新时间 + hot cache 最近重建时间。 */
export type WikiIndexSummary = Readonly<{
  counts: Readonly<Record<WikiSearchObjectType, number>>;
  total: number;
  /** 索引表最新 updated_at（null = 索引为空）。 */
  updatedAt: string | null;
  /** hot cache 最近重建时间（未重建过为 null）。 */
  rebuiltAt: string | null;
}>;

/** 有界 hot cache 状态 + 等价摘要（cache 可丢弃重建，非独立真源）。 */
export type WikiHotCacheStatus = Readonly<{
  cached: boolean;
  rebuiltAt: string | null;
  /** 当前缓存条目数（≤ maxEntries）。 */
  entryCount: number;
  /** 有界上限（本契约固定 500）。 */
  maxEntries: number;
  summary: WikiIndexSummary;
}>;
