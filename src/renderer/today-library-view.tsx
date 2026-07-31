import { useEffect, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import { SourceMark } from './source-mark';
import { PlatformMark } from './platform-mark';
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

function latestSourceTime(sourceIds: string[], sources: TodaySource[]): { at: string | null; kind: 'published' | 'collected' | null } {
  let bestPublishedMs = Number.NEGATIVE_INFINITY;
  let bestPublished: string | null = null;
  let bestCollectedMs = Number.NEGATIVE_INFINITY;
  let bestCollected: string | null = null;
  for (const id of sourceIds) {
    const source = sources.find((item) => item.id === id);
    if (!source) continue;
    if (source.publishedAt) {
      const ms = Date.parse(source.publishedAt);
      if (!Number.isNaN(ms) && ms >= bestPublishedMs) {
        bestPublishedMs = ms;
        bestPublished = source.publishedAt;
      } else if (Number.isNaN(ms) && !bestPublished) {
        bestPublished = source.publishedAt;
      }
    }
    if (source.collectedAt) {
      const ms = Date.parse(source.collectedAt);
      if (!Number.isNaN(ms) && ms >= bestCollectedMs) {
        bestCollectedMs = ms;
        bestCollected = source.collectedAt;
      }
    }
  }
  if (bestPublished) return { at: bestPublished, kind: 'published' };
  if (bestCollected) return { at: bestCollected, kind: 'collected' };
  return { at: null, kind: null };
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
  return priorityGrade(value);
}
export function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.JSX.Element> = {
    today: <><path d="M3 5h18v16H3z"/><path d="M7 3v4M17 3v4M3 10h18"/></>,
    library: <><path d="M3 4h7l2 3h9v13H3z"/></>,
    discover: <><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.3 4.7-4.7 2.3 2.3-4.7z"/></>,
    knowledge: <><circle cx="12" cy="12" r="3"/><circle cx="4.5" cy="5" r="2"/><circle cx="19.5" cy="5" r="2"/><circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="19" r="2"/><path d="m6 6.5 4.2 3.7M18 6.5l-4.2 3.7M6 17.5l4.2-3.7M18 17.5l-4.2-3.7"/></>,
    canvas: <><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.4 10.8 7.2-4.6M8.4 13.2l7.2 4.6"/></>,
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
          <p>{formatSourcePublishedAt(source.publishedAt) ?? (formatSourcePublishedAt(source.collectedAt) ? `入库 ${formatSourcePublishedAt(source.collectedAt)}` : '时间未知')}{source.author ? ` · ${source.author}` : (domainOf(source.canonicalUrl) ? ` · ${domainOf(source.canonicalUrl)}` : '')}</p>
        </div>
        {source.canonicalUrl && <button className="text-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}
      </article>)}
      {!selected.length && <p className="empty-copy">当前机会没有可展示的关联资料。</p>}
    </div>
    <button className="wide-secondary" onClick={openLibrary}>查看全部入库资料 <span>›</span></button>
  </aside>;
}


function CreateIconButton({ onClick, primary }: { onClick: () => void; primary?: boolean }): React.JSX.Element {
  return <button
    type="button"
    className={`icon-action-button create-action${primary ? ' primary' : ''}`}
    aria-label="开始创作"
    title="开始创作"
    onClick={(event) => { event.stopPropagation(); onClick(); }}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
      <path
        d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m13.5 7 3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>;
}

function Opportunity({ item, primary, selected, onToggle, onCreate, sources }: {
  item: TodayPlanItem; primary?: boolean; selected: boolean; onToggle: (item: TodayPlanItem) => void;
  onCreate: (item: TodayPlanItem) => void; sources: TodaySource[];
}): React.JSX.Element {
  const sourceTime = latestSourceTime(item.sourceIds, sources);
  const timeText = formatSourcePublishedAt(sourceTime.at);
  const timeLabel = timeText
    ? (sourceTime.kind === 'collected' ? `入库 ${timeText}` : timeText)
    : '时间未知';
  if (!primary) return <article data-opportunity-card className={`opp-row${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <strong className="opp-grade" data-grade={priorityGrade(item.priority)}>{priorityGrade(item.priority)}</strong>
    <div className="opp-main">
      <div className="opp-title">{item.title}</div>
      <div className="opp-why">{item.whyNow}</div>
      <div className="opp-meta">
        {item.platforms.map((value) => <span className={`pf-tag ${value}`} key={value}><PlatformMark platform={value}/>{platformNames[value] || value}</span>)}
        <span className="pill gray">引用资料 ×{item.sourceIds.length}</span>
        <span className="opp-faint">工作量 {item.effortEstimate}</span>
      </div>
    </div>
    <span className="opportunity-check" aria-hidden="true">✓</span>
    <CreateIconButton onClick={() => onCreate(item)}/>
  </article>;
  return <article data-opportunity-card className={`opportunity-primary hero-card${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <span className="opportunity-check" aria-hidden="true">✓</span>
    <div className="opportunity-tags hero-tags">
      <strong data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong>
      {item.platforms.map((value) => <span className={`pf-tag ${value}`} key={value}><PlatformMark platform={value}/>{platformNames[value] || value}</span>)}
      <span className="pill violet">时效 {item.timeliness}</span>
      <time dateTime={sourceTime.at ?? undefined}>{timeLabel}</time>
    </div>
    <h2>{item.title}</h2>
    <p className="hero-why">入选理由：{item.whyNow}</p>
    <div className="editorial-brief">
      <dl className="brief-core">
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
    <footer className="hero-meta">
      <span className="pill gray">目标：{item.targetAudience}</span>
      <span className="pill gray">形式：{item.formats.map((value) => formatNames[value] || value).join('、')}</span>
      <span className="pill gray">工作量 {item.effortEstimate}</span>
      <span className="pill gray">引用资料 ×{item.sourceIds.length}</span>
      <CreateIconButton primary onClick={() => onCreate(item)}/>
    </footer>
  </article>;
}

export function TodayView({ today, refresh, openStudio, openLibrary, selectedItems, onSelectionChange, planDate, onStatusChange }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void;
  openStudio: () => void;
  openLibrary: () => void;
  selectedItems: TodayPlanItem[];
  onSelectionChange: (items: TodayPlanItem[]) => void;
  planDate: string;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void;
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
  // Publish confirmation belongs on the Publish page, not the Today home rail.
  const pendingCount = pendingActions.length;
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
  useEffect(() => {
    if (!onStatusChange) return;
    if (!taskStatus) {
      onStatusChange(null);
      return;
    }
    onStatusChange({ text: taskStatus, running });
    return () => onStatusChange(null);
  }, [taskStatus, running, onStatusChange]);
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
  const dateTitle = (() => {
    const date = new Date(`${planDate}T12:00:00+08:00`);
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${week}`;
  })();
  const taskPhaseLabel = task?.phase ? (phaseLabels[task.phase] ?? '正在处理') : '正在处理';
  const planned = Math.max(0, Number(task?.progress?.planned ?? 0));
  const processed = Math.max(0, Number(task?.progress?.processed ?? 0));
  const failed = Math.max(0, Number(task?.progress?.failed ?? 0));
  const verified = Math.max(0, Number(task?.progress?.verified ?? 0));
  const saved = Math.max(0, Number(task?.progress?.saved ?? 0));
  const opportunityCount = Math.max(0, Number(task?.progress?.opportunityCount ?? 0));
  const progressRatio = planned > 0 ? Math.min(1, processed / planned) : (running ? Math.min(0.9, 0.12 + processed * 0.08) : 0);
  const progressPct = Math.round(progressRatio * 100);
  const currentSource = String(task?.progress?.currentSource || '').trim();
  const lastEvent = Array.isArray(task?.events) && task.events.length
    ? task.events[task.events.length - 1]
    : null;
  const lastEventText = lastEvent?.message ? String(lastEvent.message).trim() : '';
  const sourceElapsedSec = task?.progress?.lastActivityAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(task.progress.lastActivityAt)) / 1000))
    : 0;
  // Heartbeat keeps updating while Pi is alive; source activity only moves on real route progress.
  // A long silent source is normal (single route can take minutes). Only dead heartbeat means stuck.
  const heartbeatAgeSec = task?.heartbeatAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(task.heartbeatAt)) / 1000))
    : (task?.updatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(task.updatedAt)) / 1000)) : 0);
  const reallyStuck = running && heartbeatAgeSec > 60;
  const elapsedMin = task?.createdAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(task.createdAt)) / 60000))
    : 0;
  const formatDuration = (totalSec: number) => {
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return sec ? `${min}m${sec}s` : `${min}m`;
  };
  return <div className="today-layout" onClick={(event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-opportunity-card], button, a, input, select, textarea')) onSelectionChange([]);
    }}>
    <section className="today-main">
      <header className="page-heading today-heading">
        <div><h1>{dateTitle}</h1></div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={() => setSourcesOpen(true)}>查看资料</button>
          <button className="refresh-button" onClick={refresh}>↻ 刷新</button>
          <button className="primary-button" disabled={running} onClick={() => void startIntelligence()}>{running ? '生成中…' : primary ? '⟳ 重新侦察' : '开始今日情报'}</button>
        </div>
      </header>
      <div className="stat-strip">
        <div className="stat-cell"><div className="stat-label">今日新资料</div><div className="stat-value">{sources.length}</div><div className="stat-delta">已入库可追溯</div></div>
        <div className="stat-cell"><div className="stat-label">内容机会</div><div className="stat-value">{items.length}</div><div className={`stat-delta${sssCount ? ' up' : ''}`}>{sssCount ? `${sssCount} 个 SSS 级` : items.length ? '按等级排列' : '等待生成'}</div></div>
        <div className="stat-cell"><div className="stat-label">待你处理</div><div className="stat-value" data-tone={pendingCount ? 'amber' : undefined}>{pendingCount}</div><div className="stat-delta">{pendingCount ? '需要人工介入' : '暂无待办'}</div></div>
        <div className="stat-cell"><div className="stat-label">进行中项目</div><div className="stat-value">{studioActive ?? '–'}</div><div className="stat-delta">创作中的内容项目</div></div>
      </div>

      {task?.status === 'running' && <section className="intelligence-progress" aria-live="polite">
        <div className="intelligence-progress-head">
          <div className="intelligence-progress-title">
            <strong>{taskPhaseLabel}</strong>
            {currentSource ? <span className="intelligence-source">当前：{currentSource}</span> : null}
          </div>
          <div className="intelligence-progress-meta">
            {reallyStuck
              ? <em className="intelligence-stalled-pill">疑似卡死 {formatDuration(heartbeatAgeSec)}</em>
              : (currentSource && sourceElapsedSec > 0
                ? <em className="intelligence-source-timer">本源 {formatDuration(sourceElapsedSec)}</em>
                : null)}
            <span>{planned > 0 ? `${processed}/${planned}` : `${progressPct}%`}</span>
            <span>已运行 {elapsedMin} 分钟</span>
          </div>
        </div>
        <div className="intelligence-bar" aria-label={`进度 ${progressPct}%`}>
          <i style={{ width: `${Math.max(progressPct, running ? 6 : 0)}%` }} />
        </div>
        <div className="intelligence-counts" aria-label="进度计数">
          <span><b>{planned}</b>计划</span>
          <span><b>{processed}</b>处理</span>
          <span><b>{failed}</b>失败</span>
          <span><b>{verified}</b>核验</span>
          <span><b>{saved}</b>保存</span>
          <span><b>{opportunityCount}</b>机会</span>
        </div>
        {reallyStuck ? (
          <p className="intelligence-last-event">任务心跳超过 60 秒未更新，进程可能已挂起；可跳过当前来源或取消后重试。</p>
        ) : lastEventText && lastEventText !== currentSource && !(currentSource && lastEventText.includes(currentSource)) ? (
          <p className="intelligence-last-event">{lastEventText}</p>
        ) : null}
        <div className="intelligence-controls">
          <button onClick={() => void window.wmb.controlDailyIntelligence({ id: task.id, action: 'skip_source' })}>跳过当前来源</button>
          <button onClick={() => void window.wmb.controlDailyIntelligence({ id: task.id, action: 'save_partial' })}>保存已有结果并停止</button>
          <button onClick={() => void window.wmb.controlDailyIntelligence({ id: task.id, action: 'cancel' })}>取消任务</button>
        </div>
      </section>}
      <div className="today-grid">
        <div className="today-opps">
          {primary ? <>
            {task?.status === 'running' && task.resultRefs?.planId !== today?.plan?.id && <p className="previous-plan-notice">以下是上一轮已完成结果；本轮新机会将在来源核验结束后更新。</p>}
            <Opportunity item={primary} primary selected={selectedItems.some((item) => item.id === primary.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>
            {items.length > 1 && <div className="opp-list">{items.slice(1).map((item) => <Opportunity key={item.id} item={item} selected={selectedItems.some((selected) => selected.id === item.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>)}</div>}
          </> : <section className="empty-state">
            <h2>{running ? '正在侦察今日内容机会' : '今日内容机会还在准备中'}</h2>
            <p>{running
              ? (currentSource ? `正在处理：${currentSource}` : '来源扫描和整理完成后，机会会自动出现在这里。')
              : '点击右上角“开始今日情报”，让 Pi 扫描并写入今天的内容机会。'}</p>
            {!running && <button className="primary-button" onClick={() => void startIntelligence()}>开始今日情报</button>}
          </section>}
        </div>
        <aside className="today-rail">
          {pendingActions.length > 0 && <>
            <p className="eyebrow">待你处理 · {pendingCount}</p>
            {pendingActions.map((action) => <div className="action-card" key={action}>
              <div className="action-icon" aria-hidden="true">✋</div>
              <div>
                <div className="action-title">{action}</div>
                <div className="action-sub">需要人工处理后流程才能继续</div>
                {action.includes('运营方案') && <button className="action-go" disabled={running} onClick={() => void startIntelligence()}>开始今日情报</button>}
              </div>
            </div>)}
          </>}
          <div className="feed-list">
            {sources.slice(0, 6).map((source) => <div className="feed-item" key={source.id}>
              <SourceMark canonicalUrl={source.canonicalUrl}/>
              <div>
                <div className="feed-title">{source.title}</div>
                <div className="feed-sub"><span>{source.categories[0] || '入库资料'}</span><span>·</span><span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? '时间未知'}</span></div>
              </div>
            </div>)}
            {!sources.length && <p className="empty-copy rail-feed-empty">今日还没有入库资料。</p>}
          </div>
        </aside>
      </div>
    </section>
    <button className={`drawer-backdrop${sourcesOpen ? ' open' : ''}`} aria-label="关闭关联资料" onClick={() => setSourcesOpen(false)}/>
    <SourceList sources={today?.sources ?? []} ids={[...new Set((selectedItems.length ? selectedItems : primary ? [primary] : []).flatMap((item) => item.sourceIds))]} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={openLibrary}/>
  </div>;
}

export function LibraryView(): React.JSX.Element {
  const [section, setSection] = useState<'saved' | 'topics' | 'rediscovery'>('saved');
  const [knowledge, setKnowledge] = useState<{ items: any[]; total: number; limit: number; offset: number; hasMore: boolean } | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('');
  const [managementFilter, setManagementFilter] = useState('');
  const [knowledgeOffset, setKnowledgeOffset] = useState(0);
  const [topics, setTopics] = useState<any[]>([]);
  const [context, setContext] = useState<any>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<any>(null);
  const [rediscovery, setRediscovery] = useState<{ unused: any[]; watching: any[]; pending: any[] }>({ unused: [], watching: [], pending: [] });
  const loadKnowledge = async () => setKnowledge(await window.wmb.listKnowledgeSources({
    query: knowledgeQuery, verificationStatus: verificationFilter || undefined, managementStatus: managementFilter || undefined,
    limit: 50, offset: knowledgeOffset
  }));
  useEffect(() => { if (section === 'saved') void loadKnowledge(); }, [section, knowledgeQuery, verificationFilter, managementFilter, knowledgeOffset]);
  useEffect(() => {
    if (section === 'topics') void window.wmb.listKnowledgeTopics({ limit: 100 }).then(setTopics);
    if (section === 'rediscovery') void window.wmb.getRediscovery().then(setRediscovery);
  }, [section]);
  return <section className="page library-page">
    <nav className="library-sections" aria-label="资料库分页面">
      <button className={section === 'saved' ? 'active' : ''} onClick={() => setSection('saved')}>入库资料</button>
      <button className={section === 'topics' ? 'active' : ''} onClick={() => setSection('topics')}>主题</button>
      <button className={section === 'rediscovery' ? 'active' : ''} onClick={() => setSection('rediscovery')}>重新发现</button>
    </nav>
    {section === 'saved' ? <>
      <div className="page-toolbar knowledge-toolbar">
        <input aria-label="搜索资料" placeholder="搜索标题、摘要或关键词" value={knowledgeQuery} onChange={(e) => { setKnowledgeQuery(e.target.value); setKnowledgeOffset(0); }}/>
        <span className="chip-label">核验</span>
        {([['', '全部'], ['verified', '已核验'], ['pending', '待核验'], ['disputed', '有争议'], ['rejected', '已排除']] as const).map(([value, label]) => <button key={value} className={`chip${verificationFilter === value ? ' on' : ''}`} aria-label={`核验状态 ${label}`} onClick={() => { setVerificationFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
        <span className="chip-label">管理</span>
        {([['', '全部'], ['active', '活跃'], ['watching', '持续观察'], ['expired', '已过期'], ['archived', '已归档']] as const).map(([value, label]) => <button key={value} className={`chip${managementFilter === value ? ' on' : ''}`} aria-label={`管理状态 ${label}`} onClick={() => { setManagementFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
      </div>
      {knowledge?.items.length ? <div className="library-list">{knowledge.items.map((source) => {
        const statePill = source.managementStatus === 'watching' ? { cls: 'blue', text: '观察中' }
          : source.managementStatus === 'archived' ? { cls: 'gray', text: '已归档' }
          : source.managementStatus === 'expired' ? { cls: 'gray', text: '已过期' }
          : source.verificationStatus === 'verified' ? { cls: 'green', text: '已验证' }
          : source.verificationStatus === 'disputed' ? { cls: 'amber', text: '有争议' }
          : source.verificationStatus === 'rejected' ? { cls: 'gray', text: '已排除' }
          : { cls: 'gray', text: '待验证' };
        const tags = String(source.topics || '').split(/[,，、]/).map((tag: string) => tag.trim()).filter((tag: string) => tag && tag !== '尚未归入主题').slice(0, 4);
        return <article className="lib-row" key={source.id} onClick={() => { setSelectedKnowledge(source); void window.wmb.getKnowledgeContext({ sourceId: source.id }).then(setContext); }}>
          <SourceMark canonicalUrl={source.originalUrl}/>
          <div className="lib-main">
            <div className="lib-title">{source.title}</div>
            <div className="lib-sum">{source.summary || '这条资料尚未补充摘要。'}</div>
            <div className="lib-tags">{tags.map((tag: string) => <span className="tag" key={tag}>{tag}</span>)}<span className="tag lib-count">机会 {source.opportunityCount} · 内容 {source.projectCount} · 发布 {source.publicationCount}</span></div>
          </div>
          <div className="lib-side">
            <span className={`pill-status ${statePill.cls}`}><span className="dot"/>{statePill.text}</span>
            <span className="lib-time">{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt)}</span>
            {source.originalUrl && <button onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(source.originalUrl); }}>原文 ↗</button>}
          </div>
        </article>;
      })}</div> : <section className="empty-state library-empty"><h2>没有匹配资料</h2><p>调整搜索或筛选条件后再看。</p></section>}
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
