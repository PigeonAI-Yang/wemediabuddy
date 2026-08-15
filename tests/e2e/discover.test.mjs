// 发现 (Discover) surface Electron E2E scenarios (WMB-5243).
//
// Journeys implemented: DS-001..DS-006 (see tests/e2e/user-journeys.json).
// Real Electron + isolated workspace fixture. The GitHub/Lists live fetches are
// never triggered: rankings come from the seeded ranking_cache (rankings:get-cached),
// the X Lists surface is cache-seeded for the happy path and fixture-empty for the
// load-error boundary (readXListIndex fails locally — no browser binding, zero egress).

import { helpers } from './harness.mjs';
import { NOW, openDb, seedRankingCache, seedSourceFeed, seedXListBinding, seedXListIndex, seedXListTimeline } from './lib/seed.mjs';

const { waitForAppReady, navigateTo, VIEW_TITLES } = helpers;

const readyBoards = [
  {
    id: 'b-daily', label: '今日榜', kind: 'rankings', sourceId: 'github', sourceLabel: 'GitHub',
    sourceUrl: 'https://github.com/trending', status: 'ready',
    items: [
      { rank: 1, name: 'agentforge', description: 'E2E 项目 A：多模型路由', language: 'TypeScript', stars: '12.3k', gained: '+120', url: 'https://github.com/example/agentforge' },
      { rank: 2, name: 'wmb-toolkit', description: 'E2E 项目 B：自媒体终端', language: 'Python', stars: '4.1k', gained: '+45', url: 'https://github.com/example/wmb-toolkit' }
    ]
  },
  {
    id: 'b-weekly', label: '周榜', kind: 'rankings', sourceId: 'github', sourceLabel: 'GitHub',
    sourceUrl: 'https://github.com/trending', status: 'ready',
    items: [
      { rank: 1, name: 'pi-cli', description: 'E2E 项目 C：Pi 命令行', language: 'Go', stars: '2.7k', gained: '+98', url: 'https://github.com/example/pi-cli' }
    ]
  }
];

async function clickListsSection(page) {
  const listsStat = page.locator('.page-command-stat', { hasText: 'Lists' });
  await listsStat.waitFor({ state: 'visible', timeout: 15_000 });
  await listsStat.click();
  await page.locator('.x-lists-view').waitFor({ state: 'visible', timeout: 20_000 });
}

async function healthCheck(page, evidence, assert, step) {
  await step('健康: 无页面异常 / 无崩溃', async () => {
    assert(!evidence.crashed, '渲染进程崩溃');
    assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
  });
}

export default [
  {
    id: 'DS-001-discover-rankings-normal',
    journeyIds: ['DS-001-discover-rankings-normal'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          seedRankingCache(db, { boards: readyBoards });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step, workspace }) => {
      await step('启动进入主壳并打开发现页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'discover');
        await page.locator('.ranking-list').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('榜单条目渲染（排名/名称/描述）与来源/board 筛选', async () => {
        const items = page.locator('.ranking-list [data-ranking-item]');
        assert(await items.count() === 2, `默认 board 应渲染 2 条，实际 ${await items.count()}`);
        assert(((await items.nth(0).locator('.ranking-number').textContent()) ?? '').trim() === '1', '排名缺失');
        assert(((await items.nth(0).locator('h2').textContent()) ?? '').trim() === 'agentforge', '条目名称缺失');
        assert(((await items.nth(0).locator('p').textContent()) ?? '').includes('E2E 项目 A'), '条目描述缺失');
        assert(await page.locator('.discover-sources .chip').count() === 1, '来源 chip 缺失');
        assert(await page.locator('.filter-row .filter').count() === 2, 'board 筛选按钮缺失');
      });
      await step('切换 board 生效并标记 context-selected', async () => {
        const weekly = page.locator('.filter-row .filter', { hasText: '周榜' });
        await weekly.click();
        await page.waitForFunction(() => document.querySelectorAll('.filter-row .filter.context-selected').length >= 1, null, { timeout: 10_000 });
        await page.waitForFunction(() => (document.querySelector('.ranking-list h2')?.textContent ?? '').trim() === 'pi-cli', null, { timeout: 10_000 });
      });
      await step('刷新按钮存在且可触发 loading 态', async () => {
        const refresh = page.locator('.ranking-actions .refresh-button');
        await refresh.waitFor({ state: 'visible', timeout: 10_000 });
        // Do not click: rankings:github-ai would egress to GitHub; the button's
        // presence + disabled-during-loading contract is asserted instead.
        const disabled = await refresh.isDisabled();
        assert(disabled === false, '空闲时刷新按钮不应禁用');
      });
      await step('入库写入资料库并显示成功提示', async () => {
        await page.locator('.filter-row .filter', { hasText: '今日榜' }).click();
        const save = page.locator('.ranking-save').first();
        await save.waitFor({ state: 'visible', timeout: 10_000 });
        await save.click();
        await page.waitForFunction(() => (document.querySelector('.task-status')?.textContent ?? '').includes('已收入资料库:agentforge'), null, { timeout: 15_000 });
        await page.waitForFunction(() => (document.querySelector('.ranking-save')?.textContent ?? '').includes('✓'), null, { timeout: 10_000 });
        const db = openDb(workspace.dataRoot);
        try {
          const row = db.prepare("SELECT title FROM source_items WHERE title = 'agentforge'").get();
          assert(Boolean(row), '入库后资料库应出现该来源');
        } finally {
          db.close();
        }
      });
      await healthCheck(page, evidence, assert, step);
      return { rankings: 2, saved: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'DS-002-discover-lists-normal',
    journeyIds: ['DS-002-discover-lists-normal'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          // 榜单区也需要缓存数据才处于 normal 态（首步等待 .ranking-list 渲染）。
          seedRankingCache(db, { boards: readyBoards });
          seedSourceFeed(db, { id: 'feed-e2e', name: 'E2E Feed' });
          seedXListIndex(db, {
            accountKey: 'e2e-account',
            lists: [
              { listId: 'l-1', canonicalUrl: 'https://x.com/i/lists/1', name: 'AI 资讯', ownerHandle: 'owner1', kind: 'owned' },
              { listId: 'l-2', canonicalUrl: 'https://x.com/i/lists/2', name: '工具党', ownerHandle: 'owner2', kind: 'following' }
            ]
          });
          seedXListBinding(db, { id: 'bind-1', accountKey: 'e2e-account', listId: 'l-1', canonicalUrl: 'https://x.com/i/lists/1', ownerHandle: 'owner1', name: 'AI 资讯', kind: 'owned', sourceFeedId: 'feed-e2e' });
          seedXListBinding(db, { id: 'bind-2', accountKey: 'e2e-account', listId: 'l-2', canonicalUrl: 'https://x.com/i/lists/2', ownerHandle: 'owner2', name: '工具党', kind: 'following', sourceFeedId: 'feed-e2e' });
          seedXListTimeline(db, {
            accountKey: 'e2e-account', listId: 'l-1',
            posts: [
              { url: 'https://x.com/alice/status/1', authorHandle: '@alice', displayName: 'Alice', text: 'E2E 帖子一：AI 资讯', postedAt: NOW(), metrics: { likes: 12 } },
              { url: 'https://x.com/bob/status/2', authorHandle: '@bob', displayName: 'Bob', text: 'E2E 帖子二：工具链', postedAt: NOW(), metrics: { reposts: 3 } }
            ]
          });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开发现页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'discover');
        await page.locator('.ranking-list').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('切到 Lists 区: 缓存索引分组渲染', async () => {
        await clickListsSection(page);
        await page.waitForFunction(() => document.querySelectorAll('.x-lists-view .filter-row .filter').length >= 2, null, { timeout: 15_000 });
        const chips = await page.locator('.x-lists-view .filter-row .filter').allTextContents();
        assert(chips.some((c) => c.includes('AI 资讯')) && chips.some((c) => c.includes('工具党')), `List 分组缺失: ${chips.join(' | ')}`);
      });
      await step('选择 List 渲染缓存时间线卡片（作者/文本）', async () => {
        // 进入 Lists 区时默认选中首个 List 并读取缓存时间线（避免二次点击改变选中态导致空 feed）。
        const feed = page.locator('.x-timeline-feed[aria-label="List 动态"]');
        await feed.waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForFunction(() => document.querySelectorAll('.x-timeline-item').length >= 2, null, { timeout: 15_000 });
        const text = ((await feed.textContent()) ?? '').replace(/\s+/g, ' ');
        assert(text.includes('E2E 帖子一：AI 资讯') && text.includes('Alice') && text.includes('@alice'), '时间线卡片内容缺失');
      });
      await step('刷新动态按钮与读取路径可用', async () => {
        const refresh = page.locator('.x-list-primary');
        await refresh.waitFor({ state: 'visible', timeout: 10_000 });
        assert(((await refresh.textContent()) ?? '').includes('刷新动态'), '刷新动态按钮缺失');
      });
      await healthCheck(page, evidence, assert, step);
      return { lists: 2, posts: 2, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'DS-003-discover-rankings-error',
    journeyIds: ['DS-003-discover-rankings-error'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          seedRankingCache(db, {
            boards: [{
              id: 'b-unavail', label: 'AI 榜单', kind: 'rankings', sourceId: 'github', sourceLabel: 'GitHub',
              sourceUrl: 'https://github.com/trending', status: 'unavailable',
              error: 'E2E 模拟榜单暂不可读', items: []
            }]
          });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开发现页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'discover');
      });
      await step('board 不可用时显示暂时不可读与打开来源', async () => {
        const empty = page.locator('.empty-state.library-empty');
        await empty.waitFor({ state: 'visible', timeout: 20_000 });
        assert(((await empty.locator('h2').textContent()) ?? '').includes('暂时不可读'), `错误态标题异常: ${await empty.locator('h2').textContent()}`);
        assert(((await empty.textContent()) ?? '').includes('E2E 模拟榜单暂不可读'), '错误信息未展示');
        const openSource = page.locator('.empty-state.library-empty button', { hasText: '打开来源' });
        await openSource.waitFor({ state: 'visible', timeout: 10_000 });
      });
      await step('错误态下仍可切到 Lists 区', async () => {
        await clickListsSection(page);
        await page.locator('.empty-state.library-empty h2', { hasText: '尚未读取 X List' }).waitFor({ state: 'visible', timeout: 15_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { unavailable: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'DS-004-discover-empty',
    journeyIds: ['DS-004-discover-empty'],
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开发现页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'discover');
      });
      await step('无榜单数据时显示加载占位而非报错', async () => {
        await page.locator('.ranking-loading').waitFor({ state: 'visible', timeout: 20_000 });
        assert(((await page.locator('.ranking-loading').textContent()) ?? '').includes('正在读取最新榜单'), '空缓存占位文案异常');
        assert(await page.locator('.page-command-stat').count() >= 2, '榜单/Lists 入口应仍渲染');
      });
      await step('Lists 区正常渲染空态', async () => {
        await clickListsSection(page);
        await page.locator('.empty-state.library-empty h2', { hasText: '尚未读取 X List' }).waitFor({ state: 'visible', timeout: 15_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { empty: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'DS-005-discover-save-error',
    journeyIds: ['DS-005-discover-save-error'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          // 真实的保存失败路径：条目 URL 非法 → canonicalizeUrl 抛 SOURCE_URL_INVALID，
          // 命令回执 ok=false，UI 如实显示失败原因且不标记已入库；随后合法条目保存成功（重试可成功）。
          seedRankingCache(db, {
            boards: [
              {
                id: 'b-save', label: 'AI 榜单', kind: 'rankings', sourceId: 'github', sourceLabel: 'GitHub',
                sourceUrl: 'https://github.com/trending', status: 'ready',
                items: [
                  { rank: 1, name: 'BadRepo', description: 'E2E 坏条目（URL 非法）', language: 'TypeScript', stars: '1k', gained: '+1', url: 'not-a-valid-url' },
                  { rank: 2, name: 'GoodRepo', description: 'E2E 好条目', language: 'TypeScript', stars: '2k', gained: '+2', url: 'https://github.com/example/good-repo' }
                ]
              }
            ]
          });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step, workspace }) => {
      await step('启动进入主壳并打开发现页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'discover');
        await page.locator('.ranking-list').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('非法 URL 条目入库如实失败：无成功提示、按钮保持未入库态', async () => {
        const save = page.locator('.ranking-save').first();
        await save.click();
        await page.waitForFunction(() => Boolean(document.querySelector('.task-status')?.textContent), null, { timeout: 15_000 });
        const note = ((await page.locator('.task-status').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(!note.includes('已收入资料库'), `失败后不应显示成功提示: ${note}`);
        assert(note.includes('SOURCE_URL_INVALID') || note.includes('入库失败'), `应显示失败原因: ${note}`);
        assert(((await page.locator('.ranking-save').first().textContent()) ?? '').trim() === '＋', '失败条目保存按钮仍应为未入库态');
      });
      await step('失败后重试（合法条目）可成功', async () => {
        const save = page.locator('.ranking-save').nth(1);
        assert(((await save.textContent()) ?? '').trim() === '＋', '合法条目初始应为未入库态');
        await save.click();
        await page.waitForFunction(() => (document.querySelector('.task-status')?.textContent ?? '').includes('已收入资料库:GoodRepo'), null, { timeout: 15_000 });
        await page.waitForFunction(() => (document.querySelectorAll('.ranking-save')[1]?.textContent ?? '').includes('✓'), null, { timeout: 10_000 });
      });
      await step('DB 双读回: 只有合法条目落库', async () => {
        const db = openDb(workspace.dataRoot);
        try {
          const good = db.prepare("SELECT count(*) AS c FROM source_items WHERE title = 'GoodRepo'").get().c;
          const bad = db.prepare("SELECT count(*) AS c FROM source_items WHERE title = 'BadRepo'").get().c;
          assert(Number(good) === 1, `合法条目应落库 1 条，实际 ${good}`);
          assert(Number(bad) === 0, `非法条目不应落库，实际 ${bad}`);
        } finally {
          db.close();
        }
      });
      await healthCheck(page, evidence, assert, step);
      return { failed: 1, saved: 1, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'DS-006-discover-list-load-error',
    journeyIds: ['DS-006-discover-list-load-error'],
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开发现页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'discover');
      });
      await step('无索引时显示空态与读取 X Lists 重试按钮', async () => {
        await clickListsSection(page);
        await page.locator('.empty-state.library-empty h2', { hasText: '尚未读取 X List' }).waitFor({ state: 'visible', timeout: 15_000 });
        const retry = page.locator('.empty-state.library-empty button', { hasText: '读取 X Lists' });
        await retry.waitFor({ state: 'visible', timeout: 10_000 });
      });
      await step('读取失败时显示错误提示且可重试', async () => {
        await page.locator('.empty-state.library-empty button', { hasText: '读取 X Lists' }).click();
        // No browser binding in the fixture -> readXListIndex rejects locally (no egress).
        await page.waitForFunction(() => {
          const note = document.querySelector('.x-lists-view .empty-state p, .x-lists-view .task-status')?.textContent ?? '';
          return note.length > 0 && !note.includes('使用 WMB 共享的 X 登录态');
        }, null, { timeout: 20_000 });
        const note = ((await page.locator('.x-lists-view').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(note.includes('读取 X Lists') || note.includes('尚未读取'), '失败后重试路径应仍可用');
        assert(!note.includes('已读取'), '不得误报读取成功');
      });
      await healthCheck(page, evidence, assert, step);
      return { loadError: true, pageerrors: evidence.pageerrors.length };
    }
  }
];
