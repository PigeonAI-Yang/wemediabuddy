import type { PiFocusObject } from './app-types';
import { useEffect, useRef, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import { SourceMark } from './source-mark';
import { PlatformMark } from './platform-mark';
import { formatNames, platformNames } from './app-types';
import { dailyPreflightMessage } from './intelligence-channel-ui';
import {
  BODY_EXCERPT_CHARS, MAX_SELECTED_SOURCES, Opportunity, SourceList,
  bodyToSelectedFields, domainOf, formatSourcePublishedAt, isHeartbeatSource, latestSourceTime,
  phaseLabels, priorityGrade, priorityLabel, sortFeedSources,
  type SelectedTodaySource
} from './today-view-parts';
import { FermentingRail, TodaySourceDetail } from './today-view-panels';

export function TodayView({ today, refresh, openStudio, openLibrary, selectedItems, onSelectionChange, selectedSources, onSelectedSourcesChange, planDate, onStatusChange, aiSourcePresentation, intelligenceChannels, piConfigured }: {
  today: Awaited<ReturnType<typeof window.wmb.getToday>>;
  refresh: () => void; openStudio: () => void;
  openLibrary: (sourceId?: string) => void;
  selectedItems: TodayPlanItem[]; onSelectionChange: (items: TodayPlanItem[]) => void;
  selectedSources: SelectedTodaySource[]; onSelectedSourcesChange: (sources: SelectedTodaySource[]) => void;
  planDate: string;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void; aiSourcePresentation: boolean;
  intelligenceChannels: IntelligenceChannelsSummary | null; piConfigured: boolean;
}): React.JSX.Element {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [taskStatus, setTaskStatus] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [task, setTask] = useState<any>(null);
  const [, tick] = useState(0);
  const sources = today?.sources ?? [];
  const fermenting = today?.fermenting ?? { items: [], watchingItems: [], topics: [], pinnedSources: [] };
  const feedSources = sortFeedSources(sources);
  const pinnedSourceIds = new Set((fermenting.pinnedSources || []).map((item) => item.id));
  const displayPlan = today?.plan ?? today?.latestPlan ?? null;
  const items = displayPlan?.items ?? [];
  const primary = items[0] ?? null;
  const pendingActions = today?.pendingActions ?? [];
  const pendingCount = pendingActions.length;
  const sssCount = items.filter((item) => priorityGrade(item.priority) === 'SSS').length;
  const [studioActive, setStudioActive] = useState<number | null>(null);
  const [detailSource, setDetailSource] = useState<TodaySource | null>(null);
  const [detailBody, setDetailBody] = useState<Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>>(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
  const [detailBodyError, setDetailBodyError] = useState('');
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
  }, [displayPlan?.id]);
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
    openStudio();
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
    const blocker = dailyPreflightMessage({ summary: intelligenceChannels, piConfigured });
    if (blocker) { setTaskStatus(blocker); return; }
    setRunning(true);
    setTaskStatus('今日情报正在启动…');
    try {
      const result = await window.wmb.startDailyIntelligence({ businessDate: planDate }) as {
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
  const judgmentPhase = ['channel_scanned', 'running_pi', 'judging_opportunities', 'synthesizing', 'validating'].includes(String(task?.phase || ''));
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
                  <span>{judgmentPhase ? `渠道 ${processed}/${planned}` : (planned > 0 ? `${processed}/${planned}` : `${progressPct}%`)}</span>
                  <span>已运行 {elapsedMin} 分钟</span>
                </div>
              </div>
              <div className="intelligence-bar" data-indeterminate={judgmentPhase || undefined} aria-label={judgmentPhase ? `渠道扫描已完成 ${processed}/${planned}，正在生成方案` : `渠道扫描进度 ${progressPct}%`}>
                <i style={{ width: `${Math.max(progressPct, running ? 6 : 0)}%` }} />
              </div>
              <div className="intelligence-counts" aria-label="进度计数">
                <span><b>{planned}</b>渠道</span>
                <span><b>{processed}</b>已扫描</span>
                <span><b>{failed}</b>失败</span>
                <span><b>{verified}</b>核验</span>
                <span><b>{saved}</b>保存</span>
                <span><b>{opportunityCount}</b>机会</span>
              </div>
              {reallyStuck ? (
                <p className="intelligence-last-event">任务心跳超过 60 秒未更新，进程可能已挂起；可保存并停止或取消后重试。</p>
              ) : lastEventText && lastEventText !== currentSource && !(currentSource && lastEventText.includes(currentSource)) ? (
                <p className="intelligence-last-event">{lastEventText}</p>
              ) : null}
            </div>
            <div className="today-command-actions">
              <button className="secondary-button" onClick={() => setSourcesOpen(true)}>查看资料</button>
              <button className="secondary-button" disabled={!task?.id} onClick={() => { if (!task?.id) return; void window.wmb.controlDailyIntelligence({ id: task.id, action: 'save_partial' }); }}>保存并停止</button>
              <button className="secondary-button" disabled={!task?.id} onClick={() => { if (!task?.id) return; void window.wmb.controlDailyIntelligence({ id: task.id, action: 'cancel' }); }}>取消任务</button>
            </div>
          </>
        ) : (
          <>
            <div className="today-command-stats" aria-label="今日指标">
              <div className="today-command-stat">
                <span className="stat-label">{today?.sourcesDate === planDate ? '今日新资料' : '最近资料'}</span>
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
              <button className="primary-button" onClick={() => void startIntelligence()}>{today?.plan ? '⟳ 重新侦察' : '开始今日情报'}</button>
            </div>
          </>
        )}
      </section>
      <div className="today-grid">
        <div className="today-opps" ref={oppsRef}>
          {primary ? <>
            {!today?.plan && displayPlan ? <p className="eyebrow">最近方案 · {displayPlan.planDate}</p> : null}
            <Opportunity item={primary} primary selected={selectedItems.some((item) => item.id === primary.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>
            {items.length > 1 && <div className="opp-list">{items.slice(1).map((item) => <Opportunity key={item.id} item={item} selected={selectedItems.some((selected) => selected.id === item.id)} onToggle={toggleSelection} onCreate={create} sources={sources}/>)}</div>}
          </> : <section className="empty-state">
            <h2>{running ? '正在侦察今日内容机会' : '今日内容机会还在准备中'}</h2>
            <p>{running
              ? (currentSource ? `正在处理：${currentSource}` : '来源扫描和整理完成后，机会会自动出现在这里。')
              : '完成今日情报后，内容机会会自动出现在这里。'}</p>
          </section>}
          <FermentingRail fermenting={fermenting} createFromCarry={createFromCarry}/>
        </div>
        <aside className="today-rail" ref={railRef}>
          {pendingActions.length > 0 && <>
            <p className="eyebrow">待你处理 · {pendingCount}</p>
            {pendingActions.map((action) => <div className="action-card" key={action}>
              <div className="action-icon" aria-hidden="true">✋</div>
              <div>
                <div className="action-title">{action}</div>
                <div className="action-sub">需要人工处理后流程才能继续</div>
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
    {detailSource ? <TodaySourceDetail detailSource={detailSource} detailBody={detailBody} detailBodyLoading={detailBodyLoading} detailBodyError={detailBodyError} selectedSources={selectedSources} onClose={() => setDetailSource(null)} onToggleSelection={toggleSourceSelection} onAttachBody={attachBodyToSelection} openLibrary={openLibrary}/> : null}
  </div>;
}
