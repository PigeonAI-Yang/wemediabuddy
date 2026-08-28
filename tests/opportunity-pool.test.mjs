import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { createProjectFromPlanItem } from '../src/main/content.ts';
import { createPublication } from '../src/main/publishing.ts';
import { createTopic, saveCurrentPlan } from '../src/main/planning.ts';
import { dismissCarryForPlanItem, listFermentingBundle, mergeSimilarCarryItems, upsertCarryFromPlanItem } from '../src/main/ferment.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getOpportunityPool, getToday } from '../src/main/workbench.ts';
import { approvePlanItems, scoredReasons } from './helpers/planning-fixture.mjs';

const NOW = new Date('2026-08-05T06:00:00.000Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pool-'));
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
  return upsertSource(database, { title: `资料${id}`, originalUrl: `https://example.com/${id}`, summary: `摘要${id}` }, false).id;
}

function seedPlanItems(database, { planDate, items, createdAt }) {
  saveCurrentPlan(database, {
    planDate, timezone: 'Asia/Shanghai', summary: `${planDate} 方案`,
    items: items.map((item) => ({
      title: item.title, priority: item.priority, whyNow: '为什么是现在', timeliness: item.timeliness,
      targetAudience: `${item.title}受众`, angle: `${item.title}角度`, pointOfView: `${item.title}观点`,
      platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构',
      effortEstimate: '30m', sourceIds: [item.sourceId], scoreReasons: scoredReasons(), ...(item.topicId ? { topicId: item.topicId } : {})
    }))
  });
  const ids = new Map();
  for (const row of database.prepare(`SELECT pi.id, pi.title FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.id=?`).all(
    database.prepare('SELECT id FROM plans WHERE plan_date=? AND is_current=1').get(planDate).id
  )) {
    ids.set(row.title, row.id);
  }
  approvePlanItems(database, [...ids.values()]);
  if (createdAt) {
    database.prepare('UPDATE plan_items SET created_at=? WHERE id IN (SELECT pi.id FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.plan_date=?)').run(createdAt, planDate);
    database.prepare('UPDATE plans SET created_at=? WHERE plan_date=?').run(createdAt, planDate);
  }
  return ids;
}

function seedPlanItem(database, { planDate, title, priority, timeliness, sourceId, topicId, createdAt }) {
  const ids = seedPlanItems(database, { planDate, items: [{ title, priority, timeliness, sourceId, topicId }], createdAt });
  return ids.get(title);
}

function seedPublishedForTopic(database, topicId, publishedAt) {
  const account = saveAccount(database, { platform: 'x', accountKey: '@pool', displayName: 'pool', loginState: 'authenticated' });
  const project = createContentProject(database, { title: '已发布项目', sourceIds: [] });
  database.prepare('UPDATE content_projects SET topic_id=? WHERE id=?').run(topicId, project.id);
  const core = saveCoreVersion(database, { projectId: project.id, body: 'core', expectedRevision: 1 });
  assert.equal(core.ok, true);
  const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'post', body: 'body' });
  assert.equal(platform.ok, true);
  const publication = createPublication(database, { platformVersionId: platform.data.id, accountId: account.id });
  assert.equal(publication.ok, true);
  const row = database.prepare('SELECT id, revision FROM publications WHERE id=?').get(publication.data.id);
  database.prepare(`UPDATE publications SET status='published', external_url=?, published_at=?, updated_at=?, revision=? WHERE id=?`)
    .run(`https://x.com/pool/status/${row.id.slice(0, 6)}`, publishedAt, publishedAt, row.revision + 1, row.id);
}

test('pool unions current plans across dates and excludes adopted, dismissed and timeliness-expired items', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, 'p1');
    const s2 = seedSource(database, 'p2');
    const s3 = seedSource(database, 'p3');
    const s4 = seedSource(database, 'p4');
    const s5 = seedSource(database, 'p5');

    const ids1 = seedPlanItems(database, {
      planDate: '2026-08-04',
      items: [
        { title: '昨日热点仍在窗内', priority: 1, timeliness: '热点 2-3 天', sourceId: s1 },
        { title: '已采纳机会', priority: 1, timeliness: '热点', sourceId: s2 }
      ],
      createdAt: hoursAgo(20)
    });
    seedPlanItem(database, { planDate: '2026-08-03', title: '爆点已过期', priority: 0, timeliness: '爆点 24 小时', sourceId: s4, createdAt: hoursAgo(30) });
    const adoptedId = ids1.get('已采纳机会');
    const dismissedId = seedPlanItem(database, { planDate: '2026-08-05', title: '被否决机会', priority: 0, timeliness: '热点', sourceId: s3, createdAt: hoursAgo(2) });
    seedPlanItem(database, { planDate: '2026-07-06', title: '长青方法常驻', priority: 2, timeliness: '长青方法论', sourceId: s5, createdAt: hoursAgo(30 * 24) });

    createProjectFromPlanItem(database, adoptedId, false);
    dismissCarryForPlanItem(database, { planItemId: dismissedId, reason: '不想做' });

    const pool = getOpportunityPool(database, { now: NOW });
    const titles = pool.map((item) => item.title);
    assert.deepEqual(titles.sort(), ['昨日热点仍在窗内', '长青方法常驻'].sort());
    const breaking = pool.find((item) => item.title === '昨日热点仍在窗内');
    assert.equal(breaking.timelinessClass, 'hot');
    assert.ok(breaking.expiresAt);
    const evergreen = pool.find((item) => item.title === '长青方法常驻');
    assert.equal(evergreen.timelinessClass, 'evergreen');
    assert.equal(evergreen.expiresAt, null);
  });
});

test('dismissed fingerprint is never revived by reseeding', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database, 'revive');
    const planItemId = seedPlanItem(database, { planDate: '2026-08-05', title: '不要复活', priority: 0, timeliness: '热点', sourceId, createdAt: hoursAgo(1) });
    dismissCarryForPlanItem(database, { planItemId, reason: '否掉' });
    const revived = upsertCarryFromPlanItem(database, {
      planItemId, title: '不要复活', priority: 0, timeliness: '热点', sourceIds: [sourceId], originPlanDate: '2026-08-05'
    });
    assert.equal(revived.state, 'dismissed', 'reseed must respect dismissed parking');
    assert.equal(getOpportunityPool(database, { now: NOW }).length, 0);
  });
});

test('publish within 24h demotes same-topic opportunities to the tail with annotation', async () => {
  await withDb(async (database) => {
    const topicA = createTopic(database, '主题A').id;
    const topicB = createTopic(database, '主题B').id;
    const s1 = seedSource(database, 'd1');
    const s2 = seedSource(database, 'd2');
    seedPlanItems(database, {
      planDate: '2026-08-05',
      items: [
        { title: '同主题机会', priority: 0, timeliness: '热点', sourceId: s1, topicId: topicA },
        { title: '独立话题机会', priority: 3, timeliness: '热点', sourceId: s2, topicId: topicB }
      ],
      createdAt: hoursAgo(1)
    });
    seedPublishedForTopic(database, topicA, hoursAgo(2));

    const pool = getOpportunityPool(database, { now: NOW });
    assert.equal(pool.length, 2);
    assert.equal(pool[0].title, '独立话题机会', 'non-demoted item sorts first even at lower priority');
    assert.equal(pool[1].title, '同主题机会');
    assert.equal(pool[1].demotion?.platform, 'x');
    assert.equal(pool[1].isNew, true);
  });
});

test('plan items citing sources without canonicalUrl are rejected', async () => {
  await withDb(async (database) => {
    const withUrl = upsertSource(database, { title: '有链接', originalUrl: 'https://example.com/citable', summary: '可引用' }, false);
    const noUrl = upsertSource(database, { title: '无链接', summary: '不可引用' }, false);
    const item = {
      title: '机会', priority: 1, whyNow: '现在', timeliness: '热点', targetAudience: '受众', angle: '角度', pointOfView: '观点',
      platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m'
    };
    assert.throws(
      () => saveCurrentPlan(database, { planDate: '2026-08-05', timezone: 'Asia/Shanghai', summary: '方案', items: [{ ...item, sourceIds: [noUrl.id] }] }),
      /缺少可追溯链接/
    );
    const saved = saveCurrentPlan(database, { planDate: '2026-08-05', timezone: 'Asia/Shanghai', summary: '方案', items: [{ ...item, sourceIds: [withUrl.id] }] });
    assert.ok(saved.id, 'citable source passes the canonicalUrl constraint');
  });
});

test('story variants with overlapping sources merge into the newest carry row', async () => {
  await withDb(async (database) => {
    const ids = ['sA', 'sB', 'sC', 'sD', 'sE'].map((slug) => upsertSource(database, { title: slug, originalUrl: `https://example.com/${slug}` }, false).id);
    // 标题刻意互不共享 bigram（同一故事的不同措辞），避免保存期 saveCurrentPlan 末尾的 merge
    // 先按标题身份折叠；来源重合由下面的 UPDATE 显式制造，专测 mergeSimilarCarryItems 的来源路径。
    const a = seedPlanItem(database, { planDate: '2026-08-04', title: '配偶签证收入要求观察', priority: 1, timeliness: '长青', sourceId: ids[0], createdAt: hoursAgo(30) });
    const b = seedPlanItem(database, { planDate: '2026-08-04', title: '担保人收入证明细则', priority: 1, timeliness: '长青', sourceId: ids[1], createdAt: hoursAgo(20) });
    const c = seedPlanItem(database, { planDate: '2026-08-05', title: '居住时长门槛核对', priority: 1, timeliness: '长青', sourceId: ids[2], createdAt: hoursAgo(2) });
    // 让三条 carry 共享来源（标题/指纹不同的演化版本），并显式拉开 last_seen 保证 keeper 是丙。
    const carryRows = database.prepare(`SELECT id, object_id FROM work_carry_items WHERE object_type='plan_item'`).all();
    const byObject = new Map(carryRows.map((row) => [row.object_id, row.id]));
    const setSources = (planItemId, list) => database.prepare('UPDATE work_carry_items SET source_ids_json=? WHERE id=?').run(JSON.stringify(list), byObject.get(planItemId));
    setSources(a, [ids[0], ids[1], ids[2]]);
    setSources(b, [ids[1], ids[2], ids[3]]);
    setSources(c, [ids[2], ids[3], ids[4]]);
    const seenAt = { [a]: hoursAgo(30), [b]: hoursAgo(20), [c]: hoursAgo(2) };
    for (const [planItemId, at] of Object.entries(seenAt)) {
      database.prepare('UPDATE work_carry_items SET last_seen_at=? WHERE id=?').run(at, byObject.get(planItemId));
    }

    const merged = mergeSimilarCarryItems(database);
    assert.equal(merged, 2, '两个旧措辞并入最新一条');
    const states = database.prepare(`SELECT object_id AS oid, state FROM work_carry_items WHERE object_type='plan_item'`).all();
    const stateOf = (planItemId) => states.find((row) => row.oid === planItemId)?.state;
    assert.equal(stateOf(a), 'dismissed');
    assert.equal(stateOf(b), 'dismissed');
    assert.equal(stateOf(c), 'active', '最新出现的一行保留');
    const reason = database.prepare(`SELECT reason FROM work_carry_items WHERE object_id=?`).get(a);
    assert.match(reason.reason, /合并为同一故事/);
  });
});

test('disjoint stories never merge', async () => {
  await withDb(async (database) => {
    const s1 = upsertSource(database, { title: 'x1', originalUrl: 'https://example.com/x1' }, false).id;
    const s2 = upsertSource(database, { title: 'x2', originalUrl: 'https://example.com/x2' }, false).id;
    seedPlanItem(database, { planDate: '2026-08-04', title: '故事一', priority: 1, timeliness: '长青', sourceId: s1, createdAt: hoursAgo(30) });
    seedPlanItem(database, { planDate: '2026-08-05', title: '故事二', priority: 1, timeliness: '长青', sourceId: s2, createdAt: hoursAgo(2) });
    assert.equal(mergeSimilarCarryItems(database), 0, '零来源重合不合并');
    const active = database.prepare(`SELECT COUNT(*) AS count FROM work_carry_items WHERE object_type='plan_item' AND state='active'`).get();
    assert.equal(active.count, 2);
  });
});

test('similar titles without shared sources merge into one story at save time', async () => {
  await withDb(async (database) => {
    const s1 = upsertSource(database, { title: 'm1', originalUrl: 'https://example.com/m1' }, false).id;
    const s2 = upsertSource(database, { title: 'm2', originalUrl: 'https://example.com/m2' }, false).id;
    const a = seedPlanItem(database, {
      planDate: '2026-08-04',
      title: '英国移民新规出台：配偶签证收入门槛调整',
      priority: 1,
      timeliness: '热点',
      sourceId: s1,
      createdAt: hoursAgo(30)
    });
    // 先把旧行 last_seen 拉到更早：保存乙时 saveCurrentPlan 末尾的 merge 会按 last_seen 选乙做 keeper。
    const byObject = new Map(database.prepare(`SELECT id, object_id FROM work_carry_items WHERE object_type='plan_item'`).all().map((row) => [row.object_id, row.id]));
    database.prepare('UPDATE work_carry_items SET last_seen_at=? WHERE id=?').run(hoursAgo(30), byObject.get(a));
    const b = seedPlanItem(database, {
      planDate: '2026-08-05',
      title: '英国移民新规：配偶签证收入门槛再调整',
      priority: 1,
      timeliness: '热点',
      sourceId: s2,
      createdAt: hoursAgo(2)
    });
    const stateOf = (planItemId) => database.prepare(`SELECT state FROM work_carry_items WHERE object_id=?`).get(planItemId)?.state;
    assert.equal(stateOf(a), 'dismissed', '保存乙时的 save-time merge 已把旧措辞并入乙');
    assert.equal(stateOf(b), 'active', '最新出现的一行保留');
    const reason = database.prepare(`SELECT reason FROM work_carry_items WHERE object_id=?`).get(a);
    assert.match(reason.reason, /合并为同一故事/);
    assert.equal(mergeSimilarCarryItems(database), 0, '已合并状态再触发是幂等空操作');
  });
});

test('listFermentingBundle only keeps cards with why-watching signal', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, 'why1');
    const s2 = seedSource(database, 'why2');
    const keptTopic = createTopic(database, '政策后续未完结').id;
    const droppedTopic = createTopic(database, '单发热点无后续').id;
    const kept = seedPlanItem(database, {
      planDate: '2026-08-04',
      title: '政策后续未完结',
      priority: 1,
      timeliness: '持续跟踪',
      sourceId: s1,
      createdAt: hoursAgo(30),
      topicId: keptTopic
    });
    saveCurrentPlan(database, { planDate: '2026-08-04', timezone: 'Asia/Shanghai', summary: '无后续草案', items: [{
      title: '单发热点无后续', priority: 1, whyNow: '单次事件', timeliness: '热点', targetAudience: '单发受众',
      angle: '单发角度', pointOfView: '单发观点', platforms: ['x'], formats: ['text'], titleGuidance: '标题',
      openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [s2], topicId: droppedTopic
    }] });
    const dropped = database.prepare(`SELECT pi.id FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.id=(SELECT id FROM plans WHERE plan_date='2026-08-04' AND is_current=1)`).get().id;
    database.prepare(`UPDATE work_carry_items SET reason=?, aftershock_json='[]' WHERE object_id=?`).run('未完结影响：政策后续未出', kept);
    database.prepare(`UPDATE work_carry_items SET reason=?, aftershock_json='[]' WHERE object_id=?`).run('待处理机会', dropped);
    const bundle = listFermentingBundle(database, '2026-08-05');
    const titles = bundle.items.map((item) => item.title);
    assert.ok(titles.includes('政策后续未完结'), '有评分、已批准且有未完结信号的主题应进持续关注');
    assert.equal(titles.includes('单发热点无后续'), false, '无余波待处理不进持续关注');
  });
});

test('carry rows in expired state are excluded from the pool', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database, 'exp');
    const planItemId = seedPlanItem(database, { planDate: '2026-08-04', title: 'carry 已过期', priority: 1, timeliness: '长青方法论', sourceId, createdAt: hoursAgo(2) });
    const fingerprintRow = database.prepare(`SELECT id FROM work_carry_items WHERE object_type='plan_item' AND object_id=?`).get(planItemId);
    database.prepare(`UPDATE work_carry_items SET state='expired' WHERE id=?`).run(fingerprintRow.id);
    assert.equal(getOpportunityPool(database, { now: NOW }).length, 0, 'expired carry state terminates pool membership even for evergreen items');
  });
});

test('getToday exposes the pool alongside plan and sources', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database, 't1');
    seedPlanItem(database, { planDate: '2026-08-05', title: '池内机会', priority: 1, timeliness: '热点', sourceId, createdAt: hoursAgo(1) });
    const today = getToday(database, '2026-08-05');
    assert.ok(Array.isArray(today.pool));
    assert.equal(today.pool[0]?.title, '池内机会');
    assert.equal(today.plan?.items[0]?.title, '池内机会', 'day plan remains available alongside the pool');
  });
});

test('same story different wording collapses to one chair card (keeper: lowest priority, then newest createdAt)', async () => {
  await withDb(async (database) => {
    const sA = seedSource(database, 'kA');
    const sB = seedSource(database, 'kB');
    const sC = seedSource(database, 'kC');
    const sD = seedSource(database, 'kD');
    // 同 story 不同措辞、不同日期：字面指纹各异（各落一条 carry），播种时标题 bigram 与来源都无重合，
    // 播种期 save-time merge 不触发；下面用 SQL 制造来源重合，专测选题池投影级 storyKey 去重（验收 C9）。
    seedPlanItem(database, { planDate: '2026-08-05', title: '旧措辞甲', priority: 1, timeliness: '长青方法论', sourceId: sA, createdAt: hoursAgo(30) });
    seedPlanItem(database, { planDate: '2026-08-04', title: '新措辞乙', priority: 1, timeliness: '长青方法论', sourceId: sB, createdAt: hoursAgo(2) });
    // 优先级数字更低（priority 0）但更旧：验证 priority 优先于 createdAt。
    seedPlanItem(database, { planDate: '2026-08-03', title: '高优先级旧版', priority: 0, timeliness: '长青方法论', sourceId: sC, createdAt: hoursAgo(30) });
    seedPlanItem(database, { planDate: '2026-08-02', title: '低优先级新版', priority: 1, timeliness: '长青方法论', sourceId: sD, createdAt: hoursAgo(2) });
    database.prepare(`UPDATE plan_items SET source_ids_json=? WHERE title IN ('旧措辞甲','新措辞乙')`).run(JSON.stringify([sA, sB]));
    database.prepare(`UPDATE plan_items SET source_ids_json=? WHERE title IN ('高优先级旧版','低优先级新版')`).run(JSON.stringify([sC, sD]));

    const pool = getOpportunityPool(database, { now: NOW });
    assert.equal(pool.length, 2, '每 story 只留一张主席卡');
    const titles = pool.map((item) => item.title);
    assert.ok(titles.includes('新措辞乙'), '同优先级取最新 createdAt 作 keeper');
    assert.ok(titles.includes('高优先级旧版'), '低 priority 数字优先于 createdAt 作 keeper');
    assert.equal(titles.includes('旧措辞甲'), false, '同 story 旧措辞不并排');
    assert.equal(titles.includes('低优先级新版'), false, '同 story 低优先级行不并排');
  });
});

test('empty current plan does not remove prior non-empty plan items from the pool', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database, 'keep');
    seedPlanItem(database, {
      planDate: '2026-08-05',
      title: '仍可批的旧方案',
      priority: 1,
      timeliness: '热点 2-3 天',
      sourceId,
      createdAt: hoursAgo(3)
    });
    // 同日零更新：空 current 运行记录保档，不得把旧可批项挤出池。
    saveCurrentPlan(database, {
      planDate: '2026-08-05',
      timezone: 'Asia/Shanghai',
      summary: '本轮无新机会，空方案保档',
      items: []
    });

    const pool = getOpportunityPool(database, { now: NOW });
    assert.equal(pool.length, 1);
    assert.equal(pool[0].title, '仍可批的旧方案');

    const today = getToday(database, '2026-08-05');
    assert.equal(today.plan?.items.length, 0, 'current plan remains the empty run record');
    assert.equal(today.latestPlan?.items[0]?.title, '仍可批的旧方案');
    assert.equal(today.pool[0]?.title, '仍可批的旧方案');
  });
});

