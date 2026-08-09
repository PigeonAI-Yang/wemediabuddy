import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import {
  getKnowledgeContext, listKnowledgeSources, listRediscovery, recordKnowledgeBatch, updateKnowledgeSource
} from '../src/main/knowledge.ts';
import { refreshWorkCarry } from '../src/main/ferment.ts';
import { searchSources } from '../src/main/sources.ts';

const PLAN_DATE = '2026-08-05';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-search-eff-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedSource(database, id, title, collectedAt, extra = {}) {
  const saved = upsertSource(database, {
    title,
    originalUrl: `https://example.com/${id}`,
    summary: `${title} 摘要`,
    categories: ['工具'],
    ...extra
  }, false);
  database.prepare('UPDATE source_items SET collected_at = ? WHERE id = ?').run(collectedAt, saved.id);
  return saved.id;
}

function archiveSource(database, id) {
  const row = database.prepare('SELECT revision FROM source_items WHERE id = ?').get(id);
  updateKnowledgeSource(database, { id, expectedRevision: row.revision, managementStatus: 'archived' }, false);
}

test('searchSources default excludes archived; includeArchived flag includes them', async () => {
  await withDb(async (database) => {
    const keep = seedSource(database, 's-keep', 'Effective Search Hit', '2026-08-05T03:00:00.000Z');
    const goneA = seedSource(database, 's-gone-a', 'Archived Search Hit A', '2026-08-05T03:10:00.000Z');
    const goneB = seedSource(database, 's-gone-b', 'Archived Search Hit B', '2026-08-05T03:20:00.000Z');
    archiveSource(database, goneA);
    archiveSource(database, goneB);

    const effective = searchSources(database, 'Search Hit', 50);
    assert.deepEqual(effective.map((item) => item.id), [keep], '默认搜索只返回有效资料');
    assert.ok(!effective.some((item) => item.id === goneA || item.id === goneB));

    const all = searchSources(database, 'Search Hit', 50, true);
    assert.equal(all.length, 3, 'includeArchived=true 含已移出条目');
    assert.deepEqual(all.map((item) => item.id).sort(), [goneA, goneB, keep].sort());

    // 向后兼容：不带 includeArchived 的既有调用仍为默认排除。
    const legacy = searchSources(database, '', 50);
    assert.equal(legacy.length, 1);
  });
});

test('knowledge regression: listKnowledgeSources default excludes archived', async () => {
  await withDb(async (database) => {
    seedSource(database, 'k-keep', '档案有效资料', '2026-08-05T03:00:00.000Z');
    const gone = seedSource(database, 'k-gone', '档案已移出资料', '2026-08-05T03:10:00.000Z');
    archiveSource(database, gone);

    const defaultList = listKnowledgeSources(database, { limit: 100 });
    assert.ok(!defaultList.items.some((item) => item.id === gone), '默认列表不含已移出条目');
    assert.equal(defaultList.items.length, 1);

    const withArchived = listKnowledgeSources(database, { includeArchived: true, limit: 100 });
    assert.ok(withArchived.items.some((item) => item.id === gone), 'includeArchived 显式含已移出');

    const archivedOnly = listKnowledgeSources(database, { managementStatus: 'archived', limit: 20 });
    assert.deepEqual(archivedOnly.items.map((item) => item.id), [gone]);
  });
});

test('knowledge regression: getKnowledgeContext excludes archived sources', async () => {
  await withDb(async (database) => {
    const active = seedSource(database, 'ctx-keep', '上下文中有效资料', '2026-08-05T03:00:00.000Z');
    const gone = seedSource(database, 'ctx-gone', '上下文中已移出资料', '2026-08-05T03:10:00.000Z');
    recordKnowledgeBatch(database, {
      items: [
        { sourceId: active, topic: { title: '共享主题' } },
        { sourceId: gone, topic: { title: '共享主题' } }
      ]
    });
    const topicId = database.prepare("SELECT id FROM topics WHERE title = '共享主题'").get().id;
    archiveSource(database, gone);

    const byTopic = getKnowledgeContext(database, { topicId });
    assert.deepEqual(byTopic.sources.map((item) => item.id), [active], '按主题取上下文不含已移出资料');
    assert.ok(!byTopic.sources.some((item) => item.id === gone));

    const bySource = getKnowledgeContext(database, { sourceId: gone });
    assert.deepEqual(bySource.sources, [], '直接按已移出 sourceId 取上下文也不返回该条');
  });
});

test('ferment regression: bare high-value sources stay off continuous desk; rediscovery excludes archived', async () => {
  await withDb(async (database) => {
    const active = seedSource(database, 'fer-keep', '高价值有效资料', '2026-08-04T12:00:00.000+08:00', { priority: 1 });
    const gone = seedSource(database, 'fer-gone', '高价值但已移出资料', '2026-08-04T13:00:00.000+08:00', { priority: 1 });
    archiveSource(database, gone);
    const rediscover = seedSource(database, 're-keep', '高价值未创作资料', '2026-08-04T14:00:00.000+08:00', { priority: 2 });

    refreshWorkCarry(database, PLAN_DATE);

    // M-5001 / PRODUCT C4: bare high-value sources must not auto-seed continuous-attention desk.
    const carryIds = database.prepare(`SELECT object_id AS objectId FROM work_carry_items WHERE object_type = 'source'`)
      .all().map((row) => row.objectId);
    assert.ok(!carryIds.includes(active), '裸高价值资料不得自动进入持续关注台');
    assert.ok(!carryIds.includes(gone), '已移出资料不得被持续关注播种');

    const unused = listRediscovery(database).unused;
    assert.ok(unused.some((item) => item.id === rediscover));
    assert.ok(!unused.some((item) => item.id === gone), '「高价值但尚未创作」视图不含已移出条目');
  });
});
