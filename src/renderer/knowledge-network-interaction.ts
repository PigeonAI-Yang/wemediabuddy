// WMB-5243：全局 Wiki 知识网络 —— 渲染端交互/布局纯函数层（无 DOM 依赖、无 IPC、无副作用）。
// 供 knowledge-canvas-view / knowledge-canvas-layout 消费；全部映射逻辑纯函数化以便局部单测
// （tests/wmb-5243-network-interaction.test.mjs）。
// 边界：
// - 位置一律由本模块的确定性力导向布局计算，绝不读写手工坐标；SQLite 唯一真源，
//   投影节点无 x/y（src/shared/knowledge-network.ts），本模块不落第二真源；
// - persist* 只用于把「已计算」的 UI 状态（视口/显示参数/过滤/布局缓存）写入 localStorage，
//   图谱运行绝不依赖它们 —— 布局永远从零计算；"全局图不依赖手工保存坐标"；
// - 不消费旧画布 IPC；不做任何写操作；颜色一律由 CSS foundation token 承担，本模块只产出 token/值。

import type {
  KnowledgeNetworkNode,
  KnowledgeNetworkNodeType,
  KnowledgeNetworkProjection,
  KnowledgeNetworkRelation
} from '../shared/knowledge-network';

// ---------------------------------------------------------------------------
// 类型（与 WikiNetworkRenderer 约定的精确导入面一致）
// ---------------------------------------------------------------------------

/** 显示参数（slider 控制面；nodeSize/edgeWidth 为倍率，repulsion/centerForce/linkDistance 为布局力参数）。 */
export type DisplayParams = Readonly<{
  nodeSize: number;
  edgeWidth: number;
  repulsion: number;
  centerForce: number;
  linkDistance: number;
}>;

/** 布局输入节点的最小形状（renderer 传投影节点即可，多余字段忽略）。 */
export type KnNodeLike = Readonly<{ id: string; objectType?: string; weight?: number }>;

/** 布局输入关系的最小形状。 */
export type KnRelationLike = Readonly<{ id: string; from: string; to: string; relationType?: string }>;

/** 布局输出位置表：稳定节点 ID → 世界坐标。 */
export type Positions = Readonly<Record<string, Readonly<{ x: number; y: number }>>>;

/** 视口：屏幕 = 世界 × zoom + pan（x/y 为屏幕偏移）。 */
export type Viewport = Readonly<{ x: number; y: number; zoom: number }>;

/** 布局世界包围盒（含 padding）。 */
export type LayoutBounds = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}>;

/** 图谱过滤（search 输入 + 类型/关系语义分组）。 */
export type GraphFilter = Readonly<{
  query: string;
  nodeTypes: ReadonlySet<string>;
  relationTypes: ReadonlySet<string>;
}>;

/** 持久化 UI 状态（仅视口/显示参数/过滤；不含任何节点坐标）。 */
export type StableGraphState = Readonly<{
  viewport?: Viewport;
  displayParams?: DisplayParams;
  filter?: GraphFilter;
}>;

/** 最小可写的 storage 接口（浏览器 localStorage / 测试假 storage 均可）。 */
export type StorageLike = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}>;

// ---------------------------------------------------------------------------
// 显示参数默认值与范围（slider 边界；renderer 直接消费）
// ---------------------------------------------------------------------------

export const DISPLAY_PARAM_DEFAULTS: DisplayParams = Object.freeze({
  nodeSize: 1,
  edgeWidth: 1,
  repulsion: 1700,
  centerForce: 0.06,
  linkDistance: 150
});

export const DISPLAY_PARAM_RANGES: Readonly<Record<keyof DisplayParams, readonly [number, number]>> = Object.freeze({
  nodeSize: [0.6, 1.6],
  edgeWidth: [0.5, 2.5],
  repulsion: [300, 2000],
  centerForce: [0.01, 0.3],
  linkDistance: [60, 240]
});

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

export const DEFAULT_VIEWPORT: Viewport = Object.freeze({ x: 0, y: 0, zoom: 1 });

/** 非有限值判定（多处 NaN 防护共用同一语义）。 */
function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/** 带默认值钳制（非有限值回落 min）。 */
function clamp(value: number, min: number, max: number): number {
  if (!isFiniteNumber(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 缺省填充 + 边界钳制 + 非有限值防护；返回全新对象（不改入参）。 */
export function normalizeDisplayParams(raw?: Partial<DisplayParams> | null): DisplayParams {
  const base = { ...DISPLAY_PARAM_DEFAULTS, ...(raw ?? {}) } as Record<keyof DisplayParams, number>;
  const out = {} as Record<keyof DisplayParams, number>;
  (Object.keys(DISPLAY_PARAM_RANGES) as Array<keyof DisplayParams>).forEach((key) => {
    const [min, max] = DISPLAY_PARAM_RANGES[key];
    out[key] = clamp(base[key], min, max);
  });
  return out as DisplayParams;
}

/** zoom 钳制（含非有限值防护）。 */
export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

// ---------------------------------------------------------------------------
// 确定性随机（种子化；力导向布局可复现，测试不依赖具体审美）
// ---------------------------------------------------------------------------

/** mulberry32：确定性 PRNG（同 seed 同序列）。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 节点 ID 稳定哈希（0..1）；不依赖投影顺序变动。 */
export function hashId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// 力导向布局
// ---------------------------------------------------------------------------

/** 网格力阈值：超过该节点数启用空间哈希（O(n·邻域) 近似），中等规模图保持流畅。 */
const GRID_THRESHOLD = 160;
const DAMPING = 0.85;
const MAX_FORCE = 60;
const MAX_VELOCITY = 24;
const SPRING_STIFFNESS = 0.02;
const WORLD_BOUNDS = { width: 1400, height: 900 };
const ESCAPE_LIMIT = 5;

type SimNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
};

/**
 * 确定性力导向布局：排斥 + 弹簧 + 中心力，速度阻尼与 alpha 冷却。
 * - 位置完全由计算得到：输入节点无需任何 x/y，结果也不回写任何存储；
 * - 同输入（params + seed + warm）必得同输出，便于测试与稳定过滤；
 * - n > GRID_THRESHOLD 时用均匀网格近似排斥力，避免 O(n²) 退化（中等规模性能）。
 *
 * @param nodes   投影节点（只读最小形状；weight=正式关系度数作质量）
 * @param relations 投影关系（两端均在场才建弹簧；容忍缺端）
 * @param params  显示参数（nodeSize 参与最小间距，edgeWidth 纯视觉不进模拟）
 * @param seed    确定性种子（缺省固定值；同输入同结果）
 * @param warm    预热位置（例如上一帧布局结果或 persistPositions 缓存，保持过滤时位置稳定；
 *                仍参与完整力模拟，非手工保存坐标）
 */
export function layoutGraph(
  nodes: readonly KnNodeLike[],
  relations: readonly KnRelationLike[],
  params: DisplayParams,
  seed?: number,
  warm?: Readonly<Record<string, Readonly<{ x: number; y: number }>>> | null,
): { positions: Positions; bounds: { width: number; height: number } } {
  const p = normalizeDisplayParams(params);
  const seedValue = isFiniteNumber(seed as number) ? (seed as number) : 0x5eed;
  const iterations = clamp(Math.round(60 + nodes.length * 0.5), 40, 400);

  const present = new Set<string>();
  nodes.forEach((node) => present.add(node.id));

  // 弹簧（两端均在场；容忍缺端，不抛错；跳过自环）。
  const adjacency = new Set<string>();
  relations.forEach((relation) => {
    if (relation.from === relation.to) return;
    if (!present.has(relation.from) || !present.has(relation.to)) return;
    adjacency.add(`${relation.from}\u0000${relation.to}`);
  });

  const massOf = (weight: number | undefined): number => {
    const w = isFiniteNumber(weight as number) ? (weight as number) : 0;
    return clamp(1 + Math.max(0, w) * 0.2, 1, 5);
  };

  const rng = seededRandom(seedValue);
  const linkDistance = p.linkDistance;
  const spread = Math.min(
    Math.min(WORLD_BOUNDS.width, WORLD_BOUNDS.height) * 0.42,
    linkDistance * Math.sqrt(Math.max(1, nodes.length)) * 0.62 * p.nodeSize
  );
  const jitter = linkDistance * 0.15 * p.nodeSize;

  // 初始放置：黄金角螺旋 + 种子抖动；有预热位置则沿用（仍参与力模拟）。
  const sim: SimNode[] = nodes.map((node, index) => {
    const warmPos = warm?.[node.id];
    if (warmPos && isFiniteNumber(warmPos.x) && isFiniteNumber(warmPos.y)) {
      return { id: node.id, x: warmPos.x, y: warmPos.y, vx: 0, vy: 0, mass: massOf(node.weight) };
    }
    const radius = spread * Math.sqrt((index + 0.5) / Math.max(1, nodes.length));
    const theta = index * 2.399963;
    const hash = hashId(node.id);
    return {
      id: node.id,
      x: radius * Math.cos(theta) + (hash - 0.5) * 2 * jitter,
      y: radius * Math.sin(theta) + (rng() - 0.5) * 2 * jitter,
      vx: 0,
      vy: 0,
      mass: massOf(node.weight)
    };
  });

  const byId = new Map<string, SimNode>();
  sim.forEach((node) => byId.set(node.id, node));

  const repulsion = p.repulsion;
  const centerForce = p.centerForce;
  const minDist = Math.max(p.nodeSize * 8, 1);
  const cellSize = Math.max(linkDistance * 1.6, 40);
  const cutoff = cellSize * 2.2;

  const cellKey = (x: number, y: number): string =>
    `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;

  const applyRepulsionPair = (a: SimNode, b: SimNode): void => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;
    const d2Safe = Math.max(d2, minDist * minDist);
    const d = Math.sqrt(d2Safe);
    if (d > cutoff) return;
    const force = Math.min((repulsion * a.mass * b.mass) / d2Safe, MAX_FORCE);
    const fx = (dx / d) * force;
    const fy = (dy / d) * force;
    a.vx -= fx;
    a.vy -= fy;
    b.vx += fx;
    b.vy += fy;
  };

  const applySpringsPass = (): void => {
    adjacency.forEach((pair) => {
      const sep = pair.indexOf('\u0000');
      const from = byId.get(pair.slice(0, sep));
      const to = byId.get(pair.slice(sep + 1));
      if (!from || !to) return;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-9) return;
      const d = Math.sqrt(d2);
      const force = clamp(SPRING_STIFFNESS * (d - linkDistance), -MAX_FORCE, MAX_FORCE);
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      from.vx += fx;
      from.vy += fy;
      to.vx -= fx;
      to.vy -= fy;
    });
  };

  // 网格排斥：每对只算一次（小索引节点在自己的 3×3 邻域内找 j > i）。
  const applyRepulsionPass = (): void => {
    if (sim.length <= GRID_THRESHOLD) {
      for (let i = 0; i < sim.length; i += 1) {
        for (let j = i + 1; j < sim.length; j += 1) {
          applyRepulsionPair(sim[i], sim[j]);
        }
      }
      return;
    }
    const grid = new Map<string, number[]>();
    sim.forEach((node, index) => {
      const key = cellKey(node.x, node.y);
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    });
    sim.forEach((node, index) => {
      const cx = Math.floor(node.x / cellSize);
      const cy = Math.floor(node.y / cellSize);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.get(`${cx + ox}:${cy + oy}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j > index) applyRepulsionPair(node, sim[j]);
          }
        }
      }
    });
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const alpha = 0.05 + 0.95 * (1 - iteration / Math.max(1, iterations));
    applyRepulsionPass();
    applySpringsPass();
    // 中心力（拉向原点；mass 越大越稳定）。
    sim.forEach((node) => {
      const dist = Math.hypot(node.x, node.y) || 1;
      const pull = clamp(centerForce * dist, -MAX_FORCE, MAX_FORCE) / node.mass;
      node.vx -= (node.x / dist) * pull;
      node.vy -= (node.y / dist) * pull;
    });
    sim.forEach((node) => {
      node.vx = clamp(node.vx * DAMPING, -MAX_VELOCITY, MAX_VELOCITY);
      node.vy = clamp(node.vy * DAMPING, -MAX_VELOCITY, MAX_VELOCITY);
      node.x += node.vx * alpha;
      node.y += node.vy * alpha;
      // 逃生防护：极端情况下限制在世界包围盒 ESCAPE_LIMIT 倍内。
      node.x = clamp(node.x, -WORLD_BOUNDS.width * ESCAPE_LIMIT, WORLD_BOUNDS.width * ESCAPE_LIMIT);
      node.y = clamp(node.y, -WORLD_BOUNDS.height * ESCAPE_LIMIT, WORLD_BOUNDS.height * ESCAPE_LIMIT);
    });
  }

  const positions: Record<string, { x: number; y: number }> = {};
  sim.forEach((node) => {
    positions[node.id] = { x: node.x, y: node.y };
  });
  const bounds = computeBounds(positions);
  return { positions, bounds: { width: bounds.width, height: bounds.height } };
}

// ---------------------------------------------------------------------------
// 包围盒
// ---------------------------------------------------------------------------

/** 从位置表计算包围盒（含 padding；空输入返回原点盒）。 */
export function computeBounds(
  positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  padding = 40,
): LayoutBounds {
  const entries = Object.values(positions);
  if (entries.length === 0) {
    return { minX: -padding, minY: -padding, maxX: padding, maxY: padding, width: padding * 2, height: padding * 2, cx: 0, cy: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  entries.forEach((node) => {
    if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) return;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  });
  if (!isFiniteNumber(minX)) {
    return { minX: -padding, minY: -padding, maxX: padding, maxY: padding, width: padding * 2, height: padding * 2, cx: 0, cy: 0 };
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  };
}

// ---------------------------------------------------------------------------
// 视口数学（屏幕 = 世界 × zoom + pan）
// ---------------------------------------------------------------------------

export function worldToScreen(point: Readonly<{ x: number; y: number }>, viewport: Viewport): { x: number; y: number } {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

export function screenToWorld(point: Readonly<{ x: number; y: number }>, viewport: Viewport): { x: number; y: number } {
  const zoom = clampZoom(viewport.zoom);
  return { x: (point.x - viewport.x) / zoom, y: (point.y - viewport.y) / zoom };
}

/** 平移（屏幕像素增量）。 */
export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: clampZoom(viewport.zoom) };
}

/** 以屏幕点 point 为锚缩放：锚点下的世界坐标保持不动。 */
export function zoomAt(viewport: Viewport, point: Readonly<{ x: number; y: number }>, factor: number): Viewport {
  const zoom = clampZoom(viewport.zoom * factor);
  const anchor = screenToWorld(point, viewport);
  return { x: point.x - anchor.x * zoom, y: point.y - anchor.y * zoom, zoom };
}

/**
 * 适配视口：把位置表包围盒居中，按给定容器 bounds（屏幕像素）缩放；
 * 最大放大到 1（整图可见），padding 80 像素。
 */
export function fitToBounds(
  positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  bounds: Readonly<{ width: number; height: number }>,
  viewport: Viewport,
): Viewport {
  const padding = 80;
  const box = computeBounds(positions, padding);
  if (box.width <= 0 || box.height <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return DEFAULT_VIEWPORT;
  }
  const zoom = clampZoom(
    Math.min(
      (bounds.width - padding * 2) / box.width,
      (bounds.height - padding * 2) / box.height,
      1
    )
  );
  return {
    x: bounds.width / 2 - box.cx * zoom,
    y: bounds.height / 2 - box.cy * zoom,
    zoom
  };
}

// ---------------------------------------------------------------------------
// 命中与框选（框选即 Pi 上下文 —— 本模块只算几何，不碰 Pi 接线）
// ---------------------------------------------------------------------------

/**
 * 命中测试：返回 (point 屏幕坐标) 半径 radiusPx 内最近的节点 id；无命中返回 null。
 * 命中半径建议 = nodeSize × zoom + 4（由调用方按显示参数计算）。
 */
export function hitTestNode(
  positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  viewport: Viewport,
  point: Readonly<{ x: number; y: number }>,
  radiusPx: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  Object.entries(positions).forEach(([id, node]) => {
    const screen = worldToScreen(node, viewport);
    const d = Math.hypot(screen.x - point.x, screen.y - point.y);
    if (d <= radiusPx && d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  });
  return best;
}

/** 框选：返回屏幕矩形（box，含边界）内中心点的节点 id 列表（按投影顺序）。 */
export function boxSelectHits(
  box: Readonly<{ left: number; top: number; width: number; height: number }>,
  positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  zoom: number,
  viewport: Readonly<{ x: number; y: number }>,
): string[] {
  const minX = Math.min(box.left, box.left + box.width);
  const maxX = Math.max(box.left, box.left + box.width);
  const minY = Math.min(box.top, box.top + box.height);
  const maxY = Math.max(box.top, box.top + box.height);
  const out: string[] = [];
  Object.entries(positions).forEach(([id, node]) => {
    const screenX = node.x * zoom + viewport.x;
    const screenY = node.y * zoom + viewport.y;
    if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
      out.push(id);
    }
  });
  return out;
}

/** nodesInBox 别名（保持旧调用面；box 为 {x,y,width,height} 屏幕矩形）。 */
export function nodesInBox(
  positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  viewport: Viewport,
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
): string[] {
  return boxSelectHits({ left: box.x, top: box.y, width: box.width, height: box.height }, positions, viewport.zoom, viewport);
}

// ---------------------------------------------------------------------------
// 搜索 / 过滤（纯函数；renderer 把结果喂给布局与渲染）
// ---------------------------------------------------------------------------

export const EMPTY_FILTER: GraphFilter = Object.freeze({
  query: '',
  nodeTypes: new Set<string>(),
  relationTypes: new Set<string>()
});

function matchesQuery(node: Pick<KnowledgeNetworkNode, 'shortTitle' | 'summary'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    node.shortTitle.toLowerCase().includes(q) ||
    (node.summary ?? '').toLowerCase().includes(q)
  );
}

/**
 * 过滤：query 命中 shortTitle/summary；nodeTypes 非空时只留这些类型；
 * relationTypes 非空时只留这些语义；关系两端都必须仍在结果里。
 * 返回顺序与输入一致（投影分页顺序稳定）。
 */
export function filterGraph(
  nodes: readonly KnowledgeNetworkNode[],
  relations: readonly KnowledgeNetworkRelation[],
  filter?: Partial<GraphFilter> | null,
): { nodes: KnowledgeNetworkNode[]; relations: KnowledgeNetworkRelation[] } {
  const f: GraphFilter = {
    query: filter?.query ?? '',
    nodeTypes: filter?.nodeTypes ?? new Set<string>(),
    relationTypes: filter?.relationTypes ?? new Set<string>()
  };
  const kept = new Set<string>();
  const keptNodes: KnowledgeNetworkNode[] = [];
  nodes.forEach((node) => {
    const typeOk = f.nodeTypes.size === 0 || f.nodeTypes.has(node.objectType);
    if (!typeOk || !matchesQuery(node, f.query)) return;
    kept.add(node.id);
    keptNodes.push(node);
  });
  const keptRelations: KnowledgeNetworkRelation[] = [];
  relations.forEach((relation) => {
    if (f.relationTypes.size > 0 && !f.relationTypes.has(relation.relationType)) return;
    if (!kept.has(relation.from) || !kept.has(relation.to)) return;
    keptRelations.push(relation);
  });
  return { nodes: keptNodes, relations: keptRelations };
}

// ---------------------------------------------------------------------------
// 分页合并（跨页关系集合级：每页返回同一集合关系；合并按 id 去重，不丢失）
// ---------------------------------------------------------------------------

/**
 * 分页投影合并（renderer 分页循环的纯函数核心）：节点按页顺序追加，总量上限 maxNodes
 * （与后端 KNOWLEDGE_NETWORK_MAX_LIMIT 合同一致）；关系按 id 去重 —— 后端每页返回同一
 * 集合级关系，端点落在分页边界两侧的正式关系不会因分页丢失，重复页仅保留一份。
 */
export function mergeProjectionPages(
  pages: readonly KnowledgeNetworkProjection[],
  maxNodes: number,
): { nodes: KnowledgeNetworkNode[]; relations: KnowledgeNetworkRelation[] } {
  const nodes: KnowledgeNetworkNode[] = [];
  const relations: KnowledgeNetworkRelation[] = [];
  const seenRelationIds = new Set<string>();
  for (const page of pages) {
    for (const node of page.nodes) {
      if (nodes.length >= maxNodes) break;
      nodes.push(node);
    }
    for (const relation of page.relations) {
      if (seenRelationIds.has(relation.id)) continue;
      seenRelationIds.add(relation.id);
      relations.push(relation);
    }
  }
  return { nodes, relations };
}

// ---------------------------------------------------------------------------
// 邻接高亮（1-hop）
// ---------------------------------------------------------------------------

/** 返回 nodeId 的一跳邻居节点 id 与接触的关系 id（去重、稳定顺序）。 */
export function adjacencyOf(
  relations: readonly Pick<KnowledgeNetworkRelation, 'id' | 'from' | 'to'>[],
  nodeId: string,
): { nodeIds: string[]; relationIds: string[] } {
  const nodeIds: string[] = [];
  const relationIds: string[] = [];
  const seenNodes = new Set<string>();
  const seenRelations = new Set<string>();
  relations.forEach((relation) => {
    if (relation.from !== nodeId && relation.to !== nodeId) return;
    if (!seenRelations.has(relation.id)) {
      seenRelations.add(relation.id);
      relationIds.push(relation.id);
    }
    const other = relation.from === nodeId ? relation.to : relation.from;
    if (!seenNodes.has(other)) {
      seenNodes.add(other);
      nodeIds.push(other);
    }
  });
  return { nodeIds, relationIds };
}

// ---------------------------------------------------------------------------
// 分组 token（颜色一律由 CSS foundation token 承担）
// ---------------------------------------------------------------------------

const KNOWN_RELATION_KEYS: Record<string, true> = Object.freeze({
  supports: true,
  contradicts: true,
  qualifies: true,
  derived_from: true,
  about: true,
  belongs_to_topic: true,
  entity_relation: true
});

/** 任意字符串 → 安全 CSS token（data 属性值；未知回落 'default'）。 */
export function cssToken(value: string | null | undefined): string {
  const token = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || 'default';
}

/** 关系语义 → data-kc-rel-type 值（已知分组原样、未知回落 default）。 */
export function relationTypeToken(relationType: string | null | undefined): string {
  const token = cssToken(relationType);
  return KNOWN_RELATION_KEYS[token] ? token : 'default';
}

/** 节点类型 → data-kc-node-type 值（仅三类默认节点；未知回落 default）。 */
export function nodeTypeToken(objectType: KnowledgeNetworkNodeType | string | null | undefined): string {
  const token = cssToken(objectType);
  return token === 'topic' || token === 'knowledge_note' || token === 'knowledge_entity' ? token : 'default';
}

// ---------------------------------------------------------------------------
// UI 状态持久化（仅视口/显示参数/过滤/布局缓存；明确不含手工坐标真源）
// ---------------------------------------------------------------------------

export const NETWORK_STATE_STORAGE_KEY = 'wmb5243.knowledge-network.ui';

/** 对象 → Record（JSON 边界窄化守卫；数组/原始值回落 null）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseViewport(raw: unknown): Viewport | undefined {
  const record = asRecord(raw);
  if (!record || !isFiniteNumber(Number(record.x)) || !isFiniteNumber(Number(record.y)) || !isFiniteNumber(Number(record.zoom))) {
    return undefined;
  }
  return { x: Number(record.x), y: Number(record.y), zoom: clampZoom(Number(record.zoom)) };
}

function parseDisplayParams(raw: unknown): DisplayParams | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const allPresent = (Object.keys(DISPLAY_PARAM_RANGES) as Array<keyof DisplayParams>).every((key) =>
    isFiniteNumber(Number(record[key]))
  );
  if (!allPresent) return undefined;
  return normalizeDisplayParams(record as unknown as Partial<DisplayParams>);
}

function parseFilter(raw: unknown): GraphFilter | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const query = typeof record.query === 'string' ? record.query.slice(0, 200) : '';
  const nodeTypes = new Set<string>();
  if (Array.isArray(record.nodeTypes)) {
    record.nodeTypes.slice(0, 16).forEach((value) => {
      if (typeof value === 'string') nodeTypes.add(nodeTypeToken(value));
    });
  }
  const relationTypes = new Set<string>();
  if (Array.isArray(record.relationTypes)) {
    record.relationTypes.slice(0, 16).forEach((value) => {
      if (typeof value === 'string') relationTypes.add(relationTypeToken(value));
    });
  }
  return { query, nodeTypes, relationTypes };
}

/** 序列化 UI 状态（可逆；无节点坐标）。 */
export function serializeGraphState(state: StableGraphState): string {
  return JSON.stringify({
    viewport: state.viewport ?? undefined,
    displayParams: state.displayParams ?? undefined,
    filter: state.filter
      ? {
          query: state.filter.query,
          nodeTypes: [...state.filter.nodeTypes],
          relationTypes: [...state.filter.relationTypes]
        }
      : undefined
  });
}

/** 解析持久化 UI 状态；非法/越界/残缺输入安全回落（返回 null 表示无有效状态）。 */
export function parseGraphState(json: string | null | undefined): StableGraphState | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (!record) return null;
  const viewport = parseViewport(record.viewport);
  const displayParams = parseDisplayParams(record.displayParams);
  const filter = parseFilter(record.filter);
  if (!viewport && !displayParams && !filter) return null;
  return {
    ...(viewport ? { viewport } : {}),
    ...(displayParams ? { displayParams } : {}),
    ...(filter ? { filter } : {})
  };
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  let resolved: StorageLike | null = storage ?? null;
  if (!resolved && typeof globalThis !== 'undefined') {
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (candidate) resolved = candidate;
  }
  return resolved;
}

/** 安全读取（storage 缺失/异常一律回落 null；测试可注入假 storage）。 */
export function loadGraphState(storage?: StorageLike | null): StableGraphState | null {
  const resolved = resolveStorage(storage);
  if (!resolved) return null;
  try {
    return parseGraphState(resolved.getItem(NETWORK_STATE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 安全写入（storage 缺失/异常时返回 false）。 */
export function saveGraphState(state: StableGraphState, storage?: StorageLike | null): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved) return false;
  try {
    resolved.setItem(NETWORK_STATE_STORAGE_KEY, serializeGraphState(state));
    return true;
  } catch {
    return false;
  }
}

/** 任意 key 的视口持久化（renderer 可传命名 key；不抛错）。 */
export function persistViewport(key: string, viewport: Viewport, storage?: StorageLike | null): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved) return false;
  try {
    resolved.setItem(key, JSON.stringify({ x: viewport.x, y: viewport.y, zoom: clampZoom(viewport.zoom) }));
    return true;
  } catch {
    return false;
  }
}

/** 任意 key 的视口读取；非法/缺失返回 null（不抛错）。 */
export function loadViewport(key: string, storage?: StorageLike | null): Viewport | null {
  const resolved = resolveStorage(storage);
  if (!resolved) return null;
  try {
    return parseViewport(JSON.parse(resolved.getItem(key) ?? 'null')) ?? null;
  } catch {
    return null;
  }
}

/** 任意 key 的布局位置缓存写入（值来自 layoutGraph 输出，非手工坐标；不抛错）。 */
export function persistPositions(key: string, positions: Positions, storage?: StorageLike | null): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved) return false;
  try {
    resolved.setItem(key, JSON.stringify(positions));
    return true;
  } catch {
    return false;
  }
}

/** 任意 key 的布局位置缓存读取；非法/缺失返回 null（不抛错）。 */
export function loadPositions(key: string, storage?: StorageLike | null): Positions | null {
  const resolved = resolveStorage(storage);
  if (!resolved) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(resolved.getItem(key) ?? 'null');
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (!record) return null;
  const out: Record<string, { x: number; y: number }> = {};
  let valid = 0;
  Object.entries(record).forEach(([id, value]) => {
    const pos = asRecord(value);
    if (!pos || !isFiniteNumber(Number(pos.x)) || !isFiniteNumber(Number(pos.y))) return;
    out[id] = { x: Number(pos.x), y: Number(pos.y) };
    valid += 1;
  });
  return valid > 0 ? out : null;
}

/** reduced-motion 偏好（无 DOM 环境安全回落 false）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
