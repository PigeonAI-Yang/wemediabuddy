import { useEffect, useMemo, useRef, useState } from 'react';
import type { SourceBodyCacheRecord } from '../main/source-body-cache';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import type { SourceMediaOverview } from '../shared/source-media';
import type { PiFocusObject } from './app-types';
import { SourceMark } from './source-mark';
import {
  MAX_SELECTED_SOURCES, Opportunity,
  formatSourcePublishedAt, isHeartbeatSource,
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
  projectManagerTaskForToday,
  type DailyTaskSnapshot,
  type TodayBlockerAction,
  type TodaySecondaryId
} from './today-run-view';
import { appConfirm } from './app-confirm';

export type SettingsSectionId = 'general' | 'ai' | 'skills' | 'data' | 'browser' | 'channels' | 'lists' | 'agent' | 'diagnostics' | 'about';

/** WMB-5174 Today「研究缺口 · 等你批」行投影（与 src/main/research-successor-projection.ts 同构）。 */
export type ResearchSuccessorGapItem = Readonly<{
  id: string;
  parentJobId: string;
  parentTaskId: string;
  researchTaskId: string;
  parentRoleId: 'writer' | 'planner' | 'librarian';
  unresolvedClaims: ReadonlyArray<Readonly<{ key: string; text: string | null; type: 'fact' | 'price' | 'policy' | null }>>;
  decision: 'narrow' | 'supplement' | 'accept' | null;
  createdAt: string;
  updatedAt: string;
}>;

/** 三动作可读标签（与 research-successor RESEARCH_SUCCESSOR_ACTIONS 对应）。 */
const RESEARCH_DECISION_LABEL: Readonly<Record<'narrow' | 'supplement' | 'accept', string>> = Object.freeze({
  narrow: '收窄范围',
  supplement: '手动补料',
  accept: '接受并标注待核实'
});

const RESEARCH_PARENT_ROLE_LABEL: Readonly<Record<'writer' | 'planner' | 'librarian', string>> = Object.freeze({
  writer: '写手',
  planner: '策划',
  librarian: '资料员'
});
export type TodayFermentingSelection = {
  id: string;
  objectType: string;
  objectId: string;
  title: string;
};


export function TodayView({ today, refresh, openStudio, openLibrary, openSettings, openTopic, selectedItems, onSelectionChange, selectedSources, onSelectedSourcesChange, fermentSelectedItem = null, onFermentSelectedItemChange, planDate, onStatusChange, onFocusChange, aiSourcePresentation, intelligenceChannels, piConfigured, openProposals }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void; openStudio: (projectId?: string) => void;
  openLibrary: (sourceId?: string) => void;
  openSettings?: (section?: SettingsSectionId) => void;
  openTopic?: (topicId: string) => void;
  selectedItems: TodayPlanItem[]; onSelectionChange: (items: TodayPlanItem[]) => void;
  selectedSources: SelectedTodaySource[]; onSelectedSourcesChange: (sources: SelectedTodaySource[]) => void;
  fermentSelectedItem?: TodayFermentingSelection | null; onFermentSelectedItemChange?: (item: TodayFermentingSelection | null) => void;
  planDate: string;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void;
  onFocusChange?: (focus: PiFocusObject | null) => void;
  aiSourcePresentation: boolean;
  intelligenceChannels: IntelligenceChannelsSummary | null; piConfigured: boolean;
  openProposals?: () => void;
}): React.JSX.Element {
  const cachedRun = readTodayRunCache(planDate);
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
  // 主席只消费跨日期未终结 pool；历史 plan 不得绕过终态过滤后复活。
  const displayItems = resolveChairDisplayItems(pool, todayPlan, latestPlan);
  const primary = displayItems[0] ?? null;
  const sssCount = todayItems.filter((item) => priorityGrade(item.priority) === 'SSS').length;
  const [studioActive, setStudioActive] = useState<number | null>(null);
  const [proposalSummary, setProposalSummary] = useState<Awaited<ReturnType<typeof window.wmb.getProposalLedgerSummary>>>(null);
  const [researchGaps, setResearchGaps] = useState<ResearchSuccessorGapItem[]>([]);
  const [researchBusyId, setResearchBusyId] = useState<string | null>(null);
  const [researchMessage, setResearchMessage] = useState('');
  const [detailSource, setDetailSource] = useState<TodaySource | null>(null);
  const [detailBody, setDetailBody] = useState<SourceBodyCacheRecord | null>(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
  const [detailBodyError, setDetailBodyError] = useState('');
  const [detailMedia, setDetailMedia] = useState<SourceMediaOverview | null>(null);
  const [detailMediaLoading, setDetailMediaLoading] = useState(false);
  const [detailMediaError, setDetailMediaError] = useState('');
  const feedListRef = useRef<HTMLDivElement | null>(null);
  const detailReturnSourceIdRef = useRef<string | null>(null);
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

  // WMB-5174：Today「研究缺口 · 等你批」只读投影（仅 unresolved required needs_user 上桌）。
  useEffect(() => {
    let active = true;
    const loadGaps = () => void window.wmb.listResearchSuccessorsNeedsUser().then((items) => {
      if (active) setResearchGaps(items ?? []);
    }).catch(() => {});
    loadGaps();
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes('today') || event.scopes.includes('agent')) loadGaps();
    });
    return () => { active = false; unsubscribe(); };
  }, [planDate]);

  const decideResearchGap = async (jobId: string, decision: keyof typeof RESEARCH_DECISION_LABEL) => {
    if (researchBusyId) return;
    setResearchBusyId(jobId);
    setResearchMessage('');
    try {
      const result = await window.wmb.decideResearchSuccessor({ jobId, decision });
      if (result && typeof result === 'object' && result.ok) {
        setResearchMessage(`已选择「${RESEARCH_DECISION_LABEL[decision]}」：原角色续派已恢复待调度。`);
        window.setTimeout(() => { refresh(); window.wmb.listResearchSuccessorsNeedsUser().then((items) => setResearchGaps(items ?? [])).catch(() => {}); }, 250);
      } else {
        const error = result && typeof result === 'object' && result.error ? result.error : null;
        setResearchMessage(error ? `决策未生效（${error.code}）：${error.message}` : '决策未生效：未知错误。');
      }
    } catch (error) {
      setResearchMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setResearchBusyId(null);
    }
  };

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
    if (!onFocusChange) return;
    if (!detailSource) {
      onFocusChange(null);
      return;
    }
    const bodyStatus = detailBody?.status ?? 'none';
    const bodyExcerpt = bodyStatus === 'ready' && detailBody?.extractedText?.trim()
      ? detailBody.extractedText.slice(0, 6000)
      : null;
    onFocusChange({
      type: 'source',
      id: detailSource.id,
      title: detailSource.title,
      summary: detailSource.summary,
      url: detailSource.canonicalUrl,
      bodyStatus,
      bodyExcerpt,
      bodyChars: bodyStatus === 'ready' ? detailBody?.extractedChars ?? bodyExcerpt?.length ?? 0 : 0,
      meta: {
        author: detailSource.author,
        publishedAt: detailSource.publishedAt,
        collectedAt: detailSource.collectedAt
      }
    });
  }, [detailSource, detailBody, onFocusChange]);

  // WMB-5254：当前来源的存档媒体读模型（revision 冻结集合；只读，不写库）。
  useEffect(() => {
    if (!detailSource) { setDetailMedia(null); setDetailMediaError(''); setDetailMediaLoading(false); return; }
    let active = true;
    setDetailMediaLoading(true);
    setDetailMediaError('');
    void window.wmb.getSourceMediaOverview({ sourceId: detailSource.id }).then((value) => {
      if (!active) return;
      setDetailMedia(value);
    }).catch((error) => {
      if (!active) return;
      setDetailMediaError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setDetailMediaLoading(false); });
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
            const managerProjection = projectManagerTaskForToday(manager, child);
            const snapshot = managerProjection.task;
            setTask((prev) => JSON.stringify(prev ?? null) === JSON.stringify(snapshot) ? prev : snapshot);
            startingRef.current = false;
            setRunning(managerProjection.running);
            writeTodayRunCache({ planDate, task: snapshot, running: managerProjection.running });
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
  const openSourceDetail = (source: TodaySource) => {
    detailReturnSourceIdRef.current = source.id;
    setDetailSource(source);
  };
  const closeSourceDetail = () => {
    const sourceId = detailReturnSourceIdRef.current;
    setDetailSource(null);
    window.requestAnimationFrame(() => {
      if (!sourceId) return;
      document.querySelector<HTMLElement>(`[data-source-open="${CSS.escape(sourceId)}"]`)?.focus();
    });
  };

  useEffect(() => {
    if (!detailSource) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeSourceDetail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailSource?.id]);

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
          const managerProjection = projectManagerTaskForToday(data.managerTask, null);
          setRunning(managerProjection.running);
          setTask(managerProjection.task);
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
    if (id === 'view_sources') { openLibrary(); return; }
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
    {detailSource ? <TodaySourceDetail
      onBack={closeSourceDetail}
      openLibrary={openLibrary}
      aiSourcePresentation={aiSourcePresentation}
      detailSource={detailSource}
      detailBody={detailBody}
      detailBodyLoading={detailBodyLoading}
      detailBodyError={detailBodyError}
      detailMedia={detailMedia}
      detailMediaLoading={detailMediaLoading}
      detailMediaError={detailMediaError}
    /> : <section className="today-main">
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
            {xChannelAbsent ? <div className="pool-absent-banner" role="status"><span>X 未接入：本次判断未包含 X 动态。</span><button type="button" onClick={() => openSettings?.('browser')}>重新验证浏览器</button></div> : null}
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
                            <div className="feed-title" role="button" tabIndex={copy === 0 ? 0 : -1} data-source-open={copy === 0 ? source.id : undefined} title="打开资料详情" onClick={(event) => { event.stopPropagation(); if (copy === 0) openSourceDetail(source); }} onKeyDown={(event) => { if (copy === 0 && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); openSourceDetail(source); } }}>{source.title}</div>
                            <div className="feed-sub" role="button" tabIndex={copy === 0 ? 0 : -1} title="打开资料详情" onClick={(event) => { event.stopPropagation(); if (copy === 0) openSourceDetail(source); }} onKeyDown={(event) => { if (copy === 0 && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); openSourceDetail(source); } }}>
                              <span>{sourceOriginLabel({ ...source, pinned: pinnedSourceIds.has(source.id) })}</span>
                              <span>·</span>
                              <span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? '时间未知'}</span>
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
      {researchGaps.length > 0 ? (
        <section className="today-research-gaps" aria-label="研究缺口 · 等你批">
          <header className="today-research-gaps-head">
            <h3 className="today-research-gaps-title">研究缺口 · 等你批</h3>
            <span className="today-research-gaps-note">研究补料有未解决声明，需你决策后续动作</span>
          </header>
          <ul className="today-research-gap-list">
            {researchGaps.map((gap) => (
              <li className="today-research-gap" key={gap.id} data-successor={gap.id}>
                <p className="today-research-gap-claims">
                  {gap.unresolvedClaims.map((claim) => (
                    <span className="today-research-gap-claim" key={claim.key} title={claim.text ?? undefined}>
                      <b>{claim.key}</b>
                      {claim.text ? <span className="today-research-gap-claim-text">{claim.text}</span> : null}
                    </span>
                  ))}
                </p>
                <p className="today-research-gap-meta">
                  父工单 {RESEARCH_PARENT_ROLE_LABEL[gap.parentRoleId]} · 研究任务 #{gap.researchTaskId.slice(0, 8)} · 等待你的决策
                </p>
                <div className="today-research-gap-actions">
                  <button type="button" className="today-research-gap-action" disabled={researchBusyId !== null} onClick={() => void decideResearchGap(gap.id, 'narrow')}>收窄</button>
                  <button type="button" className="today-research-gap-action" disabled={researchBusyId !== null} onClick={() => void decideResearchGap(gap.id, 'supplement')}>手动补料</button>
                  <button type="button" className="today-research-gap-action strong" disabled={researchBusyId !== null} onClick={() => void decideResearchGap(gap.id, 'accept')}>接受并标注待核实</button>
                </div>
              </li>
            ))}
          </ul>
          {researchMessage ? <p className="today-research-gap-msg" role="status">{researchMessage}</p> : null}
        </section>
      ) : null}
      <FermentingRail fermenting={fermenting} createFromCarry={createFromCarry} selectedId={fermentSelectedItem?.id ?? null} onSelectItem={onFermentSelectedItemChange}/>
    </section>}
  </div>;
}
