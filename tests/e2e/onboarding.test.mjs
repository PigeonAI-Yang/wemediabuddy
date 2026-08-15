// onboarding surface E2E scenarios (WMB-5243).
//
// OB-001-onboarding-first-run-complete : 全新 userData（workspace 已由夹具绑定、
//   但 onboarding 未完成）→ 引导停在 AI 步骤 → 通过本地 mock OpenAI 服务完成
//   真实连接测试/保存 → 跳过平台 → 进入主壳 → 再次启动直接进主壳。
// OB-002-onboarding-completed-skip    : 已完成的 onboarding 夹具 → 跳过引导直接
//   主壳；状态栏显示工作空间与 profileId；设置「数据与存储」显示数据根路径。
// OB-003-onboarding-error-path        : 数据根不可用（data-root.json 指向一个文件）
//   → 不卡死在加载壳、不渲染主壳、无假完成状态；修复数据根后重试经引导完成进入主壳。
//
// 场景契约：default export = 数组 [{ id, journeyIds?, launch?, run(ctx) }]；
// `launch` 为可选启动选项（runner 合并进 withApp → launchApp）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { closeApp, helpers, launchApp, seedWorkspace } from './harness.mjs';

const { assert, step, waitForAppReady, navigateTo, VIEW_TITLES } = helpers;

/** 本地 mock OpenAI 兼容服务（main 进程 fetch，无 CORS 约束；仍附头以防变化）。 */
function startMockAi() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        return respond(200, { data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-vision' }] });
      }
      if (req.method === 'POST' && (req.url?.endsWith('/responses') || req.url?.endsWith('/chat/completions'))) {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          if (req.url?.endsWith('/responses')) {
            return respond(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] });
          }
          return respond(200, { choices: [{ message: { content: 'pong' } }] });
        });
        return;
      }
      respond(404, {});
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/** 引导 AI 步骤：真实连接测试 → 保存并继续 → 逐个跳过平台 → 进入 WeMediaBuddy。 */
async function completeAiWizard(page, mock) {
  await page.locator('input[placeholder="https://api.example.com/v1"]').fill(mock.baseUrl);
  await page.locator('input[type="password"]').fill('sk-e2e-mock-key');
  await page.locator('input[placeholder="gpt-5.4"]').fill('gpt-5.4');
  await page.locator('button:has-text("测试连接")').click();
  await page.locator('.onboarding-success').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('button:has-text("保存并继续")').click();
  await page.locator('h2:has-text("连接发布平台")').waitFor({ state: 'visible', timeout: 30_000 });
  const skip = page.locator('button.text-button:has-text("跳过")');
  while (await skip.count() > 0) {
    await skip.first().click();
    await page.waitForTimeout(300);
  }
  await page.locator('button.onboarding-primary:has-text("进入 WeMediaBuddy")').click();
  await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 60_000 });
}

export default [
  {
    id: 'OB-001-onboarding-first-run-complete',
    journeyIds: ['OB-001-onboarding-first-run-complete'],
    // workspace 已由夹具绑定（registry + app_meta.workspace_id），onboarding 未完成 → 引导停在 AI 步骤
    launch: { onboarding: false, seedPi: false },
    run: async ({ app, page, workspace, evidence }) => {
      await step(evidence, '启动显示引导（AI 步骤）而非主壳', async () => {
        await page.waitForSelector('.onboarding-shell:not(.onboarding-loading)', { state: 'visible', timeout: 90_000 });
        assert((await page.locator('.app-shell').count()) === 0, '未完成引导时不应渲染主壳');
        await page.locator('label:has-text("模型名称") input').waitFor({ state: 'visible', timeout: 15_000 });
      });
      const mock = await startMockAi();
      try {
        await step(evidence, '真实完成引导：AI 连接测试 → 保存并继续 → 跳过平台 → 进入', async () => {
          await completeAiWizard(page, mock);
        });
        await step(evidence, '完成后主壳渲染、默认 today、completed=true', async () => {
          const completed = await page.evaluate(() => window.wmb.getOnboardingStatus());
          assert(completed?.completed === true, 'onboardingStatus.completed 应为 true');
          const active = await page.locator('nav button.active').getAttribute('title');
          assert(active === VIEW_TITLES.today, `默认视图应为 今日，实际 ${active}`);
        });
      } finally {
        await mock.close();
      }
      await step(evidence, '再次启动跳过引导直接进主壳', async () => {
        await closeApp(app);
        const second = await launchApp({ userDataDir: workspace.userDataDir, dataRoot: workspace.dataRoot, seed: false, name: 'ob-001-relaunch' });
        try {
          await waitForAppReady(second.page, { shell: '.app-shell', timeoutMs: 60_000 });
          assert((await second.page.locator('.onboarding-shell').count()) === 0, '重启动不应再显示引导');
        } finally {
          await closeApp(second.app);
        }
      });
      return { wizardCompleted: true, relaunchedToShell: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'OB-002-onboarding-completed-skip',
    journeyIds: ['OB-002-onboarding-completed-skip'],
    run: async ({ page, workspace, evidence }) => {
      await step(evidence, '完成态启动跳过引导直接主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 60_000 });
        assert((await page.locator('.onboarding-shell').count()) === 0, '完成态启动不应出现引导表单');
      });
      await step(evidence, '状态栏显示工作空间显示名与 profileId', async () => {
        const item = page.locator('footer.status-bar .status-item', { hasText: workspace.displayName });
        await item.waitFor({ state: 'visible', timeout: 15_000 });
        const text = (await item.textContent()) ?? '';
        assert(new RegExp(`${workspace.displayName} ·\\s*\\S+`).test(text), `状态栏应含「工作空间 · profileId」: ${text}`);
        evidence.profileBar = text.trim();
      });
      await step(evidence, '设置「数据与存储」显示数据根路径', async () => {
        await navigateTo(page, 'settings');
        await page.locator('button:has-text("数据与存储")').first().click();
        const chip = page.locator('.path-chip');
        await chip.waitFor({ state: 'visible', timeout: 15_000 });
        assert(((await chip.textContent()) ?? '').trim() === workspace.dataRoot, 'path-chip 应显示数据根路径');
      });
      return { profileBar: evidence.profileBar };
    }
  },
  {
    id: 'OB-003-onboarding-error-path',
    journeyIds: ['OB-003-onboarding-error-path'],
    run: async ({ page, evidence }) => {
      await step(evidence, '基线：默认夹具正常进主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 60_000 });
      });
      const dir = mkdtempSync(path.join(os.tmpdir(), 'wmb-e2e-ob003-'));
      const userDataDir = path.join(dir, 'user-data');
      const blockedRoot = path.join(dir, 'data-root');
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(blockedRoot, 'blocked'); // 数据根位置是文件 → validateDataRoot 必然失败
      writeFileSync(path.join(userDataDir, 'data-root.json'), JSON.stringify({ path: blockedRoot }));
      let failApp;
      try {
        await step(evidence, '数据根不可用：显示恢复引导而非卡死/主壳/假完成', async () => {
          failApp = await launchApp({ userDataDir, dataRoot: blockedRoot, seed: false, name: 'ob-003-fail' });
          await failApp.page.waitForSelector('.onboarding-shell:not(.onboarding-loading)', { state: 'visible', timeout: 90_000 });
          assert((await failApp.page.locator('.app-shell').count()) === 0, '失败阶段不应渲染主壳');
          const completed = await failApp.page.evaluate(() => window.wmb.getOnboardingStatus());
          assert(completed?.completed !== true, '失败阶段不得出现假完成状态');
          assert(failApp.evidence.pageerrors.length === 0, `失败阶段不应有页面异常: ${failApp.evidence.pageerrors[0]?.message ?? ''}`);
        });
      } finally {
        if (failApp) await closeApp(failApp.app);
      }
      await step(evidence, '修复数据根后重试：经引导完成并进入主壳', async () => {
        rmSync(blockedRoot);
        // 失败阶段会落一条 currentStep=welcome 的 onboarding 状态（readOrCreateState）；
        // 重试时清掉它，让引导按「全新启动」从 AI 步骤开始（工作空间已登记，deriveCurrentStep 直接给 ai）。
        rmSync(path.join(userDataDir, 'onboarding.json'), { force: true });
        seedWorkspace({ userDataDir, dataRoot: blockedRoot, workspaceId: 'ws-ob003-retry', onboarding: false, seedPi: false });
        const retryApp = await launchApp({ userDataDir, dataRoot: blockedRoot, seed: false, name: 'ob-003-retry' });
        try {
          await retryApp.page.waitForSelector('label:has-text("模型名称") input', { state: 'visible', timeout: 60_000 });
          const mock = await startMockAi();
          try {
            await completeAiWizard(retryApp.page, mock);
          } finally {
            await mock.close();
          }
          assert((await retryApp.page.locator('.onboarding-shell').count()) === 0, '重试完成后不应再有引导');
          assert(retryApp.evidence.pageerrors.length === 0, `重试阶段页面异常: ${retryApp.evidence.pageerrors[0]?.message ?? ''}`);
        } finally {
          await closeApp(retryApp.app);
        }
      });
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* win32 锁残留，tmp 目录无害 */ }
      return { failureShown: true, retryCompleted: true, pageerrors: evidence.pageerrors.length };
    }
  }
];
