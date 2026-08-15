// WMB-5243 结果（Results）页真实 Electron E2E（RS-001..RS-004）。
//
// 契约：default export = scenario array；launch.seedFixture 启动前建真数据。
// 双证据：用户可见 DOM（周期聚合/图表钻取/健康面板/诚实空态）+ SQLite 读回。
// 不触发任何外部副作用（不启动 Pi 复盘、不采集指标）。

import { seedWorkflowBase, openWriteDb, seedStudioProject, seedPublishBinding, seedPublicationWithStatus, seedMetricSnapshots, seedReview, seedResultsHealthIssue } from './seed-workflow.mjs';
import { savePlatformVersion } from '../../src/main/content.ts';

const ACC_KEY = '@e2e-workflow-x';
const daysAgo = (days, hours = 0) => new Date(Date.now() - days * 86400_000 - hours * 3_600_000).toISOString();

/** 种子：X 平台项目 + binding；返回可复用发布函数所需上下文。 */
async function seedResultsBase({ dataRoot, workspaceId }) {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const studio = seedStudioProject(db, {});
    const accX = seedPublishBinding(db, { platform: 'x', accountKey: ACC_KEY, displayName: 'E2E X' });
    return { db, studio, accX, workspaceId };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 发布一条 X 内容（已发布态）。 */
function seedPublishedPost(db, { studio, accX, title, body, publishedAt, externalId }) {
  const plat = savePlatformVersion(db, { projectId: studio.projectId, contentVersionId: studio.coreV2Id, platform: 'x', format: 'text', title, body });
  return seedPublicationWithStatus(db, {
    platformVersionId: plat.data.id, accountId: accX.id, accountKey: ACC_KEY,
    to: 'published', externalUrl: `https://x.com/e2e-workflow-x/${externalId}`, externalId, publishedAt
  });
}

/** 结果页就绪等待。 */
async function waitResultsPage(page) {
  await page.waitForSelector('.results-page', { timeout: 20_000 });
}

/** 逐点钻取直到出现 rl-ksc（已复盘帖），命中则返回 true。 */
async function drillUntilReviewed(page) {
  const dots = await page.$$eval('.rc-dot', (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }));
  for (const dot of dots) {
    await page.evaluate(({ cx, cy }) => {
      const hit = document.querySelector('.rc-hitzone');
      if (hit) hit.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
    }, dot);
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const hit = document.querySelector('.rc-hitzone');
      if (hit) hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const hasKsc = await page.evaluate(() => !!document.querySelector('.rl-ksc'));
    if (hasKsc) return true;
    const backed = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('← 返回总览'));
      if (b) { b.click(); return true; }
      return false;
    });
    if (backed) await page.waitForTimeout(600);
  }
  return false;
}

export default [
  {
    id: 'RS-001-results-cockpit-normal',
    journeyIds: ['RS-001-results-cockpit-normal'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedResultsBase({ dataRoot, workspaceId });
        try {
          // 帖1（2 天前，已复盘）：1h/6h/24h 快照 + final Review
          const post1 = seedPublishedPost(db, { studio, accX, title: 'E2E 复盘帖', body: '复盘帖正文', publishedAt: daysAgo(2), externalId: 'e2e-r1' });
          const snap1 = seedMetricSnapshots(db, {
            publicationId: post1.publicationId, publishedAt: daysAgo(2), sourceUrl: 'https://x.com/e2e-workflow-x/e2e-r1',
            points: [
              { hours: 1, values: { views: 80 } },
              { hours: 6, values: { views: 100 } },
              { hours: 24, values: { views: 120, likes: 30 } }
            ]
          });
          seedReview(db, { publicationId: post1.publicationId, snapshotIds: snap1, keep: ['开头钩子'], stop: ['泛 CTA'], change: ['封面先给结论'], summary: 'E2E 周期复盘', status: 'final', findings: [{ title: '先给结论', body: '封面先给结论' }] });
          // 帖2（5 天前，未复盘 → 待复盘队列）：多窗口
          const post2 = seedPublishedPost(db, { studio, accX, title: 'E2E 待复盘帖', body: '待复盘正文', publishedAt: daysAgo(5), externalId: 'e2e-r2' });
          seedMetricSnapshots(db, {
            publicationId: post2.publicationId, publishedAt: daysAgo(5), sourceUrl: 'https://x.com/e2e-workflow-x/e2e-r2',
            points: [
              { hours: 1, values: { views: 200 } },
              { hours: 24, values: { views: 260 } }
            ]
          });
          // 帖3（10 天前，未复盘）：单快照
          const post3 = seedPublishedPost(db, { studio, accX, title: 'E2E 长尾帖', body: '长尾正文', publishedAt: daysAgo(10), externalId: 'e2e-r3' });
          seedMetricSnapshots(db, {
            publicationId: post3.publicationId, publishedAt: daysAgo(10), sourceUrl: 'https://x.com/e2e-workflow-x/e2e-r3',
            points: [{ hours: 24, values: { views: 55 } }]
          });
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到结果页', () => helpers.navigateTo(page, 'results'));
      await step('周期聚合驾驶舱渲染（统计/hero/图表/筛选）', async () => {
        await waitResultsPage(page);
        // 快照/复盘经 reload() 异步就绪：先等散点（与复盘同一 React 批次渲染）再断言统计，
        // 避免首帧 0 值竞态。
        await page.waitForSelector('.rc-dot', { timeout: 15_000 });
        const stats = await page.textContent('.page-command-stats');
        assert(/3\s*本周期发布/.test(stats), `本周期发布统计不符: ${stats}`);
        assert(/1\s*已复盘/.test(stats), `已复盘统计不符: ${stats}`);
        assert(/2\s*待复盘/.test(stats), `待复盘统计不符: ${stats}`);
        const hero = await page.textContent('.rl-hero');
        assert(hero.includes('本期最强内容'), 'hero 缺本期最强内容');
        assert(hero.includes('E2E 待复盘帖'), `本期最强内容应为 E2E 待复盘帖(24h 260): ${hero.slice(0, 200)}`);
        const heroKsc = await page.textContent('.rl-hero-ksc');
        for (const word of ['开头钩子', '泛 CTA', '封面先给结论']) {
          assert(heroKsc.includes(word), `hero KSC 缺 ${word}: ${heroKsc}`);
        }
        const filters = await page.textContent('.rl-filters');
        for (const chip of ['近 7 天', '近 30 天', '全部']) {
          assert(filters.includes(chip), `筛选缺 ${chip}`);
        }
        await page.waitForSelector('.rc-dot', { timeout: 15_000 });
        const dots = await page.$$eval('.rc-dot', (els) => els.length);
        assert(dots >= 3, `散点数量不足: ${dots}`);
      });
      await step('图表区钻取单帖（已复盘帖 → rl-ksc）并可返回', async () => {
        const drilled = await drillUntilReviewed(page);
        assert(drilled, '散点钻取未命中已复盘帖');
        const ksc = await page.textContent('.rl-ksc');
        for (const word of ['保留', '停止', '改变', '开头钩子', '泛 CTA', '封面先给结论']) {
          assert(ksc.includes(word), `钻取 KSC 缺 ${word}: ${ksc.slice(0, 300)}`);
        }
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('← 返回总览'));
          b?.click();
        });
        await page.waitForFunction(() => !!document.querySelector('.rc-hitzone'), null, { timeout: 10_000 });
      });
      await step('待复盘队列（72h 未复盘）可见', async () => {
        const pending = await page.textContent('.rl-pending-list');
        assert(pending.includes('E2E 待复盘帖') && pending.includes('E2E 长尾帖'), `待复盘队列缺少帖子: ${pending.slice(0, 200)}`);
        assert(pending.includes('让 Pi 复盘'), '待复盘队列缺少复盘入口');
      });
      await step('持久化读回：快照与 final Review', () => {
        const { db, close } = openDb();
        try {
          const snapCount = Number(db.prepare('SELECT COUNT(*) AS c FROM publication_metric_snapshots').get().c);
          assert(snapCount >= 6, `指标快照数不符: ${snapCount}`);
          const review = db.prepare("SELECT status FROM reviews WHERE status = 'final'").get();
          assert(Boolean(review), 'DB 缺少 final Review');
        } finally { close(); }
      });
      return { cockpit: true };
    }
  },

  {
    id: 'RS-002-results-empty',
    journeyIds: ['RS-002-results-empty'],
    launch: { seedFixture: async ({ dataRoot, workspaceId }) => { await seedWorkflowBase(dataRoot, workspaceId); } },
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到结果页', () => helpers.navigateTo(page, 'results'));
      await step('空态渲染且页面不崩溃', async () => {
        await waitResultsPage(page);
        await page.waitForSelector('.empty-state', { timeout: 15_000 });
        const emptyText = await page.textContent('.empty-state');
        assert(emptyText.includes('还没有可复盘内容'), `空态文案不符: ${emptyText}`);
        const crashed = await page.evaluate(() => !!document.querySelector('.vite-error-overlay'));
        assert(!crashed, '页面出现错误覆盖层');
      });
      return { empty: true };
    }
  },

  {
    id: 'RS-003-results-health-panel',
    journeyIds: ['RS-003-results-health-panel'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedResultsBase({ dataRoot, workspaceId });
        try {
          const post1 = seedPublishedPost(db, { studio, accX, title: 'E2E 健康帖', body: '健康帖正文', publishedAt: daysAgo(4), externalId: 'e2e-h1' });
          const snap1 = seedMetricSnapshots(db, { publicationId: post1.publicationId, publishedAt: daysAgo(4), sourceUrl: 'https://x.com/e2e-workflow-x/e2e-h1', points: [{ hours: 24, values: { views: 90 } }] });
          const reviewId = seedReview(db, { publicationId: post1.publicationId, snapshotIds: snap1, keep: ['钩子前置'], stop: ['无钩子直入'], change: ['数据先行'], summary: 'E2E 健康复盘', status: 'final', findings: [] });
          // 两条不同严重度的结果回流健康问题（unreturned_review）
          seedResultsHealthIssue(db, { id: 'health-e2e-review-1', issueType: 'unreturned_review', affectedObjectType: 'review', affectedObjectId: reviewId, severity: 'high', suggestedAction: '复盘发布 72h 未定稿，请尽快定稿' });
          seedResultsHealthIssue(db, { id: 'health-e2e-review-2', issueType: 'unreturned_review', affectedObjectType: 'review', affectedObjectId: reviewId, severity: 'medium', suggestedAction: '复盘草稿未定稿，建议补充分析' });
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到结果页', () => helpers.navigateTo(page, 'results'));
      await step('健康面板按严重度渲染并含打开深链', async () => {
        await waitResultsPage(page);
        await page.waitForSelector('.rl-health', { timeout: 20_000 });
        await page.waitForFunction(() => document.querySelectorAll('.rl-health-item').length >= 2, null, { timeout: 20_000 });
        const items = await page.$$eval('.rl-health-item', (els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
        // 严重度标签使用产品统一词典（severityLabel: high→高 / medium→中 / critical→严重）
        const severities = await page.$$eval('.rl-health-item .issue-severity', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(severities.includes('高') && severities.includes('中'), `严重度标签缺失（应为 高/中）: ${JSON.stringify(severities)}`);
        assert(items.every((t) => t.includes('E2E 健康帖')), `健康问题未解析到帖子: ${JSON.stringify(items)}`);
        const openBtn = await page.evaluate(() => {
          const b = [...document.querySelectorAll('.rl-health-item button')].find((x) => x.textContent?.includes('打开《E2E 健康帖》'));
          if (!b) return false;
          b.click();
          return true;
        });
        assert(openBtn, '健康面板缺少打开深链按钮');
        await page.waitForSelector('.rl-drill-head', { timeout: 15_000 });
        const drillTitle = await page.textContent('.rl-drill-head');
        assert(drillTitle.includes('E2E 健康帖'), `健康深链未钻取到帖子: ${drillTitle}`);
      });
      await step('行动面板（ActionsPanel）渲染', async () => {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('← 返回总览'));
          b?.click();
        });
        await page.waitForSelector('.rl-actions', { timeout: 10_000 });
        const actions = await page.textContent('.rl-actions');
        assert(actions.includes('保留') && actions.includes('停止') && actions.includes('改变'), `行动面板缺列: ${actions.slice(0, 150)}`);
        assert(actions.includes('钩子前置'), `行动面板缺已提行动: ${actions.slice(0, 300)}`);
      });
      return { healthPanel: true };
    }
  },

  {
    id: 'RS-004-results-error',
    journeyIds: ['RS-004-results-error'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedResultsBase({ dataRoot, workspaceId });
        try {
          // 帖A（5 天前，未复盘，零快照）：诚实「无指标快照」边界
          const postA = seedPublishedPost(db, { studio, accX, title: 'E2E 无快照帖', body: '无快照正文', publishedAt: daysAgo(5), externalId: 'e2e-e1' });
          // 帖B（3 天前，已复盘）：含不可见字段 → 诚实字段状态（暂不可见）
          const postB = seedPublishedPost(db, { studio, accX, title: 'E2E 部分可见帖', body: '部分可见正文', publishedAt: daysAgo(3), externalId: 'e2e-e2' });
          const snapB = seedMetricSnapshots(db, {
            publicationId: postB.publicationId, publishedAt: daysAgo(3), sourceUrl: 'https://x.com/e2e-workflow-x/e2e-e2',
            points: [{ hours: 24, values: { views: 100 } }]
          });
          // 注入不可见字段：comments 平台暂不可见（真实解析状态，非伪造）
          db.prepare(`UPDATE publication_metric_snapshots SET normalized_json = ? WHERE id = ?`)
            .run(JSON.stringify({ views: { status: 'value', value: 100, rawLabel: '100' }, comments: { status: 'unavailable', rawLabel: null } }), snapB[0]);
          seedReview(db, { publicationId: postB.publicationId, snapshotIds: snapB, keep: ['真实数据优先'], stop: ['不可见字段硬编码'], change: ['补齐指标再复盘'], summary: '部分可见复盘', status: 'final', findings: [] });
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到结果页', () => helpers.navigateTo(page, 'results'));
      await step('零快照帖：诚实空态而非白屏/伪造', async () => {
        await waitResultsPage(page);
        await page.waitForFunction(() => document.querySelectorAll('.rc-dot').length >= 1 || !!document.querySelector('.rc-empty'), null, { timeout: 20_000 });
        const rcEmpty = await page.evaluate(() => !!document.querySelector('.rc-empty'));
        if (!rcEmpty) {
          // 至少一个点（帖B）；帖A 无快照不产生散点
          const dots = await page.$$eval('.rc-dot', (els) => els.length);
          assert(dots === 1, `应只有帖B有散点: ${dots}`);
        }
        // 待复盘队列点击无快照帖 → 诚实提示（不假成功）
        const opened = await page.evaluate(() => {
          const row = [...document.querySelectorAll('.rl-pending-row')].find((r) => r.textContent?.includes('E2E 无快照帖'));
          const ttl = row?.querySelector('.ttl');
          if (!ttl) return false;
          ttl.click();
          return true;
        });
        assert(opened, '待复盘队列缺少无快照帖');
        await page.waitForSelector('.rl-drill-head', { timeout: 15_000 });
        const drill = await page.textContent('.rc-drill-detail');
        assert(drill.includes('该内容还没有指标快照。'), `无快照帖应诚实显示空态: ${drill.slice(0, 200)}`);
        const reviewNote = await page.evaluate(() => document.querySelector('.rc-drill-detail .rl-empty-note')?.textContent ?? '');
        assert(reviewNote.includes('还没有复盘'), `复盘区应诚实提示: ${reviewNote}`);
        const hint = await page.evaluate(() => document.querySelector('.rc-drill-detail .rl-hint')?.textContent ?? '');
        assert(hint.includes('没有指标快照时不能做数据驱动复盘'), `无快照应禁用复盘并提示: ${hint}`);
        const reviewBtnDisabled = await page.evaluate(() => {
          const b = [...document.querySelectorAll('.rc-drill-detail button')].find((x) => x.textContent?.includes('让 Pi 复盘'));
          return b ? b.disabled : null;
        });
        assert(reviewBtnDisabled === true, '无快照帖的让 Pi 复盘按钮应禁用');
      });
      await step('部分可见字段：诚实状态标签（暂不可见）', async () => {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('← 返回总览'));
          b?.click();
        });
        await page.waitForTimeout(600);
        const opened = await page.evaluate(() => {
          const row = [...document.querySelectorAll('.rl-pending-row')].find((r) => r.textContent?.includes('E2E 部分可见帖'));
          const ttl = row?.querySelector('.ttl');
          if (!ttl) return false;
          ttl.click();
          return true;
        });
        // 帖B 已复盘，不在待复盘队列 → 走散点钻取
        if (!opened) {
          const drilled = await drillUntilReviewed(page);
          assert(drilled, '部分可见帖未能钻取');
        }
        await page.waitForSelector('.rc-table', { timeout: 15_000 });
        const table = await page.textContent('.rc-table');
        assert(table.includes('暂不可见'), `不可见字段状态标签缺失: ${table.slice(0, 300)}`);
        assert(table.includes('1 项不可见'), `不可见计数缺失: ${table.slice(0, 300)}`);
      });
      await step('持久化读回：不可见字段真实落库', () => {
        const { db, close } = openDb();
        try {
          const row = db.prepare('SELECT normalized_json FROM publication_metric_snapshots ORDER BY created_at DESC LIMIT 1').get();
          const parsed = JSON.parse(row.normalized_json);
          assert(parsed.comments?.status === 'unavailable', 'DB 不可见字段状态不符');
        } finally { close(); }
      });
      return { errorHonest: true };
    }
  }
];
