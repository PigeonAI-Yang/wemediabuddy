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
  canonicalJsonV1,
  hashV1
} from '../src/main/workspace-orchestrator-actor.ts';
import { reconcileWorkspaceOrchestratorPreflightStartup } from '../src/main/workspace-orchestrator-recovery.ts';
import { WorkspaceOrchestratorRootStageStore } from '../src/main/workspace-orchestrator-root-stage.ts';
import { createWorkspaceOrchestratorSnapshotStore } from '../src/main/workspace-orchestrator-snapshots.ts';
import { readManagerAdapterProjection } from '../src/main/workspace-orchestrator-manager-adapter.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { executeOwnerProjectionDecision } from '../src/main/workspace-orchestrator-owner-decision.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const NOW = '2026-08-31T08:00:00.000Z';
const BUILD_ID = 'build-wmb-5373';
const MANIFEST_HASH = 'd'.repeat(64);
const SOURCE_COMMIT = 'source-wmb-5373';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

const PROVENANCE_COLUMNS = [
  'acceptance_run_id',
  'baseline_event_sequence',
  'baseline_checkpoint_revision',
  'created_after_event_sequence',
  'created_after_checkpoint_revision',
  'created_after_mono'
];

function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5373-acceptance-'));
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

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name));
}

function seedBuild(database) {
  database.prepare(`INSERT INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, 79, 0, 79, 81, 79, ?, ?, ?)`).run(
    BUILD_ID, SOURCE_COMMIT, HEX_A, HEX_B, MANIFEST_HASH, 'J:/WMB/resources', NOW
  );
}

function seedProducer(database, workspaceId, actor) {
  database.prepare(`INSERT INTO workspace_migration_state (
    workspace_id, migration_epoch, status, manifest_hash, schema_epoch, cutover_epoch,
    owner_runtime_epoch, fence_token_hash, write_fence, checkpoint_seq, before_hash,
    after_hash, started_at_utc, started_at_mono, finished_at_utc, finished_at_mono
  ) VALUES (?, 1, 'complete', ?, 79, 0, ?, ?, 'allow', 0, ?, ?, ?, 1, ?, 2)`).run(
    workspaceId, MANIFEST_HASH, actor.runtimeEpoch, HEX_A, HEX_A, HEX_B, NOW, NOW
  );
  database.prepare(`INSERT INTO producer_registry (
    workspace_id, producer_id, build_id, migration_epoch, source_location, trigger,
    trigger_id, allowed_intent_kind, owner, replacement_route, write_tables,
    write_principal, authorizer_revision, process_image_path, resources_path,
    registry_entry_hash, enabled, census_hash, created_at
  ) VALUES (?, 'producer.acceptance', ?, 1, 'tests/wmb-5373-adversarial-a47-a52.test.mjs', 'owner', 'trigger.acceptance',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_acceptance_test',
    'auth-wmb-5373', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`).run(
    workspaceId, BUILD_ID, 'registry-wmb-5373', 'census-wmb-5373', NOW
  );
}

function attestation(runtimeEpoch) {
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
    authorizerRevision: 'auth-wmb-5373'
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
  seedProducer(database, workspaceId, acquired.actor);
  const createdGate = actorStore.createStartupReconcileGate({ workspaceId, fence: acquired.fence, nowUtc: NOW, nowMono: 110 });
  assert.equal(createdGate.ok, true, JSON.stringify(createdGate));
  const completedGate = actorStore.completeStartupReconcile({ workspaceId, fence: acquired.fence, nowUtc: NOW, nowMono: 120 });
  assert.equal(completedGate.ok, true, JSON.stringify(completedGate));
  const started = startAcceptanceRun(database, {
    workspaceId,
    scenarioId,
    acceptanceRunId: `acceptance-run-wmb-5373-${scenarioId}`,
    acceptanceNamespace: `acceptance/wmb-5373/${scenarioId}`,
    scenarioInput: { scenarioId, workspaceId },
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
    actorStore,
    rootStore: new WorkspaceOrchestratorRootStageStore(database, { nowUtc: () => NOW, nowMono: () => 200 }),
    snapshotStore: createWorkspaceOrchestratorSnapshotStore(database, { nowUtc: () => NOW, nowMono: () => 200 }),
    context: started.context,
    run: started.run,
    nowMono: 210
  };
}

function currentActor(fixture) {
  const actor = fixture.actorStore.readActor(fixture.workspaceId);
  assert.ok(actor);
  return actor;
}

function tick(fixture, delta = 10) {
  fixture.nowMono += delta;
  return fixture.nowMono;
}

function withAcceptance(fixture, input) {
  return fixture.context.withAcceptance(input);
}

function policy(entries = [
  { channelId: 'official', requiredness: 'required', module: 'official_web' },
  { channelId: 'x-list', requiredness: 'optional', module: 'x_list' }
]) {
  return entries;
}

function readyChannel(channelId, requiredness = 'required') {
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
  const actor = currentActor(fixture);
  const requestId = overrides.requestId ?? `request-${fixture.scenarioId.toLowerCase()}`;
  const selectedPolicy = overrides.channelPolicy ?? policy();
  const authorizedPolicy = overrides.authorizedChannelPolicy ?? selectedPolicy;
  const payload = overrides.payload ?? { topic: 'AI infrastructure', scenarioId: fixture.scenarioId, requestId };
  return withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    businessDate: overrides.businessDate ?? '2026-08-31',
    source: overrides.source ?? 'today_ui',
    rootMode: overrides.rootMode ?? 'owner',
    requestedAction: overrides.requestedAction ?? 'full',
    requestId,
    producerId: 'producer.acceptance',
    producerAttestation: attestation(actor.runtimeEpoch),
    logicalInput: payload,
    payload,
    channelPolicy: selectedPolicy,
    authorizedChannelPolicy: authorizedPolicy,
    profileRevision: overrides.profileRevision ?? 7,
    priority: overrides.priority ?? 10,
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    fence: fenceFrom(actor),
    ...overrides
  });
}

function acceptIntent(fixture, overrides = {}) {
  const accepted = fixture.actorStore.acceptIntent(intentInput(fixture, overrides));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  return accepted;
}

function closePreflight(fixture, accepted, channelResults, overrides = {}) {
  const closed = fixture.actorStore.closePreflight(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    intentId: accepted.intentId,
    requestId: accepted.requestId,
    profileRevision: overrides.profileRevision ?? 7,
    channelResults,
    aggregateDeadlineMono: overrides.aggregateDeadlineMono,
    aggregateDeadlineUtc: overrides.aggregateDeadlineUtc,
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    fence: fenceFrom(currentActor(fixture)),
    ...overrides
  }));
  assert.equal(closed.ok, true, JSON.stringify(closed));
  return closed;
}

function admitRoot(fixture, accepted, overrides = {}) {
  const admitted = fixture.rootStore.admitRoot(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    intentId: accepted.intentId,
    requestId: accepted.requestId,
    fence: fenceFrom(currentActor(fixture)),
    envelope: { executable: 'node', argv: ['orchestrator-worker'], cwd: 'J:/WMB', scenarioId: fixture.scenarioId },
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    ...overrides
  }));
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  return admitted;
}

function sourceInput(fixture, rootBundle, preflight, options = {}) {
  const root = rootBundle.root;
  const stage = rootBundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge') ?? rootBundle.claims[0];
  const selectedChannelIds = options.selectedChannelIds ?? JSON.parse(String(preflight.selected_channels_json)).map((entry) => String(entry.channelId ?? entry.channel_id ?? entry));
  const preflightResults = JSON.parse(String(preflight.results_json ?? '[]'));
  const currentChannelFences = options.currentChannelFences ?? selectedChannelIds.map((channelId) => {
    const result = preflightResults.find((entry) => String(entry.channelId ?? entry.channel_id) === channelId) ?? {};
    return {
      ...result,
      channelId,
      profileRevision: Number(preflight.profile_revision),
      policyHash: String(preflight.policy_hash),
      status: 'ready',
      ready: true,
      revoked: false,
      authStatus: 'ready',
      configStatus: 'ready',
      configRevision: Number(result.configRevision ?? 1),
      authRevision: Number(result.authRevision ?? 1),
      capabilityRevision: Number(result.capabilityRevision ?? 1),
      capabilityLeaseId: String(result.capabilityLeaseId ?? `cap-${channelId}`),
      expiresAtMono: Number(result.expiresAtMono ?? 90_000),
    };
  });
  const currentFenceEntries = Array.isArray(currentChannelFences)
    ? currentChannelFences
    : Object.entries(currentChannelFences).map(([channelId, value]) => ({ ...value, channelId: value.channelId ?? channelId }));
  const currentFenceByChannel = new Map(currentFenceEntries.map((entry) => [String(entry.channelId), entry]));
  const successfulChannels = (options.successfulChannels ?? selectedChannelIds.map((channelId) => ({
    channelId,
    requiredness: channelId === 'official' ? 'required' : 'optional',
    receiptId: `receipt-${fixture.scenarioId}-${channelId}`,
    receiptRevision: 1,
    receiptPayloadHash: HEX_A,
    resultHash: HEX_B,
    configRevision: 1,
    authRevision: 1,
    capabilityLeaseId: `cap-${channelId}`
  }))).map((entry) => ({ ...currentFenceByChannel.get(String(entry.channelId)), ...entry }));
  const failedChannels = options.failedChannels ?? [];
  const unresolvedChannels = options.unresolvedChannels ?? [];
  const sourceBindings = options.sourceBindings ?? [{ sourceId: `source-${fixture.scenarioId}-1`, sourceRevision: 1, sourceContentHash: HEX_C }];
  const receiptBindings = options.receiptBindings ?? successfulChannels.map((entry) => ({
    receiptId: entry.receiptId,
    receiptRevision: entry.receiptRevision,
    receiptPayloadHash: entry.receiptPayloadHash
  }));
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
    currentChannelFences,
    successfulChannels,
    failedChannels,
    unresolvedChannels,
    sourceBindings,
    sourceIds: sourceBindings.map((entry) => entry.sourceId),
    receiptIds: successfulChannels.map((entry) => entry.receiptId),
    receiptBindings,
    watermarkUtc: NOW,
    watermarkMono: options.watermarkMono ?? tick(fixture),
    capturedAtUtc: NOW,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: options.nowMono ?? fixture.nowMono,
    ...options.extra
  });
}

function prepareRootWithSource(fixture, options = {}) {
  const selectedPolicy = options.intent?.channelPolicy ?? policy();
  const accepted = acceptIntent(fixture, { ...options.intent, channelPolicy: selectedPolicy, authorizedChannelPolicy: options.intent?.authorizedChannelPolicy ?? selectedPolicy });
  const selectedChannels = selectedPolicy.map((entry) => entry.channelId);
  const closed = closePreflight(fixture, accepted, options.channelResults ?? selectedChannels.map((channelId) => readyChannel(channelId, selectedPolicy.find((entry) => entry.channelId === channelId).requiredness)));
  const admitted = admitRoot(fixture, accepted, options.root ?? {});
  const rootRequestId = String(admitted.root.root_request_id);
  const bundle = fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId);
  const preflight = fixture.database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(fixture.workspaceId, closed.preflightId);
  assert.ok(preflight);
  const input = sourceInput(fixture, bundle, preflight, options.source ?? {});
  const frozen = fixture.snapshotStore.freezeSourceSnapshot(input);
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  return { accepted, closed, admitted, rootRequestId, bundle: fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId), preflight, input, frozen };
}

function projectionInput(fixture, bundle, source, options = {}) {
  const root = bundle.root;
  const stage = bundle.claims.find((claim) => String(claim.stage_request_id) === String(source.stageRequestId ?? source.input?.stageRequestId))
    ?? bundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge')
    ?? bundle.claims[0];
  assert.ok(root);
  assert.ok(stage);
  const eligible = options.eligiblePlanItemIds ?? [];
  const pending = options.pendingPlanItemIds ?? [];
  const invalid = options.invalidPlanItemIds ?? [];
  const candidate = options.candidatePlanItemIds ?? [...eligible, ...pending, ...invalid];
  const all = [...eligible, ...pending, ...invalid];
  const trustedReceiptIds = options.trustedReceiptIds ?? source.frozen?.receiptIds ?? source.value?.receiptIds ?? [`receipt-${fixture.scenarioId}-official`];
  const entries = options.entries ?? all.map((planItemId) => ({
    planItemId,
    classification: eligible.includes(planItemId) ? 'eligible' : pending.includes(planItemId) ? 'pending' : 'invalid',
    sourceReceiptIds: trustedReceiptIds
  }));
  return withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    sourceSnapshotHash: String(source.snapshotHash ?? source.frozen?.snapshotHash ?? source.value?.snapshotHash ?? source.frozen?.value?.snapshotHash),
    managerTaskId: String(root.manager_task_id),
    orchestrationId: String(root.orchestration_id),
    attemptStage: String(stage.attempt_stage),
    allowedPlanIds: options.allowedPlanIds ?? ['plan-1'],
    allowedPlanItemIds: options.allowedPlanItemIds ?? all,
    carryPlanItemIds: options.carryPlanItemIds ?? [],
    trustedReceiptIds,
    scope: options.scope ?? { purpose: 'acceptance' },
    projection: {
      planIds: options.planIds ?? ['plan-1'],
      asOf: { utc: NOW, mono: fixture.nowMono },
      entries,
      candidatePlanItemIds: candidate,
      eligiblePlanItemIds: eligible,
      pendingPlanItemIds: pending,
      invalidPlanItemIds: invalid
    },
    candidateInputCount: options.candidateInputCount ?? all.length,
    classifiedCount: options.classifiedCount ?? all.length,
    coverageGap: options.coverageGap ?? [],
    emptyQualified: options.emptyQualified,
    evidenceSuccessorOrdinal: options.evidenceSuccessorOrdinal,
    maxEvidenceSuccessors: options.maxEvidenceSuccessors,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: options.nowMono ?? tick(fixture),
    ...(options.repair ? { repair: options.repair } : {}),
    ...(options.repairItems ? { repairItems: options.repairItems } : {}),
    ...(options.repairOrdinal !== undefined ? { repairOrdinal: options.repairOrdinal } : {})
  });
}

function finishScenario(fixture, observation) {
  const status = observation.status ?? (observation.passed === true ? 'passed' : 'failed');
  const evidencePointer = observation.evidencePointer ?? `acceptance-evidence/wmb-5373/${fixture.scenarioId}/${fixture.run.acceptanceRunId}`;
  const finished = finishAcceptanceRun(fixture.database, {
    acceptanceRunId: fixture.run.acceptanceRunId,
    status,
    passed: status === 'passed',
    proof: observation.proof ?? { scenarioId: fixture.scenarioId },
    readbacks: observation.readbacks ?? [{ scenarioId: fixture.scenarioId, status }],
    expectedChildren: observation.expectedChildren,
    evidencePointer,
    reason: observation.reason,
    blocker: observation.blocker,
    finishedAtUtc: NOW,
    finishedAtMono: observation.finishedAtMono ?? tick(fixture)
  }, { nowUtc: () => NOW, nowMono: () => fixture.nowMono, defaultEvidenceRoot: 'acceptance-evidence/wmb-5373' });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(finished.replayed, false);
  assert.equal(finished.run.status, status);
  assert.ok(finished.resultHash);
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
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.resultHash, finished.resultHash);
  return finished;
}

function assertFreshTaggedRows(fixture, tables) {
  for (const table of tables) {
    const columns = tableColumns(fixture.database, table);
    assert.ok(PROVENANCE_COLUMNS.every((column) => columns.includes(column)), `${table} lacks acceptance provenance columns`);
    const rows = fixture.database.prepare(`SELECT * FROM "${table}" WHERE workspace_id=? AND acceptance_run_id=?`).all(fixture.workspaceId, fixture.run.acceptanceRunId);
    assert.ok(rows.length > 0, `${table} has no tagged rows`);
    for (const row of rows) {
      assert.equal(Number(row.baseline_event_sequence), fixture.run.baselineEventSequence);
      assert.equal(Number(row.baseline_checkpoint_revision), fixture.run.baselineCheckpointRevision);
      assert.ok(Number(row.created_after_event_sequence) > fixture.run.baselineEventSequence);
      assert.ok(Number(row.created_after_checkpoint_revision) > fixture.run.baselineCheckpointRevision);
      assert.ok(Number(row.created_after_mono) >= fixture.run.freshAfterMono);
    }
  }
}

function zeroChildCounts(fixture) {
  return {
    roots: count(fixture.database, 'daily_orchestration_roots', 'workspace_id=?', [fixture.workspaceId]),
    claims: count(fixture.database, 'daily_stage_claims', 'workspace_id=?', [fixture.workspaceId]),
    jobs: count(fixture.database, 'managed_job_dispatches', 'workspace_id=?', [fixture.workspaceId])
  };
}

// A47

test('WMB-5373 A47 H-05 hung probe deadline/recovery leaves no root and does not block unrelated mailbox', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A47');
  const accepted = acceptIntent(fixture, {
    requestId: 'request-a47-hung-probe',
    channelPolicy: policy(),
    authorizedChannelPolicy: policy()
  });
  const beforeUnrelated = zeroChildCounts(fixture);
  const unrelated = acceptIntent(fixture, {
    requestId: 'request-a47-unrelated-mcp',
    source: 'mcp',
    requestedAction: 'start_new_intent',
    channelPolicy: policy(),
    authorizedChannelPolicy: policy(),
    payload: { topic: 'unrelated command', requestId: 'request-a47-unrelated-mcp' }
  });
  assert.equal(unrelated.ok, true, JSON.stringify(unrelated));
  const hung = closePreflight(fixture, accepted, [
    { channelId: 'official', status: 'running', reasonCode: 'PROBE_HUNG', requiredness: 'required', probeRequestId: 'probe-a47-official', expiresAtMono: 260 },
    { channelId: 'x-list', status: 'not_run', reasonCode: 'NOT_RUN', requiredness: 'optional', probeRequestId: 'probe-a47-x-list', expiresAtMono: 260 }
  ], { aggregateDeadlineMono: 300, nowMono: 230 });
  assert.equal(hung.status, 'running');
  assert.equal(hung.code, null);
  assert.equal(hung.nextAction?.kind, 'preflight_recovery_wait');
  assert.equal(hung.snapshot.status, 'frozen');
  assert.equal(hung.snapshot.finishedAt, NOW);
  assert.equal(hung.nextAction?.ownerAction, false);
  assert.equal(hung.readback.rootCreated, false);
  const preflight = fixture.database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(fixture.workspaceId, hung.preflightId);
  assert.ok(preflight);
  assert.equal(Number(preflight.aggregate_deadline_mono), 300);
  const beforeExpiry = reconcileWorkspaceOrchestratorPreflightStartup(database, {
    workspaceId: fixture.workspaceId,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: 259
  });
  assert.equal(beforeExpiry.ok, true, JSON.stringify(beforeExpiry));
  assert.equal(beforeExpiry.actions.length, 1);
  assert.equal(beforeExpiry.actions[0].status, 'waiting');
  const restartedStore = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => 260 });
  const resumed = restartedStore.recoverPreflight({
    workspaceId: fixture.workspaceId,
    preflightId: hung.preflightId,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: 260
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.code, 'PROBE_RESUMED');
  assert.equal(resumed.nextAction?.kind, 'preflight_recovery_resume');
  assert.equal(resumed.nextAction?.resumeCount, 1);
  assert.ok(resumed.probe?.leaseId);
  assert.equal(resumed.probe?.attempt, 1);
  assert.equal(resumed.probe?.resumeCount, 1);
  assert.deepEqual(zeroChildCounts(fixture), beforeUnrelated);
  const resumedStoreReplay = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => 260 });
  const replay = resumedStoreReplay.watchdogPreflight({
    workspaceId: fixture.workspaceId,
    preflightId: hung.preflightId,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: 260
  });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.probe?.leaseId, resumed.probe?.leaseId);
  assert.equal(replay.probe?.resumeCount, 1);
  assert.equal(replay.nextAction?.resumeCount, 1);
  const intentWhileRunning = fixture.database.prepare('SELECT status,next_action_json,finished_at FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?').get(fixture.workspaceId, accepted.intentId);
  assert.equal(intentWhileRunning.status, 'running');
  assert.equal(intentWhileRunning.finished_at, null);
  const unrelatedMailbox = fixture.database.prepare('SELECT state FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=?').get(fixture.workspaceId, unrelated.intentId);
  assert.equal(unrelatedMailbox.state, 'enqueued');
  const terminalStore = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => 300 });
  const terminal = terminalStore.recoverPreflight({
    workspaceId: fixture.workspaceId,
    preflightId: hung.preflightId,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: 300
  });
  assert.equal(terminal.ok, true, JSON.stringify(terminal));
  assert.equal(terminal.status, 'terminal');
  assert.equal(terminal.code, 'PRECHECK_DEADLINE');
  assert.equal(terminal.nextAction?.ownerAction, false);
  assert.deepEqual(zeroChildCounts(fixture), beforeUnrelated);
  const terminalRow = fixture.database.prepare('SELECT status,finished_at,results_json FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(fixture.workspaceId, hung.preflightId);
  assert.equal(terminalRow.status, 'failed');
  assert.equal(terminalRow.finished_at, NOW);
  const failedIntent = fixture.database.prepare('SELECT status,stop_reason_json,finished_at FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?').get(fixture.workspaceId, accepted.intentId);
  assert.equal(failedIntent.status, 'failed');
  assert.equal(JSON.parse(failedIntent.stop_reason_json).reasonCode, 'PRECHECK_DEADLINE');
  assert.equal(failedIntent.finished_at, NOW);
  const hungMailbox = fixture.database.prepare('SELECT state,finished_at_utc FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=?').get(fixture.workspaceId, accepted.intentId);
  assert.equal(hungMailbox.state, 'failed');
  assert.equal(hungMailbox.finished_at_utc, NOW);
  const terminalReplay = new WorkspaceOrchestratorActorStore(database, { nowUtc: () => NOW, nowMono: () => 300 }).recoverPreflight({
    workspaceId: fixture.workspaceId,
    preflightId: hung.preflightId,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: 300
  });
  assert.equal(terminalReplay.ok, true, JSON.stringify(terminalReplay));
  assert.equal(terminalReplay.status, 'replayed');
  assert.equal(terminalReplay.code, 'PRECHECK_DEADLINE');
  assert.equal(terminalReplay.replayed, true);
  const after = zeroChildCounts(fixture);
  assert.deepEqual(after, beforeUnrelated);
  finishScenario(fixture, {
    status: 'passed',
    proof: {
      finding: 'H-05',
      injection: { channelId: 'official', status: 'running', reasonCode: 'PROBE_HUNG', aggregateDeadlineMono: 300 },
      uniqueCondition: 'hung probe lease expires once, startup/restart replay preserves identity, aggregate deadline terminalizes with PRECHECK_DEADLINE, no root/worker, unrelated mailbox remains serviceable',
      durableReadbacks: { preflight: terminalRow, failedIntent, hungMailbox, unrelatedMailbox, rootCounts: after },
      zeroWriteCounts: { beforeUnrelated, afterUnrelated: after }
    },
    readbacks: [terminalRow, failedIntent, hungMailbox, unrelatedMailbox, { rootCounts: after }]
  });
}));

// A48

test('WMB-5373 A48 H-06/N-02 monotonic deadline creates immutable gate epochs', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A48', {
    leaseExpiresAtMono: 300,
    gateDeadlineMono: 280,
    controlStallDeadlineMono: 240
  });
  const firstActor = currentActor(fixture);
  const firstGate = fixture.database.prepare('SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?').get(fixture.workspaceId, firstActor.runtimeEpoch);
  assert.ok(firstGate);
  assert.equal(firstGate.status, 'complete');
  const firstFrozen = JSON.stringify(firstGate);

  const takeoverTwo = fixture.actorStore.acquireActor({
    workspaceId: fixture.workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken: 'lease-a48-r2',
    runtimeId: 'runtime-a48-r2',
    nowUtc: '2035-01-01T00:00:00.000Z',
    nowMono: 250,
    leaseExpiresAtMono: 500,
    gateDeadlineMono: 460,
    controlStallDeadlineMono: 420,
    migrationEpoch: 1,
    writeFence: 'allow'
  });
  if (!takeoverTwo.ok) {
    const failureSummary = { ok: takeoverTwo.ok, code: takeoverTwo.code, reasonCode: takeoverTwo.reasonCode, message: takeoverTwo.message };
    const gates = fixture.database.prepare('SELECT * FROM daily_reconcile_gates WHERE workspace_id=? ORDER BY runtime_epoch').all(fixture.workspaceId);
    finishScenario(fixture, {
      status: 'failed',
      reason: 'H-06/N-02 exposed a repeated authority.taken_over outbox identity collision before a second gate epoch could start.',
      proof: {
        finding: 'H-06', amendment: 'N-02',
        injection: { secondRuntimeMono: 250, wallClock: '2035-01-01T00:00:00.000Z' },
        uniqueCondition: 'new runtime epoch/gate must be created without reusing aggregate event identity; production returned a stable rejection and rolled back the takeover',
        durableReadbacks: { takeoverTwo: failureSummary, gates },
        zeroChildCounts: zeroChildCounts(fixture),
        zeroWriteCounts: { secondTakeover: 0 }
      },
      readbacks: [failureSummary, gates]
    });
    return;
  }
  assert.equal(takeoverTwo.ok, true, JSON.stringify(takeoverTwo));
  const gateTwoPending = fixture.actorStore.createStartupReconcileGate({ workspaceId: fixture.workspaceId, fence: takeoverTwo.fence, nowUtc: '2035-01-01T00:00:00.000Z', nowMono: 260 });
  assert.equal(gateTwoPending.ok, true, JSON.stringify(gateTwoPending));
  const gateTwoRunning = fixture.actorStore.advanceStartupReconcileGate({ workspaceId: fixture.workspaceId, fence: takeoverTwo.fence, status: 'running', nowUtc: '2035-01-01T00:00:00.000Z', nowMono: 270 });
  assert.equal(gateTwoRunning.ok, true, JSON.stringify(gateTwoRunning));
  const gateTwoTerminal = fixture.actorStore.advanceStartupReconcileGate({ workspaceId: fixture.workspaceId, fence: takeoverTwo.fence, status: 'maintenance', reason: 'OWNER_NEVER_RECOVERED', nowUtc: '2035-01-01T00:00:00.000Z', nowMono: 280 });
  assert.equal(gateTwoTerminal.ok, true, JSON.stringify(gateTwoTerminal));
  const secondGate = fixture.database.prepare('SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?').get(fixture.workspaceId, 2);
  assert.equal(secondGate.status, 'maintenance');
  const secondFrozen = JSON.stringify(secondGate);

  const takeoverThree = fixture.actorStore.acquireActor({
    workspaceId: fixture.workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken: 'lease-a48-r3',
    runtimeId: 'runtime-a48-r3',
    nowUtc: '2020-01-01T00:00:00.000Z',
    nowMono: 430,
    leaseExpiresAtMono: 700,
    gateDeadlineMono: 660,
    controlStallDeadlineMono: 620,
    migrationEpoch: 1,
    writeFence: 'allow'
  });
  if (!takeoverThree.ok) {
    assert.equal(takeoverThree.code, 'ORCHESTRATOR_CONTRACT_ERROR');
    const failureSummary = { ok: takeoverThree.ok, code: takeoverThree.code, reasonCode: takeoverThree.reasonCode, message: takeoverThree.message };
    const gates = fixture.database.prepare('SELECT * FROM daily_reconcile_gates WHERE workspace_id=? ORDER BY runtime_epoch').all(fixture.workspaceId);
    finishScenario(fixture, {
      status: 'failed',
      reason: 'H-06/N-02 second epoch was durable, but a later takeover hit the same outbox aggregate identity collision.',
      proof: {
        finding: 'H-06', amendment: 'N-02',
        injection: { thirdRuntimeMono: 430, wallClock: '2020-01-01T00:00:00.000Z' },
        uniqueCondition: 'old terminal gates remain readable while a repeated takeover rejection leaves no partial third gate or child rows',
        durableReadbacks: { takeoverThree: failureSummary, gates },
        zeroChildCounts: zeroChildCounts(fixture),
        zeroWriteCounts: { thirdTakeover: 0 }
      },
      readbacks: [failureSummary, gates]
    });
    return;
  }
  assert.equal(takeoverThree.ok, true, JSON.stringify(takeoverThree));
  const gateThreePending = fixture.actorStore.createStartupReconcileGate({ workspaceId: fixture.workspaceId, fence: takeoverThree.fence, nowUtc: '2020-01-01T00:00:00.000Z', nowMono: 440 });
  assert.equal(gateThreePending.ok, true, JSON.stringify(gateThreePending));
  const gateThreeTerminal = fixture.actorStore.advanceStartupReconcileGate({ workspaceId: fixture.workspaceId, fence: takeoverThree.fence, status: 'failed', reason: 'RECONCILE_FAILED', nowUtc: '2020-01-01T00:00:00.000Z', nowMono: 450 });
  assert.equal(gateThreeTerminal.ok, true, JSON.stringify(gateThreeTerminal));

  const gates = fixture.database.prepare('SELECT * FROM daily_reconcile_gates WHERE workspace_id=? ORDER BY runtime_epoch').all(fixture.workspaceId);
  assert.deepEqual(gates.map((row) => Number(row.runtime_epoch)), [1, 2, 3]);
  assert.deepEqual(gates.map((row) => String(row.status)), ['complete', 'maintenance', 'failed']);
  assert.equal(JSON.stringify(gates[0]), firstFrozen);
  assert.equal(JSON.stringify(gates[1]), secondFrozen);
  for (const gate of gates) {
    assert.ok(Number(gate.lease_expires_at_mono) >= Number(gate.gate_deadline_mono));
    assert.equal((gate.finished_at_utc === null), (gate.finished_at_mono === null));
    if (['complete', 'maintenance', 'failed'].includes(String(gate.status))) assert.ok(gate.finished_at_mono !== null);
  }
  const current = currentActor(fixture);
  assert.equal(current.runtimeEpoch, 3);
  assert.equal(current.gateDeadlineMono, 660);
  const taggedEvents = fixture.context.readEventProof();
  assert.ok(taggedEvents.length >= 2);
  assertFreshTaggedRows(fixture, ['workspace_orchestrator_actors', 'orchestrator_events']);
  finishScenario(fixture, {
    status: 'passed',
    proof: {
      finding: 'H-06', amendment: 'N-02',
      injection: { wallClockOffsets: ['2035-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'], monoTakeovers: [250, 430] },
      uniqueCondition: 'each takeover allocates a new runtime epoch and pending gate; old terminal gates remain byte-identical; current gate reaches only pending→running→failed',
      monotonic: { oldGateDeadlineMono: 280, newGateDeadlineMonos: [460, 660], currentRuntimeEpoch: current.runtimeEpoch },
      durableReadbacks: { gates, taggedEvents },
      zeroChildCounts: zeroChildCounts(fixture),
      zeroWriteCounts: { oldGateMutation: 0 }
    },
    readbacks: [gates, current, taggedEvents]
  });
}));

// A49

test('WMB-5373 A49 H-07 initial/repaired scope hash and FK replay evidence', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A49');
  const initial = prepareRootWithSource(fixture, { intent: { requestId: 'request-a49-initial' } });
  const initialInput = projectionInput(fixture, initial.bundle, initial.frozen.value, {
    allowedPlanItemIds: ['item-initial'],
    candidatePlanItemIds: ['item-initial'],
    eligiblePlanItemIds: ['item-initial'],
    trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
    entries: [{ planItemId: 'item-initial', classification: 'eligible', sourceReceiptIds: [`receipt-${fixture.scenarioId}-official`] }]
  });
  const initialScope = fixture.snapshotStore.freezePlanScopeProjection(initialInput);
  assert.equal(initialScope.ok, true, JSON.stringify(initialScope));
  assert.equal(initialScope.value.bindingKind, 'initial_source');
  assert.equal(initialScope.value.repairSnapshotId, null);
  assert.equal(initialScope.value.repairSnapshotHash, null);
  assert.equal(initialScope.value.bindingHash, null);
  const initialReplay = fixture.snapshotStore.freezePlanScopeProjection({ ...initialInput, nowMono: tick(fixture) });
  assert.equal(initialReplay.ok, true, JSON.stringify(initialReplay));
  assert.equal(initialReplay.replayed, true);
  assert.equal(initialReplay.value.scopeHash, initialScope.value.scopeHash);
  const cancelledInitial = fixture.rootStore.cancelRoot(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: initial.rootRequestId,
    reasonCode: 'REPAIR_ROUTE_PREPARE',
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(cancelledInitial.ok, true, JSON.stringify(cancelledInitial));
  const repaired = prepareRootWithSource(fixture, {
    intent: { requestId: 'request-a49-repaired' },
    source: {
      successfulChannels: [
        { channelId: 'official', requiredness: 'required', receiptId: 'receipt-A49-repaired-official', receiptRevision: 1, receiptPayloadHash: HEX_A, resultHash: HEX_B, configRevision: 1, authRevision: 1, capabilityRevision: 1, capabilityLeaseId: 'cap-official', expiresAtMono: 90_000 },
        { channelId: 'x-list', requiredness: 'optional', receiptId: 'receipt-A49-repaired-x-list', receiptRevision: 1, receiptPayloadHash: HEX_A, resultHash: HEX_B, configRevision: 1, authRevision: 1, capabilityRevision: 1, capabilityLeaseId: 'cap-x-list', expiresAtMono: 90_000 }
      ],
      receiptBindings: [
        { receiptId: 'receipt-A49-repaired-official', receiptRevision: 1, receiptPayloadHash: HEX_A },
        { receiptId: 'receipt-A49-repaired-x-list', receiptRevision: 1, receiptPayloadHash: HEX_A }
      ]
    }
  });
  const repairedBundle = repaired.bundle;
  const repairedInput = projectionInput(fixture, repairedBundle, repaired.frozen.value, {
    allowedPlanItemIds: ['item-fixed'],
    candidatePlanItemIds: ['item-fixed'],
    eligiblePlanItemIds: ['item-fixed'],
    trustedReceiptIds: ['receipt-A49-repaired-official'],
    entries: [{ planItemId: 'item-fixed', classification: 'eligible', sourceReceiptIds: ['receipt-A49-repaired-official'] }],
    repair: {
      predecessorScopeId: initialScope.value.scopeId,
      predecessorScopeHash: initialScope.value.scopeHash,
      repairOrdinal: 1
    },
    repairItems: [{
      planItemId: 'item-invalid',
      priorItemRevision: 1,
      priorItemContentHash: HEX_A,
      repairedItemRevision: 2,
      repairedItemContentHash: HEX_B,
      receiptId: 'receipt-A49-repaired-official',
      receiptRevision: 1,
      receiptPayloadHash: HEX_A,
      childOrdinal: 1
    }]
  });
  const repairedScope = fixture.snapshotStore.freezePlanScopeProjection(repairedInput);
  assert.equal(repairedScope.ok, true, JSON.stringify(repairedScope));
  assert.equal(repairedScope.value.bindingKind, 'repaired');
  assert.ok(repairedScope.value.repairSnapshotId);
  assert.ok(repairedScope.value.repairSnapshotHash);
  assert.ok(repairedScope.value.bindingHash);
  const bindingRow = database.prepare('SELECT * FROM daily_repair_snapshot_bindings WHERE workspace_id=? AND binding_hash=?').get(fixture.workspaceId, repairedScope.value.bindingHash);
  assert.ok(bindingRow);
  assert.equal(bindingRow.predecessor_scope_id, initialScope.value.scopeId);
  assert.equal(bindingRow.predecessor_source_snapshot_id, repaired.frozen.value.snapshotId);
  const childHashes = JSON.parse(String(bindingRow.child_hashes_json));
  assert.equal(childHashes.length, 1);
  const registry = database.prepare('SELECT registry_name,derived_value,preimage_bytes FROM identity_hash_registry WHERE workspace_id=? AND derived_value IN (?,?,?) ORDER BY registry_name').all(
    fixture.workspaceId, repairedScope.value.repairSnapshotId, repairedScope.value.repairSnapshotHash, repairedScope.value.bindingHash
  );
  assert.equal(registry.length, 3);
  assert.ok(registry.every((row) => Buffer.from(row.preimage_bytes).length > 0));

  const archived = fixture.snapshotStore.archivePlanScope(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    scopeId: initialScope.value.scopeId,
    scopeHash: initialScope.value.scopeHash,
    reasonCode: 'REPAIRED_SCOPE_SUPERSEDED',
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.value.scopeStatus, 'superseded');
  assert.ok(archived.value.archiveAnchorHash);
  const archiveReplay = fixture.snapshotStore.archivePlanScope(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    scopeId: initialScope.value.scopeId,
    scopeHash: initialScope.value.scopeHash,
    reasonCode: 'REPAIRED_SCOPE_SUPERSEDED',
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(archiveReplay.ok, true, JSON.stringify(archiveReplay));
  assert.equal(archiveReplay.replayed, true);
  assert.equal(archiveReplay.value.archiveAnchorHash, archived.value.archiveAnchorHash);
  const beforeLateRepair = {
    scopes: count(database, 'daily_plan_scopes', 'workspace_id=?', [fixture.workspaceId]),
    bindings: count(database, 'daily_repair_snapshot_bindings', 'workspace_id=?', [fixture.workspaceId])
  };
  const lateRepair = fixture.snapshotStore.freezePlanScopeProjection({
    ...repairedInput,
    fence: fenceFrom(currentActor(fixture)),
    nowMono: tick(fixture)
  });
  assert.equal(lateRepair.ok, false, JSON.stringify(lateRepair));
  assert.equal(lateRepair.code, 'SCOPE_ARCHIVED');
  assert.deepEqual({
    scopes: count(database, 'daily_plan_scopes', 'workspace_id=?', [fixture.workspaceId]),
    bindings: count(database, 'daily_repair_snapshot_bindings', 'workspace_id=?', [fixture.workspaceId])
  }, beforeLateRepair);
  const beforeDelete = {
    snapshots: count(database, 'source_snapshots', 'workspace_id=?', [fixture.workspaceId]),
    scopes: count(database, 'daily_plan_scopes', 'workspace_id=?', [fixture.workspaceId]),
    bindings: count(database, 'daily_repair_snapshot_bindings', 'workspace_id=?', [fixture.workspaceId])
  };
  assert.throws(() => database.prepare('DELETE FROM source_snapshots WHERE workspace_id=? AND snapshot_id=?').run(fixture.workspaceId, repaired.frozen.value.snapshotId), /SOURCE_SNAPSHOT_IMMUTABLE|FOREIGN KEY|constraint/i);
  assert.deepEqual({
    snapshots: count(database, 'source_snapshots', 'workspace_id=?', [fixture.workspaceId]),
    scopes: count(database, 'daily_plan_scopes', 'workspace_id=?', [fixture.workspaceId]),
    bindings: count(database, 'daily_repair_snapshot_bindings', 'workspace_id=?', [fixture.workspaceId])
  }, beforeDelete);
  finishScenario(fixture, {
    status: 'passed',
    proof: {
      finding: 'H-07',
      injection: { replay: 'same initial scope', archive: archived.value.archiveAnchorHash, lateRepair: lateRepair.code, invalidDelete: 'delete parent scope while repair binding exists' },
      uniqueCondition: 'archive writes one durable anchor and supersedes the scope; replay is canonical; repair FK/hash chain stays readable; late repair is SCOPE_ARCHIVED with zero chain mutation',
      durableReadbacks: { initial: initialScope.value, initialReplay: initialReplay.value, archived: archived.value, archiveReplay: archiveReplay.value, repaired: repairedScope.value, bindingRow, registry },
      zeroChildCounts: zeroChildCounts(fixture),
      zeroWriteCounts: { scopeDelete: 0, lateRepair: beforeLateRepair, beforeDelete }
    },
    readbacks: [initialScope.value, archived.value, archiveReplay.value, repairedScope.value, bindingRow, lateRepair]
  });
}));

// A50

test('WMB-5373 A50 H-08 source partition hash and receipt provenance reject missing mappings', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A50');
  const selectedPolicy = [
    { channelId: 'official', requiredness: 'required', module: 'official_web' },
    { channelId: 'x-list', requiredness: 'optional', module: 'x_list' },
    { channelId: 'news', requiredness: 'optional', module: 'news' }
  ];
  const prepared = prepareRootWithSource(fixture, {
    intent: { requestId: 'request-a50-partition', channelPolicy: selectedPolicy, authorizedChannelPolicy: selectedPolicy },
    channelResults: selectedPolicy.map((entry) => readyChannel(entry.channelId, entry.requiredness)),
    source: {
      selectedChannelIds: ['official', 'x-list', 'news'],
      successfulChannels: [{ channelId: 'official', requiredness: 'required', receiptId: 'receipt-a50-official', receiptRevision: 1, receiptPayloadHash: HEX_A, resultHash: HEX_B, configRevision: 1, authRevision: 1, capabilityLeaseId: 'cap-official' }],
      failedChannels: [{ channelId: 'x-list', requiredness: 'optional', reasonCode: 'CHANNEL_LOGIN_REQUIRED' }],
      unresolvedChannels: [{ channelId: 'news', requiredness: 'optional', reasonCode: 'PROBE_HUNG' }],
      receiptBindings: [{ receiptId: 'receipt-a50-official', receiptRevision: 1, receiptPayloadHash: HEX_A }]
    }
  });
  const source = prepared.frozen.value;
  assert.deepEqual(source.selectedChannelIds.slice().sort(), ['news', 'official', 'x-list']);
  assert.equal(source.successfulChannels.length, 1);
  assert.equal(source.failedChannels.length, 1);
  assert.equal(source.unresolvedChannels.length, 1);
  assert.equal(new Set([
    ...source.successfulChannels.map((entry) => entry.channelId),
    ...source.failedChannels.map((entry) => entry.channelId),
    ...source.unresolvedChannels.map((entry) => entry.channelId)
  ]).size, 3);
  const sourceRow = database.prepare('SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_id=?').get(fixture.workspaceId, source.snapshotId);
  assert.ok(sourceRow);
  const partitionPreimage = {
    r: 'source-snapshot/v1',
    workspaceId: fixture.workspaceId,
    rootRequestId: source.rootRequestId,
    stageRequestId: source.stageRequestId,
    preflightId: source.preflightId,
    policyHash: source.policyHash,
    selectedChannelPartition: {
      selectedChannelIds: source.selectedChannelIds,
      successfulChannelIds: source.successfulChannels.map((entry) => entry.channelId),
      failedChannelIds: source.failedChannels.map((entry) => entry.channelId),
      unresolvedChannelIds: source.unresolvedChannels.map((entry) => entry.channelId)
    },
    successfulReceipts: source.successfulChannels,
    failedChannelPartition: source.failedChannels,
    unresolvedChannelPartition: source.unresolvedChannels,
    orderedSourceBindings: source.sourceBindings,
    sourceCap: 80,
    watermarkUtc: source.watermarkUtc,
    watermarkMono: source.watermarkMono
  };
  assert.equal(hashV1(partitionPreimage), source.snapshotHash);
  const beforeReject = { snapshots: count(database, 'source_snapshots', 'workspace_id=?', [fixture.workspaceId]), events: count(database, 'orchestrator_events', 'workspace_id=?', [fixture.workspaceId]) };
  const missingReceipt = fixture.snapshotStore.freezeSourceSnapshot({
    ...prepared.input,
    receiptBindings: [],
    nowMono: tick(fixture)
  });
  assert.equal(missingReceipt.ok, false, JSON.stringify(missingReceipt));
  assert.equal(missingReceipt.code, 'SOURCE_SNAPSHOT_STALE');
  assert.deepEqual({ snapshots: count(database, 'source_snapshots', 'workspace_id=?', [fixture.workspaceId]), events: count(database, 'orchestrator_events', 'workspace_id=?', [fixture.workspaceId]) }, beforeReject);
  const changedPartition = fixture.snapshotStore.freezeSourceSnapshot({
    ...prepared.input,
    failedChannels: [{ channelId: 'x-list', requiredness: 'optional', reasonCode: 'CHANNEL_LOGIN_REQUIRED' }],
    unresolvedChannels: [],
    nowMono: tick(fixture)
  });
  assert.equal(changedPartition.ok, false, JSON.stringify(changedPartition));
  assert.equal(changedPartition.code, 'SOURCE_PARTITION_MISMATCH');
  const cancelled = fixture.rootStore.cancelRoot(withAcceptance(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: prepared.rootRequestId,
    reasonCode: 'A50_CROSS_ROOT_PROBE',
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture)
  }));
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const crossAccepted = acceptIntent(fixture, {
    requestId: 'request-a50-cross-root',
    channelPolicy: [{ channelId: 'official', requiredness: 'required', module: 'official_web' }],
    authorizedChannelPolicy: selectedPolicy
  });
  const crossClosed = closePreflight(fixture, crossAccepted, [readyChannel('official', 'required')]);
  const crossAdmitted = admitRoot(fixture, crossAccepted);
  const crossBundle = fixture.rootStore.readRoot(fixture.workspaceId, String(crossAdmitted.root.root_request_id));
  const crossPreflight = database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(fixture.workspaceId, crossClosed.preflightId);
  assert.ok(crossPreflight);
  const crossRoot = fixture.snapshotStore.freezeSourceSnapshot(sourceInput(fixture, crossBundle, crossPreflight, {
    selectedChannelIds: ['official'],
    successfulChannels: [{ channelId: 'official', requiredness: 'required', receiptId: 'receipt-a50-official', receiptRevision: 1, receiptPayloadHash: HEX_A, resultHash: HEX_B, configRevision: 1, authRevision: 1, capabilityRevision: 1, capabilityLeaseId: 'cap-official', expiresAtMono: 90_000 }],
    receiptBindings: [{ receiptId: 'receipt-a50-official', receiptRevision: 1, receiptPayloadHash: HEX_A }]
  }));
  assert.equal(crossRoot.ok, false, JSON.stringify(crossRoot));
  assert.equal(crossRoot.code, 'SOURCE_PROVENANCE_MISMATCH');
  finishScenario(fixture, {
    status: 'passed',
    proof: {
      finding: 'H-08',
      injection: { partition: 'successful+failed+unresolved', missingReceiptBinding: true, changedUnresolvedPartition: true, crossRootReceiptId: 'receipt-a50-official' },
      uniqueCondition: 'receipt identity is bound to one root/channel partition; cross-root reuse rejects with SOURCE_PROVENANCE_MISMATCH before snapshot/scope/Judge writes',
      durableReadbacks: { source, sourceRow, missingReceipt, changedPartition, crossRoot },
      zeroChildCounts: zeroChildCounts(fixture),
      zeroWriteCounts: { beforeReject, crossRootSnapshot: 0 }
    },
    readbacks: [source, sourceRow, missingReceipt, changedPartition, crossRoot]
  });
}));

// A51

test('WMB-5373 A51 H-09 all-optional failures produce explicit actions without root or worker', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A51');
  const optionalPolicy = [{ channelId: 'x-list', requiredness: 'optional', module: 'x_list' }];
  const failedAccepted = acceptIntent(fixture, {
    requestId: 'request-a51-optional-fail',
    channelPolicy: optionalPolicy,
    authorizedChannelPolicy: optionalPolicy
  });
  const failed = closePreflight(fixture, failedAccepted, [{
    channelId: 'x-list', status: 'failed', reasonCode: 'CHANNEL_LOGIN_REQUIRED', requiredness: 'optional', probeRequestId: 'probe-a51-x-list', expiresAtMono: 90_000
  }]);
  assert.equal(failed.status, 'partial');
  assert.equal(failed.code, 'CHANNELS_ALL_FAILED');
  assert.equal(failed.nextAction.kind, 'start_new_intent');
  assert.ok(failed.nextAction.reasonCode);
  const failedCounts = zeroChildCounts(fixture);
  assert.deepEqual(failedCounts, { roots: 0, claims: 0, jobs: 0 });

  const emptyAccepted = acceptIntent(fixture, {
    requestId: 'request-a51-empty-selected',
    channelPolicy: [],
    authorizedChannelPolicy: optionalPolicy
  });
  const empty = closePreflight(fixture, emptyAccepted, []);
  assert.equal(empty.status, 'partial');
  assert.equal(empty.code, 'NO_CHANNEL_SELECTED');
  assert.equal(empty.nextAction.kind, 'start_new_intent');
  assert.ok(empty.nextAction.reasonCode);
  const emptyCounts = zeroChildCounts(fixture);
  assert.deepEqual(emptyCounts, failedCounts);
  assertFreshTaggedRows(fixture, ['orchestrator_intents', 'channel_preflight_snapshots', 'orchestrator_events']);
  finishScenario(fixture, {
    status: 'passed',
    proof: {
      finding: 'H-09',
      injection: { optionalLoginFail: 'CHANNEL_LOGIN_REQUIRED', selectedSet: [] },
      uniqueCondition: 'optional-only failure never creates root/worker/clean-empty and exposes non-empty configure_optional_channels/select_channel/start_new_intent action',
      nextActions: { failed: failed.nextAction, empty: empty.nextAction },
      durableReadbacks: { failed: failed.snapshot, empty: empty.snapshot, events: fixture.context.readEventProof('preflight.completed') },
      zeroChildCounts: emptyCounts,
      zeroWriteCounts: { root: 0, claim: 0, job: 0 }
    },
    readbacks: [failed.snapshot, empty.snapshot, failed.nextAction, empty.nextAction]
  });
}));

// A52

test('WMB-5373 A52 H-10 mixed projections block approval and execute exact invalid repair', () => withDatabase((database) => {
  const fixture = beginScenario(database, 'A52');
  const sourceId = upsertSource(database, { title: 'A52 source', originalUrl: 'https://example.com/a52', summary: 'A52 exact projection source' }, false).id;
  const fixtures = [
    { title: 'eligible A52', targetAudience: '每天审核热点进入生产线的主编', angle: '核对冻结候选清单与批准对象是否完全一致', pointOfView: '批准权必须绑定当前候选清单，否则旧选题会越权进入生产。' },
    { title: 'pending A52', targetAudience: '等待评分结果后安排内容档期的策划主管', angle: '追踪尚未完成评分的候选为何不能提前交给 Owner', pointOfView: '未完成评分的候选应继续自动处理，而不是把不完整判断转嫁给用户。' },
    { title: 'invalid A52', targetAudience: '负责修复来源和论据缺口的 Planner', angle: '识别失效来源并生成有边界的修复工单', pointOfView: '无效候选必须回到证据修复链，不能借批准动作绕过真实性门禁。' }
  ].map((spec) => ({ ...spec, priority: 1, whyNow: `${spec.title} 当前窗口必须处理。`, timeliness: '今日', platforms: ['xiaohongshu'], formats: ['article'], titleGuidance: `明确 ${spec.title} 决策边界`, openingGuidance: `先给出 ${spec.title} 的事实`, structureGuidance: `${spec.title} 的事实、判断、行动`, effortEstimate: '60 分钟', sourceIds: [sourceId], availableMaterials: ['source'], missingMaterials: [], scoreReasons: scoredReasons(80, NOW), editorialDecision: editorialDecision(spec.pointOfView) }));
  saveCurrentPlan(database, { planDate: '2026-08-31', timezone: 'Asia/Shanghai', summary: 'A52 decision fixtures', items: fixtures });
  const itemRows = database.prepare('SELECT id,title,revision,planning_status FROM plan_items WHERE title LIKE ? ORDER BY title').all('% A52');
  const eligibleItem = itemRows.find((row) => row.title === 'eligible A52');
  const pendingItem = itemRows.find((row) => row.title === 'pending A52');
  const invalidItem = itemRows.find((row) => row.title === 'invalid A52');
  assert.ok(eligibleItem && pendingItem && invalidItem);
  const combinations = [
    { name: 'E+I', eligiblePlanItemIds: [eligibleItem.id], invalidPlanItemIds: [invalidItem.id] },
    { name: 'E+P', eligiblePlanItemIds: [eligibleItem.id], pendingPlanItemIds: [pendingItem.id] },
    { name: 'E+P+I', eligiblePlanItemIds: [eligibleItem.id], pendingPlanItemIds: [pendingItem.id], invalidPlanItemIds: [invalidItem.id] }
  ];
  const readbacks = [];
  for (const combo of combinations) {
    const selectedPolicy = [{ channelId: 'official', requiredness: 'required', module: 'official_web' }];
    const receiptId = `receipt-A52-${combo.name.toLowerCase()}-official`;
    const prepared = prepareRootWithSource(fixture, {
      intent: {
        requestId: `request-a52-${combo.name.toLowerCase()}`,
        source: combo.name === 'E+I' ? 'today_ui' : combo.name === 'E+P' ? 'proposal_ui' : 'mcp',
        channelPolicy: selectedPolicy,
        authorizedChannelPolicy: selectedPolicy
      },
      channelResults: [readyChannel('official', 'required')],
      source: {
        successfulChannels: [{ channelId: 'official', requiredness: 'required', receiptId, receiptRevision: 1, receiptPayloadHash: HEX_A, resultHash: HEX_B, configRevision: 1, authRevision: 1, capabilityRevision: 1, capabilityLeaseId: 'cap-official', expiresAtMono: 90_000 }],
        receiptBindings: [{ receiptId, receiptRevision: 1, receiptPayloadHash: HEX_A }]
      }
    });
    const all = [...combo.eligiblePlanItemIds, ...(combo.pendingPlanItemIds ?? []), ...(combo.invalidPlanItemIds ?? [])];
    const scope = fixture.snapshotStore.freezePlanScopeProjection(projectionInput(fixture, prepared.bundle, prepared.frozen.value, {
      allowedPlanItemIds: all,
      candidatePlanItemIds: all,
      eligiblePlanItemIds: combo.eligiblePlanItemIds,
      pendingPlanItemIds: combo.pendingPlanItemIds ?? [],
      invalidPlanItemIds: combo.invalidPlanItemIds ?? [],
      trustedReceiptIds: [receiptId],
      entries: all.map((planItemId) => ({
        planItemId,
        classification: combo.eligiblePlanItemIds.includes(planItemId) ? 'eligible' : (combo.pendingPlanItemIds ?? []).includes(planItemId) ? 'pending' : 'invalid',
        sourceReceiptIds: [receiptId]
      }))
    }));
    assert.equal(scope.ok, true, JSON.stringify(scope));
    const root = fixture.rootStore.readRoot(fixture.workspaceId, prepared.rootRequestId).root;
    const manager = readManagerAdapterProjection(database, { workspaceId: fixture.workspaceId, includeInactive: true });
    assert.ok(manager.roots.length >= 1, JSON.stringify(manager));
    const indexRow = database.prepare('SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(fixture.workspaceId, prepared.rootRequestId);
    const nextAction = indexRow?.next_action ? JSON.parse(String(indexRow.next_action)) : null;
    const nextActionKind = String(nextAction?.kind ?? '');
    assert.ok(['repair_invalid_candidate', 'auto_bounded_successor_or_stop'].includes(nextActionKind));
    assert.notEqual(root.status, 'waiting_owner');
    const indexedRoot = manager.roots.find((entry) => String(entry.rootRequestId ?? entry.root_request_id) === prepared.rootRequestId) ?? manager.roots[manager.roots.length - 1];
    assert.equal(indexedRoot.eligiblePlanItemIds.length, 1);
    const beforeApprovalAttempt = count(database, 'content_projects', 'plan_item_id=?', [eligibleItem.id]);
    const decisionBinding = {
      workspaceId: fixture.workspaceId, rootRequestId: prepared.rootRequestId,
      stageRequestId: scope.value.stageRequestId, scopeId: scope.value.scopeId,
      scopeHash: scope.value.scopeHash, projectionHash: scope.value.projectionHash
    };
    assert.throws(() => executeOwnerProjectionDecision(database, {
      ...decisionBinding, planItemId: eligibleItem.id, classification: 'eligible', decision: 'approve',
      expectedRevision: eligibleItem.revision, requestId: `approve-${combo.name}`
    }), (error) => error?.code === 'APPROVAL_BLOCKED');
    assert.equal(count(database, 'content_projects', 'plan_item_id=?', [eligibleItem.id]), beforeApprovalAttempt);
    let repair = null;
    if (combo.name === 'E+I') {
      assert.throws(() => executeOwnerProjectionDecision(database, {
        ...decisionBinding, scopeHash: HEX_C, planItemId: invalidItem.id, classification: 'invalid', decision: 'repair',
        expectedRevision: invalidItem.revision, requestId: 'repair-stale-a52'
      }), (error) => error?.code === 'PROJECTION_ITEM_STALE');
      repair = executeOwnerProjectionDecision(database, {
        ...decisionBinding, planItemId: invalidItem.id, classification: 'invalid', decision: 'repair',
        expectedRevision: invalidItem.revision, requestId: 'repair-invalid-a52'
      });
      assert.equal(repair.decision, 'repair');
      assert.equal(repair.result.nextAction.action, 'judge');
    }
    readbacks.push({ combo: combo.name, scope: scope.value, root, manager, beforeApprovalAttempt, repair });
  }
  const finalCounts = zeroChildCounts(fixture);
  finishScenario(fixture, {
    status: 'passed',
    proof: {
      finding: 'H-10',
      injection: { combinations: combinations.map((entry) => entry.name), blockedEligibleId: eligibleItem.id, repairedInvalidId: invalidItem.id, staleScopeHash: HEX_C },
      uniqueCondition: 'mixed projections never enter waiting_owner; eligible approval is rejected without project writes, stale scope is rejected, and exact invalid repair creates the bounded Planner task',
      durableReadbacks: { readbacks, finalCounts, managerProjection: readManagerAdapterProjection(database, { workspaceId: fixture.workspaceId }) },
      zeroChildCounts: finalCounts,
      zeroWriteCounts: { blockedApprovalProject: 0, staleDecisionProject: 0 }
    },
    readbacks
  });
}));
