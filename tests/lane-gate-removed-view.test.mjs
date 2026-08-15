import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { LANE_JUDGMENT_COOLDOWN_MS, getLatestLaneJudgment, shouldSkipJudgment } from '../src/main/lane-gate.ts';
import { dispatchLaneGate, dispatchLaneRestore, dispatchSourceUpsertBatch } from '../src/main/source-commands.ts';
import { listKnowledgeSources } from '../src/main/knowledge.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const LANE = 'wemedia-intelligence-engine';

test('removed view list: lane-gated archive carries reason badge data, manual archive carries none', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const gated = await seedSource(runtime, 'AI 判定移出');
    const manual = await seedSource(runtime, '主编手动归档');

    // 一轮 AI 判定：不相关 → archived + agent 流水行（reason 必填）。
    const gate = await dispatchLaneGate(runtime, {
      requestId: `gate-${randomUUID()}`, actor: owner, workspaceLane: LANE, judgedBy: 'agent',
      judgedAt: '2026-08-07T08:00:00.000Z',
      judgments: [{ sourceId: gated, decision: 'irrelevant', reasonCode: 'lifestyle_noise', reason: '博主个人生活动态，与 AI 赛道无关', expectedRevision: 1 }]
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.data.archived.length, 1);

    // 主编手动归档（无判定流水行）。
    archiveSource(runtime, manual);

    const archived = listKnowledgeSources(database, { managementStatus: 'archived', limit: 20 });
    assert.equal(archived.total, 2);
    const gatedItem = archived.items.find((item) => item.id === gated);
    const manualItem = archived.items.find((item) => item.id === manual);
    assert.ok(gatedItem, 'AI 判定移出的资料必须在已移出列表');
    assert.equal(gatedItem.laneJudgment.decision, 'irrelevant');
    assert.equal(gatedItem.laneJudgment.reasonCode, 'lifestyle_noise');
    assert.equal(gatedItem.laneJudgment.reason, '博主个人生活动态，与 AI 赛道无关');
    assert.equal(gatedItem.laneJudgment.judgedBy, 'agent');
    assert.equal(gatedItem.laneJudgment.judgedAt, '2026-08-07T08:00:00.000Z');
    assert.equal(manualItem.laneJudgment, null, '手动归档无判定行 → 徽标「主编归档」');

    // 默认列表（有效库）不含两条归档项。
    const effective = listKnowledgeSources(database, { limit: 20 });
    assert.ok(!effective.items.some((item) => item.id === gated || item.id === manual));

    // 未判定的有效资料 laneJudgment 为空，不产生噪音字段。
    const fresh = await seedSource(runtime, '有效资料');
    const freshItem = listKnowledgeSources(database, { limit: 20 }).items.find((item) => item.id === fresh);
    assert.equal(freshItem.laneJudgment, null);
  });
});

test('restore moves source out of removed list into effective library with editor judgment row and 7d cooldown', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, '待恢复资料');
    const gate = await dispatchLaneGate(runtime, {
      requestId: `gate-${randomUUID()}`, actor: owner, workspaceLane: LANE, judgedBy: 'agent',
      judgedAt: '2026-08-07T08:00:00.000Z',
      judgments: [{ sourceId, decision: 'irrelevant', reasonCode: 'off_lane_content', reason: '赛道外内容', expectedRevision: 1 }]
    });
    assert.equal(gate.ok, true);

    // 恢复（主编覆写）：archived → active + editor 流水行。
    const restore = await dispatchLaneRestore(runtime, {
      requestId: `restore-${randomUUID()}`, actor: owner, sourceId, workspaceLane: LANE,
      expectedRevision: 2, reason: '误判，恢复为有效素材', judgedAt: '2026-08-07T09:00:00.000Z'
    });
    assert.equal(restore.ok, true);
    assert.equal(restore.data.restored, true);
    assert.equal(restore.data.source.managementStatus, 'active');

    // 已移出列表不再包含，默认列表（有效库）可见。
    const archived = listKnowledgeSources(database, { managementStatus: 'archived', limit: 20 });
    assert.ok(!archived.items.some((item) => item.id === sourceId));
    const effective = listKnowledgeSources(database, { limit: 20 });
    assert.ok(effective.items.some((item) => item.id === sourceId));

    // 流水含 editor 覆写行（当前判定 = 最新行胜出）。
    const latest = getLatestLaneJudgment(database, sourceId);
    assert.equal(latest.decision, 'relevant');
    assert.equal(latest.reasonCode, 'editor_override');
    assert.equal(latest.judgedBy, 'editor');
    assert.equal(latest.reason, '误判，恢复为有效素材');

    // 7 日冷却：恢复后 7 日内不重判，期满后可重判。
    const within = new Date('2026-08-10T08:00:00.000Z');
    assert.equal(shouldSkipJudgment(database, sourceId, within, LANE_JUDGMENT_COOLDOWN_MS), true);
    const after = new Date('2026-08-15T08:00:00.000Z');
    assert.equal(shouldSkipJudgment(database, sourceId, after, LANE_JUDGMENT_COOLDOWN_MS), false);

    // 恢复后即使被渠道重采（同一 source_id），7 日内判定编排层也跳过。
    const skip = shouldSkipJudgment(database, sourceId, within, LANE_JUDGMENT_COOLDOWN_MS);
    assert.equal(skip, true);
  });
});

async function seedSource(runtime, title) {
  const receipt = await dispatchSourceUpsertBatch(runtime, {
    requestId: `seed-${randomUUID()}`, actor: owner,
    items: [{ title, originalUrl: `https://example.com/${randomUUID()}` }]
  });
  assert.equal(receipt.ok, true);
  return receipt.data.items[0].id;
}

function archiveSource(runtime, sourceId) {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: 'test.lane.archive_fixture',
    requestId: `archive-${sourceId}-${randomUUID()}`,
    input: { sourceId },
    boundIdentity: { sourceId },
    actor: owner
  });
  return runtime.dispatchCommand(envelope, () => {
    const current = runtime.database.prepare('SELECT revision FROM source_items WHERE id=?').get(sourceId);
    if (!current) throw new Error('SOURCE_NOT_FOUND');
    runtime.database.prepare("UPDATE source_items SET management_status='archived', updated_at=?, revision=revision+1 WHERE id=? AND revision=?")
      .run(new Date().toISOString(), sourceId, current.revision);
    return { data: { sourceId }, entityType: 'source_item', entityId: sourceId };
  });
}

async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-lane-removed-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    await work({ root, runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
