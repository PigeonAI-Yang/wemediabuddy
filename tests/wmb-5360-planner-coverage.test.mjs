import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { buildPlannerSourceBoundary } from '../src/main/agent-runner.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5360-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  return { root, database };
}

function item(sourceId) {
  return {
    title: '完整 coverage 方案', priority: 1, whyNow: '官方今日公布覆盖率变化，未来两天是解释窗口，错过后需要重做验证。', timeliness: 'today',
    targetAudience: '正在核对策划覆盖率并负责内容交付的具体读者', angle: '从真实任务覆盖证据切入，而不是复述任务数量。', pointOfView: '覆盖率只有绑定真实任务证据时才有决策价值。', platforms: ['wechat'],
    formats: ['article'], titleGuidance: '标题突出覆盖缺口与真实交付之间的反差。', openingGuidance: '先展示缺口证据，再说明对交付的影响。',
    structureGuidance: '第一段交代变化；第二段展示证据；第三段给出行动判断。', effortEstimate: '1d', sourceIds: [sourceId]
  };
}

function scoredItem(sourceId) {
  const value = item(sourceId);
  return { ...value, scoreReasons: scoredReasons(78), editorialDecision: editorialDecision(value.pointOfView) };
}

test('WMB-5360 migration creates the single auditable plan_source_decisions table', async () => {
  const state = await fixture();
  try {
    const row = state.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_source_decisions'").get();
    assert.equal(row?.name, 'plan_source_decisions');
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5360 incomplete Source coverage rejects the whole plan before replacement', async () => {
  const state = await fixture();
  try {
    const selected = upsertSource(state.database, { title: 'selected', originalUrl: 'https://example.test/selected', summary: 'selected' });
    const omitted = upsertSource(state.database, { title: 'omitted', originalUrl: 'https://example.test/omitted', summary: 'omitted' });
    assert.throws(() => saveCurrentPlan(state.database, {
      planDate: '2026-08-28', timezone: 'Asia/Shanghai', summary: 'coverage', items: [item(selected.id)],
      candidateSources: [{ sourceId: selected.id, sourceRevision: selected.revision }, { sourceId: omitted.id, sourceRevision: omitted.revision }],
      sourceDecisions: [{ sourceId: selected.id, sourceRevision: selected.revision, decision: 'selected', reasonCode: 'included', reason: '进入方案' }]
    }), /PLAN_SOURCE_COVERAGE_INCOMPLETE/);
    assert.equal(state.database.prepare('SELECT COUNT(*) AS count FROM plans').get().count, 0);
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5360 complete decisions persist selected and excluded exactly once', async () => {
  const state = await fixture();
  try {
    const selected = upsertSource(state.database, { title: 'selected', originalUrl: 'https://example.test/selected', summary: 'selected' });
    const excluded = upsertSource(state.database, { title: 'excluded', originalUrl: 'https://example.test/excluded', summary: 'excluded' });
    const saved = saveCurrentPlan(state.database, {
      planDate: '2026-08-28', timezone: 'Asia/Shanghai', summary: 'coverage', items: [item(selected.id)],
      candidateSources: [{ sourceId: selected.id, sourceRevision: selected.revision }, { sourceId: excluded.id, sourceRevision: excluded.revision }],
      sourceDecisions: [
        { sourceId: selected.id, decision: 'selected', reasonCode: 'included', reason: '进入方案' },
        { sourceId: excluded.id, decision: 'excluded', reasonCode: 'weak_fit', reason: '与本轮受众不匹配' }
      ]
    });
    const rows = state.database.prepare('SELECT source_id AS sourceId,decision,reason_code AS reasonCode,plan_item_id AS planItemId FROM plan_source_decisions WHERE plan_id=? ORDER BY source_id').all(saved.id);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.sourceId === selected.id).decision, 'selected');
    assert.ok(rows.find((row) => row.sourceId === selected.id).planItemId);
    assert.equal(rows.find((row) => row.sourceId === excluded.id).reasonCode, 'weak_fit');
    assert.equal(rows.find((row) => row.sourceId === excluded.id).planItemId, null);
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5360 Planner boundary is increment union reactivated evidence, while allowed adds reactivated to lane-relevant', async () => {
  const state = await fixture();
  try {
    const now = new Date().toISOString();
    state.database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','ws-5360',?,?,1)").run(now, now);
    const oldSource = upsertSource(state.database, { title: 'old', originalUrl: 'https://example.test/old', summary: 'old evidence' });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-20T00:00:00.000Z', oldSource.id);
    const recentSource = upsertSource(state.database, { title: 'recent', originalUrl: 'https://example.test/recent', summary: 'recent identity' });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-28T08:00:00.000Z', recentSource.id);
    const payload = {
      sourceId: oldSource.id, sourceRevision: oldSource.revision,
      currentSourceId: recentSource.id, currentSourceRevision: recentSource.revision,
      entityId: 'missing-entity', entityRevision: 1, topicId: 'missing-topic', reason: 'cross-day',
      matchedAliases: ['alias'], evidenceGaps: [], outcome: 'reactivated'
    };
    state.database.prepare(`INSERT INTO jobs
      (id,kind,status,due_at,attempts,dedupe_key,payload_json,last_error,created_at,updated_at,started_at,finished_at)
      VALUES ('react-job','knowledge_reactivate_sources','succeeded',?,1,'react-dedupe',?,NULL,?,?,?,?)`)
      .run(now, JSON.stringify(payload), now, now, now, now);
    const boundary = buildPlannerSourceBoundary(state.database, {
      businessDate: '2026-08-28', checkpoint: { judgeWatermark: '2026-08-27T00:00:00.000Z' }
    }, new Set([recentSource.id]));
    assert.deepEqual(boundary.candidateIds, new Set([recentSource.id, oldSource.id]));
    assert.deepEqual(boundary.allowedIds, new Set([recentSource.id, oldSource.id]));
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5360 valid automatic scoring stops at ready_for_review and never self-approves', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, { title: 'scored', originalUrl: 'https://example.test/scored', summary: 'scored' });
    const saved = saveCurrentPlan(state.database, {
      planDate: '2026-08-28', timezone: 'Asia/Shanghai', summary: 'scored', items: [scoredItem(source.id)],
      candidateSources: [{ sourceId: source.id, sourceRevision: source.revision }],
      sourceDecisions: [{ sourceId: source.id, decision: 'selected', reasonCode: 'included', reason: '进入方案' }]
    });
    const row = state.database.prepare('SELECT planning_status AS planningStatus FROM plan_items WHERE plan_id=?').get(saved.id);
    assert.equal(row.planningStatus, 'ready_for_review');
    assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM work_carry_items WHERE object_type='plan_item'").get().count, 0);
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});
