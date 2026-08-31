import { createRoot } from "react-dom/client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TodayPlanItem, TodaySource } from "../main/workbench";
import { LongTermStudioView } from "./studio-view";
import { KnowledgeCanvasView } from "./knowledge-canvas-view";
import { Icon, TodayView, LibraryView } from "./today-library-view";
import { LibraryTopicsView } from "./library-topics-view";
import { DiscoverView } from "./discover-view";
import { ProposalsView } from "./proposals-view";
import { LegacyStudioView } from "./legacy-studio-view";
import { PublishView } from "./publishing-results-view";
import { ResultsView } from "./results-view";
import { SettingsView } from "./settings-view";
import { OnboardingView } from "./onboarding-view";
import { AgentsRosterView } from "./agents-roster-view";
import { PiDock } from "./pi-dock";
import { XListOperationModal } from "./x-list-operation-modal";
import { AppConfirmHost } from "./app-confirm";
import { AppUpdateStatusItem } from "./app-update-banner";
import type {
  PiContextRef,
  PiFocusObject,
  RankingContext,
  Theme,
  View,
  XListPiContext,
} from "./app-types";
import { logoUrl, views, WMB_NAVIGATE_WIKI_OBJECT_EVENT } from "./app-types";
import type { TodayFermentingSelection } from "./today-view";
import type { KnowledgeDeepLinkPayload } from "../shared/knowledge-topic-library";
import { workspaceStorageKey } from "./workspace-storage";
import "./styles.css";

function normalizeView(raw: string | null): View {
  if (!raw) return "today";
  if (raw === "compose") return "canvas";
  return views.includes(raw as View) ? (raw as View) : "today";
}
function StatusClock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "Asia/Shanghai",
        hour12: false,
      }).format(now),
    [now],
  );
  return <time dateTime={now.toISOString()}>{dateLabel}</time>;
}

const MemoPiDock = memo(PiDock);

function App(): React.JSX.Element {
  const [view, setView] = useState<View>(() =>
    normalizeView(localStorage.getItem("wmb.view")),
  );
  useEffect(() => {
    const next = normalizeView(view);
    if (next !== view) setView(next);
  }, [view]);
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("wmb.theme") === "light" ? "light" : "dark",
  );
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  const [settings, setSettings] =
    useState<Awaited<ReturnType<typeof window.wmb.getSettings>>>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<Awaited<
    ReturnType<typeof window.wmb.getOnboardingStatus>
  > | null>(null);
  const [today, setToday] =
    useState<Awaited<ReturnType<typeof window.wmb.getToday>>>(null);
  const [publications, setPublications] = useState<
    Awaited<ReturnType<typeof window.wmb.getPublications>>
  >([]);
  const [browserChoice, setBrowserChoice] = useState("");
  const [piDockCollapsed, setPiDockCollapsed] = useState(
    () => localStorage.getItem("wmb.piDockCollapsed") === "true",
  );
  useEffect(() => {
    void window.wmb.getOnboardingStatus().then(setOnboardingStatus);
    void window.wmb.markRendererReady();
  }, []);
  useEffect(() => {
    const expand = () => setPiDockCollapsed(false);
    const discussStudioAnnotations = () => {
      setPiDockCollapsed(false);
      window.requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent("wmb:pi-composer-focus")),
      );
    };
    window.addEventListener("wmb:pi-dock-expand", expand);
    window.addEventListener("wmb:focus-manager-dialog", expand);
    window.addEventListener("studio-discuss-pi", discussStudioAnnotations);
    return () => {
      window.removeEventListener("wmb:pi-dock-expand", expand);
      window.removeEventListener("wmb:focus-manager-dialog", expand);
      window.removeEventListener("studio-discuss-pi", discussStudioAnnotations);
    };
  }, []);

  const [piDockWidth, setPiDockWidth] = useState(
    () => Number(localStorage.getItem("wmb.piDockWidth")) || 380,
  );
  const [todaySelectedItems, setTodaySelectedItems] = useState<TodayPlanItem[]>(
    [],
  );
  const [todaySelectedSources, setTodaySelectedSources] = useState<
    Array<
      TodaySource & {
        bodyStatus?: "none" | "ready" | "failed" | "empty";
        bodyExcerpt?: string | null;
        bodyChars?: number;
      }
    >
  >([]);
  const [proposalsSelectedItem, setProposalsSelectedItem] =
    useState<TodayPlanItem | null>(null);
  const [fermentSelectedItem, setFermentSelectedItem] =
    useState<TodayFermentingSelection | null>(null);
  const [rankingContext, setRankingContext] = useState<RankingContext>({
    boards: [],
    items: [],
  });
  const [xListContext, setXListContext] = useState<XListPiContext | null>(null);
  const [canvasOpenId, setCanvasOpenId] = useState<string | null>(null);
  const [canvasContext, setCanvasContext] = useState<{
    canvasId: string;
    nodeIds: string[];
    mode: "selected";
    title: string;
  } | null>(null);
  const [studioSelectedId, setStudioSelectedId] = useState<string | null>(null);
  const [studioContext, setStudioContext] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [libraryTopicContext, setLibraryTopicContext] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [pageFocus, setPageFocus] = useState<PiFocusObject | null>(null);
  const [publishSelectedId, setPublishSelectedId] = useState<string | null>(
    null,
  );
  const [piPhase, setPiPhase] = useState<
    "idle" | "starting" | "running" | "failed" | "stopped"
  >("idle");
  const [piStatusText, setPiStatusText] = useState("Pi 空闲");
  const [pageStatus, setPageStatus] = useState<{
    text: string;
    running?: boolean;
  } | null>(null);
  const workspaceId = settings?.workspace.id ?? null;
  const skipStudioPersist = useRef(false);
  const planDate = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
        new Date(),
      ),
    [],
  );
  const todaySigRef = useRef("");
  const publicationsSigRef = useRef("");
  const refreshSettings = useCallback(
    () =>
      void window.wmb.getSettings().then((value) => {
        setSettings(value);
        setBrowserChoice(value?.boundBrowserProfile?.id ?? "");
      }),
    [],
  );
  const refreshToday = useCallback(
    () =>
      void window.wmb.getToday(planDate).then((value) => {
        const nextSig = JSON.stringify(value ?? null);
        if (nextSig === todaySigRef.current) return;
        todaySigRef.current = nextSig;
        setToday(value);
      }),
    [planDate],
  );
  const refreshPublications = useCallback(
    () =>
      void window.wmb.getPublications().then((value) => {
        const nextSig = JSON.stringify(value ?? []);
        if (nextSig === publicationsSigRef.current) return;
        publicationsSigRef.current = nextSig;
        setPublications(value);
      }),
    [],
  );
  useEffect(() => {
    void window.wmb
      .getDataRoot()
      .then((root) => setDataRoot(root?.path ?? null));
    refreshSettings();
    refreshToday();
    refreshPublications();
  }, [refreshSettings, refreshToday, refreshPublications]);
  useEffect(() => {
    // Event-driven refresh. Keep a slow safety net only while the window is visible.
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes("today") || event.scopes.includes("agent"))
        refreshToday();
      if (event.scopes.includes("publications")) refreshPublications();
      if (event.scopes.includes("sources")) refreshSettings();
    });
    const safety = window.setInterval(() => {
      if (document.hidden) return;
      // Rare catch-up for writes that forgot to emit. Not the primary path.
      refreshToday();
      refreshPublications();
    }, 120_000);
    const onVisible = () => {
      if (document.hidden) return;
      refreshToday();
      refreshPublications();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      window.clearInterval(safety);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSettings, refreshToday, refreshPublications]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("wmb.theme", theme);
  }, [theme]);
  useEffect(() => localStorage.setItem("wmb.view", view), [view]);
  useEffect(() => {
    if (!workspaceId) return;
    skipStudioPersist.current = true;
    setStudioSelectedId(
      localStorage.getItem(
        workspaceStorageKey(workspaceId, "studioSelectedId"),
      ),
    );
    setRankingContext({ boards: [], items: [] });
    setXListContext(null);
    setCanvasOpenId(null);
    setLibraryTopicContext(null);
    setPageFocus(null);
    setPublishSelectedId(null);
    setProposalsSelectedItem(null);
  }, [workspaceId]);
  useEffect(() => {
    setPageFocus(null);
    setProposalsSelectedItem(null);
    setFermentSelectedItem(null);
  }, [view]);
  useEffect(() => {
    if (view !== "discover" && view !== "today") setPageStatus(null);
  }, [view]);
  useEffect(() => {
    localStorage.removeItem("wmb.creativeContext");
  }, []);
  useEffect(() => {
    localStorage.setItem("wmb.piDockCollapsed", String(piDockCollapsed));
  }, [piDockCollapsed]);
  useEffect(() => {
    if (!workspaceId || skipStudioPersist.current) {
      skipStudioPersist.current = false;
      return;
    }
    const key = workspaceStorageKey(workspaceId, "studioSelectedId");
    if (studioSelectedId) localStorage.setItem(key, studioSelectedId);
    else localStorage.removeItem(key);
  }, [studioSelectedId, workspaceId]);
  const resizePiDock = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const move = (pointer: PointerEvent) =>
        setPiDockWidth(
          Math.max(300, Math.min(640, window.innerWidth - pointer.clientX)),
        );
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        document.body.classList.remove("resizing-pi");
      };
      document.body.classList.add("resizing-pi");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    },
    [],
  );
  const togglePiDock = useCallback(
    () => setPiDockCollapsed((value) => !value),
    [],
  );
  const resetPiDockWidth = useCallback(() => setPiDockWidth(380), []);
  useEffect(() => {
    localStorage.setItem("wmb.piDockWidth", String(piDockWidth));
  }, [piDockWidth]);
  useEffect(() => {
    if (!settings?.pi?.configured) {
      setPiPhase("idle");
      setPiStatusText("Pi 未配置");
      return;
    }
    setPiStatusText((current) => (piPhase === "idle" ? "Pi 空闲" : current));
    return window.wmb.onPiEvent((event) => {
      if (event.type === "starting") {
        setPiPhase("starting");
        setPiStatusText("Pi 正在启动");
        return;
      }
      if (event.type === "running" || event.type === "delta") {
        setPiPhase("running");
        setPiStatusText("Pi 调用中");
        return;
      }
      if (event.type === "stopped") {
        setPiPhase("stopped");
        setPiStatusText("Pi 已停止");
        return;
      }
      if (event.type === "failed") {
        setPiPhase("failed");
        setPiStatusText(
          event.error ? `Pi 失败：${event.error}` : "Pi 调用失败",
        );
        return;
      }
      if (event.type === "idle" || event.type === "agent_task") {
        setPiPhase("idle");
        setPiStatusText(settings?.pi?.configured ? "Pi 空闲" : "Pi 未配置");
      }
    });
  }, [settings?.pi?.configured]);
  const navigate = (next: View) => {
    setView(next);
    if (next === "publish" || next === "results") refreshPublications();
  };
  // B:每个视图记住自己的滚动位置,切回时恢复
  const scrollMemory = useRef<Record<string, number>>({});
  const findScroller = (workspace: Element): HTMLElement | null => {
    const candidates = [
      workspace as HTMLElement,
      ...workspace.querySelectorAll<HTMLElement>("*"),
    ];
    return (
      candidates.find(
        (el) =>
          el.scrollHeight > el.clientHeight + 4 &&
          /auto|scroll/.test(getComputedStyle(el).overflowY),
      ) ?? null
    );
  };
  useEffect(() => {
    const workspace = document.querySelector(".workspace");
    if (!workspace) return;
    const save = () => {
      const scroller = findScroller(workspace);
      if (scroller) scrollMemory.current[view] = scroller.scrollTop;
    };
    workspace.addEventListener("scroll", save, {
      capture: true,
      passive: true,
    });
    return () =>
      workspace.removeEventListener("scroll", save, { capture: true });
  }, [view]);
  useEffect(() => {
    const workspace = document.querySelector(".workspace");
    if (!workspace) return;
    const frame = requestAnimationFrame(() => {
      const saved = scrollMemory.current[view] ?? 0;
      const scroller = findScroller(workspace);
      if (scroller && saved > 0) scroller.scrollTop = saved;
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  useEffect(() => {
    if (view !== "discover") setXListContext(null);
  }, [view]);
  useEffect(() => {
    if (view !== "topic") setLibraryTopicContext(null);
  }, [view]);
  const openTopic = (topicId: string) => {
    if (workspaceId)
      localStorage.setItem(
        workspaceStorageKey(workspaceId, "libraryTopicId"),
        topicId,
      );
    navigate("topic");
    window.dispatchEvent(
      new CustomEvent("wmb-open-library-topic", { detail: { topicId } }),
    );
  };
  useEffect(() => {
    // WMB-5239：跨页深链统一导航（wiki-discovery 组件派发 CustomEvent，detail.payload=KnowledgeDeepLinkPayload）。
    // topic→openTopic(payload.objectId)（objectId=主题 ID；targetId 可能是 Wiki 页 ID，不能用于主题定位）；
    // source→写 libraryFocusSourceId+navigate('library')；knowledge_object→知识网络（画布本体卡降级）。
    // 非法/缺字段载荷 fail-closed 忽略（不导航、不抛错）；不新增顶层路由/View。
    const onNavigateWikiObject = (event: Event) => {
      const detail = (
        event as CustomEvent<{ payload?: KnowledgeDeepLinkPayload }>
      ).detail;
      const payload = detail?.payload;
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.targetType !== "string"
      )
        return;
      if (payload.targetType === "topic_wiki" && payload.objectId) {
        openTopic(payload.objectId);
      } else if (payload.targetType === "source" && payload.objectId) {
        if (workspaceId)
          localStorage.setItem(
            workspaceStorageKey(workspaceId, "libraryFocusSourceId"),
            payload.objectId,
          );
        navigate("library");
      } else if (payload.targetType === "knowledge_object") {
        navigate("canvas");
      }
    };
    window.addEventListener(
      WMB_NAVIGATE_WIKI_OBJECT_EVENT,
      onNavigateWikiObject,
    );
    return () =>
      window.removeEventListener(
        WMB_NAVIGATE_WIKI_OBJECT_EVENT,
        onNavigateWikiObject,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  const openStudio = (projectId?: string | null) => {
    if (projectId) setStudioSelectedId(projectId);
    navigate("studio");
  };
  const nav = [
    { id: "today", label: "今日" },
    { id: "agents", label: "智能体" },
    { id: "discover", label: "发现" },
    { id: "proposals", label: "选题" },
    { id: "studio", label: "创作" },
    { id: "publish", label: "发布" },
    { id: "results", label: "结果" },
  ] as const;
  const pageLabels: Record<View, string> = {
    today: "今日内容",
    agents: "智能体班组",
    discover: "发现",
    proposals: "选题台账",
    topic: "主题",
    library: "资料库",
    canvas: "知识网络",
    studio: "创作",
    publish: "发布",
    results: "结果",
    settings: "设置",
  };
  const publishSelected =
    publications.find((item) => item.publication.id === publishSelectedId) ??
    publications[0] ??
    null;
  const piContext: PiContextRef = useMemo(() => {
    if (view === "today") {
      const first = todaySelectedItems[0] ?? null;
      const firstSource = todaySelectedSources[0] ?? null;
      const fermenting = today?.fermenting ?? {
        items: [],
        watchingItems: [],
        topics: [],
        pinnedSources: [],
      };
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType:
          pageFocus?.type ??
          (first
            ? "plan_item"
            : firstSource
              ? "source"
              : fermenting.items[0]
                ? "fermenting"
                : null),
        objectId:
          pageFocus?.id ??
          first?.id ??
          firstSource?.id ??
          fermenting.items[0]?.id ??
          null,
        objectTitle:
          pageFocus?.title ??
          first?.title ??
          firstSource?.title ??
          fermenting.items[0]?.title ??
          null,
        focus: pageFocus,
        selectedItems: todaySelectedItems,
        selectedSources: todaySelectedSources,
        fermenting,
      };
    }
    if (view === "discover") {
      if (xListContext) {
        const post = xListContext.selectedPost;
        const postTitle = post
          ? (post.text || "").trim().slice(0, 48) ||
            post.authorHandle ||
            post.url
          : null;
        return {
          page: view,
          pageLabel: "发现 · X Lists",
          objectType:
            xListContext.mode === "post"
              ? "x_list_post"
              : xListContext.listId
                ? "x_list"
                : null,
          objectId:
            xListContext.mode === "post"
              ? (post?.url ?? null)
              : xListContext.listId,
          objectTitle:
            xListContext.mode === "post"
              ? postTitle
              : (xListContext.listName ?? null),
          xListContext,
        };
      }
      const firstRankingItem = rankingContext.items[0] ?? null;
      const firstRankingBoard = rankingContext.boards[0] ?? null;
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: firstRankingItem
          ? "ranking_item"
          : firstRankingBoard
            ? "ranking_board"
            : null,
        objectId: firstRankingItem
          ? `${firstRankingItem.boardId}:${firstRankingItem.name}`
          : (firstRankingBoard?.id ?? null),
        objectTitle: firstRankingItem?.name ?? firstRankingBoard?.label ?? null,
        rankingContext,
      };
    }
    if (view === "proposals") {
      const item = proposalsSelectedItem;
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: item ? "plan_item" : null,
        objectId: item?.id ?? null,
        objectTitle: item?.title ?? null,
        selectedItems: item ? [item] : [],
      };
    }
    if (view === "topic") {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: libraryTopicContext ? "topic" : null,
        objectId: libraryTopicContext?.id ?? null,
        objectTitle: libraryTopicContext?.title ?? null,
        focus: pageFocus,
      };
    }
    if (view === "library") {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: pageFocus?.type ?? null,
        objectId: pageFocus?.id ?? null,
        objectTitle: pageFocus?.title ?? null,
        focus: pageFocus,
      };
    }
    if (view === "canvas") {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: "canvas",
        objectId: canvasContext?.canvasId ?? null,
        objectTitle: canvasContext?.title ?? null,
        packagePurpose: "discussion",
        canvasId: canvasContext?.canvasId,
        contextSelection: canvasContext ?? undefined,
      };
    }
    if (view === "studio") {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: pageFocus?.type ?? (studioContext ? "project" : null),
        objectId: pageFocus?.id ?? studioContext?.id ?? null,
        objectTitle: pageFocus?.title ?? studioContext?.title ?? null,
        focus: pageFocus,
      };
    }
    if (view === "publish") {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: publishSelected ? "publication" : null,
        objectId: publishSelected?.publication.id ?? null,
        objectTitle:
          publishSelected?.payload?.title ||
          publishSelected?.payload?.body.slice(0, 42) ||
          publishSelected?.publication.id ||
          null,
        focus: publishSelected
          ? {
              type: "publication",
              id: publishSelected.publication.id,
              title:
                publishSelected.payload?.title ||
                publishSelected.payload?.body.slice(0, 42) ||
                publishSelected.publication.id,
              summary: `${publishSelected.publication.platform} · ${publishSelected.publication.status}`,
              meta: {
                platform: publishSelected.publication.platform,
                status: publishSelected.publication.status,
                projectId: publishSelected.publication.projectId,
                accountKey: publishSelected.publication.accountKey,
                operationState: publishSelected.operation?.state ?? null,
              },
            }
          : null,
      };
    }
    if (view === "results") {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: pageFocus?.type ?? null,
        objectId: pageFocus?.id ?? null,
        objectTitle: pageFocus?.title ?? null,
        focus: pageFocus,
      };
    }
    return {
      page: view,
      pageLabel: pageLabels[view],
      objectType: null,
      objectId: null,
      objectTitle: null,
      focus: pageFocus,
    };
  }, [
    view,
    todaySelectedItems,
    todaySelectedSources,
    today?.fermenting,
    fermentSelectedItem,
    proposalsSelectedItem,
    xListContext,
    rankingContext,
    libraryTopicContext,
    pageFocus,
    canvasContext,
    studioContext,
    publishSelected,
    publications,
  ]);
  if (!onboardingStatus)
    return (
      <main className="onboarding-shell onboarding-loading">
        <div className="onboarding-card">
          <span className="eyebrow">STARTING</span>
          <h2>正在准备本地工作空间…</h2>
        </div>
      </main>
    );
  if (!onboardingStatus.completed)
    return (
      <OnboardingView
        initialStatus={onboardingStatus}
        onComplete={() => {
          void window.wmb.getOnboardingStatus().then(setOnboardingStatus);
          void window.wmb
            .getDataRoot()
            .then((root) => setDataRoot(root?.path ?? null));
          refreshSettings();
          refreshToday();
          refreshPublications();
        }}
      />
    );
  return (
    <main
      className={`app-shell${piDockCollapsed ? " pi-collapsed" : " pi-open"}${view === "settings" ? " settings-mode" : ""}${view === "studio" ? " studio-mode" : ""}${view === "topic" ? " topic-mode" : ""}`}
      style={{ "--pi-open-width": `${piDockWidth}px` } as React.CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          <img src={logoUrl} alt="" />
          <strong>WeMediaBuddy</strong>
          {settings?.workspace && (
            <small title={settings.workspace.dataRoot.path}>
              {settings.workspace.displayName}
            </small>
          )}
        </div>
        {view === "settings" && <span className="topbar-page-title">设置</span>}
        <div className="titlebar-actions">
          <button
            aria-label="最小化窗口"
            onClick={() => void window.wmb.windowControl("minimize")}
          >
            −
          </button>
          <button
            aria-label="最大化或还原窗口"
            onClick={() => void window.wmb.windowControl("maximize")}
          >
            □
          </button>
          <button
            className="window-close"
            aria-label="关闭窗口"
            onClick={() => void window.wmb.windowControl("close")}
          >
            ×
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <div>
          <nav aria-label="工作流">
            <div className="nav-group-label">工作流</div>
            <button
              className={view === "today" ? "active" : ""}
              onClick={() => navigate("today")}
              title="今日"
            >
              <Icon name="today" />
              <span>今日</span>
            </button>
            {nav.slice(1).map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => navigate(item.id)}
                title={item.label}
              >
                <Icon name={item.id} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <nav aria-label="知识资产">
            <div className="nav-group-label">知识资产</div>
            <button
              className={view === "topic" ? "active" : ""}
              onClick={() => navigate("topic")}
              title="主题"
            >
              <Icon name="knowledge" />
              <span>主题</span>
            </button>
            <button
              className={view === "library" ? "active" : ""}
              onClick={() => navigate("library")}
              title="资料库"
            >
              <Icon name="library" />
              <span>资料库</span>
            </button>
            <button
              className={view === "canvas" ? "active" : ""}
              onClick={() => navigate("canvas")}
              title="关系画布"
            >
              <Icon name="canvas" />
              <span>关系画布</span>
            </button>
          </nav>
        </div>
        <nav className="sidebar-bottom">
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => navigate("settings")}
            title="设置"
          >
            <Icon name="settings" />
            <span>设置</span>
          </button>
        </nav>
      </aside>
      <section className="workspace">
        {view === "today" && (
          <TodayView
            today={today}
            refresh={refreshToday}
            openStudio={openStudio}
            openTopic={openTopic}
            openProposals={() => navigate("proposals")}
            openResults={() => {
              sessionStorage.setItem("wmb.resultsRange", "7d");
              navigate("results");
            }}
            openLibrary={(sourceId) => {
              if (sourceId && workspaceId)
                localStorage.setItem(
                  workspaceStorageKey(workspaceId, "libraryFocusSourceId"),
                  sourceId,
                );
              navigate("library");
            }}
            openSettings={(section) => {
              if (section)
                sessionStorage.setItem("wmb.settingsSection", section);
              navigate("settings");
            }}
            selectedItems={todaySelectedItems}
            onSelectionChange={setTodaySelectedItems}
            selectedSources={todaySelectedSources}
            onSelectedSourcesChange={setTodaySelectedSources}
            fermentSelectedItem={fermentSelectedItem}
            onFermentSelectedItemChange={setFermentSelectedItem}
            planDate={planDate}
            onStatusChange={setPageStatus}
            onFocusChange={setPageFocus}
            aiSourcePresentation={
              settings?.workspace.capabilities.sourceWire === true
            }
            intelligenceChannels={
              settings?.workspace.intelligenceChannels ?? null
            }
            piConfigured={settings?.pi.configured ?? false}
          />
        )}
        {view === "agents" && (
          <AgentsRosterView
            onOpenSettings={() => {
              sessionStorage.setItem("wmb.settingsSection", "agent");
              navigate("settings");
            }}
          />
        )}
        {view === "discover" && (
          <DiscoverView
            key={workspaceId ?? "discover-loading"}
            workspace={settings?.workspace ?? null}
            workspaceId={workspaceId}
            rankingContext={rankingContext}
            onRankingContextChange={setRankingContext}
            onStatusChange={setPageStatus}
            onXListContextChange={setXListContext}
          />
        )}
        {view === "proposals" && (
          <ProposalsView
            planDate={planDate}
            openStudio={openStudio}
            openTopic={openTopic}
            onOpenProject={(projectId) => {
              setStudioSelectedId(projectId);
              navigate("studio");
            }}
            openToday={() => navigate("today")}
            selectedItem={proposalsSelectedItem}
            onSelectedItemChange={setProposalsSelectedItem}
          />
        )}
        {view === "topic" && (
          <LibraryTopicsView
            key={workspaceId ?? "topics-loading"}
            workspaceId={workspaceId}
            initialTopicId={
              workspaceId
                ? localStorage.getItem(
                    workspaceStorageKey(workspaceId, "libraryTopicId"),
                  )
                : null
            }
            onTopicContextChange={setLibraryTopicContext}
            onOpenStudio={(id) => {
              setStudioSelectedId(id);
              navigate("studio");
            }}
            onGoStudio={() => navigate("studio")}
            onOpenCanvas={(canvasId) => {
              if (canvasId) setCanvasOpenId(canvasId);
              navigate("canvas");
            }}
            onOpenPi={() => setPiDockCollapsed(false)}
            piConfigured={settings?.pi.configured ?? false}
            aiSourcePresentation={
              settings?.workspace.capabilities.sourceWire === true
            }
          />
        )}
        {view === "library" && workspaceId && (
          <LibraryView
            key={workspaceId}
            onOpenTopic={(topicId) => openTopic(topicId)}
            onOpenStudio={(id) => {
              setStudioSelectedId(id);
              navigate("studio");
            }}
            onOpenCanvas={(canvasId) => {
              if (canvasId) setCanvasOpenId(canvasId);
              navigate("canvas");
            }}
            focusSourceId={localStorage.getItem(
              workspaceStorageKey(workspaceId, "libraryFocusSourceId"),
            )}
            onFocusSourceConsumed={() =>
              localStorage.removeItem(
                workspaceStorageKey(workspaceId, "libraryFocusSourceId"),
              )
            }
            onFocusChange={setPageFocus}
            aiSourcePresentation={
              settings?.workspace.capabilities.sourceWire === true
            }
            sectionStorageKey={workspaceStorageKey(
              workspaceId,
              "librarySection",
            )}
          />
        )}
        {view === "canvas" && (
          <KnowledgeCanvasView
            key={workspaceId ?? "canvas-loading"}
            initialCanvasId={canvasOpenId}
            onContextChange={setCanvasContext}
            onDiscuss={() => setPiDockCollapsed(false)}
            onOpenDetail={(target) => {
              if (target.type === "topic" && target.id) openTopic(target.id);
              else if (target.type === "source" && target.id) {
                if (workspaceId)
                  localStorage.setItem(
                    workspaceStorageKey(workspaceId, "libraryFocusSourceId"),
                    target.id,
                  );
                navigate("library");
              } else if (target.type === "source" && !target.id)
                navigate("library");
              else if (target.type === "studio" && target.id) {
                setStudioSelectedId(target.id);
                navigate("studio");
              } else if (target.type === "results") navigate("results");
            }}
          />
        )}

        {view === "studio" && (
          <LongTermStudioView
            openPublish={() => navigate("publish")}
            selectedId={studioSelectedId}
            onSelect={setStudioSelectedId}
            onContext={setStudioContext}
            onFocusChange={setPageFocus}
            onOpenSource={(sourceId) => {
              if (workspaceId)
                localStorage.setItem(
                  workspaceStorageKey(workspaceId, "libraryFocusSourceId"),
                  sourceId,
                );
              navigate("library");
            }}
            planDate={planDate}
            enabledPlatforms={
              settings?.workspace.capabilities.publishingPlatforms ?? []
            }
            aiSourcePresentation={
              settings?.workspace.capabilities.sourceWire === true
            }
          />
        )}
        {view === "publish" && (
          <PublishView
            publications={publications}
            refresh={refreshPublications}
            openStudio={openStudio}
            onEditProject={(projectId) => {
              setStudioSelectedId(projectId);
              navigate("studio");
            }}
            takeover={() => navigate("settings")}
            selectedId={publishSelectedId}
            onSelect={setPublishSelectedId}
            settings={settings}
            enabledPlatforms={
              settings?.workspace.capabilities.publishingPlatforms ?? []
            }
          />
        )}
        {view === "results" && (
          <ResultsView
            publications={publications}
            refresh={refreshPublications}
            planDate={planDate}
            enabledPlatforms={
              settings?.workspace.capabilities.publishingPlatforms ?? []
            }
            onFocusChange={setPageFocus}
            openStudio={openStudio}
          />
        )}
        {view === "settings" && (
          <SettingsView
            dataRoot={dataRoot}
            settings={settings}
            browserChoice={browserChoice}
            setBrowserChoice={setBrowserChoice}
            refresh={refreshSettings}
            theme={theme}
            setTheme={setTheme}
            back={() => navigate("today")}
          />
        )}
      </section>
      {view !== "settings" && (
        <MemoPiDock
          collapsed={piDockCollapsed}
          toggle={togglePiDock}
          configured={settings?.pi.configured ?? false}
          context={piContext}
          resize={resizePiDock}
          resetWidth={resetPiDockWidth}
        />
      )}
      <footer className="status-bar">
        <div className="status-bar-left">
          <span className="status-item" data-phase={piPhase}>
            <span className="status-dot" />
            {piStatusText}
          </span>
          {settings?.workspace && (
            <span
              className="status-item"
              title={settings.workspace.dataRoot.path}
            >
              <span className="status-dot ok" />
              {settings.workspace.displayName} ·{" "}
              {settings.workspace.profile.profileId}
            </span>
          )}
          <span className="status-item">
            <span
              className={`status-dot ${settings?.mcp?.status === "ready" ? "ok" : "idle"}`}
            />
            {settings?.mcp?.status === "ready"
              ? "AI 接入已就绪"
              : "AI 接入未启动"}
          </span>
          <span className="status-item">
            <span
              className={`status-dot ${settings?.browser?.status === "ready" ? "ok" : "idle"}`}
            />
            {settings?.browser?.status === "ready"
              ? "浏览器已连接"
              : "浏览器未启动"}
          </span>
          {pageStatus?.text && (
            <span
              className="status-item status-page"
              data-running={pageStatus.running ? "true" : "false"}
              title={pageStatus.text}
            >
              <span
                className={`status-dot ${pageStatus.running ? "ok" : "idle"}`}
              />
              {pageStatus.text}
            </span>
          )}
          <XListOperationModal />
          <AppUpdateStatusItem openSettings={() => navigate("settings")} />
        </div>
        <div className="status-bar-right">
          <button
            type="button"
            className="status-theme"
            title={theme === "dark" ? "切换到白昼紫罗兰" : "切换到黑夜紫罗兰"}
            aria-label={
              theme === "dark" ? "切换到白昼紫罗兰" : "切换到黑夜紫罗兰"
            }
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☾" : "☀"}{" "}
            <span>{theme === "dark" ? "黑夜紫罗兰" : "白昼紫罗兰"}</span>
          </button>
          <StatusClock />
        </div>
      </footer>
      <AppConfirmHost />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
