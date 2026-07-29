import { useEffect, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import { SourceMark } from './source-mark';
import type { RankingContext, RankingContextItem } from './app-types';
import { formatNames, platformNames } from './app-types';
export function formatSourcePublishedAt(value?: string | null): string | null {
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

type PriorityGrade = 'SSS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

function priorityGrade(value: number | null | undefined): PriorityGrade {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'F';
  if (n === 0) return 'SSS';
  if (n === 1) return 'S';
  if (n === 2) return 'A';
  if (n === 3) return 'B';
  if (n === 4) return 'C';
  if (n === 5) return 'D';
  if (n === 6) return 'E';
  return 'F';
}

function priorityLabel(value: number | null | undefined): string {
  return `${priorityGrade(value)}级`;
}
export function Icon({ name }: { name: string }): React.JSX.Element {
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
      <p className="eyebrow">最新情报</p>
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

function Opportunity({ item, primary, selected, onToggle, onCreate, sources }: {
  item: TodayPlanItem; primary?: boolean; selected: boolean; onToggle: (item: TodayPlanItem) => void;
  onCreate: (item: TodayPlanItem) => void; sources: TodaySource[];
}): React.JSX.Element {
  const publishedAt = latestSourcePublishedAt(item.sourceIds, sources);
  const publishedLabel = formatSourcePublishedAt(publishedAt) ?? '发布时间未知';
  if (!primary) return <article data-opportunity-card className={`opportunity-small${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <div className="opportunity-tags"><strong data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong><time dateTime={publishedAt ?? undefined}>{publishedLabel}</time></div>
    <span className="opportunity-check" aria-hidden="true">✓</span>
    <h3>{item.title}</h3>
    <dl><dt>为什么现在值得做</dt><dd>{item.whyNow}</dd><dt>建议表达角度</dt><dd>{item.angle}</dd></dl>
    <footer><span>关联资料 {item.sourceIds.length} 条</span><span>{item.platforms.map((value) => platformNames[value] || value).join('、')}</span><button onClick={(event) => { event.stopPropagation(); onCreate(item); }}>进入创作</button></footer>
  </article>;
  return <article data-opportunity-card className={`opportunity-primary${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <div className="opportunity-tags"><strong data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong><time dateTime={publishedAt ?? undefined}>{publishedLabel}</time><span>关联资料 {item.sourceIds.length} 条</span></div>
    <span className="opportunity-check" aria-hidden="true">✓</span>
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
      <button className="primary-button" onClick={(event) => { event.stopPropagation(); onCreate(item); }}>进入创作</button>
    </footer>
  </article>;
}

export function TodayView({ today, refresh, openStudio, openLibrary, openPublish, publications, selectedItems, onSelectionChange, planDate }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void;
  openStudio: () => void;
  openLibrary: () => void;
  openPublish: () => void;
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  selectedItems: TodayPlanItem[];
  onSelectionChange: (items: TodayPlanItem[]) => void;
  planDate: string;
}): React.JSX.Element {
  const phaseLabels: Record<string, string> = {
    starting: '正在启动',
    resume_pending: '等待恢复',
    resuming: '正在恢复',
    planning_sources: '正在规划来源',
    scanning_sources: '正在扫描来源',
    synthesizing: '正在整理内容机会',
    validating: '正在核验结果',
    completed: '已完成',
    partial: '部分完成',
    failed: '运行失败',
    cancelled: '已取消',
    interrupted: '已中断'
  };
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [taskStatus, setTaskStatus] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [task, setTask] = useState<any>(null);
  const [, tick] = useState(0);
  const sources = today?.sources ?? [];
  const items = today?.plan?.items ?? [];
  const primary = items[0] ?? null;
  const pendingActions = today?.pendingActions ?? [];
  const awaiting = (publications ?? []).filter((item) => item.publication.status === 'awaiting_confirmation');
  const pendingCount = pendingActions.length + awaiting.length;
  const sssCount = items.filter((item) => priorityGrade(item.priority) === 'SSS').length;
  const [studioActive, setStudioActive] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void window.wmb.listStudioProjects({ limit: 50 }).then((result) => {
      if (!active || !result) return;
      setStudioActive(result.items.filter((item) => item.status !== 'completed' && !item.archivedAt).length);
    }).catch(() => {});
    return () => { active = false; };
  }, [today?.plan?.id]);
  useEffect(() => {
    const available = new Set(items.map((item) => item.id));
    const next = selectedItems.filter((item) => available.has(item.id));
    if (next.length !== selectedItems.length) onSelectionChange(next);
  }, [today?.plan?.id]);
  useEffect(() => {
    const load = () => void window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: planDate }).then((value) => {
      setTask(value);
      if (!value) return;
      const typed = value as { status?: string; phase?: string; errorMessage?: string | null };
      setRunning(typed.status === 'running');
      if (typed.status === 'running') setTaskStatus(typed.phase === 'starting' ? '今日情报正在启动…' : '今日情报正在运行');
      if (typed.status === 'failed') setTaskStatus(typed.errorMessage || '今日情报失败');
      if (typed.status === 'interrupted') setTaskStatus('上次情报任务已中断');
      if (typed.status === 'cancelled') setTaskStatus('今日情报已取消');
      if (typed.status === 'partial') setTaskStatus('已保存可用资料，任务部分完成');
      if (typed.status === 'succeeded') setTaskStatus('今日情报已完成');
    }).catch(() => {});
    load();
    const poll = window.setInterval(load, 3000);
    const clock = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, [planDate]);
  const create = async (item: TodayPlanItem) => { await window.wmb.createProjectFromPlanItem(item.id); openStudio(); };
  const toggleSelection = (item: TodayPlanItem) => {
    onSelectionChange(selectedItems.some((selected) => selected.id === item.id)
      ? selectedItems.filter((selected) => selected.id !== item.id)
      : [...selectedItems, item]);
  };
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
      if (result.data?.task) setTask(result.data.task);
      if (result.data?.reused) {
        setTaskStatus('今日情报已在运行，已复用当前任务');
      } else {
        setTaskStatus('今日情报已在后台启动');
      }
      refresh();
    } catch (error) {
      setTaskStatus(error instanceof Error ? error.message : String(error));
    } finally {
      window.setTimeout(() => refresh(), 300);
    }
  };
  return <div className="today-layout" onClick={(event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-opportunity-card], button, a, input, select, textarea')) onSelectionChange([]);
    }}>
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
      <div className="stat-strip">
        <div className="stat-cell"><div className="stat-label">今日新资料</div><div className="stat-value">{sources.length}</div><div className="stat-delta">已入库可追溯</div></div>
        <div className="stat-cell"><div className="stat-label">内容机会</div><div className="stat-value">{items.length}</div><div className={`stat-delta${sssCount ? ' up' : ''}`}>{sssCount ? `${sssCount} 个 SSS 级` : items.length ? '按等级排列' : '等待生成'}</div></div>
        <div className="stat-cell"><div className="stat-label">待你处理</div><div className="stat-value" data-tone={pendingCount ? 'amber' : undefined}>{pendingCount}</div><div className="stat-delta">{awaiting.length ? `${awaiting.length} 项发布确认` : pendingCount ? '需要人工介入' : '暂无待办'}</div></div>
        <div className="stat-cell"><div className="stat-label">进行中项目</div><div className="stat-value">{studioActive ?? '–'}</div><div className="stat-delta">创作中的内容项目</div></div>
      </div>
      {(pendingActions.length > 0 || awaiting.length > 0) && <div className="action-strip">
        {pendingActions.map((action) => <div className="action-card" key={action}>
          <div className="action-icon" aria-hidden="true">✋</div>
          <div>
            <div className="action-title">{action}</div>
            <div className="action-sub">需要人工处理后流程才能继续</div>
            {action.includes('运营方案') && <button className="action-go" disabled={running} onClick={() => void startIntelligence()}>开始今日情报</button>}
          </div>
        </div>)}
        {awaiting.map((item) => <div className="action-card" key={item.publication.id}>
          <div className="action-icon" aria-hidden="true">📣</div>
          <div>
            <div className="action-title">确认 {platformNames[item.publication.platform] ?? item.publication.platform} 发布内容</div>
            <div className="action-sub">{item.payload?.title || item.payload?.body.slice(0, 42) || '内容版本与素材已就绪'}</div>
            <button className="action-go" onClick={openPublish}>前往发布 →</button>
          </div>
        </div>)}
      </div>}
      {task?.status === 'running' && <section className="intelligence-progress">
        <div className="intelligence-progress-head"><strong>{phaseLabels[task.phase] ?? '正在处理'}</strong><span>已运行 {Math.max(0, Math.floor((Date.now() - Date.parse(task.createdAt)) / 60000))} 分钟</span></div>
        <p>当前来源：{task.progress?.currentSource || '准备中'} · 最后活动 {task.progress?.lastActivityAt ? Math.max(0, Math.floor((Date.now() - Date.parse(task.progress.lastActivityAt)) / 1000)) : 0} 秒前</p>
        {task.progress?.lastActivityAt && Date.now() - Date.parse(task.progress.lastActivityAt) > 45_000 &&
          <p className="intelligence-stalled">当前来源超过 45 秒没有业务进展；后台心跳仍会继续更新，可跳过此来源。</p>}
        <div className="intelligence-counts">
          <span>计划 {task.progress?.planned ?? 0}</span><span>处理 {task.progress?.processed ?? 0}</span>
          <span>失败 {task.progress?.failed ?? 0}</span><span>核验 {task.progress?.verified ?? 0}</span>
          <span>保存 {task.progress?.saved ?? 0}</span><span>机会 {task.progress?.opportunityCount ?? 0}</span>
        </div>
        <div className="intelligence-events">{(task.events ?? []).slice(-3).reverse().map((event: any) => <p key={`${event.at}-${event.message}`}>{event.message}</p>)}</div>
        <div className="intelligence-controls">
          <button onClick={() => void window.wmb.controlDailyIntelligence({ id: task.id, action: 'skip_source' })}>跳过当前来源</button>
          <button onClick={() => void window.wmb.controlDailyIntelligence({ id: task.id, action: 'save_partial' })}>保存已有结果并停止</button>
          <button onClick={() => void window.wmb.controlDailyIntelligence({ id: task.id, action: 'cancel' })}>取消任务</button>
        </div>
      </section>}
      {primary ? <div className="today-feed">
        {task?.status === 'running' && task.resultRefs?.planId !== today?.plan?.id && <p className="previous-plan-notice">以下是上一轮已完成结果；本轮新机会将在来源核验结束后更新。</p>}
        <p className="eyebrow">最高机会 · {priorityGrade(primary.priority)}</p>
        <Opportunity item={primary} primary selected={selectedItems.some((item) => item.id === primary.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>
        {items.length > 1 && <p className="eyebrow">全部机会 · 按等级</p>}
        {items.length > 1 && <section className="other-opportunities"><div>{items.slice(1).map((item) => <Opportunity key={item.id} item={item} selected={selectedItems.some((selected) => selected.id === item.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>)}</div></section>}
      </div> : <section className="empty-state"><h2>今日内容机会还在准备中</h2><p>点击“开始今日情报”，让 Pi 扫描并写入今天的内容机会。</p><button className="primary-button" disabled={running} onClick={() => void startIntelligence()}>{running ? '生成中…' : '开始今日情报'}</button></section>}
    </section>
    <button className={`drawer-backdrop${sourcesOpen ? ' open' : ''}`} aria-label="关闭关联资料" onClick={() => setSourcesOpen(false)}/>
    <SourceList sources={today?.sources ?? []} ids={[...new Set((selectedItems.length ? selectedItems : primary ? [primary] : []).flatMap((item) => item.sourceIds))]} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={openLibrary}/>
  </div>;
}

export function LibraryView({ rankingContext, onRankingContextChange }: {
  rankingContext: RankingContext;
  onRankingContextChange: (context: RankingContext) => void;
}): React.JSX.Element {
  const [section, setSection] = useState<'rankings' | 'saved' | 'topics' | 'rediscovery'>('rankings');
  const [knowledge, setKnowledge] = useState<{ items: any[]; total: number; limit: number; offset: number; hasMore: boolean } | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('');
  const [managementFilter, setManagementFilter] = useState('');
  const [knowledgeOffset, setKnowledgeOffset] = useState(0);
  const [topics, setTopics] = useState<any[]>([]);
  const [context, setContext] = useState<any>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<any>(null);
  const [rediscovery, setRediscovery] = useState<{ unused: any[]; watching: any[]; pending: any[] }>({ unused: [], watching: [], pending: [] });
  const [rankings, setRankings] = useState<Awaited<ReturnType<typeof window.wmb.getGitHubRankings>> | null>(null);
  const [boardId, setBoardId] = useState('github-daily');
  const [rankingError, setRankingError] = useState('');
  const [loadingRankings, setLoadingRankings] = useState(false);
  const loadRankings = async (refresh = false) => {
    setLoadingRankings(true);
    setRankingError('');
    try { setRankings(await window.wmb.getGitHubRankings(refresh)); }
    catch (error) { setRankingError(error instanceof Error ? error.message : String(error)); }
    finally { setLoadingRankings(false); }
  };
  useEffect(() => { void loadRankings(); }, []);
  const loadKnowledge = async () => setKnowledge(await window.wmb.listKnowledgeSources({
    query: knowledgeQuery, verificationStatus: verificationFilter || undefined, managementStatus: managementFilter || undefined,
    limit: 50, offset: knowledgeOffset
  }));
  useEffect(() => { if (section === 'saved') void loadKnowledge(); }, [section, knowledgeQuery, verificationFilter, managementFilter, knowledgeOffset]);
  useEffect(() => {
    if (section === 'topics') void window.wmb.listKnowledgeTopics({ limit: 100 }).then(setTopics);
    if (section === 'rediscovery') void window.wmb.getRediscovery().then(setRediscovery);
  }, [section]);
  const board = rankings?.boards.find((item) => item.id === boardId) ?? rankings?.boards[0];
  const selectBoard = (selectedBoard: NonNullable<typeof board>) => {
    const selectedItems = selectedBoard.items.map((item) => ({ ...item, boardId: selectedBoard.id, boardLabel: selectedBoard.label }));
    setBoardId(selectedBoard.id);
    onRankingContextChange({
      boards: [{ id: selectedBoard.id, label: selectedBoard.label, sourceUrl: selectedBoard.sourceUrl, items: selectedItems }],
      items: []
    });
  };
  const toggleRankingItem = (item: RankingContextItem) => {
    const selected = rankingContext.items.some((value) => value.boardId === item.boardId && value.name === item.name);
    onRankingContextChange({
      boards: [],
      items: selected
        ? rankingContext.items.filter((value) => value.boardId !== item.boardId || value.name !== item.name)
        : [...rankingContext.items, item]
    });
  };
  return <section className="page library-page" onClick={(event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('[data-ranking-item], button, a, input, select, textarea')) onRankingContextChange({ boards: [], items: [] });
  }}>
    <header className="page-heading"><div><span>发现与积累</span><h1>{section === 'rankings' ? 'AI 榜单' : section === 'topics' ? '长期主题' : section === 'rediscovery' ? '重新发现' : '值得长期使用的资料'}</h1><p>{section === 'rankings' ? '直接看正在增长的项目、Skill、MCP、模型和 AI 产品。' : '资料会持续归入主题，并与后续内容、发布和复盘相连。'}</p></div>{section === 'saved' && <div className="stat-summary"><strong>{knowledge?.total ?? 0}</strong><span>条入库资料</span></div>}</header>
    <nav className="library-sections" aria-label="资料库分页面">
      <button className={section === 'rankings' ? 'active' : ''} onClick={() => setSection('rankings')}>AI 榜单</button>
      <button className={section === 'saved' ? 'active' : ''} onClick={() => setSection('saved')}>入库资料</button>
      <button className={section === 'topics' ? 'active' : ''} onClick={() => setSection('topics')}>主题</button>
      <button className={section === 'rediscovery' ? 'active' : ''} onClick={() => setSection('rediscovery')}>重新发现</button>
    </nav>
    {section === 'rankings' ? <>
      <div className="page-toolbar ranking-toolbar">
        <div className="filter-row">{rankings?.boards.map((item) => <button className={`filter${item.id === board?.id ? ' active' : ''}${rankingContext.boards.some((selected) => selected.id === item.id) ? ' context-selected' : ''}`} key={item.id} onClick={() => selectBoard(item)}>{rankingContext.boards.some((selected) => selected.id === item.id) ? '✓ ' : ''}{item.label}</button>)}</div>
        <div className="ranking-actions"><button className="refresh-button" disabled={loadingRankings} title={loadingRankings ? '正在刷新榜单' : '刷新榜单'} aria-label={loadingRankings ? '正在刷新榜单' : '刷新榜单'} onClick={() => void loadRankings(true)}><span className={loadingRankings ? 'ranking-refresh-spinning' : ''} aria-hidden="true">↻</span></button></div>
      </div>
      {rankingError ? <section className="empty-state library-empty"><h2>榜单读取失败</h2><p>{rankingError}</p></section>
        : !rankings || loadingRankings && !board ? <section className="ranking-loading">正在读取最新榜单…</section>
        : board?.status === 'unavailable' ? <section className="empty-state library-empty"><h2>{board.label} 暂时不可读</h2><p>{board.error}</p><button onClick={() => void window.wmb.openExternal(board.sourceUrl)}>打开来源</button></section>
        : <div className="ranking-list">{board?.items.map((item) => {
          const contextItem = { ...item, boardId: board.id, boardLabel: board.label };
          const selected = rankingContext.items.some((value) => value.boardId === board.id && value.name === item.name);
          return <article key={`${board.id}-${item.name}`} data-ranking-item className={selected ? 'selected' : ''} onClick={() => toggleRankingItem(contextItem)}>
          <strong className="ranking-number">{item.rank}</strong>
          <div><h2>{item.name}</h2><p>{item.description || '该项目尚未提供简介。'}</p><small>{[item.language, item.stars && `★ ${item.stars}`, item.gained].filter(Boolean).join(' · ')}</small></div>
          {selected && <span className="ranking-check" aria-label="已选中">✓</span>}
          <button className="ranking-open" title="查看项目" aria-label={`查看 ${item.name}`} onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(item.url); }}><span aria-hidden="true">↗</span></button>
        </article>; })}</div>}
      {rankings && <p className="ranking-footnote">更新于 {new Date(rankings.fetchedAt).toLocaleString('zh-CN')} · 数据来自 <button onClick={() => board && void window.wmb.openExternal(board.sourceUrl)}>{board?.label}</button></p>}
    </> : section === 'saved' ? <>
      <div className="page-toolbar knowledge-toolbar">
        <input aria-label="搜索资料" placeholder="搜索标题、摘要或关键词" value={knowledgeQuery} onChange={(e) => { setKnowledgeQuery(e.target.value); setKnowledgeOffset(0); }}/>
        <span className="chip-label">核验</span>
        {([['', '全部'], ['verified', '已核验'], ['pending', '待核验'], ['disputed', '有争议'], ['rejected', '已排除']] as const).map(([value, label]) => <button key={value} className={`chip${verificationFilter === value ? ' on' : ''}`} aria-label={`核验状态 ${label}`} onClick={() => { setVerificationFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
        <span className="chip-label">管理</span>
        {([['', '全部'], ['active', '活跃'], ['watching', '持续观察'], ['expired', '已过期'], ['archived', '已归档']] as const).map(([value, label]) => <button key={value} className={`chip${managementFilter === value ? ' on' : ''}`} aria-label={`管理状态 ${label}`} onClick={() => { setManagementFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
      </div>
      {knowledge?.items.length ? <div className="library-list">{knowledge.items.map((source) => <article key={source.id} onClick={() => { setSelectedKnowledge(source); void window.wmb.getKnowledgeContext({ sourceId: source.id }).then(setContext); }}>
        <SourceMark canonicalUrl={source.originalUrl}/>
        <div><div className="library-meta"><span>{source.verificationStatus === 'verified' ? '已核验' : '待核验'} · {source.managementStatus === 'watching' ? '持续观察' : source.managementStatus === 'archived' ? '已归档' : '活跃'}</span><time>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt)}</time></div><h2>{source.title}</h2><p>{source.summary || '这条资料尚未补充摘要。'}</p><small>{source.topics || '尚未归入主题'} · 机会 {source.opportunityCount} · 内容 {source.projectCount} · 发布 {source.publicationCount}</small></div>
        <div className="lib-side">
          <span className={`pill-status ${source.verificationStatus === 'verified' ? 'green' : 'gray'}`}><span className="dot"/>{source.verificationStatus === 'verified' ? '已核验' : source.verificationStatus === 'disputed' ? '有争议' : source.verificationStatus === 'rejected' ? '已排除' : '待核验'}</span>
          {source.managementStatus === 'watching' && <span className="pill-status blue">持续观察</span>}
          {(source.managementStatus === 'archived' || source.managementStatus === 'expired') && <span className="pill-status gray">{source.managementStatus === 'archived' ? '已归档' : '已过期'}</span>}
          {source.originalUrl && <button onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(source.originalUrl); }}>原文 ↗</button>}
        </div>
      </article>)}</div> : <section className="empty-state library-empty"><h2>没有匹配资料</h2><p>调整搜索或筛选条件后再看。</p></section>}
      <div className="knowledge-pager"><button disabled={knowledgeOffset === 0} onClick={() => setKnowledgeOffset(Math.max(0, knowledgeOffset - 50))}>上一页</button><span>{knowledgeOffset + 1}–{Math.min(knowledgeOffset + 50, knowledge?.total ?? 0)} / {knowledge?.total ?? 0}</span><button disabled={!knowledge?.hasMore} onClick={() => setKnowledgeOffset(knowledgeOffset + 50)}>下一页</button></div>
      {context && <section className="knowledge-context"><button aria-label="关闭历史上下文" onClick={() => { setContext(null); setSelectedKnowledge(null); }}>×</button><h2>历史上下文</h2>
        {selectedKnowledge && <div className="knowledge-status-controls">
          <label>核验<select value={selectedKnowledge.verificationStatus} onChange={async (event) => { const result = await window.wmb.updateKnowledgeSource({ id: selectedKnowledge.id, expectedRevision: selectedKnowledge.revision, verificationStatus: event.target.value }); setSelectedKnowledge({ ...selectedKnowledge, verificationStatus: event.target.value, revision: result.revision }); void loadKnowledge(); }}><option value="pending">待核验</option><option value="verified">已核验</option><option value="disputed">有争议</option><option value="rejected">已排除</option></select></label>
          <label>管理<select value={selectedKnowledge.managementStatus} onChange={async (event) => { const result = await window.wmb.updateKnowledgeSource({ id: selectedKnowledge.id, expectedRevision: selectedKnowledge.revision, managementStatus: event.target.value }); setSelectedKnowledge({ ...selectedKnowledge, managementStatus: event.target.value, revision: result.revision }); void loadKnowledge(); }}><option value="active">活跃</option><option value="watching">持续观察</option><option value="expired">已过期</option><option value="archived">已归档</option></select></label>
        </div>}
        <p>关联资料 {context.sources.length} · 内容机会 {context.opportunities.length} · 内容项目 {context.projects.length} · 已发布 {context.publications.length} · 指标 {context.metrics.length} · 最终复盘 {context.reviews.length}</p>{context.reviews.map((review: any) => <article key={review.id}><strong>复盘</strong><p>{review.summary || '无摘要'}</p></article>)}{context.findings.map((finding: any) => <article key={finding.id}><strong>{finding.title}</strong><p>{finding.body}</p></article>)}</section>}
    </> : section === 'topics' ? <div className="topic-list">{topics.map((topic) => <button key={topic.id} onClick={() => void window.wmb.getKnowledgeContext({ topicId: topic.id }).then(setContext)}><strong>{topic.title}</strong><span>{topic.sourceCount} 条资料 · {topic.opportunityCount} 个机会 · {topic.status === 'watching' ? '持续观察' : '活跃'}</span></button>)}{!topics.length && <section className="empty-state library-empty"><h2>尚未形成主题</h2><p>下一轮情报会把资料归入稳定主题。</p></section>}{context && <section className="knowledge-context"><button onClick={() => setContext(null)}>×</button><h2>{context.topics[0]?.title || '主题历史'}</h2><p>资料 {context.sources.length} · 机会 {context.opportunities.length} · 内容 {context.projects.length} · 发布 {context.publications.length} · 指标 {context.metrics.length} · 复盘 {context.reviews.length} · 方法结论 {context.findings.length}</p></section>}</div>
    : <div className="rediscovery-groups">{([['高价值但尚未创作', rediscovery.unused], ['持续观察', rediscovery.watching], ['待核验超过 7 天', rediscovery.pending]] as const).map(([title, items]) => <section key={title}><h2>{title}<span>{items.length}</span></h2>{items.length ? items.map((item) => <button key={item.id} onClick={() => void window.wmb.getKnowledgeContext({ sourceId: item.id }).then(setContext)}><strong>{item.title}</strong><small>{item.reason}</small></button>) : <p>当前没有此类资料。</p>}</section>)}</div>}
  </section>;
}

function domainOf(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return null; }
}
