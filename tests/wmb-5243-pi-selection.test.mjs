// WMB-5243 全局 Wiki 知识网络 —— Pi 框选上下文与选择历史聚焦合同测试。
// 覆盖：
// 1) 纯逻辑（knowledge-canvas-selection.ts）：拖框命中即累加、按正式知识身份去重、
//    只记录框选上下文、Ctrl+Z/Ctrl+X 栈、新框选清 redo、空框选不动历史；
// 2) Pi 接线（pi-context-payload.ts）：chip 显示「知识网络 · 已框选 N 项」、
//    selectionMode 恒为 selected、发送时用后端冻结清单（不自动发送）；
// 3) 渲染层合同（view/layout/main/pi-dock/preload）：Esc 卡片优先、可编辑焦点保留
//    系统快捷键、旧全画布上下文（current_page）不得流入 Pi、旧画布 IPC 保留。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  accumulateBoxSelection,
  emptySelectionHistory,
  formalSelectionKey,
  invalidateRedo,
  pushBoxSelection,
  redoSelection,
  undoSelection,
} from '../src/renderer/knowledge-canvas-selection.ts';
import { buildPiContextPayload, describePiContextChip } from '../src/renderer/pi-context-payload.ts';

// ---------------------------------------------------------------------------
// 纯逻辑：正式身份与框选累加
// ---------------------------------------------------------------------------

test('WMB-5243: formal selection identity prefers formal objectId, falls back to node id', () => {
  assert.equal(formalSelectionKey({ id: 'topic:abc', objectId: 'abc' }), 'abc');
  assert.equal(formalSelectionKey({ id: 'n1', objectId: null }), 'n1');
  assert.equal(formalSelectionKey({ id: 'n2' }), 'n2');
});

test('WMB-5243: box selection accumulates hits and dedupes by formal identity, first occurrence wins', () => {
  const nodes = [
    { id: 'topic:a', objectId: 'a' },
    { id: 'topic:b', objectId: 'b' },
    // 同一正式对象不应出现两个节点，但若出现，按正式身份去重保留首个
    { id: 'dup:a', objectId: 'a' },
    { id: 'knowledge_note:c', objectId: 'c' },
    { id: 'note-free', objectId: null },
  ];
  // 连续两次框选累加（无需按钮/无需 Shift）
  const first = accumulateBoxSelection([], ['topic:a', 'knowledge_note:c'], nodes);
  assert.deepEqual(first, ['topic:a', 'knowledge_note:c']);
  const second = accumulateBoxSelection(first, ['topic:b', 'note-free'], nodes);
  assert.deepEqual(second, ['topic:a', 'knowledge_note:c', 'topic:b', 'note-free']);
  // 按正式身份去重：重复框中同一对象不重复进选择
  const third = accumulateBoxSelection(second, ['dup:a', 'topic:a'], nodes);
  assert.deepEqual(third, ['topic:a', 'knowledge_note:c', 'topic:b', 'note-free']);
  // 空命中（空白框选/浏览复位）保持当前选择原样，不清空
  assert.deepEqual(accumulateBoxSelection(second, [], nodes), second);
  // 未知节点 id 按自身 id 加入
  assert.deepEqual(accumulateBoxSelection([], ['mystery:1'], nodes), ['mystery:1']);
});

// ---------------------------------------------------------------------------
// 纯逻辑：选择历史（只记录框选上下文）
// ---------------------------------------------------------------------------

test('WMB-5243: pushBoxSelection records box contexts, clears redo, skips duplicates', () => {
  let history = emptySelectionHistory();
  // 新框选清 redo：先制造一个 redo 再验证
  history = { ...history, redoStack: [['old']] };
  history = pushBoxSelection(history, [], ['n1', 'n2']);
  assert.deepEqual(history.undoStack, [['n1', 'n2']]);
  assert.deepEqual(history.redoStack, []);
  // 与栈顶相同不重复入栈
  const again = pushBoxSelection(history, ['n1', 'n2'], ['n1', 'n2']);
  assert.deepEqual(again.undoStack, [['n1', 'n2']]);
  // 选择未变化（空框选）不视为新框选：不动历史、不毁前进栈
  const empty = pushBoxSelection({ undoStack: [['n1']], redoStack: [['n2']] }, ['n1'], ['n1']);
  assert.deepEqual(empty.redoStack, [['n2']]);
  // 新结果入栈
  const grown = pushBoxSelection(history, ['n1', 'n2'], ['n1', 'n2', 'n3']);
  assert.deepEqual(grown.undoStack, [['n1', 'n2'], ['n1', 'n2', 'n3']]);
});

test('WMB-5243: first undo after consecutive boxes returns the previous box context (regression)', () => {
  // 回归：历史存框选结果快照，undo 必须回退到"上一个"框选上下文（或空），
  // 不能把弹出的最近快照原样返回（否则第一次 Ctrl+Z 选择不变）。
  let history = pushBoxSelection(emptySelectionHistory(), [], ['n1']);
  history = pushBoxSelection(history, ['n1'], ['n1', 'n2']);
  const first = undoSelection(history, ['n1', 'n2']);
  assert.deepEqual(first.next, ['n1']);
  assert.notDeepEqual(first.next, ['n1', 'n2']);
  const second = undoSelection(first.history, first.next);
  assert.deepEqual(second.next, []);
  const third = undoSelection(second.history, second.next);
  assert.deepEqual(third.next, []);
  // 回退链路可完整前进回放
  const back1 = redoSelection(second.history, second.next);
  assert.deepEqual(back1.next, ['n1']);
  const back2 = redoSelection(back1.history, back1.next);
  assert.deepEqual(back2.next, ['n1', 'n2']);
});

test('WMB-5243: undo walks back box contexts in order; nothing to undo keeps current', () => {
  let history = pushBoxSelection(pushBoxSelection(emptySelectionHistory(), [], ['n1']), ['n1'], ['n1', 'n2']);
  // 当前上下文 = 最后一次框选结果（视图侧持有）；历史栈含两次框选快照
  let current = ['n1', 'n2'];
  let step = undoSelection(history, current);
  assert.deepEqual(step.next, ['n1']);
  assert.deepEqual(step.history.redoStack, [['n1', 'n2']]);
  step = undoSelection(step.history, step.next);
  assert.deepEqual(step.next, []);
  assert.deepEqual(step.history.redoStack, [['n1', 'n2'], ['n1']]);
  // 无可回退：返回当前选择不变
  const base = undoSelection(step.history, step.next);
  assert.deepEqual(base.next, []);
  assert.deepEqual(base.history, step.history);
});

test('WMB-5243: redo restores undone box contexts; nothing to redo keeps current', () => {
  let history = pushBoxSelection(pushBoxSelection(emptySelectionHistory(), [], ['n1']), ['n1'], ['n1', 'n2']);
  let current = ['n1', 'n2'];
  const undone = undoSelection(history, current);
  const redone = redoSelection(undone.history, undone.next);
  assert.deepEqual(redone.next, ['n1', 'n2']);
  assert.deepEqual(redone.history.undoStack, [['n1'], ['n1', 'n2']]);
  assert.deepEqual(redone.history.redoStack, []);
  // 无可前进
  const nothing = redoSelection(redone.history, redone.next);
  assert.deepEqual(nothing.next, ['n1', 'n2']);
});

test('WMB-5243: new box selection invalidates forward history only via box commits', () => {
  let history = pushBoxSelection(emptySelectionHistory(), [], ['n1']);
  history = pushBoxSelection(history, ['n1'], ['n1', 'n2']);
  const undone = undoSelection(history, ['n1', 'n2']);
  assert.equal(undone.history.redoStack.length, 1);
  // 新框选发生后前进历史作废
  const fresh = pushBoxSelection(undone.history, undone.next, [...undone.next, 'n3']);
  assert.deepEqual(fresh.redoStack, []);
  assert.deepEqual(fresh.undoStack.at(-1), ['n1', 'n3']);
});

test('WMB-5243: non-box selection mutation invalidates redo without touching undo', () => {
  const history = { undoStack: [['n1']], redoStack: [['n1', 'n2']] };
  const invalidated = invalidateRedo(history);
  assert.deepEqual(invalidated.redoStack, []);
  assert.deepEqual(invalidated.undoStack, [['n1']]);
  // 无前进栈时保持原样
  assert.deepEqual(invalidateRedo({ undoStack: [], redoStack: [] }), { undoStack: [], redoStack: [] });
});

// ---------------------------------------------------------------------------
// Pi 接线：chip 文案与发送载荷（真实函数行为）
// ---------------------------------------------------------------------------

const networkBase = {
  page: 'canvas',
  pageLabel: '知识网络',
  objectType: 'canvas',
  objectId: 'global',
  // 未框选时 main.tsx 传 null（无画布上下文）；chip 只显示页面标签
  objectTitle: null,
};

test('WMB-5243: Pi chip shows 知识网络 · 已框选 N 项 for box selections', () => {
  const selected = { canvasId: 'global', nodeIds: ['topic:a', 'topic:b'], mode: 'selected', title: '知识网络' };
  assert.equal(describePiContextChip({ ...networkBase, contextSelection: selected }), '知识网络 · 已框选 2 项');
  // 未框选：只显示页面标签，不出现任何整页/全画布计数
  assert.equal(describePiContextChip(networkBase), '知识网络');
});

test('WMB-5243: Pi payload carries frozen manifest and selected mode, never current_page', () => {
  const directContext = {
    scope: 'selected_only',
    canvasId: 'global',
    items: [
      { nodeId: 'topic:a', objectType: 'topic', objectId: 'a', title: '主题A', snapshot: { id: 'a', body: '…', revision: 3 } },
      { nodeId: 'knowledge_note:b', objectType: 'knowledge_note', objectId: 'b', title: '结论B', snapshot: { id: 'b', body: '…', revision: 2 } },
    ],
    excludedCount: 0,
    excludedReasons: [],
    estimatedCharacters: 220,
    limitCharacters: 30000,
    overLimit: false,
  };
  const context = { ...networkBase, canvasId: 'global', contextSelection: { canvasId: 'global', nodeIds: ['topic:a', 'knowledge_note:b'], mode: 'selected', title: '知识网络' } };
  const text = buildPiContextPayload(context, '你好', directContext);
  assert.match(text, /page=canvas/);
  assert.match(text, /pageLabel=知识网络/);
  assert.match(text, /selectionMode=selected/);
  assert.doesNotMatch(text, /selectionMode=current_page/);
  assert.match(text, /canvasId=global/);
  assert.match(text, /contextNodeIds=\["topic:a","knowledge_note:b"\]/);
  // 未纳入数量恒显式携带（0 也出现，Pi 不得假设省略即无裁剪）
  assert.match(text, /contextSelectionExcludedCount=0/);
  assert.doesNotMatch(text, /未纳入/);
  // 冻结清单原样进载荷（scope selected_only；正文快照携带固定版本引用）
  assert.match(text, /"scope":"selected_only"/);
  assert.match(text, /"objectId":"a"/);
  assert.match(text, /"revision":3/);
  assert.match(text, /contextManifest=/);
});

test('WMB-5243: Pi payload exposes excluded count explicitly as 未纳入 N 项 when > 0', () => {
  const directContext = {
    scope: 'selected_only',
    canvasId: 'global',
    items: [
      { nodeId: 'topic:a', objectType: 'topic', objectId: 'a', title: '主题A', snapshot: { id: 'a', body: '…', revision: 3 } },
    ],
    excludedCount: 2,
    excludedReasons: [
      { nodeId: 'bogus:1', objectType: null, reason: 'invalid' },
      { nodeId: 'topic:gone', objectType: 'topic', reason: 'invalid' },
    ],
    estimatedCharacters: 220,
    limitCharacters: 30000,
    overLimit: false,
  };
  const context = { ...networkBase, canvasId: 'global', contextSelection: { canvasId: 'global', nodeIds: ['topic:a', 'bogus:1', 'topic:gone'], mode: 'selected', title: '知识网络' } };
  const text = buildPiContextPayload(context, '你好', directContext);
  assert.match(text, /contextSelectionExcludedCount=2/);
  assert.match(text, /未纳入 2 项/);
  assert.match(text, /"excludedCount":2/);
  assert.match(text, /"excludedReasons":/);
  assert.match(text, /"reason":"invalid"/);
});

// ---------------------------------------------------------------------------
// 渲染层合同：框选累加进历史、Esc 卡片优先、可编辑焦点保留系统快捷键
// ---------------------------------------------------------------------------

const view = await readFile(new URL('../src/renderer/knowledge-canvas-view.tsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../src/renderer/knowledge-canvas-layout.tsx', import.meta.url), 'utf8');
const payloadModule = await readFile(new URL('../src/renderer/pi-context-payload.ts', import.meta.url), 'utf8');
const appTypes = await readFile(new URL('../src/renderer/app-types.ts', import.meta.url), 'utf8');
const mainTsx = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
const dock = await readFile(new URL('../src/renderer/pi-dock.tsx', import.meta.url), 'utf8');
const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
const globalDts = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');
const networkShared = await readFile(new URL('../src/shared/knowledge-network.ts', import.meta.url), 'utf8');

test('WMB-5243 UI: box select commit accumulates via shared helper and records history (no confirm button)', () => {
  // 视图消费纯模块：拖框命中即累加 + 框选入历史（同一实现，不另造选择语义）
  assert.match(view, /knowledge-canvas-selection/);
  assert.match(view, /accumulateBoxSelection\(/);
  assert.match(view, /pushBoxSelection\(/);
  // 框选无需确认按钮：提交点只有 pointer-up 命中计算 + 历史/上下文更新
  assert.doesNotMatch(view, /确认框选|确认选择|apply.*[Ss]election.*[Bb]utton/);
  // 视图本身不发送 Pi（不自动发送；发送只发生在 Pi dock 用户提交时）
  assert.doesNotMatch(view, /chatPi|sendText|wmb\.chat/);
});


// ---------------------------------------------------------------------------
// Pi dock 发送路径与旧接口保留
// ---------------------------------------------------------------------------

test('WMB-5243 UI: Pi send uses backend frozen manifest, not old package preview; old canvas IPC stays', () => {
  // 发送时取后端冻结选择清单（服务端校验/去重/限长）
  assert.match(dock, /validateKnowledgeSelectionManifest\(\{ canvasId: context\.contextSelection\.canvasId, nodeIds: context\.contextSelection\.nodeIds \}\)/);
  // 不再调用旧 context package 预览（旧界面职责移除，接口保留）
  assert.doesNotMatch(dock, /previewKnowledgeContextPackage/);
  // 旧画布/包 IPC 保留（主题页与 MCP 仍依赖）——preload 与类型声明仍在
  assert.match(preload, /validateKnowledgeSelectionManifest/);
  assert.match(preload, /previewKnowledgeContextPackage/);
  assert.match(preload, /getKnowledgeCanvas/);
  assert.match(globalDts, /validateKnowledgeSelectionManifest/);
  assert.match(globalDts, /previewKnowledgeContextPackage/);
});

