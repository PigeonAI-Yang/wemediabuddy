import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import { SourceMark } from './source-mark';
import './styles.css';

type View = 'today' | 'library' | 'studio' | 'publish' | 'results' | 'diagnostics' | 'settings';
type Theme = 'dark' | 'light';
type PiContextRef = {
  page: View;
  pageLabel: string;
  objectType: string | null;
  objectId: string | null;
  objectTitle: string | null;
};

const platformNames: Record<string, string> = { x: 'X', xiaohongshu: '小红书', wechat: '微信公众号' };
const formatNames: Record<string, string> = { text: '观点短文', article: '文章', image: '图文', video: '视频', short_video: '口播视频' };

function formatSourcePublishedAt(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function latestSourcePublishedAt(sourceIds: string[], sources: TodaySource[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latest: string | null = null;
  for (const id of sourceIds) {
    const source = sources.find((item) => item.id === id);
    if (!source?.publishedAt) continue;
    const ms = Date.parse(source.publishedAt);
    if (Number.isNaN(ms)) {
      if (!latest) latest = source.publishedAt;
      continue;
    }
    if (ms >= latestMs) {
      latestMs = ms;
      latest = source.publishedAt;
    }
  }
  return latest;
}

type PriorityGrade = 'SSS' | 'S' | 'A' | 'B' | 'C';

function priorityGrade(value: number | null | undefined): PriorityGrade {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'C';
  if (n <= 0) return 'SSS';
  if (n === 1) return 'S';
  if (n === 2) return 'A';
  if (n === 3) return 'B';
  return 'C';
}

function priorityLabel(value: number | null | undefined): string {
  return `${priorityGrade(value)}级`;
}
const logoUrl = new URL('../../images/logo.png', import.meta.url).href;

function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.JSX.Element> = {
    today: <><path d="M3 5h18v16H3z"/><path d="M7 3v4M17 3v4M3 10h18"/></>,
    library: <><path d="M3 4h7l2 3h9v13H3z"/></>,
    studio: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"/><path d="m13.5 7 3.5 3.5"/></>,
    publish: <><path d="m3 11 18-8-7 18-3-7z"/><path d="m11 14 10-11"/></>,
    results: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    diagnosis: <><path d="M12 2v4M5 5l3 3M2 12h4M5 19l3-3M12 22v-4M19 19l-3-3M22 12h-4M19 5l-3 3"/><circle cx="12" cy="12" r="3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></>
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function SourceList({ sources, ids, open, close, openLibrary }: { sources: TodaySource[]; ids: string[]; open: boolean; close: () => void; openLibrary: () => void }): React.JSX.Element {
  const selected = ids.map((id) => sources.find((source) => source.id === id)).filter(Boolean) as TodaySource[];
  return <aside className={`sources-panel${open ? ' open' : ''}`} aria-label="关联资料">
    <div className="panel-heading">
      <div><h2>首选机会的关联资料</h2><button className="close-sources" aria-label="关闭关联资料" onClick={close}>×</button></div>
      <p>已保存到终端，可追溯原始来源</p>
    </div>
    <div className="source-list">
      {selected.map((source) => <article className="source-row" key={source.id}>
        <SourceMark canonicalUrl={source.canonicalUrl}/>
        <div>
          <span className="source-type">{source.categories[0] || '入库资料'}</span>
          <h3>{source.title}</h3>
          <p>{formatSourcePublishedAt(source.publishedAt) ?? '发布时间未知'}{source.author ? ` · ${source.author}` : (domainOf(source.canonicalUrl) ? ` · ${domainOf(source.canonicalUrl)}` : '')}</p>
        </div>
        {source.canonicalUrl && <button className="text-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}
      </article>)}
      {!selected.length && <p className="empty-copy">当前机会没有可展示的关联资料。</p>}
    </div>
    <button className="wide-secondary" onClick={openLibrary}>查看全部入库资料 <span>›</span></button>
  </aside>;
}

function Opportunity({ item, primary, onCreate, sources }: { item: TodayPlanItem; primary?: boolean; onCreate: (item: TodayPlanItem) => void; sources: TodaySource[] }): React.JSX.Element {
  const publishedAt = latestSourcePublishedAt(item.sourceIds, sources);
  const publishedLabel = formatSourcePublishedAt(publishedAt) ?? '发布时间未知';
  if (!primary) return <article className="opportunity-small">
    <div className="opportunity-tags"><strong data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong><time dateTime={publishedAt ?? undefined}>{publishedLabel}</time></div>
    <h3>{item.title}</h3>
    <dl><dt>为什么现在值得做</dt><dd>{item.whyNow}</dd><dt>建议表达角度</dt><dd>{item.angle}</dd></dl>
    <footer><span>关联资料 {item.sourceIds.length} 条</span><span>{item.platforms.map((value) => platformNames[value] || value).join('、')}</span><button onClick={() => onCreate(item)}>进入创作</button></footer>
  </article>;
  return <article className="opportunity-primary">
    <div className="opportunity-tags"><strong data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong><time dateTime={publishedAt ?? undefined}>{publishedLabel}</time><span>关联资料 {item.sourceIds.length} 条</span></div>
    <h2>{item.title}</h2>
    <div className="editorial-brief">
      <dl className="brief-core">
        <div><dt>为什么现在</dt><dd>{item.whyNow}</dd></div>
        <div><dt>表达角度</dt><dd>{item.angle}</dd></div>
        <div><dt>核心观点</dt><dd>{item.pointOfView}</dd></div>
      </dl>
      <section className="how-to">
        <h3>怎么讲</h3>
        <dl className="brief-how">
          <div><dt>标题</dt><dd>{item.titleGuidance}</dd></div>
          <div><dt>开头</dt><dd>{item.openingGuidance}</dd></div>
          <div><dt>结构</dt><dd>{item.structureGuidance}</dd></div>
        </dl>
      </section>
    </div>
    <footer>
      <div className="meta-line">
        <span>平台：{item.platforms.map((value) => platformNames[value] || value).join('、')}</span>
        <span>形式：{item.formats.map((value) => formatNames[value] || value).join('、')}</span>
        <span>制作：{item.effortEstimate}</span>
      </div>
      <button className="primary-button" onClick={() => onCreate(item)}>进入创作</button>
    </footer>
  </article>;
}

function TodayView({ today, refresh, openStudio, openLibrary, onPrimaryChange, planDate }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void;
  openStudio: () => void;
  openLibrary: () => void;
  onPrimaryChange: (item: TodayPlanItem | null) => void;
  planDate: string;
}): React.JSX.Element {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [taskStatus, setTaskStatus] = useState<string>('');
  const [running, setRunning] = useState(false);
  const sources = today?.sources ?? [];
  const items = today?.plan?.items ?? [];
  const primary = items[0] ?? null;
  useEffect(() => { onPrimaryChange(primary); }, [primary?.id]);
  useEffect(() => {
    void window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: planDate }).then((task) => {
      const value = task as { status?: string; phase?: string; errorMessage?: string | null } | null;
      if (!value) return;
      if (value.status === 'running') setTaskStatus(value.phase === 'starting' ? '今日情报正在启动…' : '今日情报正在生成…');
      if (value.status === 'failed') setTaskStatus(value.errorMessage || '今日情报失败');
      if (value.status === 'interrupted') setTaskStatus('上次情报任务已中断，可重新开始');
      if (value.status === 'succeeded') setTaskStatus('');
    }).catch(() => {});
  }, [planDate, today?.plan?.id]);
  const create = async (item: TodayPlanItem) => { await window.wmb.createProjectFromPlanItem(item.id); openStudio(); };
  const startIntelligence = async () => {
    if (running) return;
    setRunning(true);
    setTaskStatus('今日情报正在启动…');
    try {
      const result = await window.wmb.startDailyIntelligence(planDate) as {
        ok: boolean;
        data?: { task?: { status?: string; phase?: string; errorMessage?: string | null; resultRefs?: { opportunityCount?: number } }; reused?: boolean };
        error?: { message?: string } | null;
      };
      if (!result.ok) {
        setTaskStatus(result.error?.message || '今日情报失败');
        return;
      }
      if (result.data?.reused) {
        setTaskStatus('今日情报已在运行，已复用当前任务');
      } else if (result.data?.task?.status === 'succeeded') {
        setTaskStatus(`已生成 ${result.data.task.resultRefs?.opportunityCount ?? 0} 个内容机会`);
      } else {
        setTaskStatus(result.data?.task?.errorMessage || result.data?.task?.status || '今日情报已完成');
      }
      refresh();
    } catch (error) {
      setTaskStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      window.setTimeout(() => refresh(), 300);
    }
  };
  return <div className="today-layout">
    <section className="today-main">
      <header className="page-heading">
        <div><h1>今日内容简报</h1></div>
        <div className="heading-actions">
          <button className="primary-button" disabled={running} onClick={() => void startIntelligence()}>{running ? '生成中…' : '开始今日情报'}</button>
          <button className="sources-toggle" onClick={() => setSourcesOpen(true)}>查看资料</button>
          <button className="refresh-button" onClick={refresh}>↻ 刷新</button>
        </div>
      </header>
      {taskStatus && <p className="task-status" data-running={running ? 'true' : 'false'}>{taskStatus}</p>}
      {primary ? <div className="today-feed">
        <Opportunity item={primary} primary onCreate={create} sources={sources}/>
        {items.length > 1 && <section className="other-opportunities"><div>{items.slice(1, 3).map((item) => <Opportunity key={item.id} item={item} onCreate={create} sources={sources}/>)}</div></section>}
      </div> : <section className="empty-state"><h2>今日内容机会还在准备中</h2><p>点击“开始今日情报”，让 Pi 扫描并写入今天的内容机会。</p><button className="primary-button" disabled={running} onClick={() => void startIntelligence()}>{running ? '生成中…' : '开始今日情报'}</button></section>}
    </section>
    <button className={`drawer-backdrop${sourcesOpen ? ' open' : ''}`} aria-label="关闭关联资料" onClick={() => setSourcesOpen(false)}/>
    <SourceList sources={today?.sources ?? []} ids={primary?.sourceIds ?? []} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={openLibrary}/>
  </div>;
}

function LibraryView({ sources, selectedId, onSelect }: {
  sources: TodaySource[];
  selectedId: string | null;
  onSelect: (source: TodaySource) => void;
}): React.JSX.Element {
  const categories = Array.from(new Set(sources.flatMap((source) => source.categories))).slice(0, 6);
  return <section className="page library-page">
    <header className="page-heading"><div><span>内容资产</span><h1>值得长期使用的资料</h1><p>新闻、产品、工具、Skill 和项目，连同判断与原始来源一起保存。</p></div><div className="stat-summary"><strong>{sources.length}</strong><span>条入库资料</span></div></header>
    <div className="page-toolbar"><div className="filter-row"><button className="filter active">全部</button>{categories.map((category) => <button className="filter" key={category}>{category}</button>)}</div><span>按最新入库排序</span></div>
    {sources.length ? <div className="library-list">{sources.map((source) => <article key={source.id} className={source.id === selectedId ? 'selected' : ''} onClick={() => onSelect(source)}>
      <SourceMark canonicalUrl={source.canonicalUrl}/>
      <div><div className="library-meta"><span>{source.categories[0] || '入库资料'}</span>{(() => { const label = formatSourcePublishedAt(source.publishedAt); return label ? <time dateTime={source.publishedAt ?? undefined}>{label}</time> : null; })()}</div><h2>{source.title}</h2><p>{source.summary || source.valueJudgment || '这条资料尚未补充摘要。'}</p><small>{source.author || domainOf(source.canonicalUrl) || '本地资料'}</small></div>
      {source.canonicalUrl && <button onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(source.canonicalUrl!); }}>打开原文 ↗</button>}
    </article>)}</div> : <section className="empty-state library-empty"><h2>资料库暂无内容</h2><p>保存的新闻、工具、项目和案例会集中显示在这里。</p></section>}
  </section>;
}

function formatStudioTime(value?: string | null): string {
  if (!value) return '尚未保存';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatSourcePublishedAt(value) ?? value;
}

function formatStudioAuthor(author?: string | null): string {
  return author === 'user' ? '用户' : 'AI';
}

function StudioView({ studio, refresh, openPublish, selectedId, onSelect, planDate }: {
  studio: Awaited<ReturnType<typeof window.wmb.getStudio>>;
  refresh: () => void;
  openPublish: () => void;
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  planDate: string;
}): React.JSX.Element {
  const projects = studio ?? [];
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0] ?? null;
  const [draftStatus, setDraftStatus] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const latest = selected?.revisions[0];
  const dirty = Boolean(selected) && (
    titleDraft.trim() !== (selected?.title ?? '').trim()
    || bodyDraft !== (latest?.body ?? '')
  );
  useEffect(() => { if (selected && selected.id !== selectedId) onSelect(selected.id); }, [selected?.id]);
  useEffect(() => {
    setTitleDraft(selected?.title ?? '');
    setBodyDraft(selected?.revisions[0]?.body ?? '');
    setDraftStatus('');
  }, [selected?.id, selected?.title, selected?.revisions[0]?.id, selected?.revisions[0]?.body]);
  const writeDraft = async () => {
    if (!selected || drafting || saving) return;
    setDrafting(true);
    setDraftStatus('Pi 正在写初稿…');
    try {
      const result = await window.wmb.startStudioDraft({ businessDate: planDate, projectId: selected.id }) as {
        ok: boolean;
        data?: { task?: { status?: string; errorMessage?: string | null; resultRefs?: { versionNumber?: number } }; reused?: boolean };
        error?: { message?: string } | null;
      };
      if (!result.ok) {
        setDraftStatus(result.error?.message || '初稿失败');
        return;
      }
      if (result.data?.reused) setDraftStatus('初稿任务已在运行');
      else if (result.data?.task?.status === 'succeeded') setDraftStatus(`已保存核心版本 v${result.data.task.resultRefs?.versionNumber ?? ''}`.trim());
      else setDraftStatus(result.data?.task?.errorMessage || '初稿已完成');
      refresh();
    } catch (error) {
      setDraftStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDrafting(false);
      window.setTimeout(() => refresh(), 300);
    }
  };
  const saveManual = async () => {
    if (!selected || saving || drafting) return;
    const title = titleDraft.trim();
    const body = bodyDraft;
    if (!title) { setDraftStatus('标题不能为空'); return; }
    if (!body.trim()) { setDraftStatus('正文不能为空'); return; }
    setSaving(true);
    setDraftStatus('正在保存…');
    try {
      const result = await window.wmb.saveStudioCore({ projectId: selected.id, title, body });
      if (!result.ok) {
        setDraftStatus(result.error?.message || '保存失败');
        return;
      }
      const versionNumber = (result.data as { version?: { versionNumber?: number } } | null)?.version?.versionNumber;
      setDraftStatus('已保存');
      refresh();
    } catch (error) {
      setDraftStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
      window.setTimeout(() => refresh(), 300);
    }
  };
  return <section className="studio-layout">
    <aside className="studio-projects">
      <header><div><span>创作工作区</span><h1>内容项目</h1></div><button className="icon-button" onClick={refresh} aria-label="刷新内容项目">↻</button></header>
      <div className="project-list">{projects.map((project) => <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => onSelect(project.id)}><strong>{project.title}</strong><span>核心版本 {project.revisions.length} · 平台版本 {Object.values(project.platforms).flat().length}</span></button>)}</div>
      {!projects.length && <div className="compact-empty"><h2>还没有内容项目</h2><p>从今日首选机会进入创作后，项目会出现在这里。</p></div>}
    </aside>
    <main className="studio-editor">
      {selected ? <>
        <header className="editor-heading">
          <div className="editor-heading-copy">
            <span>核心内容</span>
            <h2>{titleDraft.trim() || selected.title}</h2>
            <p className="editor-meta">
              {latest
                ? <>最近修改 {formatStudioTime(latest.createdAt)} · {formatStudioAuthor(latest.author)}</>
                : '尚未保存核心版本'}
              {dirty ? ' · 有未保存修改' : ''}
            </p>
          </div>
        </header>
        <div className="editor-tabs"><button className="active">核心内容</button>{Object.entries(selected.platforms).map(([platform, versions]) => <button key={platform}>{platformNames[platform]} <span>{versions.length}</span></button>)}</div>
        <section className="writing-surface">
          <label htmlFor="studio-title">标题</label>
          <input
            id="studio-title"
            className="studio-title-input"
            value={titleDraft}
            disabled={drafting || saving}
            onChange={(event) => setTitleDraft(event.target.value)}
            placeholder="输入标题"
          />
          <label htmlFor="studio-body">正文</label>
          <textarea
            id="studio-body"
            className="studio-body-input"
            value={bodyDraft}
            disabled={drafting || saving}
            onChange={(event) => setBodyDraft(event.target.value)}
            placeholder="在这里直接编写或修改正文。保存后会生成新的核心版本。"
          />
        </section>
        {draftStatus && <p className="task-status" data-running={(drafting || saving) ? 'true' : 'false'}>{draftStatus}</p>}
        <footer className="editor-footer">
          <span>{latest ? `最近由${formatStudioAuthor(latest.author)}保存于 ${formatStudioTime(latest.createdAt)}` : '还没有核心版本'}{dirty ? '，有未保存修改' : ''}</span>
          <div className="editor-actions">
            <button className="primary-button" disabled={!dirty || drafting || saving} onClick={() => void saveManual()}>{saving ? '保存中…' : '保存版本'}</button>
            <button className="secondary-button" disabled={drafting || saving} onClick={() => void writeDraft()}>{drafting ? '写作中…' : '让 Pi 写初稿'}</button>
            <button className="secondary-button" disabled={drafting || saving} onClick={refresh}>读取最新内容</button>
          </div>
        </footer>
      </> : <section className="empty-state editor-empty"><h2>选择一个内容项目</h2><p>左侧会显示从今日机会创建的项目。</p></section>}
    </main>
    <aside className="studio-context">
      <section><span className="section-label">创作上下文</span><h2>这一篇为什么值得写</h2><p>项目继承今日方案中的判断和关联资料，创作时始终保留来源链路。</p></section>
      <section><h3>平台版本</h3>{selected ? <><div className="context-list">{Object.entries(selected.platforms).map(([platform, versions]) => <div key={platform}><span>{platformNames[platform]}</span><strong>{versions.length ? `${versions.length} 个版本` : '尚未适配'}</strong></div>)}</div>{selected.platforms.x[0] && <button className="primary-button full-button" onClick={async () => { const result = await window.wmb.prepareXPublication(selected.platforms.x[0].id); if (result.ok) openPublish(); }}>准备发布 X{selected.platforms.x[0].assets.length ? ' 单图' : ' 纯文字'}</button>}{selected.platforms.wechat[0] && <button className="secondary-button full-button" onClick={async () => { const result = await window.wmb.prepareWechatArticlePublication(selected.platforms.wechat[0].id); if (result.ok) openPublish(); }}>准备发布微信</button>}</> : <p className="muted">选择项目后显示平台版本。</p>}</section>
      <section><h3>媒体素材</h3><p className="muted">素材与具体版本绑定。没有真实素材时，这里不会显示占位图片。</p></section>
    </aside>
  </section>;
}

function PublishView({ publications, refresh, openStudio, takeover, selectedId, onSelect }: {
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  refresh: () => void;
  openStudio: () => void;
  takeover: () => void;
  selectedId: string | null;
  onSelect: (publicationId: string) => void;
}): React.JSX.Element {
  const [articleUrl, setArticleUrl] = useState('');
  const selected = publications.find((item) => item.publication.id === selectedId) ?? publications[0] ?? null;
  useEffect(() => { if (selected && selected.publication.id !== selectedId) onSelect(selected.publication.id); }, [selected?.publication.id]);
  const publication = selected?.publication;
  const reconcile = async () => {
    if (!publication) return;
    const reconciled = await window.wmb.reconcileNotPublished(publication.id, publication.revision);
    if (!reconciled.ok) return;
    refresh();
  };
  const readBackWechat = async () => {
    if (!publication || !articleUrl.trim()) return;
    const result = await window.wmb.readBackWechatPublication(publication.id, publication.revision, articleUrl.trim());
    if (result.ok) {
      setArticleUrl('');
      refresh();
    }
  };
  return <section className="workflow-page">
    <header className="page-heading"><div><span>发布工作区</span><h1>确认你真正要发布的内容</h1><p>平台、账号、内容版本和素材必须在一次确认中完全一致。</p></div></header>
    <div className="publish-layout">
      <aside className="workflow-list"><div className="section-heading"><h2>发布任务</h2><span>{publications.length}</span></div>{publications.length ? <div className="publication-list">{publications.map((item) => <button className={item.publication.id === publication?.id ? 'active' : ''} key={item.publication.id} onClick={() => onSelect(item.publication.id)}><strong>{item.payload?.title || item.payload?.body.slice(0, 42) || '尚未准备内容'}</strong><span>{platformNames[item.publication.platform]} · {publicationStatus(item.publication.status)}</span></button>)}</div> : <div className="compact-empty"><h2>还没有发布任务</h2><p>从创作页准备平台版本后会出现在这里。</p><button onClick={openStudio}>回到创作</button></div>}</aside>
      <main className="publish-preview">{selected?.payload ? <article className="final-preview"><span className="section-label">最终内容预览</span>{selected.payload.title && <h2>{selected.payload.title}</h2>}<p>{selected.payload.body}</p><div className="asset-summary">媒体素材 {selected.payload.assets.length} 项</div><section className="timeline"><h3>状态时间线</h3>{selected.events.map((event, index) => <div key={index}><span>{publicationStatus(String(event.to_status))}</span><small>{String(event.reason || '')}</small></div>)}</section></article> : <div className="preview-placeholder"><span>最终内容预览</span><h2>尚未取得编辑器回读</h2><p>准备完成后，这里会原样显示标题、正文和媒体素材。</p></div>}</main>
      <aside className="confirmation-panel"><span className="section-label">人工发布</span><h2>{publication ? publicationStatus(publication.status) : '发布信息尚未就绪'}</h2><dl className="confirmation-list"><dt>平台</dt><dd>{publication ? platformNames[publication.platform] : '未选择'}</dd><dt>账号</dt><dd>{publication?.accountKey || '未识别'}</dd><dt>内容状态</dt><dd>{selected?.payload ? '已准备' : '未绑定'}</dd><dt>媒体素材</dt><dd>{selected?.payload ? `${selected.payload.assets.length} 项` : '未绑定'}</dd></dl><p className="notice">{publication?.platform === 'xiaohongshu' ? '小红书 AI 操作只通过指定 MCP；请在小红书客户端中人工发布。' : 'WMB 不会点击平台的最终发布按钮。请在专用浏览器核对内容并手动发布。'}</p>{publication?.status === 'awaiting_confirmation' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器，人工发布</button>}{publication?.status === 'needs_user' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器接管</button>}{publication?.platform === 'wechat' && ['awaiting_confirmation', 'needs_user', 'unknown'].includes(publication.status) && <div className="readback-form"><input value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="粘贴已发布的公众号文章链接"/><button className="secondary-button full-button" disabled={!articleUrl.trim()} onClick={readBackWechat}>核对文章并记录结果</button></div>}{publication?.status === 'unknown' && publication.platform !== 'wechat' && <button className="secondary-button full-button" onClick={reconcile}>我已核对，确认未发布</button>}</aside>
    </div>
  </section>;
}

function ResultsView({ publications, refresh, planDate }: {
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  refresh: () => void;
  planDate: string;
}): React.JSX.Element {
  type ReviewRow = Awaited<ReturnType<typeof window.wmb.listReviews>>[number];
  type BacklinkRow = Awaited<ReturnType<typeof window.wmb.listReviewBacklinks>>[number];
  const published = (publications ?? []).filter((item) => item.publication.status === 'published' && item.publication);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Array<{
    id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string;
    normalized: Record<string, { status: string; value?: number; rawLabel?: string }>;
    raw: Record<string, { status: string; value?: number; rawLabel?: string }>;
  }>>([]);
  const [accountSnapshots, setAccountSnapshots] = useState<Array<{
    id: string; accountId: string; platform: string; capturedAt: string; sourceUrl: string;
    normalized: Record<string, { status?: string; value?: number; rawLabel?: string }>;
    raw: Record<string, { status?: string; value?: number; rawLabel?: string }>;
  }>>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([]);
  const [keepText, setKeepText] = useState('');
  const [stopText, setStopText] = useState('');
  const [changeText, setChangeText] = useState('');
  const [findingTitle, setFindingTitle] = useState('');
  const [findingBody, setFindingBody] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const selected = published.find((item) => item.publication.id === selectedId) ?? published[0] ?? null;
  const activeReview = reviews[0] ?? null;
  useEffect(() => {
    if (selected && selected.publication.id !== selectedId) setSelectedId(selected.publication.id);
  }, [selected?.publication.id]);
  const loadPublicationContext = async (publicationId: string | null) => {
    if (!publicationId) {
      setSnapshots([]);
      setReviews([]);
      setBacklinks([]);
      return;
    }
    const [pubSnaps, acctSnaps, listedReviews] = await Promise.all([
      window.wmb.listPublicationMetricSnapshots(publicationId),
      window.wmb.listAccountMetricSnapshots(),
      window.wmb.listReviews(publicationId)
    ]);
    setSnapshots(pubSnaps);
    setAccountSnapshots(acctSnaps);
    setReviews(listedReviews);
    const current = listedReviews[0];
    if (current) {
      setKeepText(current.keep.join('\n'));
      setStopText(current.stop.join('\n'));
      setChangeText(current.change.join('\n'));
      setSummary(current.summary ?? '');
      setFindingTitle(current.findings[0]?.title ?? '');
      setFindingBody(current.findings[0]?.body ?? '');
      const links = await window.wmb.listReviewBacklinks({
        reviewIds: [current.id],
        findingIds: current.findings.map((item) => item.id)
      });
      setBacklinks(links);
    } else {
      setKeepText('');
      setStopText('');
      setChangeText('');
      setSummary('');
      setFindingTitle('');
      setFindingBody('');
      setBacklinks([]);
    }
  };
  useEffect(() => { void loadPublicationContext(selected?.publication.id ?? null); }, [selected?.publication.id]);
  const capturePublication = async () => {
    if (!selected || selected.publication.platform !== 'x' || busy) return;
    setBusy(true);
    setStatusText('正在采集发布指标…');
    try {
      const capture = await window.wmb.collectXMetrics(selected.publication.id) as {
        sourceUrl: string;
        capturedAt: string;
        normalized: Record<string, { status: string; value?: number; rawLabel?: string }>;
      };
      await loadPublicationContext(selected.publication.id);
      const views = capture.normalized.views;
      setStatusText(`已采集：views=${views?.status === 'value' ? views.value : views?.status}; source=${capture.sourceUrl}`);
      refresh();
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const captureAccount = async () => {
    if (busy) return;
    setBusy(true);
    setStatusText('正在采集账号粉丝…');
    try {
      const saved = await window.wmb.collectXAccountMetrics();
      if (!saved.ok) throw new Error(saved.error?.message || '账号指标采集失败');
      const listed = await window.wmb.listAccountMetricSnapshots();
      setAccountSnapshots(listed);
      const latest = listed[0];
      const followers = latest?.normalized?.followers as { status?: string; value?: number; rawLabel?: string } | undefined;
      setStatusText(`账号粉丝：${followers?.status === 'value' ? followers.value : followers?.status || '无'} · ${latest?.sourceUrl || ''}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const splitLines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const saveCurrentReview = async (status: 'draft' | 'final') => {
    if (!selected || busy) return;
    if (!snapshots.length) {
      setStatusText('没有指标快照时不能形成数据驱动复盘。');
      return;
    }
    setBusy(true);
    setStatusText(status === 'final' ? '正在定稿复盘…' : '正在保存草稿…');
    try {
      const result = await window.wmb.saveReview({
        id: activeReview && activeReview.status !== 'final' ? activeReview.id : undefined,
        publicationId: selected.publication.id,
        metricSnapshotIds: [snapshots[0].id],
        keep: splitLines(keepText),
        stop: splitLines(stopText),
        change: splitLines(changeText),
        summary: summary.trim() || undefined,
        status,
        expectedRevision: activeReview && activeReview.status !== 'final' ? activeReview.revision : undefined,
        findings: findingTitle.trim() && findingBody.trim()
          ? [{ title: findingTitle.trim(), body: findingBody.trim() }]
          : []
      });
      if (!result.ok) throw new Error(result.error?.message || '复盘保存失败');
      await loadPublicationContext(selected.publication.id);
      setStatusText(status === 'final' ? '复盘已定稿' : '复盘草稿已保存');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const startPiReview = async () => {
    if (!selected || busy) return;
    if (!latestSnapshot && !snapshots.length) {
      setStatusText('没有指标快照时不能让 Pi 做数据驱动复盘。');
      return;
    }
    setBusy(true);
    setStatusText('Pi 正在复盘…');
    try {
      const result = await window.wmb.startResultsReview({
        businessDate: planDate,
        publicationId: selected.publication.id
      });
      if (!result.ok) throw new Error(result.error?.message || 'Pi 复盘失败');
      await loadPublicationContext(selected.publication.id);
      setStatusText('Pi 复盘已完成');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await loadPublicationContext(selected.publication.id);
    }
  };
  const latestSnapshot = snapshots[0] ?? null;
  const latestAccount = accountSnapshots[0] ?? null;
  const locked = activeReview?.status === 'final';
  return <section className="workflow-page">
    <header className="page-heading">
      <div><span>内容结果</span><h1>什么有效，下一次怎么做</h1><p>只根据真实发布和已采集的网页数据形成复盘。</p></div>
      <div className="heading-actions">
        <button className="secondary-button" disabled={busy || !selected || selected.publication.platform !== 'x'} onClick={() => void capturePublication()}>{busy ? '处理中…' : '采集发布指标'}</button>
        <button className="secondary-button" disabled={busy} onClick={() => void captureAccount()}>采集账号粉丝</button>
        <button className="primary-button" disabled={busy || !selected || !snapshots.length || locked} onClick={() => void startPiReview()}>{busy ? 'Pi 处理中…' : '让 Pi 复盘'}</button>
      </div>
    </header>
    {statusText && <p className="task-status" data-running={busy ? 'true' : 'false'}>{statusText}</p>}
    <div className="results-layout">
      <aside className="workflow-list">
        <div className="section-heading"><h2>已发布内容</h2><span>{published.length}</span></div>
        {published.length ? <div className="publication-list">{published.map((item) => {
          const pub = item.publication;
          const title = item.payload?.title || item.payload?.body.slice(0, 42) || pub.externalUrl || pub.id;
          return <button className={pub.id === selected?.publication.id ? 'active' : ''} key={pub.id} onClick={() => setSelectedId(pub.id)}>
            <strong>{title}</strong>
            <span>{platformNames[pub.platform]} · {pub.publishedAt ? new Date(pub.publishedAt).toLocaleString() : '未知时间'}</span>
          </button>;
        })}</div> : <div className="compact-empty"><h3>还没有可复盘内容</h3><p>取得真实发布地址后，内容会按发布时间显示在这里。</p></div>}
      </aside>
      <main className="results-main">
        {selected ? <section className="metrics-panel">
          <span className="section-label">指标快照</span>
          <h2>{selected.payload?.title || selected.payload?.body.slice(0, 48) || '已发布内容'}</h2>
          <dl className="metric-meta">
            <div><dt>来源页面</dt><dd>{selected.publication.externalUrl ? <button className="text-button" onClick={() => void window.wmb.openExternal(selected.publication.externalUrl!)}>{selected.publication.externalUrl}</button> : '无'}</dd></div>
            <div><dt>计划采集</dt><dd>{latestSnapshot?.scheduledFor ? new Date(latestSnapshot.scheduledFor).toLocaleString() : '尚未生成任务窗口'}</dd></div>
            <div><dt>实际采集</dt><dd>{latestSnapshot?.capturedAt ? new Date(latestSnapshot.capturedAt).toLocaleString() : '尚未采集'}</dd></div>
            <div><dt>复盘状态</dt><dd>{activeReview ? (activeReview.status === 'final' ? '已定稿' : '草稿') : (latestSnapshot ? '可写复盘' : '等待指标')}</dd></div>
          </dl>
          {latestSnapshot ? <div className="metric-tables">
            <section>
              <h3>归一化指标</h3>
              <table><thead><tr><th>字段</th><th>状态</th><th>数值</th><th>原始标签</th></tr></thead><tbody>
                {Object.entries(latestSnapshot.normalized).map(([key, field]) => <tr key={key}><td>{key}</td><td>{field.status}</td><td>{field.status === 'value' ? String(field.value) : '—'}</td><td>{field.rawLabel || '—'}</td></tr>)}
              </tbody></table>
            </section>
            <section>
              <h3>原始字段</h3>
              <table><thead><tr><th>字段</th><th>状态</th><th>数值</th><th>原始标签</th></tr></thead><tbody>
                {Object.entries(latestSnapshot.raw).map(([key, field]) => <tr key={key}><td>{key}</td><td>{field.status}</td><td>{field.status === 'value' ? String(field.value) : '—'}</td><td>{field.rawLabel || '—'}</td></tr>)}
              </tbody></table>
            </section>
          </div> : <section className="metrics-empty"><h2>还没有该内容的指标快照</h2><p>没有快照时复盘只能保持草稿，不会被当作完成的数据驱动复盘。</p></section>}
          {latestAccount && <section className="account-metrics">
            <h3>账号快照</h3>
            <p>{latestAccount.platform} · {new Date(latestAccount.capturedAt).toLocaleString()} · {latestAccount.sourceUrl}</p>
            <table><thead><tr><th>字段</th><th>状态</th><th>数值</th><th>原始标签</th></tr></thead><tbody>
              {Object.entries(latestAccount.normalized).map(([key, field]) => {
                const value = field as { status?: string; value?: number; rawLabel?: string };
                return <tr key={key}><td>{key}</td><td>{value.status || '—'}</td><td>{value.status === 'value' ? String(value.value) : '—'}</td><td>{value.rawLabel || '—'}</td></tr>;
              })}
            </tbody></table>
          </section>}
        </section> : <section className="metrics-empty"><span className="section-label">指标快照</span><h2>等待第一条真实发布</h2><p>数据会保留采集时间、来源页面和字段状态。暂不可见的指标不会被写成 0。</p></section>}
        <section className="review-editor">
          <div className="section-heading"><h2>复盘</h2><span>{activeReview ? activeReview.status : '未创建'}</span></div>
          <label className="review-field"><span>摘要</span><textarea disabled={locked || busy} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="一句话说明这次内容的结果判断" /></label>
          <div className="review-grid editable">
            <label><span>Keep（保留）</span><textarea disabled={locked || busy} value={keepText} onChange={(event) => setKeepText(event.target.value)} placeholder="每行一条" /></label>
            <label><span>Stop（停止）</span><textarea disabled={locked || busy} value={stopText} onChange={(event) => setStopText(event.target.value)} placeholder="每行一条" /></label>
            <label><span>Change（改变）</span><textarea disabled={locked || busy} value={changeText} onChange={(event) => setChangeText(event.target.value)} placeholder="每行一条" /></label>
          </div>
          {!locked && <div className="heading-actions">
            <button className="secondary-button" disabled={busy || !selected || !latestSnapshot} onClick={() => void saveCurrentReview('draft')}>保存草稿</button>
            <button className="primary-button" disabled={busy || !selected || !latestSnapshot} onClick={() => void saveCurrentReview('final')}>定稿复盘</button>
          </div>}
        </section>
      </main>
      <aside className="findings-panel">
        <span className="section-label">方法结论</span>
        {activeReview?.findings?.length ? <>
          <h2>{activeReview.findings[0].title}</h2>
          <p>{activeReview.findings[0].body}</p>
        </> : <>
          <h2>{locked ? '无方法结论' : '写一条方法结论'}</h2>
          {!locked && <>
            <label className="review-field"><span>标题</span><input disabled={busy} value={findingTitle} onChange={(event) => setFindingTitle(event.target.value)} placeholder="例如：视频封面要先给结论" /></label>
            <label className="review-field"><span>内容</span><textarea disabled={busy} value={findingBody} onChange={(event) => setFindingBody(event.target.value)} placeholder="后续方案可引用这条结论" /></label>
          </>}
        </>}
        <section className="backlink-list">
          <h3>后续方案回流</h3>
          {backlinks.length ? backlinks.map((link) => (
            <article key={link.planItemId}>
              <strong>{link.planItemTitle}</strong>
              <span>{link.planDate} · 计划 {link.planId.slice(0, 8)}</span>
            </article>
          )) : <p>还没有后续方案引用这份复盘或方法结论。</p>}
        </section>
      </aside>
    </div>
  </section>;
}

function SettingsView({ dataRoot, settings, browserChoice, setBrowserChoice, refresh }: {
  dataRoot: string | null; settings: Awaited<ReturnType<typeof window.wmb.getSettings>>; browserChoice: string;
  setBrowserChoice: (value: string) => void; refresh: () => void;
}): React.JSX.Element {
  const [piProfileId, setPiProfileId] = useState(settings?.pi.activeId ?? '');
  const [piName, setPiName] = useState(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.name ?? '');
  const [piApi, setPiApi] = useState<'openai-responses' | 'anthropic-messages'>(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.api ?? 'openai-responses');
  const [piBaseUrl, setPiBaseUrl] = useState(settings?.pi.baseUrl ?? '');
  const [piModel, setPiModel] = useState(settings?.pi.model ?? '');
  const [piApiKey, setPiApiKey] = useState('');
  const [piConfigNote, setPiConfigNote] = useState('');
  const [piModels, setPiModels] = useState<string[]>([]);
  const [loadingPiModels, setLoadingPiModels] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState('');
  const selectPiProfile = (id: string) => {
    const profile = settings?.pi.profiles.find((item) => item.id === id);
    setPiProfileId(id);
    setPiName(profile?.name ?? '');
    setPiApi(profile?.api ?? 'openai-responses');
    setPiBaseUrl(profile?.baseUrl ?? '');
    setPiModel(profile?.model ?? '');
    setPiApiKey('');
    setPiModels([]);
    setPiConfigNote('');
  };
  useEffect(() => {
    selectPiProfile(settings?.pi.activeId ?? '');
  }, [settings?.pi.activeId, settings?.pi.profiles]);
  const saveProfile = async () => {
    try {
      await window.wmb.savePiConfig({
        id: piProfileId || undefined,
        name: piName,
        baseUrl: piBaseUrl,
        model: piModel,
        api: piApi,
        apiKey: piApiKey || undefined
      });
      setPiApiKey('');
      setPiConfigNote('已保存并切换到此配置');
      refresh();
    } catch (error) {
      setPiConfigNote(error instanceof Error ? error.message : '保存失败');
    }
  };
  const fetchModels = async () => {
    setLoadingPiModels(true);
    setPiConfigNote('');
    try {
      const models = await window.wmb.listPiModels({
        id: piProfileId || undefined,
        baseUrl: piBaseUrl,
        api: piApi,
        apiKey: piApiKey || undefined
      });
      setPiModels(models);
      if (!models.includes(piModel)) setPiModel(models[0]);
      setPiConfigNote(`已获取 ${models.length} 个模型`);
    } catch (error) {
      setPiModels([]);
      setPiConfigNote(`${error instanceof Error ? error.message : '获取模型失败'} 仍可手动填写模型。`);
    } finally {
      setLoadingPiModels(false);
    }
  };
  return <section className="page settings-page">
    <header className="page-heading"><div><span>本地终端</span><h1>设置</h1><p>管理数据位置、专用浏览器和创作助手连接。</p></div></header>
    <div className="settings-grid">
      <section className="settings-block">
        <div><span className="section-label">数据与文件</span><h2>数据目录</h2><p>{dataRoot || '尚未选择数据根目录'}</p></div>
        <button className="secondary-button" onClick={() => void window.wmb.chooseDataRoot().then(refresh)}>选择目录</button>
      </section>
      {settings && <>
        <section className="settings-block browser-setting">
          <div>
            <span className="section-label">网页发布</span>
            <h2>专用浏览器</h2>
            <p>{settings.browser.status === 'ready' ? `已启动，配置目录：${settings.browser.profilePath}` : '浏览器尚未由本应用启动'}</p>
          </div>
          <div className="setting-actions">
            <select value={browserChoice} onChange={(event) => setBrowserChoice(event.target.value)}>
              {settings.browserOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.profileDirectory}</option>)}
            </select>
            <button className="secondary-button" disabled={!browserChoice} onClick={() => void window.wmb.configureBrowser(browserChoice).then(refresh)}>保存选择</button>
            <button className="primary-button" onClick={() => void window.wmb.startBrowser().then(refresh)}>启动浏览器</button>
          </div>
        </section>
        <section className="settings-block pi-api-settings">
          <div className="pi-api-copy">
            <span className="section-label">创作助手</span>
            <h2>API 接入</h2>
            <p>{settings.pi.configured ? `正在使用：${settings.pi.profiles.find((profile) => profile.active)?.name ?? '已配置接口'}` : '添加一个 OpenAI-compatible 接口后即可使用 Pi'}</p>
            <div className="pi-profile-list">
              {settings.pi.profiles.map((profile) => <button
                type="button"
                key={profile.id}
                className={`pi-profile-item${profile.id === piProfileId ? ' selected' : ''}`}
                onClick={() => selectPiProfile(profile.id)}
              >
                <span><strong>{profile.name}</strong><small>{profile.model}</small></span>
                {profile.active && <em>使用中</em>}
              </button>)}
              <button type="button" className="pi-profile-add" onClick={() => selectPiProfile('')}>＋ 新建配置</button>
            </div>
          </div>
          <div className="pi-fields">
            <label><span>配置名称</span><input value={piName} onChange={(event) => setPiName(event.target.value)} placeholder="例如：本地 CPA" /></label>
            <label><span>接口类型</span><select value={piApi} onChange={(event) => { setPiApi(event.target.value as 'openai-responses' | 'anthropic-messages'); setPiModels([]); }}>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select></label>
            <label className="wide">
              <span>模型</span>
              <div className="model-picker">
                {piModels.length
                  ? <select value={piModel} onChange={(event) => setPiModel(event.target.value)}>{piModels.map((model) => <option key={model} value={model}>{model}</option>)}</select>
                  : <input value={piModel} onChange={(event) => setPiModel(event.target.value)} placeholder="获取后选择，或手动填写" />}
                <button type="button" className="secondary-button" disabled={loadingPiModels || !piBaseUrl.trim()} onClick={() => void fetchModels()}>{loadingPiModels ? '获取中…' : '获取模型'}</button>
              </div>
            </label>
            <label className="wide"><span>Base URL</span><input value={piBaseUrl} onChange={(event) => setPiBaseUrl(event.target.value)} placeholder="http://localhost:61946/v1" /></label>
            <label className="wide"><span>API Key</span><input value={piApiKey} onChange={(event) => setPiApiKey(event.target.value)} placeholder={piProfileId ? '留空保持原密钥' : '填写 API Key'} type="password" /></label>
            {piConfigNote && <p className="pi-config-note">{piConfigNote}</p>}
            <div className="pi-config-actions">
              {piProfileId && !settings.pi.profiles.find((profile) => profile.id === piProfileId)?.active && <button className="secondary-button" onClick={() => void window.wmb.activatePiConfig(piProfileId).then(refresh)}>设为当前</button>}
              {piProfileId && <button className="danger-button" onClick={() => {
                if (!window.confirm('删除这个 API 配置？')) return;
                void window.wmb.deletePiConfig(piProfileId).then(() => { setPiProfileId(''); refresh(); });
              }}>删除</button>}
              <button className="primary-button" onClick={() => void saveProfile()}>{piProfileId ? '保存修改' : '保存并使用'}</button>
            </div>
          </div>
        </section>
        <section className="settings-block">
          <div>
            <span className="section-label">Pi Runtime</span>
            <h2>版本 {settings.piRuntime?.version || 'unknown'}</h2>
            <p>来源：{settings.piRuntime?.source === 'override' ? '数据目录覆盖' : '安装包内置'} · {settings.piRuntime?.root}</p>
            {settings.piRuntime?.previousVersion && <p>可回滚版本：{settings.piRuntime.previousVersion}</p>}
            {runtimeNote && <p className="task-status">{runtimeNote}</p>}
          </div>
          <div className="setting-actions">
            <button className="secondary-button" onClick={() => void window.wmb.getPiRuntime().then((info) => setRuntimeNote(`当前 ${info.version}（${info.source}）`)).then(refresh)}>刷新版本</button>
            <button className="secondary-button" disabled={!settings.piRuntime?.previousVersion} onClick={() => void window.wmb.rollbackPiRuntime().then((result) => {
              setRuntimeNote(result.ok ? '已回滚到上一版本' : (result.error?.message || '回滚失败'));
              refresh();
            })}>回滚上一版本</button>
          </div>
        </section>
        <section className="settings-block">
          <div>
            <span className="section-label">连接</span>
            <h2>MCP</h2>
            <p>{settings.mcp.status === 'ready' ? settings.mcp.url : '未启动'}</p>
          </div>
          <button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button>
        </section>
      </>}
    </div>
  </section>;
}

function renderMarkdownLite(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(?:<li>[\s\S]*?<\/li>)/g, (block) => `<ul>${block}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
}

function formatPiMessageTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function PiDock({ collapsed, toggle, configured, context }: {
  collapsed: boolean;
  toggle: () => void;
  configured: boolean;
  context: PiContextRef;
}): React.JSX.Element {
  type PiMessage = { role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string };
  type PiSessionItem = { id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean };
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [sessions, setSessions] = useState<PiSessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [statusText, setStatusText] = useState(configured ? '已配置' : '等待配置');
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const busy = phase === 'starting' || phase === 'running';
  const [modelLabel, setModelLabel] = useState('默认模型');
  const [toast, setToast] = useState('');

  const refreshSessions = async () => {
    try {
      const listed = await window.wmb.listPiConversations();
      setSessions(listed);
      setActiveSessionId(listed.find((item) => item.active)?.id ?? listed[0]?.id ?? null);
    } catch {
      setSessions([]);
    }
  };

  useEffect(() => {
    void window.wmb.getPiConversation().then((conversation) => {
      setMessages(conversation.messages ?? []);
      setActiveSessionId(conversation.id || null);
    }).catch(() => {});
    void refreshSessions();
  }, []);

  useEffect(() => {
    setStatusText(configured ? (phase === 'idle' ? '已配置' : statusText) : '等待配置');
  }, [configured]);

  useEffect(() => {
    const node = conversationRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, phase]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (headerRef.current && target && !headerRef.current.contains(target)) setSessionMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sessionMenuOpen]);

  useEffect(() => window.wmb.onPiEvent((event) => {
    if (event.type === 'starting') { setPhase('starting'); setStatusText('正在启动'); return; }
    if (event.type === 'running') { setPhase('running'); setStatusText('正在回复'); return; }
    if (event.type === 'delta') {
      setPhase('running'); setStatusText('正在回复');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, text: event.text ?? '' };
        else next.push({ role: 'assistant', text: event.text ?? '', status: 'streaming', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'stopped') {
      setPhase('stopped'); setStatusText('已停止');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        const text = (event.text && event.text.trim()) || last?.text || '已停止生成。';
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text, status: 'stopped' };
        else next.push({ role: 'assistant', text, status: 'stopped', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'failed') {
      setPhase('failed'); setStatusText('失败');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        const text = event.error || 'Pi 回复失败。';
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, role: 'assistant', text, status: 'failed' };
        else next.push({ role: 'assistant', text, status: 'failed', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'idle') {
      setPhase('idle'); setStatusText(configured ? '已配置' : '等待配置');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, role: 'assistant', text: event.text || last.text, status: undefined };
        return next;
      });
      void refreshSessions();
    }
  }), [configured]);

  useEffect(() => {
    void window.wmb.getSettings().then((settings) => {
      if (settings?.pi?.model) setModelLabel(settings.pi.model);
    }).catch(() => {});
  }, []);

  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 1400);
  };
  const contextChip = context.objectTitle
    ? `${context.pageLabel} · ${context.objectTitle}`
    : context.pageLabel;
  const buildPayload = (text: string) => (
    `[WMB_CONTEXT]\npage=${context.page}\npageLabel=${context.pageLabel}\nobjectType=${context.objectType ?? ''}\nobjectId=${context.objectId ?? ''}\nobjectTitle=${context.objectTitle ?? ''}\n[USER_MESSAGE]\n${text}`
  );

  const sendText = async (text: string, opts?: { replaceFrom?: number }) => {
    const value = text.trim();
    if (!value || busy) return;
    const stamped = new Date().toISOString();
    if (opts?.replaceFrom !== undefined) {
      setMessages((items) => items.slice(0, opts.replaceFrom).concat([
        { role: 'user', text: value, createdAt: stamped },
        { role: 'assistant', text: '', status: 'streaming', createdAt: stamped }
      ]));
    } else {
      setMessages((items) => [...items, { role: 'user', text: value, createdAt: stamped }, { role: 'assistant', text: '', status: 'streaming', createdAt: stamped }]);
    }
    setPhase('starting'); setStatusText('正在启动');
    try {
      const result = await window.wmb.chatPi(buildPayload(value));
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text: result.text || last.text, status: result.stopped ? 'stopped' : undefined };
        return next;
      });
      setPhase(result.stopped ? 'stopped' : 'idle');
      setStatusText(result.stopped ? '已停止' : (configured ? '已配置' : '等待配置'));
      void refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase('failed'); setStatusText('失败');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text: message, status: 'failed' };
        else next.push({ role: 'assistant', text: message, status: 'failed', createdAt: new Date().toISOString() });
        return next;
      });
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    await sendText(text);
  };
  const stop = async () => { try { await window.wmb.stopPi(); } catch {} };
  const newConversation = async () => {
    if (busy) await stop();
    const conversation = await window.wmb.newPiConversation();
    setMessages(conversation.messages ?? []);
    setActiveSessionId(conversation.id || null);
    setPhase('idle');
    setStatusText(configured ? '新会话' : '等待配置');
    setSessionMenuOpen(false);
    await refreshSessions();
  };
  const openSession = async (conversationId: string) => {
    if (!conversationId || conversationId === activeSessionId) {
      setSessionMenuOpen(false);
      return;
    }
    if (busy) await stop();
    const conversation = await window.wmb.switchPiConversation(conversationId);
    setMessages(conversation.messages ?? []);
    setActiveSessionId(conversation.id || conversationId);
    setPhase('idle');
    setStatusText(configured ? '已切换会话' : '等待配置');
    setSessionMenuOpen(false);
    await refreshSessions();
  };
  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制');
    } catch {
      showToast('复制失败');
    }
  };
  const recallMessage = (index: number) => {
    if (busy) return;
    setMessages((items) => items.slice(0, index));
    showToast('已撤回');
  };
  const resendMessage = async (index: number) => {
    const target = messages[index];
    if (!target) return;
    if (target.role === 'user') {
      await sendText(target.text, { replaceFrom: index });
      return;
    }
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') { userIndex = i; break; }
    }
    if (userIndex < 0) return;
    await sendText(messages[userIndex].text, { replaceFrom: userIndex });
  };
  const activeTitle = sessions.find((item) => item.id === activeSessionId)?.title || 'Pi';

  return <aside className={`pi-dock${collapsed ? ' collapsed' : ''}`}>
    <button className="pi-dock-toggle" onClick={toggle} aria-label={collapsed ? '展开 Pi' : '收起 Pi'}>{collapsed ? '‹' : '›'}</button>
    {!collapsed && <>
      <header className="pi-dock-header" ref={headerRef}>
        <div className="pi-dock-title-row">
          <button
            type="button"
            className={`pi-session-trigger${sessionMenuOpen ? ' open' : ''}`}
            onClick={() => {
              setSessionMenuOpen((open) => !open);
              void refreshSessions();
            }}
            aria-haspopup="listbox"
            aria-expanded={sessionMenuOpen}
            title="会话管理"
          >
            <strong>Pi</strong>
            <span className="pi-session-current" title={activeTitle}>{activeTitle === 'Pi' ? '会话' : activeTitle}</span>
            <em className="pi-session-caret" aria-hidden="true">▾</em>
          </button>
          <span data-phase={phase}>{statusText}</span>
          <button type="button" className="pi-icon-button pi-new-session" title="新会话" aria-label="新会话" onClick={() => void newConversation()}>＋</button>
        </div>
        {sessionMenuOpen && (
          <div className="pi-session-menu" role="listbox" aria-label="会话列表">
            <div className="pi-session-menu-head">
              <span>会话</span>
              <button type="button" onClick={() => void newConversation()}>新建</button>
            </div>
            <div className="pi-session-list">
              {sessions.length ? sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  role="option"
                  aria-selected={session.id === activeSessionId}
                  className={session.id === activeSessionId ? 'active' : ''}
                  onClick={() => void openSession(session.id)}
                >
                  <strong>{session.title || '新会话'}</strong>
                  <span>{formatPiMessageTime(session.updatedAt) || session.preview}</span>
                  <small>{session.preview}</small>
                </button>
              )) : <p className="pi-session-empty">还没有历史会话</p>}
            </div>
          </div>
        )}
        <div className="pi-context-chip" title={`当前会带给 Pi 的对象：${contextChip}`}>
          <em>当前:</em>
          <span>{contextChip}</span>
        </div>
        {toast && <small className="pi-toast">{toast}</small>}
      </header>
      <div className="pi-conversation" ref={conversationRef}>
        {messages.length ? <>
          {messages.map((message, index) => {
            const timeLabel = formatPiMessageTime(message.createdAt);
            const showActions = Boolean(message.text) && message.status !== 'streaming';
            return (
              <div className={`pi-bubble-wrap ${message.role}`} key={`${message.role}-${index}-${message.createdAt ?? ''}-${message.text.slice(0, 12)}`}>
                {message.role === 'assistant'
                  ? <div className={`assistant pi-bubble${message.status ? ` ${message.status}` : ''}`} dangerouslySetInnerHTML={{ __html: `<p>${renderMarkdownLite(message.text || (message.status === 'streaming' ? '…' : ''))}</p>` }} />
                  : <p className="user pi-bubble">{message.text}</p>}
                <div className="pi-bubble-meta">
                  <time className="pi-bubble-time">{timeLabel || (message.status === 'streaming' ? '发送中' : '')}</time>
                  <div className="pi-bubble-actions" aria-hidden={showActions ? undefined : true} style={showActions ? undefined : { visibility: 'hidden' }}>
                    <button type="button" title="复制" aria-label="复制" disabled={!showActions} onClick={() => void copyMessage(message.text)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button type="button" title="撤回" aria-label="撤回" disabled={!showActions || busy} onClick={() => recallMessage(index)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1 0 12h-3"/></svg>
                    </button>
                    <button type="button" title="重发" aria-label="重发" disabled={!showActions || busy || !configured} onClick={() => void resendMessage(index)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="pi-conversation-end-spacer" aria-hidden="true" />
        </> : <p className="pi-empty">{configured ? '现在可以直接和我对话。' : '请先在设置中填写 Pi API。'}</p>}
      </div>
      <footer className="pi-dock-footer">
        <div className="pi-composer">
          <textarea
            disabled={!configured || busy}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder={configured ? (busy ? 'Pi 正在回复…' : phase === 'failed' ? '失败后可以直接重试' : phase === 'stopped' ? '已停止，可以继续发送' : '给 Pi 发消息') : '配置 Pi API 后可以对话'}
          />
          <div className="pi-composer-bar">
            <div className="pi-composer-tools">
              <button type="button" className="pi-icon-button" title="插入图片（即将支持）" aria-label="插入图片" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></svg>
              </button>
              <button type="button" className="pi-icon-button" title="附件（即将支持）" aria-label="附件" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/></svg>
              </button>
              <button type="button" className="pi-icon-button" title={busy ? '停止生成' : '新会话'} aria-label={busy ? '停止生成' : '新会话'} onClick={() => void (busy ? stop() : newConversation())}>
                {busy
                  ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>}
              </button>
            </div>
            <div className="pi-composer-meta">
              <span className="pi-model-chip" title={modelLabel}>{modelLabel}</span>
              <button type="button" className="pi-send-button" disabled={!configured || busy || !input.trim()} onClick={() => void send()}>{busy ? '…' : '发送'}</button>
            </div>
          </div>
        </div>
      </footer>
    </>}
  </aside>;
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('today');
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('wmb.theme') === 'light' ? 'light' : 'dark');
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof window.wmb.getSettings>>>(null);
  const [today, setToday] = useState<Awaited<ReturnType<typeof window.wmb.getToday>>>(null);
  const [studio, setStudio] = useState<Awaited<ReturnType<typeof window.wmb.getStudio>>>(null);
  const [publications, setPublications] = useState<Awaited<ReturnType<typeof window.wmb.getPublications>>>([]);
  const [browserChoice, setBrowserChoice] = useState('');
  const [piDockCollapsed, setPiDockCollapsed] = useState(() => localStorage.getItem('wmb.piDockCollapsed') === 'true');
  const [todayPrimary, setTodayPrimary] = useState<TodayPlanItem | null>(null);
  const [librarySelectedId, setLibrarySelectedId] = useState<string | null>(null);
  const [studioSelectedId, setStudioSelectedId] = useState<string | null>(null);
  const [publishSelectedId, setPublishSelectedId] = useState<string | null>(null);
  const planDate = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), []);
  const [now, setNow] = useState(() => new Date());
  const [piPhase, setPiPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [piStatusText, setPiStatusText] = useState('Pi 空闲');
  const dateLabel = useMemo(() => new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
    hour12: false
  }).format(now), [now]);
  const refreshSettings = () => void window.wmb.getSettings().then((value) => { setSettings(value); setBrowserChoice(value?.selectedBrowser?.id ?? value?.browserOptions[0]?.id ?? ''); });
  const refreshToday = () => void window.wmb.getToday(planDate).then(setToday);
  const refreshStudio = () => void window.wmb.getStudio().then(setStudio);
  const refreshPublications = () => void window.wmb.getPublications().then(setPublications);
  useEffect(() => { void window.wmb.getDataRoot().then((root) => setDataRoot(root?.path ?? null)); refreshSettings(); refreshToday(); refreshStudio(); refreshPublications(); const poll = window.setInterval(() => { refreshToday(); refreshStudio(); refreshPublications(); }, 5000); return () => window.clearInterval(poll); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('wmb.theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('wmb.piDockCollapsed', String(piDockCollapsed)); }, [piDockCollapsed]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!settings?.pi?.configured) {
      setPiPhase('idle');
      setPiStatusText('Pi 未配置');
      return;
    }
    setPiStatusText((current) => (piPhase === 'idle' ? 'Pi 空闲' : current));
    return window.wmb.onPiEvent((event) => {
      if (event.type === 'starting') { setPiPhase('starting'); setPiStatusText('Pi 正在启动'); return; }
      if (event.type === 'running' || event.type === 'delta') { setPiPhase('running'); setPiStatusText('Pi 调用中'); return; }
      if (event.type === 'stopped') { setPiPhase('stopped'); setPiStatusText('Pi 已停止'); return; }
      if (event.type === 'failed') { setPiPhase('failed'); setPiStatusText(event.error ? `Pi 失败：${event.error}` : 'Pi 调用失败'); return; }
      if (event.type === 'idle' || event.type === 'agent_task') {
        setPiPhase('idle');
        setPiStatusText(settings?.pi?.configured ? 'Pi 空闲' : 'Pi 未配置');
      }
    });
  }, [settings?.pi?.configured]);
  const navigate = (next: View) => { setView(next); if (next === 'studio') refreshStudio(); if (next === 'publish' || next === 'results') refreshPublications(); };
  const nav = [{ id: 'today', label: '今日' }, { id: 'studio', label: '创作' }, { id: 'publish', label: '发布' }, { id: 'results', label: '结果' }] as const;
  const pageLabels: Record<View, string> = { today: '今日内容', library: '资料库', studio: '创作', publish: '发布', results: '结果', diagnostics: '系统诊断', settings: '设置' };
  const librarySelected = (today?.sources ?? []).find((source) => source.id === librarySelectedId) ?? null;
  const studioSelected = (studio ?? []).find((project) => project.id === studioSelectedId) ?? (studio ?? [])[0] ?? null;
  const publishSelected = publications.find((item) => item.publication.id === publishSelectedId) ?? publications[0] ?? null;
  const piContext: PiContextRef = (() => {
    if (view === 'today') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: todayPrimary ? 'plan_item' : null,
        objectId: todayPrimary?.id ?? null,
        objectTitle: todayPrimary?.title ?? null
      };
    }
    if (view === 'library') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: librarySelected ? 'source' : null,
        objectId: librarySelected?.id ?? null,
        objectTitle: librarySelected?.title ?? null
      };
    }
    if (view === 'studio') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: studioSelected ? 'project' : null,
        objectId: studioSelected?.id ?? null,
        objectTitle: studioSelected?.title ?? null
      };
    }
    if (view === 'publish') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: publishSelected ? 'publication' : null,
        objectId: publishSelected?.publication.id ?? null,
        objectTitle: publishSelected?.payload?.title || publishSelected?.payload?.body.slice(0, 42) || publishSelected?.publication.id || null
      };
    }
    if (view === 'results') {
      const selected = (publications ?? []).find((item) => item.publication.status === 'published') ?? null;
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: selected ? 'publication' : null,
        objectId: selected?.publication.id ?? null,
        objectTitle: selected?.payload?.title || selected?.payload?.body.slice(0, 42) || selected?.publication.id || null
      };
    }
    return { page: view, pageLabel: pageLabels[view], objectType: null, objectId: null, objectTitle: null };
  })();
  return <main className={`app-shell${piDockCollapsed ? ' pi-collapsed' : ' pi-open'}`}>
    <header className="topbar">
      <div className="brand"><img src={logoUrl} alt=""/><strong>WeMediaBuddy</strong></div>
      <div className="titlebar-actions">
        <button aria-label="最小化窗口" onClick={() => void window.wmb.windowControl('minimize')}>−</button>
        <button aria-label="最大化或还原窗口" onClick={() => void window.wmb.windowControl('maximize')}>□</button>
        <button className="window-close" aria-label="关闭窗口" onClick={() => void window.wmb.windowControl('close')}>×</button>
      </div>
    </header>
    <aside className="sidebar"><nav><button className={view === 'today' ? 'active' : ''} onClick={() => navigate('today')} title="今日"><Icon name="today"/><span>今日</span></button><button className={view === 'library' ? 'active' : ''} onClick={() => navigate('library')} title="资料库"><Icon name="library"/><span>资料库</span></button>{nav.slice(1).map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)} title={item.label}><Icon name={item.id}/><span>{item.label}</span></button>)}</nav><nav className="sidebar-bottom"><button className={view === 'diagnostics' ? 'active' : ''} onClick={() => navigate('diagnostics')} title="系统诊断"><Icon name="diagnosis"/><span>系统诊断</span></button><button className={view === 'settings' ? 'active' : ''} onClick={() => navigate('settings')} title="设置"><Icon name="settings"/><span>设置</span></button><button type="button" className="theme-toggle" title={theme === 'dark' ? '切换到白昼紫罗兰' : '切换到黑夜紫罗兰'} aria-label={theme === 'dark' ? '切换到白昼紫罗兰' : '切换到黑夜紫罗兰'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span><span>主题</span></button></nav></aside>
    <section className="workspace">
      {view === 'today' && <TodayView today={today} refresh={refreshToday} openStudio={() => navigate('studio')} openLibrary={() => navigate('library')} onPrimaryChange={setTodayPrimary} planDate={planDate}/>}
      {view === 'library' && <LibraryView sources={today?.sources ?? []} selectedId={librarySelectedId} onSelect={(source) => setLibrarySelectedId(source.id)}/>}
      {view === 'studio' && <StudioView studio={studio} refresh={refreshStudio} openPublish={() => navigate('publish')} selectedId={studioSelectedId} onSelect={setStudioSelectedId} planDate={planDate}/>}
      {view === 'publish' && <PublishView publications={publications} refresh={refreshPublications} openStudio={() => navigate('studio')} takeover={() => void window.wmb.startBrowser().then(refreshSettings)} selectedId={publishSelectedId} onSelect={setPublishSelectedId}/>}
      {view === 'results' && <ResultsView publications={publications} refresh={refreshPublications} planDate={planDate}/>}
      {view === 'settings' && <SettingsView dataRoot={dataRoot} settings={settings} browserChoice={browserChoice} setBrowserChoice={setBrowserChoice} refresh={refreshSettings}/>}
      {view === 'diagnostics' && <section className="page diagnostics-page"><header className="page-heading"><div><span>仅在异常时使用</span><h1>系统诊断</h1><p>检查本地数据、创作助手连接和专用浏览器。</p></div><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></header><div className="diagnostic-list"><article><div><h2>本地数据</h2><p>资料、内容和运行记录的存储状态</p></div><strong>{String(settings?.health.database ?? '未连接')}</strong></article><article><div><h2>创作助手连接</h2><p>外部创作助手能否读取当前终端</p></div><strong>{settings?.mcp.status === 'ready' ? '正常' : settings?.mcp.status ?? '未启动'}</strong></article><article><div><h2>专用浏览器</h2><p>用于登录平台、发布和读取结果</p></div><strong>{settings?.browser.status === 'ready' ? '已连接' : '未启动'}</strong></article></div></section>}
    </section>
    <PiDock collapsed={piDockCollapsed} toggle={() => setPiDockCollapsed((value) => !value)} configured={settings?.pi.configured ?? false} context={piContext}/>
    <footer className="status-bar">
      <div className="status-bar-left">
        <span className="status-chip" data-phase={piPhase}>{piStatusText}</span>
        <span className="status-sep">·</span>
        <span className="status-chip">{settings?.mcp?.status === 'ready' ? 'MCP 已连接' : 'MCP 未连接'}</span>
        <span className="status-sep">·</span>
        <span className="status-chip">{settings?.browser?.status === 'ready' ? '浏览器已连接' : '浏览器未启动'}</span>
      </div>
      <div className="status-bar-right">
        <time dateTime={now.toISOString()}>{dateLabel}</time>
      </div>
    </footer>
  </main>;
}

function domainOf(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return null; }
}

function publicationStatus(status: string): string {
  return ({ draft: '草稿', prepared: '已准备', awaiting_confirmation: '等待确认', publishing: '正在发布', published: '已发布', failed: '发布失败', needs_user: '需要你处理', unknown: '结果待核对' } as Record<string, string>)[status] || status;
}

createRoot(document.getElementById('root')!).render(<App />);
