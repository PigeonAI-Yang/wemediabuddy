import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createTopic, saveCurrentPlan } from '../src/main/planning.ts';
import { listFermentingBundle, refreshWorkCarry } from '../src/main/ferment.ts';
import { upsertSource } from '../src/main/sources.ts';

// 固定时间锚点：first_seen_at / collected_at 全部用 SQL 显式回填，不依赖真实时钟。
const FIRST_SEEN = '2026-08-05T02:00:00.000Z';
const NEW_SOURCE_AT = '2026-08-05T04:00:00.000Z';
const REFRESH_DATE = '2026-08-06';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-aftershock-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedSource(database, title, urlSuffix = title) {
  return upsertSource(database, { title, originalUrl: `https://example.com/${urlSuffix}` }, false).id;
}

function seedPlanItem(database, { planDate, title, priority, timeliness, sourceId, topicId }) {
  saveCurrentPlan(database, {
    planDate, timezone: 'Asia/Shanghai', summary: `${planDate} 方案`,
    items: [{
      title, priority, whyNow: '为什么是现在', timeliness,
      targetAudience: '受众', angle: '角度', pointOfView: '观点',
      platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构',
      effortEstimate: '30m', sourceIds: [sourceId], ...(topicId ? { topicId } : {})
    }]
  });
  const row = database.prepare(`SELECT pi.id FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.plan_date=? AND pi.title=?`).get(planDate, title);
  return row.id;
}

function saveRawPlan(database, { planDate, title, priority, timeliness, sourceIds, topicId }) {
  // 与 seedPlanItem 同路径，但支持多来源（供「同故事 plan_item 引用新来源」路径）。
  saveCurrentPlan(database, {
    planDate, timezone: 'Asia/Shanghai', summary: `${planDate} 方案`,
    items: [{
      title, priority, whyNow: '为什么是现在', timeliness,
      targetAudience: '受众', angle: '角度', pointOfView: '观点',
      platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构',
      effortEstimate: '30m', sourceIds, ...(topicId ? { topicId } : {})
    }]
  });
}

function backdateCarry(database, planItemId, at = FIRST_SEEN) {
  database.prepare(`UPDATE work_carry_items SET first_seen_at=? WHERE object_type='plan_item' AND object_id=?`).run(at, planItemId);
}

function backdateSource(database, sourceId, at = NEW_SOURCE_AT) {
  database.prepare(`UPDATE source_items SET collected_at=? WHERE id=?`).run(at, sourceId);
}

function carryRow(database, planItemId) {
  return database.prepare(`SELECT id, title, topic_id AS topicId, first_seen_at AS firstSeenAt, source_ids_json AS sourceIds,
    aftershock_json AS aftershocks, stage, story_key AS storyKey FROM work_carry_items WHERE object_type='plan_item' AND object_id=?`)
    .get(planItemId);
}

test('topic-null carry gets aftershock from new same-story source by title bigram', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, '英国移民新规出台：配偶签证收入门槛调整');
    const planItemId = seedPlanItem(database, {
      planDate: '2026-07-31', title: '英国移民新规出台：配偶签证收入门槛调整',
      priority: 1, timeliness: '热点', sourceId: s1
    });
    assert.equal(carryRow(database, planItemId).topicId, null, '非多日项不得被自动建主题绑定（保持无 topic 场景）');
    backdateCarry(database, planItemId);
    const s2 = seedSource(database, '英国移民新规：配偶签证收入门槛再调整');
    backdateSource(database, s2);

    const bundle = refreshWorkCarry(database, REFRESH_DATE);
    const row = carryRow(database, planItemId);
    const aftershocks = JSON.parse(row.aftershocks);
    assert.equal(aftershocks.length, 1, '无 topic 也应亮后续');
    assert.equal(aftershocks[0].sourceId, s2);
    // M-5001: continuous-attention identity is Topic; plan_item carry aftershock still writes, but rail no longer lists bare plan/source.
    assert.equal(bundle.items.some((item) => item.objectId === planItemId), false, 'plan_item 不再作为持续关注身份');
    assert.equal(bundle.items.some((item) => item.objectType === 'source'), false);
    assert.equal(row.stage, 'fermenting');
  });
});

test('topic-null carry gets aftershock from same-story plan item via source overlap', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, '配偶签证收入要求观察');
    const planItemId = seedPlanItem(database, {
      planDate: '2026-07-31', title: '配偶签证收入要求观察',
      priority: 1, timeliness: '热点', sourceId: s1
    });
    backdateCarry(database, planItemId);
    const s2 = seedSource(database, '担保人收入证明细则');
    backdateSource(database, s2);
    // 同故事新方案：来源与旧行重叠（Jaccard 0.5 ≥ 0.5），但 priority 3 非多日 → 不产生 carry 行，只做证据。
    saveRawPlan(database, {
      planDate: '2026-08-05', title: '担保人收入证明细则', priority: 3, timeliness: '热点', sourceIds: [s1, s2]
    });

    const bundle = refreshWorkCarry(database, REFRESH_DATE);
    const row = carryRow(database, planItemId);
    const aftershocks = JSON.parse(row.aftershocks);
    assert.equal(aftershocks.length, 1, '同故事新方案引用的新来源应成为余波');
    assert.equal(aftershocks[0].sourceId, s2);
    assert.equal(bundle.items.some((item) => item.objectId === planItemId), false, 'plan_item 不再作为持续关注身份');
  });
});

test('topic-null carry without new evidence stays aftershock-empty and leaves the rail', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, '单发热点无后续');
    const planItemId = seedPlanItem(database, {
      planDate: '2026-07-31', title: '单发热点无后续',
      priority: 1, timeliness: '热点', sourceId: s1
    });
    backdateCarry(database, planItemId);
    database.prepare(`UPDATE work_carry_items SET reason='待处理机会' WHERE object_type='plan_item' AND object_id=?`).run(planItemId);

    const bundle = refreshWorkCarry(database, REFRESH_DATE);
    const row = carryRow(database, planItemId);
    assert.deepEqual(JSON.parse(row.aftershocks), [], '无新证据不得亮余波');
    assert.equal(row.stage, 'emerging', '无余波且无未完结语义 → emerging');
    assert.equal(bundle.items.some((item) => item.objectId === planItemId), false, 'emerging 不进持续关注 rail');
  });
});

test('topic-bound carry keeps the topic-path aftershock (existing semantics preserved)', async () => {
  await withDb(async (database) => {
    const topicA = createTopic(database, '英国移民规则').id;
    const s1 = seedSource(database, '移民规则首轮');
    const planItemId = seedPlanItem(database, {
      planDate: '2026-07-31', title: '移民规则首轮', priority: 1, timeliness: '热点', sourceId: s1, topicId: topicA
    });
    backdateCarry(database, planItemId);
    const s2 = seedSource(database, '移民规则二轮细则');
    backdateSource(database, s2);
    saveRawPlan(database, {
      planDate: '2026-08-05', title: '移民规则二轮细则', priority: 3, timeliness: '热点', sourceIds: [s2], topicId: topicA
    });

    const bundle = refreshWorkCarry(database, REFRESH_DATE);
    const aftershocks = JSON.parse(carryRow(database, planItemId).aftershocks);
    assert.equal(aftershocks.length, 1);
    assert.equal(aftershocks[0].sourceId, s2, '同 topic 新方案引用的新来源是余波');
    assert.ok(bundle.items.some((item) => item.objectType === 'topic' && item.objectId === topicA), '主题进持续关注 rail');
  });
});

test('migration v45 adds story_key/stage and refresh populates them', async () => {
  await withDb(async (database) => {
    const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
    assert.ok(applied.has(45), 'late-migration v45 已应用');
    const columns = new Set(database.prepare('PRAGMA table_info(work_carry_items)').all().map((row) => row.name));
    assert.ok(columns.has('story_key') && columns.has('stage'), 'work_carry_items 新增 story_key/stage 列');

    const topicA = createTopic(database, '长青方法库').id;
    const s1 = seedSource(database, '资料甲');
    const topicPlanItem = seedPlanItem(database, {
      planDate: '2026-07-31', title: '长青方法常驻', priority: 1, timeliness: '本周持续', sourceId: s1, topicId: topicA
    });
    const s2 = seedSource(database, '资料乙');
    const plainPlanItem = seedPlanItem(database, {
      planDate: '2026-07-31', title: '单发热点', priority: 1, timeliness: '热点', sourceId: s2
    });
    backdateCarry(database, topicPlanItem);
    backdateCarry(database, plainPlanItem);
    database.prepare(`UPDATE work_carry_items SET reason='待处理机会' WHERE object_type='plan_item' AND object_id=?`).run(plainPlanItem);

    const bundle = refreshWorkCarry(database, REFRESH_DATE);
    const topicRow = carryRow(database, topicPlanItem);
    assert.equal(topicRow.storyKey, `topic:${topicA}`, '有 topic 的故事键为 topic: 前缀，跨日稳定');
    assert.equal(topicRow.stage, 'fermenting', '多日未完结语义 → fermenting');
    const plainRow = carryRow(database, plainPlanItem);
    assert.ok(plainRow.storyKey.startsWith('sources:') || plainRow.storyKey.startsWith('title:'), '无 topic 行也有确定性故事键');
    assert.equal(plainRow.stage, 'emerging', '无余波无未完结 → emerging');
    assert.ok(bundle.items.some((item) => item.objectType === 'topic' && item.objectId === topicA), '主题进 rail');
    assert.equal(bundle.items.some((item) => item.objectId === plainPlanItem || item.objectId === topicPlanItem), false, 'plan_item 不进 rail');
  });
});

test('refresh backfills story_key for rows that lost it (legacy/直写行)', async () => {
  await withDb(async (database) => {
    const s1 = seedSource(database, '回填对象');
    const planItemId = seedPlanItem(database, {
      planDate: '2026-07-31', title: '回填对象', priority: 1, timeliness: '热点', sourceId: s1
    });
    backdateCarry(database, planItemId);
    database.prepare(`UPDATE work_carry_items SET story_key=NULL WHERE object_type='plan_item' AND object_id=?`).run(planItemId);
    assert.equal(carryRow(database, planItemId).storyKey, null);

    refreshWorkCarry(database, REFRESH_DATE);
    assert.ok(carryRow(database, planItemId).storyKey, 'refresh 回填 story_key');
  });
});
