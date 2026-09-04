import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { hashV1, WorkspaceOrchestratorActorStore } from '../src/main/workspace-orchestrator-actor.ts';
import { WorkspaceOrchestratorRootStageStore } from '../src/main/workspace-orchestrator-root-stage.ts';
import {
  advanceWorkspaceRollback,
  confirmLegacyRuntimeDrain,
  readWorkspaceRollbackState,
  reconcileWorkspaceOrchestratorStartup,
  recordWorkspaceMigrationStep,
  registerLegacyRuntimeInventory,
  requestWorkspaceRollback
} from '../src/main/workspace-orchestrator-recovery.ts';

const NOW = '2026-08-31T08:00:00.000Z';
const BUILD_ID = 'build-wmb-5371';
const MANIFEST = 'manifest-wmb-5371';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5371-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try { return work(database); } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

function fenceFrom(actor) {
  return {
    workspaceId: actor.workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    checkpointRevision: actor.checkpointRevision
  };
}

function seedBuild(database) {
  database.prepare(`INSERT INTO build_manifests (
    build_id,source_commit,package_hash,app_asar_hash,schema_epoch,cutover_epoch,
    read_schema_min,read_schema_max,write_schema_epoch,manifest_hash,resources_path,created_at
  ) VALUES (?,?,?,?,80,0,80,80,80,?,?,?)`).run(
    BUILD_ID, 'source-wmb-5371', HEX_A, HEX_B, MANIFEST, 'J:/WMB/resources', NOW
  );
}

function makeControl(database, workspaceId, { completeGate = true } = {}) {
  seedBuild(database);
  const actorStore = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => 100 });
  const acquired = actorStore.acquireActor({
    workspaceId, currentBuildId: BUILD_ID, leaseToken: `lease-${workspaceId}`, runtimeId: `runtime-${workspaceId}`,
    nowUtc: NOW, nowMono: 100, leaseExpiresAtMono: 10_000, gateDeadlineMono: 9_000,
    controlStallDeadlineMono: 8_000, migrationEpoch: 1, writeFence: 'allow'
  });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  database.prepare(`INSERT INTO workspace_migration_state (
    workspace_id,migration_epoch,status,manifest_hash,schema_epoch,cutover_epoch,owner_runtime_epoch,
    fence_token_hash,write_fence,checkpoint_seq,before_hash,after_hash,started_at_utc,started_at_mono,
    finished_at_utc,finished_at_mono
  ) VALUES (?,1,'complete',?,80,0,?,?,'allow',0,?,?,?,?,?,?)`).run(
    workspaceId, MANIFEST, acquired.actor.runtimeEpoch, HEX_A, HEX_A, HEX_B, NOW, 1, NOW, 2
  );
  database.prepare(`INSERT INTO producer_registry (
    workspace_id,producer_id,build_id,migration_epoch,source_location,trigger,trigger_id,allowed_intent_kind,
    owner,replacement_route,write_tables,write_principal,authorizer_revision,process_image_path,resources_path,
    registry_entry_hash,enabled,census_hash,created_at
  ) VALUES (?,'producer.today',?,1,'src/main/index.ts','owner','trigger.today','full','today_ui','actor-mailbox',
    'orchestrator_mailbox','wmb_actor_store','auth-v1','J:/WMB/WeMediaBuddy.exe','J:/WMB/resources',?,1,?,?)`).run(
    workspaceId, BUILD_ID, 'registry-wmb-5371', 'census-wmb-5371', NOW
  );
  const gate = actorStore.createStartupReconcileGate({ workspaceId, fence: fenceFrom(actorStore.readActor(workspaceId)), nowUtc: NOW, nowMono: 110 });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  if (completeGate) {
    const completed = actorStore.completeStartupReconcile({ workspaceId, fence: fenceFrom(actorStore.readActor(workspaceId)), nowUtc: NOW, nowMono: 120 });
    assert.equal(completed.ok, true, JSON.stringify(completed));
  }
  return actorStore;
}

function attestation(runtimeEpoch) {
  return {
    producerId: 'producer.today', registryEntryHash: 'registry-wmb-5371', censusHash: 'census-wmb-5371',
    triggerId: 'trigger.today', processId: '5371', processStartTimeUtc: NOW, processStartTimeMono: 1,
    processImagePath: 'J:/WMB/WeMediaBuddy.exe', resourcesPath: 'J:/WMB/resources', buildId: BUILD_ID,
    sourceCommit: 'source-wmb-5371', packageHash: HEX_A, appAsarHash: HEX_B, schemaEpoch: 80,
    cutoverEpoch: 0, runtimeEpoch, writePrincipal: 'wmb_actor_store', authorizerRevision: 'auth-v1'
  };
}

function admitRoot(database, workspaceId) {
  const actorStore = makeControl(database, workspaceId);
  const actor = actorStore.readActor(workspaceId);
  const accepted = actorStore.acceptIntent({
    workspaceId, businessDate: '2026-08-31', source: 'today_ui', rootMode: 'owner', requestedAction: 'full',
    requestId: `request-${workspaceId}`, producerId: 'producer.today', producerAttestation: attestation(actor.runtimeEpoch),
    logicalInput: { topic: 'AI' }, payload: { topic: 'AI' },
    channelPolicy: [{ channelId: 'official', requiredness: 'required', module: 'official_web' }],
    authorizedChannelPolicy: [{ channelId: 'official', requiredness: 'required', module: 'official_web' }],
    profileRevision: 1, priority: 10, fence: fenceFrom(actor), nowUtc: NOW, nowMono: 130
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const closed = actorStore.closePreflight({
    workspaceId, requestId: `request-${workspaceId}`, profileRevision: 1,
    channelResults: [{ channelId: 'official', status: 'ready', capability: { ok: true }, capabilityLeaseId: 'cap-official' }],
    fence: fenceFrom(actorStore.readActor(workspaceId)), nowUtc: NOW, nowMono: 140
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const rootStore = new WorkspaceOrchestratorRootStageStore(database, { nowUtc: () => NOW, nowMono: () => 150 });
  const admitted = rootStore.admitRoot({
    workspaceId, intentId: accepted.intentId, fence: fenceFrom(actorStore.readActor(workspaceId)), nowUtc: NOW, nowMono: 150,
    argvHash: hashV1(['scan']), cwdFingerprint: hashV1('J:/WMB'), sessionKey: `session-${workspaceId}`,
    envelope: { executable: 'node', argv: ['scan'], cwd: 'J:/WMB', source: 'test' }
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  return { actorStore, rootStore, admitted, intentId: accepted.intentId };
}

function registerDispatchInventory(database, actorStore, workspaceId) {
  const dispatch = database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? ORDER BY job_id LIMIT 1').get(workspaceId);
  assert.ok(dispatch);
  assert.equal(dispatch.argv_hash, hashV1(['scan']));
  const result = registerLegacyRuntimeInventory(database, {
    workspaceId, fence: fenceFrom(actorStore.readActor(workspaceId)), resourceKind: 'worker', resourceKey: String(dispatch.job_id),
    rootRequestId: String(dispatch.root_request_id), stageRequestId: String(dispatch.stage_request_id),
    operationRequestId: String(dispatch.operation_request_id), jobId: String(dispatch.job_id), argv: ['scan'],
    sessionKey: String(dispatch.session_key), launchAttemptId: String(dispatch.launch_attempt_id), cwd: 'J:/WMB',
    state: 'running', nowUtc: NOW, nowMono: 160
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return dispatch;
}

function seedSourceSnapshotForHandoff(database, workspaceId, dispatch) {
  const root = database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=?').get(workspaceId);
  const claim = database.prepare('SELECT * FROM daily_stage_claims WHERE workspace_id=? ORDER BY stage_request_id LIMIT 1').get(workspaceId);
  const preflight = database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=?').get(workspaceId);
  const snapshotHash = `snapshot-${workspaceId}`;
  database.prepare(`INSERT INTO source_snapshots (
    snapshot_id,workspace_id,business_date,source_task_id,root_request_id,root_generation,stage_request_id,
    scan_attempt_id,preflight_id,policy_hash,profile_revision,selected_channel_ids_json,successful_channels_json,
    failed_channels_json,unresolved_channels_json,source_ids_json,source_bindings_json,receipt_ids_json,
    receipt_bindings_json,watermark_utc,watermark_mono,captured_at_utc,excluded_by_budget_count,snapshot_hash,status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'frozen')`).run(
    `source-${workspaceId}`, workspaceId, '2026-08-31', String(dispatch.job_id), String(root.root_request_id), Number(root.root_generation),
    String(claim.stage_request_id), String(dispatch.launch_attempt_id), String(preflight.preflight_id), String(preflight.policy_hash), 1,
    '["official"]', '["official"]', '[]', '[]', '[]', '{}', '[]', '{}', NOW, 160, NOW, 0, snapshotHash
  );
  database.prepare("UPDATE daily_stage_claims SET status='awaiting_judge',snapshot_json=? WHERE workspace_id=? AND stage_request_id=?")
    .run(JSON.stringify({ sourceSnapshotHash: snapshotHash, preflightId: preflight.preflight_id }), workspaceId, claim.stage_request_id);
  database.prepare('DELETE FROM workspace_active_root_index WHERE workspace_id=?').run(workspaceId);
  return { root, claim, snapshotHash };
}

test('WMB-5371 A35/A42 migration journal and legacy inventory are durable, replay-safe and terminal late-write fenced', () => withDatabase((database) => {
  const actorStore = makeControl(database, 'ws-ledger');
  const inventoryInput = {
    workspaceId: 'ws-ledger', resourceKind: 'worker', resourceKey: 'worker-1', argv: ['scan'], sessionKey: 'session-1',
    launchAttemptId: 'launch-1', cwd: 'J:/WMB', state: 'running', nowUtc: NOW, nowMono: 200
  };
  const registered = registerLegacyRuntimeInventory(database, { ...inventoryInput, fence: fenceFrom(actorStore.readActor('ws-ledger')) });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const conflict = registerLegacyRuntimeInventory(database, { ...inventoryInput, inventoryId: registered.inventory.inventoryId, cwd: 'J:/other', fence: fenceFrom(actorStore.readActor('ws-ledger')) });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'STATE_CONFLICT');
  const drained = confirmLegacyRuntimeDrain(database, {
    workspaceId: 'ws-ledger', inventoryId: registered.inventory.inventoryId, exitConfirmed: true, closeConfirmed: true,
    cleanupConfirmed: true, closeProofHash: HEX_A, cleanupProofHash: HEX_B,
    fence: fenceFrom(actorStore.readActor('ws-ledger')), nowUtc: NOW, nowMono: 210
  });
  assert.equal(drained.ok, true, JSON.stringify(drained));
  assert.equal(drained.status, 'cleaned');
  const replay = confirmLegacyRuntimeDrain(database, {
    workspaceId: 'ws-ledger', inventoryId: registered.inventory.inventoryId, exitConfirmed: true, closeConfirmed: true,
    cleanupConfirmed: true, closeProofHash: HEX_A, cleanupProofHash: HEX_B,
    fence: fenceFrom(actorStore.readActor('ws-ledger')), nowUtc: NOW, nowMono: 211
  });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);

  const step = { workspaceId: 'ws-ledger', migrationEpoch: 1, stepKey: 'inventory-census', inputHash: HEX_A, beforeHash: HEX_A, afterHash: HEX_B, rowCount: 1, winnerSetHash: HEX_B, nowUtc: NOW, nowMono: 220 };
  const committed = recordWorkspaceMigrationStep(database, { ...step, fence: fenceFrom(actorStore.readActor('ws-ledger')) });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const committedReplay = recordWorkspaceMigrationStep(database, { ...step, fence: fenceFrom(actorStore.readActor('ws-ledger')) });
  assert.equal(committedReplay.ok, true, JSON.stringify(committedReplay));
  assert.equal(committedReplay.replayed, true);
  assert.equal(count(database, 'workspace_migration_journal'), 1);
}));

test('WMB-5371 A06/A23/A27/A48 startup reconcile adopts exact inventory, restores F-to-J handoff and rebuilds the active-root index', () => withDatabase((database) => {
  const fixture = admitRoot(database, 'ws-reconcile');
  const dispatch = registerDispatchInventory(database, fixture.actorStore, 'ws-reconcile');
  const seeded = seedSourceSnapshotForHandoff(database, 'ws-reconcile', dispatch);
  const result = reconcileWorkspaceOrchestratorStartup(database, {
    workspaceId: 'ws-reconcile', fence: fenceFrom(fixture.actorStore.readActor('ws-reconcile')), nowUtc: NOW, nowMono: 300
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'complete');
  assert.equal(database.prepare('SELECT state FROM managed_job_dispatches WHERE job_id=?').get(dispatch.job_id).state, 'running');
  assert.equal(database.prepare('SELECT status,is_active FROM daily_stage_claims WHERE stage_request_id=?').get(seeded.claim.stage_request_id).status, 'succeeded');
  assert.equal(count(database, 'daily_stage_claims', "workspace_id=? AND attempt_stage='judge'", ['ws-reconcile']), 1);
  assert.equal(count(database, 'managed_job_dispatches', "workspace_id=? AND role_id='judge'", ['ws-reconcile']), 1);
  assert.equal(count(database, 'workspace_active_root_index', 'workspace_id=?', ['ws-reconcile']), 1);
  assert.equal(count(database, 'orchestrator_events', "workspace_id=? AND event_type='stage.handoff_f_to_j'", ['ws-reconcile']), 1);
}));

test('WMB-5371 startup reconcile cancels an expired root instead of preserving a permanent serial lock', () => withDatabase((database) => {
  const fixture = admitRoot(database, 'ws-expired-root');
  const rootRequestId = fixture.admitted.root.root_request_id;
  database.prepare('UPDATE daily_orchestration_roots SET root_deadline_mono=149, root_deadline_utc=? WHERE workspace_id=? AND root_request_id=?')
    .run(NOW, 'ws-expired-root', rootRequestId);
  const result = reconcileWorkspaceOrchestratorStartup(database, {
    workspaceId: 'ws-expired-root',
    fence: fenceFrom(fixture.actorStore.readActor('ws-expired-root')),
    nowUtc: NOW,
    nowMono: 170
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(database.prepare('SELECT status FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?').get('ws-expired-root', rootRequestId).status, 'cancelled');
  assert.equal(database.prepare('SELECT status FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=?').get('ws-expired-root', rootRequestId).status, 'orphaned');
  assert.equal(count(database, 'workspace_active_root_index', 'workspace_id=? AND is_active=1', ['ws-expired-root']), 0);
}));

test('WMB-5371 A21/A22 cancellation ancestry terminalizes root, claim, dispatch and dependent consumption before adoption', () => withDatabase((database) => {
  const fixture = admitRoot(database, 'ws-cancel');
  const dispatch = database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=?').get('ws-cancel');
  const claim = database.prepare('SELECT * FROM daily_stage_claims WHERE workspace_id=?').get('ws-cancel');
  const root = database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=?').get('ws-cancel');
  database.prepare(`INSERT INTO managed_effect_consumptions (
    consumption_id,workspace_id,operation_request_id,effect_request_id,effect_logical_key,effect_set_hash,effect_token,payload_hash,
    manager_task_id,orchestration_id,root_request_id,root_generation,stage_request_id,source_dispatch_job_id,source_result_hash,
    role_id,sink_name,sink_role_id,sink_contract_version,delivery_mode,sink_capability_proof_hash,state,consumption_revision,
    expected_stage_claim_revision,owner_epoch,lease_token,lease_expires_at_utc,lease_expires_at_mono,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',0,?,?,?,?,?,?,?)`).run(
    'consumption-cancel', 'ws-cancel', 'operation-effect', 'effect-1', 'logical-1', HEX_A, 'token-1', HEX_B,
    root.manager_task_id, root.orchestration_id, root.root_request_id, root.root_generation, claim.stage_request_id, dispatch.job_id, HEX_A,
    'reporter', 'sink', 'sink-role', 'v1', 'exactly_once', HEX_B, claim.claim_revision, root.owner_epoch, root.lease_token,
    root.lease_expires_at_utc, root.lease_expires_at_mono, NOW, NOW
  );
  database.prepare("UPDATE orchestrator_intents SET status='cancelled',finished_at=? WHERE workspace_id=? AND intent_id=?").run(NOW, 'ws-cancel', fixture.intentId);
  const result = reconcileWorkspaceOrchestratorStartup(database, {
    workspaceId: 'ws-cancel', fence: fenceFrom(fixture.actorStore.readActor('ws-cancel')), nowUtc: NOW, nowMono: 320
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(database.prepare('SELECT status FROM daily_orchestration_roots WHERE workspace_id=?').get('ws-cancel').status, 'cancelled');
  assert.equal(database.prepare('SELECT status FROM daily_stage_claims WHERE workspace_id=?').get('ws-cancel').status, 'orphaned');
  assert.equal(database.prepare('SELECT state FROM managed_job_dispatches WHERE workspace_id=?').get('ws-cancel').state, 'orphaned');
  assert.equal(database.prepare('SELECT state FROM managed_effect_consumptions WHERE workspace_id=?').get('ws-cancel').state, 'orphaned');
}));

test('WMB-5371 A53/A54 rollback denies writes before drain and enters maintenance when inventory is still live', () => withDatabase((database) => {
  const actorStore = makeControl(database, 'ws-rollback');
  const inventory = registerLegacyRuntimeInventory(database, {
    workspaceId: 'ws-rollback', fence: fenceFrom(actorStore.readActor('ws-rollback')), resourceKind: 'worker', resourceKey: 'worker-rb',
    argv: ['scan'], sessionKey: 'session-rb', launchAttemptId: 'launch-rb', cwd: 'J:/WMB', state: 'running', nowUtc: NOW, nowMono: 400
  });
  assert.equal(inventory.ok, true, JSON.stringify(inventory));
  const requested = requestWorkspaceRollback(database, {
    workspaceId: 'ws-rollback', fence: fenceFrom(actorStore.readActor('ws-rollback')), targetBuildManifestHash: MANIFEST,
    targetSchemaEpoch: 80, targetMinSupportedBuild: BUILD_ID, targetCutoverEpoch: 0, nowUtc: NOW, nowMono: 410
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(actorStore.readActor('ws-rollback').writeFence, 'deny');
  const fencing = advanceWorkspaceRollback(database, { workspaceId: 'ws-rollback', rollbackEpoch: requested.rollback.rollbackEpoch, status: 'fencing', fence: fenceFrom(actorStore.readActor('ws-rollback')), nowUtc: NOW, nowMono: 420 });
  assert.equal(fencing.status, 'fencing', JSON.stringify(fencing));
  const draining = advanceWorkspaceRollback(database, { workspaceId: 'ws-rollback', rollbackEpoch: requested.rollback.rollbackEpoch, status: 'draining', fence: fenceFrom(actorStore.readActor('ws-rollback')), nowUtc: NOW, nowMono: 430 });
  assert.equal(draining.status, 'draining', JSON.stringify(draining));
  assert.equal(database.prepare('SELECT state FROM workspace_legacy_runtime_inventory WHERE workspace_id=?').get('ws-rollback').state, 'draining');
  const verifying = advanceWorkspaceRollback(database, { workspaceId: 'ws-rollback', rollbackEpoch: requested.rollback.rollbackEpoch, status: 'verifying', fence: fenceFrom(actorStore.readActor('ws-rollback')), nowUtc: NOW, nowMono: 440 });
  assert.equal(verifying.status, 'maintenance', JSON.stringify(verifying));
  assert.equal(verifying.reasonCode, 'ROLLBACK_INVENTORY_NOT_DRAINED');
  assert.equal(actorStore.readActor('ws-rollback').writeFence, 'maintenance');
  assert.equal(readWorkspaceRollbackState(database, { workspaceId: 'ws-rollback', rollbackEpoch: requested.rollback.rollbackEpoch }).status, 'maintenance');
}));
