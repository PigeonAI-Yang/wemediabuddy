// 关系画布 surface Electron E2E scenarios (WMB-5243, journey matrix CV-001..CV-008).
//
// 全部按 WMB-5243 新合同断言（tests/e2e/user-journeys.json canvas 页）：
// 打开即全局 Wiki 知识网络（无画布创建）、知识短标题节点 + 正式关系连线、
// 单击浮卡（知识本体第一屏，无工程字段）/ 空白关闭 / 双击深链、
// 拖框即 Pi 上下文（累加去重、chip「知识网络 · 已框选 N 项」、不自动发送）、
// Esc/Ctrl+Z/Ctrl+X 严格历史、搜索/过滤/显示参数/缩放/邻接高亮与刷新保留、
// 空态引导保存资料、加载失败重试、上下文预算超限明示。
// Real Electron + isolated workspace（production pipeline 种子）。

import { helpers } from './harness.mjs';
import { seedRichKnowledge, seedLongNotes } from './fixture-knowledge.mjs';

const { assert, step, waitForAppReady, navigateTo, delay, openReadOnlyDb } = helpers;

const RICH = { seedFixture: async (ws) => seedRichKnowledge(ws.dataRoot, ws.workspaceId) };

const ENGINEERING_PATTERN = /knowledge_notes|knowledge_entities|change_set|receipt|revision|compile_state|note-[a-z0-9]{10,}|ent-[a-z0-9]{10,}/i;

async function waitForNetwork(page, { nodes = 1, timeoutMs = 30_000 } = {}) {
  await page.locator('[data-kc-view="knowledge-network"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(
    (min) => document.querySelectorAll('.kn-node').length >= min,
    nodes,
    { timeout: timeoutMs }
  );
}

/**
 * 等布局稳定：启动时窗口 focus 会触发一次静默投影刷新，布局以 warm 位置重算，
 * 节点屏幕位置会小幅移动。交互（单击/悬停/双击）必须在布局稳定后进行，
 * 否则点击点可能命中移动前的旧位置（节点重叠拦截）。
 */
async function waitForLayoutSettle(page, { timeoutMs = 15_000 } = {}) {
  let last = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => document.querySelector('.kn-world')?.style.transform ?? '');
    if (last !== null && now === last) return;
    last = now;
    await delay(250);
  }
}

/**
 * 等目标节点的中心点真正可命中（顶层元素即该节点）：力导向布局中节点可能互相遮挡，
 * 只有目标节点自身处于顶层时才点击/悬停，避免命中相邻节点。
 */
async function waitForNodeHitTestable(page, title, { timeoutMs = 15_000 } = {}) {
  await page.waitForFunction((t) => {
    const el = document.querySelector(`[data-kc-node-title="${t}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit?.closest?.('.kn-node')?.getAttribute('data-kc-node-title') === t;
  }, title, { timeout: timeoutMs });
}

/** 找一个不落在任何节点/连线/浮层上的板内点（框选起点 / 空白点击）。 */
function emptyBoardPoint(page) {
  return page.evaluate(() => {
    const board = document.querySelector('[data-kc-canvas]');
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.kn-node')].map((el) => el.getBoundingClientRect());
    const occupied = (x, y) => nodes.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
    const onTopElement = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return true;
      return Boolean(el.closest?.('.kn-node, [data-kc-edge], .kc-selection-box, .kn-knowledge-card, .kc-selection-bar'));
    };
    for (let i = 14; i < rect.width - 14; i += 28) {
      for (let j = 14; j < rect.height - 14; j += 28) {
        const x = rect.left + i;
        const y = rect.top + j;
        if (!occupied(x, y) && !onTopElement(x, y)) return { x, y };
      }
    }
    return { x: rect.left + 14, y: rect.top + 14 };
  });
}

/** 整板拖框（命中当前可见的全部节点中心）。 */
async function fullBoardDrag(page) {
  const board = await page.locator('[data-kc-canvas]').boundingBox();
  assert(board, '画布板不存在');
  const start = await emptyBoardPoint(page);
  assert(start, '找不到空白起点');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width - 14, board.y + board.height - 14, { steps: 12 });
  await page.mouse.up();
}

async function selectionCount(page) {
  const el = await page.locator('[data-kc-selection-count]').count();
  if (!el) return 0;
  const text = await page.locator('[data-kc-selection-count]').textContent();
  const match = /已框选 (\d+) 项/.exec(text ?? '');
  return match ? Number(match[1]) : 0;
}

async function piChipText(page) {
  const chip = page.locator('.pi-context-chip span');
  if (await chip.count() === 0) return '';
  return (await chip.textContent()) ?? '';
}

async function focusBoard(page) {
  await page.evaluate(() => document.querySelector('[data-kc-canvas]')?.focus());
}

export default [
  {
    id: 'CV-001-canvas-network-normal',
    journeyIds: ['CV-001-canvas-network-normal'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '打开关系画布直接渲染全局知识网络', async () => {
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 8 });
        await waitForLayoutSettle(page);
        const meta = await page.locator('.kc-network-meta').textContent();
        assert(meta.includes('8 个节点') && meta.includes('3 条关系'), `网络元信息错误：${meta}`);
      });
      await step(evidence, '节点为知识短标题且类型仅三类，Source 不常驻', async () => {
        const types = new Set(await page.locator('.kn-node').evaluateAll((els) => els.map((el) => el.getAttribute('data-kc-node-type'))));
        for (const t of ['topic', 'knowledge_note', 'knowledge_entity']) assert(types.has(t), `缺节点类型 ${t}`);
        assert(!types.has('source'), 'Source 不应作为常驻节点');
        const titles = await page.locator('.kn-node .kn-node-label').allTextContents();
        for (const t of ['AI Agent 工具链', 'AgentForge v2 支持多模型路由', 'AgentForge']) {
          assert(titles.includes(t), `缺知识短标题节点「${t}」，实际 ${JSON.stringify(titles)}`);
        }
        assert(!titles.some((t) => /知识结论 \d+|主题 \d+|实体 \d+/.test(t)), '节点不应显示工程编号标签');
        // 连线投影正式关系
        const edges = await page.locator('[data-kc-edge]').count();
        assert(edges >= 3, `正式关系连线应 ≥3，实际 ${edges}`);
        const relTypes = new Set(await page.locator('[data-kc-edge]').evaluateAll((els) => els.map((el) => el.getAttribute('data-kc-rel-type'))));
        assert(relTypes.has('about') && relTypes.has('applies_to') && relTypes.has('contradicts'), `缺关系类型：${[...relTypes].join(',')}`);
      });
      await step(evidence, '无旧手工画布/创作工具台职责 UI', async () => {
        const bodyText = await page.evaluate(() => document.querySelector('[data-kc-view="knowledge-network"]')?.textContent ?? '');
        for (const banned of ['新建画布', '和 Pi 讨论', '重命名', '资产抽屉', '变化投影', '健康投影', '生成简报']) {
          assert(!bodyText.includes(banned), `旧职责 UI 不应出现「${banned}」`);
        }
        assert(await page.locator('.kc-modes, .kc-detail-panel, .kc-assets, .kc-brief-form').count() === 0, '旧画布 DOM 不应渲染');
      });
      return { surface: 'canvas', journey: 'CV-001', nodes: 8, relations: 3, types: ['topic', 'knowledge_note', 'knowledge_entity'] };
    }
  },
  {
    id: 'CV-002-canvas-node-card',
    journeyIds: ['CV-002-canvas-node-card'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '单击节点打开邻近浮层知识卡', async () => {
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 8 });
        await waitForLayoutSettle(page);
        await waitForNodeHitTestable(page, 'AI Agent 工具链');
        await page.locator('[data-kc-node-title="AI Agent 工具链"]').click();
        await page.locator('[data-kc-knowledge-card]').waitFor({ state: 'visible', timeout: 20_000 });
        const cardText = await page.locator('[data-kc-knowledge-card]').textContent();
        assert(cardText.includes('主题当前综合'), '主题卡第一屏应含 主题当前综合');
        assert(cardText.includes('多模型路由'), '主题卡应展示用户知识正文');
        assert(await page.locator('[data-kc-card-scope]').count() === 1, '应有 适用范围 区');
        assert(await page.locator('[data-kc-card-evidence-boundary]').count() === 1, '应有 证据边界 区');
        assert(await page.locator('[data-kc-card-evidence]').count() === 1, '应有 依据摘要 区');
        assert(await page.locator('[data-kc-card-updated]').count() === 1, '应有 最近更新时间 区');
        assert(!ENGINEERING_PATTERN.test(cardText), `知识卡第一屏泄漏工程字段：${cardText.slice(0, 300)}`);
        // 卡片邻近节点而非固定侧栏：卡片在板内绝对定位
        const cardBox = await page.locator('[data-kc-knowledge-card]').boundingBox();
        const boardBox = await page.locator('[data-kc-canvas]').boundingBox();
        assert(cardBox && boardBox && cardBox.x >= boardBox.x && cardBox.x < boardBox.x + boardBox.width, '卡片应定位在画布板内（非侧栏）');
      });
      await step(evidence, '知识结论卡片展示完整认识正文', async () => {
        await page.locator('[data-kc-card-close]').click();
        await page.waitForFunction(() => !document.querySelector('[data-kc-knowledge-card]'));
        await waitForNodeHitTestable(page, 'AgentForge v2 支持多模型路由');
        await page.locator('[data-kc-node-title="AgentForge v2 支持多模型路由"]').click();
        await page.locator('[data-kc-knowledge-card]').waitFor({ state: 'visible', timeout: 20_000 });
        const noteCard = await page.locator('[data-kc-knowledge-card]').textContent();
        assert(noteCard.includes('完整认识'), '知识结论卡第一屏应含 完整认识');
        assert(noteCard.includes('AgentForge v2 支持多模型路由'), '知识结论卡应展示认识正文');
      });
      await step(evidence, '点击空白关闭卡片', async () => {
        const point = await emptyBoardPoint(page);
        await page.mouse.click(point.x, point.y);
        // 若首点意外命中浮层（时序），换点重试一次
        let closed = await page.evaluate(() => !document.querySelector('[data-kc-knowledge-card]'));
        if (!closed) {
          await delay(300);
          const point2 = await emptyBoardPoint(page);
          await page.mouse.click(point2.x, point2.y);
          closed = await page.evaluate(() => !document.querySelector('[data-kc-knowledge-card]'));
        }
        assert(closed, '点击图谱空白处应关闭知识卡');
      });
      await step(evidence, '双击主题节点进入正式页面', async () => {
        await waitForNodeHitTestable(page, 'AI Agent 工具链');
        await page.locator('[data-kc-node-title="AI Agent 工具链"]').dblclick();
        await page.locator('.topic-object-head h2', { hasText: 'AI Agent 工具链' }).waitFor({ state: 'visible', timeout: 20_000 });
        assert(await page.locator('aside.sidebar nav button.active').getAttribute('title') === '主题', '双击应导航到主题详情');
      });
      return { surface: 'canvas', journey: 'CV-002', cardSections: ['primary', 'scope', 'evidence-boundary', 'evidence', 'updated'] };
    }
  },
  {
    id: 'CV-003-canvas-drag-select-pi',
    journeyIds: ['CV-003-canvas-drag-select-pi'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '拖框命中节点立即更新 Pi 上下文（无确认按钮）', async () => {
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 8 });
        await waitForLayoutSettle(page);
        // 用搜索把可见集限定为单节点，整板拖框精确命中该节点
        await page.locator('[data-kc-search]').fill('20 条混合样本');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 1);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 1 项') === true, null, { timeout: 10_000 });
        assert(await page.locator('[data-kc-selection-status]').count() === 1, '框选状态栏应渲染');
        // 无确认按钮：状态栏不存在「和 Pi 讨论」/「确认」类按钮
        const statusText = await page.locator('[data-kc-selection-status]').textContent();
        assert(!/和 Pi 讨论|确认讨论/.test(statusText ?? ''), '框选后不应出现确认按钮');
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络 · 已框选 1 项', null, { timeout: 10_000 });
        const chip = await piChipText(page);
        assert(chip === '知识网络 · 已框选 1 项', `Pi chip 应为 知识网络 · 已框选 1 项，实际 ${JSON.stringify(chip)}`);
      });
      await step(evidence, '连续框选累加并按正式身份去重', async () => {
        await page.locator('[data-kc-search]').fill('');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 8);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 8 项') === true, null, { timeout: 10_000 });
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络 · 已框选 8 项', null, { timeout: 10_000 });
        assert((await piChipText(page)) === '知识网络 · 已框选 8 项', '累加后 Pi chip 应显示 8 项');
        // 重复整板拖框：全部节点已选中 → 去重，数量不变
        await fullBoardDrag(page);
        await page.waitForTimeout(600);
        assert((await selectionCount(page)) === 8, '重复框选应去重保持 8 项');
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络 · 已框选 8 项', null, { timeout: 10_000 });
        assert((await piChipText(page)) === '知识网络 · 已框选 8 项', '去重后 Pi chip 保持 8 项');
      });
      await step(evidence, '不自动发送：转写区无新对话', async () => {
        const bubbles = await page.locator('.pi-bubble-wrap').count();
        assert(bubbles === 0, `框选不应自动发送，实际 ${bubbles} 条消息`);
      });
      await step(evidence, '上下文携带冻结知识正文包（非对象名清单）', async () => {
        const pkg = await page.evaluate(() => window.wmb.previewKnowledgeContextPackage({
          canvasId: 'global',
          nodeIds: [...document.querySelectorAll('.kn-node')].map((el) => el.getAttribute('data-kc-node-id'))
        }));
        assert(pkg && Array.isArray(pkg.items) && pkg.items.length === 8, `选择包应含 8 项，实际 ${pkg?.items?.length}`);
        const statements = pkg.items.map((item) => JSON.stringify(item.snapshot ?? {}));
        assert(statements.some((s) => s.includes('多模型路由')), '选择包应携带知识正文（statement/summary），而非仅对象名');
        assert(pkg.items.every((item) => item.objectType === 'topic' || item.objectType === 'knowledge_note' || item.objectType === 'knowledge_entity'), '选择包对象类型应仅三类');
      });
      return { surface: 'canvas', journey: 'CV-003', accumulated: 8, deduped: true, autoSend: false };
    }
  },
  {
    id: 'CV-004-canvas-history-shortcuts',
    journeyIds: ['CV-004-canvas-history-shortcuts'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '两次框选入栈，Ctrl+Z 回退 / Ctrl+X 前进', async () => {
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 8 });
        await waitForLayoutSettle(page);
        await page.locator('[data-kc-search]').fill('20 条混合样本');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 1);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 1 项') === true);
        await page.locator('[data-kc-search]').fill('AgentForge');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 4);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 5 项') === true);
        await focusBoard(page);
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 1 项') === true, null, { timeout: 10_000 });
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络 · 已框选 1 项', null, { timeout: 10_000 });
        assert((await piChipText(page)) === '知识网络 · 已框选 1 项', 'Ctrl+Z 应回退到上一次框选');
        await page.keyboard.press('Control+x');
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 5 项') === true, null, { timeout: 10_000 });
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络 · 已框选 5 项', null, { timeout: 10_000 });
        assert((await piChipText(page)) === '知识网络 · 已框选 5 项', 'Ctrl+X 应前进到被回退的框选');
        assert((await page.locator('[data-kc-history-hint]').textContent()).includes('Ctrl+Z 回退'), '应有历史快捷键提示');
      });
      await step(evidence, 'Esc 无卡片时清空全部框选与 Pi 上下文', async () => {
        await focusBoard(page);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('[data-kc-selection-count]'), null, { timeout: 10_000 });
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络', null, { timeout: 10_000 });
        assert((await piChipText(page)) === '知识网络', `Esc 后 chip 应无计数，实际 ${JSON.stringify(await piChipText(page))}`);
      });
      await step(evidence, 'Esc 有卡片时先关闭卡片不清空选择', async () => {
        await page.locator('[data-kc-search]').fill('');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 8);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 8 项') === true);
        await waitForNodeHitTestable(page, 'AgentForge v2 支持多模型路由');
        await page.locator('[data-kc-node-title="AgentForge v2 支持多模型路由"]').click();
        await page.locator('[data-kc-knowledge-card]').waitFor({ state: 'visible', timeout: 20_000 });
        await focusBoard(page);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('[data-kc-knowledge-card]'), null, { timeout: 10_000 });
        assert((await selectionCount(page)) === 8, 'Esc 关卡片不应清空框选');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('[data-kc-selection-count]'), null, { timeout: 10_000 });
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络', null, { timeout: 10_000 });
        assert((await piChipText(page)) === '知识网络', '第二次 Esc 应清空框选');
      });
      await step(evidence, '输入框聚焦时保留系统快捷键；新框选作废前进历史', async () => {
        await page.locator('[data-kc-search]').fill('20 条混合样本');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 1);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 1 项') === true);
        // 输入框聚焦时 Ctrl+Z 不劫持（选中状态不变）
        await page.locator('[data-kc-search]').focus();
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(400);
        assert((await selectionCount(page)) === 1, '输入框聚焦时 Ctrl+Z 不应被图谱劫持');
        // 新框选作废前进历史
        await focusBoard(page);
        await page.keyboard.press('Control+z');
        // 历史只记录框选上下文：Esc 清空不入栈，因此 Ctrl+Z 回退到上一次框选快照（8 项）
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 8 项') === true, null, { timeout: 10_000 });
        assert((await selectionCount(page)) === 8, 'Ctrl+Z 应回退到上一次框选上下文（8 项）');
        // 清空后重新整板框选：新的有变化框选应作废前进历史（Ctrl+X 不再前进）
        await page.locator('[data-kc-search]').fill('');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 8);
        await focusBoard(page);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('[data-kc-selection-count]'), null, { timeout: 10_000 });
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 8 项') === true);
        await focusBoard(page);
        await page.keyboard.press('Control+x');
        await page.waitForTimeout(400);
        assert((await selectionCount(page)) === 8, '新框选后 Ctrl+X 前进历史应作废（选择不变）');
      });
      return { surface: 'canvas', journey: 'CV-004', undo: true, redo: true, esc: true, editableGuard: true };
    }
  },
  {
    id: 'CV-005-canvas-filters-display',
    journeyIds: ['CV-005-canvas-filters-display'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '类型/关系过滤与搜索', async () => {
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 8 });
        await waitForLayoutSettle(page);
        // 类型过滤：仅知识结论
        await page.locator('[data-kc-type-filter][data-kc-type="knowledge_note"]').click();
        await page.waitForFunction(() => {
          const chip = document.querySelector('[data-kc-type-filter][data-kc-type="knowledge_note"]');
          const count = document.querySelectorAll('.kn-node').length;
          return chip?.classList.contains('on') && count === 4;
        });
        // 关系过滤：只保留该语义连线（端点节点按类型/搜索过滤，连线两端必须在结果内）
        await page.locator('[data-kc-relation-filter][data-kc-relation="contradicts"]').click();
        await page.waitForFunction(() => {
          const chip = document.querySelector('[data-kc-relation-filter][data-kc-relation="contradicts"]');
          return chip?.classList.contains('on') && document.querySelectorAll('[data-kc-edge]').length === 1;
        });
        assert(await page.locator('[data-kc-edge][data-kc-rel-type="contradicts"]').count() === 1, 'contradicts 过滤后应只剩该连线');
        await page.locator('[data-kc-relation-filter][data-kc-relation="contradicts"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 4);
        // 恢复全部类型 → 三类节点与全部连线回归
        await page.locator('[data-kc-type-filter][data-kc-type="knowledge_note"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 8 && document.querySelectorAll('[data-kc-edge]').length === 3);
        // 搜索（标题/摘要命中）
        await page.locator('[data-kc-search]').fill('AgentForge');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 4); // 实体 + note1 + note3 + 主题
        await page.locator('[data-kc-search]').fill('');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length === 8);
      });
      await step(evidence, '邻接节点与连线高亮', async () => {
        await waitForNodeHitTestable(page, 'AgentForge');
        await page.locator('[data-kc-node-title="AgentForge"]').hover();
        await page.waitForFunction(() => document.querySelectorAll('.kn-node.adjacent').length >= 1, null, { timeout: 10_000 });
        assert(await page.locator('[data-kc-edge].adjacent').count() >= 1, '邻接连线应高亮');
      });
      await step(evidence, '显示参数调节生效', async () => {
        const sizeInput = page.locator('[data-kc-display-param="node-size"]');
        const before = await sizeInput.inputValue();
        const target = String(Math.min(Number(before) + 0.2, 1.6));
        await sizeInput.fill(target);
        await page.waitForFunction((expected) => {
          const style = getComputedStyle(document.querySelector('[data-kc-canvas]'));
          return Number.parseFloat(style.getPropertyValue('--kn-node-size')) === Number(expected);
        }, target, { timeout: 10_000 });
        await page.locator('[data-kc-display-reset]').click();
      });
      await step(evidence, '缩放按钮生效', async () => {
        const before = await page.locator('[data-kc-zoom-level]').textContent();
        await page.locator('[data-kc-zoom-in]').click();
        await page.waitForFunction((prev) => document.querySelector('[data-kc-zoom-level]')?.textContent !== prev, before, { timeout: 10_000 });
        assert((await page.locator('[data-kc-zoom-level]').textContent()) !== before, '缩放级别应变化');
      });
      await step(evidence, '刷新后搜索/过滤条件保留', async () => {
        await page.locator('[data-kc-search]').fill('多模型路由');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 1);
        await page.waitForTimeout(700); // 等 UI 状态持久化 debounce（300ms）落盘
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 1 });
        await waitForLayoutSettle(page);
        const searchValue = await page.locator('[data-kc-search]').inputValue();
        assert(searchValue === '多模型路由', `刷新后搜索条件应保留，实际 ${JSON.stringify(searchValue)}`);
      });
      return { surface: 'canvas', journey: 'CV-005', filters: true, adjacency: true, displayParams: true, persist: true };
    }
  },
  {
    id: 'CV-006-canvas-empty',
    journeyIds: ['CV-006-canvas-empty'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '空图态引导保存资料而非建画布', async () => {
        await navigateTo(page, 'canvas');
        await page.locator('[data-kc-empty-state]').waitFor({ state: 'visible', timeout: 30_000 });
        const text = await page.locator('[data-kc-empty-state]').textContent();
        assert(text.includes('还没有正式知识'), `空态标题错误：${text}`);
        assert(text.includes('保存资料'), '空态应引导保存资料');
        assert(!text.includes('创建画布') && !text.includes('新建画布'), '空态不应引导手工建画布');
        await page.locator('[data-kc-empty-action]').click();
        await page.waitForFunction(() => document.querySelector('nav button.active')?.getAttribute('title') === '资料库', null, { timeout: 15_000 });
        assert(await page.locator('.library-page').count() === 1, '空态动作应打开资料库');
      });
      return { surface: 'canvas', journey: 'CV-006', emptyGuide: '去资料库保存资料' };
    }
  },
  {
    id: 'CV-007-canvas-error-retry',
    journeyIds: ['CV-007-canvas-error-retry'],
    launch: RICH,
    run: async ({ page, app, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '投影加载失败显示重试，重试恢复', async () => {
        const injected = await app.evaluate(({ ipcMain }, channel) => {
          const store = ipcMain._invokeHandlers;
          if (!(store instanceof Map)) return { ok: false, channel };
          const original = store.get(channel);
          if (typeof original !== 'function') return { ok: false, channel };
          let failed = false;
          const wrapped = async (event, ...args) => {
            if (!failed) { failed = true; throw new Error('E2E 强制投影失败'); }
            return original(event, ...args);
          };
          store.set(channel, wrapped);
          return { ok: true, channel };
        }, 'knowledge-network:projection');
        assert(injected?.ok, `IPC 注入失败: ${JSON.stringify(injected)}`);
        await navigateTo(page, 'canvas');
        await page.locator('[data-kc-error-state]').waitFor({ state: 'visible', timeout: 30_000 });
        const errText = await page.locator('[data-kc-error-state]').textContent();
        assert(errText.includes('知识网络加载失败'), `错误态标题错误：${errText}`);
        assert(await page.locator('[data-kc-retry]').count() === 1, '应有重试按钮');
        await page.locator('[data-kc-retry]').click();
        await waitForNetwork(page, { nodes: 8 });
        await waitForLayoutSettle(page);
        const meta = await page.locator('.kc-network-meta').textContent();
        assert(meta.includes('8 个节点'), '重试后网络应恢复渲染');
      });
      await step(evidence, '无完整正文对象诚实摘要（不用工程元数据填充）', async () => {
        // 实体节点 summary 为空 → 卡片 primary 诚实回退为实体名
        await waitForNodeHitTestable(page, 'AgentForge');
        await page.locator('[data-kc-node-title="AgentForge"]').click();
        await page.locator('[data-kc-knowledge-card]').waitFor({ state: 'visible', timeout: 20_000 });
        const cardText = await page.locator('[data-kc-knowledge-card]').textContent();
        assert(cardText.includes('AgentForge'), '实体卡应诚实显示核心说明');
        assert(!ENGINEERING_PATTERN.test(cardText), `实体卡不应以工程元数据填充：${cardText.slice(0, 200)}`);
      });
      return { surface: 'canvas', journey: 'CV-007', failOnce: 'knowledge-network:projection', recovered: true };
    }
  },
  {
    id: 'CV-008-canvas-context-budget',
    journeyIds: ['CV-008-canvas-context-budget'],
    launch: { seedFixture: async (ws) => seedLongNotes(ws.dataRoot, ws.workspaceId) },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '框选超过预算：有界包 + Pi 明示未纳入数量，不静默换全图', async () => {
        await navigateTo(page, 'canvas');
        await waitForNetwork(page, { nodes: 21 });
        await focusBoard(page);
        await page.keyboard.press('Control+a');
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-kc-selection-count]');
          return el?.textContent?.includes('已框选 21 项') === true;
        }, null, { timeout: 10_000 });
        await page.locator('[data-kc-package-hint]').waitFor({ state: 'visible', timeout: 20_000 });
        const hint = await page.locator('[data-kc-package-hint]').textContent();
        assert(/上下文超限|未纳入/.test(hint ?? ''), `超限提示应明示未纳入，实际 ${JSON.stringify(hint)}`);
        const included = /已纳入 (\d+) 项/.exec(hint ?? '');
        assert(included && Number(included[1]) < 21, `应截断（已纳入 < 21），实际 ${JSON.stringify(hint)}`);
        // 服务端选择包同源验证：overLimit 或 excluded>0
        const pkg = await page.evaluate(() => window.wmb.previewKnowledgeContextPackage({
          canvasId: 'global',
          nodeIds: [...document.querySelectorAll('.kn-node')].map((el) => el.getAttribute('data-kc-node-id'))
        }));
        assert(pkg && (pkg.overLimit === true || (Array.isArray(pkg.excluded) && pkg.excluded.length > 0)), `选择包应超限或含 excluded，实际 ${JSON.stringify({ overLimit: pkg?.overLimit, excluded: pkg?.excluded?.length })}`);
        assert(Number(pkg.items.length) < 21, '选择包应有界（items < 21）');
      });
      return { surface: 'canvas', journey: 'CV-008', budget: '30000 chars', overLimit: true };
    }
  }
];
