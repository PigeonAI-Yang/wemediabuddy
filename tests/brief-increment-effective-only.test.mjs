import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { updateKnowledgeSource } from '../src/main/knowledge.ts';
import { applyLaneGateBatch, writeLaneJudgment } from '../src/main/lane-gate.ts';
import { assembleEditorialBrief, renderEditorialBrief } from '../src/main/editorial-brief.ts';

const NOW = new Date('2026-08-05T06:00:00.000Z');
const WATERMARK = '2026-08-05T02:00:00.000Z';
const LANE = 'wemedia-intelligence-engine';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-brief-eff-'));
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

test('increment excludes archived and keeps effective sources only', async () => {
  await withDb(async (database) => {
    seedSource(database, 'keep-1', '有效资料甲', '2026-08-05T03:00:00.000Z');
    const removed = seedSource(database, 'gone-1', '已移出资料', '2026-08-05T04:00:00.000Z');
    archiveSource(database, removed);

    const brief = assembleEditorialBrief(database, { now: NOW, watermark: WATERMARK });

    assert.deepEqual(brief.increment.sources.map((item) => item.title), ['有效资料甲']);
    assert.ok(!brief.increment.sources.some((item) => item.id === removed), '增量块不得包含已移出（archived）条目');
    assert.equal(brief.increment.laneFiltered.count, 0, '无判定流水时不产生透明计数');
  });
});

test('lane-filtered transparency counts irrelevant judgments in this round with top-3 reason codes', async () => {
  await withDb(async (database) => {
    const lifestyleA = seedSource(database, 'noise-a', '博主：晚饭日常', '2026-08-05T03:00:00.000Z');
    const lifestyleB = seedSource(database, 'noise-b', '博主：周末爬山', '2026-08-05T03:10:00.000Z');
    const ad = seedSource(database, 'ad-1', '推广：课程广告', '2026-08-05T03:20:00.000Z');
    const keep = seedSource(database, 'keep-2', '赛道发布：新模型评测', '2026-08-05T03:30:00.000Z');

    const applied = applyLaneGateBatch(database, {
      workspaceLane: LANE,
      judgedBy: 'agent',
      judgedAt: '2026-08-05T03:30:00.000Z',
      judgments: [
        { sourceId: lifestyleA, decision: 'irrelevant', reasonCode: 'lifestyle_noise', reason: '博主个人生活动态，与 AI 赛道无关', expectedRevision: 1 },
        { sourceId: lifestyleB, decision: 'irrelevant', reasonCode: 'lifestyle_noise', reason: '混发生活内容', expectedRevision: 1 },
        { sourceId: ad, decision: 'irrelevant', reasonCode: 'ad_promotion', reason: '营销推广内容', expectedRevision: 1 }
      ]
    });
    assert.equal(applied.archived.length, 3);
    assert.equal(database.prepare('SELECT management_status FROM source_items WHERE id = ?').get(keep).management_status, 'active');

    const brief = assembleEditorialBrief(database, { now: NOW, watermark: WATERMARK });

    assert.deepEqual(brief.increment.sources.map((item) => item.title), ['赛道发布：新模型评测'], '本轮被移出的条目不进增量');
    assert.equal(brief.increment.laneFiltered.count, 3);
    assert.deepEqual(brief.increment.laneFiltered.reasonCodes, [
      { code: 'lifestyle_noise', count: 2 },
      { code: 'ad_promotion', count: 1 }
    ]);

    const text = renderEditorialBrief(brief);
    assert.ok(text.includes('本轮另有 3 条与本赛道无关，已移出有效库：lifestyle_noise×2、ad_promotion×1'));
  });
});

test('zero irrelevant judgments renders no transparency line', async () => {
  await withDb(async (database) => {
    seedSource(database, 'keep-3', '有效资料', '2026-08-05T03:00:00.000Z');
    const brief = assembleEditorialBrief(database, { now: NOW, watermark: WATERMARK });
    assert.equal(brief.increment.laneFiltered.count, 0);
    assert.deepEqual(brief.increment.laneFiltered.reasonCodes, []);
    const text = renderEditorialBrief(brief);
    assert.ok(!text.includes('与本赛道无关'));
  });
});

test('irrelevant judgments outside the increment window are not counted', async () => {
  await withDb(async (database) => {
    // 判定发生在水印之前（上一轮）→ 不应计入本轮透明计数。
    const old = seedSource(database, 'old-gone', '上轮移出资料', '2026-08-05T00:30:00.000Z');
    archiveSource(database, old);
    writeLaneJudgment(database, {
      sourceId: old,
      workspaceLane: LANE,
      decision: 'irrelevant',
      reasonCode: 'lifestyle_noise',
      reason: '上一轮判定',
      judgedBy: 'agent',
      expectedRevision: 2,
      judgedAt: '2026-08-05T01:00:00.000Z'
    });

    const brief = assembleEditorialBrief(database, { now: NOW, watermark: WATERMARK });
    assert.equal(brief.increment.laneFiltered.count, 0, '窗口外的判定不计入本轮');
    assert.deepEqual(brief.increment.sources, []);
    assert.ok(!renderEditorialBrief(brief).includes('与本赛道无关'));
  });
});
