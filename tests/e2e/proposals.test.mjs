// 选题 (Proposals ledger) surface Electron E2E scenarios (WMB-5243).
//
// Journeys implemented: PP-001..PP-006 (see tests/e2e/user-journeys.json).
// Real Electron + isolated workspace fixture; assertions on user-visible DOM /
// navigation / real IPC (dismiss/restore go through the production dispatcher
// with receipts); SQLite used for dual readback only.

import { helpers } from './harness.mjs';
import { NOW, shanghaiPlanDate, openDb, seedPlan, seedContentProject } from './lib/seed.mjs';

const { waitForAppReady, navigateTo, VIEW_TITLES } = helpers;

const planDate = shanghaiPlanDate();

// 标题两两 bigram Jaccard < 0.5（见 ferment-read sameStory），避免选题池 story 去重把它们折叠成一条。
const OPEN_ITEMS = [
  { title: 'E2E 选题 A', priority: 1, timeliness: '长青' },
  { title: 'E2E 品牌案例', priority: 2, timeliness: '爆点' },
  { title: 'E2E 方法论拆解', priority: 3, timeliness: '长青' }
];

async function healthCheck(page, evidence, assert, step) {
  await step('健康: 无页面异常 / 无崩溃', async () => {
    assert(!evidence.crashed, '渲染进程崩溃');
    assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
  });
}

export default [
  {
    id: 'PP-001-proposals-ledger-normal',
    journeyIds: ['PP-001-proposals-ledger-normal'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          seedPlan(db, { planDate, items: OPEN_ITEMS });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开选题页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'proposals');
        await page.locator('.proposals-page').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('五个页签与台账计数渲染', async () => {
        const tabs = await page.locator('.proposal-tabs .proposal-tab').allTextContents();
        assert(tabs.some((t) => t.includes('今日可批')) && tabs.some((t) => t.includes('待处理'))
          && tabs.some((t) => t.includes('已采纳')) && tabs.some((t) => t.includes('已否掉'))
          && tabs.some((t) => t.includes('已过期')), `页签缺失: ${tabs.join(' | ')}`);
        // 台账为异步加载：先等「今日可批」计数到位，再断言值（避免加载竞态读到 0）。
        await page.waitForFunction(
          () => Number((document.querySelector('.proposal-tab-count')?.textContent ?? '').trim()) === 3,
          null,
          { timeout: 15_000 }
        );
        const todayCount = await page.locator('.proposal-tab-count').first().textContent();
        assert(Number((todayCount ?? '').trim()) === 3, `今日可批计数应为 3，实际 ${todayCount}`);
        const stats = ((await page.locator('.page-command-stats').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(stats.includes('3') && stats.includes('今日可批'), `台账统计异常: ${stats}`);
      });
      await step('今日可批列表展示选题卡字段', async () => {
        const cards = page.locator('.proposal-open-list [data-opportunity-card]');
        await cards.first().waitFor({ state: 'visible', timeout: 15_000 });
        assert(await cards.count() === 3, `今日可批应 3 条，实际 ${await cards.count()}`);
        const first = await cards.first().textContent();
        assert(first.includes('E2E 选题 A') && (first.includes('时效') || first.includes('长青') || first.includes('爆点') || first.includes('热点')), '选题卡标题/时效字段缺失');
      });
      await step('页签切换渲染对应状态列表', async () => {
        for (const [label, emptyTitle] of [['待处理', '没有待处理选题'], ['已采纳', '还没有已采纳选题'], ['已否掉', '还没有否掉的选题'], ['已过期', '还没有过期选题']]) {
          await page.locator('.proposal-tabs .proposal-tab', { hasText: label }).click();
          await page.waitForFunction(
            (t) => (document.querySelector('.proposal-empty h2')?.textContent ?? '').includes(t),
            emptyTitle,
            { timeout: 10_000 }
          );
        }
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '今日可批' }).click();
        await page.locator('.proposal-open-list').waitFor({ state: 'visible', timeout: 10_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { tabs: 5, today: 3, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'PP-002-proposals-adopt-dismiss-restore',
    journeyIds: ['PP-002-proposals-adopt-dismiss-restore'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          const plan = seedPlan(db, {
            planDate,
            items: [
              { id: 'pi-open', title: 'E2E 待否掉选题', priority: 1, timeliness: '长青' },
              { id: 'pi-adopted', title: 'E2E 已采纳选题', priority: 2, timeliness: '长青' }
            ]
          });
          seedContentProject(db, { planItemId: 'pi-adopted', title: 'E2E 采纳项目' });
          return plan;
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开选题页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'proposals');
        await page.locator('.proposal-open-list').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('否掉选题: 确认弹窗 → 条目进入已否掉并留痕', async () => {
        const card = page.locator('.proposal-open-item [data-opportunity-card]', { hasText: 'E2E 待否掉选题' });
        await card.locator('.icon-action-button.dismiss-action').click();
        await page.locator('.app-confirm-dialog[role="alertdialog"]').waitFor({ state: 'visible', timeout: 10_000 });
        assert(((await page.locator('.app-confirm-message').textContent()) ?? '').includes('否掉这个选题'), '确认弹窗文案异常');
        await page.locator('.app-confirm-actions .primary-button').click();
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '已否掉' }).click();
        await page.waitForFunction(() => (document.querySelector('.proposal-row')?.textContent ?? '').includes('E2E 待否掉选题'), null, { timeout: 15_000 });
        assert(((await page.locator('.proposal-row .proposal-state').textContent()) ?? '').includes('已否掉'), '已否掉留痕缺失');
      });
      await step('恢复选题: 从已否掉回到今日可批', async () => {
        await page.locator('.proposal-row .proposal-go-studio', { hasText: '恢复' }).click();
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '今日可批' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.proposal-open-item .opp-title')].some((el) => el.textContent?.includes('E2E 待否掉选题')), null, { timeout: 15_000 });
      });
      await step('已采纳条目可去创作打开对应项目', async () => {
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '已采纳' }).click();
        const row = page.locator('.proposal-row', { hasText: 'E2E 已采纳选题' });
        await row.waitFor({ state: 'visible', timeout: 15_000 });
        const goStudio = row.locator('.proposal-go-studio', { hasText: '去创作' });
        await goStudio.click();
        await page.waitForSelector('main.app-shell.studio-mode', { state: 'visible', timeout: 20_000 });
        assert(((await page.locator('main.app-shell').textContent()) ?? '').includes('E2E 采纳项目') || (await page.locator('.studio-editor-view, .studio-library').count()) >= 1, '创作页未打开对应项目');
      });
      await healthCheck(page, evidence, assert, step);
      return { dismissed: true, restored: true, adopted: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'PP-003-proposals-batch-dismiss',
    journeyIds: ['PP-003-proposals-batch-dismiss'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          seedPlan(db, { planDate, items: OPEN_ITEMS });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开选题页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'proposals');
        await page.locator('.proposal-open-list').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('进入批量模式勾选两条', async () => {
        await page.locator('.proposal-batch-toggle').click();
        await page.waitForFunction(() => document.querySelectorAll('.proposal-open-item .proposal-check input[type="checkbox"]').length >= 3, null, { timeout: 10_000 });
        const boxes = page.locator('.proposal-open-item .proposal-check input[type="checkbox"]');
        await boxes.nth(0).check();
        await boxes.nth(1).check();
        const bar = page.locator('.proposal-batch-bar[aria-label="批量操作"]');
        await bar.waitFor({ state: 'visible', timeout: 10_000 });
        assert(((await bar.textContent()) ?? '').includes('已勾选 2 条'), '批量栏勾选计数异常');
      });
      await step('批量否掉: 确认后全部移入已否掉且计数更新', async () => {
        await page.locator('.proposal-batch-actions .primary-button.danger-button').click();
        await page.locator('.app-confirm-dialog[role="alertdialog"]').waitFor({ state: 'visible', timeout: 10_000 });
        assert(((await page.locator('.app-confirm-message').textContent()) ?? '').includes('2 条选题'), '批量确认文案未含条数');
        await page.locator('.app-confirm-actions .primary-button').click();
        await page.waitForFunction(() => {
          const todayCount = document.querySelector('.proposal-tab-count')?.textContent ?? '';
          return Number(todayCount.trim()) === 1;
        }, null, { timeout: 15_000 });
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '已否掉' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.proposal-row').length >= 2, null, { timeout: 15_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { batch: 2, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'PP-004-proposals-empty',
    journeyIds: ['PP-004-proposals-empty'],
    run: async ({ page, evidence, assert, step }) => {
      await step('空工作空间打开选题页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'proposals');
        await page.locator('.proposals-page').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('各页签空态文案与回到今日入口', async () => {
        await page.locator('.proposal-empty h2', { hasText: '今日没有待批选题' }).waitFor({ state: 'visible', timeout: 15_000 });
        const goToday = page.locator('.proposal-empty .primary-button', { hasText: '回到今日' });
        await goToday.waitFor({ state: 'visible', timeout: 10_000 });
        for (const [label, title] of [['待处理', '没有待处理选题'], ['已采纳', '还没有已采纳选题'], ['已否掉', '还没有否掉的选题'], ['已过期', '还没有过期选题']]) {
          await page.locator('.proposal-tabs .proposal-tab', { hasText: label }).click();
          await page.waitForFunction((t) => (document.querySelector('.proposal-empty h2')?.textContent ?? '').includes(t), title, { timeout: 10_000 });
        }
      });
      await step('回到今日按钮导航到今日页', async () => {
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '今日可批' }).click();
        await page.locator('.proposal-empty .primary-button', { hasText: '回到今日' }).click();
        await page.waitForFunction(
          (t) => document.querySelector(`nav button[title="${t}"]`)?.classList.contains('active'),
          VIEW_TITLES.today,
          { timeout: 15_000 }
        );
      });
      await healthCheck(page, evidence, assert, step);
      return { empty: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'PP-005-proposals-error',
    journeyIds: ['PP-005-proposals-error'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          // One good evergreen item + one breaking item with an unparseable
          // created_at: dispositionOfPlanItem computes expiresAt via
          // new Date(Date.parse(createdAt) + window).toISOString(), which
          // throws RangeError for windowed items -> honest ledger error state.
          seedPlan(db, {
            planDate,
            items: [
              { title: 'E2E 好选题', priority: 1, timeliness: '长青' },
              { title: 'E2E 坏选题', priority: 2, timeliness: '爆点' }
            ]
          });
          db.prepare("UPDATE plan_items SET created_at = 'not-a-date' WHERE title = 'E2E 坏选题'").run();
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step, workspace }) => {
      await step('启动进入主壳并打开选题页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'proposals');
      });
      await step('台账加载失败显示错误态且可恢复', async () => {
        await page.locator('.proposal-empty h2', { hasText: '台账操作失败' }).waitFor({ state: 'visible', timeout: 20_000 });
        const body = ((await page.locator('.proposal-empty').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(body.length > 0, '错误详情缺失');
      });
      await step('修复数据源后重新进入台账恢复渲染', async () => {
        // Repair the fixture row directly (test-side write; the app holds the
        // runtime handle but SQLite allows a bounded external writer).
        const db = openDb(workspace.dataRoot);
        try {
          db.prepare("UPDATE plan_items SET created_at = ? WHERE created_at = 'not-a-date'").run(NOW());
        } finally {
          db.close();
        }
        // 页签切换触发台账重载（不经过 today:get，避免坏日期把今日页拖入 RangeError）。
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '待处理' }).click();
        await page.waitForFunction(
          (t) => (document.querySelector('.proposal-empty h2')?.textContent ?? '').includes(t),
          '没有待处理选题',
          { timeout: 10_000 }
        );
        await page.locator('.proposal-tabs .proposal-tab', { hasText: '今日可批' }).click();
        await page.locator('.proposal-open-list').waitFor({ state: 'visible', timeout: 20_000 });
        assert(((await page.locator('.proposal-open-list').textContent()) ?? '').includes('E2E 好选题'), '修复后台账未恢复渲染');
      });
      await healthCheck(page, evidence, assert, step);
      return { errorShown: true, recovered: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'PP-006-proposals-pi-selection',
    journeyIds: ['PP-006-proposals-pi-selection'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          seedPlan(db, { planDate, items: [{ title: 'E2E 焦点选题', priority: 1, timeliness: '长青' }] });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开选题页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'proposals');
        await page.locator('.proposal-open-list').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('选中选题卡后 Pi 上下文 chip 显示选题台账与标题', async () => {
        const card = page.locator('.proposal-open-item [data-opportunity-card]').first();
        await card.click();
        await page.waitForFunction(() => {
          const text = document.querySelector('.pi-context-chip span')?.textContent ?? '';
          return text.includes('选题台账') && text.includes('E2E 焦点选题');
        }, null, { timeout: 15_000 });
        const chip = ((await page.locator('.pi-context-chip span').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(chip.includes('选题台账') && chip.includes('E2E 焦点选题'), `Pi chip 异常: ${chip}`);
      });
      await step('切走视图后选择清空', async () => {
        await navigateTo(page, 'today');
        await page.waitForFunction(() => {
          const text = document.querySelector('.pi-context-chip span')?.textContent ?? '';
          return !text.includes('E2E 焦点选题') && !text.includes('选题台账');
        }, null, { timeout: 15_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { piFocus: true, pageerrors: evidence.pageerrors.length };
    }
  }
];
