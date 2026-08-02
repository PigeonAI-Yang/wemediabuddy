import type { PiFocusObject } from './app-types';
import { useEffect, useRef, useState } from 'react';
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

export type SelectedTodaySource = TodaySource & {
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty';
  bodyExcerpt?: string | null;
  bodyChars?: number;
};

const MAX_SELECTED_SOURCES = 5;
const BODY_EXCERPT_CHARS = 4000;

function isHeartbeatSource(source: TodaySource): boolean {
  const title = source.title || '';
  if (title.startsWith('[官宣巡检]')) return true;
  const categories = source.categories || [];
  if (categories.includes('wire_heartbeat') || categories.includes('official_heartbeat')) return true;
  const summary = (source.summary || '').trim();
  if (!summary) return true;
  // Very thin homepage shells: short summary that mostly restates the title.
  if (summary.length < 80 && title && summary.includes(title.replace(/^\[官宣巡检\]\s*/, '').slice(0, 12))) return true;
  return false;
}

function sortFeedSources(sources: TodaySource[]): TodaySource[] {
  return [...sources].sort((a, b) => {
    const ah = isHeartbeatSource(a) ? 1 : 0;
    const bh = isHeartbeatSource(b) ? 1 : 0;
    if (ah !== bh) return ah - bh;
    return String(b.collectedAt || '').localeCompare(String(a.collectedAt || ''));
  });
}

function bodyToSelectedFields(body: {
  status: 'ready' | 'failed' | 'empty';
  extractedText: string;
  extractedChars: number;
} | null | undefined): Pick<SelectedTodaySource, 'bodyStatus' | 'bodyExcerpt' | 'bodyChars'> {
  if (!body) return { bodyStatus: 'none', bodyExcerpt: null, bodyChars: 0 };
  if (body.status === 'ready' && body.extractedText.trim()) {
    return {
      bodyStatus: 'ready',
      bodyExcerpt: body.extractedText.slice(0, BODY_EXCERPT_CHARS),
      bodyChars: body.extractedChars || body.extractedText.length
    };
  }
  return {
    bodyStatus: body.status,
    bodyExcerpt: null,
    bodyChars: body.extractedChars || 0
  };
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

function SourceList({ sources, open, close, openLibrary, aiSourcePresentation }: {
  sources: TodaySource[];
  open: boolean; close: () => void;
  openLibrary: (sourceId?: string) => void;
  aiSourcePresentation: boolean;
}): React.JSX.Element {
  const ordered = sortFeedSources(sources);
  return <aside className={`sources-panel${open ? ' open' : ''}`} aria-label="今日资料">
    <div className="panel-heading">
      <p className="eyebrow">今日资料 · {ordered.length}</p>
      <div><h2>完整入库列表</h2><button className="close-sources" aria-label="关闭今日资料" onClick={close}>×</button></div>
      <p>首页只展示最新最重要；这里看今日全部资料</p>
    </div>
    <div className="source-list">
      {ordered.map((source) => <article className="source-row" key={source.id}>
        <SourceMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation}/>
        <div>
          <span className="source-type">{isHeartbeatSource(source) ? '巡检打卡' : (source.categories[0] || '入库资料')}</span>
          <h3>{source.title}</h3>
          <p>{formatSourcePublishedAt(source.publishedAt) ?? (formatSourcePublishedAt(source.collectedAt) ? `入库 ${formatSourcePublishedAt(source.collectedAt)}` : '时间未知')}{source.author ? ` · ${source.author}` : (domainOf(source.canonicalUrl) ? ` · ${domainOf(source.canonicalUrl)}` : '')}</p>
        </div>
        {source.canonicalUrl && <button className="text-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}
      </article>)}
      {!ordered.length && <p className="empty-copy">今日还没有入库资料。</p>}
    </div>
    <button className="wide-secondary" onClick={() => openLibrary()}>打开资料库 <span>›</span></button>
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
      <span className="pill gray">引用资料 ×{item.sourceIds.length}</span>
      <CreateIconButton primary onClick={() => onCreate(item)}/>
    </footer>
  </article>;
}

export function TodayView({ today, refresh, openStudio, openLibrary, selectedItems, onSelectionChange, selectedSources, onSelectedSourcesChange, planDate, onStatusChange, aiSourcePresentation }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void;
  openStudio: () => void;
  openLibrary: (sourceId?: string) => void;
  selectedItems: TodayPlanItem[];
  onSelectionChange: (items: TodayPlanItem[]) => void;
  selectedSources: SelectedTodaySource[];
  onSelectedSourcesChange: (sources: SelectedTodaySource[]) => void;
  planDate: string;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void; aiSourcePresentation: boolean;
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
  const fermenting = today?.fermenting ?? { items: [], watchingItems: [], topics: [], pinnedSources: [] };
  const feedSources = sortFeedSources(sources);
  const pinnedSourceIds = new Set((fermenting.pinnedSources || []).map((item) => item.id));
  const items = today?.plan?.items ?? [];
  const primary = items[0] ?? null;
  const pendingActions = today?.pendingActions ?? [];
  // Publish confirmation belongs on the Publish page, not the Today home rail.
  const pendingCount = pendingActions.length;
  const sssCount = items.filter((item) => priorityGrade(item.priority) === 'SSS').length;
  const [studioActive, setStudioActive] = useState<number | null>(null);
  const [detailSource, setDetailSource] = useState<TodaySource | null>(null);
  const [detailBody, setDetailBody] = useState<Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>>(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
  const [detailBodyError, setDetailBodyError] = useState('');
  const [carryBusyId, setCarryBusyId] = useState<string | null>(null);
  const oppsRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const feedListRef = useRef<HTMLDivElement | null>(null);
  const [visibleFeedCount, setVisibleFeedCount] = useState(feedSources.length);

  useEffect(() => {
    const opps = oppsRef.current;
    const rail = railRef.current;
    const feed = feedListRef.current;
    if (!opps || !rail || !feed || typeof ResizeObserver === 'undefined') return;

    let measuring = false;

    const sync = () => {
      if (measuring) return;
      // Outer rail matches left bottom. Feed card hugs whole rows only — no half-cut, no inner empty pad.
      const targetHeight = Math.ceil(opps.getBoundingClientRect().height);
      if (targetHeight <= 0) return;
      rail.style.height = `${targetHeight}px`;
      rail.style.minHeight = `${targetHeight}px`;
      rail.style.maxHeight = `${targetHeight}px`;

      if (!feedSources.length) {
        setVisibleFeedCount(0);
        return;
      }

      measuring = true;
      const previousCount = visibleFeedCount;
      // Temporarily render all rows to measure natural heights.
      setVisibleFeedCount(feedSources.length);

      window.requestAnimationFrame(() => {
        const railStyles = getComputedStyle(rail);
        const gap = Number.parseFloat(railStyles.rowGap || railStyles.gap || '0') || 0;
        let reserved = 0;
        for (const child of [...rail.children] as HTMLElement[]) {
          if (child === feed) continue;
          reserved += Math.ceil(child.getBoundingClientRect().height);
          reserved += gap;
        }
        const feedStyles = getComputedStyle(feed);
        const padY = (Number.parseFloat(feedStyles.paddingTop || '0') || 0)
          + (Number.parseFloat(feedStyles.paddingBottom || '0') || 0);
        const available = Math.max(0, targetHeight - reserved - padY);

        const rows = [...feed.querySelectorAll<HTMLElement>('.feed-item')];
        let used = 0;
        let fit = 0;
        for (const row of rows) {
          const rowHeight = Math.ceil(row.getBoundingClientRect().height);
          if (rowHeight <= 0) continue;
          if (used + rowHeight > available + 0.5) break;
          used += rowHeight;
          fit += 1;
        }
        const next = Math.max(1, Math.min(sources.length, fit || 1));
        setVisibleFeedCount((prev) => (prev === next ? prev : next));
        // If count didn't change, ensure we didn't leave the temporary full list on screen.
        if (next === previousCount && previousCount !== sources.length) {
          setVisibleFeedCount(next);
        }
        measuring = false;
      });
    };

    sync();
    const ro = new ResizeObserver(() => sync());
    ro.observe(opps);
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [primary?.id, items.length, sources.length, pendingActions.length, task?.status, sources.map((item) => item.id).join('|')]);
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
    const available = new Set(sources.map((source) => source.id));
    const next = selectedSources.filter((source) => available.has(source.id));
    if (next.length !== selectedSources.length) onSelectedSourcesChange(next);
  }, [sources.map((source) => source.id).join('|')]);
  useEffect(() => {
    if (!detailSource) {
      setDetailBody(null);
      setDetailBodyError('');
      setDetailBodyLoading(false);
      return;
    }
    let active = true;
    setDetailBodyLoading(true);
    setDetailBodyError('');
    void window.wmb.getSourceBodyCache(detailSource.id).then((value) => {
      if (!active) return;
      setDetailBody(value);
    }).catch((error) => {
      if (!active) return;
      setDetailBodyError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setDetailBodyLoading(false);
    });
    return () => { active = false; };
  }, [detailSource?.id]);
  useEffect(() => {
    const load = () => void window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: planDate }).then((value) => {
      setTask((prev: any) => {
        const prevSig = JSON.stringify(prev ?? null);
        const nextSig = JSON.stringify(value ?? null);
        return prevSig === nextSig ? prev : value;
      });
      if (!value) {
        setRunning((prev) => (prev ? false : prev));
        return;
      }
      const typed = value as { status?: string; phase?: string; errorMessage?: string | null };
      const nextRunning = typed.status === 'running';
      setRunning((prev) => (prev === nextRunning ? prev : nextRunning));
      let nextStatus = '';
      if (typed.status === 'running') nextStatus = typed.phase === 'starting' ? '今日情报正在启动…' : '今日情报正在运行';
      else if (typed.status === 'failed') nextStatus = typed.errorMessage || '今日情报失败';
      else if (typed.status === 'interrupted') nextStatus = '上次情报任务已中断';
      else if (typed.status === 'cancelled') nextStatus = '今日情报已取消';
      else if (typed.status === 'partial') nextStatus = '已保存可用资料，任务部分完成';
      else if (typed.status === 'succeeded') nextStatus = '今日情报已完成';
      if (nextStatus) setTaskStatus((prev) => (prev === nextStatus ? prev : nextStatus));
    }).catch(() => {});
    load();
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes('agent') || event.scopes.includes('today')) load();
    });
    // While running, keep a light fallback in case progress emits are coalesced away.
    const poll = running ? window.setInterval(load, 5_000) : 0;
    return () => {
      unsubscribe();
      if (poll) window.clearInterval(poll);
    };
  }, [planDate, running]);
  useEffect(() => {
    if (!running) return;
    const clock = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(clock);
  }, [running]);
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
  const createFromCarry = async (item: { objectType: string; objectId: string }) => {
    if (item.objectType !== 'plan_item') return;
    await window.wmb.createProjectFromPlanItem(item.objectId);
    refresh();
    openStudio();
  };
  const updateCarry = async (item: { id: string; revision: number }, state: 'active' | 'done' | 'dismissed') => {
    setCarryBusyId(item.id);
    try {
      await window.wmb.setCarryState({ id: item.id, expectedRevision: item.revision, state });
      refresh();
    } finally {
      setCarryBusyId(null);
    }
  };
  const observeCarry = async (item: { id: string; revision: number; sourceIds?: string[] }) => {
    setCarryBusyId(item.id);
    try {
      const sourceIds = item.sourceIds ?? [];
      if (sourceIds.length) await window.wmb.markSourcesWatching({ sourceIds });
      await window.wmb.setCarryState({ id: item.id, expectedRevision: item.revision, state: 'dismissed' });
      refresh();
    } finally {
      setCarryBusyId(null);
    }
  };
  const toggleSelection = (item: TodayPlanItem) => {
    onSelectionChange(selectedItems.some((selected) => selected.id === item.id)
      ? selectedItems.filter((selected) => selected.id !== item.id)
      : [...selectedItems, item]);
  };
  const toggleSourceSelection = (source: TodaySource) => {
    const exists = selectedSources.some((item) => item.id === source.id);
    if (exists) {
      onSelectedSourcesChange(selectedSources.filter((item) => item.id !== source.id));
      return;
    }
    if (selectedSources.length >= MAX_SELECTED_SOURCES) return;
    const cached = selectedSources.find((item) => item.id === source.id);
    onSelectedSourcesChange([...selectedSources, {
      ...source,
      bodyStatus: cached?.bodyStatus ?? 'none',
      bodyExcerpt: cached?.bodyExcerpt ?? null,
      bodyChars: cached?.bodyChars ?? 0
    }]);
  };
  const openSourceDetail = (source: TodaySource) => {
    setDetailSource(source);
  };
  const attachBodyToSelection = async (source: TodaySource, force = false) => {
    setDetailBodyLoading(true);
    setDetailBodyError('');
    try {
      const body = await window.wmb.fetchSourceBody({ sourceId: source.id, force, maxChars: 20000 });
      setDetailBody(body);
      const fields = bodyToSelectedFields(body);
      const exists = selectedSources.some((item) => item.id === source.id);
      if (exists) {
        onSelectedSourcesChange(selectedSources.map((item) => item.id === source.id ? { ...item, ...source, ...fields } : item));
      } else if (selectedSources.length < MAX_SELECTED_SOURCES) {
        onSelectedSourcesChange([...selectedSources, { ...source, ...fields }]);
      }
    } catch (error) {
      setDetailBodyError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailBodyLoading(false);
    }
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
  const taskPhaseLabel = task?.phase ? (phaseLabels[task.phase] ?? '正在处理') : '正在处理';
  const planned = Math.max(0, Number(task?.progress?.planned ?? 0));
  const processed = Math.max(0, Number(task?.progress?.processed ?? 0));
  const failed = Math.max(0, Number(task?.progress?.failed ?? 0));
  const verified = Math.max(0, Number(task?.progress?.verified ?? 0));
  const saved = Math.max(0, Number(task?.progress?.saved ?? 0));
  const opportunityCount = Math.max(0, Number(task?.progress?.opportunityCount ?? 0));
  const progressRatio = planned > 0 ? Math.min(1, processed / planned) : 0;
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
      if (!target.closest('[data-opportunity-card], [data-feed-item], [data-source-detail], button, a, input, select, textarea, label')) {
        onSelectionChange([]);
        onSelectedSourcesChange([]);
      }
    }}>
    <section className="today-main">
      <section
        className="today-command"
        data-mode={running ? 'running' : 'idle'}
        aria-live={running ? 'polite' : undefined}
        aria-label={running ? '今日情报运行中' : '今日概览'}
      >
        {running ? (
          <>
            <div className="today-command-run">
              <div className="today-command-run-head">
                <div className="today-command-run-title">
                  <strong>{taskPhaseLabel}</strong>
                  {currentSource ? <span className="intelligence-source">当前：{currentSource}</span> : null}
                </div>
                <div className="today-command-run-meta">
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
            </div>
            <div className="today-command-actions">
              <button className="secondary-button" onClick={() => setSourcesOpen(true)}>查看资料</button>
              <button className="secondary-button" disabled={!task?.id} onClick={() => { if (!task?.id) return; void window.wmb.controlDailyIntelligence({ id: task.id, action: 'skip_source' }); }}>跳过当前来源</button>
              <button className="secondary-button" disabled={!task?.id} onClick={() => { if (!task?.id) return; void window.wmb.controlDailyIntelligence({ id: task.id, action: 'save_partial' }); }}>保存并停止</button>
              <button className="secondary-button" disabled={!task?.id} onClick={() => { if (!task?.id) return; void window.wmb.controlDailyIntelligence({ id: task.id, action: 'cancel' }); }}>取消任务</button>
            </div>
          </>
        ) : (
          <>
            <div className="today-command-stats" aria-label="今日指标">
              <div className="today-command-stat">
                <span className="stat-label">今日新资料</span>
                <strong className="stat-value">{today?.sourcesTotal ?? sources.length}</strong>
              </div>
              <div className="today-command-stat">
                <span className="stat-label">内容机会</span>
                <strong className="stat-value">{items.length}</strong>
                {sssCount ? <em className="stat-delta up">{sssCount} SSS</em> : null}
              </div>
              <div className="today-command-stat">
                <span className="stat-label">仍在发酵</span>
                <strong className="stat-value" data-tone={(fermenting.items?.length ?? 0) ? 'amber' : undefined}>{fermenting.items?.length ?? 0}</strong>
              </div>
              <div className="today-command-stat">
                <span className="stat-label">进行中项目</span>
                <strong className="stat-value">{studioActive ?? '–'}</strong>
              </div>
            </div>
            <div className="today-command-actions">
              <button className="refresh-button" onClick={refresh} title="刷新" aria-label="刷新">↻</button>
              <button className="secondary-button" onClick={() => setSourcesOpen(true)}>查看资料</button>
              <button className="primary-button" onClick={() => void startIntelligence()}>{primary ? '⟳ 重新侦察' : '开始今日情报'}</button>
            </div>
          </>
        )}
      </section>
      <div className="today-grid">
        <div className="today-opps" ref={oppsRef}>
          {primary ? <>
            <Opportunity item={primary} primary selected={selectedItems.some((item) => item.id === primary.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>
            {items.length > 1 && <div className="opp-list">{items.slice(1).map((item) => <Opportunity key={item.id} item={item} selected={selectedItems.some((selected) => selected.id === item.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>)}</div>}
          </> : <section className="empty-state">
            <h2>{running ? '正在侦察今日内容机会' : '今日内容机会还在准备中'}</h2>
            <p>{running
              ? (currentSource ? `正在处理：${currentSource}` : '来源扫描和整理完成后，机会会自动出现在这里。')
              : '点击上方“开始今日情报”，让 Pi 扫描并写入今天的内容机会。'}</p>
            {!running && <button className="primary-button" onClick={() => void startIntelligence()}>开始今日情报</button>}
          </section>}
          {(fermenting.items?.length ?? 0) > 0 && <section className="fermenting-rail light" aria-label="仍在发酵">
            <div className="fermenting-head">
              <h2>仍在发酵 · {fermenting.items.length}</h2>
            </div>
            <div className="fermenting-list">
              {fermenting.items.map((item) => <article className="fermenting-row" key={item.id}>
                <div className="fermenting-row-main">
                  <strong className="opp-grade" data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong>
                  <div className="fermenting-row-text">
                    <h3>{item.title}</h3>
                    <div className="fermenting-row-meta">
                      <span>{item.fermentedDays} 天</span>
                      {item.originPlanDate ? <span>{item.originPlanDate}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="fermenting-actions">
                  {item.objectType === 'plan_item' ? <button className="secondary-button" onClick={() => void createFromCarry(item)}>继续做</button> : null}
                  <button className="secondary-button" disabled={carryBusyId === item.id || !(item.sourceIds?.length)} onClick={() => void observeCarry(item)}>观察</button>
                  <button className="text-button" disabled={carryBusyId === item.id} onClick={() => void updateCarry(item, 'dismissed')}>不再显示</button>
                </div>
              </article>)}
            </div>
          </section>}
        </div>
        <aside className="today-rail" ref={railRef}>
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
          <div className="feed-list" ref={feedListRef}>
            {selectedSources.length > 0 && <div className="feed-selection-bar">已选 {selectedSources.length}/{MAX_SELECTED_SOURCES} 条资料进 Pi</div>}
            {feedSources.slice(0, visibleFeedCount).map((source) => {
              const selected = selectedSources.some((item) => item.id === source.id);
              const heartbeat = isHeartbeatSource(source);
              const disabled = !selected && selectedSources.length >= MAX_SELECTED_SOURCES;
              return <div
                className={`feed-item${selected ? ' selected' : ''}${heartbeat ? ' heartbeat' : ''}${pinnedSourceIds.has(source.id) ? ' pinned' : ''}${disabled ? ' disabled' : ''}`}
                data-feed-item
                key={source.id}
                title={disabled ? `最多选择 ${MAX_SELECTED_SOURCES} 条` : (selected ? '点击空白处移出 Pi 上下文' : '点击空白处加入 Pi 上下文')}
                onClick={() => {
                  if (disabled) return;
                  toggleSourceSelection(source);
                }}
              >
                <SourceMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation}/>
                <div className="feed-main">
                  <div
                    className="feed-title"
                    title="打开资料详情"
                    onClick={(event) => {
                      event.stopPropagation();
                      openSourceDetail(source);
                    }}
                  >
                    {source.title}
                  </div>
                  <div
                    className="feed-sub"
                    title="打开资料详情"
                    onClick={(event) => {
                      event.stopPropagation();
                      openSourceDetail(source);
                    }}
                  >
                    <span>{pinnedSourceIds.has(source.id) ? '重点' : heartbeat ? '巡检打卡' : (source.categories[0] || '入库资料')}</span>
                    <span>·</span>
                    <span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? '时间未知'}</span>
                    {selected && selectedSources.find((item) => item.id === source.id)?.bodyStatus === 'ready' ? <span className="feed-body-pill">含正文</span> : null}
                  </div>
                </div>
              </div>;
            })}
            {!feedSources.length && <p className="empty-copy rail-feed-empty">今日还没有入库资料。</p>}
          </div>
        </aside>
      </div>
    </section>
    <button className={`drawer-backdrop${sourcesOpen || detailSource ? ' open' : ''}`} aria-label="关闭侧栏" onClick={() => { setSourcesOpen(false); setDetailSource(null); }}/>
    <SourceList sources={today?.sources ?? []} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={() => openLibrary()} aiSourcePresentation={aiSourcePresentation}/>
    {detailSource && <aside className="sources-panel open source-detail-panel" data-source-detail aria-label="资料详情">
      <div className="panel-heading">
        <p className="eyebrow">{isHeartbeatSource(detailSource) ? '巡检打卡 · 摘要可能很薄' : '资料详情'}</p>
        <div>
          <h2>{detailSource.title}</h2>
          <button className="close-sources" aria-label="关闭资料详情" onClick={() => setDetailSource(null)}>×</button>
        </div>
        <p>
          {(detailSource.categories[0] || '入库资料')}
          {' · '}
          {formatSourcePublishedAt(detailSource.publishedAt) ?? formatSourcePublishedAt(detailSource.collectedAt) ?? '时间未知'}
          {detailSource.author ? ` · ${detailSource.author}` : (domainOf(detailSource.canonicalUrl) ? ` · ${domainOf(detailSource.canonicalUrl)}` : '')}
        </p>
      </div>
      <div className="source-detail-body">
        <section>
          <h3>工作摘要</h3>
          <p>{detailSource.summary?.trim() || '这条资料还没有可用摘要。可抓取正文，或打开原文确认。'}</p>
        </section>
        <section>
          <div className="source-detail-body-head">
            <h3>正文缓存</h3>
            <span className="source-detail-body-status">
              {detailBodyLoading ? '处理中…'
                : detailBody?.status === 'ready' ? `已缓存 ${detailBody.extractedChars} 字`
                : detailBody?.status === 'failed' ? '抓取失败'
                : detailBody?.status === 'empty' ? '无正文'
                : '尚未抓取'}
            </span>
          </div>
          {detailBodyError ? <p className="source-detail-error">{detailBodyError}</p> : null}
          {detailBody?.errorMessage ? <p className="source-detail-error">{detailBody.errorMessage}</p> : null}
          {detailBody?.status === 'ready' && detailBody.extractedText
            ? <div className="source-detail-text">{detailBody.extractedText.slice(0, 6000)}</div>
            : <p className="empty-copy">暂无正文</p>}
        </section>
      </div>
      <div className="source-detail-actions">
        <button
          className={selectedSources.some((item) => item.id === detailSource.id) ? 'secondary-button' : 'primary-button'}
          onClick={() => toggleSourceSelection(detailSource)}
          disabled={!selectedSources.some((item) => item.id === detailSource.id) && selectedSources.length >= MAX_SELECTED_SOURCES}
        >
          {selectedSources.some((item) => item.id === detailSource.id) ? '移出 Pi 上下文' : '加入 Pi 上下文'}
        </button>
        <button className="secondary-button" disabled={detailBodyLoading} onClick={() => void attachBodyToSelection(detailSource, false)}>
          {detailBody?.status === 'ready' ? '带正文给 Pi' : '抓取正文并给 Pi'}
        </button>
        {detailBody?.status === 'ready' ? <button className="secondary-button" disabled={detailBodyLoading} onClick={() => void attachBodyToSelection(detailSource, true)}>重新抓取</button> : null}
        {detailSource.canonicalUrl ? <button className="secondary-button" onClick={() => void window.wmb.openExternal(detailSource.canonicalUrl!)}>打开原文 ↗</button> : null}
        <button className="secondary-button" onClick={() => openLibrary(detailSource.id)}>在资料库中查看</button>
      </div>
    </aside>}
  </div>;
}

type LibrarySection = 'saved' | 'rediscovery';

type LibrarySourceItem = {
  id: string;
  title: string;
  originalUrl?: string | null;
  author?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  collectedAt?: string | null;
  verificationStatus?: string;
  managementStatus?: string;
  revision?: number;
  topics?: string;
  opportunityCount?: number;
  projectCount?: number;
  publicationCount?: number;
  reason?: string;
  priority?: number;
};

type SourceKnowledgeContext = {
  topics: Array<{ id: string; title: string }>;
  opportunities: unknown[];
  projects: unknown[];
  publications: unknown[];
  reviews: Array<{ id: string; summary?: string | null }>;
  findings: Array<{ id: string; title?: string | null; body?: string | null }>;
};

type KnowledgeSourcePage = {
  items: LibrarySourceItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type RediscoveryItem = {
  id: string;
  title: string;
  reason?: string;
  priority?: number;
  collectedAt?: string | null;
};

function isLibrarySection(value: string | null): value is LibrarySection {
  return value === 'saved' || value === 'rediscovery';
}

function asSourceKnowledgeContext(value: unknown): SourceKnowledgeContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const topics = Array.isArray(record.topics) ? record.topics.filter((item): item is { id: string; title: string } => {
    if (!item || typeof item !== 'object') return false;
    const topic = item as Record<string, unknown>;
    return typeof topic.id === 'string' && typeof topic.title === 'string';
  }) : [];
  const reviews = Array.isArray(record.reviews) ? record.reviews.filter((item): item is { id: string; summary?: string | null } => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as Record<string, unknown>).id === 'string';
  }) : [];
  const findings = Array.isArray(record.findings) ? record.findings.filter((item): item is { id: string; title?: string | null; body?: string | null } => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as Record<string, unknown>).id === 'string';
  }) : [];
  return {
    topics,
    opportunities: Array.isArray(record.opportunities) ? record.opportunities : [],
    projects: Array.isArray(record.projects) ? record.projects : [],
    publications: Array.isArray(record.publications) ? record.publications : [],
    reviews,
    findings
  };
}

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
    // Not on current page: still open a minimal shell so deep-link is not a no-op.
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

function domainOf(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return null; }
}
