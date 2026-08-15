// WMB-5243 全局 Wiki 知识网络 —— 交互/布局纯函数层聚焦合同测试。
// 覆盖：显示参数钳制、确定性力导向布局（不依赖手工坐标）、视口数学、命中/框选几何、
// 搜索/过滤、邻接高亮、分组 token、UI 状态持久化（明确不含节点坐标真源）、reduced-motion。
// 纯行为测试：无 DOM、无 IPC、不运行。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VIEWPORT,
  DISPLAY_PARAM_DEFAULTS,
  MIN_ZOOM,
  adjacencyOf,
  boxSelectHits,
  clampZoom,
  computeBounds,
  cssToken,
  filterGraph,
  fitToBounds,
  hashId,
  hitTestNode,
  layoutGraph,
  loadGraphState,
  loadPositions,
  loadViewport,
  mergeProjectionPages,
  nodeTypeToken,
  nodesInBox,
  normalizeDisplayParams,
  panBy,
  persistPositions,
  persistViewport,
  prefersReducedMotion,
  relationTypeToken,
  parseGraphState,
  saveGraphState,
  screenToWorld,
  seededRandom,
  serializeGraphState,
  worldToScreen,
  zoomAt,
} from '../src/renderer/knowledge-network-interaction.ts';

const node = (id, overrides = {}) => ({ id, objectType: 'topic', weight: 1, ...overrides });
const rel = (id, from, to, relationType = 'supports') => ({ id, from, to, relationType });

// ---------------------------------------------------------------------------
// 显示参数
// ---------------------------------------------------------------------------

test('WMB-5243 UI: display params defaults fill and clamp to slider ranges', () => {
  assert.deepEqual(normalizeDisplayParams(null), DISPLAY_PARAM_DEFAULTS);
  assert.deepEqual(normalizeDisplayParams({}), DISPLAY_PARAM_DEFAULTS);
  assert.equal(normalizeDisplayParams({ nodeSize: 99 }).nodeSize, 1.6);
  assert.equal(normalizeDisplayParams({ edgeWidth: -5 }).edgeWidth, 0.5);
  assert.equal(normalizeDisplayParams({ repulsion: 1 }).repulsion, 300);
  assert.equal(normalizeDisplayParams({ linkDistance: 9999 }).linkDistance, 240);
  // 非有限值防护：NaN/Infinity 回落该键最小值。
  assert.equal(normalizeDisplayParams({ centerForce: Number.NaN }).centerForce, 0.01);
  assert.equal(normalizeDisplayParams({ nodeSize: Number.POSITIVE_INFINITY }).nodeSize, 0.6);
});

test('WMB-5243 UI: zoom clamps into [0.2, 3] and rejects NaN', () => {
  assert.equal(clampZoom(0.01), 0.2);
  assert.equal(clampZoom(10), 3);
  assert.equal(clampZoom(Number.NaN), 0.2);
});

// ---------------------------------------------------------------------------
// 力导向布局：确定性、无需手工坐标、有限边界
// ---------------------------------------------------------------------------

test('WMB-5243 UI: layout is deterministic per seed and needs no saved coordinates', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const relations = [rel('r1', 'a', 'b'), rel('r2', 'b', 'c')];
  const first = layoutGraph(nodes, relations, DISPLAY_PARAM_DEFAULTS, 42);
  const second = layoutGraph(nodes, relations, DISPLAY_PARAM_DEFAULTS, 42);
  assert.deepEqual(first.positions, second.positions);
  assert.deepEqual(first.bounds, second.bounds);
  // 每个输入 id 都有有限坐标输出。
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(Number.isFinite(first.positions[id].x), `${id}.x finite`);
    assert.ok(Number.isFinite(first.positions[id].y), `${id}.y finite`);
  }
  // 不同 seed 产生（几乎必然）不同布局 —— 布局由计算生成，不来自任何存储。
  const other = layoutGraph(nodes, relations, DISPLAY_PARAM_DEFAULTS, 7);
  const sameish = Object.keys(first.positions).every(
    (id) => first.positions[id].x === other.positions[id].x && first.positions[id].y === other.positions[id].y
  );
  assert.equal(sameish, false);
});

test('WMB-5243 UI: linkDistance and repulsion move linked/unlinked pairs directionally', () => {
  const linkedDist = (linkDistance, repulsion = DISPLAY_PARAM_DEFAULTS.repulsion, centerForce = 0.01, seed = 1) => {
    const result = layoutGraph(
      [node('a'), node('b')],
      [rel('r1', 'a', 'b')],
      { ...DISPLAY_PARAM_DEFAULTS, linkDistance, repulsion, centerForce },
      seed
    );
    return Math.hypot(
      result.positions.a.x - result.positions.b.x,
      result.positions.a.y - result.positions.b.y
    );
  };
  // 更大的连线长度 → 相连节点离得更远（方向性契约，不锁具体审美值）。
  assert.ok(linkedDist(240) > linkedDist(60), 'longer linkDistance spreads linked nodes');
  // 更强的排斥力 → 无关系节点离得更远。
  const unlinkedDist = (repulsion, seed = 1) => {
    const result = layoutGraph(
      [node('a'), node('b')],
      [],
      { ...DISPLAY_PARAM_DEFAULTS, repulsion, centerForce: 0.01 },
      seed
    );
    return Math.hypot(
      result.positions.a.x - result.positions.b.x,
      result.positions.a.y - result.positions.b.y
    );
  };
  assert.ok(unlinkedDist(2000) > unlinkedDist(300), 'stronger repulsion spreads unlinked nodes');

  const empty = layoutGraph([], [], DISPLAY_PARAM_DEFAULTS, 1);
  assert.deepEqual(empty.positions, {});
  assert.deepEqual(computeBounds({}), {
    minX: -40, minY: -40, maxX: 40, maxY: 40, width: 80, height: 80, cx: 0, cy: 0
  });
});

test('WMB-5243 UI: warm positions are honored as start but output is fully computed', () => {
  const nodes = [node('a'), node('b')];
  const warm = { a: { x: 300, y: 200 }, b: { x: 350, y: 210 } };
  const result = layoutGraph(nodes, [], DISPLAY_PARAM_DEFAULTS, 1, warm);
  // 所有输出仍为有限值；warm 参与模拟后与输入相同 seed 的结果一致。
  for (const id of ['a', 'b']) {
    assert.ok(Number.isFinite(result.positions[id].x));
    assert.ok(Number.isFinite(result.positions[id].y));
  }
  const again = layoutGraph(nodes, [], DISPLAY_PARAM_DEFAULTS, 1, warm);
  assert.deepEqual(result.positions, again.positions);
});

test('WMB-5243 UI: grid repulsion path (n > 160) runs deterministically without divergence', () => {
  const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`, { objectType: 'knowledge_note' }));
  const relations = Array.from({ length: 120 }, (_, i) => rel(`r${i}`, `n${i}`, `n${i + 1}`, 'derived_from'));
  const result = layoutGraph(nodes, relations, DISPLAY_PARAM_DEFAULTS, 3);
  assert.equal(Object.keys(result.positions).length, 200);
  let max = -Infinity;
  for (const pos of Object.values(result.positions)) {
    assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
    max = Math.max(max, Math.abs(pos.x), Math.abs(pos.y));
  }
  assert.ok(max < 1400 * 5, `no runaway: max=${max}`);
});

// ---------------------------------------------------------------------------
// 视口数学
// ---------------------------------------------------------------------------

test('WMB-5243 UI: world/screen roundtrip and pan', () => {
  const viewport = { x: 120, y: -40, zoom: 1.5 };
  const world = { x: 10, y: -20 };
  const screen = worldToScreen(world, viewport);
  assert.deepEqual(screenToWorld(screen, viewport), world);
  const panned = panBy(viewport, 8, -4);
  assert.deepEqual(panned, { x: 128, y: -44, zoom: 1.5 });
});

test('WMB-5243 UI: zoomAt keeps the anchor world point fixed', () => {
  const viewport = { x: 100, y: 50, zoom: 1 };
  const anchor = { x: 200, y: 150 };
  const next = zoomAt(viewport, anchor, 2);
  assert.equal(next.zoom, 2);
  assert.deepEqual(screenToWorld(anchor, next), screenToWorld(anchor, viewport));
  // 缩放钳制到上限。
  assert.equal(zoomAt(next, anchor, 100).zoom, 3);
});

test('WMB-5243 UI: fitToBounds centers the graph inside the container', () => {
  const positions = {
    a: { x: -100, y: -100 },
    b: { x: 100, y: 100 }
  };
  const fitted = fitToBounds(positions, { width: 800, height: 600 }, DEFAULT_VIEWPORT);
  assert.equal(fitted.zoom, 1); // 800-160 / 360 > 1，600-160 / 360 > 1 → maxZoom 1
  assert.ok(Math.abs(fitted.x - (800 / 2)) < 1);
  assert.ok(Math.abs(fitted.y - (600 / 2)) < 1);
  // 空位置表：仍安全返回居中视口（空态由 renderer 呈现，不依赖该值）。
  const emptyFit = fitToBounds({}, { width: 800, height: 600 }, DEFAULT_VIEWPORT);
  assert.ok(Number.isFinite(emptyFit.x) && Number.isFinite(emptyFit.y) && emptyFit.zoom >= MIN_ZOOM);
});

// ---------------------------------------------------------------------------
// 命中与框选
// ---------------------------------------------------------------------------

test('WMB-5243 UI: hitTestNode returns nearest node inside radius, else null', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
  const viewport = DEFAULT_VIEWPORT;
  assert.equal(hitTestNode(positions, viewport, { x: 5, y: 0 }, 10), 'a');
  assert.equal(hitTestNode(positions, viewport, { x: 95, y: 0 }, 10), 'b');
  assert.equal(hitTestNode(positions, viewport, { x: 50, y: 0 }, 10), null);
});

test('WMB-5243 UI: boxSelectHits/nodesInBox select node centers inside the screen rect', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 100 }, c: { x: 300, y: 10 } };
  const zoom = 1;
  const viewport = { x: 0, y: 0, zoom };
  assert.deepEqual(
    boxSelectHits({ left: -10, top: -10, width: 120, height: 120 }, positions, zoom, viewport),
    ['a', 'b']
  );
  assert.deepEqual(
    nodesInBox(positions, viewport, { x: -10, y: -10, width: 120, height: 120 }),
    ['a', 'b']
  );
  // 框选只依赖中心点，宽而扁的矩形不命中 y 越界的 c。
  assert.deepEqual(boxSelectHits({ left: 0, top: 0, width: 310, height: 20 }, positions, zoom, viewport), ['a', 'c']);
});

// ---------------------------------------------------------------------------
// 搜索 / 过滤
// ---------------------------------------------------------------------------

test('WMB-5243 UI: filterGraph narrows by query, node types, relation types, and endpoint survival', () => {
  const nodes = [
    { id: 'topic:a', objectType: 'topic', shortTitle: 'Alpha 主题', summary: '综合结论' },
    { id: 'knowledge_note:b', objectType: 'knowledge_note', shortTitle: 'Beta 结论', summary: '提到 alpha 词汇' },
    { id: 'knowledge_entity:c', objectType: 'knowledge_entity', shortTitle: 'Gamma 实体', summary: '' }
  ];
  const relations = [
    rel('r1', 'topic:a', 'knowledge_note:b', 'supports'),
    rel('r2', 'knowledge_note:b', 'knowledge_entity:c', 'contradicts')
  ];

  // 空过滤：全保留。
  const all = filterGraph(nodes, relations, null);
  assert.deepEqual(all.nodes.map((n) => n.id), ['topic:a', 'knowledge_note:b', 'knowledge_entity:c']);
  assert.equal(all.relations.length, 2);

  // 搜索命中 shortTitle 或 summary（大小写不敏感）。
  const byQuery = filterGraph(nodes, relations, { query: 'ALPHA' });
  assert.deepEqual(byQuery.nodes.map((n) => n.id), ['topic:a', 'knowledge_note:b']);
  assert.deepEqual(byQuery.relations.map((r) => r.id), ['r1']); // r2 端点 c 被过滤

  // 类型过滤。
  const byType = filterGraph(nodes, relations, { nodeTypes: new Set(['topic']) });
  assert.deepEqual(byType.nodes.map((n) => n.id), ['topic:a']);
  assert.equal(byType.relations.length, 0);

  // 关系语义过滤：只隐藏关系，节点仍按节点级过滤保留（Obsidian 语义）。
  const byRel = filterGraph(nodes, relations, { relationTypes: new Set(['contradicts']) });
  assert.deepEqual(byRel.relations.map((r) => r.id), ['r2']);
  assert.deepEqual(byRel.nodes.map((n) => n.id), ['topic:a', 'knowledge_note:b', 'knowledge_entity:c']);
});

// ---------------------------------------------------------------------------
// 分页合并（跨页关系集合级：每页返回同一集合关系；合并去重且不丢失）
// ---------------------------------------------------------------------------

const projectionPage = (nodes, relations) => ({ nodes, relations });

test('WMB-5243 UI: mergeProjectionPages keeps cross-page relations deduped across paged projections', () => {
  // 端点分属两页的正式关系（fixture：a1/b1 在分页边界两侧）——每页都返回同一集合关系。
  const cross = rel('r-cross', 'a1', 'b1', 'supports');
  const page1 = projectionPage([node('a1'), node('a2')], [rel('r-aa', 'a1', 'a2'), cross]);
  const page2 = projectionPage([node('b1'), node('b2')], [rel('r-bb', 'b1', 'b2'), cross]);
  const merged = mergeProjectionPages([page1, page2], 4);
  // 节点按页顺序合并不重不漏；跨页关系保留且仅一份（去重）。
  assert.deepEqual(merged.nodes.map((n) => n.id), ['a1', 'a2', 'b1', 'b2']);
  assert.equal(merged.relations.filter((r) => r.id === 'r-cross').length, 1);
  assert.deepEqual(merged.relations.map((r) => r.id).sort(), ['r-aa', 'r-bb', 'r-cross']);
});

test('WMB-5243 UI: mergeProjectionPages caps nodes at maxNodes but keeps all collection relations', () => {
  const page1 = projectionPage([node('a1'), node('a2'), node('a3')], [rel('r-cross', 'a3', 'b1')]);
  const page2 = projectionPage([node('b1'), node('b2')], [rel('r-cross', 'a3', 'b1'), rel('r-bb', 'b1', 'b2')]);
  const merged = mergeProjectionPages([page1, page2], 4);
  assert.deepEqual(merged.nodes.map((n) => n.id), ['a1', 'a2', 'a3', 'b1']);
  assert.equal(merged.relations.length, 2);
  // 空页输入安全。
  assert.deepEqual(mergeProjectionPages([], 4), { nodes: [], relations: [] });
});

// ---------------------------------------------------------------------------
// 邻接高亮
// ---------------------------------------------------------------------------

test('WMB-5243 UI: adjacencyOf returns 1-hop neighbors and touching relation ids, deduped', () => {
  const relations = [
    rel('r1', 'a', 'b'),
    rel('r2', 'b', 'c'),
    rel('r3', 'a', 'b') // 同一邻居不同关系
  ];
  assert.deepEqual(adjacencyOf(relations, 'b'), { nodeIds: ['a', 'c'], relationIds: ['r1', 'r2', 'r3'] });
  assert.deepEqual(adjacencyOf(relations, 'x'), { nodeIds: [], relationIds: [] });
});

// ---------------------------------------------------------------------------
// 分组 token（颜色由 CSS foundation token 承担，这里只保证 token 值稳定）
// ---------------------------------------------------------------------------

test('WMB-5243 UI: css/relation/node tokens are stable and fall back to default', () => {
  assert.equal(cssToken(' Supports! '), 'supports');
  assert.equal(cssToken(''), 'default');
  assert.equal(cssToken(null), 'default');
  assert.equal(relationTypeToken('supports'), 'supports');
  assert.equal(relationTypeToken('belongs_to_topic'), 'belongs_to_topic');
  assert.equal(relationTypeToken('unknown_key'), 'default');
  assert.equal(nodeTypeToken('topic'), 'topic');
  assert.equal(nodeTypeToken('knowledge_note'), 'knowledge_note');
  assert.equal(nodeTypeToken('knowledge_entity'), 'knowledge_entity');
  assert.equal(nodeTypeToken('source'), 'default');
});

test('WMB-5243 UI: seededRandom and hashId are deterministic', () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  assert.equal(a(), b());
  assert.equal(hashId('topic:x'), hashId('topic:x'));
  assert.ok(hashId('topic:x') >= 0 && hashId('topic:x') < 1);
});

// ---------------------------------------------------------------------------
// UI 状态持久化（只含视口/显示参数/过滤/布局缓存；节点坐标不是真源）
// ---------------------------------------------------------------------------

const fakeStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); }
  };
};

test('WMB-5243 UI: graph state serialize/parse roundtrips and rejects garbage', () => {
  const state = {
    viewport: { x: 10, y: 20, zoom: 1.2 },
    displayParams: { nodeSize: 1.2, edgeWidth: 1.4, repulsion: 900, centerForce: 0.06, linkDistance: 120 },
    filter: { query: 'alpha', nodeTypes: new Set(['topic']), relationTypes: new Set(['supports']) }
  };
  const json = serializeGraphState(state);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.viewport, state.viewport);
  assert.deepEqual(parsed.displayParams, state.displayParams);
  assert.deepEqual(parsed.filter.nodeTypes, ['topic']);
  assert.deepEqual(parsed.filter.relationTypes, ['supports']);
  assert.equal(parseGraphState(json).viewport.x, 10);

  assert.equal(parseGraphState('not json'), null);
  assert.equal(parseGraphState(null), null);
  assert.equal(parseGraphState('{}'), null);
  // 越界视口在解析时被钳制而不是崩溃。
  const clamped = parseGraphState(JSON.stringify({ viewport: { x: 1, y: 2, zoom: 99 } }));
  assert.equal(clamped.viewport.zoom, 3);
});

test('WMB-5243 UI: load/save with injected storage; missing keys and bad JSON return null safely', () => {
  const storage = fakeStorage();
  assert.equal(saveGraphState({ viewport: { x: 1, y: 2, zoom: 1 } }, storage), true);
  assert.deepEqual(loadGraphState(storage).viewport, { x: 1, y: 2, zoom: 1 });
  assert.equal(loadGraphState(fakeStorage()), null); // 空 storage 无状态
  assert.equal(loadGraphState(null), null); // 无 storage 环境回落 null

  assert.equal(persistViewport('vp', { x: 5, y: 6, zoom: 2 }, storage), true);
  assert.deepEqual(loadViewport('vp', storage), { x: 5, y: 6, zoom: 2 });
  assert.equal(loadViewport('missing', storage), null);

  const positions = { a: { x: 1, y: 2 }, b: { x: -3, y: 4 } };
  assert.equal(persistPositions('pos', positions, storage), true);
  assert.deepEqual(loadPositions('pos', storage), positions);
  assert.equal(loadPositions('missing', storage), null);
  // 损坏的缓存安全回落 null，不影响布局（布局永远重新计算）。
  storage.setItem('pos', '{bad');
  assert.equal(loadPositions('pos', storage), null);
});

test('WMB-5243 UI: prefersReducedMotion is safe and false outside a DOM', () => {
  assert.equal(prefersReducedMotion(), false);
});
