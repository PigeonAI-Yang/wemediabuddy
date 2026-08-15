/**
 * WMB-5238：SQLite 内建 Wiki 索引 / 全局时间日志 / 统一全文搜索的只读 IPC 接线。
 * 定位：统一 search（knowledge-index:*）、全局时间日志（knowledge-global-log:*）的
 *   main handler 注册；只读、无写通道（新表写入只经 dispatcher 授权命令与
 *   wiki-index-triggers 投影，不在本模块制造第二套写面）。
 * 约束：
 * - 通道常量唯一真源在 src/shared/knowledge-search.ts / src/shared/knowledge-global-log.ts，
 *   main 注册与 preload 均消费同一常量，不得造第二套命名；
 * - 入参纯 JSON 透传；非法/缺失参数由 store boundary 拒绝（fail-closed，抛错即拒绝，
 *   不回退为空页）；无 data-root 时返回空信封（诚实空态，不猜测/不落库）；
 * - workspace/data-root 隔离为结构性：readWorkspaceDatabase 边界，store 只读当前库；
 * - hot cache 只读：hotCache 通道读取时按 DB 指纹惰性刷新（main 侧内部行为），
 *   不暴露 rebuild/execute/raw 写通道。
 */
import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { readWorkspaceDatabase, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  WIKI_SEARCH_READ_IPC_CHANNELS,
  type WikiHotCacheStatus,
  type WikiIndexSummary,
  type WikiSearchPage
} from '../shared/knowledge-search.ts';
import {
  KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS,
  type KnowledgeLogEntry,
  type KnowledgeLogPage
} from '../shared/knowledge-global-log.ts';
import {
  getWikiHotCache,
  getWikiIndexSummary,
  searchWikiIndex
} from './knowledge-search.ts';
import {
  getKnowledgeLogEntry,
  listKnowledgeLogEntries
} from './knowledge-global-log.ts';

/** 空库/无 data-root 时的统一搜索空信封（与 store 默认 limit 对齐）。 */
const EMPTY_SEARCH_PAGE: WikiSearchPage = Object.freeze({
  items: [],
  total: 0,
  limit: 20,
  offset: 0,
  hasMore: false,
  cursor: null
});

/** 空库/无 data-root 时的索引摘要空态（counts 全 0；无缓存重建时间）。 */
const EMPTY_INDEX_SUMMARY: WikiIndexSummary = Object.freeze({
  counts: Object.freeze({
    wiki_page: 0,
    knowledge_note: 0,
    entity: 0,
    topic: 0,
    source: 0,
    fixed_version_reference: 0
  }),
  total: 0,
  updatedAt: null,
  rebuiltAt: null
});

/** 空库/无 data-root 时的 hot cache 空态（可丢弃重建、非真源；summary 与索引摘要空态对齐）。 */
const EMPTY_HOT_CACHE_STATUS: WikiHotCacheStatus = Object.freeze({
  cached: false,
  rebuiltAt: null,
  entryCount: 0,
  maxEntries: 500,
  summary: EMPTY_INDEX_SUMMARY
});

/** 空库/无 data-root 时的全局日志空信封（与 store 默认 limit 对齐）。 */
const EMPTY_LOG_PAGE: KnowledgeLogPage = Object.freeze({
  items: [],
  total: 0,
  limit: 50,
  before: null,
  after: null,
  hasMore: false,
  hasMoreBefore: false,
  hasMoreAfter: false
});

/** 注册 WMB-5238 只读 IPC（search/summary/hot-cache + global log list/get）。 */
export function registerWikiIndexIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle(WIKI_SEARCH_READ_IPC_CHANNELS.search, (_event, input: unknown) =>
    readWorkspaceDatabase(dependencies, () => EMPTY_SEARCH_PAGE, (database: DatabaseSync) => searchWikiIndex(database, input)));
  ipcMain.handle(WIKI_SEARCH_READ_IPC_CHANNELS.summary, () =>
    readWorkspaceDatabase(dependencies, () => EMPTY_INDEX_SUMMARY, (database: DatabaseSync) => getWikiIndexSummary(database)));
  ipcMain.handle(WIKI_SEARCH_READ_IPC_CHANNELS.hotCache, () =>
    readWorkspaceDatabase(dependencies, () => EMPTY_HOT_CACHE_STATUS, (database: DatabaseSync) => getWikiHotCache(database)));
  ipcMain.handle(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list, (_event, input: unknown) =>
    readWorkspaceDatabase(dependencies, () => EMPTY_LOG_PAGE, (database: DatabaseSync) => listKnowledgeLogEntries(database, (input ?? {}) as Parameters<typeof listKnowledgeLogEntries>[1])));
  ipcMain.handle(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.get, (_event, id: string) =>
    readWorkspaceDatabase(dependencies, () => null, (database: DatabaseSync): KnowledgeLogEntry | null => getKnowledgeLogEntry(database, id)));
}

/** WMB-5238 只读通道全集（与 shared 常量对齐；防注册遗漏的断言用）。 */
export const WIKI_INDEX_IPC_CHANNELS: readonly string[] = Object.freeze([
  WIKI_SEARCH_READ_IPC_CHANNELS.search,
  WIKI_SEARCH_READ_IPC_CHANNELS.summary,
  WIKI_SEARCH_READ_IPC_CHANNELS.hotCache,
  KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list,
  KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.get
]);
