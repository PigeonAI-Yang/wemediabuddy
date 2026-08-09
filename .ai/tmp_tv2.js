import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/today-view.tsx?t=123456789");import __vite__cjsImport0_react_jsxDevRuntime from "/@fs/J:/PigeonYang/WeMediaBuddy/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=9611161f"; const Fragment = __vite__cjsImport0_react_jsxDevRuntime["Fragment"]; const jsxDEV = __vite__cjsImport0_react_jsxDevRuntime["jsxDEV"];
var _s = $RefreshSig$();
import __vite__cjsImport1_react from "/@fs/J:/PigeonYang/WeMediaBuddy/node_modules/.vite/deps/react.js?v=9611161f"; const useEffect = __vite__cjsImport1_react["useEffect"]; const useMemo = __vite__cjsImport1_react["useMemo"]; const useRef = __vite__cjsImport1_react["useRef"]; const useState = __vite__cjsImport1_react["useState"];
import { SourceMark } from "/source-mark.tsx";
import {
  MAX_SELECTED_SOURCES,
  Opportunity,
  SourceList,
  bodyToSelectedFields,
  formatSourcePublishedAt,
  isHeartbeatSource,
  priorityGrade,
  sortFeedSources
} from "/today-view-parts.tsx?t=1786031618164";
import { FermentingRail, TodaySourceDetail } from "/today-view-panels.tsx?t=1786031639813";
import { poolBadges, poolItemToPlanItem } from "/today-pool-view.ts?t=1786031618164";
import { useTodayRunningTransition } from "/today-running-transition.ts";
import { TodayCommandBar } from "/today-command-bar.tsx";
import { TodayBlockers } from "/today-blockers.tsx";
import {
  deriveTodayRunView
} from "/today-run-view.ts";
export function TodayView({
  today,
  refresh,
  openStudio,
  openLibrary,
  openSettings,
  selectedItems,
  onSelectionChange,
  selectedSources,
  onSelectedSourcesChange,
  planDate,
  onStatusChange,
  aiSourcePresentation,
  intelligenceChannels,
  piConfigured
}) {
  _s();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [running, setRunning] = useTodayRunningTransition();
  const [task, setTask] = useState(null);
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
  const displayItems = pool && pool.length > 0 ? pool.map(poolItemToPlanItem) : (todayPlan ?? latestPlan)?.items ?? [];
  const primary = displayItems[0] ?? null;
  const sssCount = todayItems.filter((item) => priorityGrade(item.priority) === "SSS").length;
  const [studioActive, setStudioActive] = useState(null);
  const [detailSource, setDetailSource] = useState(null);
  const [detailBody, setDetailBody] = useState(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
  const [detailBodyError, setDetailBodyError] = useState("");
  const oppsRef = useRef(null);
  const railRef = useRef(null);
  const feedListRef = useRef(null);
  const [visibleFeedCount, setVisibleFeedCount] = useState(feedSources.length);
  const sourcesAreToday = today?.sourcesDate === planDate;
  const todaySourcesTotal = sourcesAreToday ? today?.sourcesTotal ?? sources.length : 0;
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
  const feedRowHeightsRef = useRef([]);
  const feedHeightsSignatureRef = useRef("");
  useEffect(() => {
    const opps = oppsRef.current;
    const rail = railRef.current;
    const feed = feedListRef.current;
    if (!opps || !rail || !feed || typeof ResizeObserver === "undefined") return;
    let cancelled = false;
    let debounceTimer = null;
    const signature = `${sources.map((item) => `${item.id}:${item.title.length}`).join("|")}@${Math.round(feed.clientWidth)}`;
    const computeFit = (targetHeight) => {
      const railStyles = getComputedStyle(rail);
      const gap = Number.parseFloat(railStyles.rowGap || railStyles.gap || "0") || 0;
      let reserved = 0;
      for (const child of [...rail.children]) {
        if (child === feed) continue;
        reserved += Math.ceil(child.getBoundingClientRect().height) + gap;
      }
      const feedStyles = getComputedStyle(feed);
      const padY = (Number.parseFloat(feedStyles.paddingTop || "0") || 0) + (Number.parseFloat(feedStyles.paddingBottom || "0") || 0);
      const available = Math.max(0, targetHeight - reserved - padY);
      let used = 0;
      let fit = 0;
      for (const height of feedRowHeightsRef.current) {
        const next = used + height + (fit ? gap : 0);
        if (next > available + 0.5) break;
        used = next;
        fit += 1;
      }
      return Math.max(1, Math.min(feedSources.length, fit || 1));
    };
    const sync = () => {
      const targetHeight = Math.ceil(opps.getBoundingClientRect().height);
      if (targetHeight <= 0) return;
      rail.style.height = `${targetHeight}px`;
      rail.style.minHeight = `${targetHeight}px`;
      rail.style.maxHeight = `${targetHeight}px`;
      if (!feedSources.length) {
        setVisibleFeedCount(0);
        return;
      }
      if (feedHeightsSignatureRef.current !== signature) {
        setVisibleFeedCount(feedSources.length);
        window.requestAnimationFrame(() => {
          if (cancelled) return;
          feedRowHeightsRef.current = [...feed.querySelectorAll(".feed-item")].map((row) => Math.ceil(row.getBoundingClientRect().height));
          feedHeightsSignatureRef.current = signature;
          const fit2 = computeFit(targetHeight);
          setVisibleFeedCount((prev) => prev === fit2 ? prev : fit2);
        });
        return;
      }
      const fit = computeFit(targetHeight);
      setVisibleFeedCount((prev) => prev === fit ? prev : fit);
    };
    const ro = new ResizeObserver(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      debounceTimer = setTimeout(() => {
        if (!cancelled) sync();
      }, 120);
    });
    ro.observe(opps);
    ro.observe(rail);
    sync();
    return () => {
      cancelled = true;
      clearTimeout(debounceTimer ?? void 0);
      ro.disconnect();
    };
  }, [primary?.id, displayItems.length, sources.map((item) => item.id).join("|"), runView.blockers.length, task?.status, feedSources.length]);
  useEffect(() => {
    let active = true;
    void window.wmb.getStudioSummary().then((summary) => {
      if (!active || !summary) return;
      setStudioActive(summary.byStatus.idea + summary.byStatus.drafting + summary.byStatus.review + summary.byStatus.ready);
    }).catch(() => {
    });
    return () => {
      active = false;
    };
  }, [todayPlan?.id, latestPlan?.id, displayItems.length]);
  useEffect(() => {
    if (!detailSource) {
      setDetailBody(null);
      setDetailBodyError("");
      setDetailBodyLoading(false);
      return;
    }
    let active = true;
    setDetailBodyLoading(true);
    setDetailBodyError("");
    void window.wmb.getSourceBodyCache(detailSource.id).then((value) => {
      if (!active) return;
      setDetailBody(value);
    }).catch((error) => {
      if (!active) return;
      setDetailBodyError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setDetailBodyLoading(false);
    });
    return () => {
      active = false;
    };
  }, [detailSource?.id]);
  useEffect(() => {
    const load = () => void window.wmb.getAgentTask({ intent: "daily_intelligence", businessDate: planDate }).then((value) => {
      const typed = value && typeof value === "object" ? value : null;
      setTask((prev) => JSON.stringify(prev ?? null) === JSON.stringify(typed ?? null) ? prev : typed);
      if (!typed) {
        if (!startingRef.current) setRunning(false);
        return;
      }
      const nextRunning = typed.status === "running";
      if (nextRunning) startingRef.current = false;
      if (!nextRunning && startingRef.current) return;
      setRunning(nextRunning);
    }).catch(() => {
    });
    load();
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes("agent") || event.scopes.includes("today")) load();
    });
    const poll = running || startingRef.current ? window.setInterval(load, 5e3) : 0;
    return () => {
      unsubscribe();
      if (poll) window.clearInterval(poll);
    };
  }, [planDate, running]);
  useEffect(() => {
    if (!running) return;
    const clock = window.setInterval(() => tick((value) => value + 1), 1e3);
    return () => window.clearInterval(clock);
  }, [running]);
  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange({ text: runView.statusLine, running });
    return () => onStatusChange(null);
  }, [runView.statusLine, running, onStatusChange]);
  const create = async (item) => {
    await window.wmb.createProjectFromPlanItem(item.id);
    openStudio();
  };
  const poolBadgeMap = useMemo(() => {
    const nowMs = Date.now();
    return new Map((pool ?? []).map((item) => [item.planItemId, poolBadges(item, nowMs, planDate)]));
  }, [pool, planDate]);
  const dismissOpportunity = async (planItemId) => {
    if (!window.confirm("否掉这个机会？它会从池中移除且不再出现。")) return;
    try {
      await window.wmb.dismissPlanItem({ planItemId });
      refresh();
    } catch (error) {
      onStatusChange?.({ text: error instanceof Error ? error.message : String(error), running: false });
    }
  };
  const xChannelAbsent = Boolean(intelligenceChannels?.readiness?.some((entry) => entry.module === "x_lists" && entry.status === "needs_user"));
  const createFromCarry = async (item) => {
    if (item.objectType !== "plan_item") return;
    await window.wmb.createProjectFromPlanItem(item.objectId);
    openStudio();
  };
  const toggleSelection = (item) => {
    onSelectionChange(selectedItems.some((selected) => selected.id === item.id) ? selectedItems.filter((selected) => selected.id !== item.id) : [...selectedItems, item]);
  };
  const toggleSourceSelection = (source) => {
    const exists = selectedSources.some((item) => item.id === source.id);
    if (exists) {
      onSelectedSourcesChange(selectedSources.filter((item) => item.id !== source.id));
      return;
    }
    if (selectedSources.length >= MAX_SELECTED_SOURCES) return;
    onSelectedSourcesChange([...selectedSources, { ...source, bodyStatus: "none", bodyExcerpt: null, bodyChars: 0 }]);
  };
  const attachBodyToSelection = async (source, force = false) => {
    setDetailBodyLoading(true);
    setDetailBodyError("");
    try {
      const body = await window.wmb.fetchSourceBody({ sourceId: source.id, force, maxChars: 2e4 });
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
    setTask((prev) => prev?.status === "running" ? prev : { status: "running", phase: "starting", progress: {}, events: [] });
    try {
      const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(/* @__PURE__ */ new Date());
      const result = await window.wmb.startDailyIntelligence({ businessDate });
      if (!result.ok) {
        startingRef.current = false;
        setRunning(false);
        setTask({ status: "failed", errorMessage: result.error?.message || "今日情报失败" });
        return;
      }
      if (result.data?.task) {
        setTask(result.data.task);
        startingRef.current = result.data.task.status === "running" ? false : false;
      } else {
        startingRef.current = false;
      }
      refresh();
    } catch (error) {
      startingRef.current = false;
      setRunning(false);
      setTask({ status: "failed", errorMessage: error instanceof Error ? error.message : String(error) });
    } finally {
      window.setTimeout(() => refresh(), 300);
    }
  };
  const onPrimary = () => {
    if (runView.primaryCta.kind === "open_studio") {
      openStudio();
      return;
    }
    if (runView.primaryCta.kind === "none") return;
    void startIntelligence();
  };
  const onSecondary = (id) => {
    if (id === "view_sources") {
      setSourcesOpen(true);
      return;
    }
    if (id === "refresh") {
      refresh();
      return;
    }
    if (id === "open_studio") {
      openStudio();
      return;
    }
    if (id === "restart") {
      if (!window.confirm("重新侦察会用新结果替换今日方案，继续？")) return;
      void startIntelligence();
      return;
    }
    if (id === "save_partial") {
      if (!task?.id) return;
      void window.wmb.controlDailyIntelligence({ id: task.id, action: "save_partial" });
      return;
    }
    if (id === "cancel") {
      if (!task?.id) return;
      if (!window.confirm("未保存的渠道结果会丢弃；想保留请先「保存并停止」。")) return;
      void window.wmb.controlDailyIntelligence({ id: task.id, action: "cancel" });
    }
  };
  const onBlocker = (action) => {
    if (action === "retry") {
      void startIntelligence();
      return;
    }
    if (action === "open_settings_browser") {
      openSettings?.("browser");
      return;
    }
    if (action === "open_settings_channels") {
      openSettings?.("channels");
      return;
    }
    if (action === "open_settings_ai") {
      openSettings?.("ai");
    }
  };
  return /* @__PURE__ */ jsxDEV("div", { className: "today-layout", onClick: (event) => {
    const target = event.target;
    if (!target.closest("[data-opportunity-card], [data-feed-item], [data-source-detail], button, a, input, select, textarea, label")) {
      onSelectionChange([]);
      onSelectedSourcesChange([]);
    }
  }, children: [
    /* @__PURE__ */ jsxDEV("section", { className: "today-main", children: [
      /* @__PURE__ */ jsxDEV(
        TodayCommandBar,
        {
          view: runView,
          taskId: task?.id,
          planDate,
          onPrimary,
          onSecondary
        },
        void 0,
        false,
        {
          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
          lineNumber: 326,
          columnNumber: 7
        },
        this
      ),
      /* @__PURE__ */ jsxDEV("div", { className: "today-grid", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "today-opps", ref: oppsRef, children: primary ? /* @__PURE__ */ jsxDEV(Fragment, { children: [
          xChannelAbsent ? /* @__PURE__ */ jsxDEV("div", { className: "pool-absent-banner", role: "status", children: [
            /* @__PURE__ */ jsxDEV("span", { children: "X 渠道缺席：本次判断未包含 X 动态。" }, void 0, false, {
              fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
              lineNumber: 336,
              columnNumber: 81
            }, this),
            /* @__PURE__ */ jsxDEV("button", { type: "button", onClick: () => openSettings?.("browser"), children: "重新验证浏览器" }, void 0, false, {
              fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
              lineNumber: 336,
              columnNumber: 114
            }, this)
          ] }, void 0, true, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 336,
            columnNumber: 31
          }, this) : null,
          /* @__PURE__ */ jsxDEV(Opportunity, { item: primary, primary: true, selected: selectedItems.some((item) => item.id === primary.id), onToggle: toggleSelection, onCreate: create, sources, badges: poolBadgeMap.get(primary.id), onDismiss: () => void dismissOpportunity(primary.id) }, void 0, false, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 337,
            columnNumber: 13
          }, this),
          displayItems.length > 1 && /* @__PURE__ */ jsxDEV("div", { className: "opp-list", children: displayItems.slice(1).map((item) => /* @__PURE__ */ jsxDEV(Opportunity, { item, selected: selectedItems.some((selected) => selected.id === item.id), onToggle: toggleSelection, onCreate: create, sources, badges: poolBadgeMap.get(item.id), onDismiss: () => void dismissOpportunity(item.id) }, item.id, false, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 338,
            columnNumber: 104
          }, this)) }, void 0, false, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 338,
            columnNumber: 41
          }, this)
        ] }, void 0, true, {
          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
          lineNumber: 335,
          columnNumber: 22
        }, this) : /* @__PURE__ */ jsxDEV("section", { className: "empty-state", children: [
          /* @__PURE__ */ jsxDEV("h2", { children: runView.opportunityEmptyTitle }, void 0, false, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 340,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("p", { children: runView.opportunityEmptyBody }, void 0, false, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 341,
            columnNumber: 13
          }, this)
        ] }, void 0, true, {
          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
          lineNumber: 339,
          columnNumber: 17
        }, this) }, void 0, false, {
          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
          lineNumber: 334,
          columnNumber: 9
        }, this),
        /* @__PURE__ */ jsxDEV("aside", { className: "today-rail", ref: railRef, children: [
          /* @__PURE__ */ jsxDEV(TodayBlockers, { blockers: runView.blockers, onAction: onBlocker }, void 0, false, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 345,
            columnNumber: 11
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "feed-list", ref: feedListRef, children: [
            !sourcesAreToday && today?.sourcesDate && feedSources.length > 0 ? /* @__PURE__ */ jsxDEV("p", { className: "feed-context", children: [
              "今天暂无新资料，以下为 ",
              today.sourcesDate,
              " 入库"
            ] }, void 0, true, {
              fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
              lineNumber: 347,
              columnNumber: 81
            }, this) : null,
            selectedSources.length > 0 && /* @__PURE__ */ jsxDEV("div", { className: "feed-selection-bar", children: [
              "已选 ",
              selectedSources.length,
              "/",
              MAX_SELECTED_SOURCES,
              " 条资料进 Pi"
            ] }, void 0, true, {
              fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
              lineNumber: 348,
              columnNumber: 44
            }, this),
            feedSources.slice(0, visibleFeedCount).map((source) => {
              const selected = selectedSources.some((item) => item.id === source.id);
              const heartbeat = isHeartbeatSource(source);
              const disabled = !selected && selectedSources.length >= MAX_SELECTED_SOURCES;
              return /* @__PURE__ */ jsxDEV(
                "div",
                {
                  className: `feed-item${selected ? " selected" : ""}${heartbeat ? " heartbeat" : ""}${pinnedSourceIds.has(source.id) ? " pinned" : ""}${disabled ? " disabled" : ""}`,
                  "data-feed-item": true,
                  title: disabled ? `最多选择 ${MAX_SELECTED_SOURCES} 条` : selected ? "点击空白处移出 Pi 上下文" : "点击空白处加入 Pi 上下文",
                  onClick: () => {
                    if (!disabled) toggleSourceSelection(source);
                  },
                  children: [
                    /* @__PURE__ */ jsxDEV(SourceMark, { canonicalUrl: source.canonicalUrl, aiSourcePresentation }, void 0, false, {
                      fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                      lineNumber: 360,
                      columnNumber: 17
                    }, this),
                    /* @__PURE__ */ jsxDEV("div", { className: "feed-main", children: [
                      /* @__PURE__ */ jsxDEV("div", { className: "feed-title", title: "打开资料详情", onClick: (event) => {
                        event.stopPropagation();
                        setDetailSource(source);
                      }, children: source.title }, void 0, false, {
                        fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                        lineNumber: 362,
                        columnNumber: 19
                      }, this),
                      /* @__PURE__ */ jsxDEV("div", { className: "feed-sub", title: "打开资料详情", onClick: (event) => {
                        event.stopPropagation();
                        setDetailSource(source);
                      }, children: [
                        /* @__PURE__ */ jsxDEV("span", { children: pinnedSourceIds.has(source.id) ? "重点" : heartbeat ? "巡检打卡" : source.categories[0] || "入库资料" }, void 0, false, {
                          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                          lineNumber: 364,
                          columnNumber: 21
                        }, this),
                        /* @__PURE__ */ jsxDEV("span", { children: "·" }, void 0, false, {
                          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                          lineNumber: 365,
                          columnNumber: 21
                        }, this),
                        /* @__PURE__ */ jsxDEV("span", { children: formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? "时间未知" }, void 0, false, {
                          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                          lineNumber: 366,
                          columnNumber: 21
                        }, this),
                        selected && selectedSources.find((item) => item.id === source.id)?.bodyStatus === "ready" ? /* @__PURE__ */ jsxDEV("span", { className: "feed-body-pill", children: "含正文" }, void 0, false, {
                          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                          lineNumber: 367,
                          columnNumber: 114
                        }, this) : null
                      ] }, void 0, true, {
                        fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                        lineNumber: 363,
                        columnNumber: 19
                      }, this)
                    ] }, void 0, true, {
                      fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                      lineNumber: 361,
                      columnNumber: 17
                    }, this)
                  ]
                },
                source.id,
                true,
                {
                  fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
                  lineNumber: 353,
                  columnNumber: 22
                },
                this
              );
            })
          ] }, void 0, true, {
            fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
            lineNumber: 346,
            columnNumber: 11
          }, this)
        ] }, void 0, true, {
          fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
          lineNumber: 344,
          columnNumber: 9
        }, this)
      ] }, void 0, true, {
        fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
        lineNumber: 333,
        columnNumber: 7
      }, this),
      /* @__PURE__ */ jsxDEV(FermentingRail, { fermenting, createFromCarry }, void 0, false, {
        fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
        lineNumber: 375,
        columnNumber: 7
      }, this)
    ] }, void 0, true, {
      fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
      lineNumber: 325,
      columnNumber: 5
    }, this),
    /* @__PURE__ */ jsxDEV("button", { className: `drawer-backdrop${sourcesOpen || detailSource ? " open" : ""}`, "aria-label": "关闭侧栏", onClick: () => {
      setSourcesOpen(false);
      setDetailSource(null);
    } }, void 0, false, {
      fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
      lineNumber: 377,
      columnNumber: 5
    }, this),
    /* @__PURE__ */ jsxDEV(SourceList, { sources, sourceDate: today?.sourcesDate ?? null, planDate, open: sourcesOpen, close: () => setSourcesOpen(false), openLibrary: () => openLibrary(), aiSourcePresentation }, void 0, false, {
      fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
      lineNumber: 378,
      columnNumber: 5
    }, this),
    detailSource ? /* @__PURE__ */ jsxDEV(TodaySourceDetail, { detailSource, detailBody, detailBodyLoading, detailBodyError, selectedSources, onClose: () => setDetailSource(null), onToggleSelection: toggleSourceSelection, onAttachBody: attachBodyToSelection, openLibrary }, void 0, false, {
      fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
      lineNumber: 379,
      columnNumber: 21
    }, this) : null
  ] }, void 0, true, {
    fileName: "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789",
    lineNumber: 318,
    columnNumber: 10
  }, this);
}
_s(TodayView, "d4YVPaTZT3IdQgyGn0Eh/V4q21w=", false, function() {
  return [useTodayRunningTransition];
});
_c = TodayView;
var _c;
$RefreshReg$(_c, "TodayView");
import * as RefreshRuntime from "/@react-refresh";
const inWebWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
if (import.meta.hot && !inWebWorker) {
  if (!window.$RefreshReg$) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong."
    );
  }
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh("J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}
function $RefreshReg$(type, id) {
  return RefreshRuntime.register(type, "J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx?t=123456789 " + id);
}
function $RefreshSig$() {
  return RefreshRuntime.createSignatureFunctionForTransform();
}

//# sourceMappingURL=data:application/json;base64,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V0FtREE7QUFBQSxJQUNBLHVCQUFDLFlBQU8sV0FBVyxrQkFBa0JuQixlQUFlaUMsZUFBZSxVQUFVLEVBQUUsSUFBSSxjQUFXLFFBQU8sU0FBUyxNQUFNO0FBQUVoQyxxQkFBZSxLQUFLO0FBQUdpQyxzQkFBZ0IsSUFBSTtBQUFBLElBQUcsS0FBcEs7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUFzSztBQUFBLElBQ3RLLHVCQUFDLGNBQVcsU0FBa0IsWUFBWWpELE9BQU84RCxlQUFlLE1BQU0sVUFBb0IsTUFBTS9DLGFBQWEsT0FBTyxNQUFNQyxlQUFlLEtBQUssR0FBRyxhQUFhLE1BQU1iLFlBQVksR0FBRyx3QkFBbkw7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUE4TjtBQUFBLElBQzdONkMsZUFBZSx1QkFBQyxxQkFBa0IsY0FBNEIsWUFBd0IsbUJBQXNDLGlCQUFrQyxpQkFBa0MsU0FBUyxNQUFNQyxnQkFBZ0IsSUFBSSxHQUFHLG1CQUFtQnlJLHVCQUF1QixjQUFjTSx1QkFBdUIsZUFBdFM7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUErVCxJQUFLO0FBQUEsT0E3RC9VO0FBQUE7QUFBQTtBQUFBO0FBQUEsU0E4RFA7QUFDRjtBQUFDbEwsR0FyV2VmLFdBQVM7QUFBQSxVQVlPSix5QkFBeUI7QUFBQTtBQUFBLEtBWnpDSTtBQUFTLElBQUEyTztBQUFBLGFBQUFBLElBQUEiLCJuYW1lcyI6WyJ1c2VFZmZlY3QiLCJ1c2VNZW1vIiwidXNlUmVmIiwidXNlU3RhdGUiLCJTb3VyY2VNYXJrIiwiTUFYX1NFTEVDVEVEX1NPVVJDRVMiLCJPcHBvcnR1bml0eSIsIlNvdXJjZUxpc3QiLCJib2R5VG9TZWxlY3RlZEZpZWxkcyIsImZvcm1hdFNvdXJjZVB1Ymxpc2hlZEF0IiwiaXNIZWFydGJlYXRTb3VyY2UiLCJwcmlvcml0eUdyYWRlIiwic29ydEZlZWRTb3VyY2VzIiwiRmVybWVudGluZ1JhaWwiLCJUb2RheVNvdXJjZURldGFpbCIsInBvb2xCYWRnZXMiLCJwb29sSXRlbVRvUGxhbkl0ZW0iLCJ1c2VUb2RheVJ1bm5pbmdUcmFuc2l0aW9uIiwiVG9kYXlDb21tYW5kQmFyIiwiVG9kYXlCbG9ja2VycyIsImRlcml2ZVRvZGF5UnVuVmlldyIsIlRvZGF5VmlldyIsInRvZGF5IiwicmVmcmVzaCIsIm9wZW5TdHVkaW8iLCJvcGVuTGlicmFyeSIsIm9wZW5TZXR0aW5ncyIsInNlbGVjdGVkSXRlbXMiLCJvblNlbGVjdGlvbkNoYW5nZSIsInNlbGVjdGVkU291cmNlcyIsIm9uU2VsZWN0ZWRTb3VyY2VzQ2hhbmdlIiwicGxhbkRhdGUiLCJvblN0YXR1c0NoYW5nZSIsImFpU291cmNlUHJlc2VudGF0aW9uIiwiaW50ZWxsaWdlbmNlQ2hhbm5lbHMiLCJwaUNvbmZpZ3VyZWQiLCJfcyIsInNvdXJjZXNPcGVuIiwic2V0U291cmNlc09wZW4iLCJydW5uaW5nIiwic2V0UnVubmluZyIsInRhc2siLCJzZXRUYXNrIiwic3RhcnRpbmdSZWYiLCJ0aWNrIiwic291cmNlcyIsImZlcm1lbnRpbmciLCJpdGVtcyIsIndhdGNoaW5nSXRlbXMiLCJ0b3BpY3MiLCJwaW5uZWRTb3VyY2VzIiwiZmVlZFNvdXJjZXMiLCJwaW5uZWRTb3VyY2VJZHMiLCJTZXQiLCJtYXAiLCJpdGVtIiwiaWQiLCJ0b2RheVBsYW4iLCJwbGFuIiwibGF0ZXN0UGxhbiIsInBvb2wiLCJ0b2RheUl0ZW1zIiwiZGlzcGxheUl0ZW1zIiwibGVuZ3RoIiwicHJpbWFyeSIsInNzc0NvdW50IiwiZmlsdGVyIiwicHJpb3JpdHkiLCJzdHVkaW9BY3RpdmUiLCJzZXRTdHVkaW9BY3RpdmUiLCJkZXRhaWxTb3VyY2UiLCJzZXREZXRhaWxTb3VyY2UiLCJkZXRhaWxCb2R5Iiwic2V0RGV0YWlsQm9keSIsImRldGFpbEJvZHlMb2FkaW5nIiwic2V0RGV0YWlsQm9keUxvYWRpbmciLCJkZXRhaWxCb2R5RXJyb3IiLCJzZXREZXRhaWxCb2R5RXJyb3IiLCJvcHBzUmVmIiwicmFpbFJlZiIsImZlZWRMaXN0UmVmIiwidmlzaWJsZUZlZWRDb3VudCIsInNldFZpc2libGVGZWVkQ291bnQiLCJzb3VyY2VzQXJlVG9kYXkiLCJzb3VyY2VzRGF0ZSIsInRvZGF5U291cmNlc1RvdGFsIiwic291cmNlc1RvdGFsIiwicnVuVmlldyIsImxvY2FsU3RhcnRpbmciLCJjdXJyZW50IiwiaGFzVG9kYXlQbGFuIiwiQm9vbGVhbiIsImhhc1JlY2VudFBsYW4iLCJvcHBvcnR1bml0eUNvdW50IiwiY2hhbm5lbHNTdW1tYXJ5IiwiZmVlZFJvd0hlaWdodHNSZWYiLCJmZWVkSGVpZ2h0c1NpZ25hdHVyZVJlZiIsIm9wcHMiLCJyYWlsIiwiZmVlZCIsIlJlc2l6ZU9ic2VydmVyIiwiY2FuY2VsbGVkIiwiZGVib3VuY2VUaW1lciIsInNpZ25hdHVyZSIsInRpdGxlIiwiam9pbiIsIk1hdGgiLCJyb3VuZCIsImNsaWVudFdpZHRoIiwiY29tcHV0ZUZpdCIsInRhcmdldEhlaWdodCIsInJhaWxTdHlsZXMiLCJnZXRDb21wdXRlZFN0eWxlIiwiZ2FwIiwiTnVtYmVyIiwicGFyc2VGbG9hdCIsInJvd0dhcCIsInJlc2VydmVkIiwiY2hpbGQiLCJjaGlsZHJlbiIsImNlaWwiLCJnZXRCb3VuZGluZ0NsaWVudFJlY3QiLCJoZWlnaHQiLCJmZWVkU3R5bGVzIiwicGFkWSIsInBhZGRpbmdUb3AiLCJwYWRkaW5nQm90dG9tIiwiYXZhaWxhYmxlIiwibWF4IiwidXNlZCIsImZpdCIsIm5leHQiLCJtaW4iLCJzeW5jIiwic3R5bGUiLCJtaW5IZWlnaHQiLCJtYXhIZWlnaHQiLCJ3aW5kb3ciLCJyZXF1ZXN0QW5pbWF0aW9uRnJhbWUiLCJxdWVyeVNlbGVjdG9yQWxsIiwicm93IiwicHJldiIsInJvIiwiY2xlYXJUaW1lb3V0Iiwic2V0VGltZW91dCIsIm9ic2VydmUiLCJ1bmRlZmluZWQiLCJkaXNjb25uZWN0IiwiYmxvY2tlcnMiLCJzdGF0dXMiLCJhY3RpdmUiLCJ3bWIiLCJnZXRTdHVkaW9TdW1tYXJ5IiwidGhlbiIsInN1bW1hcnkiLCJieVN0YXR1cyIsImlkZWEiLCJkcmFmdGluZyIsInJldmlldyIsInJlYWR5IiwiY2F0Y2giLCJnZXRTb3VyY2VCb2R5Q2FjaGUiLCJ2YWx1ZSIsImVycm9yIiwiRXJyb3IiLCJtZXNzYWdlIiwiU3RyaW5nIiwiZmluYWxseSIsImxvYWQiLCJnZXRBZ2VudFRhc2siLCJpbnRlbnQiLCJidXNpbmVzc0RhdGUiLCJ0eXBlZCIsIkpTT04iLCJzdHJpbmdpZnkiLCJuZXh0UnVubmluZyIsInVuc3Vic2NyaWJlIiwib25EYXRhQ2hhbmdlZCIsImV2ZW50Iiwic2NvcGVzIiwiaW5jbHVkZXMiLCJwb2xsIiwic2V0SW50ZXJ2YWwiLCJjbGVhckludGVydmFsIiwiY2xvY2siLCJ0ZXh0Iiwic3RhdHVzTGluZSIsImNyZWF0ZSIsImNyZWF0ZVByb2plY3RGcm9tUGxhbkl0ZW0iLCJwb29sQmFkZ2VNYXAiLCJub3dNcyIsIkRhdGUiLCJub3ciLCJNYXAiLCJwbGFuSXRlbUlkIiwiZGlzbWlzc09wcG9ydHVuaXR5IiwiY29uZmlybSIsImRpc21pc3NQbGFuSXRlbSIsInhDaGFubmVsQWJzZW50IiwicmVhZGluZXNzIiwic29tZSIsImVudHJ5IiwibW9kdWxlIiwiY3JlYXRlRnJvbUNhcnJ5Iiwib2JqZWN0VHlwZSIsIm9iamVjdElkIiwidG9nZ2xlU2VsZWN0aW9uIiwic2VsZWN0ZWQiLCJ0b2dnbGVTb3VyY2VTZWxlY3Rpb24iLCJzb3VyY2UiLCJleGlzdHMiLCJib2R5U3RhdHVzIiwiYm9keUV4Y2VycHQiLCJib2R5Q2hhcnMiLCJhdHRhY2hCb2R5VG9TZWxlY3Rpb24iLCJmb3JjZSIsImJvZHkiLCJmZXRjaFNvdXJjZUJvZHkiLCJzb3VyY2VJZCIsIm1heENoYXJzIiwiZmllbGRzIiwic3RhcnRJbnRlbGxpZ2VuY2UiLCJwcmltYXJ5Q3RhIiwicGhhc2UiLCJwcm9ncmVzcyIsImV2ZW50cyIsIkludGwiLCJEYXRlVGltZUZvcm1hdCIsInRpbWVab25lIiwiZm9ybWF0IiwicmVzdWx0Iiwic3RhcnREYWlseUludGVsbGlnZW5jZSIsIm9rIiwiZXJyb3JNZXNzYWdlIiwiZGF0YSIsIm9uUHJpbWFyeSIsImtpbmQiLCJvblNlY29uZGFyeSIsImNvbnRyb2xEYWlseUludGVsbGlnZW5jZSIsImFjdGlvbiIsIm9uQmxvY2tlciIsInRhcmdldCIsImNsb3Nlc3QiLCJnZXQiLCJzbGljZSIsIm9wcG9ydHVuaXR5RW1wdHlUaXRsZSIsIm9wcG9ydHVuaXR5RW1wdHlCb2R5IiwiaGVhcnRiZWF0IiwiZGlzYWJsZWQiLCJoYXMiLCJjYW5vbmljYWxVcmwiLCJzdG9wUHJvcGFnYXRpb24iLCJjYXRlZ29yaWVzIiwicHVibGlzaGVkQXQiLCJjb2xsZWN0ZWRBdCIsImZpbmQiLCJfYyJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJ0b2RheS12aWV3LnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyB1c2VFZmZlY3QsIHVzZU1lbW8sIHVzZVJlZiwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCc7XG5pbXBvcnQgdHlwZSB7IFRvZGF5UGxhbkl0ZW0sIFRvZGF5U291cmNlIH0gZnJvbSAnLi4vbWFpbi93b3JrYmVuY2gnO1xuaW1wb3J0IHR5cGUgeyBJbnRlbGxpZ2VuY2VDaGFubmVsc1N1bW1hcnkgfSBmcm9tICcuLi9tYWluL2ludGVsbGlnZW5jZS1jaGFubmVscyc7XG5pbXBvcnQgeyBTb3VyY2VNYXJrIH0gZnJvbSAnLi9zb3VyY2UtbWFyayc7XG5pbXBvcnQge1xuICBNQVhfU0VMRUNURURfU09VUkNFUywgT3Bwb3J0dW5pdHksIFNvdXJjZUxpc3QsXG4gIGJvZHlUb1NlbGVjdGVkRmllbGRzLCBmb3JtYXRTb3VyY2VQdWJsaXNoZWRBdCwgaXNIZWFydGJlYXRTb3VyY2UsXG4gIHByaW9yaXR5R3JhZGUsIHNvcnRGZWVkU291cmNlcywgdHlwZSBTZWxlY3RlZFRvZGF5U291cmNlXG59IGZyb20gJy4vdG9kYXktdmlldy1wYXJ0cyc7XG5pbXBvcnQgeyBGZXJtZW50aW5nUmFpbCwgVG9kYXlTb3VyY2VEZXRhaWwgfSBmcm9tICcuL3RvZGF5LXZpZXctcGFuZWxzJztcbmltcG9ydCB7IHBvb2xCYWRnZXMsIHBvb2xJdGVtVG9QbGFuSXRlbSB9IGZyb20gJy4vdG9kYXktcG9vbC12aWV3JztcbmltcG9ydCB7IHVzZVRvZGF5UnVubmluZ1RyYW5zaXRpb24gfSBmcm9tICcuL3RvZGF5LXJ1bm5pbmctdHJhbnNpdGlvbic7XG5pbXBvcnQgeyBUb2RheUNvbW1hbmRCYXIgfSBmcm9tICcuL3RvZGF5LWNvbW1hbmQtYmFyJztcbmltcG9ydCB7IFRvZGF5QmxvY2tlcnMgfSBmcm9tICcuL3RvZGF5LWJsb2NrZXJzJztcbmltcG9ydCB7XG4gIGRlcml2ZVRvZGF5UnVuVmlldyxcbiAgdHlwZSBEYWlseVRhc2tTbmFwc2hvdCxcbiAgdHlwZSBUb2RheUJsb2NrZXJBY3Rpb24sXG4gIHR5cGUgVG9kYXlTZWNvbmRhcnlJZFxufSBmcm9tICcuL3RvZGF5LXJ1bi12aWV3JztcblxuZXhwb3J0IHR5cGUgU2V0dGluZ3NTZWN0aW9uSWQgPSAnZ2VuZXJhbCcgfCAnYWknIHwgJ3NraWxscycgfCAnZGF0YScgfCAnYnJvd3NlcicgfCAnY2hhbm5lbHMnIHwgJ2xpc3RzJyB8ICdhZ2VudCcgfCAnZGlhZ25vc3RpY3MnIHwgJ2Fib3V0JztcblxuZXhwb3J0IGZ1bmN0aW9uIFRvZGF5Vmlldyh7IHRvZGF5LCByZWZyZXNoLCBvcGVuU3R1ZGlvLCBvcGVuTGlicmFyeSwgb3BlblNldHRpbmdzLCBzZWxlY3RlZEl0ZW1zLCBvblNlbGVjdGlvbkNoYW5nZSwgc2VsZWN0ZWRTb3VyY2VzLCBvblNlbGVjdGVkU291cmNlc0NoYW5nZSwgcGxhbkRhdGUsIG9uU3RhdHVzQ2hhbmdlLCBhaVNvdXJjZVByZXNlbnRhdGlvbiwgaW50ZWxsaWdlbmNlQ2hhbm5lbHMsIHBpQ29uZmlndXJlZCB9OiB7XG4gIHRvZGF5OiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHdpbmRvdy53bWIuZ2V0VG9kYXk+PjtcbiAgcmVmcmVzaDogKCkgPT4gdm9pZDsgb3BlblN0dWRpbzogKCkgPT4gdm9pZDtcbiAgb3BlbkxpYnJhcnk6IChzb3VyY2VJZD86IHN0cmluZykgPT4gdm9pZDtcbiAgb3BlblNldHRpbmdzPzogKHNlY3Rpb24/OiBTZXR0aW5nc1NlY3Rpb25JZCkgPT4gdm9pZDtcbiAgc2VsZWN0ZWRJdGVtczogVG9kYXlQbGFuSXRlbVtdOyBvblNlbGVjdGlvbkNoYW5nZTogKGl0ZW1zOiBUb2RheVBsYW5JdGVtW10pID0+IHZvaWQ7XG4gIHNlbGVjdGVkU291cmNlczogU2VsZWN0ZWRUb2RheVNvdXJjZVtdOyBvblNlbGVjdGVkU291cmNlc0NoYW5nZTogKHNvdXJjZXM6IFNlbGVjdGVkVG9kYXlTb3VyY2VbXSkgPT4gdm9pZDtcbiAgcGxhbkRhdGU6IHN0cmluZztcbiAgb25TdGF0dXNDaGFuZ2U/OiAoc3RhdHVzOiB7IHRleHQ6IHN0cmluZzsgcnVubmluZz86IGJvb2xlYW4gfSB8IG51bGwpID0+IHZvaWQ7IGFpU291cmNlUHJlc2VudGF0aW9uOiBib29sZWFuO1xuICBpbnRlbGxpZ2VuY2VDaGFubmVsczogSW50ZWxsaWdlbmNlQ2hhbm5lbHNTdW1tYXJ5IHwgbnVsbDsgcGlDb25maWd1cmVkOiBib29sZWFuO1xufSk6IFJlYWN0LkpTWC5FbGVtZW50IHtcbiAgY29uc3QgW3NvdXJjZXNPcGVuLCBzZXRTb3VyY2VzT3Blbl0gPSB1c2VTdGF0ZShmYWxzZSk7XG4gIGNvbnN0IFtydW5uaW5nLCBzZXRSdW5uaW5nXSA9IHVzZVRvZGF5UnVubmluZ1RyYW5zaXRpb24oKTtcbiAgY29uc3QgW3Rhc2ssIHNldFRhc2tdID0gdXNlU3RhdGU8RGFpbHlUYXNrU25hcHNob3QgfCBudWxsPihudWxsKTtcbiAgY29uc3Qgc3RhcnRpbmdSZWYgPSB1c2VSZWYoZmFsc2UpO1xuICBjb25zdCBbLCB0aWNrXSA9IHVzZVN0YXRlKDApO1xuICBjb25zdCBzb3VyY2VzID0gdG9kYXk/LnNvdXJjZXMgPz8gW107XG4gIGNvbnN0IGZlcm1lbnRpbmcgPSB0b2RheT8uZmVybWVudGluZyA/PyB7IGl0ZW1zOiBbXSwgd2F0Y2hpbmdJdGVtczogW10sIHRvcGljczogW10sIHBpbm5lZFNvdXJjZXM6IFtdIH07XG4gIGNvbnN0IGZlZWRTb3VyY2VzID0gc29ydEZlZWRTb3VyY2VzKHNvdXJjZXMpO1xuICBjb25zdCBwaW5uZWRTb3VyY2VJZHMgPSBuZXcgU2V0KChmZXJtZW50aW5nLnBpbm5lZFNvdXJjZXMgfHwgW10pLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpO1xuICBjb25zdCB0b2RheVBsYW4gPSB0b2RheT8ucGxhbiA/PyBudWxsO1xuICBjb25zdCBsYXRlc3RQbGFuID0gdG9kYXk/LmxhdGVzdFBsYW4gPz8gbnVsbDtcbiAgY29uc3QgcG9vbCA9IHRvZGF5Py5wb29sID8/IG51bGw7XG4gIGNvbnN0IHRvZGF5SXRlbXMgPSB0b2RheVBsYW4/Lml0ZW1zID8/IFtdO1xuICAvLyDkuLvluK3vvJpwb29sIOmdnuepuueUqCBwb29s77yb56m65pWw57uE5LiN5b6X5Y6L6L+H5pyA6L+R5pyJ5pWIIHBsYW4g5YWc5bqV77yI6LeR5om55LitL3BhcnRpYWwg5LiN5pKk5pen5qGI77yJ44CCXG4gIGNvbnN0IGRpc3BsYXlJdGVtcyA9IChwb29sICYmIHBvb2wubGVuZ3RoID4gMClcbiAgICA/IHBvb2wubWFwKHBvb2xJdGVtVG9QbGFuSXRlbSlcbiAgICA6ICh0b2RheVBsYW4gPz8gbGF0ZXN0UGxhbik/Lml0ZW1zID8/IFtdO1xuICBjb25zdCBwcmltYXJ5ID0gZGlzcGxheUl0ZW1zWzBdID8/IG51bGw7XG4gIGNvbnN0IHNzc0NvdW50ID0gdG9kYXlJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHByaW9yaXR5R3JhZGUoaXRlbS5wcmlvcml0eSkgPT09ICdTU1MnKS5sZW5ndGg7XG4gIGNvbnN0IFtzdHVkaW9BY3RpdmUsIHNldFN0dWRpb0FjdGl2ZV0gPSB1c2VTdGF0ZTxudW1iZXIgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW2RldGFpbFNvdXJjZSwgc2V0RGV0YWlsU291cmNlXSA9IHVzZVN0YXRlPFRvZGF5U291cmNlIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IFtkZXRhaWxCb2R5LCBzZXREZXRhaWxCb2R5XSA9IHVzZVN0YXRlPEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2Ygd2luZG93LndtYi5nZXRTb3VyY2VCb2R5Q2FjaGU+Pj4obnVsbCk7XG4gIGNvbnN0IFtkZXRhaWxCb2R5TG9hZGluZywgc2V0RGV0YWlsQm9keUxvYWRpbmddID0gdXNlU3RhdGUoZmFsc2UpO1xuICBjb25zdCBbZGV0YWlsQm9keUVycm9yLCBzZXREZXRhaWxCb2R5RXJyb3JdID0gdXNlU3RhdGUoJycpO1xuICBjb25zdCBvcHBzUmVmID0gdXNlUmVmPEhUTUxEaXZFbGVtZW50IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IHJhaWxSZWYgPSB1c2VSZWY8SFRNTEVsZW1lbnQgfCBudWxsPihudWxsKTtcbiAgY29uc3QgZmVlZExpc3RSZWYgPSB1c2VSZWY8SFRNTERpdkVsZW1lbnQgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW3Zpc2libGVGZWVkQ291bnQsIHNldFZpc2libGVGZWVkQ291bnRdID0gdXNlU3RhdGUoZmVlZFNvdXJjZXMubGVuZ3RoKTtcbiAgY29uc3Qgc291cmNlc0FyZVRvZGF5ID0gdG9kYXk/LnNvdXJjZXNEYXRlID09PSBwbGFuRGF0ZTtcbiAgY29uc3QgdG9kYXlTb3VyY2VzVG90YWwgPSBzb3VyY2VzQXJlVG9kYXkgPyAodG9kYXk/LnNvdXJjZXNUb3RhbCA/PyBzb3VyY2VzLmxlbmd0aCkgOiAwO1xuXG4gIGNvbnN0IHJ1blZpZXcgPSB1c2VNZW1vKCgpID0+IGRlcml2ZVRvZGF5UnVuVmlldyh7XG4gICAgdGFzayxcbiAgICBsb2NhbFN0YXJ0aW5nOiBzdGFydGluZ1JlZi5jdXJyZW50LFxuICAgIGhhc1RvZGF5UGxhbjogQm9vbGVhbih0b2RheVBsYW4pLFxuICAgIGhhc1JlY2VudFBsYW46ICF0b2RheVBsYW4gJiYgQm9vbGVhbihsYXRlc3RQbGFuKSxcbiAgICBvcHBvcnR1bml0eUNvdW50OiB0b2RheUl0ZW1zLmxlbmd0aCxcbiAgICBzc3NDb3VudCxcbiAgICBzb3VyY2VzVG90YWw6IHRvZGF5U291cmNlc1RvdGFsLFxuICAgIHN0dWRpb0FjdGl2ZSxcbiAgICBwaUNvbmZpZ3VyZWQsXG4gICAgY2hhbm5lbHNTdW1tYXJ5OiBpbnRlbGxpZ2VuY2VDaGFubmVsc1xuICB9KSwgW3Rhc2ssIHRvZGF5UGxhbiwgbGF0ZXN0UGxhbiwgdG9kYXlJdGVtcy5sZW5ndGgsIHNzc0NvdW50LCB0b2RheVNvdXJjZXNUb3RhbCwgc3R1ZGlvQWN0aXZlLCBwaUNvbmZpZ3VyZWQsIGludGVsbGlnZW5jZUNoYW5uZWxzLCBydW5uaW5nXSk7XG5cbiAgY29uc3QgZmVlZFJvd0hlaWdodHNSZWYgPSB1c2VSZWY8bnVtYmVyW10+KFtdKTtcbiAgY29uc3QgZmVlZEhlaWdodHNTaWduYXR1cmVSZWYgPSB1c2VSZWYoJycpO1xuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGNvbnN0IG9wcHMgPSBvcHBzUmVmLmN1cnJlbnQ7XG4gICAgY29uc3QgcmFpbCA9IHJhaWxSZWYuY3VycmVudDtcbiAgICBjb25zdCBmZWVkID0gZmVlZExpc3RSZWYuY3VycmVudDtcbiAgICBpZiAoIW9wcHMgfHwgIXJhaWwgfHwgIWZlZWQgfHwgdHlwZW9mIFJlc2l6ZU9ic2VydmVyID09PSAndW5kZWZpbmVkJykgcmV0dXJuO1xuICAgIGxldCBjYW5jZWxsZWQgPSBmYWxzZTtcbiAgICBsZXQgZGVib3VuY2VUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAvLyDooYzpq5jlj5blhrPkuo7lj6/nlKjlrr3luqbvvIjmoIfpopjmjaLooYzvvInkuI7mlofmnKzplb/luqbvvJvkuKTkuKrpg73ov5vnvJPlrZjplK7vvIzlkKbliJkgcmVzaXplL+aUtuaUviBQaSDmoI/lkI7nlKjml6fpq5jluqbnrpflh7rplJnor6/oo4HliarjgIJcbiAgICBjb25zdCBzaWduYXR1cmUgPSBgJHtzb3VyY2VzLm1hcCgoaXRlbSkgPT4gYCR7aXRlbS5pZH06JHtpdGVtLnRpdGxlLmxlbmd0aH1gKS5qb2luKCd8Jyl9QCR7TWF0aC5yb3VuZChmZWVkLmNsaWVudFdpZHRoKX1gO1xuXG4gICAgY29uc3QgY29tcHV0ZUZpdCA9ICh0YXJnZXRIZWlnaHQ6IG51bWJlcik6IG51bWJlciA9PiB7XG4gICAgICBjb25zdCByYWlsU3R5bGVzID0gZ2V0Q29tcHV0ZWRTdHlsZShyYWlsKTtcbiAgICAgIGNvbnN0IGdhcCA9IE51bWJlci5wYXJzZUZsb2F0KHJhaWxTdHlsZXMucm93R2FwIHx8IHJhaWxTdHlsZXMuZ2FwIHx8ICcwJykgfHwgMDtcbiAgICAgIGxldCByZXNlcnZlZCA9IDA7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5yYWlsLmNoaWxkcmVuXSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICAgIGlmIChjaGlsZCA9PT0gZmVlZCkgY29udGludWU7XG4gICAgICAgIHJlc2VydmVkICs9IE1hdGguY2VpbChjaGlsZC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQpICsgZ2FwO1xuICAgICAgfVxuICAgICAgY29uc3QgZmVlZFN0eWxlcyA9IGdldENvbXB1dGVkU3R5bGUoZmVlZCk7XG4gICAgICBjb25zdCBwYWRZID0gKE51bWJlci5wYXJzZUZsb2F0KGZlZWRTdHlsZXMucGFkZGluZ1RvcCB8fCAnMCcpIHx8IDApICsgKE51bWJlci5wYXJzZUZsb2F0KGZlZWRTdHlsZXMucGFkZGluZ0JvdHRvbSB8fCAnMCcpIHx8IDApO1xuICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgdGFyZ2V0SGVpZ2h0IC0gcmVzZXJ2ZWQgLSBwYWRZKTtcbiAgICAgIGxldCB1c2VkID0gMDtcbiAgICAgIGxldCBmaXQgPSAwO1xuICAgICAgZm9yIChjb25zdCBoZWlnaHQgb2YgZmVlZFJvd0hlaWdodHNSZWYuY3VycmVudCkge1xuICAgICAgICBjb25zdCBuZXh0ID0gdXNlZCArIGhlaWdodCArIChmaXQgPyBnYXAgOiAwKTtcbiAgICAgICAgaWYgKG5leHQgPiBhdmFpbGFibGUgKyAwLjUpIGJyZWFrO1xuICAgICAgICB1c2VkID0gbmV4dDtcbiAgICAgICAgZml0ICs9IDE7XG4gICAgICB9XG4gICAgICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oZmVlZFNvdXJjZXMubGVuZ3RoLCBmaXQgfHwgMSkpO1xuICAgIH07XG5cbiAgICBjb25zdCBzeW5jID0gKCkgPT4ge1xuICAgICAgY29uc3QgdGFyZ2V0SGVpZ2h0ID0gTWF0aC5jZWlsKG9wcHMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0KTtcbiAgICAgIGlmICh0YXJnZXRIZWlnaHQgPD0gMCkgcmV0dXJuO1xuICAgICAgcmFpbC5zdHlsZS5oZWlnaHQgPSBgJHt0YXJnZXRIZWlnaHR9cHhgO1xuICAgICAgcmFpbC5zdHlsZS5taW5IZWlnaHQgPSBgJHt0YXJnZXRIZWlnaHR9cHhgO1xuICAgICAgcmFpbC5zdHlsZS5tYXhIZWlnaHQgPSBgJHt0YXJnZXRIZWlnaHR9cHhgO1xuICAgICAgaWYgKCFmZWVkU291cmNlcy5sZW5ndGgpIHsgc2V0VmlzaWJsZUZlZWRDb3VudCgwKTsgcmV0dXJuOyB9XG4gICAgICBpZiAoZmVlZEhlaWdodHNTaWduYXR1cmVSZWYuY3VycmVudCAhPT0gc2lnbmF0dXJlKSB7XG4gICAgICAgIC8vIOaVsOaNruWPmOWMlu+8muWFqOmHj+a4suafk+S4gOasoeS7pea1i+mHj+ecn+WunuihjOmrmOW5tue8k+WtmO+8m+S5i+WQjuWPquaMiee8k+WtmOWBmue6r+eul+acr++8jOS4jeWGjeinpuWPkea4suafk+W+queOr+OAglxuICAgICAgICBzZXRWaXNpYmxlRmVlZENvdW50KGZlZWRTb3VyY2VzLmxlbmd0aCk7XG4gICAgICAgIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgICAgICAgIGlmIChjYW5jZWxsZWQpIHJldHVybjtcbiAgICAgICAgICBmZWVkUm93SGVpZ2h0c1JlZi5jdXJyZW50ID0gKFsuLi5mZWVkLnF1ZXJ5U2VsZWN0b3JBbGwoJy5mZWVkLWl0ZW0nKV0gYXMgSFRNTEVsZW1lbnRbXSlcbiAgICAgICAgICAgIC5tYXAoKHJvdykgPT4gTWF0aC5jZWlsKHJvdy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQpKTtcbiAgICAgICAgICBmZWVkSGVpZ2h0c1NpZ25hdHVyZVJlZi5jdXJyZW50ID0gc2lnbmF0dXJlO1xuICAgICAgICAgIGNvbnN0IGZpdCA9IGNvbXB1dGVGaXQodGFyZ2V0SGVpZ2h0KTtcbiAgICAgICAgICBzZXRWaXNpYmxlRmVlZENvdW50KChwcmV2KSA9PiAocHJldiA9PT0gZml0ID8gcHJldiA6IGZpdCkpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgZml0ID0gY29tcHV0ZUZpdCh0YXJnZXRIZWlnaHQpO1xuICAgICAgc2V0VmlzaWJsZUZlZWRDb3VudCgocHJldikgPT4gKHByZXYgPT09IGZpdCA/IHByZXYgOiBmaXQpKTtcbiAgICB9O1xuICAgIGNvbnN0IHJvID0gbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHtcbiAgICAgIC8vIHJlc2l6ZSDmi5bliqjkvJrov57nu63op6blj5HvvJvnrYnlrr3luqbnqLPlrprlkI7lho3mtYvph4/vvIzpgb/lhY3mi5bliqjmnJ/pl7Tlj43lpI3lhajph4/muLLmn5PjgIJcbiAgICAgIGlmIChkZWJvdW5jZVRpbWVyKSB7IGNsZWFyVGltZW91dChkZWJvdW5jZVRpbWVyKTsgZGVib3VuY2VUaW1lciA9IG51bGw7IH1cbiAgICAgIGRlYm91bmNlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgaWYgKCFjYW5jZWxsZWQpIHN5bmMoKTsgfSwgMTIwKTtcbiAgICB9KTtcbiAgICByby5vYnNlcnZlKG9wcHMpO1xuICAgIHJvLm9ic2VydmUocmFpbCk7XG4gICAgc3luYygpO1xuICAgIHJldHVybiAoKSA9PiB7IGNhbmNlbGxlZCA9IHRydWU7IGNsZWFyVGltZW91dChkZWJvdW5jZVRpbWVyID8/IHVuZGVmaW5lZCk7IHJvLmRpc2Nvbm5lY3QoKTsgfTtcbiAgfSwgW3ByaW1hcnk/LmlkLCBkaXNwbGF5SXRlbXMubGVuZ3RoLCBzb3VyY2VzLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkuam9pbignfCcpLCBydW5WaWV3LmJsb2NrZXJzLmxlbmd0aCwgdGFzaz8uc3RhdHVzLCBmZWVkU291cmNlcy5sZW5ndGhdKTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGxldCBhY3RpdmUgPSB0cnVlO1xuICAgIHZvaWQgd2luZG93LndtYi5nZXRTdHVkaW9TdW1tYXJ5KCkudGhlbigoc3VtbWFyeSkgPT4ge1xuICAgICAgaWYgKCFhY3RpdmUgfHwgIXN1bW1hcnkpIHJldHVybjtcbiAgICAgIHNldFN0dWRpb0FjdGl2ZShzdW1tYXJ5LmJ5U3RhdHVzLmlkZWEgKyBzdW1tYXJ5LmJ5U3RhdHVzLmRyYWZ0aW5nICsgc3VtbWFyeS5ieVN0YXR1cy5yZXZpZXcgKyBzdW1tYXJ5LmJ5U3RhdHVzLnJlYWR5KTtcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuICgpID0+IHsgYWN0aXZlID0gZmFsc2U7IH07XG4gIH0sIFt0b2RheVBsYW4/LmlkLCBsYXRlc3RQbGFuPy5pZCwgZGlzcGxheUl0ZW1zLmxlbmd0aF0pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKCFkZXRhaWxTb3VyY2UpIHsgc2V0RGV0YWlsQm9keShudWxsKTsgc2V0RGV0YWlsQm9keUVycm9yKCcnKTsgc2V0RGV0YWlsQm9keUxvYWRpbmcoZmFsc2UpOyByZXR1cm47IH1cbiAgICBsZXQgYWN0aXZlID0gdHJ1ZTtcbiAgICBzZXREZXRhaWxCb2R5TG9hZGluZyh0cnVlKTtcbiAgICBzZXREZXRhaWxCb2R5RXJyb3IoJycpO1xuICAgIHZvaWQgd2luZG93LndtYi5nZXRTb3VyY2VCb2R5Q2FjaGUoZGV0YWlsU291cmNlLmlkKS50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgaWYgKCFhY3RpdmUpIHJldHVybjtcbiAgICAgIHNldERldGFpbEJvZHkodmFsdWUpO1xuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgaWYgKCFhY3RpdmUpIHJldHVybjtcbiAgICAgIHNldERldGFpbEJvZHlFcnJvcihlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuICAgIH0pLmZpbmFsbHkoKCkgPT4geyBpZiAoYWN0aXZlKSBzZXREZXRhaWxCb2R5TG9hZGluZyhmYWxzZSk7IH0pO1xuICAgIHJldHVybiAoKSA9PiB7IGFjdGl2ZSA9IGZhbHNlOyB9O1xuICB9LCBbZGV0YWlsU291cmNlPy5pZF0pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgY29uc3QgbG9hZCA9ICgpID0+IHZvaWQgd2luZG93LndtYi5nZXRBZ2VudFRhc2soeyBpbnRlbnQ6ICdkYWlseV9pbnRlbGxpZ2VuY2UnLCBidXNpbmVzc0RhdGU6IHBsYW5EYXRlIH0pLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICBjb25zdCB0eXBlZCA9ICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSA/IHZhbHVlIGFzIERhaWx5VGFza1NuYXBzaG90IDogbnVsbDtcbiAgICAgIHNldFRhc2soKHByZXYpID0+IEpTT04uc3RyaW5naWZ5KHByZXYgPz8gbnVsbCkgPT09IEpTT04uc3RyaW5naWZ5KHR5cGVkID8/IG51bGwpID8gcHJldiA6IHR5cGVkKTtcbiAgICAgIGlmICghdHlwZWQpIHsgaWYgKCFzdGFydGluZ1JlZi5jdXJyZW50KSBzZXRSdW5uaW5nKGZhbHNlKTsgcmV0dXJuOyB9XG4gICAgICBjb25zdCBuZXh0UnVubmluZyA9IHR5cGVkLnN0YXR1cyA9PT0gJ3J1bm5pbmcnO1xuICAgICAgaWYgKG5leHRSdW5uaW5nKSBzdGFydGluZ1JlZi5jdXJyZW50ID0gZmFsc2U7XG4gICAgICBpZiAoIW5leHRSdW5uaW5nICYmIHN0YXJ0aW5nUmVmLmN1cnJlbnQpIHJldHVybjtcbiAgICAgIHNldFJ1bm5pbmcobmV4dFJ1bm5pbmcpO1xuICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICBsb2FkKCk7XG4gICAgY29uc3QgdW5zdWJzY3JpYmUgPSB3aW5kb3cud21iLm9uRGF0YUNoYW5nZWQoKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoZXZlbnQuc2NvcGVzLmluY2x1ZGVzKCdhZ2VudCcpIHx8IGV2ZW50LnNjb3Blcy5pbmNsdWRlcygndG9kYXknKSkgbG9hZCgpO1xuICAgIH0pO1xuICAgIGNvbnN0IHBvbGwgPSBydW5uaW5nIHx8IHN0YXJ0aW5nUmVmLmN1cnJlbnQgPyB3aW5kb3cuc2V0SW50ZXJ2YWwobG9hZCwgNV8wMDApIDogMDtcbiAgICByZXR1cm4gKCkgPT4geyB1bnN1YnNjcmliZSgpOyBpZiAocG9sbCkgd2luZG93LmNsZWFySW50ZXJ2YWwocG9sbCk7IH07XG4gIH0sIFtwbGFuRGF0ZSwgcnVubmluZ10pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKCFydW5uaW5nKSByZXR1cm47XG4gICAgY29uc3QgY2xvY2sgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdGljaygodmFsdWUpID0+IHZhbHVlICsgMSksIDEwMDApO1xuICAgIHJldHVybiAoKSA9PiB3aW5kb3cuY2xlYXJJbnRlcnZhbChjbG9jayk7XG4gIH0sIFtydW5uaW5nXSk7XG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBpZiAoIW9uU3RhdHVzQ2hhbmdlKSByZXR1cm47XG4gICAgb25TdGF0dXNDaGFuZ2UoeyB0ZXh0OiBydW5WaWV3LnN0YXR1c0xpbmUsIHJ1bm5pbmcgfSk7XG4gICAgcmV0dXJuICgpID0+IG9uU3RhdHVzQ2hhbmdlKG51bGwpO1xuICB9LCBbcnVuVmlldy5zdGF0dXNMaW5lLCBydW5uaW5nLCBvblN0YXR1c0NoYW5nZV0pO1xuXG4gIGNvbnN0IGNyZWF0ZSA9IGFzeW5jIChpdGVtOiBUb2RheVBsYW5JdGVtKSA9PiB7IGF3YWl0IHdpbmRvdy53bWIuY3JlYXRlUHJvamVjdEZyb21QbGFuSXRlbShpdGVtLmlkKTsgb3BlblN0dWRpbygpOyB9O1xuICBjb25zdCBwb29sQmFkZ2VNYXAgPSB1c2VNZW1vKCgpID0+IHtcbiAgICBjb25zdCBub3dNcyA9IERhdGUubm93KCk7XG4gICAgcmV0dXJuIG5ldyBNYXAoKHBvb2wgPz8gW10pLm1hcCgoaXRlbSkgPT4gW2l0ZW0ucGxhbkl0ZW1JZCwgcG9vbEJhZGdlcyhpdGVtLCBub3dNcywgcGxhbkRhdGUpXSkpO1xuICB9LCBbcG9vbCwgcGxhbkRhdGVdKTtcbiAgY29uc3QgZGlzbWlzc09wcG9ydHVuaXR5ID0gYXN5bmMgKHBsYW5JdGVtSWQ6IHN0cmluZykgPT4ge1xuICAgIGlmICghd2luZG93LmNvbmZpcm0oJ+WQpuaOiei/meS4quacuuS8mu+8n+Wug+S8muS7juaxoOS4reenu+mZpOS4lOS4jeWGjeWHuueOsOOAgicpKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHdpbmRvdy53bWIuZGlzbWlzc1BsYW5JdGVtKHsgcGxhbkl0ZW1JZCB9KTtcbiAgICAgIHJlZnJlc2goKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgb25TdGF0dXNDaGFuZ2U/Lih7IHRleHQ6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSwgcnVubmluZzogZmFsc2UgfSk7XG4gICAgfVxuICB9O1xuICBjb25zdCB4Q2hhbm5lbEFic2VudCA9IEJvb2xlYW4oaW50ZWxsaWdlbmNlQ2hhbm5lbHM/LnJlYWRpbmVzcz8uc29tZSgoZW50cnkpID0+IGVudHJ5Lm1vZHVsZSA9PT0gJ3hfbGlzdHMnICYmIGVudHJ5LnN0YXR1cyA9PT0gJ25lZWRzX3VzZXInKSk7XG4gIGNvbnN0IGNyZWF0ZUZyb21DYXJyeSA9IGFzeW5jIChpdGVtOiB7IG9iamVjdFR5cGU6IHN0cmluZzsgb2JqZWN0SWQ6IHN0cmluZyB9KSA9PiB7XG4gICAgaWYgKGl0ZW0ub2JqZWN0VHlwZSAhPT0gJ3BsYW5faXRlbScpIHJldHVybjtcbiAgICBhd2FpdCB3aW5kb3cud21iLmNyZWF0ZVByb2plY3RGcm9tUGxhbkl0ZW0oaXRlbS5vYmplY3RJZCk7XG4gICAgb3BlblN0dWRpbygpO1xuICB9O1xuICBjb25zdCB0b2dnbGVTZWxlY3Rpb24gPSAoaXRlbTogVG9kYXlQbGFuSXRlbSkgPT4ge1xuICAgIG9uU2VsZWN0aW9uQ2hhbmdlKHNlbGVjdGVkSXRlbXMuc29tZSgoc2VsZWN0ZWQpID0+IHNlbGVjdGVkLmlkID09PSBpdGVtLmlkKVxuICAgICAgPyBzZWxlY3RlZEl0ZW1zLmZpbHRlcigoc2VsZWN0ZWQpID0+IHNlbGVjdGVkLmlkICE9PSBpdGVtLmlkKVxuICAgICAgOiBbLi4uc2VsZWN0ZWRJdGVtcywgaXRlbV0pO1xuICB9O1xuICBjb25zdCB0b2dnbGVTb3VyY2VTZWxlY3Rpb24gPSAoc291cmNlOiBUb2RheVNvdXJjZSkgPT4ge1xuICAgIGNvbnN0IGV4aXN0cyA9IHNlbGVjdGVkU291cmNlcy5zb21lKChpdGVtKSA9PiBpdGVtLmlkID09PSBzb3VyY2UuaWQpO1xuICAgIGlmIChleGlzdHMpIHsgb25TZWxlY3RlZFNvdXJjZXNDaGFuZ2Uoc2VsZWN0ZWRTb3VyY2VzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5pZCAhPT0gc291cmNlLmlkKSk7IHJldHVybjsgfVxuICAgIGlmIChzZWxlY3RlZFNvdXJjZXMubGVuZ3RoID49IE1BWF9TRUxFQ1RFRF9TT1VSQ0VTKSByZXR1cm47XG4gICAgb25TZWxlY3RlZFNvdXJjZXNDaGFuZ2UoWy4uLnNlbGVjdGVkU291cmNlcywgeyAuLi5zb3VyY2UsIGJvZHlTdGF0dXM6ICdub25lJywgYm9keUV4Y2VycHQ6IG51bGwsIGJvZHlDaGFyczogMCB9XSk7XG4gIH07XG4gIGNvbnN0IGF0dGFjaEJvZHlUb1NlbGVjdGlvbiA9IGFzeW5jIChzb3VyY2U6IFRvZGF5U291cmNlLCBmb3JjZSA9IGZhbHNlKSA9PiB7XG4gICAgc2V0RGV0YWlsQm9keUxvYWRpbmcodHJ1ZSk7XG4gICAgc2V0RGV0YWlsQm9keUVycm9yKCcnKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYm9keSA9IGF3YWl0IHdpbmRvdy53bWIuZmV0Y2hTb3VyY2VCb2R5KHsgc291cmNlSWQ6IHNvdXJjZS5pZCwgZm9yY2UsIG1heENoYXJzOiAyMDAwMCB9KTtcbiAgICAgIHNldERldGFpbEJvZHkoYm9keSk7XG4gICAgICBjb25zdCBmaWVsZHMgPSBib2R5VG9TZWxlY3RlZEZpZWxkcyhib2R5KTtcbiAgICAgIGNvbnN0IGV4aXN0cyA9IHNlbGVjdGVkU291cmNlcy5zb21lKChpdGVtKSA9PiBpdGVtLmlkID09PSBzb3VyY2UuaWQpO1xuICAgICAgaWYgKGV4aXN0cykgb25TZWxlY3RlZFNvdXJjZXNDaGFuZ2Uoc2VsZWN0ZWRTb3VyY2VzLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gc291cmNlLmlkID8geyAuLi5pdGVtLCAuLi5zb3VyY2UsIC4uLmZpZWxkcyB9IDogaXRlbSkpO1xuICAgICAgZWxzZSBpZiAoc2VsZWN0ZWRTb3VyY2VzLmxlbmd0aCA8IE1BWF9TRUxFQ1RFRF9TT1VSQ0VTKSBvblNlbGVjdGVkU291cmNlc0NoYW5nZShbLi4uc2VsZWN0ZWRTb3VyY2VzLCB7IC4uLnNvdXJjZSwgLi4uZmllbGRzIH1dKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgc2V0RGV0YWlsQm9keUVycm9yKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHNldERldGFpbEJvZHlMb2FkaW5nKGZhbHNlKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3Qgc3RhcnRJbnRlbGxpZ2VuY2UgPSBhc3luYyAoKSA9PiB7XG4gICAgaWYgKHJ1bm5pbmcgfHwgc3RhcnRpbmdSZWYuY3VycmVudCkgcmV0dXJuO1xuICAgIGlmIChydW5WaWV3LnByaW1hcnlDdGEuY29uZmlybSAmJiAhd2luZG93LmNvbmZpcm0ocnVuVmlldy5wcmltYXJ5Q3RhLmNvbmZpcm0pKSByZXR1cm47XG4gICAgc3RhcnRpbmdSZWYuY3VycmVudCA9IHRydWU7XG4gICAgc2V0UnVubmluZyh0cnVlKTtcbiAgICBzZXRUYXNrKChwcmV2KSA9PiBwcmV2Py5zdGF0dXMgPT09ICdydW5uaW5nJyA/IHByZXYgOiB7IHN0YXR1czogJ3J1bm5pbmcnLCBwaGFzZTogJ3N0YXJ0aW5nJywgcHJvZ3Jlc3M6IHt9LCBldmVudHM6IFtdIH0pO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBidXNpbmVzc0RhdGUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7IHRpbWVab25lOiAnQXNpYS9TaGFuZ2hhaScgfSkuZm9ybWF0KG5ldyBEYXRlKCkpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgd2luZG93LndtYi5zdGFydERhaWx5SW50ZWxsaWdlbmNlKHsgYnVzaW5lc3NEYXRlIH0pIGFzIHtcbiAgICAgICAgb2s6IGJvb2xlYW47XG4gICAgICAgIGRhdGE/OiB7IHRhc2s/OiBEYWlseVRhc2tTbmFwc2hvdDsgcmV1c2VkPzogYm9vbGVhbiB9O1xuICAgICAgICBlcnJvcj86IHsgbWVzc2FnZT86IHN0cmluZyB9IHwgbnVsbDtcbiAgICAgIH07XG4gICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICBzdGFydGluZ1JlZi5jdXJyZW50ID0gZmFsc2U7XG4gICAgICAgIHNldFJ1bm5pbmcoZmFsc2UpO1xuICAgICAgICBzZXRUYXNrKHsgc3RhdHVzOiAnZmFpbGVkJywgZXJyb3JNZXNzYWdlOiByZXN1bHQuZXJyb3I/Lm1lc3NhZ2UgfHwgJ+S7iuaXpeaDheaKpeWksei0pScgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChyZXN1bHQuZGF0YT8udGFzaykge1xuICAgICAgICBzZXRUYXNrKHJlc3VsdC5kYXRhLnRhc2spO1xuICAgICAgICBzdGFydGluZ1JlZi5jdXJyZW50ID0gcmVzdWx0LmRhdGEudGFzay5zdGF0dXMgPT09ICdydW5uaW5nJyA/IGZhbHNlIDogZmFsc2U7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdGFydGluZ1JlZi5jdXJyZW50ID0gZmFsc2U7XG4gICAgICB9XG4gICAgICByZWZyZXNoKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHN0YXJ0aW5nUmVmLmN1cnJlbnQgPSBmYWxzZTtcbiAgICAgIHNldFJ1bm5pbmcoZmFsc2UpO1xuICAgICAgc2V0VGFzayh7IHN0YXR1czogJ2ZhaWxlZCcsIGVycm9yTWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiByZWZyZXNoKCksIDMwMCk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IG9uUHJpbWFyeSA9ICgpID0+IHtcbiAgICBpZiAocnVuVmlldy5wcmltYXJ5Q3RhLmtpbmQgPT09ICdvcGVuX3N0dWRpbycpIHsgb3BlblN0dWRpbygpOyByZXR1cm47IH1cbiAgICBpZiAocnVuVmlldy5wcmltYXJ5Q3RhLmtpbmQgPT09ICdub25lJykgcmV0dXJuO1xuICAgIHZvaWQgc3RhcnRJbnRlbGxpZ2VuY2UoKTtcbiAgfTtcblxuICBjb25zdCBvblNlY29uZGFyeSA9IChpZDogVG9kYXlTZWNvbmRhcnlJZCkgPT4ge1xuICAgIGlmIChpZCA9PT0gJ3ZpZXdfc291cmNlcycpIHsgc2V0U291cmNlc09wZW4odHJ1ZSk7IHJldHVybjsgfVxuICAgIGlmIChpZCA9PT0gJ3JlZnJlc2gnKSB7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG4gICAgaWYgKGlkID09PSAnb3Blbl9zdHVkaW8nKSB7IG9wZW5TdHVkaW8oKTsgcmV0dXJuOyB9XG4gICAgaWYgKGlkID09PSAncmVzdGFydCcpIHtcbiAgICAgIGlmICghd2luZG93LmNvbmZpcm0oJ+mHjeaWsOS+puWvn+S8mueUqOaWsOe7k+aenOabv+aNouS7iuaXpeaWueahiO+8jOe7p+e7re+8nycpKSByZXR1cm47XG4gICAgICB2b2lkIHN0YXJ0SW50ZWxsaWdlbmNlKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChpZCA9PT0gJ3NhdmVfcGFydGlhbCcpIHtcbiAgICAgIGlmICghdGFzaz8uaWQpIHJldHVybjtcbiAgICAgIHZvaWQgd2luZG93LndtYi5jb250cm9sRGFpbHlJbnRlbGxpZ2VuY2UoeyBpZDogdGFzay5pZCwgYWN0aW9uOiAnc2F2ZV9wYXJ0aWFsJyB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGlkID09PSAnY2FuY2VsJykge1xuICAgICAgaWYgKCF0YXNrPy5pZCkgcmV0dXJuO1xuICAgICAgaWYgKCF3aW5kb3cuY29uZmlybSgn5pyq5L+d5a2Y55qE5rig6YGT57uT5p6c5Lya5Lii5byD77yb5oOz5L+d55WZ6K+35YWI44CM5L+d5a2Y5bm25YGc5q2i44CN44CCJykpIHJldHVybjtcbiAgICAgIHZvaWQgd2luZG93LndtYi5jb250cm9sRGFpbHlJbnRlbGxpZ2VuY2UoeyBpZDogdGFzay5pZCwgYWN0aW9uOiAnY2FuY2VsJyB9KTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3Qgb25CbG9ja2VyID0gKGFjdGlvbjogVG9kYXlCbG9ja2VyQWN0aW9uKSA9PiB7XG4gICAgaWYgKGFjdGlvbiA9PT0gJ3JldHJ5JykgeyB2b2lkIHN0YXJ0SW50ZWxsaWdlbmNlKCk7IHJldHVybjsgfVxuICAgIGlmIChhY3Rpb24gPT09ICdvcGVuX3NldHRpbmdzX2Jyb3dzZXInKSB7IG9wZW5TZXR0aW5ncz8uKCdicm93c2VyJyk7IHJldHVybjsgfVxuICAgIGlmIChhY3Rpb24gPT09ICdvcGVuX3NldHRpbmdzX2NoYW5uZWxzJykgeyBvcGVuU2V0dGluZ3M/LignY2hhbm5lbHMnKTsgcmV0dXJuOyB9XG4gICAgaWYgKGFjdGlvbiA9PT0gJ29wZW5fc2V0dGluZ3NfYWknKSB7IG9wZW5TZXR0aW5ncz8uKCdhaScpOyB9XG4gIH07XG5cbiAgcmV0dXJuIDxkaXYgY2xhc3NOYW1lPVwidG9kYXktbGF5b3V0XCIgb25DbGljaz17KGV2ZW50KSA9PiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxFbGVtZW50O1xuICAgIGlmICghdGFyZ2V0LmNsb3Nlc3QoJ1tkYXRhLW9wcG9ydHVuaXR5LWNhcmRdLCBbZGF0YS1mZWVkLWl0ZW1dLCBbZGF0YS1zb3VyY2UtZGV0YWlsXSwgYnV0dG9uLCBhLCBpbnB1dCwgc2VsZWN0LCB0ZXh0YXJlYSwgbGFiZWwnKSkge1xuICAgICAgb25TZWxlY3Rpb25DaGFuZ2UoW10pO1xuICAgICAgb25TZWxlY3RlZFNvdXJjZXNDaGFuZ2UoW10pO1xuICAgIH1cbiAgfX0+XG4gICAgPHNlY3Rpb24gY2xhc3NOYW1lPVwidG9kYXktbWFpblwiPlxuICAgICAgPFRvZGF5Q29tbWFuZEJhclxuICAgICAgICB2aWV3PXtydW5WaWV3fVxuICAgICAgICB0YXNrSWQ9e3Rhc2s/LmlkfVxuICAgICAgICBwbGFuRGF0ZT17cGxhbkRhdGV9XG4gICAgICAgIG9uUHJpbWFyeT17b25QcmltYXJ5fVxuICAgICAgICBvblNlY29uZGFyeT17b25TZWNvbmRhcnl9XG4gICAgICAvPlxuICAgICAgPGRpdiBjbGFzc05hbWU9XCJ0b2RheS1ncmlkXCI+XG4gICAgICAgIDxkaXYgY2xhc3NOYW1lPVwidG9kYXktb3Bwc1wiIHJlZj17b3Bwc1JlZn0+XG4gICAgICAgICAge3ByaW1hcnkgPyA8PlxuICAgICAgICAgICAge3hDaGFubmVsQWJzZW50ID8gPGRpdiBjbGFzc05hbWU9XCJwb29sLWFic2VudC1iYW5uZXJcIiByb2xlPVwic3RhdHVzXCI+PHNwYW4+WCDmuKDpgZPnvLrluK3vvJrmnKzmrKHliKTmlq3mnKrljIXlkKsgWCDliqjmgIHjgII8L3NwYW4+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgb25DbGljaz17KCkgPT4gb3BlblNldHRpbmdzPy4oJ2Jyb3dzZXInKX0+6YeN5paw6aqM6K+B5rWP6KeI5ZmoPC9idXR0b24+PC9kaXY+IDogbnVsbH1cbiAgICAgICAgICAgIDxPcHBvcnR1bml0eSBpdGVtPXtwcmltYXJ5fSBwcmltYXJ5IHNlbGVjdGVkPXtzZWxlY3RlZEl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IHByaW1hcnkuaWQpfSBvblRvZ2dsZT17dG9nZ2xlU2VsZWN0aW9ufSBvbkNyZWF0ZT17Y3JlYXRlfSBzb3VyY2VzPXtzb3VyY2VzfSBiYWRnZXM9e3Bvb2xCYWRnZU1hcC5nZXQocHJpbWFyeS5pZCl9IG9uRGlzbWlzcz17KCkgPT4gdm9pZCBkaXNtaXNzT3Bwb3J0dW5pdHkocHJpbWFyeS5pZCl9Lz5cbiAgICAgICAgICAgIHtkaXNwbGF5SXRlbXMubGVuZ3RoID4gMSAmJiA8ZGl2IGNsYXNzTmFtZT1cIm9wcC1saXN0XCI+e2Rpc3BsYXlJdGVtcy5zbGljZSgxKS5tYXAoKGl0ZW0pID0+IDxPcHBvcnR1bml0eSBrZXk9e2l0ZW0uaWR9IGl0ZW09e2l0ZW19IHNlbGVjdGVkPXtzZWxlY3RlZEl0ZW1zLnNvbWUoKHNlbGVjdGVkKSA9PiBzZWxlY3RlZC5pZCA9PT0gaXRlbS5pZCl9IG9uVG9nZ2xlPXt0b2dnbGVTZWxlY3Rpb259IG9uQ3JlYXRlPXtjcmVhdGV9IHNvdXJjZXM9e3NvdXJjZXN9IGJhZGdlcz17cG9vbEJhZGdlTWFwLmdldChpdGVtLmlkKX0gb25EaXNtaXNzPXsoKSA9PiB2b2lkIGRpc21pc3NPcHBvcnR1bml0eShpdGVtLmlkKX0vPil9PC9kaXY+fVxuICAgICAgICAgIDwvPiA6IDxzZWN0aW9uIGNsYXNzTmFtZT1cImVtcHR5LXN0YXRlXCI+XG4gICAgICAgICAgICA8aDI+e3J1blZpZXcub3Bwb3J0dW5pdHlFbXB0eVRpdGxlfTwvaDI+XG4gICAgICAgICAgICA8cD57cnVuVmlldy5vcHBvcnR1bml0eUVtcHR5Qm9keX08L3A+XG4gICAgICAgICAgPC9zZWN0aW9uPn1cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxhc2lkZSBjbGFzc05hbWU9XCJ0b2RheS1yYWlsXCIgcmVmPXtyYWlsUmVmfT5cbiAgICAgICAgICA8VG9kYXlCbG9ja2VycyBibG9ja2Vycz17cnVuVmlldy5ibG9ja2Vyc30gb25BY3Rpb249e29uQmxvY2tlcn0gLz5cbiAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZlZWQtbGlzdFwiIHJlZj17ZmVlZExpc3RSZWZ9PlxuICAgICAgICAgICAgeyFzb3VyY2VzQXJlVG9kYXkgJiYgdG9kYXk/LnNvdXJjZXNEYXRlICYmIGZlZWRTb3VyY2VzLmxlbmd0aCA+IDAgPyA8cCBjbGFzc05hbWU9XCJmZWVkLWNvbnRleHRcIj7ku4rlpKnmmoLml6DmlrDotYTmlpnvvIzku6XkuIvkuLoge3RvZGF5LnNvdXJjZXNEYXRlfSDlhaXlupM8L3A+IDogbnVsbH1cbiAgICAgICAgICAgIHtzZWxlY3RlZFNvdXJjZXMubGVuZ3RoID4gMCAmJiA8ZGl2IGNsYXNzTmFtZT1cImZlZWQtc2VsZWN0aW9uLWJhclwiPuW3sumAiSB7c2VsZWN0ZWRTb3VyY2VzLmxlbmd0aH0ve01BWF9TRUxFQ1RFRF9TT1VSQ0VTfSDmnaHotYTmlpnov5sgUGk8L2Rpdj59XG4gICAgICAgICAgICB7ZmVlZFNvdXJjZXMuc2xpY2UoMCwgdmlzaWJsZUZlZWRDb3VudCkubWFwKChzb3VyY2UpID0+IHtcbiAgICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzZWxlY3RlZFNvdXJjZXMuc29tZSgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gc291cmNlLmlkKTtcbiAgICAgICAgICAgICAgY29uc3QgaGVhcnRiZWF0ID0gaXNIZWFydGJlYXRTb3VyY2Uoc291cmNlKTtcbiAgICAgICAgICAgICAgY29uc3QgZGlzYWJsZWQgPSAhc2VsZWN0ZWQgJiYgc2VsZWN0ZWRTb3VyY2VzLmxlbmd0aCA+PSBNQVhfU0VMRUNURURfU09VUkNFUztcbiAgICAgICAgICAgICAgcmV0dXJuIDxkaXZcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU9e2BmZWVkLWl0ZW0ke3NlbGVjdGVkID8gJyBzZWxlY3RlZCcgOiAnJ30ke2hlYXJ0YmVhdCA/ICcgaGVhcnRiZWF0JyA6ICcnfSR7cGlubmVkU291cmNlSWRzLmhhcyhzb3VyY2UuaWQpID8gJyBwaW5uZWQnIDogJyd9JHtkaXNhYmxlZCA/ICcgZGlzYWJsZWQnIDogJyd9YH1cbiAgICAgICAgICAgICAgICBkYXRhLWZlZWQtaXRlbVxuICAgICAgICAgICAgICAgIGtleT17c291cmNlLmlkfVxuICAgICAgICAgICAgICAgIHRpdGxlPXtkaXNhYmxlZCA/IGDmnIDlpJrpgInmi6kgJHtNQVhfU0VMRUNURURfU09VUkNFU30g5p2hYCA6IChzZWxlY3RlZCA/ICfngrnlh7vnqbrnmb3lpITnp7vlh7ogUGkg5LiK5LiL5paHJyA6ICfngrnlh7vnqbrnmb3lpITliqDlhaUgUGkg5LiK5LiL5paHJyl9XG4gICAgICAgICAgICAgICAgb25DbGljaz17KCkgPT4geyBpZiAoIWRpc2FibGVkKSB0b2dnbGVTb3VyY2VTZWxlY3Rpb24oc291cmNlKTsgfX1cbiAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgIDxTb3VyY2VNYXJrIGNhbm9uaWNhbFVybD17c291cmNlLmNhbm9uaWNhbFVybH0gYWlTb3VyY2VQcmVzZW50YXRpb249e2FpU291cmNlUHJlc2VudGF0aW9ufS8+XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmZWVkLW1haW5cIj5cbiAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmVlZC10aXRsZVwiIHRpdGxlPVwi5omT5byA6LWE5paZ6K+m5oOFXCIgb25DbGljaz17KGV2ZW50KSA9PiB7IGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpOyBzZXREZXRhaWxTb3VyY2Uoc291cmNlKTsgfX0+e3NvdXJjZS50aXRsZX08L2Rpdj5cbiAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmVlZC1zdWJcIiB0aXRsZT1cIuaJk+W8gOi1hOaWmeivpuaDhVwiIG9uQ2xpY2s9eyhldmVudCkgPT4geyBldmVudC5zdG9wUHJvcGFnYXRpb24oKTsgc2V0RGV0YWlsU291cmNlKHNvdXJjZSk7IH19PlxuICAgICAgICAgICAgICAgICAgICA8c3Bhbj57cGlubmVkU291cmNlSWRzLmhhcyhzb3VyY2UuaWQpID8gJ+mHjeeCuScgOiBoZWFydGJlYXQgPyAn5beh5qOA5omT5Y2hJyA6IChzb3VyY2UuY2F0ZWdvcmllc1swXSB8fCAn5YWl5bqT6LWE5paZJyl9PC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICA8c3Bhbj7Ctzwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgPHNwYW4+e2Zvcm1hdFNvdXJjZVB1Ymxpc2hlZEF0KHNvdXJjZS5wdWJsaXNoZWRBdCkgPz8gZm9ybWF0U291cmNlUHVibGlzaGVkQXQoc291cmNlLmNvbGxlY3RlZEF0KSA/PyAn5pe26Ze05pyq55+lJ308L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgIHtzZWxlY3RlZCAmJiBzZWxlY3RlZFNvdXJjZXMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gc291cmNlLmlkKT8uYm9keVN0YXR1cyA9PT0gJ3JlYWR5JyA/IDxzcGFuIGNsYXNzTmFtZT1cImZlZWQtYm9keS1waWxsXCI+5ZCr5q2j5paHPC9zcGFuPiA6IG51bGx9XG4gICAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgPC9kaXY+O1xuICAgICAgICAgICAgfSl9XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvYXNpZGU+XG4gICAgICA8L2Rpdj5cbiAgICAgIDxGZXJtZW50aW5nUmFpbCBmZXJtZW50aW5nPXtmZXJtZW50aW5nfSBjcmVhdGVGcm9tQ2Fycnk9e2NyZWF0ZUZyb21DYXJyeX0vPlxuICAgIDwvc2VjdGlvbj5cbiAgICA8YnV0dG9uIGNsYXNzTmFtZT17YGRyYXdlci1iYWNrZHJvcCR7c291cmNlc09wZW4gfHwgZGV0YWlsU291cmNlID8gJyBvcGVuJyA6ICcnfWB9IGFyaWEtbGFiZWw9XCLlhbPpl63kvqfmoI9cIiBvbkNsaWNrPXsoKSA9PiB7IHNldFNvdXJjZXNPcGVuKGZhbHNlKTsgc2V0RGV0YWlsU291cmNlKG51bGwpOyB9fS8+XG4gICAgPFNvdXJjZUxpc3Qgc291cmNlcz17c291cmNlc30gc291cmNlRGF0ZT17dG9kYXk/LnNvdXJjZXNEYXRlID8/IG51bGx9IHBsYW5EYXRlPXtwbGFuRGF0ZX0gb3Blbj17c291cmNlc09wZW59IGNsb3NlPXsoKSA9PiBzZXRTb3VyY2VzT3BlbihmYWxzZSl9IG9wZW5MaWJyYXJ5PXsoKSA9PiBvcGVuTGlicmFyeSgpfSBhaVNvdXJjZVByZXNlbnRhdGlvbj17YWlTb3VyY2VQcmVzZW50YXRpb259Lz5cbiAgICB7ZGV0YWlsU291cmNlID8gPFRvZGF5U291cmNlRGV0YWlsIGRldGFpbFNvdXJjZT17ZGV0YWlsU291cmNlfSBkZXRhaWxCb2R5PXtkZXRhaWxCb2R5fSBkZXRhaWxCb2R5TG9hZGluZz17ZGV0YWlsQm9keUxvYWRpbmd9IGRldGFpbEJvZHlFcnJvcj17ZGV0YWlsQm9keUVycm9yfSBzZWxlY3RlZFNvdXJjZXM9e3NlbGVjdGVkU291cmNlc30gb25DbG9zZT17KCkgPT4gc2V0RGV0YWlsU291cmNlKG51bGwpfSBvblRvZ2dsZVNlbGVjdGlvbj17dG9nZ2xlU291cmNlU2VsZWN0aW9ufSBvbkF0dGFjaEJvZHk9e2F0dGFjaEJvZHlUb1NlbGVjdGlvbn0gb3BlbkxpYnJhcnk9e29wZW5MaWJyYXJ5fS8+IDogbnVsbH1cbiAgPC9kaXY+O1xufVxuIl0sImZpbGUiOiJKOi9QaWdlb25ZYW5nL1dlTWVkaWFCdWRkeS9zcmMvcmVuZGVyZXIvdG9kYXktdmlldy50c3gifQ==