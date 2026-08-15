// Pi dock surface Electron E2E scenarios (WMB-5243, journey matrix PI-001..PI-005).
//
// PI-002（真实发送→流式回复）在矩阵中标 manual 排除（需真实 AI provider），不进入可自动化分母。
// 本文件覆盖：上下文 chip 与 dock 折叠/宽度持久化（含新网络投影 contextSelection 兼容契约）、
// Pi 未配置态、不可达 provider 失败投影（非假成功 + 可重试）、本地会话管理（新建/切换/归档）。
// Real Electron + isolated workspace（无真实 AI 调用）。

import { helpers } from './harness.mjs';
import { seedRichKnowledge, seedPiSessions } from './fixture-knowledge.mjs';

const { assert, step, waitForAppReady, navigateTo, delay } = helpers;

async function piChipText(page) {
  const chip = page.locator('.pi-context-chip span');
  if (await chip.count() === 0) return '';
  return (await chip.textContent()) ?? '';
}

async function fullBoardDrag(page) {
  const board = await page.locator('[data-kc-canvas]').boundingBox();
  const start = await page.evaluate(() => {
    const b = document.querySelector('[data-kc-canvas]');
    const rect = b.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.kn-node')].map((el) => el.getBoundingClientRect());
    const occupied = (x, y) => nodes.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    for (let i = 14; i < rect.width - 14; i += 28) {
      for (let j = 14; j < rect.height - 14; j += 28) {
        const x = rect.left + i;
        const y = rect.top + j;
        if (!occupied(x, y)) return { x, y };
      }
    }
    return { x: rect.left + 14, y: rect.top + 14 };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width - 14, board.y + board.height - 14, { steps: 12 });
  await page.mouse.up();
}

export default [
  {
    id: 'PI-001-pi-dock-context-chip',
    journeyIds: ['PI-001-pi-dock-context-chip'],
    launch: { seedFixture: async (ws) => seedRichKnowledge(ws.dataRoot, ws.workspaceId) },
    run: async ({ page, app, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '知识网络框选更新上下文 chip（新投影兼容契约）', async () => {
        await navigateTo(page, 'canvas');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 8);
        await fullBoardDrag(page);
        await page.waitForFunction(() => document.querySelector('[data-kc-selection-count]')?.textContent?.includes('已框选 8 项') === true);
        await page.waitForFunction(() => document.querySelector('.pi-context-chip span')?.textContent === '知识网络 · 已框选 8 项', null, { timeout: 10_000 });
        const chip = await piChipText(page);
        assert(chip === '知识网络 · 已框选 8 项', `chip 应反映知识网络框选，实际 ${JSON.stringify(chip)}`);
        // contextSelection 兼容契约：canvasId='global' + 稳定网络节点 ID 可被既有选择包通道消费
        const pkg = await page.evaluate(() => {
          const ids = [...document.querySelectorAll('.kn-node')].map((el) => el.getAttribute('data-kc-node-id'));
          return window.wmb.previewKnowledgeContextPackage({ canvasId: 'global', nodeIds: ids });
        });
        assert(pkg && pkg.items.length === 8 && pkg.scope === 'selected_only', '选择包应保持 selected_only 契约');
      });
      await step(evidence, 'dock 折叠/宽度持久化并重载保持', async () => {
        await navigateTo(page, 'today');
        // 折叠开关平时透明不可点（pointer-events:none），悬停 rail 后才可点击
        await page.locator('.pi-dock-toggle-rail').hover();
        await page.locator('.pi-dock-toggle').click();
        await page.waitForFunction(() => document.querySelector('.pi-dock')?.classList.contains('collapsed') === true);
        const collapsedStored = await page.evaluate(() => localStorage.getItem('wmb.piDockCollapsed'));
        assert(collapsedStored === 'true', `折叠状态应持久化，实际 ${collapsedStored}`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await page.waitForFunction(() => document.querySelector('.pi-dock')?.classList.contains('collapsed') === true);
        // 展开并拖拽 resize 手柄改宽度 → localStorage 持久化
        await page.locator('.pi-dock-toggle-rail').hover();
        await page.locator('.pi-dock-toggle').click();
        await page.waitForFunction(() => document.querySelector('.pi-dock')?.classList.contains('collapsed') === false);
        const handle = await page.locator('.pi-resize-handle').boundingBox();
        assert(handle, 'resize 手柄应存在');
        // app-shell grid-template-columns 有 200ms 过渡；无头窗口下过渡不推进，
        // 先真实显示窗口让过渡跑完，再等 dock 宽度落定后拖拽手柄
        await app.evaluate(({ BrowserWindow }) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.isVisible()) win.show();
          }
        });
        await page.waitForFunction(() => {
          const dock = document.querySelector('.pi-dock')?.getBoundingClientRect();
          return dock && dock.width > 370;
        }, null, { timeout: 10_000 });
        const handleSettled = await page.locator('.pi-resize-handle').boundingBox();
        const beforeWidth = await page.evaluate(() => Number(localStorage.getItem('wmb.piDockWidth')) || 380);
        await page.mouse.move(handleSettled.x + handleSettled.width / 2, handleSettled.y + handleSettled.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleSettled.x + 40, handleSettled.y + handleSettled.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForFunction((prev) => (Number(localStorage.getItem('wmb.piDockWidth')) || 380) !== prev, beforeWidth, { timeout: 10_000 });
        const storedWidth = await page.evaluate(() => Number(localStorage.getItem('wmb.piDockWidth')));
        assert(storedWidth > 300 && storedWidth < beforeWidth, `宽度应缩小并持久化：${storedWidth}`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        const appliedWidth = await page.evaluate(() => document.querySelector('.app-shell')?.style.getPropertyValue('--pi-open-width'));
        assert(Math.abs(Number.parseFloat(appliedWidth) - storedWidth) <= 2, `重载后宽度应保持：${appliedWidth} vs ${storedWidth}`);
      });
      return { surface: 'pi', journey: 'PI-001', chip: '知识网络 · 已框选 8 项', persist: true };
    }
  },
  {
    id: 'PI-003-pi-unconfigured-state',
    journeyIds: ['PI-003-pi-unconfigured-state'],
    launch: { seedPi: false },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '未配置态：状态栏/dock/composer 诚实降级', async () => {
        await waitForAppReady(page);
        const statusBar = await page.locator('.status-bar').textContent();
        assert(statusBar.includes('Pi 未配置'), `状态栏应显示 Pi 未配置，实际 ${statusBar.slice(0, 80)}`);
        const placeholder = await page.locator('.pi-composer textarea').getAttribute('placeholder');
        assert(placeholder.includes('配置 Pi API'), `composer 应引导配置，实际 ${JSON.stringify(placeholder)}`);
        const sendDisabled = await page.locator('.pi-send-button').isDisabled();
        assert(sendDisabled, '未配置时发送按钮应禁用');
        const transcript = await page.locator('.pi-empty').textContent();
        assert(transcript.includes('请先在设置中填写 Pi API'), '转写区应显示配置指引');
        // 配置入口可达（设置 AI 分区）
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="AI 与模型"]').click();
        await page.locator('.settings-section-heading h3', { hasText: '配置预设' }).waitFor({ state: 'visible' });
      });
      return { surface: 'pi', journey: 'PI-003', unconfigured: true };
    }
  },
  {
    id: 'PI-004-pi-configure-failure',
    journeyIds: ['PI-004-pi-configure-failure'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '配置不可达 provider 后发送 → 失败投影（非假成功）', async () => {
        await waitForAppReady(page);
        // 把当前 profile 改到不可达本地端口（真实持久化；无外部网络）
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="AI 与模型"]').click();
        const baseUrlInput = page.locator('.settings-form label', { hasText: 'Base URL' }).locator('input');
        await baseUrlInput.fill('http://127.0.0.1:9/v1');
        await page.locator('.settings-form-actions button.primary-button', { hasText: '保存修改' }).click();
        await page.waitForFunction(() => document.querySelector('.pi-config-note')?.textContent?.includes('已保存并切换到此配置') === true, null, { timeout: 15_000 });
        const cfg = await page.evaluate(() => window.wmb.getSettings());
        assert(cfg?.pi?.profiles?.some((p) => p.baseUrl === 'http://127.0.0.1:9/v1'), '不可达配置应持久化');
        await navigateTo(page, 'today');
        await page.locator('.pi-composer textarea').fill('E2E 失败路径测试消息');
        await page.locator('.pi-send-button').click();
        // 等待失败投影：assistant 失败气泡（错误文本）或 失败状态
        let failed = false;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const bubbleText = await page.locator('.pi-bubble-wrap.assistant .pi-bubble').allTextContents();
          const statusBarText = await page.locator('.status-bar .status-item[data-phase]').first().textContent();
          if (bubbleText.some((t) => t.trim().length > 0) || /Pi 失败/.test(statusBarText ?? '')) {
            failed = true;
            break;
          }
          await delay(2000);
        }
        assert(failed, '发送不可达 provider 应在 120s 内投影失败');
        const finalBubble = (await page.locator('.pi-bubble-wrap.assistant .pi-bubble').allTextContents()).join(' ');
        const statusText = (await page.locator('.status-bar .status-item[data-phase]').first().textContent()) ?? '';
        const projected = finalBubble || statusText;
        assert(!/已回复|成功/.test(projected), `失败不得伪装成功：${projected.slice(0, 120)}`);
        // 失败后 composer 可重试（诚实恢复面）
        const retryPlaceholder = await page.locator('.pi-composer textarea').getAttribute('placeholder');
        assert(/重试|继续/.test(retryPlaceholder ?? ''), `失败后应可重试，实际 ${JSON.stringify(retryPlaceholder)}`);
      });
      return { surface: 'pi', journey: 'PI-004', failureProjected: true, honest: true };
    }
  },
  {
    id: 'PI-005-pi-session-management',
    journeyIds: ['PI-005-pi-session-management'],
    launch: { seedFixture: async (ws) => seedPiSessions(ws.dataRoot) },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '会话列表加载本地历史（不触发外部调用）', async () => {
        await waitForAppReady(page);
        await page.locator('.pi-session-trigger').click();
        await page.locator('.pi-session-menu').waitFor({ state: 'visible' });
        const rows = page.locator('.pi-session-row');
        assert(await rows.count() === 2, `应有两个本地会话，实际 ${await rows.count()}`);
        const rowTexts = await rows.allTextContents();
        assert(rowTexts.some((t) => t.includes('E2E 会话甲')), '缺会话甲');
        assert(rowTexts.some((t) => t.includes('E2E 会话乙')), '缺会话乙');
        await page.locator('.pi-session-trigger').click();
      });
      await step(evidence, '切换会话加载对应历史消息', async () => {
        await page.locator('.pi-session-trigger').click();
        await page.locator('.pi-session-row', { hasText: 'E2E 会话乙' }).locator('button[role="option"]').click();
        await page.waitForFunction(() => document.querySelector('.user.pi-bubble')?.textContent?.includes('上一轮结论是什么') === true, null, { timeout: 15_000 });
        assert(await page.locator('.pi-bubble-wrap.user').count() === 1, '切换会话应只显示该会话消息');
      });
      await step(evidence, '新建会话清空转写并设置活动会话', async () => {
        await page.locator('.pi-session-trigger').click();
        await page.locator('.pi-session-menu-head button', { hasText: '新建' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.pi-bubble-wrap').length === 0, null, { timeout: 15_000 });
        assert(await page.locator('.pi-empty').count() === 1, '新会话转写应为空态');
      });
      await step(evidence, '归档会话后状态正确且不崩溃', async () => {
        await page.locator('.pi-session-trigger').click();
        const rowsBefore = await page.locator('.pi-session-row').count();
        const activeRow = page.locator('.pi-session-row.active').first();
        await activeRow.locator('.pi-session-more').click();
        await page.locator('.pi-session-actions button', { hasText: '归档会话' }).click();
        await page.waitForFunction((before) => document.querySelectorAll('.pi-session-row').length === before - 1, rowsBefore, { timeout: 15_000 });
        const archivedLink = await page.locator('.pi-session-archived-link').textContent();
        assert(/已归档会话/.test(archivedLink ?? ''), '应有已归档会话入口');
        assert(await page.locator('.app-shell').isVisible(), '归档后应用不崩溃');
      });
      return { surface: 'pi', journey: 'PI-005', sessions: 2, localOnly: true };
    }
  }
];
