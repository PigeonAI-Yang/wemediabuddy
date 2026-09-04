// WMB-5243 全局 Wiki 知识网络 —— renderer 聚焦合同测试。
// 覆盖：投影纯函数（严重度/标签/问题命中/刷新合并/强调合并/刷新 scope —— 旧画布兼容层保留）
// 与渲染层合同（dataChanged 订阅替代轮询、全局网络只读投影消费、框选即 Pi 上下文、
// 单击浮卡 / 双击深链、旧创作工具台职责移除、DOM E2E selectors、键盘历史、无正式知识写入口）。
// WMB-5257：默认折叠面板、rAF/CSS 变量指针深度（无 state）、球面节点与有界深度、
// 无世界倾斜旋转、reduced-motion 中性化、仅 foundation token（见文末契约）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  changeKindLabel,
  issueTypeLabel,
  issuesForNode,
  keepSelection,
  maxIssueSeverity,
  mergeCanvasRefresh,
  mergeProjectionEmphasis,
  projectionNodeClass,
  selectionModeFor,
  severityLabel,
  severityRank,
  shouldRefreshCanvas,
} from '../src/renderer/knowledge-canvas-projection.ts';
import {
  evidenceBoundaryChips,
  evidenceBoundaryText,
  relationKeyLabel,
  sourceNatureLabel,
} from '../src/renderer/knowledge-network-format.ts';

// ---------------------------------------------------------------------------
// 纯逻辑：严重度与标签（旧画布兼容层保留）
// ---------------------------------------------------------------------------

test('WMB-5213 UI: severity rank orders info<low<medium<high<critical and unknown is lowest', () => {
  assert.ok(severityRank('info') < severityRank('low'));
  assert.ok(severityRank('low') < severityRank('medium'));
  assert.ok(severityRank('medium') < severityRank('high'));
  assert.ok(severityRank('high') < severityRank('critical'));
  assert.ok(severityRank('unknown') < severityRank('info'));
  assert.ok(severityRank(null) < severityRank('info'));
  assert.equal(severityLabel('critical'), '严重');
  assert.equal(severityLabel('high'), '高');
  assert.equal(severityLabel('medium'), '中');
  assert.equal(severityLabel('low'), '低');
  assert.equal(severityLabel('info'), '提示');
});

test('WMB-5213 UI: change kind labels cover every formal change type', () => {
  for (const kind of [
    'created', 'strengthened', 'weakened', 'contradicted', 'qualified', 'superseded',
    'merged', 'promoted', 'archived', 'rejected', 'restored', 'recompiled'
  ]) {
    assert.notEqual(changeKindLabel(kind), kind, `${kind} 需要中文标签`);
  }
  assert.equal(changeKindLabel('created'), '新增');
  assert.equal(changeKindLabel('superseded'), '被替代');
  assert.equal(changeKindLabel('relation_created'), 'relation_created');
});

test('WMB-5213 UI: issue type labels cover lint issue taxonomy', () => {
  for (const type of [
    'stale_claim', 'unresolved_contradiction', 'unsupported_claim', 'duplicate_entity',
    'duplicate_knowledge', 'orphan_knowledge', 'missing_wiki_page', 'stale_wiki_page',
    'broken_reference', 'unreturned_review', 'underperforming_method',
    'overgeneralized_global', 'unanswered_high_value_question'
  ]) {
    assert.notEqual(issueTypeLabel(type), type, `${type} 需要中文标签`);
  }
  assert.equal(issueTypeLabel('stale_claim'), '陈旧断言');
});

// ---------------------------------------------------------------------------
// 纯逻辑：健康问题 → 节点命中（与资料库/主题同一对象 ID）
// ---------------------------------------------------------------------------

const issue = (overrides = {}) => ({
  id: 'i1', issueType: 'stale_claim', severity: 'high', status: 'open',
  affectedObjectId: 'topic-1', affectedObjectType: 'topic', suggestedAction: '复核',
  ...overrides,
});

test('WMB-5213 UI: health issues match nodes by affectedObjectId across object types', () => {
  const topicNode = { id: 'node-a', objectId: 'topic-1', objectType: 'topic' };
  assert.deepEqual(issuesForNode([issue()], topicNode).map((item) => item.id), ['i1']);
  // affectedObjectType 只是提示：source 节点命中同一 objectId 也算（后端按 ID 桥接）
  assert.equal(issuesForNode([issue()], { id: 'node-b', objectId: 'topic-1', objectType: 'source' }).length, 1);
  // 无关节点不命中
  assert.equal(issuesForNode([issue()], { id: 'node-c', objectId: 'topic-9', objectType: 'topic' }).length, 0);
  // null objectId 的健康问题不命中任何节点
  assert.equal(issuesForNode([issue({ affectedObjectId: null })], topicNode).length, 0);
  // 空输入安全
  assert.equal(issuesForNode(null, topicNode).length, 0);
  assert.equal(issuesForNode([issue()], null).length, 0);
});

test('WMB-5213 UI: note nodes fall back to their own node id as identity', () => {
  const noteNode = { id: 'note-node', objectId: null, objectType: 'note' };
  assert.equal(issuesForNode([issue({ affectedObjectId: 'note-node' })], noteNode).length, 1);
  assert.equal(issuesForNode([issue({ affectedObjectId: 'other' })], noteNode).length, 0);
});

test('WMB-5213 UI: max severity picks the highest issue severity per node', () => {
  const issues = [issue({ id: 'a', severity: 'low' }), issue({ id: 'b', severity: 'critical' }), issue({ id: 'c', severity: 'medium' })];
  assert.equal(maxIssueSeverity(issues), 'critical');
  assert.equal(maxIssueSeverity([issue({ severity: 'info' })]), 'info');
  assert.equal(maxIssueSeverity([]), null);
  assert.equal(maxIssueSeverity(null), null);
});

// ---------------------------------------------------------------------------
// 纯逻辑：刷新合并与强调层（旧画布兼容层保留）
// ---------------------------------------------------------------------------

test('WMB-5213 UI: refresh merge keeps user layout x/y while adopting new object state', () => {
  const current = { id: 'c1', nodes: [{ id: 'n1', x: 10, y: 20, width: 120, height: 60, object: { title: '旧' } }] };
  const next = { id: 'c1', nodes: [{ id: 'n1', x: 999, y: 999, width: 130, height: 70, object: { title: '新' } }] };
  const merged = mergeCanvasRefresh(current, next);
  assert.equal(merged.nodes[0].x, 10);
  assert.equal(merged.nodes[0].y, 20);
  assert.equal(merged.nodes[0].width, 130);
  assert.equal(merged.nodes[0].object.title, '新');
});

test('WMB-5213 UI: projection emphasis merges changes/health/deepLink by node id without touching layout', () => {
  const canvas = { id: 'c1', nodes: [{ id: 'n1', x: 5, y: 6, revision: 2, object: { title: '主题' } }] };
  const projection = { mode: 'change', nodes: [{ id: 'n1', changes: [{ changeType: 'created' }], healthIssueIds: undefined, deepLink: { route: 'topic', objectId: 'topic-1' }, compileState: 'legacy_shell' }] };
  const merged = mergeProjectionEmphasis(canvas, projection);
  assert.equal(merged?.nodes[0].x, 5);
  assert.equal(merged?.nodes[0].changes?.length, 1);
  assert.equal(merged?.nodes[0].deepLink.route, 'topic');
  // WMB-5233：诚实三态经投影强调层合并到画布节点（空壳不显示已编译）。
  assert.equal(merged?.nodes[0].compileState, 'legacy_shell');
  assert.equal(mergeProjectionEmphasis(canvas, null), canvas);
  assert.equal(mergeProjectionEmphasis(null, projection), null);
});

test('WMB-5213 UI: refresh keeps only still-existing selection ids in order', () => {
  assert.deepEqual(
    keepSelection(['n1', 'n2', 'gone'], [{ id: 'n2' }, { id: 'n1' }]),
    ['n1', 'n2'],
  );
  assert.deepEqual(keepSelection([], [{ id: 'n1' }]), []);
  assert.deepEqual(keepSelection(['n1'], null), []);
});

test('WMB-5213 UI: selection mode rule matches onContextChange boundary', () => {
  assert.equal(selectionModeFor([]), 'current_page');
  assert.equal(selectionModeFor(['n1']), 'selected');
});

test('WMB-5213 UI: projection node class combines change and health emphasis', () => {
  assert.equal(projectionNodeClass({ id: 'n', changes: [] }), '');
  assert.equal(projectionNodeClass({ id: 'n', changes: [{ changeType: 'created' }] }), 'changed');
  assert.equal(projectionNodeClass({ id: 'n', healthIssueIds: ['i1'] }), 'has-issues');
  assert.equal(projectionNodeClass({ id: 'n', changes: [{}], healthIssueIds: ['i1'] }), 'changed has-issues');
});

test('WMB-5213 UI: dataChanged refresh scope gate matches canvas projection broadcast contract', () => {
  assert.equal(shouldRefreshCanvas(['canvas']), true);
  assert.equal(shouldRefreshCanvas(['knowledge', 'topics', 'health', 'receipt', 'library']), true);
  assert.equal(shouldRefreshCanvas(['sources']), true);
  assert.equal(shouldRefreshCanvas(['today', 'agent']), false);
  assert.equal(shouldRefreshCanvas(['proposals']), false);
  assert.equal(shouldRefreshCanvas(null), true);
});

// ---------------------------------------------------------------------------
// 纯逻辑：知识网络格式层（展示标签/证据边界文案；无 IPC/无副作用）
// ---------------------------------------------------------------------------

test('WMB-5243 UI: relation key labels cover the formal evidence/relation vocabulary', () => {
  for (const key of ['supports', 'contradicts', 'qualifies', 'derived_from', 'about', 'belongs_to_topic', 'entity_relation']) {
    assert.notEqual(relationKeyLabel(key), key, `${key} 需要中文标签`);
  }
  assert.equal(relationKeyLabel('supports'), '支持');
  assert.equal(relationKeyLabel('contradicts'), '反驳');
  // 未知 key 诚实回退原值，不造工程外标签
  assert.equal(relationKeyLabel('unknown_key'), 'unknown_key');
  assert.equal(relationKeyLabel(null), '');
});

test('WMB-5243 UI: source nature labels cover the evidence taxonomy', () => {
  for (const nature of [
    'primary_source', 'secondary_source', 'user_statement', 'user_experience',
    'business_record', 'performance_observation', 'review', 'derived_knowledge', 'ai_inference'
  ]) {
    assert.notEqual(sourceNatureLabel(nature), nature, `${nature} 需要中文标签`);
  }
  assert.equal(sourceNatureLabel('primary_source'), '一手资料');
  assert.equal(sourceNatureLabel('ai_inference'), 'AI 推断');
});

test('WMB-5243 UI: evidence boundary is a bounded chip set', () => {
  assert.deepEqual(
    evidenceBoundaryChips({ evidenceCount: 4, byRelation: { supports: 3, contradicts: 1 }, bySourceNature: { primary_source: 2, review: 2 } }),
    ['4 条依据', '支持 3', '反驳 1', '一手资料 2', '复盘 2'],
  );
  assert.deepEqual(evidenceBoundaryChips({ evidenceCount: 0, byRelation: {}, bySourceNature: {} }), []);
});

test('WMB-5243 UI: evidence boundary text is a bounded one-liner with distribution', () => {
  assert.equal(
    evidenceBoundaryText({ evidenceCount: 4, byRelation: { supports: 3, contradicts: 1 }, bySourceNature: { primary_source: 2, review: 2 } }),
    '4 条依据 · 支持 3 · 反驳 1 · 一手资料 2 · 复盘 2',
  );
  assert.equal(evidenceBoundaryText({ evidenceCount: 0, byRelation: {}, bySourceNature: {} }), '暂无依据');
  assert.equal(evidenceBoundaryText(null), '暂无依据');
});

// ---------------------------------------------------------------------------
// 渲染层合同：全局网络加载、dataChanged 订阅、框选即 Pi、浮卡深链、旧职责移除
// ---------------------------------------------------------------------------

const view = await readFile(new URL('../src/renderer/knowledge-canvas-view.tsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../src/renderer/knowledge-canvas-layout.tsx', import.meta.url), 'utf8');
const card = await readFile(new URL('../src/renderer/knowledge-network-card.tsx', import.meta.url), 'utf8');
const mainTsx = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
const format = await readFile(new URL('../src/renderer/knowledge-network-format.ts', import.meta.url), 'utf8');
const canvasCss = await readFile(new URL('../src/renderer/styles-knowledge-canvas.css', import.meta.url), 'utf8');

test('WMB-5243 UI: dataChanged subscription replaces polling; silent refresh keeps viewport and valid selection', () => {
  // 轮询不再是主路径：不再有 5000ms setInterval 整画布替换
  assert.doesNotMatch(view, /setInterval/);
  assert.doesNotMatch(view, /5000/);
  // 订阅既有 onDataChanged API；刷新 scope 门限为知识/主题/画布/健康
  assert.match(view, /window\.wmb\.onDataChanged/);
  assert.match(view, /NETWORK_REFRESH_SCOPES\.includes\(scope\)/);
  // focus 恢复是事件驱动兜底，不是轮询
  assert.match(view, /addEventListener\(['"]focus['"], refresh\)/);
  // 刷新保留仍有效的框选（按稳定节点 ID 过滤），保留视口（投影刷新不动 viewport 状态）
  assert.match(view, /setSelected\(\(current\) => current\.filter\(\(id\) => alive\.has\(id\)\)\)/);
});

test('WMB-5243 UI: view consumes the global read-only projection with composite stable ids', () => {
  assert.match(view, /getKnowledgeNetworkProjection/);
  // 分页走共享合同常量（默认页 500 / 上限 2000；每页返回同一集合级关系，跨页不丢失）
  assert.match(view, /limit: KNOWLEDGE_NETWORK_DEFAULT_LIMIT/);
  // 分页合并直到 hasMore 或上限（不 N+1：一次投影查询族）；合并按 id 去重保留跨页关系
  assert.match(view, /page\.hasMore/);
  assert.match(view, /KNOWLEDGE_NETWORK_MAX_LIMIT/);
  assert.match(view, /mergeProjectionPages/);
  // 消费共享契约类型（稳定节点 ID = objectType:objectId）
  assert.match(view, /from '\.\.\/shared\/knowledge-network'/);
  // 旧三模式投影/详情通道不再被消费
  assert.doesNotMatch(view, /getKnowledgeCanvasProjection/);
  assert.doesNotMatch(view, /getCanvasNodeDetail/);
  assert.doesNotMatch(view, /listChangeSets/);
  assert.doesNotMatch(view, /listHealthIssues/);
  assert.doesNotMatch(view, /listWikiPages/);
});

test('WMB-5243 UI: Pi context is box-selection only; never current_page full network', () => {
  // 空选择 → null；有选择 → {canvasId:'global', nodeIds, mode:'selected', title:'知识网络'}
  assert.match(view, /onContextChange\(\s*selected\.length/);
  assert.match(view, /canvasId: KNOWLEDGE_NETWORK_CANVAS_ID/);
  assert.match(view, /nodeIds: selected/);
  assert.match(view, /mode: 'selected'/);
  assert.match(view, /title: '知识网络'/);
  assert.match(view, /: null/);
  // 回调类型为兼容 main.tsx 保留 union，但发射点绝不使用 current_page 整图模式
  assert.doesNotMatch(view, /mode: 'current_page'\s*[,}]/);
  // 框选提交走 knowledge-canvas-selection 纯模块（累加 + 历史）
  assert.match(view, /accumulateBoxSelection\(current, hits, nodesRef\.current\)/);
  assert.match(view, /pushBoxSelection\(h, current, next\)/);
  assert.match(view, /invalidateRedo\(h\)/);
  assert.match(view, /undoSelectionPure\(historyRef\.current, selectedRef\.current\)/);
  assert.match(view, /redoSelectionPure\(historyRef\.current, selectedRef\.current\)/);
  // 冻结选择包提示复用既有 previewKnowledgeContextPackage（canvasId='global'，后端分支解析）
  assert.match(view, /previewKnowledgeContextPackage\(\{/);
  assert.match(view, /canvasId: KNOWLEDGE_NETWORK_CANVAS_ID/);
});

test('WMB-5243 UI: node click opens knowledge floating card with first-screen knowledge fields', () => {
  // 单击节点 → 请求知识本体详情（浮卡数据），不是固定侧栏
  assert.match(view, /getKnowledgeNetworkNodeDetail\(\{ nodeId \}\)/);
  // 浮卡段落顺序：完整认识/主题当前综合/实体核心说明 → 适用范围 → 证据边界 → 依据摘要 → 相关认识 → 最近更新
  const order = ['data-kc-card-primary', 'data-kc-card-scope', 'data-kc-card-evidence-boundary', 'data-kc-card-evidence', 'data-kc-card-related', 'data-kc-card-updated'];
  let cursor = -1;
  for (const attr of order) {
    // 用 attr + '>' 定位真实开标签，避免 evidence 与 evidence-boundary 前缀碰撞
    const index = card.indexOf(`${attr}>`);
    assert.ok(index >= 0, `${attr} 应出现在浮卡中`);
    assert.ok(index > cursor, `${attr} 顺序应在 ${order[order.indexOf(attr) - 1] ?? '卡片头部'} 之后`);
    cursor = index;
  }
  // 对象 ID/表名/ChangeSet/Receipt/编译状态/版本号不进入第一屏
  assert.doesNotMatch(card, /versionRef/);
  assert.doesNotMatch(card, /compileState/);
  assert.doesNotMatch(card, /changeSet/);
  assert.doesNotMatch(card, /receipt/);
  // 不存在固定详情侧栏（主界面只保留浮卡）
  assert.doesNotMatch(layout, /kc-detail-panel/);
  assert.doesNotMatch(layout, /kc-projection-panel/);
});


test('WMB-5243 UI: old creation-tool responsibilities are gone from the main UI', () => {
  // 新建/重命名多张画布、资产抽屉、手工节点/关系、创作简报、确认讨论按钮全部移除
  for (const symbol of [
    'createCanvas', 'renameCanvas', 'addObject', 'addNote', 'createRelation',
    'connectByKeyboard', 'beginConnection', 'removeNode', 'decideSuggestion',
    'openBriefForm', 'createOrUpdateBrief', 'confirmBriefAndCreateProject', 'setDrawer',
  ]) {
    assert.doesNotMatch(view, new RegExp(symbol));
  }
  for (const selector of [
    'kc-assets', 'kc-brief-form', 'kc-package-submit', 'kc-relation-menu',
    'kc-edge-menu', 'kc-suggestions', 'kc-drawer-backdrop', '和 Pi 讨论',
  ]) {
    assert.doesNotMatch(layout, new RegExp(selector));
  }
  // 旧画布写通道保留仅供主题页/MCP 兼容 —— 新 UI 不消费
  assert.doesNotMatch(view, /listKnowledgeCanvases/);
  assert.doesNotMatch(view, /getKnowledgeCanvas\(/);
  assert.doesNotMatch(view, /updateKnowledgeCanvas/);
  assert.doesNotMatch(view, /addKnowledgeCanvasNode/);
  assert.doesNotMatch(view, /createKnowledgeRelation/);
  assert.doesNotMatch(view, /createCreativeBrief/);
});

test('WMB-5243 UI: renderer never writes formal knowledge directly', () => {
  assert.doesNotMatch(view, /submitKnowledgeChangeSet/);
  assert.doesNotMatch(view, /applyKnowledgeChangeSet/);
});

test('WMB-5243 UI: keyboard history works card-first with editable guard', () => {
  assert.match(layout, /event\.key === 'Escape'/);
  assert.match(layout, /if \(c\.cardNodeId\)/);
  assert.match(layout, /c\.closeNodeCard\(\)/);
  assert.match(layout, /c\.onClearSelection\(\)/);
  // Ctrl+Z / Ctrl+X 历史 + Ctrl+A 全选；输入框/可编辑区有焦点时保留系统快捷键
  assert.match(layout, /event\.key\.toLowerCase\(\) === 'z'/);
  assert.match(layout, /event\.key\.toLowerCase\(\) === 'x'/);
  assert.match(layout, /event\.key\.toLowerCase\(\) === 'a'/);
  assert.match(layout, /closest\(\s*'input, textarea, select, \[contenteditable="true"\]'/);
  // 框选即 Pi：左键拖框命中后立即提交（无确认按钮）
  assert.match(layout, /onBoxSelectCommit/);
  assert.match(layout, /boxSelectHits\(/);
  // aria-live 自动刷新宣布
  assert.match(layout, /aria-live="polite"/);
  assert.match(view, /setRefreshAnnounce/);
});

test('WMB-5243 UI: DOM exposes stable E2E selectors for the knowledge network', () => {
  assert.match(layout, /data-kc-view="knowledge-network"/);
  assert.match(layout, /data-kc-canvas/);
  assert.match(layout, /data-kc-search/);
  assert.match(layout, /data-kc-type-filter/);
  assert.match(layout, /data-kc-relation-filter/);
  assert.match(layout, /data-kc-display-params/);
  assert.match(layout, /data-kc-selection-status/);
  assert.match(layout, /data-kc-selection-box/);
  assert.match(layout, /data-kc-history-undo/);
  assert.match(layout, /data-kc-history-redo/);
  assert.match(layout, /data-kc-empty-state/);
  assert.match(layout, /data-kc-error-state/);
  assert.match(layout, /data-kc-retry/);
  assert.match(layout, /data-kc-loading/);
  // 浮卡容器选择器在浮卡组件文件（布局通过 KnowledgeNetworkCard 渲染）
  assert.match(card, /data-kc-knowledge-card/);
  // 节点渲染：短标题（知识含义）而非工程标签；类型分组走 data 属性 + 语义 class
  assert.match(layout, /data-kc-node-id=\{node\.id\}/);
  assert.match(layout, /data-kc-node-type=\{node\.objectType\}/);
  assert.match(layout, /data-kc-node-title=\{node\.shortTitle\}/);
  assert.match(layout, /kn-node-label/);
  assert.match(layout, /kn-node-type/);
  assert.match(layout, /node\.shortTitle \|\| '未命名知识'/);
  // 空态引导保存资料（不引导手工建画布）
  assert.match(layout, /data-kc-empty-action/);
  assert.match(layout, /去资料库保存资料/);
});

// ---------------------------------------------------------------------------
// WMB-5255：紧凑控制面板覆盖层 + 度数圆点节点 + 标签密度 + 响应式无横向溢出
// ---------------------------------------------------------------------------

test('WMB-5255 UI: panel toggle, dot-node contract, on-demand labels, existing selectors, responsive no-overflow', () => {
  // 既有 E2E 选择器全部保留（搜索/类型/关系/显示参数/图计数）
  assert.match(layout, /data-kc-search/);
  assert.match(layout, /data-kc-type-filter/);
  assert.match(layout, /data-kc-relation-filter/);
  assert.match(layout, /data-kc-display-params/);
  assert.match(layout, /data-kc-display-reset/);
  assert.match(layout, /kc-network-meta/);

  // 面板折叠：显式开关按钮 + aria-expanded + 开合状态；默认折叠（无 matchMedia 自动展开）
  assert.match(layout, /data-kc-panel-toggle/);
  assert.match(layout, /aria-expanded=\{panelOpen\}/);
  assert.match(layout, /data-kc-panel-open=\{panelOpen \? 'true' : 'false'\}/);
  assert.match(layout, /setPanelOpen/);
  assert.doesNotMatch(layout, /matchMedia\('\(max-width: 700px\)'\)/);
  assert.match(canvasCss, /\.kc-control-panel/);
  assert.match(canvasCss, /data-kc-panel-open="false"/);
  assert.match(canvasCss, /pointer-events: none/);

  // 板面拥有剩余空间：header 之后直接是板面容器；工具条为板内覆盖
  assert.match(layout, /kc-board-tools/);
  assert.match(canvasCss, /\.kc-board-tools/);
  assert.match(canvasCss, /\.kc-network-meta/);

  // 点状节点契约：度数 → CSS 变量（TSX 钳制）+ 度数/搜索命中 data 属性（无高度数常驻标签路径）
  assert.match(layout, /'--kn-node-weight'/);
  assert.match(layout, /Math\.min\(\s*Math\.max\(/);
  assert.match(layout, /NODE_WEIGHT_CLAMP_MAX/);
  assert.match(layout, /data-kc-degree=\{/);
  assert.doesNotMatch(layout, /data-kc-high-degree/);
  assert.match(layout, /data-kc-search-match=\{/);
  assert.match(canvasCss, /--kn-node-weight/);
  assert.match(canvasCss, /\.kn-node::before\s*\{[\s\S]*border-radius: 50%/);
  // 无 pill 表面：节点本体没有圆角/阴影/背景/实心边框（显式 border: 0）
  assert.doesNotMatch(canvasCss, /\.kn-node\s*\{[^}]*border-radius/);
  assert.doesNotMatch(canvasCss, /\.kn-node\s*\{[^}]*box-shadow/);
  assert.match(canvasCss, /\.kn-node\s*\{[^}]*background: none;/);
  assert.match(canvasCss, /\.kn-node\s*\{[^}]*border: 0;/);

  // 按需标签契约：无 zoom 阈值 / 高度数 / 邻接批量揭示路径；默认 dot-only，仅精确
  // 悬停 / 键盘聚焦 / 选中 / 邻接焦点 / 搜索命中 显示；标签绝对定位、不拦指针、不改布局
  assert.doesNotMatch(layout, /data-kc-label-zoom/);
  assert.doesNotMatch(canvasCss, /data-kc-label-zoom/);
  assert.doesNotMatch(canvasCss, /\[data-kc-high-degree="true"\] \.kn-node-label/);
  assert.doesNotMatch(canvasCss, /\.kn-node\.adjacent \.kn-node-label/);
  assert.match(canvasCss, /\.kn-node \.kn-node-label\s*\{[\s\S]*display: none/);
  assert.match(canvasCss, /\.kn-node \.kn-node-label\s*\{[\s\S]*position: absolute/);
  assert.match(canvasCss, /\.kn-node \.kn-node-label\s*\{[\s\S]*pointer-events: none/);
  assert.match(canvasCss, /\.kn-node:hover \.kn-node-label/);
  assert.match(canvasCss, /\.kn-node:focus-visible \.kn-node-label/);
  assert.match(canvasCss, /\.kn-node\.selected \.kn-node-label/);
  assert.match(canvasCss, /\.kn-node\.focused \.kn-node-label/);
  assert.match(canvasCss, /\[data-kc-search-match="true"\] \.kn-node-label/);

  // 邻接变暗修复：节点与边统一 kn-dimmed 类（边在邻接聚焦时同步变暗）
  assert.match(layout, /dimmed \? 'kn-dimmed' : ''/);
  assert.match(canvasCss, /\.kn-node\.kn-dimmed/);
  assert.match(canvasCss, /line\.kn-edge\.kn-dimmed/);

  // 响应式无横向溢出：700px 断点 + 板内绝对覆盖（根 overflow hidden）
  assert.match(canvasCss, /@media \(max-width: 700px\)/);
  assert.match(canvasCss, /overflow: hidden/);
  // 新样式仅 foundation token（无裸色值；与 design-tokens-drift 门禁一致）
  assert.doesNotMatch(canvasCss, /#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/);
});

// ---------------------------------------------------------------------------
// WMB-5257：克制 2.5D 深度 —— 默认折叠面板 + rAF/CSS 变量指针深度 + 球面节点 +
// 无世界倾斜旋转 + reduced-motion 中性化 + 仅 foundation token
// ---------------------------------------------------------------------------

test('WMB-5257 UI: panel defaults collapsed; pointer depth is rAF + CSS variables with cleanup', () => {
  // 默认折叠：无歧义初始 false，无 matchMedia 响应式自动展开残留；手动开关保留
  assert.match(layout, /const \[panelOpen, setPanelOpen\] = useState\(false\)/);
  assert.doesNotMatch(layout, /matchMedia\('\(max-width: 700px\)'\)/);
  assert.match(layout, /data-kc-panel-open=\{panelOpen \? 'true' : 'false'\}/);
  assert.match(layout, /setPanelOpen\(\(open\) => !open\)/);

  // 指针深度：连续值只进 ref，单 rAF 写板面 CSS 变量（有界）；卸载/运动偏好切换取消防帧
  assert.match(layout, /pointerDepthRef/);
  assert.match(layout, /pointerFrameRef/);
  assert.match(layout, /--kn-pointer-x/);
  assert.match(layout, /--kn-pointer-y/);
  assert.match(layout, /--kn-grid-dx/);
  assert.match(layout, /--kn-grid-dy/);
  // 绑定走 React onPointerMove（跟随当前板面元素，不残留板面原生监听）；
  // 运动偏好进 ref；清理 = 取消防帧 + 解除媒体查询监听
  assert.match(layout, /onPointerMove=\{handleBoardPointerMove\}/);
  assert.match(layout, /reduceMotionRef/);
  assert.match(layout, /requestAnimationFrame\(writePointerDepth\)/);
  assert.match(layout, /cancelAnimationFrame\(pointerFrameRef\.current\)/);
  assert.match(layout, /removeEventListener\('change', onMotionChange\)/);
  assert.doesNotMatch(layout, /board\.addEventListener\('pointermove'/);
  // 连续指针值绝不进 React state
  assert.doesNotMatch(layout, /setPointer/);
  // CSS 变量有界：归一化 0..1 偏移 × 常量 → 视差 ±4/±3px 天然有界
  assert.match(layout, /\(\(x - 0\.5\) \* 8\)\.toFixed\(2\)/);
  assert.match(layout, /\(\(y - 0\.5\) \* 6\)\.toFixed\(2\)/);
});

test('WMB-5257 UI: world keeps viewport-only transform; nodes are bounded token spheres; ambience layering and reduced motion', () => {
  // .kn-world 只做视口 translate/scale：无 tilt/rotate/3D 矩阵（命中盒/框选数学不变）
  assert.match(
    layout,
    /transform: `translate\(\$\{c\.viewport\.x\}px, \$\{c\.viewport\.y\}px\) scale\(\$\{c\.viewport\.zoom\}\)`/,
  );
  assert.doesNotMatch(layout, /rotate\(|rotateX|rotateY|rotateZ|rotate3d|matrix3d/);
  assert.match(canvasCss, /\[data-kc-canvas\] \.kn-world\s*\{[\s\S]*z-index: 1/);

  // 球面材质：radial-gradient + foundation token 材质变量 + 度数派生有界深度；无节点动画
  assert.match(canvasCss, /\.kn-node::before\s*\{[\s\S]*radial-gradient/);
  assert.match(canvasCss, /--kn-node-material: var\(--accent\)/);
  assert.match(canvasCss, /--kn-node-material: var\(--grade-a\)/);
  assert.match(canvasCss, /--kn-node-material: var\(--grade-b\)/);
  assert.match(canvasCss, /--kn-node-depth: min\(/);
  assert.match(canvasCss, /--kn-node-depth\)/);
  assert.doesNotMatch(canvasCss, /\.kn-node\s*\{[^}]*animation:/);
  assert.doesNotMatch(canvasCss, /\.kn-node::before\s*\{[^}]*animation:/);
  // 悬停/聚焦上浮仅缩放（translate(-50%,-50%) 保点心固定），标签行为不变
  assert.match(canvasCss, /\.kn-node:hover::before,[\s\S]*:focus-visible::before/);
  assert.match(canvasCss, /\.kn-node:hover \.kn-node-label/);

  // 环境光：板面 ::after 非交互 + 低透明度 + 在图谱内容之下（z-index 层序）
  assert.match(canvasCss, /\[data-kc-canvas\]::after\s*\{[\s\S]*pointer-events: none/);
  assert.match(canvasCss, /\[data-kc-canvas\]::after\s*\{[\s\S]*z-index: 0/);
  assert.match(canvasCss, /\[data-kc-canvas\]::after\s*\{[\s\S]*color-mix/);

  // reduced-motion：JS 中性化 + CSS 关闭动态氛围（网格视差归零、环境光隐藏）
  assert.match(layout, /prefers-reduced-motion: reduce/);
  assert.match(
    canvasCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-kc-canvas\]\s*\{\s*background-position: 0 0/,
  );
  assert.match(
    canvasCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-kc-canvas\]::after\s*\{\s*opacity: 0/,
  );

  // 仅 foundation token：整页无裸色值（含新增径向渐变/阴影/环境光）
  assert.doesNotMatch(canvasCss, /#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/);
});
