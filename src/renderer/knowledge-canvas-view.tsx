// WMB-5243：关系画布 → 全局 Wiki 知识网络（renderer 主控）。
// 职责：加载全局只读投影、搜索/类型/关系过滤、显示参数、邻接高亮、
// 节点单击浮卡 / 双击深链、框选即 Pi 上下文（累加 + Ctrl+Z/Ctrl+X/Esc 历史）。
// 旧创作工具台职责（新建/重命名画布、资产抽屉、手工节点/关系、变化健康模式、
// 创作简报、确认讨论按钮）已从主界面移除；旧画布 IPC 保留供主题页/MCP 兼容，本 UI 不再消费。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KnowledgeCanvasLayout } from './knowledge-canvas-layout';
import {
  accumulateBoxSelection,
  emptySelectionHistory,
  invalidateRedo,
  pushBoxSelection,
  redoSelection as redoSelectionPure,
  undoSelection as undoSelectionPure,
  type SelectionHistory,
} from './knowledge-canvas-selection';
import {
  DEFAULT_VIEWPORT,
  DISPLAY_PARAM_DEFAULTS,
  adjacencyOf,
  filterGraph,
  layoutGraph,
  loadGraphState,
  mergeProjectionPages,
  saveGraphState,
  type DisplayParams,
  type GraphFilter,
  type Positions,
  type StableGraphState,
  type Viewport,
} from './knowledge-network-interaction';
import {
  KNOWLEDGE_NETWORK_CANVAS_ID,
  KNOWLEDGE_NETWORK_DEFAULT_LIMIT,
  KNOWLEDGE_NETWORK_MAX_LIMIT,
} from '../shared/knowledge-network';
import type {
  KnowledgeNetworkNode,
  KnowledgeNetworkNodeDetail,
  KnowledgeNetworkNodeType,
  KnowledgeNetworkProjection,
  KnowledgeNetworkProjectionInput,
  KnowledgeNetworkRelation,
} from '../shared/knowledge-network';
import {
  decideDetailTarget,
  NO_FORMAL_PAGE_NOTICE,
  type CanvasDetailTarget,
} from './knowledge-network-format';
import type { KnowledgeLogEntry } from '../shared/knowledge-global-log';
import { useKnowledgeLog } from './wiki-discovery';
import {
  locateLogEntry,
  searchEmptyHint,
  searchMatchCandidates,
  type CanvasLocateDecision,
} from './knowledge-canvas-locate';

export type { CanvasDetailTarget } from './knowledge-network-format';

/** Pi 上下文使用的稳定网络标识（后端在 canvasId==='global' 分支解析正式对象）。 */
const NETWORK_REFRESH_SCOPES: readonly string[] = ['knowledge', 'topics', 'canvas', 'health'];

type NetworkApi = {
  getKnowledgeNetworkProjection?: (
    input: KnowledgeNetworkProjectionInput,
  ) => Promise<KnowledgeNetworkProjection>;
  getKnowledgeNetworkNodeDetail?: (input: {
    nodeId: string;
  }) => Promise<KnowledgeNetworkNodeDetail>;
};

/** 防御式访问：后端 preload 落地前不炸；落地后走正式通道。 */
const networkApi = (): NetworkApi =>
  (window as { wmb?: NetworkApi }).wmb ?? {};

/** 框选即 Pi 上下文（WMB-5243 选中态契约：mode 恒为 selected，从不整图回退）。 */
export type KnowledgeNetworkSelectionContext = {
  canvasId: string;
  nodeIds: string[];
  mode: 'selected';
  title: string;
};

export function KnowledgeCanvasView({
  initialCanvasId: _initialCanvasId,
  onContextChange,
  onDiscuss: _onDiscuss,
  onOpenDetail,
}: {
  initialCanvasId?: string | null;
  onContextChange: (item: KnowledgeNetworkSelectionContext | null) => void;
  /** 兼容旧签名：全局网络不再提供"和 Pi 讨论"确认按钮，Pi 上下文随框选即时同步。 */
  onDiscuss?: () => void;
  onOpenDetail?: (target: CanvasDetailTarget) => void;
}) {
  void _initialCanvasId;
  void _onDiscuss;

  const [nodes, setNodes] = useState<KnowledgeNetworkNode[]>([]);
  const [relations, setRelations] = useState<KnowledgeNetworkRelation[]>([]);
  const [filters, setFilters] = useState<
    KnowledgeNetworkProjection['filters'] | null
  >(null);
  const [totalNodes, setTotalNodes] = useState(0);
  const [totalRelations, setTotalRelations] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<SelectionHistory>(() =>
    emptySelectionHistory(),
  );
  const [cardNodeId, setCardNodeId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<KnowledgeNetworkNodeDetail | null>(
    null,
  );
  const [detailError, setDetailError] = useState(false);
  const [filter, setFilter] = useState<GraphFilter>(() => ({
    query: '',
    nodeTypes: new Set<string>(),
    relationTypes: new Set<string>(),
  }));
  const [displayParams, setDisplayParams] = useState<DisplayParams>(
    DISPLAY_PARAM_DEFAULTS,
  );
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [adjacencyFocus, setAdjacencyFocus] = useState<string | null>(null);
  const [positionOverrides, setPositionOverrides] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [packageHint, setPackageHint] = useState<{
    items: number;
    excluded: number;
    overLimit: boolean;
  } | null>(null);
  const [refreshAnnounce, setRefreshAnnounce] = useState('');
  const [initialViewportRestored, setInitialViewportRestored] = useState(false);
  const [cardJump, setCardJump] = useState<{
    label: string;
    target: CanvasDetailTarget;
  } | null>(null);
  /** 深链解析已完成且无正式页面（note/entity）：浮卡展示诚实降级按钮而非静默隐藏。 */
  const [cardNoTarget, setCardNoTarget] = useState(false);
  /** 浮卡内可观察反馈（无正式页面降级 / 降级按钮保持）；关闭卡片即清空。 */
  const [cardNotice, setCardNotice] = useState<string | null>(null);
  /** WMB-5239：画布只读轻量入口 —— 最近变化面板开合 / 诚实不可定位提示。 */
  const [logOpen, setLogOpenRaw] = useState(false);
  const [logNotice, setLogNotice] = useState<string | null>(null);
  /** 重开面板即清空上次的诚实提示（提示只在当次点击后可见）。 */
  const setLogOpen = useCallback((open: boolean) => {
    if (open) setLogNotice(null);
    setLogOpenRaw(open);
  }, []);
  /** WMB-5239：定位请求（seq 单调递增；布局据此居中视口）。 */
  const [locateRequest, setLocateRequest] = useState<{
    nodeId: string;
    seq: number;
  } | null>(null);
  /** WMB-5239：知识健康只读提示（画布不承担维护执行；数字来自维护状态 lint 投影）。 */
  const [health, setHealth] = useState<{
    openIssues: number;
    lastCompletedAt: string | null;
  } | null>(null);
  const [healthError, setHealthError] = useState(false);

  /** WMB-5239：最近变化（全局日志轻量入口；复用 wiki-discovery 数据层与订阅纪律）。 */
  const logState = useKnowledgeLog({ limit: 10 });

  const selectedRef = useRef<string[]>(selected);
  selectedRef.current = selected;
  const nodesRef = useRef<KnowledgeNetworkNode[]>(nodes);
  nodesRef.current = nodes;
  const historyRef = useRef<SelectionHistory>(history);
  historyRef.current = history;
  const positionsRef = useRef<Positions | null>(null);
  const lastUpdatedAtRef = useRef<string | null>(null);

  // ------------------------------------------------------------------
  // 投影加载（分页合并；dataChanged 静默刷新保留视口/过滤/有效框选）
  // ------------------------------------------------------------------
  const loadProjection = useCallback(async (opts: { silent?: boolean } = {}) => {
    const api = networkApi();
    if (!api.getKnowledgeNetworkProjection) {
      setError('知识网络数据通道尚未就绪');
      setLoading(false);
      return;
    }
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      // 后端每页返回同一集合级关系（端点落在分页边界两侧的正式关系不丢失）；
      // 合并节点按页顺序追加（上限 = KNOWLEDGE_NETWORK_MAX_LIMIT），关系按 id 去重。
      const pages: KnowledgeNetworkProjection[] = [];
      let page = await api.getKnowledgeNetworkProjection({
        limit: KNOWLEDGE_NETWORK_DEFAULT_LIMIT,
      });
      pages.push(page);
      let loadedNodes = page.nodes.length;
      while (
        page.hasMore &&
        loadedNodes < KNOWLEDGE_NETWORK_MAX_LIMIT &&
        page.nodes.length > 0
      ) {
        page = await api.getKnowledgeNetworkProjection({
          limit: KNOWLEDGE_NETWORK_DEFAULT_LIMIT,
          offset: loadedNodes,
        });
        pages.push(page);
        loadedNodes += page.nodes.length;
      }
      const merged = mergeProjectionPages(pages, KNOWLEDGE_NETWORK_MAX_LIMIT);
      setNodes(merged.nodes);
      setRelations(merged.relations);
      setFilters(page.filters);
      setTotalNodes(page.totalNodes);
      setTotalRelations(page.totalRelations);
      setUpdatedAt(page.updatedAt);
      if (
        lastUpdatedAtRef.current !== null &&
        page.updatedAt !== lastUpdatedAtRef.current
      ) {
        setRefreshAnnounce(
          `知识网络已同步：${new Date(page.updatedAt).toLocaleTimeString()} 的知识状态`,
        );
      }
      lastUpdatedAtRef.current = page.updatedAt;
      const alive = new Set(merged.nodes.map((node) => node.id));
      setSelected((current) => current.filter((id) => alive.has(id)));
      setCardNodeId((current) =>
        current && alive.has(current) ? current : null,
      );
    } catch {
      if (!opts.silent) setError('知识网络加载失败，请重试');
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  // WMB-5239：知识健康只读提示（getKnowledgeMaintenanceStatus 的 lint 投影；
  // 画布只呈现健康状态，绝不提供维护执行入口）。
  const loadHealth = useCallback(async () => {
    try {
      const status = await window.wmb.getKnowledgeMaintenanceStatus();
      setHealth({
        openIssues: status?.lint?.openIssues ?? 0,
        lastCompletedAt: status?.report?.completedAt ?? null,
      });
      setHealthError(false);
    } catch {
      setHealthError(true);
    }
  }, []);

  useEffect(() => {
    void loadProjection();
  }, [loadProjection]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    const refresh = () => void loadProjection({ silent: true });
    const unsubscribe = window.wmb.onDataChanged?.((event) => {
      if (event.scopes.some((scope) => NETWORK_REFRESH_SCOPES.includes(scope))) {
        refresh();
        if (event.scopes.includes('health')) void loadHealth();
      }
    });
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe?.();
      window.removeEventListener('focus', refresh);
    };
  }, [loadProjection, loadHealth]);

  // ------------------------------------------------------------------
  // UI 状态持久化（仅视口/显示参数/过滤；布局永远从零计算，无手工坐标真源）
  // ------------------------------------------------------------------
  useEffect(() => {
    const saved = loadGraphState();
    if (saved?.displayParams) setDisplayParams(saved.displayParams);
    if (saved?.filter) {
      setFilter({
        query: saved.filter.query ?? '',
        nodeTypes: new Set(saved.filter.nodeTypes),
        relationTypes: new Set(saved.filter.relationTypes),
      });
    }
    if (saved?.viewport) setViewport(saved.viewport);
    setInitialViewportRestored(true);
  }, []);

  useEffect(() => {
    const state: StableGraphState = { viewport, displayParams, filter };
    const timer = window.setTimeout(() => {
      saveGraphState(state);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [viewport, displayParams, filter]);

  // ------------------------------------------------------------------
  // Pi 上下文：框选即 Pi 当前上下文（仅 selected；空选择清空；从不整图 current_page）
  // ------------------------------------------------------------------
  const selectedKey = selected.join('|');
  useEffect(() => {
    onContextChange(
      selected.length
        ? {
            canvasId: KNOWLEDGE_NETWORK_CANVAS_ID,
            nodeIds: selected,
            mode: 'selected',
            title: '知识网络',
          }
        : null,
    );
  }, [selectedKey, onContextChange]);

  // ------------------------------------------------------------------
  // 框选历史（纯逻辑在 knowledge-canvas-selection；视图只接线）
  // ------------------------------------------------------------------
  const commitBoxSelection = useCallback((hits: readonly string[]) => {
    const current = selectedRef.current;
    const next = accumulateBoxSelection(current, hits, nodesRef.current);
    setHistory((h) => pushBoxSelection(h, current, next));
    if (next !== current) setSelected([...next]);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected([]);
  }, []);

  const applyUndo = useCallback(() => {
    const result = undoSelectionPure(historyRef.current, selectedRef.current);
    setHistory(result.history);
    setSelected([...result.next]);
  }, []);

  const applyRedo = useCallback(() => {
    const result = redoSelectionPure(historyRef.current, selectedRef.current);
    setHistory(result.history);
    setSelected([...result.next]);
  }, []);

  // ------------------------------------------------------------------
  // 搜索/过滤/邻接
  // ------------------------------------------------------------------
  const visible = useMemo(
    () =>
      filterGraph(nodes, relations, {
        query: filter.query,
        nodeTypes: filter.nodeTypes,
        relationTypes: filter.relationTypes,
      }),
    [nodes, relations, filter],
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // WMB-5239：图谱内搜索定位候选（与图谱过滤同一 query 语义；只看 query，被类型/关系
  // 过滤隐藏的命中也能定位 —— 点击时由 locateNode 清除隐藏过滤）。
  const searchMatches = useMemo(
    () => searchMatchCandidates(nodes, filter.query),
    [nodes, filter.query],
  );
  const searchEmptyText = useMemo(
    () => searchEmptyHint(filter.query, searchMatches.length),
    [filter.query, searchMatches.length],
  );

  const selectAllVisible = useCallback(() => {
    setHistory((h) => invalidateRedo(h));
    setSelected(visibleRef.current.nodes.map((node) => node.id));
  }, []);

  const toggleType = useCallback((type: KnowledgeNetworkNodeType) => {
    setFilter((current) => {
      const next = new Set(current.nodeTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { ...current, nodeTypes: next };
    });
  }, []);

  const toggleRelation = useCallback((key: string) => {
    setFilter((current) => {
      const next = new Set(current.relationTypes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...current, relationTypes: next };
    });
  }, []);

  const adjacency = useMemo(
    () =>
      adjacencyFocus
        ? adjacencyOf(visible.relations, adjacencyFocus)
        : { nodeIds: [], relationIds: [] },
    [adjacencyFocus, visible.relations],
  );

  // ------------------------------------------------------------------
  // 力导向布局（确定性种子 + 上一次位置暖启动，刷新不跳图）
  // ------------------------------------------------------------------
  const layout = useMemo(
    () =>
      layoutGraph(
        nodes,
        relations,
        displayParams,
        42,
        positionsRef.current,
      ),
    [nodes, relations, displayParams],
  );
  useEffect(() => {
    positionsRef.current = layout.positions;
  }, [layout]);

  const positions = useMemo<Positions>(
    () => ({ ...layout.positions, ...positionOverrides }),
    [layout, positionOverrides],
  );

  const handleNodeDrag = useCallback(
    (nodeId: string, point: { x: number; y: number }) => {
      setPositionOverrides((current) => ({ ...current, [nodeId]: point }));
    },
    [],
  );

  // ------------------------------------------------------------------
  // 显示参数
  // ------------------------------------------------------------------
  const setDisplayParam = useCallback(
    <K extends keyof DisplayParams>(key: K, value: number) => {
      setDisplayParams((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const resetDisplayParams = useCallback(() => {
    setDisplayParams(DISPLAY_PARAM_DEFAULTS);
  }, []);

  // ------------------------------------------------------------------
  // 知识浮卡（单击节点请求知识详情；空白关闭；相关认识可切换节点）
  // ------------------------------------------------------------------
  const openNodeCard = useCallback(async (nodeId: string) => {
    setCardNodeId(nodeId);
    setDetailError(false);
    setNodeDetail(null);
    setCardNotice(null);
    const api = networkApi();
    if (!api.getKnowledgeNetworkNodeDetail) return;
    try {
      const detail = await api.getKnowledgeNetworkNodeDetail({ nodeId });
      setNodeDetail(detail);
    } catch {
      setDetailError(true);
    }
  }, []);

  const closeNodeCard = useCallback(() => {
    setCardNodeId(null);
    setNodeDetail(null);
    setDetailError(false);
    setCardJump(null);
    setCardNoTarget(false);
    setCardNotice(null);
  }, []);

  // WMB-5239：定位既有节点 —— 清除隐藏过滤 + 邻接高亮 + 请求布局居中 + 打开本体卡。
  // 复用 WMB-5243 选中/浮卡/深链语义，不新建路由、不恢复手工关系编辑。
  const locateNode = useCallback((nodeId: string) => {
    if (!nodesRef.current.some((node) => node.id === nodeId)) return;
    if (!visibleRef.current.nodes.some((node) => node.id === nodeId)) {
      setFilter({ query: '', nodeTypes: new Set(), relationTypes: new Set() });
    }
    setAdjacencyFocus(nodeId);
    setLocateRequest((current) => ({ nodeId, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // WMB-5239：最近变化条目 → 画布定位决策分发（聚焦节点 / 本体卡 / 既有深链 / 诚实提示）。
  const onLogEntryOpen = useCallback(
    (entry: KnowledgeLogEntry) => {
      const decision: CanvasLocateDecision = locateLogEntry(
        entry,
        new Set(nodesRef.current.map((node) => node.id)),
      );
      switch (decision.kind) {
        case 'focus-node':
          setLogNotice(null);
          locateNode(decision.nodeId);
          break;
        case 'open-card':
          setLogNotice(null);
          void openNodeCard(decision.nodeId);
          break;
        case 'deep-link':
          setLogNotice(null);
          onOpenDetail?.(decision.target);
          break;
        case 'not-locatable':
          setLogNotice(decision.reason);
          break;
      }
    },
    [locateNode, openNodeCard, onOpenDetail],
  );

  const openRelatedCard = useCallback(
    (nodeId: string) => {
      void openNodeCard(nodeId);
    },
    [openNodeCard],
  );

  // ------------------------------------------------------------------
  // 深链（保留正式导航回调；topic 路由直连，object 路由走既有准确深链解析）
  // ------------------------------------------------------------------
  // 返回 null 表示「无正式导航目标」：note/entity（knowledge_object）没有独立正式页面，
  // 调用方（双击 / 跳转按钮）必须降级到本体浮卡并给出可观察反馈，不得静默 no-op。
  const resolveDetailTarget = useCallback(
    async (
      detail: KnowledgeNetworkNodeDetail,
    ): Promise<CanvasDetailTarget | null> => {
      const link = detail.deepLink;
      if (!link) return null;
      if (link.route === 'topic')
        return { type: 'topic', id: link.objectId, title: link.title };
      try {
        const payload = await window.wmb.resolveKnowledgeDeepLink({
          objectType: detail.node.objectType,
          objectId: detail.node.objectId,
        });
        const decision = decideDetailTarget(link, payload);
        return decision.kind === 'navigate' ? decision.target : null;
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!cardNodeId || !nodeDetail) {
      setCardJump(null);
      setCardNoTarget(false);
      return;
    }
    let cancelled = false;
    void resolveDetailTarget(nodeDetail).then((target) => {
      if (cancelled) return;
      if (!target) {
        setCardJump(null);
        setCardNoTarget(true);
        return;
      }
      setCardNoTarget(false);
      setCardJump({
        label:
          target.type === 'topic'
            ? '在主题中打开'
            : target.type === 'source'
              ? '在资料库中打开'
              : target.type === 'studio'
                ? '在创作中打开'
                : '打开结果',
        target,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [cardNodeId, nodeDetail, resolveDetailTarget]);

  const jumpToDetail = useCallback(() => {
    if (cardJump) {
      onOpenDetail?.(cardJump.target);
      closeNodeCard();
      return;
    }
    // 无正式页面（note/entity）：按钮不静默 —— 保留/重开本体浮卡并给出可观察反馈。
    if (cardNodeId) {
      void openNodeCard(cardNodeId);
      setCardNotice(NO_FORMAL_PAGE_NOTICE);
    }
  }, [cardJump, onOpenDetail, closeNodeCard, cardNodeId, openNodeCard]);

  const deepLinkNode = useCallback(
    async (nodeId: string) => {
      const api = networkApi();
      if (!api.getKnowledgeNetworkNodeDetail) return;
      try {
        const detail = await api.getKnowledgeNetworkNodeDetail({ nodeId });
        const target = await resolveDetailTarget(detail);
        if (target) {
          onOpenDetail?.(target);
          return;
        }
        // note/entity 无独立正式页面：诚实降级 —— 打开/保持本体浮卡并给出可观察反馈。
        void openNodeCard(nodeId);
        setCardNotice(NO_FORMAL_PAGE_NOTICE);
      } catch {
        // 深链失败不静默：同样落到本体浮卡（详情读取失败会在卡内显示可重试反馈）。
        void openNodeCard(nodeId);
        setCardNotice(NO_FORMAL_PAGE_NOTICE);
      }
    },
    [onOpenDetail, resolveDetailTarget, openNodeCard],
  );

  // ------------------------------------------------------------------
  // 冻结选择包提示（服务端按正式身份去重 + 有界；Pi 明示未纳入数量）
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!selected.length) {
      setPackageHint(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.wmb
        .previewKnowledgeContextPackage({
          canvasId: KNOWLEDGE_NETWORK_CANVAS_ID,
          nodeIds: selectedRef.current,
        })
        .then((pkg: unknown) => {
          if (cancelled) return;
          if (!pkg || typeof pkg !== 'object') {
            setPackageHint(null);
            return;
          }
          const items =
            'items' in pkg && Array.isArray(pkg.items) ? pkg.items.length : 0;
          // WMB-5243：excludedCount 由服务端全量给出（去重+无效/已消失+限长）；旧 preview 兜底用 excluded.length。
          const excluded =
            'excludedCount' in pkg && typeof pkg.excludedCount === 'number'
              ? pkg.excludedCount
              : 'excluded' in pkg && Array.isArray(pkg.excluded)
                ? pkg.excluded.length
                : 0;
          const overLimit =
            'overLimit' in pkg ? Boolean(pkg.overLimit) : false;
          setPackageHint({ items, excluded, overLimit });
        })
        .catch(() => {
          if (!cancelled) setPackageHint(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedKey]);

  const packageHintText = useMemo(() => {
    if (!packageHint) return null;
    if (packageHint.overLimit)
      return `上下文超限 · 已纳入 ${packageHint.items} 项 · 未纳入 ${packageHint.excluded} 项`;
    if (packageHint.excluded > 0)
      return `已纳入 ${packageHint.items} 项 · 未纳入 ${packageHint.excluded} 项`;
    return `已纳入 ${packageHint.items} 项`;
  }, [packageHint]);

  return (
    <KnowledgeCanvasLayout
      c={{
        nodes,
        relations,
        totalNodes,
        totalRelations,
        filters,
        updatedAt,
        loading,
        error,
        visibleNodes: visible.nodes,
        visibleRelations: visible.relations,
        positions,
        bounds: layout.bounds,
        viewport,
        setViewport,
        searchQuery: filter.query,
        setSearchQuery: (query) => setFilter((current) => ({ ...current, query })),
        activeTypes: filter.nodeTypes,
        toggleType,
        activeRelationKeys: filter.relationTypes,
        toggleRelation,
        displayParams,
        setDisplayParam,
        resetDisplayParams,
        selected,
        onBoxSelectCommit: commitBoxSelection,
        onClearSelection: clearSelection,
        canUndo: history.undoStack.length > 0,
        canRedo: history.redoStack.length > 0,
        onUndo: applyUndo,
        onRedo: applyRedo,
        onSelectAll: selectAllVisible,
        packageHint: packageHintText,
        cardNodeId,
        nodeDetail,
        detailError,
        openNodeCard,
        closeNodeCard,
        openRelatedCard,
        cardJump,
        cardNoTarget,
        cardNotice,
        onJumpDetail: jumpToDetail,
        onNodeDoubleClick: deepLinkNode,
        adjacencyFocus,
        setAdjacencyFocus,
        adjacency: {
          nodeIds: adjacency.nodeIds,
          relationIds: adjacency.relationIds,
        },
        refreshAnnounce,
        onRetry: () => void loadProjection(),
        onOpenLibrary: () => onOpenDetail?.({ type: 'source', title: '资料库' }),
        onNodeDrag: handleNodeDrag,
        initialViewportRestored,
        // WMB-5239：画布只读轻量入口（最近变化 / 知识健康 / 图谱内搜索定位）
        logOpen,
        setLogOpen,
        logNotice,
        onLogEntryOpen,
        log: logState,
        health,
        healthError,
        onRetryHealth: () => void loadHealth(),
        searchMatches,
        searchEmptyText,
        onLocateNode: locateNode,
        locateRequest,
      }}
    />
  );
}
