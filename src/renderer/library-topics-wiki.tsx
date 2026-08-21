// extracted from library-topics-view.tsx (structural split)
import { SourceMark } from './source-mark';
import { formatWhen, itemKey, relationLabel } from './library-topics-helpers';
import type { DossierItem } from './library-topics-helpers';
import {
  COMPILE_STATE_HINTS,
  COMPILE_STATE_LABELS,
  COMPILE_STATUS_LABELS,
  DOSSIER_CATEGORY_ORDER,
  DOSSIER_LABELS,
  RISK_KIND_LABELS,
  WIKI_TAB_LABELS,
  WIKI_TAB_ORDER,
} from './library-topics-constants';
import { KeyConclusionCard, TopicActivityBody, TopicSearchBody, WikiEvidenceCard, WikiHealthCard, WikiReceiptCard, WikiUsageCard, WikiVersionCard } from './library-topics-parts';
import type { KnowledgeWikiPageVersionRecord } from '../shared/knowledge-flywheel';
import type { TopicWikiBody, TopicWikiDetail } from '../shared/knowledge-topic-library';
import type { DossierCounts } from './library-topics-helpers';
import type { WikiTabId } from './library-topics-constants';
import type { KnowledgeWikiPageRecord } from '../shared/knowledge-flywheel';

export function WikiPageView(props: {
  wikiDetail: TopicWikiDetail | null;
  counts: DossierCounts;
  sourcesPreview: DossierItem[];
  wikiTab: WikiTabId;
  setWikiTab: (tab: WikiTabId) => void;
  wikiCompileStatus: string | null;
  compileState: string;
  wikiRisks: TopicWikiDetail['risks'] | null;
  hasCurrentKnowledge: boolean;
  wikiBody: TopicWikiBody | null;
  restoringVersionId: string | null;
  restoreMessage: string | null;
  onRestore: (version: KnowledgeWikiPageVersionRecord) => void;
  wikiPage: KnowledgeWikiPageRecord | null;
  aiSourcePresentation?: boolean;
  indexHint: string;
  topicSearchQuery: string;
  setTopicSearchQuery: (v: string) => void;
  topicSearch: { loading: boolean; error: string | null; results: Array<{ objectType: string; objectId: string; versionRef: string; title: string; snippet?: string | null; updatedAt?: string | null; navigation: unknown }>; total: number; retry: () => void };
  topicActivity: { loading: boolean; error: string | null; hasMore: boolean; loadingMore: boolean; loadMore: () => void; retry: () => void };
  topicActivityEntries: Array<{ id: string; title: string; summary?: string | null; eventType: string; time: string; objectType: string }>;
  setDeepMode: (v: boolean) => void;
  setDeepCategory: (v: string) => void;
}): React.JSX.Element | null {
  const {
    wikiDetail,
    counts,
    sourcesPreview,
    wikiTab,
    setWikiTab,
    wikiCompileStatus,
    compileState,
    wikiRisks,
    hasCurrentKnowledge,
    wikiBody,
    restoringVersionId,
    restoreMessage,
    onRestore,
    wikiPage,
    aiSourcePresentation,
    indexHint,
    topicSearchQuery,
    setTopicSearchQuery,
    topicSearch,
    topicActivity,
    topicActivityEntries,
    setDeepMode,
    setDeepCategory,
  } = props;
  if (!wikiDetail) return null;
  const dossier = wikiDetail.dossierCounts;
  const evidenceEmpty = !wikiDetail.evidence.items.length;
  const impactEmpty = !wikiDetail.creationImpact.items.length;
  const researchEmpty = !wikiDetail.questions.length && !wikiDetail.healthIssues.items.length;
  const secondaryEmpty = evidenceEmpty && impactEmpty && researchEmpty;
  const receipts = wikiDetail.receipts.items;
  const sourceTotalCount = counts.sources ?? 0;
  const openDeepSources = () => {
    setDeepMode(true);
    setDeepCategory('sources');
  };
  return (
    <div className="topic-wiki-page" data-compile-status={wikiCompileStatus ?? 'none'} data-wiki-tab={wikiTab}>
      <nav className="topic-wiki-tabs" aria-label="主题内容">
        {WIKI_TAB_ORDER.map((tab) => (
          <button key={tab} type="button" className={wikiTab === tab ? 'active' : ''} aria-pressed={wikiTab === tab} onClick={() => setWikiTab(tab)}>
            {WIKI_TAB_LABELS[tab]}
            {tab === 'overview' ? null : <span>{tab === 'sources' ? (counts.sources ?? 0) : tab === 'changes' ? wikiDetail.receipts.total : wikiDetail.versions.total}</span>}
          </button>
        ))}
      </nav>
      {wikiCompileStatus && wikiCompileStatus !== 'current' ? (
        <div className={`topic-wiki-compile-banner ${wikiCompileStatus}`} role="status">
          <strong>{COMPILE_STATUS_LABELS[wikiCompileStatus] ?? wikiCompileStatus}</strong>
          {wikiDetail.wiki?.compileNote ? <span>{wikiDetail.wiki.compileNote}</span> : null}
        </div>
      ) : null}
      {compileState === 'uncompiled' || compileState === 'legacy_shell' ? (
        <div className={`topic-wiki-compile-banner compile-state-${compileState}`} role="status">
          <strong>{COMPILE_STATE_LABELS[compileState]}</strong>
          <span>{COMPILE_STATE_HINTS[compileState]}</span>
        </div>
      ) : null}
      {wikiRisks && (wikiRisks.disputed > 0 || wikiRisks.inference > 0 || wikiRisks.contradicted > 0 || wikiRisks.stale || wikiRisks.failed) ? (
        <div className="topic-wiki-risks" aria-label="当前认识风险">
          {wikiRisks.disputed > 0 ? <span className="library-topic-badge warn">{RISK_KIND_LABELS.disputed} {wikiRisks.disputed}</span> : null}
          {wikiRisks.contradicted > 0 ? <span className="library-topic-badge danger">{RISK_KIND_LABELS.contradicted} {wikiRisks.contradicted}</span> : null}
          {wikiRisks.inference > 0 ? <span className="library-topic-badge info">{RISK_KIND_LABELS.inference} {wikiRisks.inference}</span> : null}
          {wikiRisks.stale ? <span className="library-topic-badge">{RISK_KIND_LABELS.stale}</span> : null}
          {wikiRisks.failed ? <span className="library-topic-badge danger">{COMPILE_STATUS_LABELS.failed}</span> : null}
        </div>
      ) : null}
      <section
        id="topic-wiki-current"
        data-wiki-tab="overview"
        className={`topic-wiki-section topic-wiki-primary${hasCurrentKnowledge ? '' : ' is-empty'}`}
        aria-labelledby="topic-wiki-current-title"
        tabIndex={-1}
      >
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-current-title">当前认识</h3>
          {wikiBody?.asOf ? <span>截至 {formatWhen(wikiBody.asOf)}</span> : null}
        </div>
        {hasCurrentKnowledge ? (
          <>
            {wikiBody?.summary && wikiBody.summary !== '暂无综合摘要。' ? <p className="topic-wiki-summary">{wikiBody.summary}</p> : null}
            {(wikiBody?.keyConclusions ?? []).length ? (
              <div className="library-topic-cards">
                {(wikiBody?.keyConclusions ?? []).map((item, index) => (
                  <KeyConclusionCard key={`${item.noteId}-${index}`} item={item} index={index} />
                ))}
              </div>
            ) : null}
            {(wikiBody?.retainedDisputes ?? []).length ? (
              <section className="library-topic-secondary" aria-label="未解决争议">
                <h4>未解决争议</h4>
                <p className="library-topic-secondary-note">这些主张仍在对抗中，未自动裁决。</p>
                <div className="library-topic-cards">
                  {(wikiBody?.retainedDisputes ?? []).map((item, index) => (
                    <KeyConclusionCard key={`${item.noteId}-${index}-d`} item={item} index={index} />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <div className="topic-wiki-empty">
            <span className="empty-mark" aria-hidden="true">◔</span>
            <strong className="topic-wiki-empty-title">还没有形成可复用的认识</strong>
            <p className="topic-wiki-empty-text">已有资料仍在档案中。继续保存可靠来源，资料员会把其中可验证、可复用的部分整理成当前认识。</p>
            <button type="button" className="secondary-button" onClick={() => setDeepMode(true)}>
              查看已有资料
            </button>
          </div>
        )}
      </section>
      {sourceTotalCount > 0 ? (
        <section className="topic-wiki-section topic-wiki-sources-preview" data-wiki-tab="overview" aria-labelledby="topic-wiki-sources-title">
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-sources-title">已有资料</h3>
            <button type="button" className="text-button" onClick={openDeepSources}>
              查看全部 {sourceTotalCount} 份
            </button>
          </div>
          {sourcesPreview.length ? (
            <div className="topic-wiki-source-list">
              {sourcesPreview.slice(0, 2).map((item) => (
                <article key={itemKey(item)} className="topic-wiki-source-row">
                  <SourceMark canonicalUrl={item.metadata?.originalUrl ?? item.metadata?.sourceUrl ?? null} aiSourcePresentation={Boolean(aiSourcePresentation)} />
                  <div className="topic-wiki-source-body">
                    <div className="topic-wiki-source-title">{item.title}</div>
                    {item.body ? <div className="topic-wiki-source-summary">{item.body}</div> : null}
                    <div className="topic-wiki-source-meta">{formatWhen(item.occurredAt)} · 已归入本主题</div>
                  </div>
                  <span className={`topic-wiki-source-type${item.metadata?.relation === 'primary' ? ' primary' : ''}`}>{relationLabel(item.metadata?.relation)}</span>
                </article>
              ))}
            </div>
          ) : (
            <p className="library-panel-empty">资料正在整理中。</p>
          )}
          {sourcesPreview.length > 2 ? (
            <div className="topic-wiki-source-more">
              <button type="button" className="text-button" onClick={openDeepSources}>
                展开剩余 {sourcesPreview.length - 2} 份资料
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {receipts.length ? (
        <section className="topic-wiki-section topic-wiki-changes topic-wiki-recent" data-wiki-tab="overview" aria-labelledby="topic-wiki-recent-title">
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-recent-title">最近变化</h3>
            <button type="button" className="text-button" onClick={() => setWikiTab('changes')}>
              查看全部
            </button>
          </div>
          <div className="library-topic-cards">
            {receipts.slice(0, 3).map((receipt) => (
              <WikiReceiptCard key={receipt.id} receipt={receipt} />
            ))}
          </div>
        </section>
      ) : null}
      <section
        id="topic-wiki-changes"
        data-wiki-tab="changes"
        className="topic-wiki-section topic-wiki-changes"
        aria-labelledby="topic-wiki-changes-title"
        tabIndex={-1}
      >
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-changes-title">最近变化</h3>
          <span>{wikiDetail.receipts.total} 次更新</span>
        </div>
        {receipts.length ? (
          <div className="library-topic-cards">
            {receipts.map((receipt) => (
              <WikiReceiptCard key={receipt.id} receipt={receipt} />
            ))}
          </div>
        ) : (
          <p className="library-panel-empty">最近还没有认识变化。</p>
        )}
      </section>
      <section className="topic-wiki-section topic-wiki-changes topic-wiki-activity" data-wiki-tab="changes"
        aria-labelledby="topic-wiki-activity-title"
        tabIndex={-1}
      >
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-activity-title">相关动态</h3>
          <span>资料摄取 · 检查 · 问答</span>
        </div>
        <TopicActivityBody topicActivity={topicActivity} topicActivityEntries={topicActivityEntries} />
      </section>
      <section className="topic-wiki-section topic-wiki-search" data-wiki-tab="sources"
        aria-labelledby="topic-wiki-search-title"
        tabIndex={-1}
      >
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-search-title">搜索本主题资料</h3>
          <span className="topic-index-hint" role="status">{indexHint}</span>
        </div>
        <div className="topic-wiki-search-field">
          <input
            type="search"
            className="topic-wiki-search-input"
            placeholder="在本主题的资料、知识与实体中检索"
            aria-label="搜索本主题资料"
            value={topicSearchQuery}
            onChange={(event) => setTopicSearchQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <TopicSearchBody topicSearch={topicSearch} topicSearchQuery={topicSearchQuery} />
      </section>
      <div className="topic-wiki-secondary" data-wiki-tab="sources" aria-label="认识储备">
        {secondaryEmpty ? <p className="topic-wiki-secondary-empty">认识仍在积累：证据、创作影响与待研究会在情报回流后出现。</p> : null}
        <section
          id="topic-wiki-evidence"
          className="topic-wiki-section topic-wiki-compact"
          aria-labelledby="topic-wiki-evidence-title"
          tabIndex={-1}
        >
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-evidence-title">证据</h3>
            <span>{wikiDetail.evidence.total} 条</span>
          </div>
          {wikiDetail.evidence.items.length ? (
            <div className="library-topic-cards">
              {wikiDetail.evidence.items.map((entry) => (
                <WikiEvidenceCard key={entry.id} entry={entry} />
              ))}
            </div>
          ) : !secondaryEmpty ? (
            <p className="library-panel-empty">暂无证据条目。</p>
          ) : null}
        </section>
        <section
          id="topic-wiki-impact"
          className="topic-wiki-section topic-wiki-compact"
          aria-labelledby="topic-wiki-impact-title"
          tabIndex={-1}
        >
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-impact-title">创作影响</h3>
            <span>{wikiDetail.creationImpact.total} 条</span>
          </div>
          {wikiDetail.creationImpact.items.length ? (
            <div className="library-topic-cards">
              {wikiDetail.creationImpact.items.map((record) => (
                <WikiUsageCard key={record.id} record={record} />
              ))}
            </div>
          ) : !secondaryEmpty ? (
            <p className="library-panel-empty">暂无创作使用记录（创作参考当前认识后出现）。</p>
          ) : null}
        </section>
        <section
          id="topic-wiki-research"
          className="topic-wiki-section topic-wiki-compact"
          aria-labelledby="topic-wiki-research-title"
          tabIndex={-1}
        >
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-research-title">待研究</h3>
            <span>{wikiDetail.questions.length + wikiDetail.healthIssues.total} 项</span>
          </div>
          {wikiDetail.questions.length ? (
            <div className="library-topic-cards">
              {wikiDetail.questions.map((question, index) => (
                <article key={`q-${index}`} className="library-topic-card">
                  <p>{question}</p>
                </article>
              ))}
            </div>
          ) : null}
          {wikiDetail.healthIssues.items.length ? (
            <div className="library-topic-cards">
              {wikiDetail.healthIssues.items.map((issue) => (
                <WikiHealthCard key={issue.id} issue={issue} />
              ))}
            </div>
          ) : null}
          {!wikiDetail.questions.length && !wikiDetail.healthIssues.items.length && !secondaryEmpty ? <p className="library-panel-empty">暂无待研究问题。</p> : null}
        </section>
        <section
          id="topic-wiki-dossier"
          className="topic-wiki-section topic-wiki-compact topic-wiki-dossier"
          aria-labelledby="topic-wiki-dossier-title"
          tabIndex={-1}
        >
          <div className="library-topic-section-head">
            <h3 id="topic-wiki-dossier-title">完整档案</h3>
            <span>八类档案</span>
          </div>
          {dossier && Object.values(dossier).some((count) => count > 0) ? (
            <div className="topic-wiki-dossier-counts" aria-label="档案分类计数">
              {DOSSIER_CATEGORY_ORDER.map((category) => (
                <span key={category} className="library-topic-badge">
                  {DOSSIER_LABELS[category]} {dossier[category] ?? 0}
                </span>
              ))}
            </div>
          ) : (
            <p className="library-panel-empty">档案会在资料入库后建立。</p>
          )}
          <div className="library-panel-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setDeepMode(true);
                setDeepCategory('');
              }}
            >
              打开完整档案
            </button>
          </div>
        </section>
      </div>
      <section
        id="topic-wiki-versions"
        data-wiki-tab="versions"
        className="topic-wiki-section topic-wiki-compact topic-wiki-versions"
        aria-labelledby="topic-wiki-versions-title"
        tabIndex={-1}
      >
        <div className="library-topic-section-head">
          <h3 id="topic-wiki-versions-title">版本</h3>
          <span>{wikiDetail.versions.total} 个版本</span>
        </div>
        {wikiDetail.versions.items.length ? (
          <div className="library-topic-cards">
            {wikiDetail.versions.items.map((version) => (
              <WikiVersionCard key={version.id} version={version} isCurrent={version.id === wikiPage?.currentVersionId} restoringVersionId={restoringVersionId} onRestore={onRestore} />
            ))}
          </div>
        ) : (
          <p className="library-panel-empty">暂无版本记录。</p>
        )}
        {restoreMessage ? <p className="library-topic-action-note" role="status">{restoreMessage}</p> : null}
      </section>
    </div>
  );
}
