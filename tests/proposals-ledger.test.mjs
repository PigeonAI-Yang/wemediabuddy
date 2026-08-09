import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createProjectFromPlanItem } from '../src/main/content.ts';
import { dismissCarryForPlanItem } from '../src/main/ferment.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getOpportunityPool } from '../src/main/workbench.ts';
import { getProposalLedger, summarizeProposalLedger } from '../src/main/proposals.ts';

const NOW = new Date('2026-08-07T06:00:00.000Z');
const TODAY = '2026-08-07';
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-proposals-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedSource(database, id) {
  return upsertSource(database, {
    title: `资料${id}`,
    originalUrl: `https://example.com/${id}`,
    summary: `摘要${id}`
  }, false).id;
}

function seedItem(database, { planDate, title, priority = 1, timeliness = '热点 2-3 天', sourceId, createdAt }) {
  saveCurrentPlan(database, {
    planDate,
    timezone: 'Asia/Shanghai',
    summary: `${planDate} 方案`,
    items: [{
      title,
      priority,
      whyNow: '为什么现在',
      timeliness,
      targetAudience: '受众',
      angle: '角度',
      pointOfView: '观点',
      platforms: ['x'],
      formats: ['text'],
      titleGuidance: '标题',
      openingGuidance: '开头',
      structureGuidance: '结构',
      effortEstimate: '30m',
      sourceIds: [sourceId]
    }]
  });
  const row = database.prepare(`
    SELECT pi.id FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE p.plan_date = ? AND pi.title = ?
    ORDER BY p.created_at DESC LIMIT 1
  `).get(planDate, title);
  if (createdAt) {
    database.prepare('UPDATE plan_items SET created_at=? WHERE id=?').run(createdAt, row.id);
    database.prepare('UPDATE plans SET created_at=? WHERE id=(SELECT plan_id FROM plan_items WHERE id=?)').run(createdAt, row.id);
  }
  return row.id;
}

test('empty history returns zero counts', async () => {
  await withDb(async (database) => {
    const summary = summarizeProposalLedger(database, { planDate: TODAY, now: NOW });
    assert.deepEqual(summary, { today: 0, shelved: 0, adopted: 0, dismissed: 0, expired: 0 });
    const ledger = getProposalLedger(database, { planDate: TODAY, tab: 'today', now: NOW });
    assert.equal(ledger.items.length, 0);
  });
});

test('classifies today shelved adopted dismissed expired and keeps empty current from blanking open items', async () => {
  await withDb(async (database) => {
    const sToday = seedSource(database, 'today');
    const sShelved = seedSource(database, 'shelved');
    const sAdopt = seedSource(database, 'adopt');
    const sDismiss = seedSource(database, 'dismiss');
    const sExpire = seedSource(database, 'expire');

    // 同日多条必须一次写入；多次 saveCurrentPlan 会互相覆盖。
    saveCurrentPlan(database, {
      planDate: TODAY,
      timezone: 'Asia/Shanghai',
      summary: '今日递案',
      items: [
        {
          title: '今日可批选题', priority: 1, whyNow: '为什么现在', timeliness: '热点 2-3 天', targetAudience: '受众',
          angle: '角度', pointOfView: '观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
          openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [sToday]
        },
        {
          title: '已采纳选题', priority: 1, whyNow: '为什么现在', timeliness: '热点 2-3 天', targetAudience: '受众',
          angle: '角度', pointOfView: '观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
          openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [sAdopt]
        },
        {
          title: '已否掉选题', priority: 1, whyNow: '为什么现在', timeliness: '热点 2-3 天', targetAudience: '受众',
          angle: '角度', pointOfView: '观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
          openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [sDismiss]
        }
      ]
    });
    database.prepare(`UPDATE plan_items SET created_at=? WHERE title IN ('今日可批选题','已采纳选题','已否掉选题')`).run(hoursAgo(2));
    database.prepare(`UPDATE plans SET created_at=? WHERE plan_date=? AND is_current=1`).run(hoursAgo(2), TODAY);

    const adoptId = database.prepare(`SELECT id FROM plan_items WHERE title=?`).get('已采纳选题').id;
    const dismissId = database.prepare(`SELECT id FROM plan_items WHERE title=?`).get('已否掉选题').id;
    createProjectFromPlanItem(database, adoptId, false);
    dismissCarryForPlanItem(database, { planItemId: dismissId, reason: '不做' });

    seedItem(database, { planDate: '2026-08-05', title: '搁置选题', sourceId: sShelved, createdAt: hoursAgo(30) });
    seedItem(database, {
      planDate: '2026-08-04',
      title: '过期爆点选题',
      priority: 0,
      timeliness: '爆点 24 小时',
      sourceId: sExpire,
      createdAt: hoursAgo(40)
    });

    // 同日空 current 运行记录不得掏空台账开放项
    saveCurrentPlan(database, {
      planDate: TODAY,
      timezone: 'Asia/Shanghai',
      summary: '本轮无新产出',
      items: []
    });

    const summary = summarizeProposalLedger(database, { planDate: TODAY, now: NOW });
    assert.equal(summary.today, 1);
    assert.equal(summary.shelved, 1);
    assert.equal(summary.adopted, 1);
    assert.equal(summary.dismissed, 1);
    assert.equal(summary.expired, 1);

    const todayTab = getProposalLedger(database, { planDate: TODAY, tab: 'today', now: NOW });
    assert.deepEqual(todayTab.items.map((item) => item.title), ['今日可批选题']);
    assert.equal(todayTab.counts.today, 1);

    const shelvedTab = getProposalLedger(database, { planDate: TODAY, tab: 'shelved', now: NOW });
    assert.deepEqual(shelvedTab.items.map((item) => item.title), ['搁置选题']);

    const adoptedTab = getProposalLedger(database, { planDate: TODAY, tab: 'adopted', now: NOW });
    assert.equal(adoptedTab.items[0]?.title, '已采纳选题');
    assert.ok(adoptedTab.items[0]?.adoptedProjectId);

    const dismissedTab = getProposalLedger(database, { planDate: TODAY, tab: 'dismissed', now: NOW });
    assert.equal(dismissedTab.items[0]?.title, '已否掉选题');

    const expiredTab = getProposalLedger(database, { planDate: TODAY, tab: 'expired', now: NOW });
    assert.equal(expiredTab.items[0]?.title, '过期爆点选题');
  });
});
test('today tab matches opportunity pool subset for same day', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, 'p1');
    const s2 = seedSource(database, 'p2');
    seedItem(database, { planDate: TODAY, title: '池内今日A', sourceId: s1, createdAt: hoursAgo(1) });
    seedItem(database, { planDate: '2026-08-05', title: '池内跨日B', sourceId: s2, createdAt: hoursAgo(20) });

    const poolToday = getOpportunityPool(database, { now: NOW })
      .filter((item) => item.planDate === TODAY)
      .map((item) => item.planItemId)
      .sort();
    const ledgerToday = getProposalLedger(database, { planDate: TODAY, tab: 'today', now: NOW })
      .items.map((item) => item.planItemId)
      .sort();
    assert.deepEqual(ledgerToday, poolToday);
  });
});


test('offset pagination returns hasMore and distinct pages', async () => {
  await withDb(async (database) => {
    const titles = ['量子计算突破', '英国租房指南', '小红书封面公式', '独立开发变现', '路径规划算法'];
    const items = [];
    for (let i = 0; i < titles.length; i += 1) {
      const sourceId = seedSource(database, `src-page-${i}`);
      items.push({
        title: titles[i],
        priority: i + 1,
        whyNow: '为什么现在',
        timeliness: '长青常驻',
        targetAudience: '受众',
        angle: '角度',
        pointOfView: '观点',
        platforms: ['x'],
        formats: ['text'],
        titleGuidance: '标题',
        openingGuidance: '开头',
        structureGuidance: '结构',
        effortEstimate: '30m',
        sourceIds: [sourceId]
      });
    }
    saveCurrentPlan(database, { planDate: TODAY, timezone: 'Asia/Shanghai', summary: '分页方案', items });
    const page0 = getProposalLedger(database, { planDate: TODAY, tab: 'today', limit: 2, offset: 0, now: NOW });
    const page1 = getProposalLedger(database, { planDate: TODAY, tab: 'today', limit: 2, offset: 2, now: NOW });
    assert.equal(page0.total, 5);
    assert.equal(page0.items.length, 2);
    assert.equal(page0.hasMore, true);
    assert.equal(page1.items.length, 2);
    assert.ok(page1.items.every((item) => !page0.items.some((a) => a.planItemId === item.planItemId)));
  });
});

test('restoreDismissedProposal returns item to open ledger', async () => {
  const { restoreDismissedProposal } = await import('../src/main/proposals.ts');
  await withDb(async (database) => {
    const sourceId = seedSource(database, 'src-restore');
    const planItemId = seedItem(database, { planDate: TODAY, title: '可恢复选题', priority: 1, sourceId, createdAt: hoursAgo(1) });
    dismissCarryForPlanItem(database, { planItemId, reason: '测试否掉' }, false);
    let dismissed = getProposalLedger(database, { planDate: TODAY, tab: 'dismissed', now: NOW });
    assert.ok(dismissed.items.some((item) => item.planItemId === planItemId));
    restoreDismissedProposal(database, { planItemId, reason: '测试恢复' }, false);
    dismissed = getProposalLedger(database, { planDate: TODAY, tab: 'dismissed', now: NOW });
    assert.equal(dismissed.items.some((item) => item.planItemId === planItemId), false);
    const today = getProposalLedger(database, { planDate: TODAY, tab: 'today', now: NOW });
    assert.ok(today.items.some((item) => item.planItemId === planItemId) || today.counts.today >= 1);
  });
});
