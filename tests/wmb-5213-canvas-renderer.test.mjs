// WMB-5213 关系画布三模式投影 —— renderer 聚焦合同测试。
// 覆盖：投影纯函数（严重度/标签/问题命中/刷新合并/强调合并/刷新 scope）
// 与渲染层合同（dataChanged 订阅替代轮询、刷新保留 selection/viewport/drawer/连接编辑、
// 三模式切换、正式详情深链、selected-only 动作清单、无平行对象 CRUD、键盘/aria/reduced-motion）。
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

// ---------------------------------------------------------------------------
// 纯逻辑：严重度与标签
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
// 纯逻辑：刷新合并与强调层（刷新保留交互状态的关键）
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
// 渲染层合同：dataChanged 订阅替代轮询、刷新不丢交互状态
// ---------------------------------------------------------------------------

const view = await readFile(new URL('../src/renderer/knowledge-canvas-view.tsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../src/renderer/knowledge-canvas-layout.tsx', import.meta.url), 'utf8');
const relations = await readFile(new URL('../src/renderer/knowledge-canvas-relations.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/renderer/styles-knowledge.css', import.meta.url), 'utf8');
const mainTsx = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
const projectionModule = await readFile(new URL('../src/renderer/knowledge-canvas-projection.ts', import.meta.url), 'utf8');

test('WMB-5213 UI: dataChanged subscription replaces the 5s poll as primary path', () => {
  // 轮询不再是主路径：不再有 5000ms setInterval 整画布替换
  assert.doesNotMatch(view, /setInterval/);
  assert.doesNotMatch(view, /5000/);
  // 订阅既有 onDataChanged API（scope 名由 CanvasProjection 后端广播约定）
  assert.match(view, /window\.wmb\.onDataChanged/);
  assert.match(view, /shouldRefreshCanvas\(event\.scopes\)/);
  // focus 恢复是事件驱动兜底，不是轮询
  assert.match(view, /window\.addEventListener\("focus", refresh\)/);
});

test('WMB-5213 UI: refresh merges new state while preserving selection/viewport/drawer/connection editing', () => {
  assert.match(view, /mergeCanvasRefresh\(current, next\)/);
  assert.match(view, /keepSelection\(current, next\.nodes\)/);
  assert.match(view, /setConnecting\(\(current\) =>/);
  assert.match(view, /setPendingRelation\(\(current\) =>/);
  assert.match(view, /setKeyboardConnectionSource\(\(current\) =>/);
  assert.match(view, /setSelectedRelation\(\(current\) =>/);
  // 静默刷新不重设 viewport 滚动（preserveViewport 只在画布切换时应用服务端 viewport）
  assert.match(view, /options\.preserveViewport/);
  assert.match(view, /boardRef\.current\.scrollLeft = next\.viewportX/);
  // drawer 与详情在刷新期间保持打开（detailNodeId 仍在画布中时重取详情）
  assert.match(view, /detailNodeId && next\.nodes\.some/);
});

test('WMB-5213 UI: three projection modes share one object identity and fetch the projection envelope', () => {
  assert.match(view, /useState<KnowledgeCanvasProjectionMode>\("relation"\)/);
  assert.match(view, /getKnowledgeCanvasProjection\(\{/);
  assert.match(view, /mode: projectionMode/);
  assert.match(view, /changeSetId:\s*$/m);
  assert.match(view, /projectionMode === "change" && selectedChangeSetId/);
  assert.match(layout, /role="tablist"/);
  assert.match(layout, /aria-label="画布投影模式"/);
  assert.match(layout, /role="tab"/);
  assert.match(layout, /aria-selected=\{projectionMode === value\}/);
  assert.match(layout, /projection-?change|projection-\$\{projectionMode\}/);
  assert.match(layout, /变化/);
  assert.match(layout, /健康/);
  // 同一对象身份：强调层叠加在既有节点上，不建第二份节点身份
  assert.match(view, /mergeProjectionEmphasis\(canvas, projection\)/);
});

test('WMB-5213 UI: change mode highlights nodes accurately from backend projection changes', () => {
  assert.match(layout, /Array\.isArray\(node\.changes\) && node\.changes\.length/);
  assert.match(layout, /changeKindLabel\(change\.changeType\)/);
  assert.match(layout, /kc-change-list/);
  assert.match(layout, /selectChangeSet\(item\.id\)/);
  assert.match(view, /listChangeSets\(\{ limit: 20 \}\)/);
});

test('WMB-5213 UI: health mode projects issues with the same object ids as library', () => {
  assert.match(layout, /kc-health-list/);
  assert.match(layout, /issueTypeLabel\(issue\.issueType\)/);
  assert.match(layout, /severityRank\(b\.severity\) - severityRank\(a\.severity\)/);
  assert.match(layout, /matchedNodeId/);
  assert.match(view, /listHealthIssues\(\{ limit: 100 \}\)/);
  assert.match(view, /listWikiPages\(\{ limit: 100 \}\)/);
  // 健康问题与资料库同一对象 ID：按 affectedObjectId 命中画布节点
  assert.match(view, /issuesForNode\(knowledgeOverview\.issues, node\)/);
});

test('WMB-5213 UI: node detail opens formal page deep links mapped to existing navigation', () => {
  assert.match(view, /getCanvasNodeDetail\(\{/);
  assert.match(view, /setDrawer\("detail"\)/);
  assert.match(view, /deepLinkTarget = \(/);
  assert.match(view, /wiki\?\.subjectType === "topic" && wiki\.subjectId/);
  assert.match(layout, /kc-detail-jump/);
  assert.match(layout, /在主题中打开/);
  assert.match(layout, /在资料库中打开/);
  // main.tsx 接线：画布跳转复用既有 openTopic / libraryFocusSourceId / studio 模式
  assert.match(mainTsx, /onOpenDetail=\{\(target\) =>/);
  assert.match(mainTsx, /target\.type === 'topic' && target\.id\) openTopic\(target\.id\)/);
  assert.match(mainTsx, /libraryFocusSourceId/);
});

// WMB-5233：空壳诚实三态（uncompiled / legacy_shell / compiled）在画布节点与详情如实表达，
// 空壳（legacy 初始页）绝不显示“已编译/当前”；标签与 chip 全 token。
test('WMB-5233 UI: canvas shows honest compile state and never current for empty shells', () => {
  // 节点 chip：compileState 优先，回退 compileStatus 旧行为。
  assert.match(layout, /compileStateLabel\(status\.compileState\)/);
  assert.match(layout, /compile-state-\$\{status\.compileState\}/);
  assert.match(view, /node\.compileState/);
  // 详情面板：legacy_shell 显示「初始档案（历史初始化，尚无采纳知识）」而非「当前」。
  assert.match(layout, /初始档案（历史初始化，尚无采纳知识）/);
  assert.match(layout, /已编译 · 当前/);
  // 标签函数与 chip 样式走既有 token（无裸色旁路）。
  assert.match(projectionModule, /legacy_shell: '初始档案'/);
  assert.match(css, /\.kc-compile\.compile-state-legacy_shell\{/);
  assert.match(css, /\.kc-compile\.compile-state-uncompiled\{/);
  assert.doesNotMatch(css, /\.kc-compile\.compile-state-.*#[0-9a-fA-F]{3,6}/);
});

test('WMB-5213 UI: selected-only action list shows the exact manifest passed to backend', () => {
  assert.match(view, /validateKnowledgeSelectionManifest\(\{ canvasId: canvas\.id, nodeIds \}\)/);
  assert.match(layout, /selected-only · \{manifest\.items\.length\} 个正式对象/);
  assert.match(layout, /kc-selection-manifest/);
  assert.match(layout, /实际传入对象/);
  assert.match(layout, /manifest\.overLimit/);
  // 创作动作使用同一份 nodeIds（与 Pi 边界一致；无平行对象 CRUD）
  assert.match(view, /createCreativeBrief\(\{/);
  assert.match(view, /selectionMode: selectionModeFor\(selectedRef\.current\)/);
  assert.match(view, /updateCreativeBrief\(\{/);
  assert.match(view, /getCreativeBriefForContext\(\{/);
  assert.match(view, /createProjectFromBrief\(\{/);
});

test('WMB-5213 UI: delete stays canvas-only; renderer never writes formal knowledge directly', () => {
  // UI 删除仍只删除画布节点引用
  assert.match(view, /removeKnowledgeCanvasNode\(\{/);
  assert.match(layout, /删除节点只移除画布引用，不会删除正式知识/);
  // 画布视图不得出现正式知识写入口（唯一正式写经 applyKnowledgeChangeSet 由后台/编译器执行）
  assert.doesNotMatch(view, /submitKnowledgeChangeSet/);
  assert.doesNotMatch(view, /applyKnowledgeChangeSet/);
});

test('WMB-5213 UI: keyboard reachable for modes, detail, and existing canvas shortcuts', () => {
  assert.match(layout, /event\.key === "Escape"/);
  assert.match(layout, /event\.key === "Delete"/);
  assert.match(layout, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(layout, /aria-label=\{`查看 \$\{node\.object\.title\} 的正式详情`\}/);
  assert.match(layout, /connectByKeyboard\(node\)/);
  // 自动刷新 aria-live 简短宣布，不重置焦点
  assert.match(layout, /aria-live="polite"/);
  assert.match(view, /setRefreshAnnounce/);
});

test('WMB-5213 UI: change highlight transitions honor reduced motion and theme tokens', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.kc-node\.changed/);
  assert.match(css, /200ms ease/);
  const section = css.slice(css.indexOf('/* ============ WMB-5213'));
  // 新视觉规则只用主题 token，不出现裸色值旁路
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,6}/);
  assert.doesNotMatch(section, /rgb\(\s*\d+\s+\d+\s+\d+\s*\)/);
});
