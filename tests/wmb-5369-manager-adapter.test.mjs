import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hashV1 } from '../src/main/workspace-orchestrator-actor.ts';
import {
  buildManagerTypedCommand,
  readManagerAdapterProjection
} from '../src/main/workspace-orchestrator-manager-adapter.ts';

const BUSINESS_DATE = '2026-08-30';
const NOW = '2026-08-30T10:00:00.000Z';
const HEX = (letter) => letter.repeat(64);

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE workspace_active_root_index (
      workspace_id TEXT NOT NULL,
      root_request_id TEXT NOT NULL,
      orchestration_id TEXT NOT NULL,
      manager_task_id TEXT NOT NULL,
      root_generation INTEGER NOT NULL,
      source TEXT NOT NULL,
      root_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      terminal_reason TEXT,
      is_active INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      mailbox_sequence INTEGER NOT NULL,
      checkpoint_revision INTEGER NOT NULL,
      index_revision INTEGER NOT NULL,
      stage_request_id TEXT,
      projection_state TEXT NOT NULL,
      scope_hash TEXT,
      projection_hash TEXT,
      eligible_ids_hash TEXT,
      next_action TEXT,
      visible_since TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, root_request_id)
    );
    CREATE TABLE daily_orchestration_roots (
      workspace_id TEXT NOT NULL,
      root_request_id TEXT NOT NULL,
      intent_id TEXT,
      business_date TEXT NOT NULL,
      source TEXT NOT NULL,
      root_mode TEXT NOT NULL,
      root_generation INTEGER NOT NULL,
      root_input_hash TEXT NOT NULL,
      orchestration_id TEXT NOT NULL,
      manager_task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      coverage_gap_json TEXT NOT NULL,
      stop_reason_json TEXT,
      finished_at TEXT,
      root_deadline_utc TEXT,
      root_deadline_mono INTEGER,
      gate_deadline_utc TEXT,
      gate_deadline_mono INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, root_request_id)
    );
    CREATE TABLE daily_stage_claims (
      workspace_id TEXT NOT NULL,
      stage_request_id TEXT NOT NULL,
      root_request_id TEXT NOT NULL,
      root_generation INTEGER NOT NULL,
      manager_task_id TEXT NOT NULL,
      orchestration_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      finished_at TEXT,
      PRIMARY KEY (workspace_id, stage_request_id)
    );
    CREATE TABLE daily_plan_scopes (
      workspace_id TEXT NOT NULL,
      stage_request_id TEXT NOT NULL,
      root_request_id TEXT NOT NULL,
      root_generation INTEGER NOT NULL,
      root_input_hash TEXT NOT NULL,
      manager_task_id TEXT NOT NULL,
      orchestration_id TEXT NOT NULL,
      source_snapshot_hash TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      scope_status TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, stage_request_id)
    );
  `);
  return database;
}

function scopeAndProjection(input) {
  const candidate = [...new Set([
    ...input.eligiblePlanItemIds,
    ...input.pendingPlanItemIds,
    ...input.invalidPlanItemIds
  ])].sort();
  const scopeBase = {
    version: 'PlanScopeV1',
    workspaceId: input.workspaceId,
    stageRequestId: input.stageRequestId,
    rootRequestId: input.rootRequestId,
    rootGeneration: input.rootGeneration,
    rootInputHash: input.rootInputHash,
    bindingKind: 'initial_source',
    repairSnapshotId: null,
    repairSnapshotHash: null,
    bindingHash: null,
    allowedPlanIds: candidate.length ? ['plan-1'] : [],
    allowedPlanItemIds: candidate,
    carryPlanItemIds: [],
    trustedReceiptIds: candidate.length ? ['receipt-1'] : []
  };
  const scopeHash = hashV1({
    r: 'plan-scope/v1',
    workspaceId: input.workspaceId,
    stageRequestId: input.stageRequestId,
    rootRequestId: input.rootRequestId,
    sourceSnapshotHash: input.sourceSnapshotHash,
    bindingHash: null,
    orderedAllowedPlanIds: scopeBase.allowedPlanIds,
    orderedAllowedItemIds: scopeBase.allowedPlanItemIds,
    orderedCarryItemIds: [],
    trustedReceiptIds: scopeBase.trustedReceiptIds,
    scopeJson: scopeBase
  });
  const scope = { ...scopeBase, scopeHash };
  const entries = candidate.map((planItemId) => ({
    planItemId,
    classification: input.eligiblePlanItemIds.includes(planItemId)
      ? 'eligible'
      : input.pendingPlanItemIds.includes(planItemId) ? 'pending' : 'invalid',
    sourceReceiptIds: scopeBase.trustedReceiptIds
  }));
  const asOf = { utc: NOW, mono: null };
  const projectionBase = {
    version: 'TodayRecommendationProjectionV2',
    workspaceId: input.workspaceId,
    businessDate: BUSINESS_DATE,
    managerTaskId: input.managerTaskId,
    orchestrationId: input.orchestrationId,
    stageRequestId: input.stageRequestId,
    scopeHash,
    bindingHash: null,
    repairSnapshotHash: null,
    planIds: scopeBase.allowedPlanIds,
    asOf,
    entries,
    candidatePlanItemIds: candidate,
    eligiblePlanItemIds: [...input.eligiblePlanItemIds],
    pendingPlanItemIds: [...input.pendingPlanItemIds],
    invalidPlanItemIds: [...input.invalidPlanItemIds],
    trustedReceiptIds: scopeBase.trustedReceiptIds,
    emptyQualified: Boolean(input.emptyQualified),
    acceptanceRunId: null,
    baselineEventSequence: null,
    baselineCheckpointRevision: null,
    createdAfterEventSequence: null,
    createdAfterCheckpointRevision: null,
    createdAfterMono: null
  };
  const projectionHash = hashV1({
    r: 'projection/v2',
    workspaceId: projectionBase.workspaceId,
    businessDate: projectionBase.businessDate,
    managerTaskId: projectionBase.managerTaskId,
    orchestrationId: projectionBase.orchestrationId,
    stageRequestId: projectionBase.stageRequestId,
    scopeHash,
    bindingHash: null,
    repairSnapshotHash: null,
    planIds: projectionBase.planIds,
    asOf,
    orderedEntries: entries,
    candidatePlanItemIds: candidate,
    eligiblePlanItemIds: projectionBase.eligiblePlanItemIds,
    pendingPlanItemIds: projectionBase.pendingPlanItemIds,
    invalidPlanItemIds: projectionBase.invalidPlanItemIds,
    trustedReceiptIds: projectionBase.trustedReceiptIds,
    emptyQualified: projectionBase.emptyQualified
  });
  return { scope, projection: { ...projectionBase, projectionHash }, candidate };
}

function insertRoot(database, input) {
  const rootInputHash = input.rootInputHash ?? HEX('r');
  const root = {
    workspaceId: input.workspaceId ?? 'workspace-a',
    rootRequestId: input.rootRequestId,
    orchestrationId: input.orchestrationId ?? `${input.rootRequestId}-orch`,
    managerTaskId: input.managerTaskId ?? `${input.rootRequestId}-manager`,
    rootGeneration: input.rootGeneration ?? 0,
    source: input.source ?? 'today_ui',
    rootMode: input.rootMode ?? 'owner',
    status: input.status ?? 'waiting_owner',
    businessDate: input.businessDate ?? BUSINESS_DATE,
    rootInputHash,
    stageRequestId: input.projectionState === 'frozen' ? (input.stageRequestId ?? `${input.rootRequestId}-stage`) : null,
    projectionState: input.projectionState ?? 'absent',
    priority: input.priority ?? 1,
    mailboxSequence: input.mailboxSequence ?? (input.rootGeneration + 1),
    checkpointRevision: input.checkpointRevision ?? 1,
    indexRevision: input.indexRevision ?? 1,
    terminalReason: input.terminalReason ?? null,
    nextAction: input.nextAction ?? { kind: 'no_action' }
  };
  database.prepare(`INSERT INTO daily_orchestration_roots (
    workspace_id,root_request_id,intent_id,business_date,source,root_mode,root_generation,
    root_input_hash,orchestration_id,manager_task_id,status,coverage_gap_json,stop_reason_json,
    finished_at,root_deadline_utc,root_deadline_mono,gate_deadline_utc,gate_deadline_mono,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    root.workspaceId, root.rootRequestId, null, root.businessDate, root.source, root.rootMode, root.rootGeneration,
    root.rootInputHash, root.orchestrationId, root.managerTaskId, root.status, '[]', root.terminalReason,
    null, NOW, 999999, NOW, 999999, NOW
  );

  let hashes = { scopeHash: null, projectionHash: null, eligibleIdsHash: null };
  if (root.projectionState === 'frozen') {
    const frozen = scopeAndProjection({
      ...root,
      stageRequestId: root.stageRequestId,
      sourceSnapshotHash: input.sourceSnapshotHash ?? HEX('s'),
      eligiblePlanItemIds: input.eligiblePlanItemIds ?? [],
      pendingPlanItemIds: input.pendingPlanItemIds ?? [],
      invalidPlanItemIds: input.invalidPlanItemIds ?? [],
      emptyQualified: input.emptyQualified ?? false
    });
    hashes = {
      scopeHash: frozen.scope.scopeHash,
      projectionHash: frozen.projection.projectionHash,
      eligibleIdsHash: hashV1({
        r: 'eligible-ids/v1',
        workspaceId: root.workspaceId,
        rootRequestId: root.rootRequestId,
        stageRequestId: root.stageRequestId,
        scopeHash: frozen.scope.scopeHash,
        projectionHash: frozen.projection.projectionHash,
        orderedEligiblePlanItemIds: frozen.projection.eligiblePlanItemIds
      })
    };
    database.prepare(`INSERT INTO daily_stage_claims (
      workspace_id,stage_request_id,root_request_id,root_generation,manager_task_id,orchestration_id,status,result_json,finished_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      root.workspaceId, root.stageRequestId, root.rootRequestId, root.rootGeneration,
      root.managerTaskId, root.orchestrationId, 'succeeded', JSON.stringify({ projection: frozen.projection }), NOW
    );
    database.prepare(`INSERT INTO daily_plan_scopes (
      workspace_id,stage_request_id,root_request_id,root_generation,root_input_hash,manager_task_id,
      orchestration_id,source_snapshot_hash,scope_hash,scope_status,scope_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      root.workspaceId, root.stageRequestId, root.rootRequestId, root.rootGeneration, root.rootInputHash,
      root.managerTaskId, root.orchestrationId, input.sourceSnapshotHash ?? HEX('s'), frozen.scope.scopeHash,
      'frozen', JSON.stringify({ scope: frozen.scope, projection: frozen.projection })
    );
  }
  database.prepare(`INSERT INTO workspace_active_root_index (
    workspace_id,root_request_id,orchestration_id,manager_task_id,root_generation,source,root_mode,
    status,terminal_reason,is_active,priority,mailbox_sequence,checkpoint_revision,index_revision,
    stage_request_id,projection_state,scope_hash,projection_hash,eligible_ids_hash,next_action,visible_since,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    root.workspaceId, root.rootRequestId, root.orchestrationId, root.managerTaskId, root.rootGeneration,
    root.source, root.rootMode, root.status, root.terminalReason, 1, root.priority, root.mailboxSequence,
    root.checkpointRevision, root.indexRevision, root.stageRequestId, root.projectionState,
    hashes.scopeHash, hashes.projectionHash, hashes.eligibleIdsHash, JSON.stringify(root.nextAction), NOW, NOW
  );
  return root;
}

function readRoots(database) {
  return readManagerAdapterProjection(database, { workspaceId: 'workspace-a', businessDate: BUSINESS_DATE }).roots;
}

test('A09/A11: same-day roots remain isolated and each opportunity count equals its eligible set', () => {
  const database = createDatabase();
  try {
    insertRoot(database, { rootRequestId: 'root-a', rootGeneration: 0, priority: 1, eligiblePlanItemIds: ['item-a'], projectionState: 'frozen' });
    insertRoot(database, { rootRequestId: 'root-b', rootGeneration: 1, priority: 2, eligiblePlanItemIds: ['item-b', 'item-c'], projectionState: 'frozen' });
    const model = readRoots(database);
    assert.equal(model.length, 2);
    assert.deepEqual(model.map((root) => root.identity.rootRequestId), ['root-a', 'root-b']);
    assert.deepEqual(model[0].eligiblePlanItemIds, ['item-a']);
    assert.deepEqual(model[1].eligiblePlanItemIds, ['item-b', 'item-c']);
    for (const root of model) {
      assert.equal(root.opportunityCount, root.eligiblePlanItemIds.length);
      assert.equal(root.opportunityCount, root.eligiblePlanItemIds.length, 'child/row counts never substitute for opportunities');
      assert.equal(root.projectionError, null);
      assert.ok(root.identity.scopeHash);
      assert.ok(root.identity.projectionHash);
      assert.ok(root.identity.eligibleIdsHash);
    }
  } finally {
    database.close();
  }
});

test('A18/A24/A38: absent, not_applicable, clean-empty, pending, invalid and mixed projections stay truthful', () => {
  const database = createDatabase();
  try {
    insertRoot(database, { rootRequestId: 'absent', rootGeneration: 0, priority: 1, projectionState: 'absent' });
    insertRoot(database, { rootRequestId: 'not-applicable', rootGeneration: 1, priority: 2, projectionState: 'not_applicable' });
    insertRoot(database, { rootRequestId: 'clean-empty', rootGeneration: 2, priority: 3, projectionState: 'frozen', emptyQualified: true });
    insertRoot(database, { rootRequestId: 'eligible', rootGeneration: 3, priority: 4, projectionState: 'frozen', eligiblePlanItemIds: ['eligible-1'] });
    insertRoot(database, { rootRequestId: 'pending', rootGeneration: 4, priority: 5, projectionState: 'frozen', pendingPlanItemIds: ['pending-1'] });
    insertRoot(database, { rootRequestId: 'invalid', rootGeneration: 5, priority: 6, projectionState: 'frozen', invalidPlanItemIds: ['invalid-1'] });
    insertRoot(database, { rootRequestId: 'mixed', rootGeneration: 6, priority: 7, projectionState: 'frozen', eligiblePlanItemIds: ['mixed-e'], pendingPlanItemIds: ['mixed-p'], invalidPlanItemIds: ['mixed-i'] });
    const byId = new Map(readRoots(database).map((root) => [root.identity.rootRequestId, root]));
    assert.equal(byId.get('absent').projectionState, 'absent');
    assert.equal(byId.get('absent').projectionHash, null);
    assert.deepEqual(byId.get('absent').eligiblePlanItemIds, []);
    assert.equal(byId.get('not-applicable').projectionState, 'not_applicable');
    assert.equal(byId.get('clean-empty').projectionState, 'frozen');
    assert.equal(byId.get('clean-empty').emptyQualified, true);
    assert.equal(byId.get('clean-empty').opportunityCount, 0);
    assert.deepEqual(byId.get('pending').pendingPlanItemIds, ['pending-1']);
    assert.equal(byId.get('pending').opportunityCount, 0);
    assert.deepEqual(byId.get('invalid').invalidPlanItemIds, ['invalid-1']);
    assert.equal(byId.get('invalid').opportunityCount, 0);
    assert.deepEqual(byId.get('mixed').eligiblePlanItemIds, ['mixed-e']);
    assert.deepEqual(byId.get('mixed').pendingPlanItemIds, ['mixed-p']);
    assert.deepEqual(byId.get('mixed').invalidPlanItemIds, ['mixed-i']);
    assert.equal(byId.get('mixed').opportunityCount, 1);
    for (const root of byId.values()) assert.equal(root.projectionError, null);
  } finally {
    database.close();
  }
});

test('A52-A53: stale or mismatched frozen identity fails closed and typed commands reject generic Continue', () => {
  const database = createDatabase();
  try {
    const root = insertRoot(database, { rootRequestId: 'stale', rootGeneration: 0, projectionState: 'frozen', eligiblePlanItemIds: ['item-1'] });
    database.prepare('UPDATE daily_plan_scopes SET scope_status=? WHERE workspace_id=? AND stage_request_id=?')
      .run('building', root.workspaceId, root.stageRequestId);
    const stale = readRoots(database)[0];
    assert.equal(stale.projectionState, 'error');
    assert.equal(stale.projectionError.code, 'PROJECTION_MISMATCH');
    assert.deepEqual(stale.eligiblePlanItemIds, []);
    assert.equal(stale.opportunityCount, 0);

    const mismatchRoot = insertRoot(database, { rootRequestId: 'hash-mismatch', rootGeneration: 1, projectionState: 'frozen', eligiblePlanItemIds: ['item-2'] });
    database.prepare('UPDATE workspace_active_root_index SET eligible_ids_hash=? WHERE workspace_id=? AND root_request_id=?')
      .run(HEX('x'), mismatchRoot.workspaceId, mismatchRoot.rootRequestId);
    const mismatched = readRoots(database).find((item) => item.identity.rootRequestId === mismatchRoot.rootRequestId);
    assert.equal(mismatched.projectionState, 'error');
    assert.equal(mismatched.projectionError.code, 'PROJECTION_MISMATCH');
    assert.deepEqual(mismatched.candidatePlanItemIds, []);
    assert.equal(mismatched.opportunityCount, 0);

    const identity = {
      workspaceId: 'workspace-a', rootRequestId: 'root-a', rootGeneration: 0,
      orchestrationId: 'orch-a', managerTaskId: 'manager-a', stageRequestId: 'stage-a',
      scopeHash: HEX('s'), projectionHash: HEX('p'), eligibleIdsHash: HEX('e'),
      checkpointRevision: 3, indexRevision: 4
    };
    const command = buildManagerTypedCommand({
      type: 'approve_candidates', requestId: 'request-a', identity,
      payload: { eligiblePlanItemIds: ['item-1'] }
    });
    assert.equal(command.type, 'approve_candidates');
    assert.equal(command.payload.rootRequestId, identity.rootRequestId);
    assert.equal(command.payload.expectedCheckpointRevision, identity.checkpointRevision);
    assert.throws(() => buildManagerTypedCommand({ type: 'Continue', requestId: 'request-b', identity }), (error) => error.code === 'MANAGER_COMMAND_NOT_ALLOWED');
    assert.throws(() => buildManagerTypedCommand({ type: 'approve_candidates', requestId: 'request-d', identity: { ...identity, checkpointRevision: undefined } }), (error) => error.code === 'MANAGER_COMMAND_IDENTITY_REQUIRED');
  } finally {
    database.close();
  }
});
