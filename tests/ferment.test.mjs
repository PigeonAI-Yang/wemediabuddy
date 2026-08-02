import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { getToday } from '../src/main/workbench.ts';
import { refreshWorkCarry, setCarryState } from '../src/main/ferment.ts';
import { createProjectFromPlanItem } from '../src/main/content.ts';

function seedPlan(database, planDate, title = 'DeepSeek-V4-Flash 正式版：国产模型的 Agent 时刻到了吗？') {
  const source = upsertSource(database, {
    title: 'DeepSeek-V4-Flash 正式 API 发布',
    originalUrl: `https://example.com/dsv4-${planDate}`,
    summary: 'DeepSeek V4 Flash API public beta',
    priority: 1,
    categories: ['official_release']
  });
  saveCurrentPlan(database, {
    planDate,
    timezone: 'Asia/Shanghai',
    summary: 'test',
    items: [{
      title,
      priority: 1,
      whyNow: '正式发布',
      timeliness: '本周持续',
      targetAudience: '开发者',
      angle: 'Agent 能力',
      pointOfView: '国产模型拐点',
      platforms: ['wechat'],
      formats: ['article'],
      titleGuidance: 't',
      openingGuidance: 'o',
      structureGuidance: 's',
      effortEstimate: '2h',
      sourceIds: [source.id]
    }]
  });
  return source.id;
}

test('yesterday high-value plan item appears in today fermenting rail', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-ferment-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    seedPlan(database, '2026-07-31');
    refreshWorkCarry(database, '2026-08-01');
    const before = database.prepare('SELECT id, revision, updated_at FROM work_carry_items ORDER BY id').all();
    const today = getToday(database, '2026-08-01');
    getToday(database, '2026-08-01');
    assert.deepEqual(database.prepare('SELECT id, revision, updated_at FROM work_carry_items ORDER BY id').all(), before);
    assert.ok(today.fermenting);
    const hit = today.fermenting.items.find((item) => item.objectType === 'plan_item' && item.title.includes('DeepSeek-V4-Flash'));
    assert.ok(hit, 'expected yesterday plan item in fermenting rail');
    assert.equal(today.plan, null);
    assert.ok(hit.fermentedDays >= 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dismiss and done remove item from active fermenting list', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-ferment-state-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    seedPlan(database, '2026-07-31');
    let bundle = refreshWorkCarry(database, '2026-08-01');
    const item = bundle.items.find((row) => row.title.includes('DeepSeek-V4-Flash'));
    assert.ok(item);
    const dismissed = setCarryState(database, { id: item.id, expectedRevision: item.revision, state: 'dismissed' });
    assert.equal(dismissed.state, 'dismissed');
    bundle = refreshWorkCarry(database, '2026-08-01');
    assert.equal(bundle.items.some((row) => row.id === item.id), false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marking sources watching keeps them in library watching board', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-library-watch-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const sourceId = seedPlan(database, '2026-07-31');
    const { markSourcesWatching, listWatchingSources } = await import('../src/main/knowledge.ts');
    const marked = markSourcesWatching(database, [sourceId]);
    assert.ok(marked.ids.includes(sourceId));
    const board = listWatchingSources(database, 20);
    assert.ok(board.some((row) => row.id === sourceId));
    // Old carry watching rows are promoted into library watching and leave the today rail.
    let bundle = refreshWorkCarry(database, '2026-08-01');
    const item = bundle.items.find((row) => row.title.includes('DeepSeek-V4-Flash'));
    if (item) {
      setCarryState(database, { id: item.id, expectedRevision: item.revision, state: 'watching' });
      bundle = refreshWorkCarry(database, '2026-08-01');
      assert.equal(bundle.watchingItems.some((row) => row.id === item.id), false);
      assert.ok(listWatchingSources(database, 20).some((row) => row.id === sourceId));
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('creating project marks matching carry done', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-ferment-done-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    seedPlan(database, '2026-07-31');
    const planItem = database.prepare(`SELECT pi.id FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.plan_date='2026-07-31' LIMIT 1`).get();
    assert.ok(planItem?.id);
    refreshWorkCarry(database, '2026-08-01');
    createProjectFromPlanItem(database, planItem.id);
    const bundle = refreshWorkCarry(database, '2026-08-01');
    assert.equal(bundle.items.some((row) => row.objectId === planItem.id), false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
