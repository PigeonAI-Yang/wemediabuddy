// WMB-5243 全局 Wiki 知识网络 —— 节点双击 / 浮卡跳转聚焦合同测试。
// 修复最终审查 3 个 high correctness 缺口：
// 1) resolveDetailTarget 对 knowledge_object（note/entity 无独立正式页面）返回 null 时，
//    双击与跳转按钮不得静默 no-op；
// 2) 双击 note/entity → 打开/保持本体浮卡并给出可观察反馈（诚实降级，不新建路由）；
// 3) 无正式页面时跳转按钮必须存在且可观察（保留浮卡 + 反馈文案）。
// 回归：topic 双击仍深链正式主题页；Esc/空白关闭仍清卡片并清空降级反馈。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  CARD_FALLBACK_JUMP_LABEL,
  decideDetailTarget,
  NO_FORMAL_PAGE_NOTICE,
} from '../src/renderer/knowledge-network-format.ts';

// ---------------------------------------------------------------------------
// 纯决策：decideDetailTarget（knowledge-network-format.ts）
// ---------------------------------------------------------------------------

const topicLink = {
  route: 'topic',
  objectType: 'topic',
  objectId: 'topic-1',
  title: 'AI Agent 工具链',
};
const noteLink = {
  route: 'object',
  objectType: 'knowledge_note',
  objectId: 'note-1',
  title: '结论B',
};
const entityLink = {
  route: 'object',
  objectType: 'knowledge_entity',
  objectId: 'entity-1',
  title: '实体C',
};
const objectPayload = (targetType, targetId, title = '') => ({
  targetType,
  targetId,
  title,
});

test('WMB-5243 nav: topic deep link resolves to the formal topic page (double-click deep-link preserved)', () => {
  const decision = decideDetailTarget(topicLink, null);
  assert.deepEqual(decision, {
    kind: 'navigate',
    target: { type: 'topic', id: 'topic-1', title: 'AI Agent 工具链' },
  });
  // 导航目标仍是既有四种路由目标之一（不新增目标类型/路由）
  assert.deepEqual(Object.keys(decision.target).sort(), ['id', 'title', 'type']);
});

test('WMB-5243 nav: topic_wiki / source payloads reuse the existing deep-link routing', () => {
  assert.deepEqual(
    decideDetailTarget(noteLink, objectPayload('topic_wiki', 'page-9', '主题综合')),
    { kind: 'navigate', target: { type: 'topic', id: 'page-9', title: '主题综合' } },
  );
  assert.deepEqual(
    decideDetailTarget(noteLink, objectPayload('source', 'src-1', '网络资料')),
    { kind: 'navigate', target: { type: 'source', id: 'src-1', title: '网络资料' } },
  );
});

test('WMB-5243 nav: knowledge_note / knowledge_entity without formal page degrade to the ontology card with feedback', () => {
  // knowledge_object = note/entity 无独立正式页面：诚实降级、不静默、不新建路由
  for (const link of [noteLink, entityLink]) {
    const decision = decideDetailTarget(
      link,
      objectPayload('knowledge_object', link.objectId, link.title),
    );
    assert.equal(decision.kind, 'card-fallback', `${link.objectType} 应降级到浮卡`);
    if (decision.kind === 'card-fallback') {
      assert.equal(decision.notice, NO_FORMAL_PAGE_NOTICE);
      assert.ok(decision.notice.length > 0, '反馈文案不得为空');
      assert.ok(!('target' in decision), '降级决策不得携带导航目标');
    }
  }
});

test('WMB-5243 nav: missing deep link or failed resolution also degrades to the card (never silent)', () => {
  assert.equal(decideDetailTarget(null, null).kind, 'card-fallback');
  assert.equal(decideDetailTarget(noteLink, null).kind, 'card-fallback');
});

test('WMB-5243 nav: fallback copy constants are user-visible and non-empty', () => {
  assert.ok(NO_FORMAL_PAGE_NOTICE.includes('本卡'));
  assert.ok(CARD_FALLBACK_JUMP_LABEL.includes('无独立页面'));
  assert.ok(CARD_FALLBACK_JUMP_LABEL.includes('在本卡查看'));
});

// ---------------------------------------------------------------------------
// 渲染层接线：双击 / 跳转按钮 / 反馈（view / layout / card）
// ---------------------------------------------------------------------------

const view = await readFile(
  new URL('../src/renderer/knowledge-canvas-view.tsx', import.meta.url),
  'utf8',
);
const layout = await readFile(
  new URL('../src/renderer/knowledge-canvas-layout.tsx', import.meta.url),
  'utf8',
);
const card = await readFile(
  new URL('../src/renderer/knowledge-network-card.tsx', import.meta.url),
  'utf8',
);
const format = await readFile(
  new URL('../src/renderer/knowledge-network-format.ts', import.meta.url),
  'utf8',
);

test('WMB-5243 nav UI: double-click on note/entity without formal page opens/keeps the card and shows feedback', () => {
  // 深链目标存在 → 正式导航（topic 双击深链不回归）
  assert.match(view, /if \(target\) \{\s*onOpenDetail\?\.\(target\);\s*return;\s*\}/);
  // 无目标（note/entity）→ 打开/保持本体浮卡 + 可观察反馈，不静默
  assert.match(view, /void openNodeCard\(nodeId\);\s*setCardNotice\(NO_FORMAL_PAGE_NOTICE\);/);
  // 深链失败同样降级浮卡（catch 不吞）
  assert.match(
    view,
    /catch \{[\s\S]{0,120}void openNodeCard\(nodeId\);\s*setCardNotice\(NO_FORMAL_PAGE_NOTICE\);/,
  );
  // 视图消费纯决策层（resolveDetailTarget 收口）
  assert.match(view, /decideDetailTarget\(link, payload\)/);
  assert.match(view, /resolveKnowledgeDeepLink\(\{/);
});

test('WMB-5243 nav UI: jump button is never silently hidden for note/entity — fallback keeps the card and notices', () => {
  // 解析完成且无正式页面 → 浮卡展示诚实降级按钮（布局层不再静默隐藏）
  assert.match(
    layout,
    /cardJump\?\.label \?\?\s*\(c\.cardNoTarget \? CARD_FALLBACK_JUMP_LABEL : null\)/,
  );
  // 解析完成无目标 → cardNoTarget=true（浮卡进入降级态）
  assert.match(view, /if \(!target\) \{\s*setCardJump\(null\);\s*setCardNoTarget\(true\);/);
  // 点击降级按钮：无 cardJump → 保留/重开本体浮卡 + 反馈文案（非无操作）
  assert.match(
    view,
    /if \(cardJump\) \{\s*onOpenDetail\?\.\(cardJump\.target\);\s*closeNodeCard\(\);\s*return;\s*\}/,
  );
  assert.match(
    view,
    /if \(cardNodeId\) \{\s*void openNodeCard\(cardNodeId\);\s*setCardNotice\(NO_FORMAL_PAGE_NOTICE\);\s*\}/,
  );
});

test('WMB-5243 nav UI: card renders the observable feedback banner and the jump button', () => {
  assert.match(card, /notice: string \| null/);
  assert.match(card, /data-kc-card-notice/);
  assert.match(card, /role="status"/);
  assert.match(layout, /notice=\{c\.cardNotice\}/);
  assert.match(layout, /onJump=\{c\.onJumpDetail\}/);
  // 跳转按钮复用既有 data-kc-card-jump（不新增第二个按钮/路由）
  assert.match(card, /data-kc-card-jump/);
});

test('WMB-5243 nav UI: Esc and blank-click close still clear the card including fallback feedback (no regression)', () => {
  // 空白点击关闭浮卡（布局 handleBoardClick → closeNodeCard）
  assert.match(layout, /handleBoardClick[\s\S]{0,120}c\.closeNodeCard\(\);/);
  // Esc 卡片优先：有卡片先关卡，不触发清空框选
  assert.match(
    layout,
    /event\.key === 'Escape'[\s\S]{0,200}cardNodeId[\s\S]{0,160}closeNodeCard[\s\S]{0,140}onClearSelection/,
  );
  // 关闭路径同时清空跳转目标、降级态与反馈文案（打开新卡时同样清空反馈）
  assert.match(
    view,
    /setCardNodeId\(null\);[\s\S]{0,260}setCardJump\(null\);[\s\S]{0,80}setCardNoTarget\(false\);[\s\S]{0,80}setCardNotice\(null\);/,
  );
  assert.match(view, /setCardNodeId\(nodeId\);[\s\S]{0,120}setCardNotice\(null\);/);
});

test('WMB-5243 nav UI: no new routes or target types are introduced', () => {
  // CanvasDetailTarget 类型保持四种既有目标（topic/source/studio/results）
  assert.match(format, /type: 'topic' \| 'source' \| 'studio' \| 'results'/);
  // 降级决策是独立的 card-fallback 分支，不进入 onOpenDetail 路由
  assert.match(format, /kind: 'card-fallback'/);
  assert.doesNotMatch(format, /type: 'knowledge_object'/);
});
