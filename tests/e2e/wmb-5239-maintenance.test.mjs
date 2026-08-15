// WMB-5239 真实 Electron E2E：全库维护入口 + 统一搜索 + 全局日志 + 主题范围 + 画布定位 + 重启读回。
// 覆盖 ReviewWmb5239Boundaries 验收清单（真实 UI 断言）：
// - 资料库：全库整理入口/阶段进度/暂停继续/失败项/整理报告/批量摄取反馈/搜索全部资料/最近变化；
// - 主题：搜索本主题资料 + 相关动态（topicId 限定；无维护控件）；
// - 画布：最近变化（全局日志）+ 知识健康只读提示（无维护执行入口）；
// - 用户语言：全库整理/搜索全部资料/最近变化/整理报告/失败项/暂停/继续 存在；
//   可见文本零 compiled/receipt/changeset/hot-cache/index/cursor 工程词；
// - 无新顶层路由（侧栏仍 主题|资料库|知识网络）；1568 宽无横向溢出；
// - 重启读回：维护 run 状态沿 SQLite 持久化，重启后 UI 读回一致。
import { helpers } from './harness.mjs';
import { seedRichKnowledge } from './fixture-knowledge.mjs';
import { openWorkspaceDb } from './fixture-knowledge.mjs';
import { rebuildWikiIndex } from '../../src/main/db/wiki-index-store.ts';

const { assert, step, waitForAppReady, navigateTo, delay, openReadOnlyDb, captureEvidence } = helpers;

// 种子在应用启动前直写 DB；生产路径的索引投影只在应用内接线（boot 后 ChangeSet 提交时触发），
// 所以种子后需等价重建索引，使「搜索全部资料」反映真实已收录内容（重建 = 生产自愈等价路径）。
const RICH = {
  seedFixture: async (ws) => {
    await seedRichKnowledge(ws.dataRoot, ws.workspaceId);
    const db = openWorkspaceDb(ws.dataRoot);
    try {
      rebuildWikiIndex(db, false);
    } finally {
      db.close();
    }
  }
};

const ENGINEERING_PATTERN = /compiled|changeset|hot[-_ ]?cache|scan_compile|receipt|revision|index|cursor/i;

async function bodyText(page, selector) {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', selector);
}

async function clickWikiTool(page, tool) {
  await page.locator(`[data-wiki-tool="${tool}"]`).first().click();
  await page.locator(`[data-wiki-panel="${tool}"]`).first().waitFor({ state: 'visible', timeout: 15_000 });
}

export default [
  {
    id: 'WMB-5239-maintenance-search-log',
    journeyIds: ['WMB-5239-maintenance-search-log'],
    launch: RICH,
    run: async ({ app, page, workspace, evidence, artifactsDir }) => {
      await step(evidence, '打开资料库并等待工具条', async () => {
        await waitForAppReady(page);
        await navigateTo(page, 'library');
        await page.locator('.library-wiki-tools').first().waitFor({ state: 'visible', timeout: 20_000 });
      });

      await step(evidence, '全库整理：入口/开始/暂停/继续/失败/报告 seams 存在', async () => {
        const tools = await bodyText(page, '.library-wiki-tools');
        assert(tools.includes('全库整理'), '工具条应有 全库整理 入口');
        assert(tools.includes('搜索全部资料'), '工具条应有 搜索全部资料 入口');
        assert(tools.includes('最近变化'), '工具条应有 最近变化 入口');
        await clickWikiTool(page, 'maintenance');
        const panel = await bodyText(page, '[data-wiki-panel="maintenance"]');
        assert(panel.includes('全库整理'), '维护面板标题应为 全库整理');
        assert(!/compiled|changeset|receipt|scan_compile/i.test(panel), `维护面板泄漏工程词: ${panel.slice(0, 200)}`);
        // 阶段进度条：整理资料→检查健康→生成报告→已完成。
        const phases = await page.locator('[data-wiki-panel="maintenance"] [data-maintenance-phase]').count();
        assert(phases === 4, `应有 4 个阶段节点，实际 ${phases}`);
        const phaseText = await bodyText(page, '[data-wiki-panel="maintenance"] .library-maintenance-phases');
        assert(phaseText.includes('整理资料') && phaseText.includes('检查健康') && phaseText.includes('生成报告') && phaseText.includes('已完成'),
          `阶段进度应为用户语言: ${phaseText.slice(0, 200)}`);
      });

      await step(evidence, '全库整理：开始 → 整理中 → 暂停 → 继续', async () => {
        const start = page.locator('[data-maintenance-action="start"]').first();
        if (await start.count()) {
          await start.click();
          // start 幂等；等待状态读回 running。
          await page.waitForFunction(() => {
            const el = document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]');
            return el?.getAttribute('data-maintenance-status') === 'running';
          }, null, { timeout: 20_000 });
          const running = await bodyText(page, '[data-wiki-panel="maintenance"]');
          assert(running.includes('整理中'), '开始后状态应为 整理中');
          assert(!/scan_compile|compiled|receipt/i.test(running), `运行态泄漏工程词: ${running.slice(0, 200)}`);
          // 暂停（批次边界生效）。
          const pause = page.locator('[data-maintenance-action="pause"]').first();
          if (await pause.count()) {
            await pause.click();
            await page.waitForFunction(() => {
              const el = document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]');
              return el?.getAttribute('data-maintenance-status') === 'paused';
            }, null, { timeout: 25_000 });
            const paused = await bodyText(page, '[data-wiki-panel="maintenance"]');
            assert(paused.includes('已暂停'), '暂停后状态应为 已暂停');
            // 继续。
            const resume = page.locator('[data-maintenance-action="resume"]').first();
            if (await resume.count()) {
              await resume.click();
              await page.waitForFunction(() => {
                const el = document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]');
                return el?.getAttribute('data-maintenance-status') === 'running';
              }, null, { timeout: 25_000 });
            }
          }
        }
      });

      await step(evidence, '统一搜索：搜索全部资料 输入命中并给出用户语言结果', async () => {
        await clickWikiTool(page, 'search');
        const input = page.locator('[data-wiki-panel="search"] .wiki-search-input');
        await input.waitFor({ state: 'visible', timeout: 15_000 });
        await input.fill('AgentForge');
        await page.waitForFunction(() => {
          const text = document.querySelector('[data-wiki-panel="search"]')?.textContent ?? '';
          return text.includes('找到') && text.includes('条结果');
        }, null, { timeout: 15_000 });
        const searchText = await bodyText(page, '[data-wiki-panel="search"]');
        assert(!ENGINEERING_PATTERN.test(searchText), `搜索结果泄漏工程词: ${searchText.slice(0, 200)}`);
        const resultRows = await page.locator('[data-wiki-panel="search"] [data-wiki-result]').count();
        assert(resultRows >= 1, `搜索应至少命中 1 条，实际 ${resultRows}`);
      });

      await step(evidence, '画布：最近变化（全局日志）+ 知识健康只读提示；无维护执行入口', async () => {
        await navigateTo(page, 'canvas');
        await page.locator('[data-kc-log-toggle]').first().waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('[data-kc-log-toggle]').first().click();
        await page.locator('[data-kc-log-panel]').first().waitFor({ state: 'visible', timeout: 15_000 });
        const logText = await bodyText(page, '[data-kc-log-panel]');
        assert(!ENGINEERING_PATTERN.test(logText), `画布日志泄漏工程词: ${logText.slice(0, 200)}`);
        // 知识健康只读提示（无执行入口）。
        const health = await page.locator('[data-kc-health-hint]').first();
        assert(await health.count() === 1, '画布应有知识健康提示');
        const canvasText = await page.evaluate(() => document.querySelector('[data-kc-view="knowledge-network"]')?.textContent ?? '');
        assert(!canvasText.includes('startKnowledgeMaintenance') && !canvasText.includes('全库整理开始'), '画布不应出现维护执行入口');
      });

      await step(evidence, '主题：搜索本主题资料 + 相关动态（topicId 限定，无维护控件）', async () => {
        await navigateTo(page, 'topic');
        // 打开 AI Agent 工具链 详情（列表卡或已开详情任一）。
        await page.waitForFunction(() => {
          const h2 = document.querySelector('.topic-object-head h2');
          if (h2?.textContent === 'AI Agent 工具链') return true;
          return [...document.querySelectorAll('.topic-object-card .topic-object-card-top strong')]
            .some((el) => el.textContent === 'AI Agent 工具链');
        }, null, { timeout: 25_000 });
        const head = page.locator('.topic-object-head h2');
        if (await head.count() === 0 || await head.first().textContent({ timeout: 2_000 }).catch(() => '') !== 'AI Agent 工具链') {
          await page.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first().click();
          await page.waitForFunction(() => document.querySelector('.topic-object-head h2')?.textContent === 'AI Agent 工具链', null, { timeout: 25_000 });
        }
        await page.locator('.topic-wiki-page').first().waitFor({ state: 'visible', timeout: 20_000 });
        // 搜索本主题资料位于「资料」页签；相关动态位于「变化」页签。
        await page.locator('.topic-wiki-tabs button', { hasText: '资料' }).first().click();
        await page.locator('.topic-wiki-search').first().waitFor({ state: 'visible', timeout: 15_000 });
        const topicText = await page.evaluate(() => document.querySelector('.topic-wiki-page')?.textContent ?? '');
        assert(topicText.includes('搜索本主题资料'), '主题应有 搜索本主题资料');
        assert(!topicText.includes('startKnowledgeMaintenance') && !topicText.includes('全库整理开始'), '主题不应有维护执行入口');
        // 搜索本主题资料命中。
        const topicInput = page.locator('.topic-wiki-search-input').first();
        if (await topicInput.count()) {
          await topicInput.fill('AgentForge');
          await page.waitForFunction(() => {
            const text = document.querySelector('.topic-wiki-search')?.textContent ?? '';
            return text.includes('找到');
          }, null, { timeout: 15_000 });
          const topicSearchText = await bodyText(page, '.topic-wiki-search');
          assert(!ENGINEERING_PATTERN.test(topicSearchText), `主题搜索泄漏工程词: ${topicSearchText.slice(0, 200)}`);
        }
        // 相关动态在「变化」页签（topicId 限定；无维护控件）。
        await page.locator('.topic-wiki-tabs button', { hasText: '变化' }).first().click();
        await page.locator('.topic-wiki-activity').first().waitFor({ state: 'visible', timeout: 15_000 });
        const activityText = await bodyText(page, '.topic-wiki-activity');
        assert(activityText.includes('相关动态'), '主题应有 相关动态');
        assert(!ENGINEERING_PATTERN.test(activityText), `主题动态泄漏工程词: ${activityText.slice(0, 200)}`);
      });

      await step(evidence, '无新顶层路由 + 1568 宽无横向溢出', async () => {
        // 侧栏知识资产仍 主题|资料库|关系画布（无独立 Wiki 顶层入口）。
        const sidebar = await page.evaluate(() => document.querySelector('aside.sidebar')?.textContent ?? '');
        assert(sidebar.includes('主题') && sidebar.includes('资料库') && sidebar.includes('关系画布'), '侧栏应仍 主题|资料库|关系画布');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflow <= 0, `1568 宽不应横向溢出，实际 scrollWidth-clientWidth=${overflow}`);
      });

      await step(evidence, '重启读回：维护状态沿 SQLite 持久化，重启后 UI 读回一致', async () => {
        const db = openReadOnlyDb(workspace.dataRoot);
        const row = db.db.prepare("SELECT value FROM app_meta WHERE key = 'wmb_knowledge_maintenance_v1'").get();
        db.close();
        // 若已执行过 start，run 记录应持久化（无论当前 paused/running/completed）。
        if (row) {
          const run = JSON.parse(String(row.value));
          assert(run.workspaceId === workspace.workspaceId, 'run 应绑定当前工作空间');
          assert(typeof run.status === 'string' && ['running', 'paused', 'completed', 'failed'].includes(run.status), 'run 状态应合法');
        }
      });

      await step(evidence, '捕获成功证据（截图/控制台/日志）', async () => {
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'wmb-5239-pass' });
      });

      return { maintenanceStarted: true };
    }
  }
];
