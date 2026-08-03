import type { PiFocusObject } from './app-types';
import { useEffect, useRef, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import { SourceMark } from './source-mark';
import { PlatformMark } from './platform-mark';
import { formatNames, platformNames } from './app-types';
import { dailyPreflightMessage } from './intelligence-channel-ui';
import { Icon, domainOf, formatSourcePublishedAt } from './today-view-parts';

import { asSourceKnowledgeContext, isLibrarySection, type KnowledgeSourcePage, type LibrarySection, type LibrarySourceItem, type RediscoveryItem, type SourceKnowledgeContext } from './library-view-parts';

export function LibraryView(props: {
  onOpenTopic?: (topicId: string) => void;
  onOpenStudio?: (projectId: string) => void;
  onOpenCanvas?: (canvasId?: string) => void;
  focusSourceId?: string | null;
  onFocusSourceConsumed?: () => void;
  onFocusChange?: (focus: PiFocusObject | null) => void; aiSourcePresentation: boolean; sectionStorageKey: string;
}): React.JSX.Element {
  const { onOpenTopic, focusSourceId, onFocusSourceConsumed, onFocusChange, aiSourcePresentation, sectionStorageKey } = props;
  const storedSection = localStorage.getItem(sectionStorageKey);
  const initialSection = storedSection === 'topics' ? 'saved' : storedSection;
  const [section, setSection] = useState<LibrarySection>(isLibrarySection(initialSection) ? initialSection : 'saved');
  const [knowledge, setKnowledge] = useState<KnowledgeSourcePage | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('');
  const [managementFilter, setManagementFilter] = useState('');
  const [knowledgeOffset, setKnowledgeOffset] = useState(0);
  const [sourceContext, setSourceContext] = useState<SourceKnowledgeContext | null>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<LibrarySourceItem | null>(null);
  const [libraryBody, setLibraryBody] = useState<Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>>(null);
  const [libraryBodyLoading, setLibraryBodyLoading] = useState(false);
  const [libraryBodyError, setLibraryBodyError] = useState('');
  const [rediscovery, setRediscovery] = useState<{ unused: RediscoveryItem[]; watching: RediscoveryItem[]; pending: RediscoveryItem[] }>({ unused: [], watching: [], pending: [] });
  const [watchingBoard, setWatchingBoard] = useState<LibrarySourceItem[]>([]);
  const [editingSource, setEditingSource] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [sourceActionError, setSourceActionError] = useState('');
  const [sourceActionBusy, setSourceActionBusy] = useState(false);
  const [pendingSourceAction, setPendingSourceAction] = useState<null | 'archive' | 'delete'>(null);
  const focusRequestId = useRef(0);
  const publishFocus = (source: LibrarySourceItem | null, body: Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>> | null = null) => {
    if (!onFocusChange) return;
    if (!source) {
      onFocusChange(null);
      return;
    }
    const excerpt = body?.status === 'ready' && body.extractedText?.trim()
      ? body.extractedText.slice(0, 6000)
      : null;
    onFocusChange({
      type: 'source',
      id: source.id,
      title: source.title,
      summary: source.summary ?? null,
      url: source.originalUrl ?? null,
      bodyStatus: body?.status ?? 'none',
      bodyExcerpt: excerpt,
      bodyChars: body?.extractedChars ?? excerpt?.length ?? 0,
      meta: {
        author: source.author ?? null,
        publishedAt: source.publishedAt ?? null,
        collectedAt: source.collectedAt ?? null,
        verificationStatus: source.verificationStatus ?? null,
        managementStatus: source.managementStatus ?? null,
        topics: source.topics ?? ''
      }
    });
  };


  const openSection = (next: LibrarySection) => {
    setSection(next);
    localStorage.setItem(sectionStorageKey, next);
  };

  const openSourceDrawer = async (source: LibrarySourceItem) => {
    const requestId = ++focusRequestId.current;
    setSelectedKnowledge(source);
    setLibraryBody(null);
    setLibraryBodyError('');
    setLibraryBodyLoading(true);
    publishFocus(source, null);
    try {
      const [context, body] = await Promise.all([
        window.wmb.getKnowledgeContext({ sourceId: source.id }),
        window.wmb.getSourceBodyCache(source.id)
      ]);
      if (requestId !== focusRequestId.current) return;
      setSourceContext(asSourceKnowledgeContext(context));
      setLibraryBody(body);
      publishFocus(source, body);
    } catch (error) {
      if (requestId !== focusRequestId.current) return;
      setLibraryBodyError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === focusRequestId.current) setLibraryBodyLoading(false);
    }
  };
  const fetchLibraryBody = async (force = false) => {
    if (!selectedKnowledge) return;
    const source = selectedKnowledge;
    const requestId = ++focusRequestId.current;
    setLibraryBodyLoading(true);
    setLibraryBodyError('');
    try {
      const body = await window.wmb.fetchSourceBody({ sourceId: source.id, force, maxChars: 20000 });
      if (requestId !== focusRequestId.current) return;
      setLibraryBody(body);
      publishFocus(source, body);
    } catch (error) {
      if (requestId !== focusRequestId.current) return;
      setLibraryBodyError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === focusRequestId.current) setLibraryBodyLoading(false);
    }
  };
  const loadWatchingBoard = async () => {
    const rows = await window.wmb.listWatchingSources({ limit: 30 });
    setWatchingBoard((rows ?? []) as LibrarySourceItem[]);
  };

  const loadKnowledge = async () => {
    const page = await window.wmb.listKnowledgeSources({
      query: knowledgeQuery,
      verificationStatus: verificationFilter || undefined,
      managementStatus: managementFilter || undefined,
      limit: 50,
      offset: knowledgeOffset
    });
    if (!page) {
      setKnowledge(null);
      return;
    }
    setKnowledge({
      items: (page.items ?? []) as LibrarySourceItem[],
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore
    });
  };

  useEffect(() => {
    if (section === 'saved') {
      void loadKnowledge();
      void loadWatchingBoard();
    }
  }, [section, knowledgeQuery, verificationFilter, managementFilter, knowledgeOffset]);
  useEffect(() => {
    if (section !== 'saved') return;
    return window.wmb.onDataChanged((event) => {
      if (!event.scopes.includes('library') && !event.scopes.includes('sources')) return;
      void loadKnowledge();
      void loadWatchingBoard();
    });
  }, [section, knowledgeQuery, verificationFilter, managementFilter, knowledgeOffset]);
  useEffect(() => {
    if (!focusSourceId || section !== 'saved' || !knowledge?.items?.length) return;
    const hit = knowledge.items.find((item) => item.id === focusSourceId);
    if (hit) {
      void openSourceDrawer(hit);
      onFocusSourceConsumed?.();
      return;
    }
    void openSourceDrawer({ id: focusSourceId, title: '定位中的资料' });
    onFocusSourceConsumed?.();
  }, [focusSourceId, section, knowledge?.items?.map((item) => item.id).join('|')]);

  useEffect(() => {
    if (section === 'rediscovery') {
      void window.wmb.getRediscovery().then((value) => {
        setRediscovery({
          unused: (value?.unused ?? []) as RediscoveryItem[],
          watching: (value?.watching ?? []) as RediscoveryItem[],
          pending: (value?.pending ?? []) as RediscoveryItem[]
        });
      });
    }
  }, [section]);

  const closeSourceDetail = () => {
    focusRequestId.current += 1;
    setSourceContext(null);
    setSelectedKnowledge(null);
    setLibraryBody(null);
    setLibraryBodyError('');
    setEditingSource(false);
    setSourceActionError('');
    setPendingSourceAction(null);
    publishFocus(null);
  };
  const beginEditSource = () => {
    if (!selectedKnowledge) return;
    setEditTitle(selectedKnowledge.title || '');
    setEditSummary(selectedKnowledge.summary || '');
    setEditAuthor(selectedKnowledge.author || '');
    setSourceActionError('');
    setEditingSource(true);
  };
  const saveSourceEdits = async () => {
    if (!selectedKnowledge || selectedKnowledge.revision == null) return;
    const title = editTitle.trim();
    if (!title) {
      setSourceActionError('标题不能为空');
      return;
    }
    setSourceActionBusy(true);
    setSourceActionError('');
    try {
      const result = await window.wmb.updateKnowledgeSource({
        id: selectedKnowledge.id,
        expectedRevision: selectedKnowledge.revision,
        title,
        summary: editSummary.trim() || null,
        author: editAuthor.trim() || null
      });
      const next = {
        ...selectedKnowledge,
        title,
        summary: editSummary.trim() || null,
        author: editAuthor.trim() || null,
        revision: result.revision
      };
      setSelectedKnowledge(next);
      setEditingSource(false);
      publishFocus(next, libraryBody);
      void loadKnowledge();
      void loadWatchingBoard();
    } catch (error) {
      setSourceActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSourceActionBusy(false);
    }
  };
  const archiveSelectedSource = async () => {
    if (!selectedKnowledge || selectedKnowledge.revision == null) return;
    setSourceActionBusy(true);
    setSourceActionError('');
    try {
      await window.wmb.updateKnowledgeSource({
        id: selectedKnowledge.id,
        expectedRevision: selectedKnowledge.revision,
        managementStatus: 'archived'
      });
      closeSourceDetail();
      void loadKnowledge();
      void loadWatchingBoard();
    } catch (error) {
      setSourceActionError(error instanceof Error ? error.message : String(error));
      setPendingSourceAction(null);
    } finally {
      setSourceActionBusy(false);
    }
  };
  const deleteSelectedSource = async () => {
    if (!selectedKnowledge || selectedKnowledge.revision == null) return;
    setSourceActionBusy(true);
    setSourceActionError('');
    try {
      await window.wmb.deleteKnowledgeSource({
        id: selectedKnowledge.id,
        expectedRevision: selectedKnowledge.revision
      });
      closeSourceDetail();
      void loadKnowledge();
      void loadWatchingBoard();
    } catch (error) {
      setSourceActionError(error instanceof Error ? error.message : String(error));
      setPendingSourceAction(null);
    } finally {
      setSourceActionBusy(false);
    }
  };

  if (selectedKnowledge) {
    const metaBits = [
      selectedKnowledge.managementStatus === 'watching' ? '观察中' : null,
      formatSourcePublishedAt(selectedKnowledge.publishedAt) ?? formatSourcePublishedAt(selectedKnowledge.collectedAt),
      selectedKnowledge.author || null,
      domainOf(selectedKnowledge.originalUrl ?? null)
    ].filter(Boolean);
    return <section className="page library-page library-source-detail-page">
      <header className="library-source-detail-head">
        <button className="text-button" onClick={closeSourceDetail}>← 返回资料库</button>
        <div className="library-source-detail-actions">
          {!editingSource ? <button className="secondary-button" disabled={sourceActionBusy} onClick={beginEditSource}>编辑</button> : null}
          <button className="secondary-button" disabled={libraryBodyLoading || sourceActionBusy} onClick={() => void fetchLibraryBody(false)}>{libraryBody?.status === 'ready' ? '刷新正文' : '抓取正文'}</button>
          {libraryBody?.status === 'ready' ? <button className="secondary-button" disabled={libraryBodyLoading || sourceActionBusy} onClick={() => void fetchLibraryBody(true)}>强制重抓</button> : null}
          {selectedKnowledge.originalUrl ? <button className="secondary-button" onClick={() => void window.wmb.openExternal(selectedKnowledge.originalUrl!)}>打开原文 ↗</button> : null}
          <button className="secondary-button" disabled={sourceActionBusy || selectedKnowledge.revision == null} onClick={() => { setSourceActionError(''); setPendingSourceAction('archive'); }}>归档</button>
          <button className="text-button danger-button" disabled={sourceActionBusy || selectedKnowledge.revision == null} onClick={() => { setSourceActionError(''); setPendingSourceAction('delete'); }}>删除</button>
        </div>
      </header>
      <article className="library-source-detail">
        {sourceActionError ? <p className="source-detail-error">{sourceActionError}</p> : null}
        {pendingSourceAction ? (
          <div className="library-source-confirm" role="group" aria-label={pendingSourceAction === 'delete' ? '确认删除' : '确认归档'}>
            <p>{pendingSourceAction === 'delete'
              ? `永久删除「${selectedKnowledge.title}」？不可恢复。`
              : `归档「${selectedKnowledge.title}」后，默认列表不再显示。`}</p>
            <div className="library-source-detail-actions">
              <button
                className={pendingSourceAction === 'delete' ? 'primary-button danger-button' : 'primary-button'}
                disabled={sourceActionBusy}
                onClick={() => { void (pendingSourceAction === 'delete' ? deleteSelectedSource() : archiveSelectedSource()); }}
              >{pendingSourceAction === 'delete' ? '确认删除' : '确认归档'}</button>
              <button className="secondary-button" disabled={sourceActionBusy} onClick={() => setPendingSourceAction(null)}>取消</button>
            </div>
          </div>
        ) : null}
        {editingSource ? (
          <div className="library-source-edit">
            <label>标题<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
            <label>作者<input value={editAuthor} onChange={(event) => setEditAuthor(event.target.value)} /></label>
            <label>摘要<textarea value={editSummary} rows={6} onChange={(event) => setEditSummary(event.target.value)} /></label>
            <div className="library-source-detail-actions">
              <button className="primary-button" disabled={sourceActionBusy} onClick={() => void saveSourceEdits()}>保存</button>
              <button className="secondary-button" disabled={sourceActionBusy} onClick={() => { setEditingSource(false); setSourceActionError(''); }}>取消</button>
            </div>
          </div>
        ) : (
          <>
            <h1>{selectedKnowledge.title}</h1>
            {metaBits.length ? <p className="library-source-detail-meta">{metaBits.join(' · ')}</p> : null}
          </>
        )}
        <div className="knowledge-status-controls">
          <label>核验<select value={selectedKnowledge.verificationStatus ?? 'pending'} disabled={sourceActionBusy || selectedKnowledge.revision == null} onChange={async (event) => {
            if (selectedKnowledge.revision == null) return;
            const result = await window.wmb.updateKnowledgeSource({ id: selectedKnowledge.id, expectedRevision: selectedKnowledge.revision, verificationStatus: event.target.value });
            setSelectedKnowledge({ ...selectedKnowledge, verificationStatus: event.target.value, revision: result.revision });
            void loadKnowledge();
          }}><option value="pending">待核验</option><option value="verified">已核验</option><option value="disputed">有争议</option><option value="rejected">已排除</option></select></label>
          <label>管理<select value={selectedKnowledge.managementStatus ?? 'active'} disabled={sourceActionBusy || selectedKnowledge.revision == null} onChange={async (event) => {
            if (selectedKnowledge.revision == null) return;
            const result = await window.wmb.updateKnowledgeSource({ id: selectedKnowledge.id, expectedRevision: selectedKnowledge.revision, managementStatus: event.target.value });
            setSelectedKnowledge({ ...selectedKnowledge, managementStatus: event.target.value, revision: result.revision });
            void loadKnowledge();
            void loadWatchingBoard();
          }}><option value="active">活跃</option><option value="watching">观察中</option><option value="expired">已过期</option><option value="archived">已归档</option></select></label>
        </div>
        {!editingSource ? <section>
          <h2>摘要</h2>
          <p>{selectedKnowledge.summary || '暂无摘要'}</p>
        </section> : null}
        <section>
          <div className="source-detail-body-head">
            <h2>正文</h2>
            <span className="source-detail-body-status">{libraryBodyLoading ? '处理中…' : libraryBody?.status === 'ready' ? `已缓存 ${libraryBody.extractedChars} 字` : libraryBody?.status === 'failed' ? '抓取失败' : libraryBody?.status === 'empty' ? '无正文' : '尚未抓取'}</span>
          </div>
          {libraryBodyError ? <p className="source-detail-error">{libraryBodyError}</p> : null}
          {libraryBody?.errorMessage ? <p className="source-detail-error">{libraryBody.errorMessage}</p> : null}
          {libraryBody?.status === 'ready' && libraryBody.extractedText
            ? <div className="library-source-detail-body">{libraryBody.extractedText}</div>
            : <p className="empty-copy">暂无正文</p>}
        </section>
        <section>
          <h2>关联</h2>
          <p className="library-source-detail-meta">主题 {sourceContext?.topics.length ?? 0} · 机会 {sourceContext?.opportunities.length ?? 0} · 项目 {sourceContext?.projects.length ?? 0} · 发布 {sourceContext?.publications.length ?? 0}</p>
          <div className="library-source-detail-links">
            {(sourceContext?.topics ?? []).map((item) => <button key={item.id} className="secondary-button" onClick={() => onOpenTopic?.(item.id)}>{item.title}</button>)}
          </div>
          {(sourceContext?.reviews ?? []).map((review) => <article className="library-source-detail-note" key={review.id}><strong>复盘</strong><p>{review.summary || '无摘要'}</p></article>)}
          {(sourceContext?.findings ?? []).map((finding) => <article className="library-source-detail-note" key={finding.id}><strong>{finding.title}</strong><p>{finding.body}</p></article>)}
        </section>
      </article>
    </section>;
  }

  return <section className="page library-page">
    <nav className="library-sections" aria-label="资料库分页面">
      <button className={section === 'saved' ? 'active' : ''} onClick={() => openSection('saved')}>资料</button>
      <button className={section === 'rediscovery' ? 'active' : ''} onClick={() => openSection('rediscovery')}>重新发现</button>
    </nav>

    {section === 'saved' ? <>
      {watchingBoard.length > 0 && managementFilter !== 'watching' && <section className="library-watching-board" aria-label="观察中">
        <div className="library-watching-head">
          <h2>观察中 · {watchingBoard.length}</h2>
        </div>
        <div className="library-watching-list">
          {watchingBoard.map((source) => (
            <article
              className="library-watching-card"
              key={`watch-${source.id}`}
              role="button"
              tabIndex={0}
              onClick={() => { void openSourceDrawer(source); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  void openSourceDrawer(source);
                }
              }}
            >
              <div className="library-watching-title">{source.title}</div>
              <div className="library-watching-meta">
                <span>观察中</span>
                <span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? ''}</span>
              </div>
              {source.summary ? <p>{source.summary}</p> : null}
            </article>
          ))}
        </div>
      </section>}
      <div className="page-toolbar knowledge-toolbar">
        <input aria-label="搜索资料" placeholder="搜索标题、摘要或关键词" value={knowledgeQuery} onChange={(e) => { setKnowledgeQuery(e.target.value); setKnowledgeOffset(0); }}/>
        <span className="chip-label">核验</span>
        {([['', '全部'], ['verified', '已核验'], ['pending', '待核验'], ['disputed', '有争议'], ['rejected', '已排除']] as const).map(([value, label]) => <button key={value} className={`chip${verificationFilter === value ? ' on' : ''}`} aria-label={`核验状态 ${label}`} onClick={() => { setVerificationFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
        <span className="chip-label">管理</span>
        {([['', '全部'], ['active', '活跃'], ['watching', '观察中'], ['expired', '已过期'], ['archived', '已归档']] as const).map(([value, label]) => <button key={value} className={`chip${managementFilter === value ? ' on' : ''}`} aria-label={`管理状态 ${label}`} onClick={() => { setManagementFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
      </div>
      {knowledge?.items.length ? <div className="library-list">{knowledge.items.map((source) => {
        const statePill = source.managementStatus === 'watching' ? { cls: 'blue', text: '观察中' }
          : source.managementStatus === 'archived' ? { cls: 'gray', text: '已归档' }
          : source.managementStatus === 'expired' ? { cls: 'gray', text: '已过期' }
          : source.verificationStatus === 'verified' ? { cls: 'green', text: '已验证' }
          : source.verificationStatus === 'disputed' ? { cls: 'amber', text: '有争议' }
          : source.verificationStatus === 'rejected' ? { cls: 'gray', text: '已排除' }
          : { cls: 'gray', text: '待验证' };
        const tags = String(source.topics || '').split(/[,，、]/).map((tag) => tag.trim()).filter((tag) => tag && tag !== '尚未归入主题').slice(0, 4);
        return <article className="lib-row" key={source.id} onClick={() => { void openSourceDrawer(source); }}>
          <SourceMark canonicalUrl={source.originalUrl ?? null} aiSourcePresentation={aiSourcePresentation}/>
          <div className="lib-main">
            <div className="lib-title">{source.title}</div>
            <div className="lib-sum">{source.summary || '暂无摘要'}</div>
            <div className="lib-tags">{tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}<span className="tag lib-count">机会 {source.opportunityCount ?? 0} · 内容 {source.projectCount ?? 0} · 发布 {source.publicationCount ?? 0}</span></div>
          </div>
          <div className="lib-side">
            <span className={`pill-status ${statePill.cls}`}><span className="dot"/>{statePill.text}</span>
            <span className="lib-time">{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt)}</span>
            {source.originalUrl ? <button onClick={(event) => { event.stopPropagation(); const url = source.originalUrl; if (url) void window.wmb.openExternal(url); }}>原文 ↗</button> : null}
          </div>
        </article>;
      })}</div> : <section className="empty-state library-empty"><h2>没有匹配资料</h2><p>调整搜索或筛选条件后再看。</p></section>}
      <div className="knowledge-pager"><button disabled={knowledgeOffset === 0} onClick={() => setKnowledgeOffset(Math.max(0, knowledgeOffset - 50))}>上一页</button><span>{knowledgeOffset + 1}–{Math.min(knowledgeOffset + 50, knowledge?.total ?? 0)} / {knowledge?.total ?? 0}</span><button disabled={!knowledge?.hasMore} onClick={() => setKnowledgeOffset(knowledgeOffset + 50)}>下一页</button></div>
    </> : <div className="rediscovery-groups">{([['高价值但尚未创作', rediscovery.unused], ['持续观察', rediscovery.watching], ['待核验超过 7 天', rediscovery.pending]] as const).map(([title, items]) => <section key={title}><h2>{title}<span>{items.length}</span></h2>{items.length ? items.map((item) => <button key={item.id} onClick={() => { void openSourceDrawer(item); openSection('saved'); }}><strong>{item.title}</strong><small>{item.reason}</small></button>) : <p>当前没有此类资料。</p>}</section>)}</div>}
  </section>;
}

