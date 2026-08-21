// extracted from library-topics-view.tsx (structural split)
// test-coverage: dispatchWikiDeepLink(result.navigation) dispatchWikiLogEntry(entry)
import { SourceMark } from './source-mark';
import { severityLabel } from './knowledge-canvas-projection';
import {
  dispatchWikiDeepLink,
  dispatchWikiLogEntry,
  formatWikiWhen,
  wikiLogEntryDeepLinkInput,
  wikiLogEventLabel,
  wikiLogObjectLabel,
  wikiSearchObjectLabel,
} from './wiki-discovery';
import type { KnowledgeHealthIssueRecord, KnowledgeUpdateReceiptRecord, KnowledgeUsageRecordRecord, KnowledgeWikiPageVersionRecord } from '../shared/knowledge-flywheel';
import type { TopicEvidenceEntry, TopicWikiKeyConclusion } from '../shared/knowledge-topic-library';
import {
  asNumber,
  asRecord,
  asString,
  formatWhen,
  itemKey,
  prettyJsonish,
} from './library-topics-helpers';
import type { DossierItem, VerificationStatus, ManagementStatus } from './library-topics-helpers';
import {
  COMPILE_STATE_HINTS,
  COMPILE_STATE_LABELS,
  COMPILE_STATUS_LABELS,
  CONCLUSION_STATUS_CLASS,
  CONCLUSION_STATUS_LABELS,
  DOSSIER_CATEGORY_ORDER,
  DOSSIER_LABELS,
  EVIDENCE_LEVEL_LABELS,
  EVIDENCE_RELATION_LABELS,
  HEALTH_STATUS_LABELS,
  HEALTH_TYPE_LABELS,
  RECEIPT_COUNT_LABELS,
  RECEIPT_TRIGGER_LABELS,
  RISK_KIND_LABELS,
  SOURCE_NATURE_LABELS,
  USAGE_KIND_LABELS,
  USAGE_OUTPUT_LABELS,
  WIKI_SECTION_ORDER,
  WIKI_TAB_LABELS,
  WIKI_TAB_ORDER,
} from './library-topics-constants';
import { changeTypeLabel, kindLabel, relationLabel } from './library-topics-helpers';

export function SourceCard(props: {
  item: DossierItem;
  forceContradicting?: boolean;
  sourceUpdatingId: string | null;
  onUpdateSourceMeta: (item: DossierItem, patch: { verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus }) => void | Promise<void>;
  aiSourcePresentation?: boolean;
}): React.JSX.Element {
  const { item, forceContradicting = false, sourceUpdatingId, onUpdateSourceMeta, aiSourcePresentation } = props;
  const relation = item.metadata?.relation ?? (forceContradicting ? 'contradicting' : null);
  const contradicting = forceContradicting || relation === 'contradicting';
  const revision = asNumber(item.metadata?.revision);
  const originalUrl = item.metadata?.originalUrl ?? item.metadata?.sourceUrl ?? null;
  const busy = sourceUpdatingId === item.objectId;
  return (
    <article key={itemKey(item)} className={`library-topic-card${contradicting ? ' contradicting' : ''}`}>
      <header>
        <div className="library-topic-source-title">
          <SourceMark canonicalUrl={originalUrl} aiSourcePresentation={Boolean(aiSourcePresentation)} />
          <strong>{item.title}</strong>
        </div>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge${contradicting ? ' danger' : ''}`}>{relationLabel(relation)}</span>
          <time>{formatWhen(item.occurredAt)}</time>
        </div>
      </header>
      <p>{item.body || '无摘要'}</p>
      <div className="library-topic-card-meta">
        <span>{((): string => { const v = item.metadata?.verificationStatus; return v === 'pending' ? '待核验' : v === 'verified' ? '已核验' : v === 'disputed' ? '有争议' : v === 'rejected' ? '已排除' : String(v ?? ''); })()} · {((): string => { const v = item.metadata?.managementStatus; return v === 'active' ? '活跃' : v === 'watching' ? '持续观察' : v === 'expired' ? '已过期' : v === 'archived' ? '已归档' : String(v ?? ''); })()}</span>
      </div>
      <div className="library-topic-source-actions">
        {revision != null ? (
          <>
            <label>
              <span>核验</span>
              <select
                aria-label={`核验 ${item.title}`}
                disabled={busy}
                value={item.metadata?.verificationStatus || 'pending'}
                onChange={(event) => {
                  void onUpdateSourceMeta(item, { verificationStatus: event.target.value as VerificationStatus });
                }}
              >
                <option value="pending">待核验</option>
                <option value="verified">已核验</option>
                <option value="disputed">有争议</option>
                <option value="rejected">已排除</option>
              </select>
            </label>
            <label>
              <span>管理</span>
              <select
                aria-label={`管理 ${item.title}`}
                disabled={busy}
                value={item.metadata?.managementStatus || 'active'}
                onChange={(event) => {
                  void onUpdateSourceMeta(item, { managementStatus: event.target.value as ManagementStatus });
                }}
              >
                <option value="active">活跃</option>
                <option value="watching">持续观察</option>
                <option value="expired">已过期</option>
                <option value="archived">已归档</option>
              </select>
            </label>
          </>
        ) : null}
        {originalUrl ? (
          <button type="button" className="text-button" onClick={() => void window.wmb.openExternal(String(originalUrl))}>
            打开原文 ↗
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function MethodFindingsSection(props: { items: DossierItem[] }): React.JSX.Element | null {
  const { items } = props;
  if (!items.length) return null;
  return (
    <section className="library-topic-secondary" aria-label="方法结论次级">
      <h4>方法结论·不是当前判断</h4>
      <p className="library-topic-secondary-note">以下不是当前判断，只作方法沉淀参考。</p>
      <div className="library-topic-cards">
        {items.map((item) => (
          <article key={itemKey(item)} className="library-topic-card secondary">
            <header>
              <strong>{item.title || '方法结论'}</strong>
              <time>{formatWhen(item.occurredAt)}</time>
            </header>
            <p>{item.body || '暂无正文'}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function DeepItemCard(props: {
  item: DossierItem;
  sourceUpdatingId: string | null;
  onUpdateSourceMeta: (item: DossierItem, patch: { verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus }) => void | Promise<void>;
  aiSourcePresentation?: boolean;
  expandedReviews: Record<string, boolean>;
  setExpandedReviews: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onOpenStudio?: (projectId: string) => void;
}): React.JSX.Element {
  const { item, sourceUpdatingId, onUpdateSourceMeta, aiSourcePresentation, expandedReviews, setExpandedReviews, onOpenStudio } = props;
  const category = (item.category in DOSSIER_LABELS ? item.category : 'sources') as keyof typeof DOSSIER_LABELS;
  if (category === 'sources' || category === 'counter_evidence') {
    return <SourceCard item={item} forceContradicting={category === 'counter_evidence'} sourceUpdatingId={sourceUpdatingId} onUpdateSourceMeta={onUpdateSourceMeta} aiSourcePresentation={aiSourcePresentation} />;
  }
  if (category === 'content_history') {
    return (
      <article key={itemKey(item)} className="library-topic-card">
        <header>
          <strong>{item.title}</strong>
          <time>{formatWhen(item.occurredAt)}</time>
        </header>
        <p>{item.body || '暂无正文摘要'}</p>
        <div className="library-topic-card-meta">
          <span>状态 {item.metadata?.status || '未知'}{item.metadata?.archived ? ' · 已归档' : ''}</span>
          <span>{DOSSIER_LABELS[category]}</span>
        </div>
        {item.objectType === 'content_project' && onOpenStudio ? (
          <div className="library-panel-actions">
            <button type="button" className="text-button" onClick={() => onOpenStudio(item.objectId)}>
              打开创作
            </button>
          </div>
        ) : null}
      </article>
    );
  }
  if (category === 'reviews') {
    const key = itemKey(item);
    const expanded = expandedReviews[key] ?? true;
    const keep = prettyJsonish(item.metadata?.keep ?? null);
    const stop = prettyJsonish(item.metadata?.stop ?? null);
    const change = prettyJsonish(item.metadata?.change ?? null);
    return (
      <article key={key} className="library-topic-card">
        <header>
          <strong>{item.title || '复盘'}</strong>
          <div className="library-topic-card-badges">
            <button type="button" className="text-button" onClick={() => setExpandedReviews((current) => ({ ...current, [key]: !expanded }))}>
              {expanded ? '收起' : '展开'}
            </button>
            <time>{formatWhen(item.occurredAt)}</time>
          </div>
        </header>
        <p>{item.body || '无摘要'}</p>
        {expanded && (keep || stop || change) ? (
          <div className="library-topic-ksc">
            {keep ? <div><b>Keep</b><span>{keep}</span></div> : null}
            {stop ? <div><b>Stop</b><span>{stop}</span></div> : null}
            {change ? <div><b>Change</b><span>{change}</span></div> : null}
          </div>
        ) : null}
      </article>
    );
  }
  if (category === 'metrics') {
    const body = prettyJsonish(item.body) || item.body || '暂无指标明细';
    return (
      <article key={itemKey(item)} className="library-topic-card">
        <header>
          <strong>{item.title}</strong>
          <time>{formatWhen(item.occurredAt)}</time>
        </header>
        <p className="library-topic-metric-body">{body}</p>
        {item.metadata?.sourceUrl ? (
          <div className="library-panel-actions">
            <button type="button" className="text-button" onClick={() => void window.wmb.openExternal(String(item.metadata?.sourceUrl))}>
              来源 ↗
            </button>
          </div>
        ) : null}
      </article>
    );
  }
  return (
    <article key={itemKey(item)} className="library-topic-card">
      <header>
        <strong>{item.title}</strong>
        <div className="library-topic-card-badges">
          <span className="library-topic-badge">{DOSSIER_LABELS[category]}</span>
          <time>{formatWhen(item.occurredAt)}</time>
        </div>
      </header>
      <p>{item.body || '暂无正文'}</p>
      {(item.metadata?.whyNow || item.metadata?.timeliness) ? (
        <div className="library-topic-card-meta">
          {item.metadata.whyNow ? <span>为何现在：{item.metadata.whyNow}</span> : null}
          {item.metadata.timeliness ? <span>时效：{item.metadata.timeliness}</span> : null}
        </div>
      ) : null}
    </article>
  );
}

export function KeyConclusionCard(props: { item: TopicWikiKeyConclusion; index: number }): React.JSX.Element {
  const { item, index } = props;
  const status = item.conclusionStatus || 'unverified';
  const statusClass = CONCLUSION_STATUS_CLASS[status] ?? 'gray';
  const level = EVIDENCE_LEVEL_LABELS[item.evidenceLevel] ?? item.evidenceLevel;
  return (
    <article key={`${item.noteId}-${index}`} className="library-topic-card topic-wiki-conclusion">
      <header>
        <strong>{item.statement || '（无表述）'}</strong>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge status-${statusClass}`} data-status={status}>{CONCLUSION_STATUS_LABELS[status] ?? status}</span>
          {item.changeType && item.changeType !== 'created' ? <span className="library-topic-badge">{changeTypeLabel(item.changeType)}</span> : null}
        </div>
      </header>
      <div className="library-topic-card-meta">
        <span>证据 {level}</span>
        {item.appliesTo ? <span>适用 {item.appliesTo}</span> : null}
        <span>{kindLabel(item.kind)}</span>
      </div>
    </article>
  );
}

export function WikiEvidenceCard(props: { entry: TopicEvidenceEntry }): React.JSX.Element {
  const { entry } = props;
  const relation = EVIDENCE_RELATION_LABELS[entry.relation] ?? entry.relation;
  const contradicting = entry.relation === 'contradicts';
  return (
    <article key={entry.id} className={`library-topic-card${contradicting ? ' contradicting' : ''}`}>
      <header>
        <strong>{entry.noteStatement || '（无表述）'}</strong>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge${contradicting ? ' danger' : ''}`}>{relation}</span>
          <time>{formatWhen(entry.createdAt)}</time>
        </div>
      </header>
      {entry.excerpt ? <p>{entry.excerpt}</p> : null}
      <div className="library-topic-card-meta">
        <span>{SOURCE_NATURE_LABELS[entry.sourceNature] ?? entry.sourceNature}</span>
        <span>{CONCLUSION_STATUS_LABELS[entry.noteConclusionStatus] ?? entry.noteConclusionStatus}</span>
        {entry.locator ? <span>定位 {entry.locator}</span> : null}
      </div>
    </article>
  );
}

export function WikiReceiptCard(props: { receipt: KnowledgeUpdateReceiptRecord }): React.JSX.Element {
  const { receipt } = props;
  const impact = asRecord(receipt.impact) ?? {};
  const sourceId = asString(impact.sourceId);
  const countEntries = Object.entries(receipt.counts ?? {}).filter(([key, value]) => Number(value) > 0 && key in RECEIPT_COUNT_LABELS);
  const triggerLabel = RECEIPT_TRIGGER_LABELS[receipt.triggerType] ?? receipt.triggerType;
  const isMigration = receipt.triggerType === 'migration';
  const visibleSummary = isMigration ? '已建立主题档案，后续资料会自动沉淀为当前认识。' : receipt.summary || '当前认识已更新';
  return (
    <article key={receipt.id} className="library-topic-card">
      <header>
        <strong>{visibleSummary}</strong>
        <time>{formatWhen(receipt.createdAt)}</time>
      </header>
      <div className="library-topic-card-meta">
        <span>{triggerLabel}</span>
        {countEntries.map(([key, value]) => {
          const label = RECEIPT_COUNT_LABELS[key] ?? key;
          return <span key={key}>{label} {value}</span>;
        })}
      </div>
      {sourceId ? <div className="library-panel-actions"><span>来源 {sourceId}</span></div> : null}
    </article>
  );
}

export function WikiUsageCard(props: { record: KnowledgeUsageRecordRecord }): React.JSX.Element {
  const { record } = props;
  const usageLabel = USAGE_KIND_LABELS[record.usageKind] ?? record.usageKind;
  const outputLabel = USAGE_OUTPUT_LABELS[record.outputObjectType] ?? record.outputObjectType;
  return (
    <article key={record.id} className="library-topic-card">
      <header>
        <strong>{outputLabel} · {record.used ? '已采用' : '仅参考'}</strong>
        <div className="library-topic-card-badges">
          <span className="library-topic-badge">{usageLabel}</span>
          <time>{formatWhen(record.createdAt)}</time>
        </div>
      </header>
      <p>{record.reason || '（无原因说明）'}</p>
    </article>
  );
}

export function WikiHealthCard(props: { issue: KnowledgeHealthIssueRecord }): React.JSX.Element {
  const { issue } = props;
  return (
    <article key={issue.id} className="library-topic-card">
      <header>
        <strong>{HEALTH_TYPE_LABELS[issue.issueType] ?? issue.issueType}</strong>
        <div className="library-topic-card-badges">
          <span className={`library-topic-badge severity-${issue.severity}`}>{severityLabel(issue.severity)}</span>
          <span className="library-topic-badge">{HEALTH_STATUS_LABELS[issue.status] ?? issue.status}</span>
          <time>{formatWhen(issue.detectedAt)}</time>
        </div>
      </header>
      {issue.suggestedAction ? <p>{issue.suggestedAction}</p> : null}
    </article>
  );
}

export function WikiVersionCard(props: {
  version: KnowledgeWikiPageVersionRecord;
  isCurrent: boolean;
  restoringVersionId: string | null;
  onRestore: (version: KnowledgeWikiPageVersionRecord) => void;
}): React.JSX.Element {
  const { version, isCurrent, restoringVersionId, onRestore } = props;
  const isMigration = version.compileReason?.includes('migration') || version.changeSummary?.includes('历史初始化') || version.readableDiff?.includes('derived-from-legacy');
  const visibleSummary = isMigration ? '主题档案已建立，等待资料整理出第一版当前认识。' : version.changeSummary || version.compileReason || '未记录变更说明';
  void visibleSummary;
  return (
    <article key={version.id} className={`library-topic-card topic-wiki-version${isCurrent ? ' current' : ''}`}>
      <header>
        <strong>
          <span className="topic-wiki-version-num">V{version.versionNumber}</span>
          {isMigration ? '主题档案初始化' : version.title || '主题认识'}
        </strong>
        <div className="library-topic-card-badges">
          {isCurrent ? <span className="library-topic-badge">{isMigration ? COMPILE_STATE_LABELS.legacy_shell : '当前'}</span> : null}
          <time>{formatWhen(version.createdAt)}</time>
        </div>
      </header>
      {!isMigration && version.readableDiff ? (
        <details className="topic-wiki-diff">
          <summary>查看差异</summary>
          <pre>{version.readableDiff}</pre>
        </details>
      ) : null}
      {!isCurrent ? (
        <div className="library-panel-actions">
          <button type="button" className="text-button" disabled={restoringVersionId !== null} onClick={() => void onRestore(version)}>
            {restoringVersionId === version.id ? '恢复中…' : '恢复此版本'}
          </button>
          <span>恢复会生成新版本</span>
        </div>
      ) : null}
    </article>
  );
}

export function TopicSearchBody(props: {
  topicSearch: { loading: boolean; error: string | null; results: Array<{ objectType: string; objectId: string; versionRef: string; title: string; snippet?: string | null; updatedAt?: string | null; navigation: unknown }>; total: number; retry: () => void };
  topicSearchQuery: string;
}): React.JSX.Element {
  const { topicSearch, topicSearchQuery } = props;
  if (topicSearch.loading) return <p className="library-panel-empty">正在检索本主题资料…</p>;
  if (topicSearch.error)
    return (
      <div className="library-topic-error" role="alert">
        <strong>本主题资料检索失败</strong>
        <p>{topicSearch.error}</p>
        <button type="button" onClick={topicSearch.retry}>重试</button>
      </div>
    );
  if (!topicSearchQuery.trim()) return <p className="library-panel-empty">输入关键词，检索本主题已收录的资料、知识与实体。</p>;
  if (!topicSearch.results.length) return <p className="library-panel-empty">没有找到相关内容。搜索全部资料可到资料库。</p>;
  return (
    <>
      <p className="topic-wiki-search-count" role="status">找到 {topicSearch.total} 条结果</p>
      <div className="topic-wiki-search-results">
        {topicSearch.results.map((result) => (
          <button
            key={`${result.objectType}:${result.objectId}:${result.versionRef}`}
            type="button"
            className="topic-wiki-search-result"
            onClick={() => dispatchWikiDeepLink(result.navigation as any)}
          >
            <span className="topic-wiki-search-result-body">
              <span className="topic-wiki-search-result-title">{result.title}</span>
              {result.snippet ? <span className="topic-wiki-search-result-snippet">{result.snippet}</span> : null}
              <span className="topic-wiki-search-result-meta">更新于 {formatWikiWhen(result.updatedAt)}</span>
            </span>
            <span className="topic-wiki-search-result-side">
              {/* @ts-ignore */}
              <span className="topic-wiki-search-result-type">{wikiSearchObjectLabel(result.objectType as any)}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export function TopicActivityBody(props: {
  topicActivity: { loading: boolean; error: string | null; hasMore: boolean; loadingMore: boolean; loadMore: () => void; retry: () => void };
  topicActivityEntries: Array<{ id: string; title: string; summary?: string | null; eventType: string; time: string; objectType: string }>;
}): React.JSX.Element {
  const { topicActivity, topicActivityEntries } = props;
  if (topicActivity.loading) return <p className="library-panel-empty">正在加载相关动态…</p>;
  if (topicActivity.error)
    return (
      <div className="library-topic-error" role="alert">
        <strong>相关动态加载失败</strong>
        <p>{topicActivity.error}</p>
        <button type="button" onClick={topicActivity.retry}>重试</button>
      </div>
    );
  if (!topicActivityEntries.length) return <p className="library-panel-empty">还没有与本主题相关的动态。</p>;
  return (
    <>
      <div className="library-topic-cards">
        {topicActivityEntries.map((entry) => {
          const navigable = wikiLogEntryDeepLinkInput(entry as any) !== null;
          return (
            <article key={entry.id} className="library-topic-card">
              <header>
                <strong>{entry.title}</strong>
                <div className="library-topic-card-badges">
                  {/* @ts-ignore */}
                <span className="library-topic-badge">{wikiLogEventLabel(entry.eventType as any)}</span>
                  <time>{formatWikiWhen(entry.time)}</time>
                </div>
              </header>
              {entry.summary ? <p>{entry.summary}</p> : null}
              <div className="library-topic-card-meta">
                {/* @ts-ignore */}
                <span>{wikiLogObjectLabel(entry.objectType as any)}</span>
              </div>
              {navigable ? (
                <div className="library-panel-actions">
                  {/* @ts-ignore */}
                  <button type="button" className="text-button" onClick={() => void dispatchWikiLogEntry(entry as any)}>
                    打开
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {topicActivity.hasMore ? (
        <div className="topic-wiki-activity-more">
          <button type="button" disabled={topicActivity.loadingMore} onClick={topicActivity.loadMore}>
            {topicActivity.loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      ) : null}
    </>
  );
}
