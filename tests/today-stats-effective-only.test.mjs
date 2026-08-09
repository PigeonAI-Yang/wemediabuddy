import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { updateKnowledgeSource } from '../src/main/knowledge.ts';
import { getToday } from '../src/main/workbench.ts';

const PLAN_DATE = '2026-08-05';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-today-eff-'));
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
    categories: ['官方发布'],
    ...extra
  }, false);
  database.prepare('UPDATE source_items SET collected_at = ? WHERE id = ?').run(collectedAt, saved.id);
  return saved.id;
}

function archiveSource(database, id) {
  const row = database.prepare('SELECT revision FROM source_items WHERE id = ?').get(id);
  updateKnowledgeSource(database, { id, expectedRevision: row.revision, managementStatus: 'archived' }, false);
}

test('today sources and total count effective-only; archivedTodayCount counts removed', async () => {
  await withDb(async (database) => {
    const keep = seedSource(database, 'today-keep', '今日有效资料', `${PLAN_DATE}T12:00:00.000+08:00`);
    const removed = seedSource(database, 'today-gone', '今日已移出资料', `${PLAN_DATE}T13:00:00.000+08:00`);
    archiveSource(database, removed);
    seedSource(database, 'yesterday', '昨日资料', '2026-08-04T12:00:00.000+08:00');

    const today = getToday(database, PLAN_DATE);

    assert.deepEqual(today.sources.map((item) => item.id), [keep], '今日列表只含有效资料');
    assert.ok(!today.sources.some((item) => item.id === removed), '已移出条目不得出现在今日 feed');
    assert.equal(today.sourcesTotal, 1, '今日新资料统计只数有效项');
    assert.equal(today.archivedTodayCount, 1, 'feed 行尾「另有 N 条」计数为当日已移出条数');
    assert.equal(today.sourcesDate, PLAN_DATE);
  });
});

test('all archived today falls back to latest effective source date, stats stay effective-only', async () => {
  await withDb(async (database) => {
    const removed = seedSource(database, 'all-gone', '唯一今日资料（已移出）', `${PLAN_DATE}T12:00:00.000+08:00`);
    archiveSource(database, removed);
    const yesterday = seedSource(database, 'fb-keep', '昨日有效资料', '2026-08-04T12:00:00.000+08:00');

    const today = getToday(database, PLAN_DATE);

    assert.deepEqual(today.sources.map((item) => item.id), [yesterday], '回退到最近一个仍有有效资料的日子');
    assert.equal(today.sourcesTotal, 1);
    assert.equal(today.sourcesDate, '2026-08-04', 'sourcesDate 只认有效资料');
    assert.equal(today.archivedTodayCount, 1);
  });
});

test('empty database degrades to zero counts', async () => {
  await withDb(async (database) => {
    const today = getToday(database, PLAN_DATE);
    assert.deepEqual(today.sources, []);
    assert.equal(today.sourcesTotal, 0);
    assert.equal(today.archivedTodayCount, 0);
    assert.equal(today.sourcesDate, null);
  });
});

test('Shanghai calendar day bounds match UTC Z collected_at (no +08:00 string compare)', async () => {
  await withDb(async (database) => {
    // Production stores collected_at as UTC Z. Early morning Shanghai is previous UTC calendar day.
    const morningShanghai = seedSource(database, 'z-morning', '上海早晨入库', '2026-08-04T17:30:00.000Z'); // 2026-08-05 01:30+08
    const eveningShanghai = seedSource(database, 'z-evening', '上海傍晚入库', '2026-08-05T10:00:00.000Z'); // 2026-08-05 18:00+08
    seedSource(database, 'z-prev', '前一日上海晚间', '2026-08-04T15:00:00.000Z'); // 2026-08-04 23:00+08

    const today = getToday(database, '2026-08-05');
    assert.equal(today.sourcesDate, '2026-08-05');
    assert.equal(today.sourcesTotal, 2);
    assert.deepEqual(today.sources.map((item) => item.id).sort(), [morningShanghai, eveningShanghai].sort());
  });
});
