import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { LANE_JUDGMENT_COOLDOWN_MS, getLatestLaneJudgment, readLaneJudgments, shouldSkipJudgment } from '../src/main/lane-gate.ts';
import { dispatchLaneGate, dispatchLaneRestore, dispatchSourceUpsertBatch } from '../src/main/source-commands.ts';
import { getSource } from '../src/main/sources.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { ensureAutomaticTaskGrant, getTaskGrant } from '../src/main/task-grants.ts';

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const external = { type: 'external_agent', id: 'mcp', label: 'External MCP Agent' };
const LANE = 'wemedia-intelligence-engine';

test('migration applies source_lane_judgments as append-only audit table', async () => {
  await withRuntime(async ({ database }) => {
    const columns = database.prepare('PRAGMA table_info(source_lane_judgments)').all().map((row) => row.name);
    assert.deepEqual(columns, [
      'id', 'source_id', 'workspace_lane', 'decision', 'reason_code', 'reason',
      'judged_by', 'confidence', 'source_revision', 'judged_at'
    ]);
    const decisionCheck = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='source_lane_judgments'").get().sql;
    assert.match(decisionCheck, /decision IN \('relevant', 'irrelevant'\)/);
    assert.match(decisionCheck, /judged_by IN \('system', 'agent', 'editor'\)/);
    assert.match(decisionCheck, /ON DELETE CASCADE/);
  });
});

test('lane_gate writes judgment rows with receipt and readback via readLaneJudgments/latest', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'AI lane source');
    const receipt = await dispatchLaneGate(runtime, {
      requestId: 'gate-write', actor: owner, workspaceLane: LANE, judgedBy: 'agent', judgedAt: '2026-08-07T08:00:00.000Z',
      judgments: [{
        sourceId, decision: 'irrelevant', reasonCode: 'lifestyle_noise',
        reason: '博主个人生活动态，与 AI 赛道无关', expectedRevision: 1
      }]
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.command, 'sources.lane_gate');
    assert.equal(receipt.version, 'CommandReceiptV1');
    assert.equal(receipt.data.written.length, 1);
    assert.equal(receipt.data.skipped.length, 0);
    assert.equal(receipt.data.judgments[0].decision, 'irrelevant');
    assert.equal(receipt.data.judgments[0].reasonCode, 'lifestyle_noise');
    assert.equal(receipt.data.judgments[0].judgedBy, 'agent');
    assert.equal(receipt.data.judgments[0].sourceRevision, 2);

    const rows = database.prepare('SELECT * FROM source_lane_judgments').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_id, sourceId);
    assert.equal(rows[0].workspace_lane, LANE);
    assert.equal(rows[0].reason, '博主个人生活动态，与 AI 赛道无关');
    assert.equal(getSource(database, sourceId).managementStatus, 'archived');
    assert.equal(getSource(database, sourceId).revision, 2);

    const read = readLaneJudgments(database, { sourceId });
    assert.equal(read.length, 1);
    assert.equal(read[0].id, receipt.data.judgments[0].id);
    assert.equal(getLatestLaneJudgment(database, sourceId).reasonCode, 'lifestyle_noise');
    assert.equal(readLaneJudgments(database, { workspaceLane: LANE }).length, 1);
  });
});

test('replay returns prior receipt and same-input conflict rejects with zero writes', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Replay source');
    const input = {
      requestId: 'gate-replay', actor: owner, workspaceLane: LANE, judgedBy: 'agent', judgedAt: '2026-08-07T08:00:00.000Z',
      judgments: [{ sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 1 }]
    };
    const baselineReceipts = count(database, 'command_receipts');
    const first = await dispatchLaneGate(runtime, input);
    const replay = await dispatchLaneGate(runtime, input);
    assert.deepEqual(replay, first);
    assert.equal(count(database, 'source_lane_judgments'), 1);
    assert.equal(count(database, 'command_receipts'), baselineReceipts + 1);

    await assert.rejects(() => dispatchLaneGate(runtime, {
      ...input, judgments: [{ sourceId, decision: 'irrelevant', reasonCode: 'ad_promotion', reason: '广告', expectedRevision: 1 }]
    }), { code: 'REQUEST_REPLAY_CONFLICT' });
    const other = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'sources.other', requestId: input.requestId, input: {}, boundIdentity: { entityType: 'lane_judgment' }, actor: owner
    });
    await assert.rejects(() => runtime.dispatchCommand(other, () => ({ data: {}, entityType: 'lane_judgment' })), { code: 'REQUEST_REPLAY_CONFLICT' });
    assert.equal(count(database, 'source_lane_judgments'), 1);
    assert.equal(count(database, 'command_receipts'), baselineReceipts + 1);
  });
});

test('stale runtime identity and stale source revision both write zero judgment rows', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Stale revision source');
    const staleEnvelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId, runtimeEpoch: 'stale-epoch', command: 'sources.lane_gate',
      requestId: 'gate-stale-runtime', input: { workspaceLane: LANE, judgedBy: 'agent', judgedAt: null, judgments: [] },
      boundIdentity: { entityType: 'lane_judgment' }, actor: external
    });
    await assert.rejects(() => runtime.dispatchCommand(staleEnvelope, () => ({ data: {}, entityType: 'lane_judgment' })), { code: 'WORKSPACE_STALE' });
    assert.equal(count(database, 'source_lane_judgments'), 0);

    const staleRevision = await dispatchLaneGate(runtime, {
      requestId: 'gate-stale-revision', actor: owner, workspaceLane: LANE, judgedBy: 'agent',
      judgments: [{ sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 0 }]
    });
    assert.equal(staleRevision.ok, false);
    assert.equal(staleRevision.error.code, 'REVISION_CONFLICT');
    assert.equal(count(database, 'source_lane_judgments'), 0);

    const missingSource = await dispatchLaneGate(runtime, {
      requestId: 'gate-missing-source', actor: owner, workspaceLane: LANE, judgedBy: 'agent',
      judgments: [{ sourceId: 'does-not-exist', decision: 'relevant', reasonCode: 'official_source', expectedRevision: 1 }]
    });
    assert.equal(missingSource.ok, false);
    assert.equal(missingSource.error.code, 'SOURCE_NOT_FOUND');
    assert.equal(count(database, 'source_lane_judgments'), 0);
  });
});

test('irrelevant without reason rejects LANE_JUDGMENT_INVALID and same-round re-run is zero-write', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Round idempotency source');
    const invalid = await dispatchLaneGate(runtime, {
      requestId: 'gate-no-reason', actor: owner, workspaceLane: LANE, judgedBy: 'agent',
      judgments: [{ sourceId, decision: 'irrelevant', reasonCode: 'lifestyle_noise', expectedRevision: 1 }]
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'LANE_JUDGMENT_INVALID');
    assert.equal(count(database, 'source_lane_judgments'), 0);

    const roundInput = {
      requestId: 'gate-round-1', actor: owner, workspaceLane: LANE, judgedBy: 'agent', judgedAt: '2026-08-07T08:00:00.000Z',
      judgments: [{ sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 1 }]
    };
    const first = await dispatchLaneGate(runtime, roundInput);
    assert.equal(first.ok, true);
    const retried = await dispatchLaneGate(runtime, { ...roundInput, requestId: 'gate-round-1-retry' });
    assert.equal(retried.ok, true);
    assert.equal(retried.data.written.length, 0);
    assert.deepEqual(retried.data.skipped, [{ sourceId, reason: 'already_judged' }]);
    assert.equal(count(database, 'source_lane_judgments'), 1);
  });
});

test('judgments are append-only: newer round rows accumulate and latest wins', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Append-only source');
    const first = await dispatchLaneGate(runtime, {
      requestId: 'gate-append-1', actor: owner, workspaceLane: LANE, judgedBy: 'agent', judgedAt: '2026-08-07T08:00:00.000Z',
      judgments: [{ sourceId, decision: 'irrelevant', reasonCode: 'lifestyle_noise', reason: '生活动态', expectedRevision: 1 }]
    });
    assert.equal(first.ok, true);
    const second = await dispatchLaneGate(runtime, {
      requestId: 'gate-append-2', actor: owner, workspaceLane: LANE, judgedBy: 'system', judgedAt: '2026-08-08T08:00:00.000Z',
      judgments: [{ sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 2 }]
    });
    assert.equal(second.ok, true);
    assert.equal(count(database, 'source_lane_judgments'), 2);
    assert.equal(getSource(database, sourceId).managementStatus, 'archived');
    const latest = getLatestLaneJudgment(database, sourceId);
    assert.equal(latest.decision, 'relevant');
    assert.equal(latest.judgedBy, 'system');
    assert.equal(latest.judgedAt, '2026-08-08T08:00:00.000Z');
  });
});

test('lane_restore moves archived source back to active and appends editor override row', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Restore me');
    await archiveSource(runtime, sourceId); // revision 1 -> 2, management_status='archived'
    const receipt = await dispatchLaneRestore(runtime, {
      requestId: 'restore-1', actor: owner, sourceId, workspaceLane: LANE, expectedRevision: 2,
      reason: '误判，恢复为有效素材'
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.command, 'sources.lane_restore');
    assert.equal(receipt.data.restored, true);
    assert.equal(receipt.data.source.managementStatus, 'active');
    assert.equal(receipt.data.source.revision, 3);
    assert.equal(receipt.revisions.before, 2);
    assert.equal(receipt.revisions.after, 3);
    assert.equal(receipt.data.judgment.judgedBy, 'editor');
    assert.equal(receipt.data.judgment.decision, 'relevant');
    assert.equal(receipt.data.judgment.reasonCode, 'editor_override');
    assert.equal(receipt.data.judgment.reason, '误判，恢复为有效素材');
    assert.equal(receipt.data.judgment.sourceRevision, 3);

    const rows = readLaneJudgments(database, { sourceId });
    assert.equal(rows.length, 1);
    assert.equal(getSource(database, sourceId).managementStatus, 'active');
  });
});

test('lane_restore is zero-write when source is already active or revision is stale', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Already active');
    const noop = await dispatchLaneRestore(runtime, {
      requestId: 'restore-noop', actor: owner, sourceId, workspaceLane: LANE, expectedRevision: 1
    });
    assert.equal(noop.ok, true);
    assert.equal(noop.data.restored, false);
    assert.equal(noop.data.judgment, null);
    assert.equal(count(database, 'source_lane_judgments'), 0);
    assert.equal(getSource(database, sourceId).revision, 1);

    await archiveSource(runtime, sourceId);
    const stale = await dispatchLaneRestore(runtime, {
      requestId: 'restore-stale', actor: owner, sourceId, workspaceLane: LANE, expectedRevision: 1
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'REVISION_CONFLICT');
    assert.equal(count(database, 'source_lane_judgments'), 0);
    assert.equal(getSource(database, sourceId).managementStatus, 'archived');
  });
});

test('cooldown helper blocks re-judgment within 7 days after restore and allows after expiry', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const sourceId = await seedSource(runtime, 'Cooldown source');
    await archiveSource(runtime, sourceId);
    const restored = await dispatchLaneRestore(runtime, {
      requestId: 'restore-cooldown', actor: owner, sourceId, workspaceLane: LANE, expectedRevision: 2,
      judgedAt: '2026-08-07T08:00:00.000Z'
    });
    assert.equal(restored.ok, true);
    const within = new Date('2026-08-10T08:00:00.000Z');
    assert.equal(shouldSkipJudgment(database, sourceId, within, LANE_JUDGMENT_COOLDOWN_MS), true);
    assert.equal(shouldSkipJudgment(database, sourceId, within), true);
    const after = new Date('2026-08-15T08:00:00.000Z');
    assert.equal(shouldSkipJudgment(database, sourceId, after, LANE_JUDGMENT_COOLDOWN_MS), false);
    assert.equal(shouldSkipJudgment(database, 'unknown-source', within), false);
  });
});

test('lane_gate runs under the daily judge task grant and automatic scope mounts it', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'daily_intelligence', businessDate: '2026-08-07',
      contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: owner, requestId: 'task-start-lane-grant' })).task;
    const grantId = await ensureAutomaticTaskGrant(runtime, task.id);
    const grant = getTaskGrant(runtime.database, grantId);
    assert.ok(grant.allowedCommands.includes('sources.lane_gate'));
    assert.ok(!grant.allowedCommands.includes('sources.lane_restore'), 'lane_restore is editor intent, not automatic');

    const sourceId = await seedSource(runtime, 'Granted lane source');
    const receipt = await dispatchLaneGate(runtime, {
      requestId: 'gate-granted', actor: external, taskId: task.id, grantId,
      workspaceLane: LANE, judgedBy: 'agent',
      judgments: [{ sourceId, decision: 'irrelevant', reasonCode: 'off_lane_content', reason: '赛道外内容', expectedRevision: 1 }]
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.actor.type, 'external_agent');
    assert.equal(count(database, 'source_lane_judgments'), 1);

    const withoutGrant = await dispatchLaneGate(runtime, {
      requestId: 'gate-no-grant', actor: external, taskId: task.id,
      workspaceLane: LANE, judgedBy: 'agent',
      judgments: [{ sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 1 }]
    });
    assert.equal(withoutGrant.ok, false);
    assert.equal(withoutGrant.error.code, 'TASK_GRANT_REQUIRED');
    assert.equal(count(database, 'source_lane_judgments'), 1);
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-lane-gate-'));
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

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
}
