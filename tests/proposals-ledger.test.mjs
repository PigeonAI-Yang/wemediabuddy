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
import { approvePlanItems, editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

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

function completeFields(title) {
  const thesisByTitle = {
    '今日可批选题': {
      targetAudience: '今天要决定是否追进实时热点的内容主编',
      angle: '核对首发时间与受众影响，判断今天是否值得抢发',
      pointOfView: '只有窗口仍开放且读者利益明确的热点才应占用今日产能'
    },
    '已采纳选题': {
      targetAudience: '正在把批准方案交给制作团队的项目负责人',
      angle: '检查证据包是否足以直接进入项目制作',
      pointOfView: '批准必须同时落成可追踪项目，不能只改变选题状态'
    },
    '已否掉选题': {
      targetAudience: '需要清理低价值候选而不想丢失决策记录的编辑',
      angle: '从机会成本和后续可恢复性解释否决决定',
      pointOfView: '低价值候选应退出今日队列，但否决记录必须可审计'
    },
    '量子计算突破': {
      targetAudience: '正在判断量子计算新闻是否改变技术路线的研发负责人',
      angle: '区分实验室指标突破与可部署能力之间的距离',
      pointOfView: '单项量子指标刷新不等于企业现在就该迁移计算任务'
    },
    '英国租房指南': {
      targetAudience: '本周准备在英国签约但看不懂押金条款的新租客',
      angle: '用签约前检查清单拆解押金保护与退租风险',
      pointOfView: '租客最大的可控损失发生在签字前而不是退租争议时'
    },
    '小红书封面公式': {
      targetAudience: '内容可靠但封面点击率持续偏低的小红书创作者',
      angle: '从信息层级与首屏承诺诊断封面而非追逐模板',
      pointOfView: '高点击封面靠清晰兑现读者收益，不靠堆叠流行装饰'
    },
    '独立开发变现': {
      targetAudience: '产品已上线却没有稳定付费用户的独立开发者',
      angle: '从首批付费访谈倒推功能与定价取舍',
      pointOfView: '独立产品应先验证谁愿意付钱，再扩充功能规模'
    },
    '路径规划算法': {
      targetAudience: '正在处理配送延迟和路线成本的调度工程师',
      angle: '比较动态约束下的实时重规划代价',
      pointOfView: '真实路径规划的关键不是最短距离，而是约束变化后的稳定重算'
    }
  };
  const thesis = thesisByTitle[title] ?? {
    targetAudience: `正在评估 ${title} 并负责真实内容交付的具体读者`,
    angle: `从 ${title} 的可核验证据与真实成本切入`,
    pointOfView: `${title} 只有通过真实证据验证后才值得投入制作`
  };
  return {
    whyNow: '官方今日公布关键变化，未来两天是解释窗口，错过后需要重新核对事实。',
    timeliness: '热点 2-3 天',
    ...thesis,
    platforms: ['x'], formats: ['text'],
    titleGuidance: '标题突出事件变化与读者实际成本之间的反差。',
    openingGuidance: '先给出一条可核验事实，再说明它为什么影响当前选择。',
    structureGuidance: '第一段交代事件；第二段展示证据；第三段给出行动判断。',
    effortEstimate: '30m', scoreReasons: scoredReasons(80, NOW.toISOString()), editorialDecision: editorialDecision(thesis.pointOfView)
  };
}

function seedItem(database, { planDate, title, priority = 1, timeliness = '热点 2-3 天', sourceId, createdAt }) {
  saveCurrentPlan(database, {
    planDate,
    timezone: 'Asia/Shanghai',
    summary: `${planDate} 方案`,
    items: [{
      title,
      priority,
      ...completeFields(title),
      timeliness,
      sourceIds: [sourceId],
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
    assert.deepEqual(summary, { today: 0, shelved: 0, adopted: 0, dismissed: 0, expired: 0, scoring_pending: 0 });
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
          title: '今日可批选题', priority: 1, whyNow: '为什么现在', timeliness: '热点 2-3 天', targetAudience: '今日受众',
          angle: '今日角度', pointOfView: '今日观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
          openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [sToday], scoreReasons: scoredReasons(), editorialDecision: editorialDecision('今日观点')
        },
        {
          title: '已采纳选题', priority: 1, whyNow: '为什么现在', timeliness: '热点 2-3 天', targetAudience: '采纳受众',
          angle: '采纳角度', pointOfView: '采纳观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
          openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [sAdopt], scoreReasons: scoredReasons(), editorialDecision: editorialDecision('采纳观点')
        },
        {
          title: '已否掉选题', priority: 1, whyNow: '为什么现在', timeliness: '热点 2-3 天', targetAudience: '否掉受众',
          angle: '否掉角度', pointOfView: '否掉观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
          openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [sDismiss], scoreReasons: scoredReasons(), editorialDecision: editorialDecision('否掉观点')
        }
      ].map((item) => ({ ...item, ...completeFields(item.title) }))
    });
    database.prepare(`UPDATE plan_items SET created_at=? WHERE title IN ('今日可批选题','已采纳选题','已否掉选题')`).run(hoursAgo(2));
    database.prepare(`UPDATE plans SET created_at=? WHERE plan_date=? AND is_current=1`).run(hoursAgo(2), TODAY);

    const adoptId = database.prepare(`SELECT id FROM plan_items WHERE title=?`).get('已采纳选题').id;
    const dismissId = database.prepare(`SELECT id FROM plan_items WHERE title=?`).get('已否掉选题').id;
    approvePlanItems(database, [adoptId]);
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
        targetAudience: `${titles[i]}受众`,
        angle: `${titles[i]}角度`,
        pointOfView: `${titles[i]}观点`,
        platforms: ['x'],
        formats: ['text'],
        titleGuidance: '标题',
        openingGuidance: '开头',
        structureGuidance: '结构',
        effortEstimate: '30m',
        sourceIds: [sourceId],
        scoreReasons: scoredReasons(80, NOW.toISOString()), editorialDecision: editorialDecision(titles[i]),
        ...completeFields(titles[i])
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
