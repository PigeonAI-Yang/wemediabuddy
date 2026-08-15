// WMB-5239：共享 Wiki 搜索/日志面板组件（资料库/主题/画布共用；纯逻辑见 wiki-discovery-parts.ts）。
// 组件可访问：input aria-label、Enter 提交、Esc 清空、ArrowDown 进入结果、结果按钮可聚焦、
//   aria-live 计数、loading/empty/error+retry 四态。全库搜索入口唯一在资料库（Review 边界）；
//   主题/画布按需用 useWikiSearch(topicId)/useKnowledgeLog 自渲染或仅消费日志面板。
import { useRef, useState } from 'react';
import type { KnowledgeLogEntry } from '../shared/knowledge-global-log';
import type { KnowledgeDeepLinkPayload } from '../shared/knowledge-topic-library';
import type { WikiSearchResult } from '../shared/knowledge-search';
import {
  dispatchWikiDeepLink,
  dispatchWikiLogEntry,
  formatWikiWhen,
  useKnowledgeLog,
  useWikiSearch,
  wikiLogEventLabel,
  wikiSearchObjectLabel,
} from './wiki-discovery-parts';

export {
  WIKI_DISCOVERY_REFRESH_SCOPES,
  WIKI_LOG_PAGE_LIMIT,
  WIKI_MAINTENANCE_EVENT,
  WIKI_NAVIGATE_EVENT,
  WIKI_SEARCH_DEBOUNCE_MS,
  WIKI_SEARCH_PAGE_LIMIT,
  dispatchWikiDeepLink,
  dispatchWikiLogEntry,
  dispatchWikiMaintenance,
  formatWikiWhen,
  shouldRefreshWikiDiscovery,
  useKnowledgeLog,
  useWikiIndexSummary,
  useWikiSearch,
  wikiLogEntryDeepLinkInput,
  wikiLogEventLabel,
  wikiLogObjectLabel,
  wikiSearchObjectLabel,
} from './wiki-discovery-parts';
export type {
  KnowledgeLogHookOptions,
  KnowledgeLogHookState,
  WikiIndexSummaryHookState,
  WikiSearchHookOptions,
  WikiSearchHookState,
} from './wiki-discovery-parts';

export type WikiSearchPanelProps = Readonly<{
  /** 结果点击回调（缺省走 dispatchWikiDeepLink(result.navigation)）。 */
  onResultOpen?: (payload: KnowledgeDeepLinkPayload, result: WikiSearchResult) => void;
  label?: string;
  placeholder?: string;
  emptyHint?: string;
  compact?: boolean;
  autoFocus?: boolean;
  className?: string;
}>;

/** 统一搜索面板：输入 + 紧凑行式结果 + 四态。全库六类对象（搜索全部资料）。 */
export function WikiSearchPanel(props: WikiSearchPanelProps): React.JSX.Element {
  const {
    onResultOpen,
    label = '搜索全部资料',
    placeholder = '搜索全部资料（Wiki、笔记、实体、主题、资料）',
    emptyHint = '没有找到匹配的内容，换个关键词试试。',
    compact = false,
    autoFocus = false,
    className,
  } = props;
  const [query, setQuery] = useState('');
  const search = useWikiSearch({ query });
  const listRef = useRef<HTMLDivElement | null>(null);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQuery('');
      event.currentTarget.select();
    } else if (event.key === 'ArrowDown') {
      const first = listRef.current?.querySelector<HTMLButtonElement>('[data-wiki-result]');
      if (first) {
        first.focus();
        event.preventDefault();
      }
    }
  };

  const open = (result: WikiSearchResult) => {
    if (onResultOpen) onResultOpen(result.navigation, result);
    else dispatchWikiDeepLink(result.navigation);
  };

  const hasQuery = Boolean(query.trim());

  return (
    <section className={`wiki-discovery wiki-search-panel${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="wiki-search-input-row">
        <input
          type="search"
          className="wiki-search-input"
          aria-label={label}
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
        />
        {hasQuery ? (
          <button type="button" className="wiki-search-clear" aria-label="清空搜索" onClick={() => setQuery('')}>×</button>
        ) : null}
      </div>
      <div className="wiki-discovery-status" role="status" aria-live="polite">
        {search.total > 0 ? `找到 ${search.total} 条结果` : ''}
      </div>
      <div className="wiki-search-results" ref={listRef} aria-busy={search.loading || search.refreshing}>
        {search.loading ? (
          <p className="wiki-discovery-empty">正在搜索…</p>
        ) : search.error ? (
          <div className="wiki-discovery-error" role="alert">
            <strong>搜索失败</strong>
            <p>{search.error}</p>
            <button type="button" className="wiki-discovery-retry" onClick={search.retry}>重试</button>
          </div>
        ) : !hasQuery ? (
          <p className="wiki-discovery-empty">输入关键词搜索全部资料。</p>
        ) : !search.results.length ? (
          <p className="wiki-discovery-empty">{emptyHint}</p>
        ) : (
          <ul className="wiki-search-result-list">
            {search.results.map((result) => (
              <li key={`${result.objectType}:${result.objectId}:${result.versionRef}`}>
                <button
                  type="button"
                  data-wiki-result
                  className="wiki-result-row"
                  onClick={() => open(result)}
                >
                  <span className="wiki-result-type">{wikiSearchObjectLabel(result.objectType)}</span>
                  <strong className="wiki-result-title">{result.title}</strong>
                  {result.snippet ? <span className="wiki-result-snippet">{result.snippet}</span> : null}
                  <time className="wiki-result-time" dateTime={result.updatedAt}>{formatWikiWhen(result.updatedAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
        {search.refreshing && !search.loading && search.results.length ? (
          <p className="wiki-discovery-refresh-note">已自动更新</p>
        ) : null}
      </div>
    </section>
  );
}

export type KnowledgeLogPanelProps = Readonly<{
  /** 条目点击回调（缺省走 dispatchWikiLogEntry：maintenance→整理面板，其余→深链）。 */
  onEntryOpen?: (entry: KnowledgeLogEntry) => void;
  label?: string;
  emptyHint?: string;
  compact?: boolean;
  limit?: number;
  className?: string;
}>;

/** 最近变化日志面板：事件标签 + 标题 + 摘要 + 相对时间，紧凑行式 + loadMore。 */
export function KnowledgeLogPanel(props: KnowledgeLogPanelProps): React.JSX.Element {
  const {
    onEntryOpen,
    label = '最近变化',
    emptyHint = '还没有知识变化记录。',
    compact = false,
    limit,
    className,
  } = props;
  const log = useKnowledgeLog({ limit });
  const open = (entry: KnowledgeLogEntry) => {
    if (onEntryOpen) onEntryOpen(entry);
    else void dispatchWikiLogEntry(entry);
  };

  return (
    <section className={`wiki-discovery wiki-log-panel${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <header className="wiki-log-head">
        <strong className="wiki-log-label">{label}</strong>
        {log.total > 0 ? <span className="wiki-log-count">{log.total}</span> : null}
      </header>
      <div className="wiki-log-body" aria-busy={log.loading || log.refreshing}>
        {log.loading ? (
          <p className="wiki-discovery-empty">正在加载最近变化…</p>
        ) : log.error ? (
          <div className="wiki-discovery-error" role="alert">
            <strong>{label}加载失败</strong>
            <p>{log.error}</p>
            <button type="button" className="wiki-discovery-retry" onClick={log.retry}>重试</button>
          </div>
        ) : !log.entries.length ? (
          <p className="wiki-discovery-empty">{emptyHint}</p>
        ) : (
          <ul className="wiki-log-list">
            {log.entries.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="wiki-log-row" onClick={() => open(entry)}>
                  <span className="wiki-log-event">{wikiLogEventLabel(entry.eventType)}</span>
                  <span className="wiki-log-title">{entry.title}</span>
                  {entry.summary ? <span className="wiki-log-summary">{entry.summary}</span> : null}
                  <time className="wiki-log-time" dateTime={entry.time}>{formatWikiWhen(entry.time)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
        {log.hasMore ? (
          <div className="wiki-log-more">
            <button type="button" disabled={log.loadingMore} onClick={log.loadMore}>
              {log.loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
