import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateDatabase } from "../src/main/db/migrations.ts";
import {
  finishAcceptanceRun,
  readAcceptanceRun,
  startAcceptanceRun,
} from "../src/main/workspace-orchestrator-acceptance.ts";
import {
  WorkspaceOrchestratorActorStore,
  canonicalJsonV1,
  hashV1,
  readWorkspaceOrchestratorActor,
} from "../src/main/workspace-orchestrator-actor.ts";
import { WorkspaceOrchestratorRootStageStore } from "../src/main/workspace-orchestrator-root-stage.ts";
import { createWorkspaceOrchestratorResourceAdmissionStore } from "../src/main/workspace-orchestrator-resource-admission.ts";
import { createWorkspaceOrchestratorSnapshotStore } from "../src/main/workspace-orchestrator-snapshots.ts";
import {
  advanceWorkspaceRollback,
  confirmLegacyRuntimeDrain,
  readWorkspaceRollbackState,
  registerLegacyRuntimeInventory,
  requestWorkspaceRollback,
} from "../src/main/workspace-orchestrator-recovery.ts";
import {
  WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS,
  freezeWorkspaceOrchestratorProducerManifest,
  requireRegisteredOrchestratorProducer,
} from "../src/main/workspace-orchestrator-stage0.ts";

const NOW = "2026-08-31T08:00:00.000Z";
const BUILD_ID = "build-wmb-5373-a41-a46";
const MANIFEST_HASH = "d".repeat(64);
const SOURCE_COMMIT = "source-wmb-5373";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmb-5373-a41-a46-"));
  const database = migrateDatabase(path.join(directory, "wmb.db"));
  try {
    return work(database);
  } finally {
    database.close();
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  }
}

function count(database, table, where = "", params = []) {
  return Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM "${table}"${where ? ` WHERE ${where}` : ""}`,
      )
      .get(...params).count,
  );
}

function seedBuild(database) {
  database
    .prepare(
      `INSERT INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, 79, 0, 79, 81, 79, ?, ?, ?)`,
    )
    .run(
      BUILD_ID,
      SOURCE_COMMIT,
      HEX_A,
      HEX_B,
      MANIFEST_HASH,
      "J:/WMB/resources",
      NOW,
    );
}

function seedProducer(database, workspaceId, actor) {
  database
    .prepare(
      `INSERT INTO workspace_migration_state (
    workspace_id, migration_epoch, status, manifest_hash, schema_epoch, cutover_epoch,
    owner_runtime_epoch, fence_token_hash, write_fence, checkpoint_seq, before_hash,
    after_hash, started_at_utc, started_at_mono, finished_at_utc, finished_at_mono
  ) VALUES (?, 1, 'complete', ?, 79, 0, ?, ?, 'allow', 0, ?, ?, ?, 1, ?, 2)`,
    )
    .run(
      workspaceId,
      MANIFEST_HASH,
      actor.runtimeEpoch,
      HEX_A,
      HEX_A,
      HEX_B,
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO producer_registry (
    workspace_id, producer_id, build_id, migration_epoch, source_location, trigger,
    trigger_id, allowed_intent_kind, owner, replacement_route, write_tables,
    write_principal, authorizer_revision, process_image_path, resources_path,
    registry_entry_hash, enabled, census_hash, created_at
  ) VALUES (?, 'producer.acceptance', ?, 1, 'tests/wmb-5373-adversarial-a41-a46.test.mjs', 'owner', 'trigger.acceptance',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_acceptance_test',
    'auth-wmb-5373', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`,
    )
    .run(workspaceId, BUILD_ID, "registry-wmb-5373", "census-wmb-5373", NOW);
}

function seedFrozenCensus(database, workspaceId, manifest) {
  const insert = database.prepare(`INSERT INTO producer_registry (
    workspace_id, producer_id, build_id, migration_epoch, source_location, trigger,
    trigger_id, allowed_intent_kind, owner, replacement_route, write_tables,
    write_principal, authorizer_revision, process_image_path, resources_path,
    registry_entry_hash, enabled, census_hash, created_at
  ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of manifest.entries) {
    insert.run(
      workspaceId,
      entry.producerId,
      BUILD_ID,
      entry.sourceLocation,
      entry.trigger,
      entry.triggerId,
      entry.allowedIntentKind,
      entry.owner,
      entry.replacementRoute,
      JSON.stringify(entry.writeTables),
      entry.writePrincipal,
      entry.authorizerRevision,
      entry.processImagePath,
      entry.resourcesPath,
      entry.registryEntryHash,
      entry.enabled ? 1 : 0,
      entry.censusHash,
      NOW,
    );
  }
}

function attestation(runtimeEpoch, overrides = {}) {
  return {
    producerId: "producer.acceptance",
    registryEntryHash: "registry-wmb-5373",
    censusHash: "census-wmb-5373",
    triggerId: "trigger.acceptance",
    processId: "5373",
    processStartTimeUtc: NOW,
    processStartTimeMono: 1,
    processImagePath: "J:/WMB/WeMediaBuddy.exe",
    resourcesPath: "J:/WMB/resources",
    buildId: BUILD_ID,
    sourceCommit: SOURCE_COMMIT,
    packageHash: HEX_A,
    appAsarHash: HEX_B,
    schemaEpoch: 79,
    cutoverEpoch: 0,
    runtimeEpoch,
    writePrincipal: "wmb_acceptance_test",
    authorizerRevision: "auth-wmb-5373",
    ...overrides,
  };
}

function fenceFrom(actor) {
  return {
    workspaceId: actor.workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    checkpointRevision: actor.checkpointRevision,
  };
}

function beginScenario(database, scenarioId, options = {}) {
  const workspaceId =
    options.workspaceId ?? `wmb-5373-${scenarioId.toLowerCase()}`;
  const source = options.source ?? "today_ui";
  const rootMode = options.rootMode ?? "owner";
  const requestId = options.requestId ?? `request-${scenarioId.toLowerCase()}`;
  seedBuild(database);
  const actorStore = new WorkspaceOrchestratorActorStore(database, {
    nowUtc: () => NOW,
    nowMono: () => 100,
  });
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
    writeFence: "allow",
  });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  seedProducer(database, workspaceId, acquired.actor);
  const createdGate = actorStore.createStartupReconcileGate({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 110,
  });
  assert.equal(createdGate.ok, true, JSON.stringify(createdGate));
  const completedGate = actorStore.completeStartupReconcile({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 120,
  });
  assert.equal(completedGate.ok, true, JSON.stringify(completedGate));
  const started = startAcceptanceRun(
    database,
    {
      workspaceId,
      scenarioId,
      acceptanceRunId: `acceptance-run-wmb-5373-${scenarioId}`,
      acceptanceNamespace: `acceptance/wmb-5373/${scenarioId}`,
      scenarioInput: { scenarioId, workspaceId, source, rootMode, requestId },
      buildId: BUILD_ID,
      manifestHash: MANIFEST_HASH,
      startedAtUtc: NOW,
      startedAtMono: 200,
      freshAfterMono: 200,
    },
    {
      nowUtc: () => NOW,
      nowMono: () => 200,
      defaultEvidenceRoot: "acceptance-evidence/wmb-5373",
    },
  );
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.replayed, false);
  return {
    database,
    workspaceId,
    scenarioId,
    source,
    rootMode,
    requestId,
    actorStore,
    rootStore: new WorkspaceOrchestratorRootStageStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    }),
    resourceStore: createWorkspaceOrchestratorResourceAdmissionStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    }),
    snapshotStore: createWorkspaceOrchestratorSnapshotStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    }),
    context: started.context,
    run: started.run,
    nowMono: 210,
  };
}

function tick(fixture, delta = 10) {
  fixture.nowMono += delta;
  return fixture.nowMono;
}

function currentActor(fixture) {
  const actor = fixture.actorStore.readActor(fixture.workspaceId);
  assert.ok(actor);
  return actor;
}

function acceptanceInput(context, input) {
  return context.withAcceptance(input);
}

function policyRequiredOnly() {
  return [
    { channelId: "official", requiredness: "required", module: "official_web" },
  ];
}

function readyChannel(channelId = "official", requiredness = "required") {
  return {
    channelId,
    status: "ready",
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
    probeReceiptHash: HEX_A,
  };
}

function intentInput(fixture, overrides = {}) {
  const actor = currentActor(fixture);
  const source = overrides.source ?? fixture.source;
  const rootMode = overrides.rootMode ?? fixture.rootMode;
  const requestId = overrides.requestId ?? fixture.requestId;
  const payload = overrides.payload ?? {
    topic: "AI infrastructure",
    scenarioId: fixture.scenarioId,
    requestId,
  };
  const channelPolicy = overrides.channelPolicy ?? policyRequiredOnly();
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    businessDate: overrides.businessDate ?? "2026-08-31",
    source,
    rootMode,
    requestedAction: overrides.requestedAction ?? "full",
    requestId,
    producerId: overrides.producerId ?? "producer.acceptance",
    producerAttestation:
      overrides.producerAttestation ?? attestation(actor.runtimeEpoch),
    logicalInput: overrides.logicalInput ?? payload,
    payload,
    channelPolicy,
    authorizedChannelPolicy: overrides.authorizedChannelPolicy ?? channelPolicy,
    profileRevision: overrides.profileRevision ?? 7,
    priority: overrides.priority ?? 10,
    nowUtc: NOW,
    nowMono: overrides.nowMono ?? tick(fixture),
    fence: fenceFrom(actor),
    ...overrides,
  });
}

function closePreflight(fixture, accepted, channelResults, overrides = {}) {
  const closed = fixture.actorStore.closePreflight(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      intentId: accepted.intentId,
      requestId: accepted.requestId,
      profileRevision: overrides.profileRevision ?? 7,
      channelResults,
      nowUtc: NOW,
      nowMono: overrides.nowMono ?? tick(fixture),
      fence: fenceFrom(currentActor(fixture)),
      ...overrides,
    }),
  );
  assert.equal(closed.ok, true, JSON.stringify(closed));
  return closed;
}

function acceptAndClose(
  fixture,
  overrides = {},
  channelResults = [readyChannel("official")],
) {
  const accepted = fixture.actorStore.acceptIntent(
    intentInput(fixture, overrides),
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const closed = closePreflight(fixture, accepted, channelResults);
  return { accepted, closed };
}

function admitRoot(fixture, accepted, overrides = {}) {
  const admitted = fixture.rootStore.admitRoot(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      intentId: accepted.intentId,
      requestId: accepted.requestId,
      fence: fenceFrom(currentActor(fixture)),
      envelope: {
        executable: "node",
        argv: ["orchestrator-worker"],
        cwd: "J:/WMB",
        scenarioId: fixture.scenarioId,
      },
      nowUtc: NOW,
      nowMono: overrides.nowMono ?? tick(fixture),
      ...overrides,
    }),
  );
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  return admitted;
}

function sourceInput(fixture, rootBundle, preflight, options = {}) {
  const root = rootBundle.root;
  const receiptNamespace = String(root.root_request_id ?? root.rootRequestId).slice(0, 12);
  const stage =
    rootBundle.claims.find(
      (claim) => String(claim.attempt_stage ?? claim.attemptStage) !== "judge",
    ) ?? rootBundle.claims[0];
  assert.ok(root);
  assert.ok(stage);
  const selectedChannelIds =
    options.selectedChannelIds ??
    JSON.parse(String(preflight.selected_channels_json ?? "[]")).map((entry) =>
      String(entry.channelId ?? entry.channel_id ?? entry),
    );
  const preflightResults = JSON.parse(String(preflight.results_json ?? "[]"));
  const currentChannelFences =
    options.currentChannelFences ??
    selectedChannelIds.map((channelId) => {
      const result =
        preflightResults.find(
          (entry) => String(entry.channelId ?? entry.channel_id) === channelId,
        ) ?? {};
      return {
        ...result,
        channelId,
        profileRevision: Number(
          preflight.profile_revision ?? preflight.profileRevision,
        ),
        policyHash: String(preflight.policy_hash ?? preflight.policyHash),
        status: "ready",
        ready: true,
        revoked: false,
        authStatus: "ready",
        configStatus: "ready",
      };
    });
  const currentFenceEntries = Array.isArray(currentChannelFences)
    ? currentChannelFences
    : Object.entries(currentChannelFences).map(([channelId, value]) => ({
        ...value,
        channelId: value.channelId ?? channelId,
      }));
  const currentFenceByChannel = new Map(
    currentFenceEntries.map((entry) => [String(entry.channelId), entry]),
  );
  const successfulChannels = (
    options.successfulChannels ??
    selectedChannelIds.map((channelId) => ({
      channelId,
      requiredness: "required",
      receiptId: `receipt-${fixture.scenarioId}-${receiptNamespace}-${channelId}`,
      receiptRevision: 1,
      receiptPayloadHash: HEX_A,
      resultHash: HEX_B,
      configRevision: 1,
      authRevision: 1,
      capabilityLeaseId: `cap-${channelId}`,
    }))
  ).map((entry) => ({
    ...currentFenceByChannel.get(String(entry.channelId)),
    ...entry,
  }));
  const sourceBindings = options.sourceBindings ?? [
    {
      sourceId: `source-${fixture.scenarioId}-1`,
      sourceRevision: 1,
      sourceContentHash: HEX_C,
    },
  ];
  const receiptBindings =
    options.receiptBindings ??
    successfulChannels.map((entry) => ({
      receiptId: entry.receiptId,
      receiptRevision: entry.receiptRevision,
      receiptPayloadHash: entry.receiptPayloadHash,
    }));
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id ?? root.rootRequestId),
    rootGeneration: Number(root.root_generation ?? root.rootGeneration),
    rootInputHash: String(root.root_input_hash ?? root.rootInputHash),
    stageRequestId: String(stage.stage_request_id ?? stage.stageRequestId),
    scanAttemptId: String(stage.stage_request_id ?? stage.stageRequestId),
    preflightId: String(preflight.preflight_id ?? preflight.preflightId),
    policyHash: String(preflight.policy_hash ?? preflight.policyHash),
    profileRevision: Number(
      preflight.profile_revision ?? preflight.profileRevision,
    ),
    selectedChannelIds,
    currentChannelFences,
    successfulChannels,
    failedChannels: options.failedChannels ?? [],
    unresolvedChannels: options.unresolvedChannels ?? [],
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
    ...options.extra,
  });
}

function freezeSourceForRoot(
  fixture,
  accepted,
  closed,
  rootRequestId,
  options = {},
) {
  const before = fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId);
  assert.ok(before.root);
  const preflight = fixture.database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(fixture.workspaceId, closed.preflightId);
  assert.ok(preflight);
  const input = sourceInput(fixture, before, preflight, options);
  const result = fixture.snapshotStore.freezeSourceSnapshot(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  const bundle = fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId);
  assert.ok(bundle.root);
  return { result, bundle, preflight, input };
}

function handoffToJudge(fixture, frozen) {
  const root = frozen.bundle.root;
  const fClaim = frozen.bundle.claims.find(
    (claim) => String(claim.attempt_stage ?? claim.attemptStage) !== "judge",
  );
  assert.ok(root);
  assert.ok(fClaim);
  const result = fixture.rootStore.handoffToJudge(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      rootRequestId: String(root.root_request_id ?? root.rootRequestId),
      stageRequestId: String(fClaim.stage_request_id ?? fClaim.stageRequestId),
      expectedRootCheckpointRevision: Number(
        root.checkpoint_revision ?? root.checkpointRevision,
      ),
      expectedClaimRevision: Number(
        fClaim.claim_revision ?? fClaim.claimRevision,
      ),
      sourceSnapshotHash: String(frozen.result.value.snapshotHash),
      currentChannelFences: frozen.input.currentChannelFences,
      fence: fenceFrom(currentActor(fixture)),
      envelope: {
        executable: "node",
        argv: ["judge"],
        cwd: "J:/WMB",
        scenarioId: fixture.scenarioId,
      },
      nowUtc: NOW,
      nowMono: tick(fixture),
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function projectionInput(fixture, bundle, source, options = {}) {
  const root = bundle.root;
  const stage = options.stageRequestId
    ? bundle.claims.find(
        (claim) =>
          String(claim.stage_request_id ?? claim.stageRequestId) ===
          String(options.stageRequestId),
      )
    : (bundle.claims.find(
        (claim) =>
          String(claim.attempt_stage ?? claim.attemptStage) !== "judge",
      ) ?? bundle.claims[0]);
  assert.ok(root);
  assert.ok(stage);
  const candidate = options.candidatePlanItemIds ?? [];
  const eligible = options.eligiblePlanItemIds ?? [];
  const pending = options.pendingPlanItemIds ?? [];
  const invalid = options.invalidPlanItemIds ?? [];
  const all = [...eligible, ...pending, ...invalid];
  const trustedReceiptIds = options.trustedReceiptIds ?? source.receiptIds ?? source.value?.receiptIds ?? [];
  const entries =
    options.entries ??
    all.map((planItemId) => ({
      planItemId,
      classification: eligible.includes(planItemId)
        ? "eligible"
        : pending.includes(planItemId)
          ? "pending"
          : "invalid",
      sourceReceiptIds: trustedReceiptIds,
    }));
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id ?? root.rootRequestId),
    rootGeneration: Number(root.root_generation ?? root.rootGeneration),
    rootInputHash: String(root.root_input_hash ?? root.rootInputHash),
    stageRequestId: String(stage.stage_request_id ?? stage.stageRequestId),
    sourceSnapshotHash: String(
      options.sourceSnapshotHash ?? source.snapshotHash,
    ),
    sourceSnapshotStageRequestId: options.sourceSnapshotStageRequestId,
    managerTaskId: String(root.manager_task_id ?? root.managerTaskId),
    orchestrationId: String(root.orchestration_id ?? root.orchestrationId),
    attemptStage: String(stage.attempt_stage ?? stage.attemptStage),
    allowedPlanIds: options.allowedPlanIds ?? ["plan-1"],
    allowedPlanItemIds: options.allowedPlanItemIds ?? all,
    carryPlanItemIds: options.carryPlanItemIds ?? [],
    trustedReceiptIds,
    scope: options.scope ?? { purpose: "acceptance" },
    projection: {
      planIds: options.planIds ?? ["plan-1"],
      asOf: options.asOf ?? { utc: NOW, mono: fixture.nowMono },
      entries,
      candidatePlanItemIds: candidate,
      eligiblePlanItemIds: eligible,
      pendingPlanItemIds: pending,
      invalidPlanItemIds: invalid,
    },
    candidateInputCount: options.candidateInputCount ?? candidate.length,
    classifiedCount: options.classifiedCount ?? all.length,
    coverageGap: options.coverageGap ?? [],
    emptyQualified: options.emptyQualified,
    evidenceSuccessorOrdinal: options.evidenceSuccessorOrdinal,
    maxEvidenceSuccessors: options.maxEvidenceSuccessors,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: options.nowMono ?? tick(fixture),
  });
}

function jsonSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  return value;
}

function finishScenario(fixture, observation) {
  const status =
    observation.status ?? (observation.passed === true ? "passed" : "failed");
  const evidencePointer =
    observation.evidencePointer ??
    `acceptance-evidence/wmb-5373/${fixture.scenarioId}/${fixture.run.acceptanceRunId}`;
  const finished = finishAcceptanceRun(
    fixture.database,
    {
      acceptanceRunId: fixture.run.acceptanceRunId,
      status,
      passed: status === "passed",
      proof: jsonSafe(observation.proof ?? { scenarioId: fixture.scenarioId }),
      readbacks: jsonSafe(
        observation.readbacks ?? [{ scenarioId: fixture.scenarioId, status }],
      ),
      expectedChildren: observation.expectedChildren,
      evidencePointer,
      reason: observation.reason,
      blocker: observation.blocker,
      finishedAtUtc: NOW,
      finishedAtMono: observation.finishedAtMono ?? tick(fixture),
    },
    {
      nowUtc: () => NOW,
      nowMono: () => fixture.nowMono,
      defaultEvidenceRoot: "acceptance-evidence/wmb-5373",
    },
  );
  assert.equal(finished.ok, true);
  assert.equal(finished.replayed, false);
  assert.equal(finished.run.status, status);
  assert.ok(finished.resultHash);
  const persisted = readAcceptanceRun(
    fixture.database,
    fixture.run.acceptanceRunId,
  );
  assert.ok(persisted);
  assert.equal(persisted.status, status);
  assert.equal(persisted.resultHash, finished.resultHash);
  assert.equal(persisted.evidencePointer, evidencePointer);
  const replay = finishAcceptanceRun(
    fixture.database,
    {
      acceptanceRunId: fixture.run.acceptanceRunId,
      status,
      passed: status === "passed",
      proof: { replay: true },
      readbacks: [{ replay: true }],
      evidencePointer,
      blocker: status === "not_executed" ? observation.blocker : undefined,
      finishedAtUtc: NOW,
      finishedAtMono: tick(fixture),
    },
    {
      nowUtc: () => NOW,
      nowMono: () => fixture.nowMono,
      defaultEvidenceRoot: "acceptance-evidence/wmb-5373",
    },
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.resultHash, finished.resultHash);
  return finished;
}

function proofOf(
  scenarioId,
  finding,
  injection,
  uniqueCondition,
  durableReadbacks,
  zeroWriteCounts,
  extra = {},
) {
  return {
    scenarioId,
    finding,
    injection,
    uniqueCondition,
    durableReadbacks,
    zeroWriteCounts,
    ...extra,
  };
}

function prepareRootWithSource(fixture, options = {}) {
  const { accepted, closed } = acceptAndClose(
    fixture,
    options.intent ?? {},
    options.channelResults ?? [readyChannel("official")],
  );
  const admitted = admitRoot(fixture, accepted, options.root ?? {});
  const rootRequestId = String(
    admitted.root.root_request_id ?? admitted.root.rootRequestId,
  );
  const frozen = freezeSourceForRoot(
    fixture,
    accepted,
    closed,
    rootRequestId,
    options.source ?? {},
  );
  return { accepted, closed, admitted, rootRequestId, frozen };
}

// A41

test("WMB-5373 A41 producer census/attestation and cancellation reject dynamic writers", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A41");
    const manifest = freezeWorkspaceOrchestratorProducerManifest({
      buildId: BUILD_ID,
      sourceCommit: SOURCE_COMMIT,
      packageHash: HEX_A,
      appAsarHash: HEX_B,
      schemaEpoch: 79,
      cutoverEpoch: 0,
      authorizerRevision: "auth-wmb-5373",
      processImagePath: "J:/WMB/WeMediaBuddy.exe",
      resourcesPath: "J:/WMB/resources",
    });
    seedFrozenCensus(database, fixture.workspaceId, manifest);
    assert.equal(
      manifest.entries.length,
      WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.length,
    );
    assert.equal(
      new Set(manifest.entries.map((entry) => entry.producerId)).size,
      manifest.entries.length,
    );
    for (const entry of manifest.entries) {
      assert.equal(entry.censusHash, manifest.censusHash);
      assert.equal(
        requireRegisteredOrchestratorProducer(
          entry.producerId,
          entry.sourceLocation,
        ).producerId,
        entry.producerId,
      );
    }
    const censusRows = database
      .prepare(
        "SELECT producer_id,registry_entry_hash,census_hash,enabled FROM producer_registry WHERE workspace_id=? AND build_id=? ORDER BY producer_id",
      )
      .all(fixture.workspaceId, BUILD_ID);
    assert.equal(censusRows.length, manifest.entries.length + 1);
    assert.equal(
      censusRows.filter((row) => Number(row.enabled) === 1).length,
      manifest.entries.length + 1,
    );

    const beforeForged = {
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      roots: count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const forged = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "a41-forged-attestation",
        payload: { forged: true },
        logicalInput: { forged: true },
        producerAttestation: attestation(currentActor(fixture).runtimeEpoch, {
          triggerId: "trigger.acceptance:forged",
        }),
      }),
    );
    assert.equal(forged.ok, false, JSON.stringify(forged));
    assert.equal(forged.code, "CUTOVER_REQUIRED");
    const afterForged = {
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      roots: count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    assert.deepEqual(afterForged, beforeForged);

    const prepared = prepareRootWithSource(fixture, {
      intent: { requestId: "a41-valid-root" },
    });
    const cancelled = fixture.rootStore.cancelRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: prepared.rootRequestId,
        expectedRootCheckpointRevision: Number(
          fixture.rootStore.readRoot(
            fixture.workspaceId,
            prepared.rootRequestId,
          ).root.checkpoint_revision,
        ),
        reasonCode: "A41_CANCEL_DYNAMIC_WRITER",
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const cancelledBundle = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    assert.equal(cancelledBundle.root.status, "cancelled");
    const cancellationReason = String(
      cancelledBundle.index?.terminal_reason ??
        cancelledBundle.index?.terminalReason ??
        "",
    );
    assert.equal(cancellationReason, "A41_CANCEL_DYNAMIC_WRITER");
    const dispatch =
      cancelledBundle.dispatches.find(
        (entry) => String(entry.role_id ?? entry.roleId) === "reporter",
      ) ?? cancelledBundle.dispatches[0];
    assert.ok(dispatch);
    const beforeLate = {
      roots: count(
        database,
        "daily_orchestration_roots",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      claims: count(
        database,
        "daily_stage_claims",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      dispatches: count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
    };
    const late = fixture.resourceStore.settleTerminal(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        jobId: String(dispatch.job_id ?? dispatch.jobId),
        childIdentityKey: String(
          dispatch.child_identity_key ?? dispatch.childIdentityKey,
        ),
        operationRequestId: String(
          dispatch.operation_request_id ?? dispatch.operationRequestId,
        ),
        parentStageRequestId: String(
          dispatch.parent_stage_request_id ?? dispatch.parentStageRequestId,
        ),
        expectedParentClaimRevision: Number(
          dispatch.expected_parent_claim_revision ??
            dispatch.expectedParentClaimRevision ??
            0,
        ),
        terminalStatus: "succeeded",
        resultStatus: "succeeded",
        resultHash: HEX_B,
        result: { late: true },
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(late.ok, false, JSON.stringify(late));
    assert.equal(late.code, "TERMINAL_IMMUTABILITY_CONFLICT");
    const afterLate = {
      roots: count(
        database,
        "daily_orchestration_roots",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      claims: count(
        database,
        "daily_stage_claims",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      dispatches: count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
    };
    assert.deepEqual(afterLate, beforeLate);
    finishScenario(fixture, {
      passed: true,
      proof: proofOf(
        "A41",
        "frozen census covers every registered producer and post-cancel dynamic writer is rejected",
        {
          censusHash: manifest.censusHash,
          forgedAttestationCode: forged.code,
          cancellationReason,
          lateWriterCode: late.code,
        },
        {
          registryEntries: manifest.entries.length,
          rootRequestId: prepared.rootRequestId,
          cancelledState: cancelledBundle.root.status,
        },
        {
          forgedMailbox: 0,
          forgedIntents: 0,
          forgedRoots: 0,
          lateRootClaimDispatchWrites: 0,
        },
        {
          censusRows: censusRows.length,
          cancellation: cancelled.readback,
          lateWriter: late.readback,
          actor: currentActor(fixture),
        },
      ),
      readbacks: [manifest, forged, cancelled, late, cancelledBundle],
      expectedChildren: {
        required: [
          {
            table: "daily_orchestration_roots",
            count: 1,
            terminal: true,
            where: { root_request_id: prepared.rootRequestId },
          },
        ],
      },
    });
  }));

// A42

test("WMB-5373 A42 rollback barrier denies, drains, verifies compatibility, and atomically rebinds the current startup gate", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A42");
    const initialActor = currentActor(fixture);
    const initialGate = database
      .prepare(
        "SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?",
      )
      .get(fixture.workspaceId, initialActor.runtimeEpoch);
    assert.ok(initialGate);
    const inventoryInput = {
      workspaceId: fixture.workspaceId,
      resourceKind: "worker",
      resourceKey: "worker-a42",
      argv: ["worker", "--a42"],
      sessionKey: "session-a42",
      launchAttemptId: "launch-a42",
      cwd: "J:/WMB",
      pid: 42042,
      processStartTimeUtc: NOW,
      processStartTimeMono: 101,
      state: "running",
      fence: fenceFrom(initialActor),
      nowUtc: NOW,
      nowMono: tick(fixture),
    };
    const registered = registerLegacyRuntimeInventory(database, inventoryInput);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const rollback = requestWorkspaceRollback(database, {
      workspaceId: fixture.workspaceId,
      targetBuildManifestHash: MANIFEST_HASH,
      targetSchemaEpoch: 79,
      targetMinSupportedBuild: BUILD_ID,
      targetCutoverEpoch: 0,
      reason: "A42 compatibility rollback",
      fence: fenceFrom(currentActor(fixture)),
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(rollback.ok, true, JSON.stringify(rollback));
    assert.equal(rollback.status, "requested");
    assert.equal(currentActor(fixture).writeFence, "deny");
    const rollbackFence = rollback.fence;

    const fencing = advanceWorkspaceRollback(database, {
      workspaceId: fixture.workspaceId,
      rollbackEpoch: rollback.rollback.rollbackEpoch,
      status: "fencing",
      fence: rollback.fence,
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(fencing.ok, true, JSON.stringify(fencing));
    assert.equal(fencing.status, "fencing");
    assert.equal(currentActor(fixture).writeFence, "deny");
    const beforeDenied = {
      inventory: count(
        database,
        "workspace_legacy_runtime_inventory",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const denied = registerLegacyRuntimeInventory(database, {
      ...inventoryInput,
      resourceKey: "worker-a42-denied",
      launchAttemptId: "launch-a42-denied",
      fence: fencing.fence,
      nowMono: tick(fixture),
    });
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(denied.code, "WRITE_FENCE_DENIED");
    const afterDenied = {
      inventory: count(
        database,
        "workspace_legacy_runtime_inventory",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    assert.deepEqual(afterDenied, beforeDenied);

    const draining = advanceWorkspaceRollback(database, {
      workspaceId: fixture.workspaceId,
      rollbackEpoch: rollback.rollback.rollbackEpoch,
      status: "draining",
      fence: fencing.fence,
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(draining.ok, true, JSON.stringify(draining));
    assert.equal(draining.status, "draining");
    assert.equal(currentActor(fixture).writeFence, "deny");
    assert.equal(
      database
        .prepare(
          "SELECT state FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND inventory_id=?",
        )
        .get(fixture.workspaceId, registered.inventory.inventoryId).state,
      "draining",
    );
    const drained = confirmLegacyRuntimeDrain(database, {
      workspaceId: fixture.workspaceId,
      inventoryId: registered.inventory.inventoryId,
      exitConfirmed: true,
      processExited: true,
      closeConfirmed: true,
      sessionClosed: true,
      cleanupConfirmed: true,
      cwdCleaned: true,
      closeProofHash: HEX_A,
      cleanupProofHash: HEX_B,
      fence: draining.fence,
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(drained.ok, true, JSON.stringify(drained));
    assert.equal(drained.inventory.state, "cleaned");
    const verifying = advanceWorkspaceRollback(database, {
      workspaceId: fixture.workspaceId,
      rollbackEpoch: rollback.rollback.rollbackEpoch,
      status: "verifying",
      fence: drained.fence,
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(verifying.ok, true, JSON.stringify(verifying));
    assert.equal(verifying.status, "verifying");
    assert.equal(currentActor(fixture).writeFence, "deny");
    const gatePredecessor = database
      .prepare(
        "SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?",
      )
      .get(fixture.workspaceId, currentActor(fixture).runtimeEpoch);
    assert.ok(gatePredecessor);
    const complete = advanceWorkspaceRollback(database, {
      workspaceId: fixture.workspaceId,
      rollbackEpoch: rollback.rollback.rollbackEpoch,
      status: "complete",
      compatibility: true,
      fence: verifying.fence,
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(complete.ok, true, JSON.stringify(complete));
    assert.equal(complete.status, "complete");
    assert.equal(complete.event.replayed, false);
    assert.equal(complete.gateRebinding.applied, true);
    assert.equal(complete.gateRebinding.status, "complete");
    assert.equal(
      complete.gateRebinding.checkpointPredecessor,
      Number(gatePredecessor.checkpoint_revision),
    );
    const afterCompleteActor = currentActor(fixture);
    const afterCompleteGate = database
      .prepare(
        "SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?",
      )
      .get(fixture.workspaceId, afterCompleteActor.runtimeEpoch);
    assert.ok(afterCompleteGate);
    assert.equal(afterCompleteActor.writeFence, "allow");
    assert.equal(
      afterCompleteGate.runtime_epoch,
      afterCompleteActor.runtimeEpoch,
    );
    assert.equal(afterCompleteGate.owner_epoch, afterCompleteActor.ownerEpoch);
    assert.equal(afterCompleteGate.lease_token, afterCompleteActor.leaseToken);
    assert.equal(afterCompleteGate.status, "complete");
    assert.equal(
      afterCompleteGate.checkpoint_revision,
      afterCompleteActor.checkpointRevision,
    );
    assert.notEqual(
      afterCompleteGate.checkpoint_revision,
      Number(gatePredecessor.checkpoint_revision),
    );
    assert.equal(complete.gate.runtimeEpoch, afterCompleteActor.runtimeEpoch);
    assert.equal(complete.gate.ownerEpoch, afterCompleteActor.ownerEpoch);
    assert.equal(complete.gate.leaseToken, afterCompleteActor.leaseToken);
    assert.equal(complete.gate.status, "complete");
    assert.equal(
      complete.gate.checkpointRevision,
      afterCompleteActor.checkpointRevision,
    );
    assert.equal(
      count(database, "daily_reconcile_gates", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    const completeEventRow = database
      .prepare(
        "SELECT payload_json FROM orchestrator_events WHERE workspace_id=? AND event_id=?",
      )
      .get(fixture.workspaceId, complete.event.eventId);
    assert.ok(completeEventRow);
    const completeEventPayload = JSON.parse(
      String(completeEventRow.payload_json),
    );
    assert.equal(completeEventPayload.gateRebinding.applied, true);
    assert.equal(
      completeEventPayload.gateRebinding.current.checkpointRevision,
      afterCompleteActor.checkpointRevision,
    );

    const beforeStaleFence = {
      inventory: count(
        database,
        "workspace_legacy_runtime_inventory",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const staleFenceWrite = registerLegacyRuntimeInventory(database, {
      ...inventoryInput,
      resourceKey: "worker-a42-stale-fence",
      launchAttemptId: "launch-a42-stale-fence",
      fence: rollbackFence,
      nowMono: tick(fixture),
    });
    assert.equal(staleFenceWrite.ok, false, JSON.stringify(staleFenceWrite));
    assert.equal(staleFenceWrite.code, "EXECUTION_AUTHORIZATION_INVALID");
    const afterStaleFence = {
      inventory: count(
        database,
        "workspace_legacy_runtime_inventory",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    assert.deepEqual(afterStaleFence, beforeStaleFence);

    const beforePostRollback = {
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      inventory: count(
        database,
        "workspace_legacy_runtime_inventory",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
    };
    const restored = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "a42-post-rollback-allowed",
        source: "scheduler_0900",
        rootMode: "scheduler",
        requestedAction: "stage_d",
        payload: { afterRollback: true },
        logicalInput: { afterRollback: true },
      }),
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.status, "accepted");
    const afterPostRollback = {
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      inventory: count(
        database,
        "workspace_legacy_runtime_inventory",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
    };
    assert.equal(afterPostRollback.mailbox, beforePostRollback.mailbox + 1);
    assert.equal(afterPostRollback.intents, beforePostRollback.intents + 1);
    assert.equal(afterPostRollback.inventory, beforePostRollback.inventory);
    const postIntentActor = currentActor(fixture);
    const postIntentGate = database
      .prepare(
        "SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?",
      )
      .get(fixture.workspaceId, postIntentActor.runtimeEpoch);
    assert.equal(postIntentGate.status, "complete");
    assert.equal(
      postIntentGate.checkpoint_revision,
      postIntentActor.checkpointRevision,
    );

    const replayCheckpoint = postIntentActor.checkpointRevision;
    const completeReplay = advanceWorkspaceRollback(database, {
      workspaceId: fixture.workspaceId,
      rollbackEpoch: rollback.rollback.rollbackEpoch,
      status: "complete",
      fence: fenceFrom(postIntentActor),
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    assert.equal(completeReplay.ok, true, JSON.stringify(completeReplay));
    assert.equal(completeReplay.replayed, true);
    assert.equal(completeReplay.event.eventId, complete.event.eventId);
    assert.equal(currentActor(fixture).checkpointRevision, replayCheckpoint);
    assert.equal(completeReplay.gate.checkpointRevision, replayCheckpoint);
    const rollbackReadback = readWorkspaceRollbackState(database, {
      workspaceId: fixture.workspaceId,
      rollbackEpoch: rollback.rollback.rollbackEpoch,
    });
    assert.equal(rollbackReadback.status, "complete");
    finishScenario(fixture, {
      status: "passed",
      reason:
        "Rollback completion atomically rebinds the current complete startup gate to the post-rollback Actor checkpoint and admits the first legal intent.",
      proof: proofOf(
        "A42",
        "deny→drain→verify→compatibility proof completes with one current startup gate rebound to the post-rollback Actor checkpoint; stale pre-complete fences remain write-invalid while the first legal intent succeeds",
        {
          rollbackEpoch: rollback.rollback.rollbackEpoch,
          deniedCode: denied.code,
          staleFenceCode: staleFenceWrite.code,
          finalStatus: complete.status,
          postRollbackStatus: restored.status,
          replayed: completeReplay.replayed,
        },
        {
          denyBeforeDrain: true,
          drainBeforeVerify: true,
          compatibilityProof: true,
          actorGateCheckpointEqual: true,
          firstLegalIntentAccepted: true,
          completeReplayNoBump: true,
        },
        {
          deniedInventoryWrites: 0,
          deniedMailboxWrites: 0,
          deniedIntentWrites: 0,
          staleFenceInventoryWrites: 0,
          staleFenceMailboxWrites: 0,
          staleFenceIntentWrites: 0,
          postRollbackMailboxWrites: 1,
          postRollbackIntentWrites: 1,
        },
        {
          rollback: rollbackReadback,
          initialGate: initialGate,
          gatePredecessor,
          completeGate: complete.gate,
          gateRebinding: complete.gateRebinding,
          completeEvent: complete.event,
          staleFenceWrite,
          postRollback: restored,
          actor: currentActor(fixture),
        },
      ),
      readbacks: [
        rollback,
        denied,
        fencing,
        draining,
        drained,
        verifying,
        complete,
        completeReplay,
        rollbackReadback,
        staleFenceWrite,
        restored,
        beforeStaleFence,
        afterStaleFence,
        beforePostRollback,
        afterPostRollback,
      ],
    });
  }));

// A43

test("WMB-5373 A43 one hundred equivalent scheduler requests coalesce and mailbox stays monotonic through restart/backpressure", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A43", {
      source: "scheduler_0900",
      rootMode: "scheduler",
    });
    const coalescingKey = "scheduler-2026-08-31";
    const submitEquivalent = (requestId, index) =>
      fixture.actorStore.acceptIntent(
        intentInput(fixture, {
          requestId,
          source: "scheduler_0900",
          rootMode: "scheduler",
          requestedAction: "stage_d",
          payload: { schedulerWork: "same", date: "2026-08-31" },
          logicalInput: { schedulerWork: "same", date: "2026-08-31" },
          coalescingKey,
          coalescingMode: "equivalent_scheduler_work",
          priority: index === 0 ? 1 : 100,
        }),
      );
    const first = submitEquivalent("a43-equivalent-000", 0);
    assert.equal(first.ok, true, JSON.stringify(first));
    const afterFirst = count(
      database,
      "orchestrator_mailbox",
      "workspace_id=?",
      [fixture.workspaceId],
    );
    assert.equal(afterFirst, 1);
    const equivalentResults = [];
    for (let index = 1; index < 100; index += 1) {
      const result = submitEquivalent(
        `a43-equivalent-${String(index).padStart(3, "0")}`,
        index,
      );
      equivalentResults.push(result);
      assert.equal(result.ok, false, JSON.stringify(result));
    }
    assert.equal(
      count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    const restarted = new WorkspaceOrchestratorActorStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    });
    const replayed = restarted.acceptIntent(
      intentInput(fixture, {
        requestId: "a43-equivalent-000",
        source: "scheduler_0900",
        rootMode: "scheduler",
        requestedAction: "stage_d",
        payload: { schedulerWork: "same", date: "2026-08-31" },
        logicalInput: { schedulerWork: "same", date: "2026-08-31" },
        coalescingKey,
        coalescingMode: "equivalent_scheduler_work",
        priority: 1,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(replayed.ok, true, JSON.stringify(replayed));
    assert.equal(replayed.receiptId, first.receiptId);
    assert.equal(
      count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );

    for (let index = 0; index < 255; index += 1) {
      const fill = fixture.actorStore.acceptIntent(
        intentInput(fixture, {
          requestId: `a43-fill-${String(index).padStart(3, "0")}`,
          source: "scheduler_0900",
          rootMode: "scheduler",
          requestedAction: "stage_d",
          payload: { schedulerWork: "fill", index },
          logicalInput: { schedulerWork: "fill", index },
          coalescingKey: null,
          coalescingMode: "none",
          priority: index % 10,
          nowMono: tick(fixture),
        }),
      );
      assert.equal(fill.ok, true, JSON.stringify(fill));
    }
    assert.equal(
      count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      256,
    );
    const beforeBackpressure = {
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      roots: count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const backpressure = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "a43-backpressure-256",
        source: "scheduler_0900",
        rootMode: "scheduler",
        requestedAction: "stage_d",
        payload: { schedulerWork: "backpressure" },
        logicalInput: { schedulerWork: "backpressure" },
        coalescingKey: "a43-backpressure",
        coalescingMode: "equivalent_scheduler_work",
        priority: 200,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(backpressure.ok, false, JSON.stringify(backpressure));
    assert.equal(backpressure.code, "MAILBOX_BACKPRESSURE");
    const afterBackpressure = {
      mailbox: count(database, "orchestrator_mailbox", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intents: count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      roots: count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    assert.deepEqual(afterBackpressure, beforeBackpressure);
    const postRestart = new WorkspaceOrchestratorActorStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    });
    const backpressureAfterRestart = postRestart.acceptIntent(
      intentInput(fixture, {
        requestId: "a43-backpressure-after-restart",
        source: "scheduler_0900",
        rootMode: "scheduler",
        requestedAction: "stage_d",
        payload: { schedulerWork: "backpressure-after-restart" },
        logicalInput: { schedulerWork: "backpressure-after-restart" },
        coalescingKey: "a43-after-restart",
        coalescingMode: "equivalent_scheduler_work",
        priority: 200,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(
      backpressureAfterRestart.ok,
      false,
      JSON.stringify(backpressureAfterRestart),
    );
    assert.equal(backpressureAfterRestart.code, "MAILBOX_BACKPRESSURE");
    const sequences = database
      .prepare(
        "SELECT mailbox_sequence FROM orchestrator_mailbox WHERE workspace_id=? ORDER BY mailbox_sequence",
      )
      .all(fixture.workspaceId)
      .map((row) => Number(row.mailbox_sequence));
    assert.deepEqual(
      sequences,
      Array.from({ length: 256 }, (_, index) => index + 1),
    );
    finishScenario(fixture, {
      passed: true,
      proof: proofOf(
        "A43",
        "equivalent scheduler work has one durable mailbox entry, remains replay-idempotent after restart, and rejects at depth 256",
        {
          equivalentAttempts: 100,
          coalescedRejections: equivalentResults.length,
          backpressureCode: backpressure.code,
          backpressureAfterRestartCode: backpressureAfterRestart.code,
        },
        {
          firstMailboxSequence: first.mailboxSequence,
          mailboxDepth: sequences.length,
          sequenceMonotonic: true,
          replayReceiptId: replayed.receiptId,
        },
        {
          coalescedMailboxWrites: 0,
          coalescedIntentWrites: 0,
          backpressureMailboxWrites: 0,
          backpressureIntentWrites: 0,
          postRestartBackpressureMailboxWrites: 0,
        },
        {
          first,
          replayed,
          backpressure,
          backpressureAfterRestart,
          mailboxSequences: sequences.slice(0, 3).concat(sequences.slice(-3)),
          actor: currentActor(fixture),
        },
      ),
      readbacks: [
        first,
        replayed,
        backpressure,
        backpressureAfterRestart,
        {
          mailboxSequences: sequences,
          equivalentAttempts: equivalentResults.length,
        },
      ],
    });
  }));

// A44

test("WMB-5373 A44 Judge fairness promotes higher-priority waiting work and aged work without duplicate claims or dispatches", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A44");
    const first = prepareRootWithSource(fixture, {
      intent: {
        requestId: "a44-low-priority",
        source: "today_ui",
        rootMode: "owner",
        requestedAction: "full",
        priority: 1,
      },
      source: {
        sourceBindings: [
          {
            sourceId: "a44-low-source",
            sourceRevision: 1,
            sourceContentHash: HEX_C,
          },
        ],
      },
    });
    const firstHandoff = handoffToJudge(fixture, first.frozen);
    const firstBundle = fixture.rootStore.readRoot(
      fixture.workspaceId,
      first.rootRequestId,
    );
    const firstJudge = firstBundle.dispatches.find(
      (entry) => String(entry.role_id ?? entry.roleId) === "judge",
    );
    assert.ok(firstJudge);
    assert.equal(
      String(firstJudge.result_status ?? firstJudge.resultStatus ?? ""),
      "",
    );

    const second = prepareRootWithSource(fixture, {
      intent: {
        requestId: "a44-high-priority-interactive",
        source: "scheduler_0900",
        rootMode: "scheduler",
        requestedAction: "full",
        priority: 100,
      },
      source: {
        sourceBindings: [
          {
            sourceId: "a44-high-source",
            sourceRevision: 1,
            sourceContentHash: HEX_C,
          },
        ],
      },
    });
    const secondHandoff = handoffToJudge(fixture, second.frozen);
    const secondBundle = fixture.rootStore.readRoot(
      fixture.workspaceId,
      second.rootRequestId,
    );
    const secondJudge = secondBundle.dispatches.find(
      (entry) => String(entry.role_id ?? entry.roleId) === "judge",
    );
    assert.ok(secondJudge);
    assert.equal(
      String(secondJudge.result_status ?? secondJudge.resultStatus),
      "waiting_resource",
    );

    const scheduleInput = {
      workspaceId: fixture.workspaceId,
      fence: fenceFrom(currentActor(fixture)),
      nowUtc: NOW,
      nowMono: tick(fixture),
    };
    const scheduled = fixture.resourceStore.scheduleJudge(scheduleInput);
    assert.equal(scheduled.ok, true, JSON.stringify(scheduled));
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.reasonCode, "JUDGE_PREEMPTED_FOR_HIGHER_PRIORITY");
    assert.equal(scheduled.readback.activeJudgeCount, 1);
    assert.equal(
      scheduled.readback.activeJudgeJobId,
      String(secondJudge.job_id ?? secondJudge.jobId),
    );
    assert.deepEqual(scheduled.readback.orderedWaitingJudgeJobIds, [
      String(firstJudge.job_id ?? firstJudge.jobId),
    ]);

    const firstAfterSchedule = fixture.resourceStore.readDispatch({
      workspaceId: fixture.workspaceId,
      jobId: String(firstJudge.job_id ?? firstJudge.jobId),
    });
    const secondAfterSchedule = fixture.resourceStore.readDispatch({
      workspaceId: fixture.workspaceId,
      jobId: String(secondJudge.job_id ?? secondJudge.jobId),
    });
    assert.ok(firstAfterSchedule);
    assert.ok(secondAfterSchedule);
    assert.equal(firstAfterSchedule.state, "reserved");
    assert.equal(firstAfterSchedule.resultStatus, "waiting_resource");
    assert.equal(secondAfterSchedule.state, "reserved");
    assert.equal(secondAfterSchedule.resultStatus, null);

    const beforeReplay = {
      claims: count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      roots: count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const replay = fixture.resourceStore.scheduleJudge(scheduleInput);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, "waiting_resource");
    assert.equal(replay.reasonCode, "JUDGE_WAITING_BEHIND_ACTIVE");
    assert.deepEqual(replay.readback, scheduled.readback);
    assert.deepEqual(
      {
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        dispatches: count(
          database,
          "managed_job_dispatches",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        roots: count(database, "daily_orchestration_roots", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      beforeReplay,
    );

    const restartedStore = createWorkspaceOrchestratorResourceAdmissionStore(
      database,
      { nowUtc: () => NOW, nowMono: () => fixture.nowMono },
    );
    const restartReplay = restartedStore.scheduleJudge(scheduleInput);
    assert.equal(restartReplay.ok, true, JSON.stringify(restartReplay));
    assert.equal(restartReplay.replayed, true);
    assert.deepEqual(restartReplay.readback, scheduled.readback);

    const aged = restartedStore.scheduleJudge({
      ...scheduleInput,
      nowUtc: "2026-08-31T09:41:00.000Z",
      nowMono: tick(fixture),
    });
    assert.equal(aged.ok, true, JSON.stringify(aged));
    assert.equal(aged.status, "scheduled");
    assert.equal(aged.reasonCode, "JUDGE_PREEMPTED_FOR_HIGHER_PRIORITY");
    assert.equal(aged.readback.activeJudgeCount, 1);
    assert.equal(
      aged.readback.activeJudgeJobId,
      String(firstJudge.job_id ?? firstJudge.jobId),
    );
    assert.deepEqual(aged.readback.orderedWaitingJudgeJobIds, [
      String(secondJudge.job_id ?? secondJudge.jobId),
    ]);

    const firstFinal = restartedStore.readDispatch({
      workspaceId: fixture.workspaceId,
      jobId: String(firstJudge.job_id ?? firstJudge.jobId),
    });
    const secondFinal = restartedStore.readDispatch({
      workspaceId: fixture.workspaceId,
      jobId: String(secondJudge.job_id ?? secondJudge.jobId),
    });
    assert.ok(firstFinal);
    assert.ok(secondFinal);
    assert.equal(firstFinal.resultStatus, null);
    assert.equal(secondFinal.resultStatus, "waiting_resource");
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND role_id='judge' AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running') AND (result_status IS NULL OR result_status!='waiting_resource')",
        [fixture.workspaceId],
      ),
      1,
    );

    finishScenario(fixture, {
      status: "passed",
      reason:
        "Judge scheduling promotes strict priority winners, preserves replay identity, and eventually promotes aged waiting work.",
      proof: proofOf(
        "A44",
        "Judge fairness is durable and replay-safe",
        {
          firstPriority: 1,
          secondPriority: 100,
          firstJobId: firstJudge.job_id,
          secondJobId: secondJudge.job_id,
        },
        {
          immediatePromotion: true,
          replayStable: true,
          restartStable: true,
          agingPromotion: true,
          activeJudgeCount: aged.readback.activeJudgeCount,
        },
        { replayJudgeClaims: 0, replayJudgeDispatches: 0, replayRoots: 0 },
        {
          firstHandoff,
          secondHandoff,
          scheduled,
          replay,
          restartReplay,
          aged,
          firstFinal,
          secondFinal,
        },
      ),
      readbacks: [
        firstHandoff,
        secondHandoff,
        scheduled,
        replay,
        restartReplay,
        aged,
        firstFinal,
        secondFinal,
      ],
    });
  }));

// A45

test("WMB-5373 A45 eighty-source cap still permits one unique F-to-J handoff", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A45");
    const sourceBindings = Array.from({ length: 81 }, (_, index) => ({
      sourceId: `source-A45-${String(index).padStart(2, "0")}`,
      sourceRevision: 1,
      sourceContentHash: HEX_C,
    }));
    const prepared = prepareRootWithSource(fixture, {
      source: {
        selectedChannelIds: ["official"],
        sourceBindings,
        sourceIds: sourceBindings.map((entry) => entry.sourceId),
        successfulChannels: [
          {
            channelId: "official",
            requiredness: "required",
            receiptId: "receipt-A45-official",
            receiptRevision: 1,
            receiptPayloadHash: HEX_A,
            resultHash: HEX_B,
            configRevision: 1,
            authRevision: 1,
            capabilityLeaseId: "cap-official",
          },
        ],
        receiptBindings: [
          {
            receiptId: "receipt-A45-official",
            receiptRevision: 1,
            receiptPayloadHash: HEX_A,
          },
        ],
      },
    });
    const source = prepared.frozen.result.value;
    assert.equal(source.sourceBindings.length, 80);
    assert.equal(source.sourceIds.length, 80);
    assert.equal(source.excludedByBudgetCount, 1);
    assert.ok(!source.sourceIds.includes("source-A45-80"));
    const handoff = handoffToJudge(fixture, prepared.frozen);
    const afterHandoff = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    const fClaim = afterHandoff.claims.find(
      (claim) => String(claim.attempt_stage ?? claim.attemptStage) !== "judge",
    );
    const jClaims = afterHandoff.claims.filter(
      (claim) => String(claim.attempt_stage ?? claim.attemptStage) === "judge",
    );
    assert.equal(fClaim.status, "succeeded");
    assert.equal(jClaims.length, 1);
    const beforeReplay = {
      claims: count(
        database,
        "daily_stage_claims",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      dispatches: count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const replay = handoffToJudge(fixture, prepared.frozen);
    assert.equal(replay.status, "replayed");
    const afterReplay = {
      claims: count(
        database,
        "daily_stage_claims",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      dispatches: count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    assert.deepEqual(afterReplay, beforeReplay);
    finishScenario(fixture, {
      passed: true,
      proof: proofOf(
        "A45",
        "source cap excludes exactly one of eighty-one bindings while one F-to-J handoff remains unique",
        {
          sourceCountInput: sourceBindings.length,
          sourceCountFrozen: source.sourceBindings.length,
          excludedByBudgetCount: source.excludedByBudgetCount,
          handoff: handoff.status,
        },
        {
          rootRequestId: prepared.rootRequestId,
          fStatus: fClaim.status,
          judgeClaimCount: jClaims.length,
          replayed: replay.replayed,
        },
        { replayClaims: 0, replayDispatches: 0, replayEvents: 0 },
        {
          source,
          handoff,
          replay,
          root: afterHandoff.root,
          claims: afterHandoff.claims,
          dispatches: afterHandoff.dispatches,
        },
      ),
      readbacks: [source, handoff, replay, afterHandoff],
      expectedChildren: {
        required: [
          {
            table: "source_snapshots",
            count: 1,
            where: { stage_request_id: String(source.stageRequestId) },
          },
        ],
      },
    });
  }));

// A46

test("WMB-5373 A46 successor guard proves same-root strict-progress lifecycle", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A46");
    const prepared = prepareRootWithSource(fixture, {
      intent: { requestId: "a46-single-root" },
    });
    const firstInput = {
      ...projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          candidatePlanItemIds: ["a46-pending-1", "a46-pending-2"],
          eligiblePlanItemIds: [],
          pendingPlanItemIds: ["a46-pending-1", "a46-pending-2"],
          invalidPlanItemIds: [],
          allowedPlanItemIds: ["a46-pending-1", "a46-pending-2"],
          trustedReceiptIds: prepared.frozen.result.value.receiptIds,
          asOf: { utc: NOW, mono: fixture.nowMono },
        },
      ),
      progressAfter: {
        gapHash: HEX_A,
        orderedMissingEvidenceIds: ["a46-missing-1", "a46-missing-2"],
        orderedGapItemIds: ["a46-gap-1", "a46-gap-2"],
        orderedCandidatePlanItemIds: ["a46-pending-1", "a46-pending-2"],
      },
    };
    const projected =
      fixture.snapshotStore.freezePlanScopeProjection(firstInput);
    assert.equal(projected.ok, true, JSON.stringify(projected));
    assert.equal(projected.replayed, false);
    const predecessorMeasure = projected.value.progressAfter;
    assert.equal(projected.value.progressMeasureVersion, 2);
    assert.equal(projected.value.progressOrdinal, 0);
    assert.equal(projected.value.strictProgress, false);
    const rootAfterProjection = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    assert.equal(
      String(rootAfterProjection.root.root_request_id),
      prepared.rootRequestId,
    );
    assert.equal(String(rootAfterProjection.root.status), "running");
    const predecessorStageRequestId = projected.value.stageRequestId;
    const predecessorStage = rootAfterProjection.claims.find(
      (claim) => String(claim.stage_request_id) === predecessorStageRequestId,
    );
    assert.equal(String(predecessorStage.status), "partial");

    const successorInput = (predecessor, predecessorStageId, ordinal) => {
      const currentRoot = fixture.rootStore.readRoot(
        fixture.workspaceId,
        prepared.rootRequestId,
      );
      const currentPredecessor = currentRoot.claims.find(
        (claim) => String(claim.stage_request_id) === predecessorStageId,
      );
      return acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: prepared.rootRequestId,
        rootGeneration: Number(currentRoot.root.root_generation),
        rootInputHash: String(currentRoot.root.root_input_hash),
        predecessorStageRequestId: predecessorStageId,
        predecessorScopeId: predecessor.scopeId,
        predecessorScopeHash: predecessor.scopeHash,
        predecessorProjectionHash: predecessor.projectionHash,
        predecessorGapHash: predecessor.progressAfter.gapHash,
        sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
        progressOrdinal: ordinal,
        maxEvidenceSuccessors: 2,
        expectedRootCheckpointRevision: Number(
          currentRoot.root.checkpoint_revision,
        ),
        expectedClaimRevision: Number(currentPredecessor.claim_revision),
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      });
    };
    const successor = fixture.rootStore.createEvidenceSuccessor(
      successorInput(projected.value, predecessorStageRequestId, 1),
    );
    assert.equal(successor.ok, true, JSON.stringify(successor));
    assert.equal(successor.replayed, undefined);
    assert.equal(successor.readback.progressOrdinal, 1);
    assert.equal(String(successor.claim.attempt_stage), "research");
    assert.equal(String(successor.claim.status), "claimed");
    assert.equal(Number(successor.claim.is_active), 1);
    assert.equal(
      String(successor.claim.parent_stage_request_id),
      predecessorStageRequestId,
    );
    const successorSnapshot = JSON.parse(String(successor.claim.snapshot_json));
    assert.equal(successorSnapshot.stageFamily, "evidence_successor");
    assert.equal(
      successorSnapshot.sourceSnapshotHash,
      prepared.frozen.result.value.snapshotHash,
    );
    assert.equal(
      successorSnapshot.sourceSnapshotStageRequestId,
      predecessorStageRequestId,
    );
    assert.equal(
      successor.readback.dispatches.filter(
        (dispatch) =>
          String(dispatch.stage_request_id) ===
          String(successor.claim.stage_request_id),
      ).length,
      0,
    );
    const successorStageRequestId = String(successor.claim.stage_request_id);

    const beforeReplay = {
      identity: count(database, "identity_hash_registry", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      claims: count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const replay = fixture.rootStore.createEvidenceSuccessor(
      successorInput(projected.value, predecessorStageRequestId, 1),
    );
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "replayed");
    assert.equal(replay.readback.replay, true);
    assert.equal(
      String(replay.claim.stage_request_id),
      successorStageRequestId,
    );
    assert.deepEqual(
      {
        identity: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        dispatches: count(
          database,
          "managed_job_dispatches",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      beforeReplay,
    );

    const successorBundle = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    const noOpInput = {
      ...projectionInput(
        fixture,
        successorBundle,
        prepared.frozen.result.value,
        {
          stageRequestId: successorStageRequestId,
          sourceSnapshotStageRequestId: predecessorStageRequestId,
          candidatePlanItemIds: ["a46-pending-1", "a46-pending-2"],
          eligiblePlanItemIds: [],
          pendingPlanItemIds: ["a46-pending-1", "a46-pending-2"],
          invalidPlanItemIds: [],
          allowedPlanItemIds: ["a46-pending-1", "a46-pending-2"],
          trustedReceiptIds: prepared.frozen.result.value.receiptIds,
        },
      ),
      predecessorScopeId: projected.value.scopeId,
      predecessorScopeHash: projected.value.scopeHash,
      progressBefore: predecessorMeasure,
      evidenceSuccessorOrdinal: 1,
      progressAfter: {
        gapHash: HEX_A,
        orderedMissingEvidenceIds: ["a46-missing-1", "a46-missing-2"],
        orderedGapItemIds: ["a46-gap-1", "a46-gap-2"],
        orderedCandidatePlanItemIds: ["a46-pending-1", "a46-pending-2"],
      },
    };
    const beforeNoOp = {
      identity: count(database, "identity_hash_registry", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      claims: count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const noOp = fixture.snapshotStore.freezePlanScopeProjection(noOpInput);
    assert.equal(noOp.ok, false, JSON.stringify(noOp));
    assert.equal(noOp.code, "NO_BUSINESS_PROGRESS");
    assert.deepEqual(noOp.readback.progressBefore, predecessorMeasure);
    assert.equal(noOp.readback.progressAfter.gapHash, HEX_A);
    assert.equal(noOp.readback.strictProgress, false);
    assert.deepEqual(
      {
        identity: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        dispatches: count(
          database,
          "managed_job_dispatches",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      beforeNoOp,
    );

    const successorOneInput = {
      ...projectionInput(
        fixture,
        successorBundle,
        prepared.frozen.result.value,
        {
          stageRequestId: successorStageRequestId,
          sourceSnapshotStageRequestId: predecessorStageRequestId,
          candidatePlanItemIds: ["a46-pending-2"],
          eligiblePlanItemIds: [],
          pendingPlanItemIds: ["a46-pending-2"],
          invalidPlanItemIds: [],
          allowedPlanItemIds: ["a46-pending-2"],
          trustedReceiptIds: prepared.frozen.result.value.receiptIds,
        },
      ),
      predecessorScopeId: projected.value.scopeId,
      predecessorScopeHash: projected.value.scopeHash,
      progressBefore: predecessorMeasure,
      evidenceSuccessorOrdinal: 1,
      progressAfter: {
        gapHash: HEX_B,
        orderedMissingEvidenceIds: ["a46-missing-2"],
        orderedGapItemIds: ["a46-gap-2"],
        orderedCandidatePlanItemIds: ["a46-pending-2"],
      },
    };
    const positiveOne =
      fixture.snapshotStore.freezePlanScopeProjection(successorOneInput);
    assert.equal(positiveOne.ok, true, JSON.stringify(positiveOne));
    assert.equal(positiveOne.replayed, false);
    assert.equal(positiveOne.value.progressMeasureVersion, 2);
    assert.equal(positiveOne.value.progressOrdinal, 1);
    assert.equal(positiveOne.value.strictProgress, true);
    assert.equal(String(positiveOne.readback.root.status), "running");
    assert.equal(String(positiveOne.readback.stage.status), "partial");
    const successorOneStage = JSON.parse(
      String(positiveOne.readback.stage.snapshot_json),
    );
    assert.equal(successorOneStage.stageFamily, "evidence_successor");
    assert.equal(
      successorOneStage.sourceSnapshotHash,
      prepared.frozen.result.value.snapshotHash,
    );

    const beforeOverflow = {
      identity: count(database, "identity_hash_registry", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      claims: count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const limited = fixture.rootStore.createEvidenceSuccessor(
      successorInput(positiveOne.value, successorStageRequestId, 3),
    );
    assert.equal(limited.ok, false, JSON.stringify(limited));
    assert.equal(limited.code, "EVIDENCE_SUCCESSOR_LIMIT");
    assert.deepEqual(
      {
        identity: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        dispatches: count(
          database,
          "managed_job_dispatches",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      beforeOverflow,
    );

    const successorTwo = fixture.rootStore.createEvidenceSuccessor(
      successorInput(positiveOne.value, successorStageRequestId, 2),
    );
    assert.equal(successorTwo.ok, true, JSON.stringify(successorTwo));
    assert.equal(successorTwo.readback.progressOrdinal, 2);
    assert.equal(
      String(successorTwo.claim.parent_stage_request_id),
      successorStageRequestId,
    );
    const successorTwoStageRequestId = String(
      successorTwo.claim.stage_request_id,
    );

    const beforeReplayTwo = {
      identity: count(database, "identity_hash_registry", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      claims: count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      dispatches: count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const replayTwo = fixture.rootStore.createEvidenceSuccessor(
      successorInput(positiveOne.value, successorStageRequestId, 2),
    );
    assert.equal(replayTwo.ok, true, JSON.stringify(replayTwo));
    assert.equal(replayTwo.status, "replayed");
    assert.equal(replayTwo.readback.replay, true);
    assert.equal(
      String(replayTwo.claim.stage_request_id),
      successorTwoStageRequestId,
    );
    assert.deepEqual(
      {
        identity: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        scopes: count(database, "daily_plan_scopes", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        dispatches: count(
          database,
          "managed_job_dispatches",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      beforeReplayTwo,
    );

    const successorTwoBundle = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    const positiveTwoInput = {
      ...projectionInput(
        fixture,
        successorTwoBundle,
        prepared.frozen.result.value,
        {
          stageRequestId: successorTwoStageRequestId,
          sourceSnapshotStageRequestId: predecessorStageRequestId,
          candidatePlanItemIds: ["a46-eligible"],
          eligiblePlanItemIds: ["a46-eligible"],
          pendingPlanItemIds: [],
          invalidPlanItemIds: [],
          allowedPlanItemIds: ["a46-eligible"],
          trustedReceiptIds: prepared.frozen.result.value.receiptIds,
        },
      ),
      predecessorScopeId: positiveOne.value.scopeId,
      predecessorScopeHash: positiveOne.value.scopeHash,
      progressBefore: positiveOne.value.progressAfter,
      evidenceSuccessorOrdinal: 2,
      progressAfter: {
        gapHash: HEX_C,
        orderedMissingEvidenceIds: [],
        orderedGapItemIds: [],
        orderedCandidatePlanItemIds: ["a46-eligible"],
      },
    };
    const positiveTwo =
      fixture.snapshotStore.freezePlanScopeProjection(positiveTwoInput);
    assert.equal(positiveTwo.ok, true, JSON.stringify(positiveTwo));
    assert.equal(positiveTwo.replayed, false);
    assert.equal(positiveTwo.value.progressMeasureVersion, 2);
    assert.equal(positiveTwo.value.progressOrdinal, 2);
    assert.equal(positiveTwo.value.strictProgress, true);
    assert.equal(String(positiveTwo.readback.root.status), "waiting_owner");
    assert.equal(String(positiveTwo.readback.stage.status), "succeeded");
    const rootAfterPositive = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    assert.equal(String(rootAfterPositive.root.status), "waiting_owner");
    assert.equal(
      String(
        rootAfterPositive.claims.find(
          (claim) =>
            String(claim.stage_request_id) === successorTwoStageRequestId,
        ).status,
      ),
      "succeeded",
    );

    finishScenario(fixture, {
      status: "passed",
      reason:
        "A46 creates ordinal-one and ordinal-two same-root evidence successors, replays each identity without writes, rejects no-op and ordinal-three before writes, and commits strict progress through the frozen predecessor source snapshot.",
      proof: proofOf(
        "A46",
        "same-root evidence successor lifecycle is durable and strict-progress guarded through ordinal two",
        {
          successorStageRequestId,
          successorTwoStageRequestId,
          replayed: replay.readback.replay && replayTwo.readback.replay,
          noOpCode: noOp.code,
          limitedCode: limited.code,
          strictProgressOrdinalOne: positiveOne.value.strictProgress,
          strictProgressOrdinalTwo: positiveTwo.value.strictProgress,
        },
        {
          rootRequestId: prepared.rootRequestId,
          predecessorStageRequestId,
          sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
          finalRootStatus: rootAfterPositive.root.status,
        },
        {
          replayIdentityWrites: 0,
          replayScopeWrites: 0,
          replayClaimWrites: 0,
          replayDispatchWrites: 0,
          replayEventWrites: 0,
          noOpWrites: 0,
          overflowWrites: 0,
        },
        {
          projected,
          successor,
          replay,
          noOp,
          positiveOne,
          limited,
          successorTwo,
          replayTwo,
          positiveTwo,
          root: rootAfterPositive,
        },
      ),
      readbacks: [
        projected,
        successor,
        replay,
        noOp,
        positiveOne,
        limited,
        successorTwo,
        replayTwo,
        positiveTwo,
        rootAfterPositive,
      ],
      expectedChildren: {
        required: [
          {
            table: "source_snapshots",
            count: 1,
            where: { stage_request_id: predecessorStageRequestId },
          },
        ],
      },
    });
  }));
