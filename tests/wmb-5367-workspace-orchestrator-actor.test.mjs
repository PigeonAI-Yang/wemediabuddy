import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { WorkspaceOrchestratorActorStore } from '../src/main/workspace-orchestrator-actor.ts';

const NOW = '2026-08-30T10:00:00.000Z';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const BUILD_ID = 'build-wmb-5367';

function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5367-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try { return work(database); } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

function seedBuild(database) {
  database.prepare(`INSERT INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, 79, 0, 79, 79, 79, ?, ?, ?)`)
    .run(BUILD_ID, 'source-wmb-5367', HEX_A, HEX_B, 'manifest-wmb-5367', 'J:/WMB/resources', NOW);
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

function seedProducer(database, workspaceId, actor) {
  database.prepare(`INSERT INTO workspace_migration_state (
    workspace_id, migration_epoch, status, manifest_hash, schema_epoch, cutover_epoch,
    owner_runtime_epoch, fence_token_hash, write_fence, checkpoint_seq, before_hash,
    after_hash, started_at_utc, started_at_mono, finished_at_utc, finished_at_mono
  ) VALUES (?, 1, 'complete', ?, 79, 0, ?, ?, 'allow', 0, ?, ?, ?, 1, ?, 2)`)
    .run(workspaceId, 'manifest-wmb-5367', actor.runtimeEpoch, HEX_A, HEX_A, HEX_B, NOW, NOW);
  database.prepare(`INSERT INTO producer_registry (
    workspace_id, producer_id, build_id, migration_epoch, source_location, trigger,
    trigger_id, allowed_intent_kind, owner, replacement_route, write_tables,
    write_principal, authorizer_revision, process_image_path, resources_path,
    registry_entry_hash, enabled, census_hash, created_at
  ) VALUES (?, 'producer.today', ?, 1, 'src/main/index.ts', 'owner', 'trigger.today',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_actor_store',
    'auth-v1', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`)
    .run(workspaceId, BUILD_ID, 'registry-wmb-5367', 'census-wmb-5367', NOW);
}

function attestation(runtimeEpoch) {
  return {
    producerId: 'producer.today',
    registryEntryHash: 'registry-wmb-5367',
    censusHash: 'census-wmb-5367',
    triggerId: 'trigger.today',
    processId: '5367',
    processStartTimeUtc: NOW,
    processStartTimeMono: 1,
    processImagePath: 'J:/WMB/WeMediaBuddy.exe',
    resourcesPath: 'J:/WMB/resources',
    buildId: BUILD_ID,
    sourceCommit: 'source-wmb-5367',
    packageHash: HEX_A,
    appAsarHash: HEX_B,
    schemaEpoch: 79,
    cutoverEpoch: 0,
    runtimeEpoch,
    writePrincipal: 'wmb_actor_store',
    authorizerRevision: 'auth-v1'
  };
}

function acquire(database, workspaceId, nowMono = 100, leaseToken = `lease-${workspaceId}`) {
  const store = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => nowMono });
  const result = store.acquireActor({
    workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken,
    runtimeId: `runtime-${workspaceId}`,
    nowUtc: NOW,
    nowMono,
    leaseExpiresAtMono: nowMono + 1_000,
    gateDeadlineMono: nowMono + 900,
    controlStallDeadlineMono: nowMono + 800,
    migrationEpoch: 1,
    writeFence: 'allow'
  });
  assert.equal(result.ok, true);
  return { store, result };
}

function completeGate(database, workspaceId) {
  seedBuild(database);
  const { store, result } = acquire(database, workspaceId);
  seedProducer(database, workspaceId, result.actor);
  const created = store.createStartupReconcileGate({ workspaceId, fence: result.fence, nowUtc: NOW, nowMono: 110 });
  assert.equal(created.ok, true);
  assert.equal(created.gate.status, 'pending');
  const completed = store.completeStartupReconcile({ workspaceId, fence: result.fence, nowUtc: NOW, nowMono: 120 });
  assert.equal(completed.ok, true);
  assert.equal(completed.gate.status, 'complete');
  return { store, actor: store.readActor(workspaceId) };
}

function intentInput(workspaceId, runtimeEpoch, requestId, payload = { topic: 'AI' }) {
  return {
    workspaceId,
    businessDate: '2026-08-30',
    source: 'today_ui',
    rootMode: 'owner',
    requestedAction: 'full',
    requestId,
    producerId: 'producer.today',
    producerAttestation: attestation(runtimeEpoch),
    logicalInput: payload,
    payload,
    channelPolicy: [
      { channelId: 'official', requiredness: 'required', module: 'official_web' },
      { channelId: 'x-list', requiredness: 'optional', module: 'x_list' }
    ],
    authorizedChannelPolicy: [
      { channelId: 'official', requiredness: 'required', module: 'official_web' },
      { channelId: 'x-list', requiredness: 'optional', module: 'x_list' }
    ],
    profileRevision: 7,
    priority: 10,
    nowUtc: NOW,
    nowMono: 130
  };
}

test('WMB-5367 sole authority is busy while live and takeover rotates every epoch after monotonic stall', () => withDatabase((database) => {
  seedBuild(database);
  const first = acquire(database, 'ws-authority');
  assert.equal(first.result.status, 'acquired');
  const busy = first.store.acquireActor({
    workspaceId: 'ws-authority', currentBuildId: BUILD_ID, leaseToken: 'lease-second',
    nowUtc: NOW, nowMono: 500, leaseExpiresAtMono: 1_500, gateDeadlineMono: 1_400,
    controlStallDeadlineMono: 1_300
  });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'AUTHORITY_BUSY');
  assert.equal(count(database, 'workspace_orchestrator_actors'), 1);

  const takeover = first.store.acquireActor({
    workspaceId: 'ws-authority', currentBuildId: BUILD_ID, leaseToken: 'lease-takeover',
    nowUtc: NOW, nowMono: 901, leaseExpiresAtMono: 1_901, gateDeadlineMono: 1_801,
    controlStallDeadlineMono: 1_701
  });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.status, 'taken_over');
  assert.equal(takeover.actor.runtimeEpoch, 2);
  assert.equal(takeover.actor.ownerEpoch, 2);
  assert.equal(takeover.actor.authorityRevision, 2);
  assert.equal(takeover.gate.status, 'pending');
  assert.equal(count(database, 'workspace_orchestrator_actors'), 1);
  assert.equal(count(database, 'daily_reconcile_gates'), 1);
}));

test('WMB-5367 startup gate blocks T1, then accepted intent replays canonically and conflicting payload is zero-write', () => withDatabase((database) => {
  seedBuild(database);
  const { store, result } = acquire(database, 'ws-replay');
  seedProducer(database, 'ws-replay', result.actor);
  store.createStartupReconcileGate({ workspaceId: 'ws-replay', fence: result.fence, nowUtc: NOW, nowMono: 110 });

  const blocked = store.acceptIntent(intentInput('ws-replay', result.actor.runtimeEpoch, 'request-gate'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'STARTUP_RECONCILE_REQUIRED', JSON.stringify(blocked));
  assert.equal(count(database, 'orchestrator_intents'), 0);
  assert.equal(count(database, 'orchestrator_mailbox'), 0);

  const gate = store.completeStartupReconcile({ workspaceId: 'ws-replay', fence: result.fence, nowUtc: NOW, nowMono: 120 });
  assert.equal(gate.ok, true);
  const accepted = store.acceptIntent(intentInput('ws-replay', result.actor.runtimeEpoch, 'request-replay'));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 'accepted');
  assert.equal(count(database, 'orchestrator_intents'), 1);
  assert.equal(count(database, 'orchestrator_mailbox'), 1);
  assert.ok(count(database, 'identity_hash_registry') >= 5);

  const before = {
    intents: count(database, 'orchestrator_intents'),
    mailbox: count(database, 'orchestrator_mailbox'),
    events: count(database, 'orchestrator_events'),
    outbox: count(database, 'orchestrator_outbox')
  };
  const replay = store.acceptIntent(intentInput('ws-replay', result.actor.runtimeEpoch, 'request-replay'));
  assert.equal(replay.ok, true);
  assert.equal(replay.receiptId, accepted.receiptId);
  assert.deepEqual({
    intents: count(database, 'orchestrator_intents'),
    mailbox: count(database, 'orchestrator_mailbox'),
    events: count(database, 'orchestrator_events'),
    outbox: count(database, 'orchestrator_outbox')
  }, before);

  const conflict = store.acceptIntent(intentInput('ws-replay', result.actor.runtimeEpoch, 'request-replay', { topic: 'different' }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'REQUEST_REPLAY_CONFLICT');
  assert.equal(conflict.readback.businessWrites, 0);
  assert.deepEqual({
    intents: count(database, 'orchestrator_intents'),
    mailbox: count(database, 'orchestrator_mailbox'),
    events: count(database, 'orchestrator_events'),
    outbox: count(database, 'orchestrator_outbox')
  }, before);
}));

test('WMB-5367 required preflight failure is needs_user with durable snapshot and explicitly zero root/claim/job', () => withDatabase((database) => {
  const { store, actor } = completeGate(database, 'ws-required');
  const accepted = store.acceptIntent(intentInput('ws-required', actor.runtimeEpoch, 'request-required'));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const closed = store.closePreflight({
    workspaceId: 'ws-required', requestId: 'request-required', nowUtc: NOW, nowMono: 140,
    channelResults: [
      { channelId: 'official', status: 'login_required', reasonCode: 'CHANNEL_LOGIN_REQUIRED' },
      { channelId: 'x-list', status: 'ready', capability: { ok: true } }
    ]
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, 'needs_user');
  assert.equal(closed.code, 'CHANNEL_CONFIGURATION_REQUIRED');
  assert.equal(closed.snapshot.status, 'needs_user');
  assert.equal(closed.snapshot.requiredFailures.length, 1);
  assert.equal(closed.nextAction.kind, 'repair_required_channel');
  assert.equal(count(database, 'daily_orchestration_roots'), 0);
  assert.equal(count(database, 'daily_stage_claims'), 0);
  assert.equal(count(database, 'managed_job_dispatches'), 0);
  assert.equal(database.prepare("SELECT status FROM orchestrator_intents WHERE request_id='request-required'").get().status, 'needs_user');
}));

test('WMB-5367 optional failure is excluded with coverage gap while all required ready only admits pre-root', () => withDatabase((database) => {
  const { store, actor } = completeGate(database, 'ws-optional');
  const accepted = store.acceptIntent(intentInput('ws-optional', actor.runtimeEpoch, 'request-optional'));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const closed = store.closePreflight({
    workspaceId: 'ws-optional', requestId: 'request-optional', nowUtc: NOW, nowMono: 140,
    channelResults: [
      { channelId: 'official', status: 'ready', capability: { ok: true }, capabilityLeaseId: 'cap-official' },
      { channelId: 'x-list', status: 'login_required', reasonCode: 'CHANNEL_LOGIN_REQUIRED' }
    ]
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, 'admitted');
  assert.deepEqual(closed.snapshot.readyChannelIds, ['official']);
  assert.deepEqual(closed.snapshot.excludedOptionalChannelIds, ['x-list']);
  assert.equal(closed.coverageGap.length, 1);
  assert.equal(count(database, 'daily_orchestration_roots'), 0);
  assert.equal(count(database, 'daily_stage_claims'), 0);
  assert.equal(count(database, 'managed_job_dispatches'), 0);
}));

test('WMB-5367 unknown producer and mailbox depth 256 fail closed without business writes', () => withDatabase((database) => {
  const { store, actor } = completeGate(database, 'ws-backpressure');
  const unknown = intentInput('ws-backpressure', actor.runtimeEpoch, 'request-unknown');
  unknown.producerAttestation = { ...unknown.producerAttestation, producerId: 'unknown.producer' };
  const rejected = store.acceptIntent(unknown);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CUTOVER_REQUIRED', JSON.stringify(rejected));
  assert.equal(count(database, 'orchestrator_intents'), 0);

  const invalidPolicy = intentInput('ws-backpressure', actor.runtimeEpoch, 'request-policy-invalid');
  invalidPolicy.channelPolicy = [
    { channelId: 'official', requiredness: 'optional', module: 'official_web' },
    { channelId: 'x-list', requiredness: 'optional', module: 'x_list' }
  ];
  const policyRejected = store.acceptIntent(invalidPolicy);
  assert.equal(policyRejected.ok, false);
  assert.equal(policyRejected.code, 'CHANNEL_POLICY_INVALID', JSON.stringify(policyRejected));
  assert.equal(count(database, 'orchestrator_intents'), 0);
  assert.equal(count(database, 'command_receipts'), 2);

  for (let sequence = 1; sequence <= 256; sequence += 1) {
    const intentId = `seed-intent-${sequence}`;
    database.prepare(`INSERT INTO orchestrator_intents (
      intent_id, workspace_id, business_date, source, root_mode, requested_action,
      request_id, command_replay_key, invocation_id, invocation_ordinal, causation_id,
      logical_input_hash, normalized_policy_hash, channel_policy_json, checkpoint_revision,
      status, created_at, updated_at
    ) VALUES (?, 'ws-backpressure', '2026-08-30', 'scheduler_0900', 'scheduler', 'full',
      ?, ?, ?, ?, ?, ?, ?, '[]', 0, 'preflight_pending', ?, ?)`)
      .run(intentId, `seed-request-${sequence}`, `seed-replay-${sequence}`, `seed-invocation-${sequence}`,
        sequence, `seed-causation-${sequence}`, `seed-logical-${sequence}`, `seed-policy-${sequence}`, NOW, NOW);
    database.prepare(`INSERT INTO orchestrator_mailbox (
      workspace_id, mailbox_sequence, command_replay_key, request_id, intent_id, producer,
      priority, enqueued_at_utc, enqueued_at_mono, expires_at_utc, expires_at_mono,
      coalescing_mode, causation_id, logical_input_hash, normalized_policy_hash, payload_hash, state
    ) VALUES ('ws-backpressure', ?, ?, ?, ?, 'scheduler.seed', 0, ?, ?, ?, ?, 'none', ?, ?, ?, ?, 'enqueued')`)
      .run(sequence, `seed-replay-${sequence}`, `seed-request-${sequence}`, intentId, NOW, sequence,
        NOW, sequence + 10_000, `seed-causation-${sequence}`, `seed-logical-${sequence}`,
        `seed-policy-${sequence}`, `seed-payload-${sequence}`);
  }
  const before = { intents: count(database, 'orchestrator_intents'), mailbox: count(database, 'orchestrator_mailbox') };
  const pressure = store.acceptIntent(intentInput('ws-backpressure', actor.runtimeEpoch, 'request-pressure'));
  assert.equal(pressure.ok, false);
  assert.equal(pressure.code, 'MAILBOX_BACKPRESSURE');
  assert.deepEqual({ intents: count(database, 'orchestrator_intents'), mailbox: count(database, 'orchestrator_mailbox') }, before);
}));
