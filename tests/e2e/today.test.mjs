// 今日 (Today) surface Electron E2E scenarios (WMB-5243).
//
// Journeys implemented: TD-001..TD-006 (see tests/e2e/user-journeys.json).
// All scenarios run against a real Electron app with an isolated workspace
// fixture; assertions are user-visible DOM / navigation / real IPC, with the
// SQLite DB used only for dual readback. No external network side effects:
// nothing here starts Pi, MCP, or browser sessions.
//
// Scenario contract: default export = array of { id, journeyIds, launch?, run(ctx) }.
// ctx = { app, page, workspace, artifactsDir, evidence, runtimeDir, helpers, assert, step, openDb }.

import { helpers } from './harness.mjs';
import {
  NOW, shanghaiPlanDate, openDb,
  seedPlan, seedSource, seedTopic, seedTopicSourceLink
} from './lib/seed.mjs';

const { waitForAppReady, navigateTo, VIEW_TITLES, delay } = helpers;

const planDate = shanghaiPlanDate();

/** Seed a today plan (primary + N secondary opportunities) and today's sources. */
function seedTodayWorkspace({ items, sources }) {
  return async ({ dataRoot }) => {
    const db = openDb(dataRoot);
    try {
      const plan = seedPlan(db, { planDate, items });
      const sourceIds = (sources ?? []).map((s) => seedSource(db, s));
      return { plan, sourceIds };
    } finally {
      db.close();
    }
  };
}

// 标题两两 bigram Jaccard < 0.5（ferment-read sameStory），避免选题池 story 去重把两条计划折叠成一条。
const IDLE_ITEMS = [
  { title: 'E2E 机会 1', priority: 1, timeliness: '爆点' },
  { title: 'E2E 长青选题 B', priority: 2, timeliness: '长青' }
];
const TODAY_SOURCES = [
  { title: 'E2E 资料 1', summary: 'E2E 资料摘要 1', author: 'E2E 作者', originalUrl: 'https://example.com/e2e/source-1' },
  { title: 'E2E 资料 2', summary: 'E2E 资料摘要 2', author: 'E2E 作者', originalUrl: 'https://example.com/e2e/source-2' }
];

export default [
  {
    id: 'TD-001-today-plan-normal',
    journeyIds: ['TD-001-today-plan-normal'],
    launch: { seedFixture: seedTodayWorkspace({ items: IDLE_ITEMS, sources: [] }) },
    run: async ({ page, evidence, assert, step, openDb }) => {
      await step('启动进入主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
      });
      await step('今日页渲染空闲命令栏与计划项', async () => {
        await page.locator('.today-command[data-mode="idle"]').waitFor({ state: 'visible', timeout: 20_000 });
        const hero = page.locator('.opportunity-primary.hero-card');
        await hero.waitFor({ state: 'visible', timeout: 20_000 });
        assert(((await hero.locator('h2').textContent()) ?? '').trim() === 'E2E 机会 1', '主计划项标题不符');
        assert(await page.locator('.opp-row[data-opportunity-card]').count() === 1, '次级计划项应恰好 1 条');
      });
      await step('选题台账入口显示计数并可导航', async () => {
        const entry = page.locator('.proposal-ledger-entry');
        await entry.waitFor({ state: 'visible', timeout: 15_000 });
        const text = ((await entry.textContent()) ?? '').replace(/\s+/g, ' ');
        assert(text.includes('选题台账') && text.includes('今日可批'), `选题台账入口文案异常: ${text}`);
        await entry.click();
        await page.waitForFunction(
          (t) => document.querySelector(`nav button[title="${t}"]`)?.classList.contains('active'),
          VIEW_TITLES.proposals,
          { timeout: 15_000 }
        );
      });
      await step('回到今日，主机会「开始创作」打开创作页', async () => {
        await navigateTo(page, 'today');
        const create = page.locator('.opportunity-primary .icon-action-button.create-action');
        await create.waitFor({ state: 'visible', timeout: 15_000 });
        await create.click();
        await page.waitForSelector('main.app-shell.studio-mode', { state: 'visible', timeout: 20_000 });
        const db = openDb();
        try {
          const row = db.db.prepare('SELECT plan_item_id AS planItemId FROM content_projects WHERE plan_item_id IS NOT NULL LIMIT 1').get();
          assert(Boolean(row?.planItemId), '点击创作后未落库 content_projects(plan_item_id)');
        } finally {
          db.close();
        }
      });
      await step('健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { plan: 2, studio: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'TD-002-today-run-running',
    journeyIds: ['TD-002-today-run-running'],
    // 不在夹具里预置 running 任务：应用启动时会尝试恢复 running 的 daily 任务并重驱管线
    // （恢复路径会因 Pi 配置未真实加密而把任务泊入 needs_user，无法呈现「运行中」）。
    // 改为启动后经真实 IPC agent:start 创建 running 任务 → data:changed 驱动今日页进入运行态。
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          for (const s of TODAY_SOURCES) seedSource(db, s);
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
      });
      await step('运行中状态: 真实 IPC 启动 daily 任务 → 命令栏 data-mode=running', async () => {
        const started = await page.evaluate(
          (bd) => window.wmb.startAgentTask({ intent: 'daily_intelligence', businessDate: bd }),
          planDate
        );
        assert(Boolean(started?.ok || started?.reused), `启动运行任务失败: ${JSON.stringify(started?.error ?? started)}`);
        await page.locator('.today-command[data-mode="running"]').waitFor({ state: 'visible', timeout: 30_000 });
      });
      await step('入库信息流渲染今日来源', async () => {
        await page.locator('.feed-list').waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForFunction(() => document.querySelectorAll('.feed-item[data-feed-item]').length >= 2, null, { timeout: 15_000 });
      });
      await step('健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { running: true, feed: 2, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'TD-003-today-empty',
    journeyIds: ['TD-003-today-empty'],
    run: async ({ page, evidence, assert, step }) => {
      await step('空工作空间进入主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
      });
      await step('空态文案: feed 无资料、机会区空态、命令栏 idle', async () => {
        await page.locator('.today-command[data-mode="idle"]').waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('.today-opps .empty-state').waitFor({ state: 'visible', timeout: 15_000 });
        const emptyCopy = await page.locator('.feed-list .empty-copy').first().textContent();
        assert(/今日还没有入库资料|暂无可用入库资料/.test(emptyCopy ?? ''), `feed 空态文案异常: ${emptyCopy}`);
      });
      await step('无数据时仍可导航到其他视图', async () => {
        await navigateTo(page, 'discover');
        await page.waitForFunction(
          (t) => document.querySelector(`nav button[title="${t}"]`)?.classList.contains('active'),
          VIEW_TITLES.discover,
          { timeout: 15_000 }
        );
      });
      await step('健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { empty: true, navigable: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'TD-004-today-selection-pi-context',
    journeyIds: ['TD-004-today-selection-pi-context'],
    launch: { seedFixture: seedTodayWorkspace({ items: IDLE_ITEMS, sources: TODAY_SOURCES }) },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
      });
      await step('选择资料进入 Pi 上下文并显示已选计数', async () => {
        const feedItem = page.locator('.feed-item[data-feed-item]').first();
        await feedItem.waitFor({ state: 'visible', timeout: 20_000 });
        await feedItem.click();
        const bar = page.locator('.feed-selection-bar');
        await bar.waitFor({ state: 'visible', timeout: 10_000 });
        const text = ((await bar.textContent()) ?? '').replace(/\s+/g, ' ');
        assert(text.includes('已选 1/5 条资料进 Pi'), `已选计数不符: ${text}`);
      });
      await step('Pi 上下文 chip 反映今日内容与选中资料', async () => {
        const chip = page.locator('.pi-context-chip span');
        await chip.waitFor({ state: 'visible', timeout: 10_000 });
        const text = ((await chip.textContent()) ?? '').replace(/\s+/g, ' ');
        assert(text.includes('今日内容') && text.includes('1 条资料'), `Pi chip 未反映今日选中: ${text}`);
      });
      await step('勾选主机会后 chip 显示选中标题', async () => {
        const hero = page.locator('.opportunity-primary.hero-card');
        await hero.click();
        await page.waitForFunction(() => (document.querySelector('.pi-context-chip span')?.textContent ?? '').includes('E2E 机会 1'), null, { timeout: 10_000 });
      });
      await step('切换到选题页后选择状态清空, chip 不再引用今日选中', async () => {
        await navigateTo(page, 'proposals');
        await page.waitForFunction(() => {
          const text = document.querySelector('.pi-context-chip span')?.textContent ?? '';
          return text.includes('选题台账') && !text.includes('E2E 机会 1') && !text.includes('今日内容');
        }, null, { timeout: 15_000 });
      });
      await step('健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { selectedSources: 1, chip: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'TD-005-today-error-recovery',
    journeyIds: ['TD-005-today-error-recovery'],
    // 两条 bigram 互异的机会：否掉次级机会 → 选题池刷新（data:changed）后该行从主区消失；
    // 恢复 → 重新出现。覆盖「真实 IPC 变更 → 页面经 data:changed 自动刷新恢复」的恢复契约。
    launch: { seedFixture: seedTodayWorkspace({
      items: [
        { title: 'E2E 主机会', priority: 1, timeliness: '爆点' },
        { title: 'E2E 次级机会', priority: 2, timeliness: '长青' }
      ],
      sources: []
    }) },
    run: async ({ page, evidence, assert, step, workspace }) => {
      const itemId = (() => {
        const db = openDb(workspace.dataRoot);
        try {
          return db.prepare('SELECT id FROM plan_items WHERE title = ?').get('E2E 次级机会').id;
        } finally {
          db.close();
        }
      })();
      await step('启动进入主壳, 主次机会卡可见', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await page.locator('.opportunity-primary.hero-card').waitFor({ state: 'visible', timeout: 20_000 });
        assert(((await page.locator('.opportunity-primary.hero-card h2').textContent()) ?? '').trim() === 'E2E 主机会', '主机会标题不符');
        await page.locator('.opp-row[data-opportunity-card]').waitFor({ state: 'visible', timeout: 15_000 });
      });
      await step('真实 IPC 否掉次级机会 → data:changed 刷新, 次级行消失且不白屏', async () => {
        await page.evaluate((id) => window.wmb.dismissPlanItem({ planItemId: id }), itemId);
        await page.waitForFunction(() => document.querySelectorAll('.opp-row[data-opportunity-card]').length === 0, null, { timeout: 15_000 });
        assert(((await page.locator('.opportunity-primary.hero-card h2').textContent()) ?? '').trim() === 'E2E 主机会', '否掉次级后主机会应保留');
        assert((await page.locator('.app-shell').count()) === 1, '页面应保持渲染（无白屏崩溃）');
      });
      await step('真实 IPC 恢复选题 → 数据经 data:changed 回到页面', async () => {
        await page.evaluate((id) => window.wmb.restoreProposal({ planItemId: id }), itemId);
        await page.locator('.opp-row[data-opportunity-card]').waitFor({ state: 'visible', timeout: 15_000 });
        assert(((await page.locator('.opp-row[data-opportunity-card] .opp-title').textContent()) ?? '').trim() === 'E2E 次级机会', '恢复后次级机会未回到页面');
      });
      await step('健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { recovered: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'TD-006-today-fermenting-rail',
    journeyIds: ['TD-006-today-fermenting-rail'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          const sourceId = seedSource(db, { title: 'E2E 发酵来源', summary: 'E2E 发酵摘要', originalUrl: 'https://example.com/e2e/ferment' });
          const topicId = seedTopic(db, { title: 'E2E 发酵主题' });
          seedTopicSourceLink(db, { topicId, sourceId });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
      });
      await step('持续关注发酵栏渲染主题条目', async () => {
        const rail = page.locator('details.fermenting-rail[aria-label="持续关注"]');
        await rail.waitFor({ state: 'visible', timeout: 20_000 });
        const summary = ((await rail.locator('summary').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(/持续关注 · 主题 · [1-9]/.test(summary), `发酵栏主题计数异常: ${summary}`);
        await page.waitForFunction(() => document.querySelectorAll('.fermenting-list .fermenting-row').length >= 1, null, { timeout: 10_000 });
      });
      await step('健康: 无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { fermenting: true, pageerrors: evidence.pageerrors.length };
    }
  }
];
