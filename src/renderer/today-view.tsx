import { useEffect, useMemo, useRef, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import { SourceMark } from './source-mark';
import {
  MAX_SELECTED_SOURCES, Opportunity, SourceList,
  bodyToSelectedFields, formatSourcePublishedAt, isHeartbeatSource,
  priorityGrade, sortFeedSources, type SelectedTodaySource
} from './today-view-parts';
import { FermentingRail, TodaySourceDetail } from './today-view-panels';
import { useTodayRunningTransition } from './today-running-transition';
import { TodayCommandBar } from './today-command-bar';
import { TodayBlockers } from './today-blockers';
import {
  deriveTodayRunView,
  type DailyTaskSnapshot,
  type TodayBlockerAction,
  type TodaySecondaryId
} from './today-run-view';

export type SettingsSectionId = 'general' | 'ai' | 'skills' | 'data' | 'browser' | 'channels' | 'lists' | 'agent' | 'diagnostics' | 'about';

export function TodayView({ today, refresh, openStudio, openLibrary, openSettings, selectedItems, onSelectionChange, selectedSources, onSelectedSourcesChange, planDate, onStatusChange, aiSourcePresentation, intelligenceChannels, piConfigured }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void; openStudio: () => void;
  openLibrary: (sourceId?: string) => void;
  openSettings?: (section?: SettingsSectionId) => void;
  selectedItems: TodayPlanItem[]; onSelectionChange: (items: TodayPlanItem[]) => void;
  selectedSources: SelectedTodaySource[]; onSelectedSourcesChange: (sources: SelectedTodaySource[]) => void;
  planDate: string;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void; aiSourcePresentation: boolean;
  intelligenceChannels: IntelligenceChannelsSummary | null; piConfigured: boolean;
}): React.JSX.Element {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [running, setRunning] = useTodayRunningTransition();
  const [task, setTask] = useState<DailyTaskSnapshot | null>(null);
  const startingRef = useRef(false);
  const [, tick] = useState(0);
  const sources = today?.sources ?? [];
  const fermenting = today?.fermenting ?? { items: [], watchingItems: [], topics: [], pinnedSources: [] };
  const feedSources = sortFeedSources(sources);
  const pinnedSourceIds = new Set((fermenting.pinnedSources || []).map((item) => item.id));
  const todayPlan = today?.plan ?? null;
  const latestPlan = today?.latestPlan ?? null;
  const displayPlan = todayPlan ?? latestPlan;
  const todayItems = todayPlan?.items ?? [];
  const displayItems = displayPlan?.items ?? [];
  const primary = displayItems[0] ?? null;
  const sssCount = todayItems.filter((item) => priorityGrade(item.priority) === 'SSS').length;
  const [studioActive, setStudioActive] = useState<number | null>(null);
  const [detailSource, setDetailSource] = useState<TodaySource | null>(null);
  const [detailBody, setDetailBody] = useState<Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>>(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
  const [detailBodyError, setDetailBodyError] = useState('');
  const oppsRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const feedListRef = useRef<HTMLDivElement | null>(null);
  const [visibleFeedCount, setVisibleFeedCount] = useState(feedSources.length);
  const sourcesAreToday = today?.sourcesDate === planDate;
  const todaySourcesTotal = sourcesAreToday ? (today?.sourcesTotal ?? sources.length) : 0;

  const runView = useMemo(() => deriveTodayRunView({
    task,
    localStarting: startingRef.current,
    hasTodayPlan: Boolean(todayPlan),
    hasRecentPlan: !todayPlan && Boolean(latestPlan),
    opportunityCount: todayItems.length,
    sssCount,
    sourcesTotal: todaySourcesTotal,
    studioActive,
    piConfigured,
    channelsSummary: intelligenceChannels
  }), [task, todayPlan, latestPlan, todayItems.length, sssCount, todaySourcesTotal, studioActive, piConfigured, intelligenceChannels, running]);

  useEffect(() => {
    const opps = oppsRef.current;
    const rail = railRef.current;
    const feed = feedListRef.current;
    if (!opps || !rail || !feed || typeof ResizeObserver === 'undefined') return;
    let measuring = false;
    const sync = () => {
      if (measuring) return;
      const targetHeight = Math.ceil(opps.getBoundingClientRect().height);
      if (targetHeight <= 0) return;
      rail.style.height = `${targetHeight}px`;
      rail.style.minHeight = `${targetHeight}px`;
      rail.style.maxHeight = `${targetHeight}px`;
      if (!feedSources.length) { setVisibleFeedCount(0); return; }
      measuring = true;
      const previousCount = visibleFeedCount;
      setVisibleFeedCount(feedSources.length);
      window.requestAnimationFrame(() => {
        const railStyles = getComputedStyle(rail);
        const gap = Number.parseFloat(railStyles.rowGap || railStyles.gap || '0') || 0;
        let reserved = 0;
        for (const child of [...rail.children] as HTMLElement[]) {
          if (child === feed) continue;
          reserved += Math.ceil(child.getBoundingClientRect().height) + gap;
        }
        const feedStyles = getComputedStyle(feed);
        const padY = (Number.parseFloat(feedStyles.paddingTop || '0') || 0) + (Number.parseFloat(feedStyles.paddingBottom || '0') || 0);
        const available = Math.max(0, targetHeight - reserved - padY);
        const rows = [...feed.querySelectorAll('.feed-item')] as HTMLElement[];
        let used = 0;
        let fit = 0;
        for (const row of rows) {
          const height = Math.ceil(row.getBoundingClientRect().height);
          const next = used + height + (fit ? gap : 0);
          if (next > available + 0.5) break;
          used = next;
          fit += 1;
        }
        const next = Math.max(1, Math.min(feedSources.length, fit || 1));
        setVisibleFeedCount((prev) => (prev === next ? prev : next));
        if (next === previousCount && previousCount !== feedSources.length) setVisibleFeedCount(next);
        measuring = false;
      });
    };
    const ro = new ResizeObserver(() => sync());
    ro.observe(opps);
    ro.observe(rail);
    sync();
    return () => ro.disconnect();
  }, [primary?.id, displayItems.length, sources.length, runView.blockers.length, task?.status, sources.map((item) => item.id).join('|'), feedSources.length, visibleFeedCount]);

  useEffect(() => {
    let active = true;
    void window.wmb.getStudioSummary().then((summary) => {
      if (!active || !summary) return;
      setStudioActive(summary.byStatus.idea + summary.byStatus.drafting + summary.byStatus.review + summary.byStatus.ready);
    }).catch(() => {});
    return () => { active = false; };
  }, [todayPlan?.id, latestPlan?.id, displayItems.length]);

  useEffect(() => {
    if (!detailSource) { setDetailBody(null); setDetailBodyError(''); setDetailBodyLoading(false); return; }
    let active = true;
    setDetailBodyLoading(true);
    setDetailBodyError('');
    void window.wmb.getSourceBodyCache(detailSource.id).then((value) => {
      if (!active) return;
      setDetailBody(value);
    }).catch((error) => {
      if (!active) return;
      setDetailBodyError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setDetailBodyLoading(false); });
    return () => { active = false; };
  }, [detailSource?.id]);

  useEffect(() => {
    const load = () => void window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: planDate }).then((value) => {
      const typed = (value && typeof value === 'object') ? value as DailyTaskSnapshot : null;
      setTask((prev) => JSON.stringify(prev ?? null) === JSON.stringify(typed ?? null) ? prev : typed);
      if (!typed) { if (!startingRef.current) setRunning(false); return; }
      const nextRunning = typed.status === 'running';
      if (nextRunning) startingRef.current = false;
      if (!nextRunning && startingRef.current) return;
      setRunning(nextRunning);
    }).catch(() => {});
    load();
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes('agent') || event.scopes.includes('today')) load();
    });
    const poll = running || startingRef.current ? window.setInterval(load, 5_000) : 0;
    return () => { unsubscribe(); if (poll) window.clearInterval(poll); };
  }, [planDate, running]);

  useEffect(() => {
    if (!running) return;
    const clock = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(clock);
  }, [running]);

  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange({ text: runView.statusLine, running });
    return () => onStatusChange(null);
  }, [runView.statusLine, running, onStatusChange]);

  const create = async (item: TodayPlanItem) => { await window.wmb.createProjectFromPlanItem(item.id); openStudio(); };
  const createFromCarry = async (item: { objectType: string; objectId: string }) => {
    if (item.objectType !== 'plan_item') return;
    await window.wmb.createProjectFromPlanItem(item.objectId);
    openStudio();
  };
  const toggleSelection = (item: TodayPlanItem) => {
    onSelectionChange(selectedItems.some((selected) => selected.id === item.id)
      ? selectedItems.filter((selected) => selected.id !== item.id)
      : [...selectedItems, item]);
  };
  const toggleSourceSelection = (source: TodaySource) => {
    const exists = selectedSources.some((item) => item.id === source.id);
    if (exists) { onSelectedSourcesChange(selectedSources.filter((item) => item.id !== source.id)); return; }
    if (selectedSources.length >= MAX_SELECTED_SOURCES) return;
    onSelectedSourcesChange([...selectedSources, { ...source, bodyStatus: 'none', bodyExcerpt: null, bodyChars: 0 }]);
  };
  const attachBodyToSelection = async (source: TodaySource, force = false) => {
    setDetailBodyLoading(true);
    setDetailBodyError('');
    try {
      const body = await window.wmb.fetchSourceBody({ sourceId: source.id, force, maxChars: 20000 });
      setDetailBody(body);
      const fields = bodyToSelectedFields(body);
      const exists = selectedSources.some((item) => item.id === source.id);
      if (exists) onSelectedSourcesChange(selectedSources.map((item) => item.id === source.id ? { ...item, ...source, ...fields } : item));
      else if (selectedSources.length < MAX_SELECTED_SOURCES) onSelectedSourcesChange([...selectedSources, { ...source, ...fields }]);
    } catch (error) {
      setDetailBodyError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailBodyLoading(false);
    }
  };

  const startIntelligence = async () => {
    if (running || startingRef.current) return;
    if (runView.primaryCta.confirm && !window.confirm(runView.primaryCta.confirm)) return;
    startingRef.current = true;
    setRunning(true);
    setTask((prev) => prev?.status === 'running' ? prev : { status: 'running', phase: 'starting', progress: {}, events: [] });
    try {
      const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const result = await window.wmb.startDailyIntelligence({ businessDate }) as {
        ok: boolean;
        data?: { task?: DailyTaskSnapshot; reused?: boolean };
        error?: { message?: string } | null;
      };
      if (!result.ok) {
        startingRef.current = false;
        setRunning(false);
        setTask({ status: 'failed', errorMessage: result.error?.message || '今日情报失败' });
        return;
      }
      if (result.data?.task) {
        setTask(result.data.task);
        startingRef.current = result.data.task.status === 'running' ? false : false;
      } else {
        startingRef.current = false;
      }
      refresh();
    } catch (error) {
      startingRef.current = false;
      setRunning(false);
      setTask({ status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) });
    } finally {
      window.setTimeout(() => refresh(), 300);
    }
  };

  const onPrimary = () => {
    if (runView.primaryCta.kind === 'open_studio') { openStudio(); return; }
    if (runView.primaryCta.kind === 'none') return;
    void startIntelligence();
  };

  const onSecondary = (id: TodaySecondaryId) => {
    if (id === 'view_sources') { setSourcesOpen(true); return; }
    if (id === 'refresh') { refresh(); return; }
    if (id === 'open_studio') { openStudio(); return; }
    if (id === 'restart') {
      if (!window.confirm('重新侦察会用新结果替换今日方案，继续？')) return;
      void startIntelligence();
      return;
    }
    if (id === 'save_partial') {
      if (!task?.id) return;
      void window.wmb.controlDailyIntelligence({ id: task.id, action: 'save_partial' });
      return;
    }
    if (id === 'cancel') {
      if (!task?.id) return;
      if (!window.confirm('未保存的渠道结果会丢弃；想保留请先「保存并停止」。')) return;
      void window.wmb.controlDailyIntelligence({ id: task.id, action: 'cancel' });
    }
  };

  const onBlocker = (action: TodayBlockerAction) => {
    if (action === 'retry') { void startIntelligence(); return; }
    if (action === 'open_settings_browser') { openSettings?.('browser'); return; }
    if (action === 'open_settings_channels') { openSettings?.('channels'); return; }
    if (action === 'open_settings_ai') { openSettings?.('ai'); }
  };

  return <div className="today-layout" onClick={(event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('[data-opportunity-card], [data-feed-item], [data-source-detail], button, a, input, select, textarea, label')) {
      onSelectionChange([]);
      onSelectedSourcesChange([]);
    }
  }}>
    <section className="today-main">
      <TodayCommandBar
        view={runView}
        taskId={task?.id}
        planDate={planDate}
        onPrimary={onPrimary}
        onSecondary={onSecondary}
      />
      <div className="today-grid">
        <div className="today-opps" ref={oppsRef}>
          {primary && !runView.showOpportunityEmpty ? <>
            {!today?.plan && displayPlan ? <p className="eyebrow">最近方案 · {displayPlan.planDate}</p> : null}
            <Opportunity item={primary} primary selected={selectedItems.some((item) => item.id === primary.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>
            {displayItems.length > 1 && <div className="opp-list">{displayItems.slice(1).map((item) => <Opportunity key={item.id} item={item} selected={selectedItems.some((selected) => selected.id === item.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>)}</div>}
          </> : <section className="empty-state">
            <h2>{runView.opportunityEmptyTitle}</h2>
            <p>{runView.opportunityEmptyBody}</p>
          </section>}
          <FermentingRail fermenting={fermenting} createFromCarry={createFromCarry}/>
        </div>
        <aside className="today-rail" ref={railRef}>
          <TodayBlockers blockers={runView.blockers} onAction={onBlocker} />
          <div className="feed-list" ref={feedListRef}>
            {!sourcesAreToday && today?.sourcesDate && feedSources.length > 0 ? <p className="feed-context">今天暂无新资料，以下为 {today.sourcesDate} 入库</p> : null}
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
                onClick={() => { if (!disabled) toggleSourceSelection(source); }}
              >
                <SourceMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation}/>
                <div className="feed-main">
                  <div className="feed-title" title="打开资料详情" onClick={(event) => { event.stopPropagation(); setDetailSource(source); }}>{source.title}</div>
                  <div className="feed-sub" title="打开资料详情" onClick={(event) => { event.stopPropagation(); setDetailSource(source); }}>
                    <span>{pinnedSourceIds.has(source.id) ? '重点' : heartbeat ? '巡检打卡' : (source.categories[0] || '入库资料')}</span>
                    <span>·</span>
                    <span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? '时间未知'}</span>
                    {selected && selectedSources.find((item) => item.id === source.id)?.bodyStatus === 'ready' ? <span className="feed-body-pill">含正文</span> : null}
                  </div>
                </div>
              </div>;
            })}
          </div>
        </aside>
      </div>
    </section>
    <button className={`drawer-backdrop${sourcesOpen || detailSource ? ' open' : ''}`} aria-label="关闭侧栏" onClick={() => { setSourcesOpen(false); setDetailSource(null); }}/>
    <SourceList sources={sources} sourceDate={today?.sourcesDate ?? null} planDate={planDate} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={() => openLibrary()} aiSourcePresentation={aiSourcePresentation}/>
    {detailSource ? <TodaySourceDetail detailSource={detailSource} detailBody={detailBody} detailBodyLoading={detailBodyLoading} detailBodyError={detailBodyError} selectedSources={selectedSources} onClose={() => setDetailSource(null)} onToggleSelection={toggleSourceSelection} onAttachBody={attachBodyToSelection} openLibrary={openLibrary}/> : null}
  </div>;
}
