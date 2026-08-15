import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { getToday } from '../src/main/workbench.ts';
import { listFermentingBundle, refreshWorkCarry, setCarryState } from '../src/main/ferment.ts';
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

test('yesterday multi-day plan projects topic onto continuous-attention rail', () => {
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
    const hit = today.fermenting.items.find((item) => item.objectType === 'topic' && item.title.includes('DeepSeek-V4-Flash'));
    assert.ok(hit, 'expected topic progress row in continuous-attention rail');
    assert.equal(hit.objectType, 'topic');
    assert.ok(hit.topicId);
    assert.equal(today.plan, null);
    assert.ok(hit.fermentedDays >= 0);
    assert.equal(today.fermenting.items.some((item) => item.objectType === 'source'), false);
    assert.equal(today.fermenting.pinnedSources.length, 0);
    const linked = database.prepare('SELECT count(*) AS c FROM topic_source_links WHERE topic_id=?').get(hit.topicId);
    assert.ok(Number(linked.c) >= 1, 'plan save should link sources onto topic');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bare high-value source alone does not appear on continuous-attention rail', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-ferment-bare-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    upsertSource(database, {
      title: '孤立高价值资料不应上桌',
      originalUrl: 'https://example.com/bare-source',
      summary: 'no plan no topic',
      priority: 0,
      categories: ['signal']
    });
    // Backdate so seed window would historically pick it up.
    database.prepare(`UPDATE source_items SET collected_at = ?`).run('2026-07-30T08:00:00.000Z');
    const bundle = refreshWorkCarry(database, '2026-08-01');
    assert.equal(bundle.items.some((row) => row.objectType === 'source'), false);
    assert.equal(bundle.items.length, 0);
    assert.equal(bundle.pinnedSources.length, 0);
    const sourceCarry = database.prepare(`SELECT count(*) AS c FROM work_carry_items WHERE object_type='source'`).get();
    assert.equal(Number(sourceCarry.c), 0, 'seedCarryFromHighValueSources must not insert source carry');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dismissing plan-item carry removes topic from rail when no other signal', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-ferment-state-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    seedPlan(database, '2026-07-31');
    let bundle = refreshWorkCarry(database, '2026-08-01');
    const topicRow = bundle.items.find((row) => row.objectType === 'topic' && row.title.includes('DeepSeek-V4-Flash'));
    assert.ok(topicRow);
    const carry = database.prepare(`SELECT id, revision FROM work_carry_items WHERE object_type='plan_item' AND state='active' LIMIT 1`).get();
    assert.ok(carry);
    const dismissed = setCarryState(database, { id: carry.id, expectedRevision: carry.revision, state: 'dismissed' });
    assert.equal(dismissed.state, 'dismissed');
    // Drop topic_source_links so only carry signal remains for this fixture.
    database.prepare('DELETE FROM topic_source_links').run();
    database.prepare(`UPDATE topics SET last_seen_at = ?`).run('2026-06-01T00:00:00.000Z');
    bundle = listFermentingBundle(database, '2026-08-01');
    assert.equal(bundle.items.some((row) => row.topicId === topicRow.topicId), false);
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
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('creating project marks matching carry done and topic may leave if no signal', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-ferment-done-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    seedPlan(database, '2026-07-31');
    const planItem = database.prepare(`SELECT pi.id, pi.topic_id AS topicId FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.plan_date='2026-07-31' LIMIT 1`).get();
    assert.ok(planItem?.id);
    refreshWorkCarry(database, '2026-08-01');
    createProjectFromPlanItem(database, planItem.id);
    const activeCarry = database.prepare(`SELECT count(*) AS c FROM work_carry_items WHERE object_type='plan_item' AND object_id=? AND state IN ('active','watching')`).get(planItem.id);
    assert.equal(Number(activeCarry.c), 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
