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
import { dismissCarryForPlanItem, upsertCarryFromPlanItem } from '../src/main/ferment.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getOpportunityPool, getToday } from '../src/main/workbench.ts';

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
      targetAudience: '受众', angle: '角度', pointOfView: '观点',
      platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构',
      effortEstimate: '30m', sourceIds: [item.sourceId], ...(item.topicId ? { topicId: item.topicId } : {})
    }))
  });
  const ids = new Map();
  for (const row of database.prepare(`SELECT pi.id, pi.title FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.plan_date=?`).all(planDate)) {
    ids.set(row.title, row.id);
  }
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
        { title: '别主题机会', priority: 3, timeliness: '热点', sourceId: s2, topicId: topicB }
      ],
      createdAt: hoursAgo(1)
    });
    seedPublishedForTopic(database, topicA, hoursAgo(2));

    const pool = getOpportunityPool(database, { now: NOW });
    assert.equal(pool.length, 2);
    assert.equal(pool[0].title, '别主题机会', 'non-demoted item sorts first even at lower priority');
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
