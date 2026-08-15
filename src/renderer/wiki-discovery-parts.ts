// WMB-5239：共享 Wiki 搜索/日志纯逻辑与状态 hooks（renderer 级单一来源，无 JSX 便于聚焦测试）。
// 定位：资料库/主题/关系画布三页共用同一套用户语言映射、深链分发、竞态防护与
//   loading/empty/error/retry 状态机，避免三套重复 IPC 与映射（Review 边界：全库搜索
//   入口唯一在资料库；主题/画布经 topicId/objectTypes 限定或仅消费日志面板）。
// 契约：
// - 只读消费 preload 的 searchWikiIndex / listKnowledgeLogEntries / resolveKnowledgeDeepLink
//   （WMB-5238/WMB-5212），无任何写通道；
// - 竞态防护：每个请求带递增 seq，响应到达时 seq 不匹配即丢弃（旧响应不覆盖新查询）；
// - data_changed 订阅（可选链调用）命中 WIKI_DISCOVERY_REFRESH_SCOPES 时做有界后台刷新：
//   保留当前结果，refreshing=true，不整页 loading；
// - 用户语言：搜索全部资料/最近变化/全库整理/失败项；禁 index/cursor/hot-cache/limit/
//   offset/compiled/receipt/changeset 等工程词；
// - 深链复用既有导航机制：经 CustomEvent 桥到 main.tsx（WireWmb5239UiSeams 注册监听），
//   topic→openTopic、source→libraryFocusSourceId+navigate('library')、object→画布本体卡降级。
import { useCallback, useEffect, useRef, useState } from 'react';
import { WMB_NAVIGATE_WIKI_OBJECT_EVENT } from './app-types.ts';
import type {
  KnowledgeLogEntry,
  KnowledgeLogEventType,
  KnowledgeLogObjectType,
  KnowledgeLogReadFilter,
} from '../shared/knowledge-global-log.ts';
import type {
  KnowledgeDeepLinkInput,
  KnowledgeDeepLinkPayload,
} from '../shared/knowledge-topic-library.ts';
import type {
  WikiIndexSummary,
  WikiSearchFilter,
  WikiSearchObjectType,
  WikiSearchResult,
} from '../shared/knowledge-search.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 搜索防抖窗口（避免每击键一次 IPC）。 */
export const WIKI_SEARCH_DEBOUNCE_MS = 260;
/** 搜索默认页大小（契约上限 100）。 */
export const WIKI_SEARCH_PAGE_LIMIT = 20;
/** 日志默认页大小（契约上限 100）。 */
export const WIKI_LOG_PAGE_LIMIT = 50;

/** dataChanged 触发共享发现刷新的 scope（知识面写面广播全集；空 scopes 视为刷新）。 */
export const WIKI_DISCOVERY_REFRESH_SCOPES: readonly string[] = Object.freeze([
  'knowledge', 'topics', 'canvas', 'health', 'receipt', 'library', 'sources',
]);

export function shouldRefreshWikiDiscovery(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes || !scopes.length) return true;
  return scopes.some((scope) => WIKI_DISCOVERY_REFRESH_SCOPES.includes(scope));
}

/** 深链导航桥事件（真源在 app-types，main.tsx 已由 WireWmb5239UiSeams 注册唯一监听；detail.payload 为 KnowledgeDeepLinkPayload）。 */
export const WIKI_NAVIGATE_EVENT = WMB_NAVIGATE_WIKI_OBJECT_EVENT;
/** 全库整理面板定位事件（资料库维护面板可选监听；detail.runId）。 */
export const WIKI_MAINTENANCE_EVENT = 'wmb-open-library-maintenance';

// ---------------------------------------------------------------------------
// 用户语言映射（纯函数；单份，三页共用）
// ---------------------------------------------------------------------------

const WIKI_SEARCH_OBJECT_LABELS: Readonly<Record<WikiSearchObjectType, string>> = Object.freeze({
  wiki_page: 'Wiki 页面',
  knowledge_note: '知识笔记',
  entity: '实体',
  topic: '主题',
  source: '资料',
  fixed_version_reference: '版本引用',
});

/** 统一搜索结果对象类型 → 用户语言（六类覆盖；未知类型兜底「知识对象」）。 */
export function wikiSearchObjectLabel(objectType: WikiSearchObjectType): string {
  return WIKI_SEARCH_OBJECT_LABELS[objectType] ?? '知识对象';
}

const WIKI_LOG_EVENT_LABELS: Readonly<Record<KnowledgeLogEventType, string>> = Object.freeze({
  change_set: '知识更新',
  receipt: '更新记录',
  compile: '页面已生成',
  lint_detected: '发现健康问题',
  lint_resolved: '健康问题已解决',
  maintenance_started: '开始全库整理',
  maintenance_completed: '全库整理完成',
  query: '问答写回',
  source: '资料摄取',
});

/** 全局日志事件类型 → 用户语言（九类覆盖；未知类型兜底「知识事件」）。 */
export function wikiLogEventLabel(eventType: KnowledgeLogEventType): string {
  return WIKI_LOG_EVENT_LABELS[eventType] ?? '知识事件';
}

const WIKI_LOG_OBJECT_LABELS: Readonly<Record<KnowledgeLogObjectType, string>> = Object.freeze({
  change_set: '知识更新',
  receipt: '更新记录',
  wiki_page_version: 'Wiki 页面',
  health_issue: '健康问题',
  maintenance_run: '全库整理',
  query_artifact: '问答记录',
  source_revision: '资料版本',
});

/** 全局日志承载对象类型 → 用户语言（七类覆盖；未知类型兜底「知识对象」）。 */
export function wikiLogObjectLabel(objectType: KnowledgeLogObjectType): string {
  return WIKI_LOG_OBJECT_LABELS[objectType] ?? '知识对象';
}

/** ISO 时间 → 相对时间（刚刚/N 分钟前/N 小时前/N 天前/YYYY-MM-DD）；非法或空 → '—'。 */
export function formatWikiWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const month = String(then.getMonth() + 1).padStart(2, '0');
  const day = String(then.getDate()).padStart(2, '0');
  return `${then.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// 日志 locator → 深链输入映射（Scout 风险：source 条目 locator.id 是 revisionId，
// 导航必须取 versionRefs.sourceId；health/change_set/receipt/query 按 refs 优先级取首个）
// ---------------------------------------------------------------------------

function firstRefId(refs: KnowledgeLogEntry['refs']): KnowledgeDeepLinkInput | null {
  const [wikiPageId] = refs.wikiPageIds;
  if (wikiPageId) return { objectType: 'wiki_page', objectId: wikiPageId };
  const [noteId] = refs.noteIds;
  if (noteId) return { objectType: 'knowledge_note', objectId: noteId };
  const [topicId] = refs.topicIds;
  if (topicId) return { objectType: 'topic', objectId: topicId };
  const [sourceId] = refs.sourceIds;
  if (sourceId) return { objectType: 'source', objectId: sourceId };
  const [entityId] = refs.entityIds;
  if (entityId) return { objectType: 'entity', objectId: entityId };
  return null;
}

/** 日志条目 → 深链输入；maintenance_run 无可导航对象 → null。 */
export function wikiLogEntryDeepLinkInput(entry: KnowledgeLogEntry): KnowledgeDeepLinkInput | null {
  switch (entry.locator.kind) {
    case 'source_revision': {
      const sourceId = entry.versionRefs.sourceId ?? entry.locator.id;
      return sourceId ? { objectType: 'source', objectId: sourceId } : null;
    }
    case 'wiki_page_version': {
      const wikiPageId = entry.versionRefs.wikiPageId ?? entry.locator.id;
      return wikiPageId ? { objectType: 'wiki_page', objectId: wikiPageId } : null;
    }
    case 'health_issue':
    case 'change_set':
    case 'receipt':
    case 'query_artifact':
      return firstRefId(entry.refs);
    case 'maintenance_run':
      return null;
  }
}

// ---------------------------------------------------------------------------
// 深链分发（CustomEvent 桥；导航落地在 main.tsx，Wire 注册监听）
// ---------------------------------------------------------------------------

/** 派发统一搜索/日志结果的跨页导航（payload 同源 KnowledgeDeepLinkPayload）。 */
export function dispatchWikiDeepLink(payload: KnowledgeDeepLinkPayload): void {
  window.dispatchEvent(new CustomEvent<{ payload: KnowledgeDeepLinkPayload }>(WIKI_NAVIGATE_EVENT, { detail: { payload } }));
}

/** 派发「打开资料库全库整理面板」定位请求（maintenance 日志条目点击）。 */
export function dispatchWikiMaintenance(runId: string): void {
  window.dispatchEvent(new CustomEvent<{ runId: string }>(WIKI_MAINTENANCE_EVENT, { detail: { runId } }));
}

/** 日志条目点击：maintenance 事件 → 整理面板；其余 → locator 映射 → resolveKnowledgeDeepLink → 跨页导航。 */
export async function dispatchWikiLogEntry(entry: KnowledgeLogEntry): Promise<void> {
  if (entry.eventType === 'maintenance_started' || entry.eventType === 'maintenance_completed') {
    dispatchWikiMaintenance(entry.versionRefs.maintenanceRunId ?? entry.locator.id);
    return;
  }
  const input = wikiLogEntryDeepLinkInput(entry);
  if (!input) return;
  const payload = await window.wmb.resolveKnowledgeDeepLink(input).catch(() => null);
  if (payload) dispatchWikiDeepLink(payload);
}

// ---------------------------------------------------------------------------
// 状态 hooks（seq 防竞态；data_changed 有界后台刷新）
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '请求失败，请稍后重试。';
}

export type WikiIndexSummaryHookState = Readonly<{
  summary: WikiIndexSummary | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  retry: () => void;
  refresh: () => void;
}>;

/** 索引摘要 hook（全库统计：六类对象计数/总量/更新时间）：seq 防竞态 + data_changed 有界刷新。 */
export function useWikiIndexSummary(options: { enabled?: boolean } = {}): WikiIndexSummaryHookState {
  const { enabled = true } = options;
  const [summary, setSummary] = useState<WikiIndexSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback((mode: 'initial' | 'background') => {
    if (!enabled) return;
    const requestSeq = ++seq.current;
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    setError(null);
    void (async () => {
      try {
        const value = await window.wmb.getWikiIndexSummary();
        if (requestSeq !== seq.current) return;
        setSummary(value ?? null);
      } catch (cause) {
        if (requestSeq !== seq.current) return;
        setError(errorMessage(cause));
      } finally {
        if (requestSeq === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
  }, [enabled]);

  useEffect(() => {
    load('initial');
    return () => {
      seq.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!window.wmb?.onDataChanged) return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshWikiDiscovery(event.scopes)) return;
      load('background');
    });
  }, [load]);

  const retry = useCallback(() => {
    load('initial');
  }, [load]);

  const refresh = useCallback(() => {
    load('background');
  }, [load]);

  return { summary, loading, refreshing, error, retry, refresh };
}

export type WikiSearchHookOptions = Readonly<{
  /** 搜索词；空白 → 本地空结果（不发 IPC，契约语义）。 */
  query: string;
  debounceMs?: number;
  limit?: number;
  scope?: WikiSearchFilter['scope'];
  /** Topic 限定（主题页上下文）。 */
  topicId?: string;
  objectTypes?: readonly WikiSearchObjectType[];
  enabled?: boolean;
}>;

export type WikiSearchHookState = Readonly<{
  results: readonly WikiSearchResult[];
  total: number;
  /** 首载/换词加载（展示骨架）。 */
  loading: boolean;
  /** data_changed 后台刷新（保留旧结果）。 */
  refreshing: boolean;
  error: string | null;
  retry: () => void;
  refresh: () => void;
}>;

/** 统一全文搜索 hook：防抖 + seq 防竞态 + data_changed 有界刷新（单份 IPC 通道）。 */
export function useWikiSearch(options: WikiSearchHookOptions): WikiSearchHookState {
  const {
    query,
    debounceMs = WIKI_SEARCH_DEBOUNCE_MS,
    limit = WIKI_SEARCH_PAGE_LIMIT,
    scope,
    topicId,
    objectTypes,
    enabled = true,
  } = options;
  const [results, setResults] = useState<readonly WikiSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const activeQuery = useRef('');

  const runSearch = useCallback(async (term: string, mode: 'initial' | 'background', requestSeq: number) => {
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    setError(null);
    const filter: WikiSearchFilter = {
      query: term,
      limit,
      ...(scope !== undefined ? { scope } : {}),
      ...(topicId ? { topicId } : {}),
      ...(objectTypes && objectTypes.length ? { objectTypes } : {}),
    };
    try {
      const page = await window.wmb.searchWikiIndex(filter);
      if (requestSeq !== seq.current) return; // 旧响应：丢弃
      setResults(page?.items ?? []);
      setTotal(page?.total ?? 0);
    } catch (cause) {
      if (requestSeq !== seq.current) return;
      setError(errorMessage(cause));
    } finally {
      if (requestSeq === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [limit, scope, topicId, objectTypes]);

  // 防抖：换词立即清空旧结果（不同查询的结果不得残留展示），防抖后发起请求。
  useEffect(() => {
    if (!enabled) return;
    const trimmed = query.trim();
    const requestSeq = ++seq.current;
    if (!trimmed) {
      activeQuery.current = '';
      setResults([]);
      setTotal(0);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setResults([]);
    setTotal(0);
    setError(null);
    setLoading(true);
    const timer = window.setTimeout(() => {
      activeQuery.current = trimmed;
      void runSearch(trimmed, 'initial', requestSeq);
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      seq.current += 1; // 换词/卸载即丢弃在途旧响应（配合 requestSeq 双保险）
    };
  }, [query, debounceMs, enabled, runSearch]);

  // data_changed 有界刷新：仅当前有活跃查询时后台重跑，保留结果。
  useEffect(() => {
    if (!window.wmb?.onDataChanged) return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshWikiDiscovery(event.scopes)) return;
      const term = activeQuery.current;
      if (!term) return;
      const requestSeq = ++seq.current;
      void runSearch(term, 'background', requestSeq);
    });
  }, [runSearch]);

  const retry = useCallback(() => {
    const term = activeQuery.current;
    if (!term) return;
    const requestSeq = ++seq.current;
    void runSearch(term, 'initial', requestSeq);
  }, [runSearch]);

  const refresh = useCallback(() => {
    const term = activeQuery.current;
    if (!term) return;
    const requestSeq = ++seq.current;
    void runSearch(term, 'background', requestSeq);
  }, [runSearch]);

  return { results, total, loading, refreshing, error, retry, refresh };
}

export type KnowledgeLogHookOptions = Readonly<{
  topicId?: string;
  eventType?: KnowledgeLogEventType;
  objectType?: KnowledgeLogObjectType;
  limit?: number;
  enabled?: boolean;
}>;

export type KnowledgeLogHookState = Readonly<{
  entries: readonly KnowledgeLogEntry[];
  total: number;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  retry: () => void;
  refresh: () => void;
  loadMore: () => void;
}>;

/** 全局知识时间日志 hook：keyset 分页（before 取更旧）+ seq 防竞态 + data_changed 有界刷新。 */
export function useKnowledgeLog(options: KnowledgeLogHookOptions): KnowledgeLogHookState {
  const {
    topicId,
    eventType,
    objectType,
    limit = WIKI_LOG_PAGE_LIMIT,
    enabled = true,
  } = options;
  const [entries, setEntries] = useState<readonly KnowledgeLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const beforeRef = useRef<string | null>(null);

  const loadFirst = useCallback((mode: 'initial' | 'background') => {
    if (!enabled) return;
    const requestSeq = ++seq.current;
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    setError(null);
    const filter: KnowledgeLogReadFilter = {
      limit,
      ...(topicId ? { topicId } : {}),
      ...(eventType ? { eventType } : {}),
      ...(objectType ? { objectType } : {}),
    };
    void (async () => {
      try {
        const page = await window.wmb.listKnowledgeLogEntries(filter);
        if (requestSeq !== seq.current) return;
        setEntries(page?.items ?? []);
        setTotal(page?.total ?? 0);
        setHasMore(Boolean(page?.hasMore));
        beforeRef.current = page?.before ?? null;
      } catch (cause) {
        if (requestSeq !== seq.current) return;
        setError(errorMessage(cause));
      } finally {
        if (requestSeq === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
  }, [enabled, topicId, eventType, objectType, limit]);

  // 挂载/过滤变化 → 首载；卸载/变化时递增 seq 丢弃在途响应。
  useEffect(() => {
    loadFirst('initial');
    return () => {
      seq.current += 1;
    };
  }, [loadFirst]);

  // data_changed 有界刷新：时间倒序，新条目出现在顶部 → 回第一页替换。
  useEffect(() => {
    if (!window.wmb?.onDataChanged) return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshWikiDiscovery(event.scopes)) return;
      loadFirst('background');
    });
  }, [loadFirst]);

  const loadMore = useCallback(() => {
    if (!enabled || loading || refreshing || loadingMore || !hasMore) return;
    const requestSeq = ++seq.current;
    const before = beforeRef.current;
    setLoadingMore(true);
    setError(null);
    const filter: KnowledgeLogReadFilter = {
      limit,
      ...(topicId ? { topicId } : {}),
      ...(eventType ? { eventType } : {}),
      ...(objectType ? { objectType } : {}),
      ...(before ? { before } : {}),
    };
    void (async () => {
      try {
        const page = await window.wmb.listKnowledgeLogEntries(filter);
        if (requestSeq !== seq.current) return;
        setEntries((prev) => {
          const seen = new Set(prev.map((entry) => entry.id));
          return [...prev, ...(page?.items ?? []).filter((entry) => !seen.has(entry.id))];
        });
        setTotal(page?.total ?? total);
        setHasMore(Boolean(page?.hasMore));
        beforeRef.current = page?.before ?? null;
      } catch (cause) {
        if (requestSeq !== seq.current) return;
        setError(errorMessage(cause));
      } finally {
        if (requestSeq === seq.current) setLoadingMore(false);
      }
    })();
  }, [enabled, loading, refreshing, loadingMore, hasMore, topicId, eventType, objectType, limit, total]);

  const retry = useCallback(() => {
    loadFirst('initial');
  }, [loadFirst]);

  const refresh = useCallback(() => {
    loadFirst('background');
  }, [loadFirst]);

  return { entries, total, loading, refreshing, loadingMore, hasMore, error, retry, refresh, loadMore };
}
