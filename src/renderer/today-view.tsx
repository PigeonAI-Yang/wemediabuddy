import { useEffect, useMemo, useRef, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import { SourceMark } from './source-mark';
import {
  MAX_SELECTED_SOURCES, Opportunity, SourceList,
  bodyToSelectedFields, formatSourcePublishedAt, isHeartbeatSource,
  priorityGrade, sortFeedSources, sourceOriginLabel, type SelectedTodaySource
} from './today-view-parts';
import { FermentingRail, TodaySourceDetail } from './today-view-panels';
import { poolBadges, resolveChairDisplayItems } from './today-pool-view';
import { useTodayRunningTransition } from './today-running-transition';
import { readTodayRunCache, writeTodayRunCache } from './today-run-cache';
import { TodayCommandBar } from './today-command-bar';
import { TodayBlockers } from './today-blockers';
import {
  deriveTodayRunView,
  isManagerNonterminal,
  type DailyTaskSnapshot,
  type TodayBlockerAction,
  type TodaySecondaryId
} from './today-run-view';
import { appConfirm } from './app-confirm';

export type SettingsSectionId = 'general' | 'ai' | 'skills' | 'data' | 'browser' | 'channels' | 'lists' | 'agent' | 'diagnostics' | 'about';

export function TodayView({ today, refresh, openStudio, openLibrary, openSettings, openTopic, selectedItems, onSelectionChange, selectedSources, onSelectedSourcesChange, fermentSelectedItem = null, onFermentSelectedItemChange, planDate, onStatusChange, aiSourcePresentation, intelligenceChannels, piConfigured, openProposals }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void; openStudio: (projectId?: string) => void;
  openLibrary: (sourceId?: string) => void;
  openSettings?: (section?: SettingsSectionId) => void;
  openTopic?: (topicId: string) => void;
  selectedItems: TodayPlanItem[]; onSelectionChange: (items: TodayPlanItem[]) => void;
  selectedSources: SelectedTodaySource[]; onSelectedSourcesChange: (sources: SelectedTodaySource[]) => void;
  fermentSelectedItem?: any | null; onFermentSelectedItemChange?: (item: any | null) => void;
  planDate: string;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void; aiSourcePresentation: boolean;
  intelligenceChannels: IntelligenceChannelsSummary | null; piConfigured: boolean;
  openProposals?: () => void;
}): React.JSX.Element {
  const cachedRun = readTodayRunCache(planDate);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [running, setRunning] = useTodayRunningTransition(Boolean(cachedRun?.running));
  const [task, setTask] = useState<DailyTaskSnapshot | null>(cachedRun?.task ?? null);
  const [controlPending, setControlPending] = useState<'save_partial' | 'cancel' | null>(null);
  const startingRef = useRef(false);
  const [, tick] = useState(0);
  const sources = today?.sources ?? [];
  const fermenting = today?.fermenting ?? { items: [], watchingItems: [], topics: [], pinnedSources: [] };
  const feedSources = sortFeedSources(sources);
  const pinnedSourceIds = new Set((fermenting.pinnedSources || []).map((item) => item.id));
  const todayPlan = today?.plan ?? null;
  const latestPlan = today?.latestPlan ?? null;
  const pool = today?.pool ?? null;
  const todayItems = todayPlan?.items ?? [];
  const pendingTopicMaintenance = today?.topicMaintenance?.pending ?? 0;
  // 主席：pool > 今日非空 plan > 最近非空 plan；空 current 运行记录不得掏空主区。
  const displayItems = resolveChairDisplayItems(pool, todayPlan, latestPlan);
  const primary = displayItems[0] ?? null;
  const sssCount = todayItems.filter((item) => priorityGrade(item.priority) === 'SSS').length;
  const [studioActive, setStudioActive] = useState<number | null>(null);
  const [proposalSummary, setProposalSummary] = useState<Awaited<ReturnType<typeof window.wmb.getProposalLedgerSummary>>>(null);
  const [detailSource, setDetailSource] = useState<TodaySource | null>(null);
  const [detailBody, setDetailBody] = useState<Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>>(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
  const [detailBodyError, setDetailBodyError] = useState('');
  const feedListRef = useRef<HTMLDivElement | null>(null);
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
    channelsSummary: intelligenceChannels,
    controlPending: controlPending != null,
    controlPendingAction: controlPending
  }), [task, todayPlan, latestPlan, todayItems.length, sssCount, todaySourcesTotal, studioActive, piConfigured, intelligenceChannels, running, controlPending]);

  // 入库信息流：内容超出视口时无缝自动向上滚动；悬停暂停，便于点选。
  useEffect(() => {
    const feed = feedListRef.current;
    if (!feed || feedSources.length < 2) return;
    const track = feed.querySelector<HTMLElement>('.feed-stream-track');
    if (!track) return;

    let raf = 0;
    let last = performance.now();
    let offset = 0;
    let paused = false;
    const speed = 22; // px/s

    const onEnter = () => { paused = true; };
    const onLeave = () => { paused = false; last = performance.now(); };
    feed.addEventListener('pointerenter', onEnter);
    feed.addEventListener('pointerleave', onLeave);

    const tickFrame = (now: number) => {
      const half = track.scrollHeight / 2;
      if (!paused && half > feed.clientHeight + 8) {
        const dt = Math.min(0.05, (now - last) / 1000);
        offset += speed * dt;
        if (offset >= half) offset -= half;
        track.style.transform = `translate3d(0, ${-offset}px, 0)`;
      }
      last = now;
      raf = requestAnimationFrame(tickFrame);
    };
    raf = requestAnimationFrame(tickFrame);

    return () => {
      cancelAnimationFrame(raf);
      feed.removeEventListener('pointerenter', onEnter);
      feed.removeEventListener('pointerleave', onLeave);
      track.style.transform = '';
    };
  }, [feedSources.map((item) => item.id).join('|'), primary?.id, displayItems.length, runView.blockers.length]);

  useEffect(() => {
    let active = true;
    void window.wmb.getStudioSummary().then((summary) => {
      if (!active || !summary) return;
      setStudioActive(summary.byStatus.idea + summary.byStatus.drafting + summary.byStatus.review + summary.byStatus.ready);
    }).catch(() => {});
    return () => { active = false; };
  }, [todayPlan?.id, latestPlan?.id, displayItems.length]);

  useEffect(() => {
    let active = true;
    const loadSummary = () => void window.wmb.getProposalLedgerSummary(planDate).then((value) => {
      if (active) setProposalSummary(value);
    }).catch(() => {});
    loadSummary();
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes('today') || event.scopes.includes('proposals')) loadSummary();
    });
    return () => { active = false; unsubscribe(); };
  }, [planDate]);

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
    const load = () => {
      void (async () => {
        try {
          await window.wmb.syncManagerTask?.({ businessDate: planDate });
          const projection = await window.wmb.getManagerTask?.({ businessDate: planDate });
          const manager = projection?.managerTask;
          const child = projection?.legacyChild;
          if (manager && isManagerNonterminal(manager)) {
            const summary = manager.checkpoint?.summary || manager.progress?.message || '主管任务进行中';
            const runningChild = child?.status === 'running' ? child : null;
            // 诚实投影：有运行中 child 用 child 的 phase/计数（determinate）；否则用 manager checkpoint 阶段。
            // 主管未终态（含 waiting_human/report）恒为 running：不得因旧方案存在或 child 停止而降级 partial→idle。
            const snapshot = {
              id: runningChild?.id || manager.id,
              intent: runningChild?.intent || 'page_agents',
              status: 'running',
              phase: runningChild?.phase || manager.checkpoint?.phase || 'manager',
              progress: {
                ...(runningChild?.progress || {}),
                message: summary,
                planned: runningChild?.progress?.planned,
                processed: runningChild?.progress?.processed
              },
              events: runningChild?.events?.length ? runningChild.events : (summary ? [{ message: summary }] : []),
              errorMessage: summary
            } as DailyTaskSnapshot;
            setTask((prev) => JSON.stringify(prev ?? null) === JSON.stringify(snapshot) ? prev : snapshot);
            startingRef.current = false;
            setRunning(true);
            writeTodayRunCache({ planDate, task: snapshot, running: true });
            return;
          }
        } catch { /* fall through */ }
        const value = await window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: planDate });
        const typed = (value && typeof value === 'object') ? value as DailyTaskSnapshot : null;
        setTask((prev) => JSON.stringify(prev ?? null) === JSON.stringify(typed ?? null) ? prev : typed);
        if (!typed) {
          if (!startingRef.current) {
            setRunning(false);
            writeTodayRunCache({ planDate, task: null, running: false });
          }
          return;
        }
        const nextRunning = typed.status === 'running';
        if (nextRunning) startingRef.current = false;
        if (!nextRunning && startingRef.current) return;
        setRunning(nextRunning);
        writeTodayRunCache({ planDate, task: typed, running: nextRunning });
      })().catch(() => {});
    };
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

  const create = async (item: TodayPlanItem) => {
    const project = await window.wmb.createProjectFromPlanItem(item.id);
    openStudio(project?.id);
  };
  const poolBadgeMap = useMemo(() => {
    const nowMs = Date.now();
    return new Map((pool ?? []).map((item) => [item.planItemId, poolBadges(item, nowMs, planDate)]));
  }, [pool, planDate]);
  const dismissOpportunity = async (planItemId: string) => {
    if (!await appConfirm({ title: '否掉机会', message: '否掉这个机会？它会从池中移除且不再出现。', confirmLabel: '否掉', danger: true })) return;
    try {
      await window.wmb.dismissPlanItem({ planItemId });
      refresh();
    } catch (error) {
      onStatusChange?.({ text: error instanceof Error ? error.message : String(error), running: false });
    }
  };
  const xChannelAbsent = Boolean(intelligenceChannels?.readiness?.some((entry) => entry.module === 'x_lists' && entry.status === 'needs_user'));
  const createFromCarry = async (item: { objectType: string; objectId: string; title?: string }) => {
    if (item.objectType === 'plan_item') {
      const project = await window.wmb.createProjectFromPlanItem(item.objectId);
      openStudio(project?.id);
      return;
    }
    if (item.objectType === 'topic') {
      const title = (item.title || '主题创作').trim();
      const project = await window.wmb.createStudioProject({ title, body: `# ${title}\n\n` });
      if (project?.id != null && project.revision != null) {
        try {
          await window.wmb.updateStudioProject({ projectId: project.id, expectedRevision: project.revision, topicId: item.objectId });
        } catch {
          // Project exists even if topic bind fails; still open studio.
        }
      }
      openStudio(project?.id);
      return;
    }
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
    if (runView.primaryCta.confirm && !await appConfirm({ title: '开始今日情报', message: runView.primaryCta.confirm, confirmLabel: '继续' })) return;
    startingRef.current = true;
    setRunning(true);
    setTask((prev) => {
      const next = prev?.status === 'running' ? prev : { status: 'running', phase: 'starting', progress: {}, events: [] } as DailyTaskSnapshot;
      writeTodayRunCache({ planDate, task: next, running: true });
      return next;
    });
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
      const data = result.data as {
        task?: DailyTaskSnapshot;
        managerTask?: { id: string; checkpoint?: { summary?: string; status?: string; phase?: string }; status?: string };
        focusDialog?: boolean;
        action?: string;
        reused?: boolean;
      } | undefined;
      if (data?.focusDialog) {
        window.dispatchEvent(new CustomEvent('wmb:focus-manager-dialog', {
          detail: { managerTaskId: data.managerTask?.id, action: data.action }
        }));
      }
      if (data?.action === 'focus_existing') {
        // Serial lock: do not show a second run; surface manager summary on the command bar.
        startingRef.current = false;
        if (data.task) {
          setRunning(data.task.status === 'running');
          setTask(data.task);
        } else if (data.managerTask) {
          const nonterminal = isManagerNonterminal(data.managerTask);
          setRunning(nonterminal);
          setTask({
            id: data.managerTask.id,
            status: nonterminal ? 'running' : (data.managerTask.checkpoint?.status === 'waiting_human' ? 'partial' : data.managerTask.status),
            phase: data.managerTask.checkpoint?.phase || 'manager',
            progress: {},
            events: [],
            errorMessage: data.managerTask.checkpoint?.summary || '主管任务进行中 · 查看对话进度'
          } as DailyTaskSnapshot);
        }
        refresh();
        return;
      }
      if (data?.task) {
        setTask(data.task);
        startingRef.current = data.task.status === 'running' ? false : false;
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
    if (runView.primaryCta.label === '对话中 · 查看进度' || runView.headline === '主管编排中') {
      window.dispatchEvent(new CustomEvent('wmb:focus-manager-dialog', { detail: { action: 'focus_existing' } }));
      return;
    }
    void startIntelligence();
  };

  const onSecondary = (id: TodaySecondaryId) => {
    if (id === 'view_sources') { setSourcesOpen(true); return; }
    if (id === 'refresh') { refresh(); return; }
    if (id === 'open_studio') { openStudio(); return; }
    if (id === 'continue') { void startIntelligence(); return; }
    if (id === 'restart') {
      void (async () => {
        if (!await appConfirm({ title: '重新侦察', message: '重新侦察会用新结果替换今日方案，继续？', confirmLabel: '继续侦察' })) return;
        await startIntelligence();
      })();
      return;
    }
    if (id === 'save_partial') {
      const taskId = task?.id;
      if (!taskId) {
        setTask((current) => current ? { ...current, errorMessage: '没有可停止的运行中任务。' } : { status: 'failed', errorMessage: '没有可停止的运行中任务。' });
        return;
      }
      if (controlPending) return;
      void (async () => {
        setControlPending('save_partial');
        try {
          const result = await window.wmb.controlDailyIntelligence({ id: taskId, action: 'save_partial' });
          if (result && typeof result === 'object' && result.ok === false) {
            setTask((current) => ({ ...(current ?? { id: taskId }), status: current?.status || 'running', errorMessage: result.error?.message || '保存并停止失败' }));
          } else if (result?.data && typeof result.data === 'object') {
            setTask(result.data as DailyTaskSnapshot);
          }
          refresh();
        } catch (error) {
          setTask((current) => ({ ...(current ?? { id: taskId }), status: current?.status || 'running', errorMessage: error instanceof Error ? error.message : String(error) }));
        } finally {
          setControlPending(null);
          window.setTimeout(() => refresh(), 300);
        }
      })();
      return;
    }
    if (id === 'cancel') {
      const taskId = task?.id;
      if (!taskId) {
        setTask((current) => current ? { ...current, errorMessage: '没有可取消的运行中任务。' } : { status: 'failed', errorMessage: '没有可取消的运行中任务。' });
        return;
      }
      if (controlPending) return;
      void (async () => {
        if (!await appConfirm({
          title: '停止任务',
          message: '将结束本次运行。已入库资料仍保留；未完成的方案综合会丢弃。想保留已扫描进度请用「保存并停止」。',
          confirmLabel: '直接停止',
          danger: true
        })) return;
        setControlPending('cancel');
        try {
          const result = await window.wmb.controlDailyIntelligence({ id: taskId, action: 'cancel' });
          if (result && typeof result === 'object' && result.ok === false) {
            setTask((current) => ({ ...(current ?? { id: taskId }), status: current?.status || 'running', errorMessage: result.error?.message || '取消失败' }));
          } else if (result?.data && typeof result.data === 'object') {
            setTask(result.data as DailyTaskSnapshot);
          }
          refresh();
        } catch (error) {
          setTask((current) => ({ ...(current ?? { id: taskId }), status: current?.status || 'running', errorMessage: error instanceof Error ? error.message : String(error) }));
        } finally {
          setControlPending(null);
          window.setTimeout(() => refresh(), 300);
        }
      })();
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
      {openProposals && proposalSummary ? <button type="button" className="proposal-ledger-entry" onClick={openProposals} title="打开选题台账">
        <span className="proposal-ledger-entry-title">选题台账 · {(proposalSummary.today ?? 0) + (proposalSummary.shelved ?? 0)}</span>
        <span className="proposal-ledger-entry-counts">今日可批 · {proposalSummary.today ?? 0} ｜ 待处理 · {proposalSummary.shelved ?? 0}</span>
        <span className="proposal-ledger-entry-arrow" aria-hidden="true">›</span>
      </button> : null}
      <div className="today-grid">
        <div className="today-opps">
          {primary ? <>
            {xChannelAbsent ? <div className="pool-absent-banner" role="status"><span>X 渠道缺席：本次判断未包含 X 动态。</span><button type="button" onClick={() => openSettings?.('browser')}>重新验证浏览器</button></div> : null}
            <Opportunity item={primary} primary selected={selectedItems.some((item) => item.id === primary.id)} onToggle={toggleSelection} onCreate={create} sources={sources} badges={poolBadgeMap.get(primary.id)} onDismiss={() => void dismissOpportunity(primary.id)}/>
            {displayItems.length > 1 && <div className="opp-list">{displayItems.slice(1).map((item) => <Opportunity key={item.id} item={item} selected={selectedItems.some((selected) => selected.id === item.id)} onToggle={toggleSelection} onCreate={create} sources={sources} badges={poolBadgeMap.get(item.id)} onDismiss={() => void dismissOpportunity(item.id)}/>)}</div>}
          </> : <section className="empty-state">
            <h2>{runView.opportunityEmptyTitle}</h2>
            <p>{runView.opportunityEmptyBody}</p>
          </section>}
        </div>
        <aside className="today-rail">
          <TodayBlockers blockers={runView.blockers} onAction={onBlocker} />
          <div className="feed-list" ref={feedListRef} aria-label="入库信息流">
            {!sourcesAreToday && today?.sourcesDate && feedSources.length > 0 ? <p className="feed-context">今天暂无新资料，以下为最近有效入库</p> : null}
            {selectedSources.length > 0 && <div className="feed-selection-bar">已选 {selectedSources.length}/{MAX_SELECTED_SOURCES} 条资料进 Pi</div>}
            {feedSources.length ? (
              <div className="feed-stream-viewport">
                <div className="feed-stream-track">
                  {[0, 1].map((copy) => (
                    <div className="feed-stream-copy" key={`feed-copy-${copy}`} aria-hidden={copy === 1 ? true : undefined}>
                      {feedSources.map((source) => {
                        const selected = selectedSources.some((item) => item.id === source.id);
                        const heartbeat = isHeartbeatSource(source);
                        const disabled = !selected && selectedSources.length >= MAX_SELECTED_SOURCES;
                        return <div
                          className={`feed-item${selected ? ' selected' : ''}${heartbeat ? ' heartbeat' : ''}${pinnedSourceIds.has(source.id) ? ' pinned' : ''}${disabled ? ' disabled' : ''}`}
                          data-feed-item
                          key={`${copy}-${source.id}`}
                          title={disabled ? `最多选择 ${MAX_SELECTED_SOURCES} 条` : (selected ? '点击空白处移出 Pi 上下文' : '点击空白处加入 Pi 上下文')}
                          onClick={() => { if (!disabled && copy === 0) toggleSourceSelection(source); }}
                        >
                          <SourceMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation} avatarUrl={source.avatarUrl}/>
                          <div className="feed-main">
                            <div className="feed-title" title="打开资料详情" onClick={(event) => { event.stopPropagation(); if (copy === 0) setDetailSource(source); }}>{source.title}</div>
                            <div className="feed-sub" title="打开资料详情" onClick={(event) => { event.stopPropagation(); if (copy === 0) setDetailSource(source); }}>
                              <span>{sourceOriginLabel({ ...source, pinned: pinnedSourceIds.has(source.id) })}</span>
                              <span>·</span>
                              <span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? '时间未知'}</span>
                              {selected && selectedSources.find((item) => item.id === source.id)?.bodyStatus === 'ready' ? <span className="feed-body-pill">含正文</span> : null}
                            </div>
                          </div>
                        </div>;
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ) : <p className="empty-copy">{sourcesAreToday ? '今日还没有入库资料。' : '暂无可用入库资料。'}</p>}
          </div>
        </aside>
      </div>
      {pendingTopicMaintenance ? <button className="today-topic-maintenance" type="button" onClick={() => openTopic?.('')}>有 {pendingTopicMaintenance} 份主题整理提案待你批准</button> : null}
      <FermentingRail fermenting={fermenting} createFromCarry={createFromCarry} selectedId={fermentSelectedItem?.id ?? null} onSelectItem={onFermentSelectedItemChange}/>
    </section>
    <button className={`drawer-backdrop${sourcesOpen || detailSource ? ' open' : ''}`} aria-label="关闭侧栏" onClick={() => { setSourcesOpen(false); setDetailSource(null); }}/>
    <SourceList sources={sources} sourceDate={today?.sourcesDate ?? null} planDate={planDate} open={sourcesOpen} close={() => setSourcesOpen(false)} openLibrary={() => openLibrary()} aiSourcePresentation={aiSourcePresentation}/>
    {detailSource ? <TodaySourceDetail detailSource={detailSource} detailBody={detailBody} detailBodyLoading={detailBodyLoading} detailBodyError={detailBodyError} selectedSources={selectedSources} onClose={() => setDetailSource(null)} onToggleSelection={toggleSourceSelection} onAttachBody={attachBodyToSelection} openLibrary={openLibrary}/> : null}
  </div>;
}
