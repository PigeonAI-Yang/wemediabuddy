// navigation surface E2E scenarios (WMB-5243).
//
// Two scenarios:
//  - smoke-launch-exit: minimal launch / navigate / exit smoke (standalone,
//    run via `npm run e2e:smoke`; not part of the journey matrix).
//  - NAV-001-global-navigation-all-views: matrix journey — full sidebar tour,
//    mode classes, wmb.view persistence, invalid/compose normalization,
//    no Vite overlay / no white screen / no page errors.
//
// Scenario contract: default export = array of { id, journeyIds?, run(ctx) }.
// ctx = { app, page, workspace, artifactsDir, evidence, runtimeDir, helpers }.

import { helpers } from './harness.mjs';

const { assert, step, waitForAppReady, navigateTo, VIEW_TITLES, delay } = helpers;

const WORKFLOW_NAV = ['today', 'agents', 'discover', 'proposals', 'studio', 'publish', 'results'];
const KNOWLEDGE_NAV = ['topic', 'library', 'canvas'];
const ALL_NAV = [...WORKFLOW_NAV, ...KNOWLEDGE_NAV, 'settings'];

async function assertActiveView(page, view) {
  // 只断言全局侧栏激活态；各页面内部的 tab（如 proposals 的 nav.proposal-tabs button.active）
  // 也会匹配裸 `nav button.active`，必须限定到侧栏作用域。
  const active = await page.locator('aside.sidebar nav button.active').getAttribute('title');
  assert(active === VIEW_TITLES[view], `${view} 激活态错误: 期望 ${VIEW_TITLES[view]}，实际 ${active}`);
}

async function reloadAndWait(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 60_000 });
}

export default [
  {
    id: 'smoke-launch-exit',
    journeyIds: [],
    run: async ({ app, page, evidence }) => {
      await step(evidence, '启动: 主壳可见且品牌标识正确', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        const brand = page.locator('.topbar .brand strong');
        await brand.waitFor({ state: 'visible', timeout: 15_000 });
        assert(((await brand.textContent()) ?? '').trim() === 'WeMediaBuddy', '主壳品牌标识不符');
      });
      await step(evidence, '默认视图 = 今日', async () => {
        await assertActiveView(page, 'today');
      });
      await step(evidence, '导航: 今日 → 智能体 → 今日', async () => {
        await navigateTo(page, 'agents');
        await page.locator('section.agents-roster').waitFor({ state: 'visible', timeout: 20_000 });
        await assertActiveView(page, 'agents');
        await navigateTo(page, 'today');
        await assertActiveView(page, 'today');
      });
      await step(evidence, '健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `启动期间页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      await step(evidence, '退出: 应用进程正常结束', async () => {
        const exitPromise = new Promise((resolve) => app.process()?.once('exit', () => resolve('exited')));
        await app.close();
        const exitState = await Promise.race([exitPromise, delay(25_000).then(() => 'timeout')]);
        assert(exitState === 'exited', `Electron 未正常退出: ${exitState}`);
      });
      return { launched: true, navigated: ['today', 'agents'], exited: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'NAV-001-global-navigation-all-views',
    journeyIds: ['NAV-001-global-navigation-all-views'],
    run: async ({ page, evidence }) => {
      await step(evidence, '11 个顶级视图经侧栏依次可达且激活态正确', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        for (const view of ALL_NAV) {
          await navigateTo(page, view);
          await assertActiveView(page, view);
        }
      });
      await step(evidence, 'mode class: settings-mode / studio-mode / topic-mode，settings 隐藏 Pi dock', async () => {
        await navigateTo(page, 'settings');
        const settingsClass = await page.locator('main.app-shell').getAttribute('class');
        assert(settingsClass?.includes('settings-mode'), 'settings 视图缺少 settings-mode class');
        assert((await page.locator('aside.pi-dock').count()) === 0, 'settings 视图不应渲染 Pi dock');
        await navigateTo(page, 'studio');
        const studioClass = await page.locator('main.app-shell').getAttribute('class');
        assert(studioClass?.includes('studio-mode'), 'studio 视图缺少 studio-mode class');
        await navigateTo(page, 'topic');
        const topicClass = await page.locator('main.app-shell').getAttribute('class');
        assert(topicClass?.includes('topic-mode'), 'topic 视图缺少 topic-mode class');
      });
      await step(evidence, 'wmb.view 持久化，重载后恢复上次视图', async () => {
        await navigateTo(page, 'studio');
        await reloadAndWait(page);
        await assertActiveView(page, 'studio');
      });
      await step(evidence, '非法 wmb.view 归一为 today；compose 归一为 canvas', async () => {
        await page.evaluate(() => localStorage.setItem('wmb.view', 'bogus-view'));
        await reloadAndWait(page);
        await assertActiveView(page, 'today');
        await page.evaluate(() => localStorage.setItem('wmb.view', 'compose'));
        await reloadAndWait(page);
        await assertActiveView(page, 'canvas');
      });
      await step(evidence, '全程无 Vite overlay / 白屏 / 页面异常', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert((await page.locator('vite-error-overlay, #vite-error-overlay, [data-vite-devkit-overlay]').count()) === 0, '检测到 Vite 错误 overlay');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { navigated: ALL_NAV.length, pageerrors: evidence.pageerrors.length };
    }
  }
];
