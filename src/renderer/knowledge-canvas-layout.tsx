// WMB-5243：全局 Wiki 知识网络布局（呈现 + 图谱交互；数据/状态来自 KnowledgeCanvasView）。
// 交互按 Obsidian Graph View 基线：滚轮缩放、拖拽平移（中键 / 空格+左键）、
// 节点拖动（会话级位置覆盖，不落真源）、左键拖框 = 框选（即 Pi 上下文）、
// 单击节点浮卡、双击深链、空白点击关闭卡片、邻接高亮、搜索/过滤/显示参数容器。
// WMB-5255：控制面板收敛为板面左上覆盖层（面板背景 pointer-events 透传，交互控件各自
// stopPropagation；WMB-5257 起默认折叠，无 matchMedia 响应式自动展开）；节点渲染为
// 度数缩放圆点（--kn-node-weight 由 TSX 钳制注入）+ 按需揭示的纯文本标签：默认
// dot-only（所有 zoom 级别），仅精确 悬停/键盘聚焦/选中/邻接焦点/搜索命中 揭示；
// 无 zoom 阈值、无高度数/邻接批量标签路径，标签绝对定位不改布局、不拦指针；
// 图计数与最近变化/知识健康收敛为板面右上工具条覆盖层。
// WMB-5257：克制 2.5D 深度 —— 节点为 foundation-token 径向球面材质（度数派生有界深度
// --kn-node-depth，阴影/高光有界，无无限动画）；指针环境光与网格视差只经 ref + 单
// rAF 写板面 CSS 变量（--kn-pointer-x/y、--kn-grid-dx/dy），绝不进 React state；
// prefers-reduced-motion 下保持中性静态；.kn-world 只做视口 translate/scale，不倾斜旋转。
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KnowledgeNetworkFilterEntry,
  KnowledgeNetworkNode,
  KnowledgeNetworkNodeDetail,
  KnowledgeNetworkNodeType,
  KnowledgeNetworkRelation,
} from '../shared/knowledge-network';
import { KNOWLEDGE_NETWORK_NODE_TYPE_LABELS } from '../shared/knowledge-network';
import { KnowledgeNetworkCard, type KnowledgeCardAnchor } from './knowledge-network-card';
import {
  boxSelectHits,
  clampZoom,
  fitToBounds,
  zoomAt,
  type DisplayParams,
  type Positions,
  type Viewport,
} from './knowledge-network-interaction';
import {
  CARD_FALLBACK_JUMP_LABEL,
  relativeTime,
  type CanvasDetailTarget,
} from './knowledge-network-format';
import type { KnowledgeLogEntry } from '../shared/knowledge-global-log';
import { formatWikiWhen, wikiLogEventLabel, type KnowledgeLogHookState } from './wiki-discovery';
import { AppModal } from './app-modal';
import { locateLogEntry } from './knowledge-canvas-locate';

export type KnowledgeNetworkLayoutContext = {
  nodes: readonly KnowledgeNetworkNode[];
  relations: readonly KnowledgeNetworkRelation[];
  totalNodes: number;
  totalRelations: number;
  filters: Readonly<{
    nodeTypes: readonly KnowledgeNetworkFilterEntry[];
    relationTypes: readonly KnowledgeNetworkFilterEntry[];
  }> | null;
  updatedAt: string | null;
  loading: boolean;
  error: string | null;
  visibleNodes: readonly KnowledgeNetworkNode[];
  visibleRelations: readonly KnowledgeNetworkRelation[];
  positions: Positions;
  bounds: Readonly<{ width: number; height: number }>;
  viewport: Viewport;
  setViewport: (viewport: Viewport) => void;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  activeTypes: ReadonlySet<string>;
  toggleType: (type: KnowledgeNetworkNodeType) => void;
  activeRelationKeys: ReadonlySet<string>;
  toggleRelation: (key: string) => void;
  displayParams: DisplayParams;
  setDisplayParam: <K extends keyof DisplayParams>(key: K, value: number) => void;
  resetDisplayParams: () => void;
  selected: readonly string[];
  onBoxSelectCommit: (hits: readonly string[]) => void;
  onClearSelection: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelectAll: () => void;
  packageHint: string | null;
  cardNodeId: string | null;
  nodeDetail: KnowledgeNetworkNodeDetail | null;
  detailError: boolean;
  openNodeCard: (nodeId: string) => void;
  closeNodeCard: () => void;
  openRelatedCard: (nodeId: string) => void;
  cardJump: { label: string; target: CanvasDetailTarget } | null;
  /** 深链解析完成且无正式页面（note/entity）：展示诚实降级按钮而非静默隐藏。 */
  cardNoTarget: boolean;
  /** 浮卡内可观察反馈（无正式页面降级 / 降级按钮保持）；空白/Esc 关闭卡片即清空。 */
  cardNotice: string | null;
  onJumpDetail: () => void;
  onNodeDoubleClick: (nodeId: string) => void;
  adjacencyFocus: string | null;
  setAdjacencyFocus: (nodeId: string | null) => void;
  adjacency: Readonly<{ nodeIds: string[]; relationIds: string[] }>;
  refreshAnnounce: string;
  onRetry: () => void;
  onOpenLibrary: () => void;
  onNodeDrag: (nodeId: string, point: { x: number; y: number }) => void;
  /** 首次挂载是否已完成持久化视口恢复（布局据此决定是否自动适配视口）。 */
  initialViewportRestored: boolean;
  // WMB-5239：画布只读轻量入口（最近变化 / 知识健康 / 图谱内搜索定位；画布不承担维护执行）
  /** 最近变化（全局日志）面板开合。 */
  logOpen: boolean;
  setLogOpen: (open: boolean) => void;
  /** 最近变化条目诚实不可定位提示（点击条目后展示，面板重开后清空）。 */
  logNotice: string | null;
  onLogEntryOpen: (entry: KnowledgeLogEntry) => void;
  /** 最近变化数据（wiki-discovery useKnowledgeLog 投影；loading/empty/error/retry 由布局消费）。 */
  log: KnowledgeLogHookState;
  /** 知识健康只读提示（lint 待处理问题数 + 上次全库整理完成时间；无任何执行入口）。 */
  health: { openIssues: number; lastCompletedAt: string | null } | null;
  healthError: boolean;
  onRetryHealth: () => void;
  /** 图谱内搜索定位候选（与 data-kc-search / searchQuery 同一匹配语义，有界）。 */
  searchMatches: readonly KnowledgeNetworkNode[];
  /** 搜索无匹配的诚实提示（query 非空且零命中时非 null）。 */
  searchEmptyText: string | null;
  /** 定位既有节点（视图清除隐藏过滤 + 邻接高亮；布局负责居中 + 本体卡）。 */
  onLocateNode: (nodeId: string) => void;
  /** 定位请求（seq 单调递增；布局据此把目标节点居中到板面）。 */
  locateRequest: { nodeId: string; seq: number } | null;
};

const CARD_WIDTH = 360;
const DRAG_THRESHOLD_PX = 4;

/** WMB-5255：节点点径由度数驱动（TSX 钳制后以 CSS 变量注入；0..16 覆盖真实度数分布）。 */
const NODE_WEIGHT_CLAMP_MAX = 16;

const DISPLAY_PARAM_DEFS: ReadonlyArray<
  readonly [keyof DisplayParams, string, [number, number], number]
> = [
  ['nodeSize', '节点大小', [0.6, 1.6], 0.1],
  ['edgeWidth', '连线粗细', [0.5, 2.5], 0.1],
  ['repulsion', '排斥力', [300, 2000], 50],
  ['centerForce', '中心力', [0.01, 0.3], 0.01],
  ['linkDistance', '连线长度', [60, 240], 10],
];

export function KnowledgeCanvasLayout({ c }: { c: KnowledgeNetworkLayoutContext }) {
  const boardRef = useRef<HTMLDivElement>(null);
  /** WMB-5251：最近变化弹层关闭后的焦点归还目标（可定位条目 → 图谱节点/板面，而非工具栏触发按钮）。 */
  const logReturnFocusRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const boxRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [cardAnchor, setCardAnchor] = useState<KnowledgeCardAnchor | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  /** WMB-5239：知识健康只读弹层开合（画布只呈现健康状态，无维护执行入口）。 */
  const [healthOpen, setHealthOpen] = useState(false);
  /** WMB-5257：左侧图谱设置面板默认折叠（无 matchMedia 响应式自动展开；手动开关保留）。 */
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * WMB-5257：指针深度控制器 —— 连续指针值只存 ref，单 rAF 写入板面 CSS 变量
   * （聚光位置 --kn-pointer-x/y 归一化 0..1；网格视差 --kn-grid-dx/dy 有界 ±4/±3px）。
   * 绑定走 React onPointerMove（跟随当前板面元素，不依赖挂载时捕获的旧节点）；绝不
   * 用 React state 承载连续指针值；同一时刻至多一个挂起帧；卸载/运动偏好切换时取消防帧。
   * prefers-reduced-motion 下保持中性静态（reduceMotionRef 短路指针路径）。
   */
  const pointerDepthRef = useRef({ x: 0.5, y: 0.5 });
  const pointerFrameRef = useRef<number | null>(null);
  const reduceMotionRef = useRef(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduceMotionRef.current = motion.matches;
    const board = boardRef.current;
    if (board) {
      board.style.setProperty('--kn-pointer-x', '0.5');
      board.style.setProperty('--kn-pointer-y', '0.5');
      board.style.setProperty('--kn-grid-dx', '0px');
      board.style.setProperty('--kn-grid-dy', '0px');
    }
    const onMotionChange = () => {
      reduceMotionRef.current = motion.matches;
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }
      if (reduceMotionRef.current) {
        const current = boardRef.current;
        if (current) {
          current.style.setProperty('--kn-pointer-x', '0.5');
          current.style.setProperty('--kn-pointer-y', '0.5');
          current.style.setProperty('--kn-grid-dx', '0px');
          current.style.setProperty('--kn-grid-dy', '0px');
        }
      }
    };
    motion.addEventListener('change', onMotionChange);
    return () => {
      motion.removeEventListener('change', onMotionChange);
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const writePointerDepth = () => {
    pointerFrameRef.current = null;
    const board = boardRef.current;
    if (!board) return;
    const { x, y } = pointerDepthRef.current;
    board.style.setProperty('--kn-pointer-x', String(x));
    board.style.setProperty('--kn-pointer-y', String(y));
    board.style.setProperty('--kn-grid-dx', `${((x - 0.5) * 8).toFixed(2)}px`);
    board.style.setProperty('--kn-grid-dy', `${((y - 0.5) * 6).toFixed(2)}px`);
  };
  const schedulePointerFrame = () => {
    if (pointerFrameRef.current === null) {
      pointerFrameRef.current = requestAnimationFrame(writePointerDepth);
    }
  };
  /** React 合成指针移动：跟随当前板面元素；reduced-motion 短路；连续值只进 ref。 */
  const handleBoardPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduceMotionRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    pointerDepthRef.current = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
    schedulePointerFrame();
  };
  const dragRef = useRef<{
    kind: 'box' | 'pan' | 'node';
    startX: number;
    startY: number;
    origin?: { x: number; y: number };
    moved: boolean;
  }>({ kind: 'box', startX: 0, startY: 0, moved: false });
  const fittedRef = useRef(false);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpacePressed(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpacePressed(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ------------------------------------------------------------------
  // 视口：滚轮缩放（光标锚点）、中键/空格拖拽平移、按钮缩放、适应视图
  // ------------------------------------------------------------------
  const handleWheel = (event: React.WheelEvent) => {
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = zoomAt(
      c.viewport,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      factor,
    );
    c.setViewport({ ...next, zoom: clampZoom(next.zoom) });
  };

  const zoomByFactor = (factor: number) => {
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const next = zoomAt(
      c.viewport,
      { x: rect.width / 2, y: rect.height / 2 },
      factor,
    );
    c.setViewport({ ...next, zoom: clampZoom(next.zoom) });
  };

  const fitBoard = () => {
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const next = fitToBounds(
      c.positions,
      { width: rect.width, height: rect.height },
      c.viewport,
    );
    c.setViewport({ ...next, zoom: clampZoom(next.zoom) });
  };

  // 首次布局就绪后适配视口；持久化视口恢复完成前不覆盖用户位置。
  useEffect(() => {
    if (fittedRef.current) return;
    if (!c.initialViewportRestored) return;
    const board = boardRef.current;
    if (!board) return;
    const count = Object.keys(c.positions).length;
    if (!count) return;
    const rect = board.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    fittedRef.current = true;
    const next = fitToBounds(
      c.positions,
      { width: rect.width, height: rect.height },
      { x: 0, y: 0, zoom: 1 },
    );
    c.setViewport({ ...next, zoom: clampZoom(next.zoom) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.positions, c.initialViewportRestored]);

  // ------------------------------------------------------------------
  // 背景指针：左键拖框（框选即 Pi 上下文）；中键 / 空格+左键拖拽平移。
  // 事件从 .kn-world / 空板面冒泡到板面；节点/卡片/浮层各自 stopPropagation。
  // ------------------------------------------------------------------
  const beginBoardPointer = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        '.kn-node, .kn-edges, .kn-knowledge-card, .kn-zoom, .kc-selection-bar, .empty-state',
      )
    ) {
      return;
    }
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const panning = event.button === 1 || (event.button === 0 && spacePressed);
    if (panning) {
      event.preventDefault();
      dragRef.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      let lastX = event.clientX;
      let lastY = event.clientY;
      let vx = c.viewport.x;
      let vy = c.viewport.y;
      const move = (pointer: PointerEvent) => {
        const dx = pointer.clientX - lastX;
        const dy = pointer.clientY - lastY;
        lastX = pointer.clientX;
        lastY = pointer.clientY;
        if (dx !== 0 || dy !== 0) dragRef.current.moved = true;
        vx += dx;
        vy += dy;
        c.setViewport({ ...c.viewport, x: vx, y: vy });
      };
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        dragRef.current.kind = 'box';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop, { once: true });
      return;
    }
    if (event.button !== 0) return;
    dragRef.current = {
      kind: 'box',
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    const startLeft = event.clientX - rect.left;
    const startTop = event.clientY - rect.top;
    const move = (pointer: PointerEvent) => {
      const left = pointer.clientX - rect.left;
      const top = pointer.clientY - rect.top;
      if (
        Math.abs(left - startLeft) > DRAG_THRESHOLD_PX ||
        Math.abs(top - startTop) > DRAG_THRESHOLD_PX
      ) {
        dragRef.current.moved = true;
      }
      const nextBox = {
        left: Math.min(startLeft, left),
        top: Math.min(startTop, top),
        width: Math.abs(left - startLeft),
        height: Math.abs(top - startTop),
      };
      boxRef.current = nextBox;
      setBox(nextBox);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      setBox(null);
      const finalBox = boxRef.current;
      boxRef.current = null;
      dragRef.current.kind = 'box';
      if (
        finalBox &&
        finalBox.width > DRAG_THRESHOLD_PX &&
        finalBox.height > DRAG_THRESHOLD_PX
      ) {
        const hits = boxSelectHits(
          finalBox,
          c.positions,
          c.viewport.zoom,
          c.viewport,
        );
        const visibleIds = new Set(c.visibleNodes.map((node) => node.id));
        c.onBoxSelectCommit(hits.filter((id) => visibleIds.has(id)));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const handleBoardClick = () => {
    if (dragRef.current.moved) return;
    c.closeNodeCard();
  };

  // ------------------------------------------------------------------
  // 节点：拖动（会话覆盖）、单击浮卡、双击深链、悬停邻接高亮
  // ------------------------------------------------------------------
  const beginNodePointer = (
    event: React.PointerEvent,
    node: KnowledgeNetworkNode,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const origin = c.positions[node.id] ?? { x: 0, y: 0 };
    dragRef.current = {
      kind: 'node',
      startX: event.clientX,
      startY: event.clientY,
      origin,
      moved: false,
    };
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - dragRef.current.startX;
      const dy = pointer.clientY - dragRef.current.startY;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
        dragRef.current.moved = true;
      }
      if (dragRef.current.moved && dragRef.current.origin) {
        c.onNodeDrag(node.id, {
          x: dragRef.current.origin.x + dx / c.viewport.zoom,
          y: dragRef.current.origin.y + dy / c.viewport.zoom,
        });
      }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      dragRef.current.kind = 'box';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const handleNodeClick = (
    event: React.MouseEvent,
    node: KnowledgeNetworkNode,
  ) => {
    event.stopPropagation();
    if (dragRef.current.moved) return;
    c.openNodeCard(node.id);
  };

  const handleNodeDoubleClick = (
    event: React.MouseEvent,
    node: KnowledgeNetworkNode,
  ) => {
    event.stopPropagation();
    c.onNodeDoubleClick(node.id);
  };

  // ------------------------------------------------------------------
  // 键盘：Esc 卡片优先 → 清空选择；Ctrl+Z/Ctrl+X 历史；Ctrl+A 全选；
  // 输入框/可编辑区有焦点时保留系统快捷键。
  // ------------------------------------------------------------------
  const handleKeyDown = (event: React.KeyboardEvent) => {
    const editable = Boolean(
      (event.target instanceof Element ? event.target : null)?.closest(
        'input, textarea, select, [contenteditable="true"]',
      ),
    );
    if (event.key === 'Escape') {
      if (editable) return;
      if (c.cardNodeId) {
        c.closeNodeCard();
        return;
      }
      if (c.logOpen) {
        c.setLogOpen(false);
        return;
      }
      c.onClearSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      if (editable) return;
      event.preventDefault();
      c.onUndo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') {
      if (editable) return;
      event.preventDefault();
      c.onRedo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      if (editable) return;
      event.preventDefault();
      c.onSelectAll();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
    }
  };

  // ------------------------------------------------------------------
  // 浮卡定位：节点旁打开（优先右侧，越界翻左），随缩放重新锚定
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!c.cardNodeId) {
      setCardAnchor(null);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const board = boardRef.current;
      if (!board) return;
      const boardRect = board.getBoundingClientRect();
      const element = board.querySelector<HTMLElement>(
        `[data-kc-node-id="${c.cardNodeId}"]`,
      );
      if (!element) {
        // WMB-5239：定位的节点未渲染（被过滤隐藏 / 超出投影上限）→ 右侧固定锚位，
        // 知识本体卡仍可独立读取（诚实降级，不静默 no-op）。
        setCardAnchor({
          left: Math.max(12, boardRect.width - CARD_WIDTH - 12),
          top: 12,
        });
        return;
      }
      const nodeRect = element.getBoundingClientRect();
      let left = nodeRect.right - boardRect.left + 14;
      if (left + CARD_WIDTH > boardRect.width - 12) {
        left = nodeRect.left - boardRect.left - CARD_WIDTH - 14;
      }
      left = Math.max(
        12,
        Math.min(left, Math.max(12, boardRect.width - CARD_WIDTH - 12)),
      );
      const top = Math.max(
        12,
        Math.min(
          nodeRect.top - boardRect.top,
          Math.max(12, boardRect.height - 320),
        ),
      );
      setCardAnchor({ left, top });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.cardNodeId, c.nodeDetail?.node.id, c.viewport.zoom]);

  // WMB-5239：定位请求 → 把目标节点居中到板面（复用板面像素尺寸与既有 clampZoom）。
  useEffect(() => {
    if (!c.locateRequest) return;
    const board = boardRef.current;
    if (!board) return;
    const pos = c.positions[c.locateRequest.nodeId];
    if (!pos) return;
    const rect = board.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const zoom = clampZoom(c.viewport.zoom);
    c.setViewport({
      x: rect.width / 2 - pos.x * zoom,
      y: rect.height / 2 - pos.y * zoom,
      zoom,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.locateRequest?.seq]);

  // WMB-5251：最近变化条目点击 —— 可定位条目先请求关闭弹层，再走既有定位流程
  // （聚焦节点 / 本体卡 / 深链），并把焦点还给图谱目标（节点元素或画布板面）而非
  // 工具栏触发按钮；诚实不可定位条目保持弹层打开展示提示。
  const handleLogEntryClick = (entry: KnowledgeLogEntry) => {
    logReturnFocusRef.current = null;
    const decision = locateLogEntry(
      entry,
      new Set(c.nodes.map((node) => node.id)),
    );
    if (decision.kind === 'not-locatable') {
      c.onLogEntryOpen(entry);
      return;
    }
    if (decision.kind === 'focus-node' || decision.kind === 'open-card') {
      const nodeTarget = boardRef.current?.querySelector<HTMLElement>(
        `[data-kc-node-id="${decision.nodeId}"]`,
      );
      logReturnFocusRef.current = nodeTarget ?? boardRef.current;
    }
    c.setLogOpen(false);
    c.onLogEntryOpen(entry);
  };

  // WMB-5239：健康弹层点击外部关闭（弹层为只读投影，不拦截画布交互）。
  useEffect(() => {
    if (!healthOpen) return;
    const onDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('[data-kc-health-hint], [data-kc-health-popover]')
      ) {
        return;
      }
      setHealthOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [healthOpen]);

  const adjacencyNodeIds = useMemo(
    () => new Set(c.adjacency.nodeIds),
    [c.adjacency],
  );
  const adjacencyRelationIds = useMemo(
    () => new Set(c.adjacency.relationIds),
    [c.adjacency],
  );
  /** WMB-5255：搜索命中节点集合（命中节点按需揭示标签）。 */
  const searchMatchIds = useMemo(
    () => new Set(c.searchMatches.map((node) => node.id)),
    [c.searchMatches],
  );

  const worldStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    transform: `translate(${c.viewport.x}px, ${c.viewport.y}px) scale(${c.viewport.zoom})`,
    transformOrigin: '0 0',
    width: Math.max(c.bounds.width, 1),
    height: Math.max(c.bounds.height, 1),
  };

  const isEmpty = !c.loading && !c.error && c.nodes.length === 0;
  const cardNode =
    c.cardNodeId && c.nodeDetail
      ? c.nodeDetail.node
      : c.cardNodeId
        ? c.nodes.find((node) => node.id === c.cardNodeId) ?? null
        : null;

  return (
    <section className="kc-page" data-kc-view="knowledge-network">
      <header className="kc-header" data-kc-header>
        <div className="kc-breadcrumb">
          知识系统 / <strong>全局知识网络</strong>
        </div>
      </header>
      <div
        className="kc-board-wrap"
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          className="kn-board"
          data-kc-canvas
          ref={boardRef}
          tabIndex={0}
          aria-label="全局知识网络；拖框框选知识，单击节点查看知识卡片，双击进入正式页面，Ctrl+Z 回退框选，Ctrl+X 前进，Esc 清除"
          style={
            {
              '--kn-node-size': c.displayParams.nodeSize,
              '--kn-edge-width': c.displayParams.edgeWidth,
            } as React.CSSProperties
          }
          onWheel={handleWheel}
          onPointerDown={beginBoardPointer}
          onPointerMove={handleBoardPointerMove}
          onClick={handleBoardClick}
          onKeyDown={handleKeyDown}
        >
          <div className="kn-world" style={worldStyle}>
            <svg className="kn-edges" data-kc-edges>
              {c.visibleRelations.map((relation) => {
                const from = c.positions[relation.from];
                const to = c.positions[relation.to];
                if (!from || !to) return null;
                const adjacent = adjacencyRelationIds.has(relation.id);
                const dimmed =
                  c.adjacencyFocus !== null && !adjacent;
                return (
                  <line
                    key={relation.id}
                    data-kc-edge
                    data-kc-rel-type={relation.relationType}
                    className={`kn-edge${adjacent ? ' adjacent' : ''}${
                      dimmed ? ' kn-dimmed' : ''
                    }`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                  />
                );
              })}
            </svg>
            {c.visibleNodes.map((node) => {
              const pos = c.positions[node.id] ?? { x: 0, y: 0 };
              const isFocus = c.adjacencyFocus === node.id;
              const adjacent = adjacencyNodeIds.has(node.id);
              const dimmed = c.adjacencyFocus !== null && !isFocus && !adjacent;
              // WMB-5255：点径 = 度数（TSX 钳制 → CSS 变量）；标签按需揭示（CSS 类驱动，
              // 无 zoom/高度数/邻接批量路径）。
              const weight = Math.min(
                Math.max(Math.round(node.weight) || 0, 0),
                NODE_WEIGHT_CLAMP_MAX,
              );
              const nodeClass = [
                'kn-node',
                `type-${node.objectType}`,
                c.selected.includes(node.id) ? 'selected' : '',
                isFocus ? 'focused' : '',
                adjacent ? 'adjacent' : '',
                dimmed ? 'kn-dimmed' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <article
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  className={nodeClass}
                  data-kc-node-id={node.id}
                  data-kc-node-type={node.objectType}
                  data-kc-node-title={node.shortTitle}
                  data-kc-degree={String(weight)}
                  data-kc-search-match={
                    searchMatchIds.has(node.id) ? 'true' : 'false'
                  }
                  style={
                    {
                      left: pos.x,
                      top: pos.y,
                      '--kn-node-weight': String(weight),
                    } as React.CSSProperties
                  }
                  onPointerDown={(event) => beginNodePointer(event, node)}
                  onClick={(event) => handleNodeClick(event, node)}
                  onDoubleClick={(event) => handleNodeDoubleClick(event, node)}
                  onPointerEnter={() => c.setAdjacencyFocus(node.id)}
                  onPointerLeave={() => {
                    if (c.adjacencyFocus === node.id) c.setAdjacencyFocus(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      c.openNodeCard(node.id);
                    }
                  }}
                >
                  <span className="kn-node-label">
                    {node.shortTitle || '未命名知识'}
                  </span>
                </article>
              );
            })}
          </div>
          {/* WMB-5255：紧凑左侧控制面板（Obsidian 式覆盖；面板背景不拦图谱交互，
              交互控件各自 stopPropagation，拖框/平移/点击节点不受面板影响）。 */}
          <div
            className="kc-control-panel"
            data-kc-control-panel
            data-kc-panel-open={panelOpen ? 'true' : 'false'}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="kc-panel-head">
              <strong>图谱设置</strong>
              <button
                type="button"
                className="kc-panel-toggle"
                data-kc-panel-toggle
                aria-expanded={panelOpen}
                aria-controls="kc-control-panel-body"
                aria-label={panelOpen ? '收起图谱设置' : '展开图谱设置'}
                onClick={(event) => {
                  event.stopPropagation();
                  setPanelOpen((open) => !open);
                }}
              >
                {panelOpen ? '«' : '»'}
              </button>
            </div>
            <div
              className="kc-panel-body"
              id="kc-control-panel-body"
              data-kc-panel-body
            >
              <input
                data-kc-search
                type="search"
                placeholder="搜索主题、知识结论或实体…"
                aria-label="搜索知识网络"
                value={c.searchQuery}
                onChange={(event) => c.setSearchQuery(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              />
              {c.filters && (
                <>
                  <div className="kc-panel-group">
                    <span className="kc-panel-group-label">节点类型</span>
                    <div className="kc-filter-group" data-kc-type-filters>
                      {c.filters.nodeTypes.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          data-kc-type-filter
                          data-kc-type={entry.id}
                          className={`chip${c.activeTypes.has(entry.id) ? ' on' : ''}`}
                          onClick={() =>
                            c.toggleType(entry.id as KnowledgeNetworkNodeType)
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          {entry.label}
                          <span className="chip-label">{entry.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="kc-panel-group">
                    <span className="kc-panel-group-label">关系</span>
                    <div className="kc-filter-group" data-kc-relation-filters>
                      {c.filters.relationTypes.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          data-kc-relation-filter
                          data-kc-relation={entry.id}
                          className={`chip${c.activeRelationKeys.has(entry.id) ? ' on' : ''}`}
                          onClick={() => c.toggleRelation(entry.id)}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          {entry.label}
                          <span className="chip-label">{entry.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              <div className="kc-panel-group">
                <span className="kc-panel-group-label">显示</span>
                <div className="kc-display-params" data-kc-display-params>
                  {DISPLAY_PARAM_DEFS.map(([key, label, range, step]) => (
                    <label key={key} title={label}>
                      {label}
                      <input
                        type="range"
                        data-kc-display-param={key
                          .replace(/([a-z])([A-Z])/g, '$1-$2')
                          .toLowerCase()}
                        min={range[0]}
                        max={range[1]}
                        step={step}
                        value={c.displayParams[key]}
                        onChange={(event) =>
                          c.setDisplayParam(key, Number(event.target.value))
                        }
                        onPointerDown={(event) => event.stopPropagation()}
                      />
                      <output>{c.displayParams[key]}</output>
                    </label>
                  ))}
                  <button
                    type="button"
                    className="chip"
                    data-kc-display-reset
                    onClick={c.resetDisplayParams}
                  >
                    重置
                  </button>
                </div>
              </div>
              {/* WMB-5239：图谱内搜索定位（结果内联在面板内；点击行聚焦既有节点） */}
              {c.searchQuery.trim() !== '' && (
                <div
                  className="kc-search-locate"
                  data-kc-search-locate
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  {c.searchMatches.length > 0 ? (
                    <>
                      <div className="kc-locate-head" data-kc-locate-count>
                        匹配 {c.searchMatches.length} 个节点
                      </div>
                      <ul className="kc-locate-list">
                        {c.searchMatches.map((node) => (
                          <li key={node.id}>
                            <button
                              type="button"
                              className="kc-locate-row"
                              data-kc-locate-row
                              data-kc-locate-node={node.id}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                c.onLocateNode(node.id);
                              }}
                            >
                              <span className="kn-node-type">
                                {KNOWLEDGE_NETWORK_NODE_TYPE_LABELS[node.objectType]}
                              </span>
                              <span className="kn-node-label">
                                {node.shortTitle || '未命名知识'}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <div className="kc-locate-empty" data-kc-locate-empty>
                      <p>{c.searchEmptyText ?? '没有匹配的知识节点'}</p>
                      <button
                        type="button"
                        className="chip"
                        data-kc-locate-library
                        onClick={c.onOpenLibrary}
                      >
                        去资料库搜索全部资料
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {box && (
            <div
              className="kc-selection-box"
              data-kc-selection-box
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }}
            />
          )}
          <div className="kn-zoom" aria-label="图谱缩放">
            <button
              type="button"
              className="kn-zoom-btn"
              data-kc-zoom-out
              aria-label="缩小"
              onClick={() => zoomByFactor(1 / 1.15)}
            >
              −
            </button>
            <span data-kc-zoom-level>
              {Math.round(c.viewport.zoom * 100)}%
            </span>
            <button
              type="button"
              className="kn-zoom-btn"
              data-kc-zoom-in
              aria-label="放大"
              onClick={() => zoomByFactor(1.15)}
            >
              ＋
            </button>
            <button
              type="button"
              className="kn-zoom-btn"
              data-kc-zoom-fit
              onClick={fitBoard}
            >
              适应视图
            </button>
          </div>
        </div>
        {c.cardNodeId && cardAnchor && (
          <KnowledgeNetworkCard
            node={cardNode}
            detail={c.nodeDetail}
            detailError={c.detailError}
            anchor={cardAnchor}
            jumpLabel={
              c.cardJump?.label ??
              (c.cardNoTarget ? CARD_FALLBACK_JUMP_LABEL : null)
            }
            onJump={c.onJumpDetail}
            onClose={c.closeNodeCard}
            onOpenRelated={c.openRelatedCard}
            notice={c.cardNotice}
          />
        )}
        {c.selected.length > 0 && (
          <div className="kc-selection-bar" data-kc-selection-status>
            <strong data-kc-selection-count>已框选 {c.selected.length} 项</strong>
            {c.packageHint && (
              <span
                className="kc-manifest-hint"
                data-kc-package-hint
                title="冻结知识正文包（证据摘要 + 固定版本引用）"
              >
                {c.packageHint}
              </span>
            )}
            <button
              type="button"
              data-kc-history-undo
              disabled={!c.canUndo}
              title="Ctrl+Z"
              onClick={c.onUndo}
            >
              ↶ 回退框选
            </button>
            <button
              type="button"
              data-kc-history-redo
              disabled={!c.canRedo}
              title="Ctrl+X"
              onClick={c.onRedo}
            >
              ↷ 前进
            </button>
            <button type="button" onClick={c.onClearSelection}>
              清空（Esc）
            </button>
            <small data-kc-history-hint>
              Ctrl+Z 回退 · Ctrl+X 前进 · Esc 清空
            </small>
          </div>
        )}
        {/* WMB-5255：板面右上角克制工具条（图计数/更新时间 + 最近变化 + 知识健康；只读入口） */}
        <div className="kc-board-tools" data-kc-board-tools>
          <span className="kc-network-meta" data-kc-network-meta>
            {c.loading
              ? '正在载入知识网络…'
              : `${c.totalNodes} 个节点 · ${c.totalRelations} 条关系${
                  c.updatedAt ? ` · 更新于 ${relativeTime(c.updatedAt)}` : ''
                }`}
          </span>
          <button
            type="button"
            data-kc-log-toggle
            aria-expanded={c.logOpen}
            aria-controls="kc-log-panel-dialog"
            aria-label="最近变化"
            onClick={() => {
              // 重开弹层时清掉上次可定位点击留下的归还目标，普通关闭回到触发按钮。
              if (!c.logOpen) logReturnFocusRef.current = null;
              c.setLogOpen(!c.logOpen);
            }}
          >
            最近变化
          </button>
          <button
            type="button"
            className={`kc-health-hint${c.health && c.health.openIssues > 0 ? ' warn' : ''}`}
            data-kc-health-hint
            aria-expanded={healthOpen}
            aria-label="知识健康"
            onClick={() => setHealthOpen((open) => !open)}
          >
            {c.healthError
              ? '知识健康不可用'
              : c.health
                ? c.health.openIssues > 0
                  ? `知识健康 · ${c.health.openIssues} 个待处理问题`
                  : '知识健康 · 无待处理问题'
                : '知识健康 …'}
          </button>
          {healthOpen && (
            <div
              className="kc-health-popover"
              data-kc-health-popover
              role="dialog"
              aria-label="知识健康"
            >
              <button
                type="button"
                className="kc-health-close"
                data-kc-health-close
                aria-label="关闭知识健康"
                onClick={() => setHealthOpen(false)}
              >
                ×
              </button>
              <strong className="kc-health-title">知识健康</strong>
              {c.healthError ? (
                <>
                  <p className="kc-health-line" data-kc-health-error>
                    健康状态加载失败
                  </p>
                  <button
                    type="button"
                    className="chip"
                    data-kc-health-retry
                    onClick={() => void c.onRetryHealth()}
                  >
                    重试
                  </button>
                </>
              ) : c.health ? (
                <>
                  <p className="kc-health-line" data-kc-health-issues>
                    {c.health.openIssues > 0
                      ? `待处理问题 ${c.health.openIssues} 个`
                      : '无待处理问题'}
                  </p>
                  <p className="kc-health-line" data-kc-health-last-run>
                    上次全库整理
                    {relativeTime(c.health.lastCompletedAt) || '尚未进行'}
                  </p>
                  <button
                    type="button"
                    className="chip"
                    data-kc-health-library
                    onClick={() => {
                      setHealthOpen(false);
                      c.onOpenLibrary();
                    }}
                  >
                    去资料库查看全库整理
                  </button>
                </>
              ) : (
                <p className="kc-health-line">正在读取健康状态…</p>
              )}
            </div>
          )}
        </div>
        {/* WMB-5239/WMB-5251：最近变化（全局日志只读轻量弹层；条目点击 → 画布定位决策；
            几何/头部/关闭/焦点与滚动锁由共享 AppModal 拥有） */}
        <AppModal
          open={c.logOpen}
          title="最近变化"
          size="large"
          onRequestClose={() => c.setLogOpen(false)}
          className="kc-log-modal"
          ariaDescription="查看知识系统最近的写入变化；点击条目可在图谱中定位"
          returnFocusRef={logReturnFocusRef}
          testId="kc-log-panel"
        >
          <div className="kc-log-modal-body" data-kc-log-panel>
            {c.log.loading ? (
              <p className="kc-log-modal-empty" data-kc-log-loading>
                正在载入最近变化…
              </p>
            ) : c.log.error ? (
              <div className="kc-log-modal-error" data-kc-log-error role="alert">
                <p>最近变化加载失败</p>
                <p className="kc-log-modal-error-detail">{c.log.error}</p>
                <button
                  type="button"
                  className="chip"
                  data-kc-log-retry
                  onClick={c.log.retry}
                >
                  重试
                </button>
              </div>
            ) : c.log.entries.length === 0 ? (
              <p className="kc-log-modal-empty" data-kc-log-empty>
                还没有知识变化记录
              </p>
            ) : (
              <ul className="kc-log-list">
                {c.log.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="kc-log-row"
                      data-kc-log-row
                      data-kc-log-event={entry.eventType}
                      onClick={() => handleLogEntryClick(entry)}
                    >
                      <span className="kc-log-event">
                        {wikiLogEventLabel(entry.eventType)}
                      </span>
                      <span className="kc-log-title">{entry.title}</span>
                      {entry.summary ? (
                        <span className="kc-log-summary">{entry.summary}</span>
                      ) : null}
                      <time className="kc-log-time" dateTime={entry.time}>
                        {formatWikiWhen(entry.time)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {c.log.hasMore ? (
              <div className="kc-log-modal-more">
                <button
                  type="button"
                  className="chip"
                  data-kc-log-more
                  disabled={c.log.loadingMore}
                  onClick={c.log.loadMore}
                >
                  {c.log.loadingMore ? '加载中…' : '加载更多'}
                </button>
              </div>
            ) : null}
            {c.logNotice && (
              <p
                className="kc-log-modal-notice"
                data-kc-log-notice
                role="status"
              >
                {c.logNotice}
              </p>
            )}
          </div>
        </AppModal>
        {isEmpty && (
          <section className="empty-state" data-kc-empty-state>
            <h2>还没有正式知识</h2>
            <p>
              保存资料并让知识维护沉淀出主题、知识结论与实体后，这里会自动呈现全局知识网络。
            </p>
            <button
              type="button"
              className="primary-button"
              data-kc-empty-action
              onClick={c.onOpenLibrary}
            >
              去资料库保存资料
            </button>
          </section>
        )}
        {!c.loading && c.error && (
          <section className="empty-state" data-kc-error-state>
            <h2>知识网络加载失败</h2>
            <p>{c.error}</p>
            <button
              type="button"
              className="primary-button"
              data-kc-retry
              onClick={c.onRetry}
            >
              重试
            </button>
          </section>
        )}
        {c.loading && c.nodes.length === 0 && (
          <div className="empty-state" data-kc-loading>
            <p>正在载入知识网络…</p>
          </div>
        )}
      </div>
      <div className="kc-aria-live" aria-live="polite">
        {c.refreshAnnounce}
      </div>
    </section>
  );
}
