import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  finishAcceptanceRun,
  readAcceptanceRun,
  startAcceptanceRun
} from '../src/main/workspace-orchestrator-acceptance.ts';
import {
  WorkspaceOrchestratorActorStore,
  hashV1,
  readWorkspaceOrchestratorActor
} from '../src/main/workspace-orchestrator-actor.ts';
import { WorkspaceOrchestratorRootStageStore } from '../src/main/workspace-orchestrator-root-stage.ts';
import { createWorkspaceOrchestratorSnapshotStore } from '../src/main/workspace-orchestrator-snapshots.ts';
import {
  recordWorkspaceMigrationStep,
  reconcileWorkspaceOrchestratorStartup
} from '../src/main/workspace-orchestrator-recovery.ts';

const NOW = '2026-08-31T08:00:00.000Z';
const BUILD_ID = 'build-wmb-5373';
const SOURCE_COMMIT = 'source-wmb-5373';
const MANIFEST_HASH = 'd'.repeat(64);
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const ACCEPTANCE_COLUMNS = [
  'acceptance_run_id',
  'baseline_event_sequence',
  'baseline_checkpoint_revision',
  'created_after_event_sequence',
  'created_after_checkpoint_revision',
  'created_after_mono'
];
const PROVENANCE_TABLES = [
  'workspace_orchestrator_actors',
  'orchestrator_mailbox',
  'command_receipts',
  'orchestrator_intents',
  'channel_preflight_snapshots',
  'daily_orchestration_roots',
  'daily_stage_claims',
  'source_snapshots',
  'daily_repair_snapshot_bindings',
  'daily_plan_scopes',
  'managed_job_dispatches',
  'managed_effect_consumptions',
  'orchestrator_events',
  'orchestrator_outbox',
  'orchestrator_inbox',
  'workspace_active_root_index'
];

function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5373-adversarial-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    return work(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columns(database, table) {
  if (!tableExists(database, table)) return [];
  return database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name));
}

function seedBuild(database) {
  database.prepare(`INSERT INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, 79, 0, 79, 81, 79, ?, ?, ?)`)
    .run(BUILD_ID, SOURCE_COMMIT, HEX_A, HEX_B, MANIFEST_HASH, 'J:/WMB/resources', NOW);
}

function seedProducer(database, workspaceId, actor, options = {}) {
  const migrationStatus = options.migrationStatus ?? 'complete';
  const migrationWriteFence = options.migrationWriteFence ?? 'allow';
  const terminalMigration = ['complete', 'failed', 'maintenance'].includes(migrationStatus);
  database.prepare(`INSERT INTO workspace_migration_state (
    workspace_id, migration_epoch, status, manifest_hash, schema_epoch, cutover_epoch,
    owner_runtime_epoch, fence_token_hash, write_fence, checkpoint_seq, before_hash,
    after_hash, started_at_utc, started_at_mono, finished_at_utc, finished_at_mono
  ) VALUES (?, 1, ?, ?, 80, 0, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`)
    .run(workspaceId, migrationStatus, MANIFEST_HASH, actor.runtimeEpoch, HEX_A, migrationWriteFence, HEX_A, HEX_B, NOW, terminalMigration ? NOW : null, terminalMigration ? 2 : null);
  database.prepare(`INSERT INTO producer_registry (
    workspace_id, producer_id, build_id, migration_epoch, source_location, trigger,
    trigger_id, allowed_intent_kind, owner, replacement_route, write_tables,
    write_principal, authorizer_revision, process_image_path, resources_path,
    registry_entry_hash, enabled, census_hash, created_at
  ) VALUES (?, 'producer.acceptance', ?, 1, 'tests/wmb-5373-adversarial-a35-a40.test.mjs', 'owner', 'trigger.acceptance',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_acceptance_test',
    'auth-wmb-5373', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`)
    .run(workspaceId, BUILD_ID, 'registry-wmb-5373', 'census-wmb-5373', NOW);
}

function attestation(runtimeEpoch, overrides = {}) {
  return {
    producerId: 'producer.acceptance',
    registryEntryHash: 'registry-wmb-5373',
    censusHash: 'census-wmb-5373',
    triggerId: 'trigger.acceptance',
    processId: '5373',
    processStartTimeUtc: NOW,
    processStartTimeMono: 1,
    processImagePath: 'J:/WMB/WeMediaBuddy.exe',
    resourcesPath: 'J:/WMB/resources',
    buildId: BUILD_ID,
    sourceCommit: SOURCE_COMMIT,
    packageHash: HEX_A,
    appAsarHash: HEX_B,
    schemaEpoch: 79,
    cutoverEpoch: 0,
    runtimeEpoch,
    writePrincipal: 'wmb_acceptance_test',
    authorizerRevision: 'auth-wmb-5373',
    ...overrides
  };
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

function beginScenario(database, scenarioId, options = {}) {
  const workspaceId = options.workspaceId ?? `wmb-5373-${scenarioId.toLowerCase()}`;
  const source = options.source ?? 'today_ui';
  const rootMode = options.rootMode ?? 'owner';
  const requestId = options.requestId ?? `request-${scenarioId.toLowerCase()}`;
  seedBuild(database);
  const actorStore = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => 100 });
  const acquired = actorStore.acquireActor({
    workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken: `lease-${scenarioId}`,
    runtimeId: `runtime-${scenarioId}`,
    nowUtc: NOW,
    nowMono: 100,
    leaseExpiresAtMono: options.leaseExpiresAtMono ?? 100_000,
    gateDeadlineMono: options.gateDeadlineMono ?? 90_000,
    controlStallDeadlineMono: options.controlStallDeadlineMono ?? 80_000,
    migrationEpoch: 1,
    writeFence: 'allow'
  });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  seedProducer(database, workspaceId, acquired.actor, { migrationStatus: options.migrationStatus, migrationWriteFence: options.migrationWriteFence });
  const created = actorStore.createStartupReconcileGate({ workspaceId, fence: acquired.fence, nowUtc: NOW, nowMono: 110 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const completed = actorStore.completeStartupReconcile({ workspaceId, fence: acquired.fence, nowUtc: NOW, nowMono: 120 });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const actor = actorStore.readActor(workspaceId);
  assert.ok(actor);
  const started = startAcceptanceRun(database, {
    workspaceId,
    scenarioId,
    acceptanceRunId: `acceptance-run-wmb-5373-${scenarioId}`,
    acceptanceNamespace: `acceptance/wmb-5373/${scenarioId}`,
    scenarioInput: { scenarioId, workspaceId, source, rootMode, requestId },
    buildId: BUILD_ID,
    manifestHash: MANIFEST_HASH,
    startedAtUtc: NOW,
    startedAtMono: 200,
    freshAfterMono: 200
  }, { nowUtc: () => NOW, nowMono: () => 200, defaultEvidenceRoot: 'acceptance-evidence/wmb-5373' });
  assert.equal(started.ok, true, JSON.stringify(started));
  return {
    database,
    workspaceId,
    scenarioId,
    source,
    rootMode,
    requestId,
    actorStore,
    rootStore: new WorkspaceOrchestratorRootStageStore(database, { nowUtc: () => NOW, nowMono: () => 200 }),
    snapshotStore: createWorkspaceOrchestratorSnapshotStore(database, { nowUtc: () => NOW, nowMono: () => 200 }),
    context: started.context,
    run: started.run,
    nowMono: 210
  };
}

function tick(fixture, delta = 10) {
  fixture.nowMono += delta;
  return fixture.nowMono;
}

function actor(fixture) {
  const value = readWorkspaceOrchestratorActor(fixture.database, fixture.workspaceId);
  assert.ok(value);
  return value;
}

function withAcceptance(fixture, input) {
  return fixture.context.withAcceptance(input);
}

function policyOfficial(requiredness = 'required') {
  return [{ channelId: 'official', requiredness, module: 'official_web' }];
}

function policyWithOptional() {
  return [...policyOfficial(), { channelId: 'x-list', requiredness: 'optional', module: 'x_list' }];
}

function readyChannel(channelId = 'official', requiredness = 'required') {
  return {
    channelId,
    status: 'ready',
    requiredness,
    capability: { ok: true, channelId },
    configRevision: 1,
    authRevision: 1,
    capabilityRevision: 1,
    capabilityLeaseId: `cap-${channelId}`,
    checkedAtUtc: NOW,
    expiresAtUtc: NOW,
    expiresAtMono: 90_000,
    probeRequestId: `probe-${channelId}`,
    probeReceiptHash: HEX_A
  };
}

function intentInput(fixture, overrides = {}) {
  const current = actor(fixture);
  const payload = overrides.payload ?? { topic: 'AI infrastructure', scenarioId: fixture.scenarioId, requestId: overrides.requestId ?? fixture.requestId };
  const channelPolicy = overrides.channelPolicy ?? policyWithOptional();
  return withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    businessDate: overrides.businessDate ?? '2026-08-31',
    source: overrides.source ?? fixture.source,
    rootMode: overrides.rootMode ?? fixture.rootMode,
    requestedAction: overrides.requestedAction ?? 'full',
    requestId: overrides.requestId ?? fixture.requestId,
    producerId: overrides.producerId ?? 'producer.acceptance',
    producerAttestation: overrides.producerAttestation ?? attestation(current.runtimeEpoch),
    logicalInput: payload,
    payload,
    channelPolicy,
    authorizedChannelPolicy: overrides.authorizedChannelPolicy ?? channelPolicy,
    profileRevision: overrides.profileRevision ?? 7,
    priority: overrides.priority ?? 10,
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    fence: fenceFrom(current),
    ...overrides
  });
}

function acceptIntent(fixture, overrides = {}) {
  const result = fixture.actorStore.acceptIntent(intentInput(fixture, overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function closePreflight(fixture, accepted, channelResults = [readyChannel('official'), readyChannel('x-list', 'optional')], overrides = {}) {
  const result = fixture.actorStore.closePreflight(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    intentId: accepted.intentId,
    requestId: accepted.requestId,
    profileRevision: overrides.profileRevision ?? 7,
    channelResults,
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    fence: fenceFrom(actor(fixture)),
    ...overrides
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function admitRoot(fixture, accepted, overrides = {}) {
  const result = fixture.rootStore.admitRoot(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    intentId: accepted.intentId,
    requestId: accepted.requestId,
    fence: fenceFrom(actor(fixture)),
    envelope: { executable: 'node', argv: ['orchestrator-worker'], cwd: 'J:/WMB', scenarioId: fixture.scenarioId },
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    ...overrides
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function sourceInput(fixture, rootBundle, preflight, overrides = {}) {
  const root = rootBundle.root;
  const stage = rootBundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge') ?? rootBundle.claims[0];
  const receiptNamespace = String(root.root_request_id).slice(0, 12);
  const selectedChannelIds = overrides.selectedChannelIds ?? JSON.parse(String(preflight.selected_channels_json)).map((entry) => String(entry.channelId ?? entry.channel_id ?? entry));
  const preflightResults = JSON.parse(String(preflight.results_json ?? '[]'));
  const currentChannelFences = overrides.currentChannelFences ?? selectedChannelIds.map((channelId) => {
    const result = preflightResults.find((entry) => String(entry.channelId ?? entry.channel_id) === channelId) ?? readyChannel(channelId, channelId === 'official' ? 'required' : 'optional');
    return {
      ...result,
      channelId,
      profileRevision: Number(preflight.profile_revision),
      policyHash: String(preflight.policy_hash),
      ready: true,
      revoked: false,
      authStatus: 'ready',
      configStatus: 'ready'
    };
  });
  const currentFenceEntries = Array.isArray(currentChannelFences)
    ? currentChannelFences
    : Object.entries(currentChannelFences).map(([channelId, value]) => ({ ...value, channelId: value.channelId ?? channelId }));
  const currentFenceByChannel = new Map(currentFenceEntries.map((entry) => [String(entry.channelId), entry]));
  const successfulChannels = overrides.successfulChannels ?? selectedChannelIds.map((channelId) => ({
    ...currentFenceByChannel.get(channelId),
    channelId,
    requiredness: channelId === 'official' ? 'required' : 'optional',
    receiptId: `receipt-${fixture.scenarioId}-${receiptNamespace}-${channelId}`,
    receiptRevision: 1,
    receiptPayloadHash: HEX_A,
    resultHash: HEX_B
  }));
  const sourceBindings = overrides.sourceBindings ?? [{ sourceId: `source-${fixture.scenarioId}-1`, sourceRevision: 1, sourceContentHash: HEX_C }];
  return withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    scanAttemptId: String(stage.stage_request_id),
    preflightId: String(preflight.preflight_id),
    policyHash: String(preflight.policy_hash),
    profileRevision: Number(preflight.profile_revision),
    selectedChannelIds,
    successfulChannels,
    currentChannelFences,
    failedChannels: overrides.failedChannels ?? [],
    unresolvedChannels: overrides.unresolvedChannels ?? [],
    sourceBindings,
    sourceIds: sourceBindings.map((entry) => entry.sourceId),
    receiptIds: successfulChannels.map((entry) => entry.receiptId),
    receiptBindings: overrides.receiptBindings ?? successfulChannels.map((entry) => ({
      receiptId: entry.receiptId,
      receiptRevision: entry.receiptRevision,
      receiptPayloadHash: entry.receiptPayloadHash
    })),
    watermarkUtc: NOW,
    watermarkMono: overrides.watermarkMono ?? tick(fixture),
    capturedAtUtc: NOW,
    fence: fenceFrom(actor(fixture)),
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? fixture.nowMono,
    ...overrides.extra
  });
}

function prepareRootWithSource(fixture, options = {}) {
  const accepted = acceptIntent(fixture, options.intent ?? {});
  const closed = closePreflight(fixture, accepted, options.channelResults ?? [readyChannel('official'), readyChannel('x-list', 'optional')]);
  const admitted = admitRoot(fixture, accepted, options.root ?? {});
  const rootRequestId = String(admitted.root.root_request_id);
  const bundleBefore = fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId);
  const preflight = fixture.database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(fixture.workspaceId, closed.preflightId);
  assert.ok(preflight);
  const frozen = fixture.snapshotStore.freezeSourceSnapshot(sourceInput(fixture, bundleBefore, preflight, options.source ?? {}));
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  return { accepted, closed, admitted, rootRequestId, frozen, bundle: fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId) };
}

function handoff(fixture, prepared, overrides = {}) {
  const bundle = fixture.rootStore.readRoot(fixture.workspaceId, prepared.rootRequestId);
  assert.ok(bundle.root);
  const parent = bundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge');
  assert.ok(parent);
  const input = withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: prepared.rootRequestId,
    rootGeneration: Number(bundle.root.root_generation),
    rootInputHash: String(bundle.root.root_input_hash),
    stageRequestId: String(parent.stage_request_id),
    sourceSnapshotHash: String(prepared.frozen.value?.snapshotHash ?? prepared.frozen.snapshotHash),
    expectedRootCheckpointRevision: Number(bundle.root.checkpoint_revision),
    expectedClaimRevision: Number(parent.claim_revision),
    fence: fenceFrom(actor(fixture)),
    currentChannelFences: overrides.currentChannelFences ?? prepared.frozen.value?.successfulChannels ?? [],
    envelope: { executable: 'node', argv: ['judge'], cwd: 'J:/WMB', scenarioId: fixture.scenarioId },
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    ...overrides
  });
  return fixture.rootStore.handoffToJudge(input);
}

function cancel(fixture, prepared, overrides = {}) {
  const bundle = fixture.rootStore.readRoot(fixture.workspaceId, prepared.rootRequestId);
  assert.ok(bundle.root);
  return fixture.rootStore.cancelRoot(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: prepared.rootRequestId,
    expectedRootCheckpointRevision: Number(bundle.root.checkpoint_revision),
    reasonCode: overrides.reasonCode ?? 'CANCELLED_BY_AUTHORIZED_SYSTEM',
    fence: fenceFrom(actor(fixture)),
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    ...overrides
  }));
}

function restartActor(fixture, suffix = 'restart', writeFence = 'allow') {
  const old = actor(fixture);
  const result = fixture.actorStore.acquireActor({
    workspaceId: fixture.workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken: `lease-${fixture.scenarioId}-${suffix}`,
    runtimeId: `runtime-${fixture.scenarioId}-${suffix}`,
    nowUtc: NOW,
    nowMono: 100_001,
    leaseExpiresAtMono: 200_000,
    gateDeadlineMono: 190_000,
    controlStallDeadlineMono: 180_000,
    migrationEpoch: 1,
    writeFence
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.actor.runtimeEpoch, old.runtimeEpoch + 1);
  const gate = fixture.actorStore.completeStartupReconcile({ workspaceId: fixture.workspaceId, fence: result.fence, nowUtc: NOW, nowMono: 100_020 });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  return result;
}

function assertProvenance(fixture, expected = [], options = {}) {
  const expectedSet = new Set(expected);
  for (const table of PROVENANCE_TABLES) {
    if (!tableExists(fixture.database, table)) continue;
    const names = columns(fixture.database, table);
    if (!names.includes('workspace_id')) continue;
    const hasProvenanceColumns = ACCEPTANCE_COLUMNS.every((name) => names.includes(name));
    const rows = hasProvenanceColumns
      ? fixture.database.prepare(`SELECT * FROM "${table}" WHERE workspace_id=?`).all(fixture.workspaceId)
      : [];
    const tagged = rows.filter((row) => ACCEPTANCE_COLUMNS.some((name) => row[name] !== null && row[name] !== undefined));
    for (const row of tagged) {
      assert.ok(ACCEPTANCE_COLUMNS.every((name) => row[name] !== null && row[name] !== undefined), `${table} acceptance tuple incomplete`);
      assert.equal(String(row.acceptance_run_id), fixture.run.acceptanceRunId, `${table} acceptance run mismatch`);
      assert.equal(Number(row.baseline_event_sequence), fixture.run.baselineEventSequence, `${table} baseline event mismatch`);
      assert.equal(Number(row.baseline_checkpoint_revision), fixture.run.baselineCheckpointRevision, `${table} baseline checkpoint mismatch`);
      assert.ok(Number(row.created_after_event_sequence) > fixture.run.baselineEventSequence, `${table} stale event`);
      assert.ok(Number(row.created_after_checkpoint_revision) > fixture.run.baselineCheckpointRevision, `${table} stale checkpoint`);
      assert.ok(Number(row.created_after_mono) >= fixture.run.freshAfterMono, `${table} stale mono`);
    }
    if (expectedSet.has(table)) {
      assert.equal(hasProvenanceColumns, true, `${table} missing acceptance provenance columns`);
      assert.ok(rows.some((row) => String(row.acceptance_run_id ?? '') === fixture.run.acceptanceRunId), `${table} no acceptance row`);
    }
  }
  const events = fixture.context.readEventProof();
  if (options.requireEvent !== false) assert.ok(events.length > 0, `${fixture.scenarioId} needs durable event proof`);
  return events;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  return value;
}

function finishScenario(fixture, observation) {
  const status = observation.status ?? 'passed';
  const evidencePointer = observation.evidencePointer ?? `acceptance-evidence/wmb-5373/${fixture.scenarioId}/${fixture.run.acceptanceRunId}`;
  const finished = finishAcceptanceRun(fixture.database, {
    acceptanceRunId: fixture.run.acceptanceRunId,
    status,
    passed: status === 'passed',
    reason: observation.reason,
    blocker: observation.blocker,
    proof: jsonSafe(observation.proof ?? { scenarioId: fixture.scenarioId }),
    readbacks: jsonSafe(observation.readbacks ?? [{ scenarioId: fixture.scenarioId, status }]),
    evidencePointer,
    finishedAtUtc: NOW,
    finishedAtMono: observation.finishedAtMono ?? tick(fixture)
  }, { nowUtc: () => NOW, nowMono: () => fixture.nowMono, defaultEvidenceRoot: 'acceptance-evidence/wmb-5373' });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(finished.replayed, false);
  assert.equal(finished.run.status, status);
  assert.ok(finished.resultHash);
  assert.equal(finished.evidencePointer, evidencePointer);
  const persisted = readAcceptanceRun(fixture.database, fixture.run.acceptanceRunId);
  assert.ok(persisted);
  assert.equal(persisted.status, status);
  assert.equal(persisted.resultHash, finished.resultHash);
  assert.equal(persisted.evidencePointer, evidencePointer);
  const replay = finishAcceptanceRun(fixture.database, {
    acceptanceRunId: fixture.run.acceptanceRunId,
    status,
    passed: status === 'passed',
    proof: { replay: true },
    readbacks: [{ replay: true }],
    evidencePointer,
    blocker: status === 'not_executed' ? observation.blocker : undefined,
    finishedAtUtc: NOW,
    finishedAtMono: tick(fixture)
  }, { nowUtc: () => NOW, nowMono: () => fixture.nowMono, defaultEvidenceRoot: 'acceptance-evidence/wmb-5373' });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.resultHash, finished.resultHash);
  return finished;
}

function snapshotCounts(database, workspaceId) {
  return {
    roots: count(database, 'daily_orchestration_roots', 'workspace_id=?', [workspaceId]),
    claims: count(database, 'daily_stage_claims', 'workspace_id=?', [workspaceId]),
    dispatches: count(database, 'managed_job_dispatches', 'workspace_id=?', [workspaceId]),
    effects: count(database, 'managed_effect_consumptions', 'workspace_id=?', [workspaceId]),
    snapshots: count(database, 'source_snapshots', 'workspace_id=?', [workspaceId]),
    scopes: count(database, 'daily_plan_scopes', 'workspace_id=?', [workspaceId]),
    projections: count(database, 'daily_plan_scopes', 'workspace_id=?', [workspaceId]),
    intents: count(database, 'orchestrator_intents', 'workspace_id=?', [workspaceId])
  };
}

// A35 — B-07: cancel and F→J handoff share a linearization boundary.
test('WMB-5373 A35 cancel/handoff lock order leaves no post-cancel Judge child', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A35');
  const first = prepareRootWithSource(fixture, { intent: { requestId: 'request-a35-cancel-first' } });
  const cancelled = cancel(fixture, first, { reasonCode: 'A35_CANCEL_BEFORE_HANDOFF' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const cancelledBundle = fixture.rootStore.readRoot(fixture.workspaceId, first.rootRequestId);
  const countsBeforeLateHandoff = {
    claims: count(database, 'daily_stage_claims', 'workspace_id=? AND root_request_id=?', [fixture.workspaceId, first.rootRequestId]),
    dispatches: count(database, 'managed_job_dispatches', 'workspace_id=? AND root_request_id=?', [fixture.workspaceId, first.rootRequestId])
  };
  const lateHandoff = handoff(fixture, first);
  assert.equal(lateHandoff.ok, false, JSON.stringify(lateHandoff));
  assert.ok(['CANCELLED_BY_AUTHORIZED_SYSTEM', 'STATE_CONFLICT', 'EXECUTION_AUTHORIZATION_INVALID'].includes(lateHandoff.code));
  const afterLateHandoff = fixture.rootStore.readRoot(fixture.workspaceId, first.rootRequestId);
  assert.equal(afterLateHandoff.root.status, 'cancelled');
  assert.equal(afterLateHandoff.claims.filter((claim) => claim.attempt_stage === 'judge').length, 0);
  assert.deepEqual({
    claims: count(database, 'daily_stage_claims', 'workspace_id=? AND root_request_id=?', [fixture.workspaceId, first.rootRequestId]),
    dispatches: count(database, 'managed_job_dispatches', 'workspace_id=? AND root_request_id=?', [fixture.workspaceId, first.rootRequestId])
  }, countsBeforeLateHandoff);
  assert.equal(afterLateHandoff.claims.filter((claim) => Number(claim.is_active) === 1).length, 0);

  const restarted = restartActor(fixture, 'a35');
  const second = prepareRootWithSource(fixture, { intent: { requestId: 'request-a35-handoff-first', rootMode: 'scheduler' } });
  const handedOff = handoff(fixture, second);
  assert.equal(handedOff.ok, true, JSON.stringify(handedOff));
  const afterHandoff = fixture.rootStore.readRoot(fixture.workspaceId, second.rootRequestId);
  const judge = afterHandoff.claims.find((claim) => claim.attempt_stage === 'judge');
  assert.ok(judge);
  assert.equal(count(database, 'daily_stage_claims', 'workspace_id=? AND root_request_id=? AND attempt_stage=\'judge\'', [fixture.workspaceId, second.rootRequestId]), 1);
  const cancelledAfterHandoff = cancel(fixture, second, { reasonCode: 'A35_CANCEL_AFTER_HANDOFF' });
  assert.equal(cancelledAfterHandoff.ok, true, JSON.stringify(cancelledAfterHandoff));
  const final = fixture.rootStore.readRoot(fixture.workspaceId, second.rootRequestId);
  assert.equal(final.root.status, 'cancelled');
  assert.equal(final.claims.filter((claim) => Number(claim.is_active) === 1).length, 0);
  assert.equal(final.claims.filter((claim) => claim.attempt_stage === 'judge').length, 1);
  assert.equal(final.claims.find((claim) => claim.attempt_stage === 'judge').status, 'cancelled');
  const judgeDispatch = final.dispatches.find((dispatch) => String(dispatch.stage_request_id) === String(judge.stage_request_id));
  assert.ok(judgeDispatch);
  assert.ok(['cancelled', 'orphaned'].includes(String(judgeDispatch.state)));
  const events = assertProvenance(fixture, ['daily_orchestration_roots', 'daily_stage_claims', 'managed_job_dispatches', 'workspace_active_root_index', 'orchestrator_events']);
  finishScenario(fixture, {
    proof: {
      finding: 'B-07',
      injection: 'cancel-before-handoff and handoff-before-cancel with runtime restart',
      uniqueCondition: 'cancel-first has zero Judge; handoff-first has exactly one terminalized Judge',
      durableReadbacks: { cancelledBundle, afterLateHandoff, restarted, afterHandoff, final, events },
      zeroWriteCounts: { lateHandoff: countsBeforeLateHandoff }
    },
    readbacks: [cancelledBundle.root, afterLateHandoff.root, afterHandoff.root, final.root]
  });
}));

// A36 — B-08: every required current-channel fence drift fails closed at source freeze and F→J handoff.
function sourceSnapshotContent(database, workspaceId, stageRequestId) {
  const row = database.prepare('SELECT * FROM source_snapshots WHERE workspace_id=? AND stage_request_id=?').get(workspaceId, stageRequestId);
  if (!row) return null;
  return {
    snapshotHash: String(row.snapshot_hash),
    status: String(row.status),
    profileRevision: Number(row.profile_revision),
    policyHash: String(row.policy_hash),
    selectedChannels: String(row.selected_channel_ids_json),
    successfulChannels: String(row.successful_channels_json),
    failedChannels: String(row.failed_channels_json),
    unresolvedChannels: String(row.unresolved_channels_json)
  };
}

function assertFenceReject(fixture, prepared, beforeCounts, beforeSnapshot, result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'SOURCE_SNAPSHOT_STALE', JSON.stringify(result));
  assert.deepEqual(snapshotCounts(fixture.database, fixture.workspaceId), beforeCounts);
  const bundle = fixture.rootStore.readRoot(fixture.workspaceId, prepared.rootRequestId);
  const parent = bundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge') ?? bundle.claims[0];
  assert.ok(parent);
  assert.deepEqual(sourceSnapshotContent(fixture.database, fixture.workspaceId, String(parent.stage_request_id)), beforeSnapshot);
  assert.equal(String(bundle.root.status), 'running');
  assert.notEqual(String(bundle.root.status), 'waiting_owner');
  assert.equal(bundle.claims.some((claim) => String(claim.attempt_stage) === 'judge'), false);
  assert.doesNotMatch(JSON.stringify(bundle), /clean_empty/);
}

function mutateFence(prepared, channelId, patch) {
  return prepared.frozen.value.successfulChannels.map((entry) => String(entry.channelId) === channelId ? { ...entry, ...patch } : entry);
}

test('WMB-5373 A36 capability/config/auth drift fails closed before freeze and before Judge handoff', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A36');
  const proof = { authConfig: [], capabilityLease: [], revision: [] };

  const authAccepted = acceptIntent(fixture, { requestId: 'request-a36-auth-config', source: 'today_ui' });
  const authClosed = closePreflight(fixture, authAccepted);
  const authAdmitted = admitRoot(fixture, authAccepted);
  const authRoot = fixture.rootStore.readRoot(fixture.workspaceId, String(authAdmitted.root.root_request_id));
  const authPreflight = database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(fixture.workspaceId, authClosed.preflightId);
  assert.ok(authPreflight);
  const authInput = sourceInput(fixture, authRoot, authPreflight);
  const authPrepared = { rootRequestId: String(authAdmitted.root.root_request_id) };
  const authBefore = snapshotCounts(database, fixture.workspaceId);
  const authSnapshotBefore = null;
  for (const [label, patch] of [
    ['auth', { authRevision: 2, authStatus: 'expired' }],
    ['config', { configRevision: 2, configStatus: 'changed' }]
  ]) {
    const rejected = fixture.snapshotStore.freezeSourceSnapshot({
      ...authInput,
      currentChannelFences: authInput.currentChannelFences.map((entry) => String(entry.channelId) === 'official' ? { ...entry, ...patch } : entry)
    });
    assertFenceReject(fixture, authPrepared, authBefore, authSnapshotBefore, rejected);
    proof.authConfig.push({ label, result: rejected });
  }

  const leasePrepared = prepareRootWithSource(fixture, { intent: { requestId: 'request-a36-capability-lease', source: 'proposal_ui' } });
  const leaseParent = leasePrepared.bundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge');
  assert.ok(leaseParent);
  const leaseSnapshotBefore = sourceSnapshotContent(database, fixture.workspaceId, String(leaseParent.stage_request_id));
  const leaseBefore = snapshotCounts(database, fixture.workspaceId);
  const expiredAt = fixture.nowMono + 10;
  const expired = handoff(fixture, leasePrepared, {
    currentChannelFences: mutateFence(leasePrepared, 'official', { expiresAtMono: expiredAt }),
    nowMono: expiredAt
  });
  assertFenceReject(fixture, leasePrepared, leaseBefore, leaseSnapshotBefore, expired);
  proof.capabilityLease.push({ label: 'expired', result: expired });
  const revokedAt = expiredAt + 10;
  const revokedBefore = snapshotCounts(database, fixture.workspaceId);
  const revoked = handoff(fixture, leasePrepared, {
    currentChannelFences: mutateFence(leasePrepared, 'official', { status: 'revoked', revoked: true }),
    nowMono: revokedAt
  });
  assertFenceReject(fixture, leasePrepared, revokedBefore, leaseSnapshotBefore, revoked);
  proof.capabilityLease.push({ label: 'revoked', result: revoked });

  const revisionPrepared = prepareRootWithSource(fixture, { intent: { requestId: 'request-a36-profile-capability-revision', source: 'mcp' } });
  const revisionParent = revisionPrepared.bundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge');
  assert.ok(revisionParent);
  const revisionSnapshotBefore = sourceSnapshotContent(database, fixture.workspaceId, String(revisionParent.stage_request_id));
  const profileBefore = snapshotCounts(database, fixture.workspaceId);
  const profileDrift = handoff(fixture, revisionPrepared, {
    currentChannelFences: revisionPrepared.frozen.value.successfulChannels.map((entry) => ({ ...entry, profileRevision: 8 })),
    nowMono: fixture.nowMono + 10
  });
  assertFenceReject(fixture, revisionPrepared, profileBefore, revisionSnapshotBefore, profileDrift);
  proof.revision.push({ label: 'profile', result: profileDrift });
  const capabilityBefore = snapshotCounts(database, fixture.workspaceId);
  const capabilityDrift = handoff(fixture, revisionPrepared, {
    currentChannelFences: mutateFence(revisionPrepared, 'official', { capabilityRevision: 2 }),
    nowMono: fixture.nowMono + 20
  });
  assertFenceReject(fixture, revisionPrepared, capabilityBefore, revisionSnapshotBefore, capabilityDrift);
  proof.revision.push({ label: 'capability', result: capabilityDrift });

  const events = assertProvenance(fixture, [
    'orchestrator_intents', 'channel_preflight_snapshots', 'daily_orchestration_roots',
    'daily_stage_claims', 'source_snapshots', 'managed_job_dispatches',
    'workspace_active_root_index', 'orchestrator_events'
  ]);
  finishScenario(fixture, {
    proof: {
      finding: 'B-08',
      injection: 'auth/config drift before source freeze; capability expiry/revocation and profile/capability revision drift after frozen source before Judge',
      uniqueCondition: 'all drift attempts return stable SOURCE_SNAPSHOT_STALE with no root/claim/dispatch/effect/index/snapshot growth, no waiting_owner/clean_empty/Judge, and frozen source rows unchanged',
      scenarios: proof,
      events
    },
    readbacks: [proof, events]
  });
}));

// A37 — B-09: requiredness is normalized from the authorized profile and invalid policy writes only a rejection receipt.
test('WMB-5373 A37 invalid channel policy matrix rejects before root with zero business writes', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A37');
  const authorized = policyWithOptional();
  const attempts = [
    ['required-to-optional', [{ channelId: 'official', requiredness: 'optional', module: 'official_web' }]],
    ['required-omitted', [{ channelId: 'x-list', requiredness: 'optional', module: 'x_list' }]],
    ['duplicate', [{ channelId: 'official', requiredness: 'required', module: 'official_web' }, { channelId: 'official', requiredness: 'required', module: 'official_web' }]],
    ['unknown', [...policyOfficial(), { channelId: 'unknown', requiredness: 'optional', module: 'unknown' }]],
    ['pseudo-module', [{ channelId: 'official', requiredness: 'required', module: 'forged_module' }]],
    ['unauthorized', [{ channelId: 'foreign', requiredness: 'optional', module: 'foreign_module' }]]
  ];
  const results = [];
  for (const [label, policy] of attempts) {
    const result = fixture.actorStore.acceptIntent(intentInput(fixture, {
      requestId: `request-a37-${label}`,
      channelPolicy: policy,
      authorizedChannelPolicy: authorized,
      payload: { topic: 'A37', label }
    }));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'CHANNEL_POLICY_INVALID', JSON.stringify(result));
    results.push({ label, result });
  }
  assert.equal(count(database, 'command_receipts', 'workspace_id=?', [fixture.workspaceId]), attempts.length);
  assert.equal(count(database, 'orchestrator_intents', 'workspace_id=?', [fixture.workspaceId]), 0);
  assert.equal(count(database, 'daily_orchestration_roots', 'workspace_id=?', [fixture.workspaceId]), 0);
  assert.equal(count(database, 'daily_stage_claims', 'workspace_id=?', [fixture.workspaceId]), 0);
  assert.equal(count(database, 'managed_job_dispatches', 'workspace_id=?', [fixture.workspaceId]), 0);
  assert.equal(count(database, 'daily_plan_scopes', 'workspace_id=?', [fixture.workspaceId]), 0);
  const events = assertProvenance(fixture, ['command_receipts'], { requireEvent: false });
  finishScenario(fixture, {
    proof: {
      finding: 'B-09',
      injection: attempts.map(([label]) => label),
      uniqueCondition: 'all six non-monotonic policies return CHANNEL_POLICY_INVALID before root',
      durableReadbacks: { results, events },
      zeroWriteCounts: { intents: 0, roots: 0, claims: 0, dispatches: 0, scopes: 0 }
    },
    readbacks: results.map(({ label, result }) => ({ label, receipt: result.receipt ?? result }))
  });
}));

// A38 — B-10: active-root index projection-state variants are explicit and rebuildable.
test('WMB-5373 A38 projection absent/not_applicable/frozen and active-root index rebuild are durable', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A38');
  const ordinary = prepareRootWithSource(fixture, { intent: { requestId: 'request-a38-ordinary' } });
  let ordinaryIndex = database.prepare('SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, ordinary.rootRequestId);
  assert.ok(ordinaryIndex);
  assert.equal(ordinaryIndex.projection_state, 'absent');
  assert.equal(ordinaryIndex.scope_hash, null);
  assert.equal(ordinaryIndex.projection_hash, null);
  assert.equal(ordinaryIndex.eligible_ids_hash, null);
  const cancelledOrdinary = cancel(fixture, ordinary, { reasonCode: 'A38_PRE_PROJECTION_CANCEL' });
  assert.equal(cancelledOrdinary.ok, true, JSON.stringify(cancelledOrdinary));

  const noTargetsAccepted = acceptIntent(fixture, { requestId: 'request-a38-no-targets', rootMode: 'scheduler' });
  const noTargetsClosed = closePreflight(fixture, noTargetsAccepted, [readyChannel('official', 'required')]);
  const noTargetsAdmitted = admitRoot(fixture, noTargetsAccepted, { rootMode: 'scheduler' });
  const noTargetsId = String(noTargetsAdmitted.root.root_request_id);
  const noTargetsBundle = fixture.rootStore.readRoot(fixture.workspaceId, noTargetsId);
  const noTargetsStage = noTargetsBundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge');
  const noTargetResult = fixture.snapshotStore.freezeStageDTargetEffect(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: noTargetsId,
    rootGeneration: Number(noTargetsBundle.root.root_generation),
    rootInputHash: String(noTargetsBundle.root.root_input_hash),
    stageRequestId: String(noTargetsStage.stage_request_id),
    cycleId: 'a38-no-targets',
    targets: [],
    effects: [],
    fence: fenceFrom(actor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(noTargetResult.ok, true, JSON.stringify(noTargetResult));
  const noTargetRead = fixture.rootStore.readRoot(fixture.workspaceId, noTargetsId);
  const noTargetIndex = database.prepare('SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, noTargetsId);
  assert.equal(noTargetRead.root.status, 'succeeded');
  assert.equal(noTargetIndex.terminal_reason, 'NO_CURRENT_TARGETS');
  assert.equal(noTargetIndex.projection_state, 'not_applicable');
  assert.equal(noTargetIndex.scope_hash, null);
  assert.equal(noTargetIndex.projection_hash, null);
  assert.equal(noTargetIndex.eligible_ids_hash, null);
  assert.equal(count(database, 'daily_plan_scopes', 'workspace_id=? AND root_request_id=?', [fixture.workspaceId, noTargetsId]), 0);

  const candidate = prepareRootWithSource(fixture, { intent: { requestId: 'request-a38-candidate' } });
  const candidateBundle = fixture.rootStore.readRoot(fixture.workspaceId, candidate.rootRequestId);
  const candidateStage = candidateBundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge');
  const projection = fixture.snapshotStore.freezePlanScopeProjection(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: candidate.rootRequestId,
    rootGeneration: Number(candidateBundle.root.root_generation),
    rootInputHash: String(candidateBundle.root.root_input_hash),
    stageRequestId: String(candidateStage.stage_request_id),
    sourceSnapshotHash: String(candidate.frozen.value.snapshotHash),
    managerTaskId: String(candidateBundle.root.manager_task_id),
    orchestrationId: String(candidateBundle.root.orchestration_id),
    attemptStage: String(candidateStage.attempt_stage),
    allowedPlanIds: ['plan-a38'],
    allowedPlanItemIds: ['item-a38'],
    carryPlanItemIds: [],
    trustedReceiptIds: candidate.frozen.value.receiptIds,
    scope: { purpose: 'a38' },
    projection: {
      planIds: ['plan-a38'],
      asOf: { utc: NOW, mono: tick(fixture) },
      entries: [{ planItemId: 'item-a38', classification: 'eligible', sourceReceiptIds: candidate.frozen.value.receiptIds }],
      candidatePlanItemIds: ['item-a38'],
      eligiblePlanItemIds: ['item-a38'],
      pendingPlanItemIds: [],
      invalidPlanItemIds: []
    },
    candidateInputCount: 1,
    classifiedCount: 1,
    coverageGap: [],
    fence: fenceFrom(actor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(projection.ok, true, JSON.stringify(projection));
  const frozenIndex = database.prepare('SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, candidate.rootRequestId);
  assert.equal(frozenIndex.projection_state, 'frozen');
  assert.ok(frozenIndex.scope_hash);
  assert.ok(frozenIndex.projection_hash);
  assert.ok(frozenIndex.eligible_ids_hash);
  const staleProjectionBefore = database.prepare('SELECT scope_hash, projection_hash, eligible_ids_hash FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, candidate.rootRequestId);
  const staleProjection = fixture.snapshotStore.freezePlanScopeProjection(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: candidate.rootRequestId,
    rootGeneration: Number(candidateBundle.root.root_generation),
    rootInputHash: String(candidateBundle.root.root_input_hash),
    stageRequestId: String(candidateStage.stage_request_id),
    sourceSnapshotHash: String(candidate.frozen.value.snapshotHash),
    managerTaskId: String(candidateBundle.root.manager_task_id),
    orchestrationId: String(candidateBundle.root.orchestration_id),
    attemptStage: String(candidateStage.attempt_stage),
    allowedPlanIds: ['plan-a38'],
    allowedPlanItemIds: ['item-different'],
    trustedReceiptIds: candidate.frozen.value.receiptIds,
    scope: { purpose: 'a38-stale-approval' },
    projection: {
      planIds: ['plan-a38'],
      asOf: { utc: NOW, mono: tick(fixture) },
      entries: [{ planItemId: 'item-different', classification: 'eligible', sourceReceiptIds: candidate.frozen.value.receiptIds }],
      candidatePlanItemIds: ['item-different'],
      eligiblePlanItemIds: ['item-different'],
      pendingPlanItemIds: [],
      invalidPlanItemIds: []
    },
    candidateInputCount: 1,
    classifiedCount: 1,
    fence: fenceFrom(actor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(staleProjection.ok, false, JSON.stringify(staleProjection));
  const staleProjectionAfter = database.prepare('SELECT scope_hash, projection_hash, eligible_ids_hash FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, candidate.rootRequestId);
  assert.deepEqual(staleProjectionAfter, staleProjectionBefore);
  database.prepare('DELETE FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').run(fixture.workspaceId, noTargetsId);
  const deletedIndexCount = count(database, 'workspace_active_root_index', 'workspace_id=? AND root_request_id=?', [fixture.workspaceId, noTargetsId]);
  assert.equal(deletedIndexCount, 0);
  const rebuilt = reconcileWorkspaceOrchestratorStartup(database, withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    fence: fenceFrom(actor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(rebuilt.ok, false, JSON.stringify(rebuilt));
  assert.equal(rebuilt.status, 'maintenance');
  assert.ok(Array.isArray(rebuilt.maintenanceReasons) && rebuilt.maintenanceReasons.length > 0, JSON.stringify(rebuilt));
  const rebuiltIndex = database.prepare('SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, noTargetsId);
  assert.ok(rebuiltIndex, JSON.stringify(rebuilt));
  assert.equal(rebuiltIndex.projection_state, 'not_applicable');
  assert.ok(Array.isArray(rebuilt.actions) && rebuilt.actions.some((action) => action === `index-rebuilt:${noTargetsId}`), JSON.stringify(rebuilt));
  const events = assertProvenance(fixture, ['daily_orchestration_roots', 'daily_stage_claims', 'daily_plan_scopes', 'workspace_active_root_index', 'orchestrator_events']);
  finishScenario(fixture, {
    proof: {
      finding: 'B-10',
      injection: 'ordinary absent, scheduler NO_CURRENT_TARGETS, deleted active-root index, stale projection replay',
      uniqueCondition: 'absent/not_applicable/frozen states are explicit; rebuild restores index; stale projection is zero-write conflict',
      durableReadbacks: { ordinaryIndex, noTargetRead, noTargetIndex, rebuilt, frozenIndex, staleProjection, events },
      zeroWriteCounts: { staleProjection: { before: staleProjectionBefore, after: staleProjectionAfter } }
    },
    readbacks: [ordinaryIndex, noTargetIndex, frozenIndex, staleProjection]
  });
}));

// A39 — B-11: migration journal is append-only and conflict enters maintenance; this run records the missing global actor fence honestly.
test('WMB-5373 A39 migration journal replay/conflict and global zero-write fence evidence', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A39', { migrationStatus: 'running', migrationWriteFence: 'deny' });
  const current = actor(fixture);
  const runningMigration = database.prepare('SELECT status,write_fence FROM workspace_migration_state WHERE workspace_id=? AND migration_epoch=?').get(fixture.workspaceId, current.migrationEpoch);
  assert.deepEqual({ status: runningMigration.status, write_fence: runningMigration.write_fence }, { status: 'running', write_fence: 'deny' });
  const step = {
    workspaceId: fixture.workspaceId,
    migrationEpoch: current.migrationEpoch,
    stepKey: 'a39-orphan-map',
    inputHash: hashV1({ r: 'a39-input', rows: 2 }),
    beforeHash: HEX_A,
    afterHash: HEX_B,
    rowCount: 2,
    winnerSetHash: HEX_C,
    fence: fenceFrom(current),
    nowUtc: NOW,
    nowMono: tick(fixture)
  };
  const committed = recordWorkspaceMigrationStep(database, step);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.status, 'committed');
  const replay = recordWorkspaceMigrationStep(database, { ...step, fence: committed.fence, nowMono: tick(fixture) });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.status, 'replayed');
  const conflict = recordWorkspaceMigrationStep(database, {
    ...step,
    fence: replay.fence,
    inputHash: hashV1({ r: 'a39-conflict' }),
    nowMono: tick(fixture)
  });
  assert.equal(conflict.ok, false, JSON.stringify(conflict));
  assert.equal(conflict.code, 'MIGRATION_JOURNAL_CONFLICT');
  const journalRows = database.prepare('SELECT step_key,input_hash,before_hash,after_hash,row_count,winner_set_hash,status FROM workspace_migration_journal WHERE workspace_id=? ORDER BY step_seq').all(fixture.workspaceId);
  assert.equal(journalRows.length, 1);
  assert.equal(journalRows[0].input_hash, step.inputHash);
  const migration = database.prepare('SELECT status,write_fence,failure_reason FROM workspace_migration_state WHERE workspace_id=? AND migration_epoch=?').get(fixture.workspaceId, current.migrationEpoch);
  assert.deepEqual({ status: migration.status, write_fence: migration.write_fence, failure_reason: migration.failure_reason }, { status: 'maintenance', write_fence: 'maintenance', failure_reason: 'MIGRATION_JOURNAL_CONFLICT' });
  const restarted = restartActor(fixture, 'a39', 'deny');
  const beforeInvalidWriter = snapshotCounts(database, fixture.workspaceId);
  const invalidWriter = fixture.actorStore.acceptIntent(intentInput(fixture, { requestId: 'request-a39-invalid-writer' }));
  const afterInvalidWriter = snapshotCounts(database, fixture.workspaceId);
  assert.equal(invalidWriter.ok, false, JSON.stringify(invalidWriter));
  assert.equal(invalidWriter.code, 'WRITE_FENCE_DENIED');
  assert.equal(afterInvalidWriter.roots, beforeInvalidWriter.roots);
  assert.equal(afterInvalidWriter.claims, beforeInvalidWriter.claims);
  assert.equal(afterInvalidWriter.dispatches, beforeInvalidWriter.dispatches);
  assert.equal(afterInvalidWriter.intents, beforeInvalidWriter.intents);
  assert.equal(restarted.actor.writeFence, 'deny');
  const events = assertProvenance(fixture, ['command_receipts'], { requireEvent: false });
  finishScenario(fixture, {
    proof: {
      finding: 'B-11',
      injection: 'journal commit, identical replay, conflicting replay, then writer attempt',
      uniqueCondition: 'journal winner is immutable and conflicting input is MIGRATION_JOURNAL_CONFLICT; global deny fence rejects the new intent with zero business writes',
      durableReadbacks: { committed, replay, conflict, journalRows, migration, invalidWriter, events },
      zeroWriteCounts: { intents: afterInvalidWriter.intents, roots: afterInvalidWriter.roots, claims: afterInvalidWriter.claims, dispatches: afterInvalidWriter.dispatches }
    },
    readbacks: [journalRows, migration, invalidWriter]
  });
}));

// A40 — B-12: legacy producer identities are denied while a current Actor intent/root follows the new path.
test('WMB-5373 A40 legacy renderer/MCP/scheduler/binary requests are cutover-rejected with zero dual writes', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A40');
  const oldRequests = [
    { label: 'renderer', source: 'legacy_renderer', producerId: 'producer.legacy-renderer', producerAttestation: attestation(actor(fixture).runtimeEpoch, { producerId: 'producer.legacy-renderer' }) },
    { label: 'mcp', source: 'legacy_mcp', producerId: 'producer.legacy-mcp', producerAttestation: attestation(actor(fixture).runtimeEpoch, { producerId: 'producer.legacy-mcp' }) },
    { label: 'scheduler', source: 'legacy_scheduler', producerId: 'producer.acceptance', producerAttestation: attestation(actor(fixture).runtimeEpoch, { buildId: 'build-old', sourceCommit: 'source-old' }) }
  ];
  const before = snapshotCounts(database, fixture.workspaceId);
  const rejected = oldRequests.map(({ label, source, producerId, producerAttestation }) => {
    const result = fixture.actorStore.acceptIntent(intentInput(fixture, {
      requestId: `request-a40-${label}`,
      source,
      producerId,
      producerAttestation,
      payload: { topic: 'A40', label }
    }));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'CUTOVER_REQUIRED', JSON.stringify(result));
    return { label, result };
  });
  const afterLegacy = snapshotCounts(database, fixture.workspaceId);
  assert.equal(afterLegacy.roots, before.roots);
  assert.equal(afterLegacy.claims, before.claims);
  assert.equal(afterLegacy.dispatches, before.dispatches);
  assert.equal(afterLegacy.scopes, before.scopes);
  const currentIntent = acceptIntent(fixture, { requestId: 'request-a40-current', source: 'today_ui' });
  const currentPreflight = closePreflight(fixture, currentIntent, [readyChannel('official', 'required'), readyChannel('x-list', 'optional')]);
  const currentRoot = admitRoot(fixture, currentIntent);
  assert.equal(currentRoot.ok, true, JSON.stringify(currentRoot));
  const rowsByOldRequest = oldRequests.map(({ label }) => database.prepare('SELECT COUNT(*) AS count FROM orchestrator_intents WHERE workspace_id=? AND request_id=?').get(fixture.workspaceId, `request-a40-${label}`).count);
  assert.deepEqual(rowsByOldRequest, [0, 0, 0]);
  const build = database.prepare('SELECT build_id,manifest_hash,app_asar_hash FROM build_manifests WHERE build_id=?').get(BUILD_ID);
  const currentActor = actor(fixture);
  const producer = database.prepare('SELECT build_id,registry_entry_hash,census_hash FROM producer_registry WHERE workspace_id=? AND producer_id=?').get(fixture.workspaceId, 'producer.acceptance');
  assert.equal(currentActor.currentBuildId, BUILD_ID);
  assert.equal(producer.build_id, BUILD_ID);
  const events = assertProvenance(fixture, ['command_receipts', 'orchestrator_intents', 'channel_preflight_snapshots', 'daily_orchestration_roots', 'daily_stage_claims', 'managed_job_dispatches', 'workspace_active_root_index', 'orchestrator_events']);
  finishScenario(fixture, {
    proof: {
      finding: 'B-12',
      injection: 'legacy renderer, MCP, scheduler, and old build attestation requests alongside current Actor intent',
      uniqueCondition: 'all legacy requests are CUTOVER_REQUIRED with zero intent/root/claim/dispatch; current Actor writes one canonical path',
      durableReadbacks: { rejected, currentIntent, currentPreflight, currentRoot, build, currentActor, producer, events },
      zeroWriteCounts: { oldRequests: rowsByOldRequest, legacyDelta: { before, after: afterLegacy } }
    },
    readbacks: rejected.map(({ label, result }) => ({ label, receipt: result.receipt ?? result })).concat([currentRoot.root])
  });
}));
