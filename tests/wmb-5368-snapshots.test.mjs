import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateDatabase } from "../src/main/db/migrations.ts";
import {
  hashV1,
  WorkspaceOrchestratorActorStore,
} from "../src/main/workspace-orchestrator-actor.ts";
import { WorkspaceOrchestratorRootStageStore } from "../src/main/workspace-orchestrator-root-stage.ts";
import { createWorkspaceOrchestratorSnapshotStore } from "../src/main/workspace-orchestrator-snapshots.ts";

const NOW = "2026-08-30T10:00:00.000Z";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const BUILD_ID = "build-wmb-5368";

function withDatabase(work) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmb-5368-snapshots-"),
  );
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
        `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`,
      )
      .get(...params).count,
  );
}

function expectOk(result, label) {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
  return result;
}

function seedBuild(database) {
  database
    .prepare(
      `INSERT OR IGNORE INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, 79, 0, 79, 79, 79, ?, ?, ?)`,
    )
    .run(
      BUILD_ID,
      "source-wmb-5368",
      HEX_A,
      HEX_B,
      "manifest-wmb-5368",
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
      "manifest-wmb-5368",
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
  ) VALUES (?, 'producer.today', ?, 1, 'src/main/index.ts', 'owner', 'trigger.today',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_actor_store',
    'auth-v1', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`,
    )
    .run(workspaceId, BUILD_ID, "registry-wmb-5368", "census-wmb-5368", NOW);
}

function attestation(runtimeEpoch) {
  return {
    producerId: "producer.today",
    registryEntryHash: "registry-wmb-5368",
    censusHash: "census-wmb-5368",
    triggerId: "trigger.today",
    processId: "5368",
    processStartTimeUtc: NOW,
    processStartTimeMono: 1,
    processImagePath: "J:/WMB/WeMediaBuddy.exe",
    resourcesPath: "J:/WMB/resources",
    buildId: BUILD_ID,
    sourceCommit: "source-wmb-5368",
    packageHash: HEX_A,
    appAsarHash: HEX_B,
    schemaEpoch: 79,
    cutoverEpoch: 0,
    runtimeEpoch,
    writePrincipal: "wmb_actor_store",
    authorizerRevision: "auth-v1",
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

function compareCodePoints(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function sortedIds(values) {
  return [...values].sort(compareCodePoints);
}

function makeActorAndGate(database, workspaceId) {
  seedBuild(database);
  const actorStore = new WorkspaceOrchestratorActorStore(database, {
    nowUtc: () => NOW,
    nowMono: () => 100,
  });
  const acquired = actorStore.acquireActor({
    workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken: `lease-${workspaceId}`,
    runtimeId: `runtime-${workspaceId}`,
    nowUtc: NOW,
    nowMono: 100,
    leaseExpiresAtMono: 10_000,
    gateDeadlineMono: 9_000,
    controlStallDeadlineMono: 8_000,
    migrationEpoch: 1,
    writeFence: "allow",
  });
  expectOk(acquired, `actor acquisition for ${workspaceId}`);
  seedProducer(database, workspaceId, acquired.actor);
  const created = actorStore.createStartupReconcileGate({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 110,
  });
  expectOk(created, `startup gate creation for ${workspaceId}`);
  const completed = actorStore.completeStartupReconcile({
    workspaceId,
    fence: fenceFrom(actorStore.readActor(workspaceId)),
    nowUtc: NOW,
    nowMono: 120,
  });
  expectOk(completed, `startup gate completion for ${workspaceId}`);
  return actorStore;
}

function makeFixture(
  database,
  {
    workspaceId = "ws-snapshots",
    rootMode = "owner",
    includeOptional = false,
    optionalFailure = false,
  } = {},
) {
  const actorStore = makeActorAndGate(database, workspaceId);
  const policies = [
    { channelId: "official", requiredness: "required", module: "official_web" },
    ...(includeOptional
      ? [{ channelId: "x-list", requiredness: "optional", module: "x_list" }]
      : []),
  ];
  const actorBeforeIntent = actorStore.readActor(workspaceId);
  const requestId = `request-${workspaceId}`;
  const accepted = actorStore.acceptIntent({
    workspaceId,
    businessDate: "2026-08-30",
    source: "today_ui",
    rootMode,
    requestedAction: "full",
    requestId,
    producerId: "producer.today",
    producerAttestation: attestation(actorBeforeIntent.runtimeEpoch),
    logicalInput: { topic: "AI", requestId },
    payload: { topic: "AI", requestId },
    channelPolicy: policies,
    authorizedChannelPolicy: policies,
    profileRevision: 7,
    priority: 10,
    fence: fenceFrom(actorBeforeIntent),
    nowUtc: NOW,
    nowMono: 130,
  });
  expectOk(accepted, `intent acceptance for ${workspaceId}`);
  const channelResults = policies.map((policy) =>
    policy.channelId === "x-list" && optionalFailure
      ? {
          channelId: policy.channelId,
          status: "timeout",
          reasonCode: "NETWORK_TIMEOUT",
          checkedAtUtc: NOW,
          expiresAtUtc: "2026-08-30T10:00:30.000Z",
          expiresAtMono: 30_000,
          probeRequestId: `probe-${policy.channelId}`,
          probeReceiptHash: HEX_B,
        }
      : {
          channelId: policy.channelId,
          status: "ready",
          capability: { ok: true },
          configRevision: 1,
          authRevision: 1,
          capabilityRevision: 1,
          capabilityLeaseId: `cap-${policy.channelId}`,
          checkedAtUtc: NOW,
          expiresAtUtc: "2026-08-30T10:00:30.000Z",
          expiresAtMono: 30_000,
          probeRequestId: `probe-${policy.channelId}`,
          probeReceiptHash: HEX_A,
        },
  );
  const actorBeforePreflight = actorStore.readActor(workspaceId);
  const closed = actorStore.closePreflight({
    workspaceId,
    intentId: accepted.intentId,
    requestId,
    profileRevision: 7,
    channelResults,
    fence: fenceFrom(actorBeforePreflight),
    nowUtc: NOW,
    nowMono: 140,
  });
  expectOk(closed, `preflight close for ${workspaceId}`);
  assert.equal(closed.status, "admitted");

  const rootStore = new WorkspaceOrchestratorRootStageStore(database, {
    nowUtc: () => NOW,
    nowMono: () => 150,
  });
  const admitted = rootStore.admitRoot({
    workspaceId,
    intentId: accepted.intentId,
    fence: fenceFrom(actorStore.readActor(workspaceId)),
    nowUtc: NOW,
    nowMono: 150,
    envelope: {
      executable: "node",
      argv: ["scan"],
      cwd: "J:/WMB",
      source: "test",
    },
  });
  expectOk(admitted, `root admission for ${workspaceId}`);
  const root = database
    .prepare(
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    )
    .get(workspaceId, admitted.root.root_request_id);
  const stage = database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(workspaceId, admitted.claim.stage_request_id);
  const preflight = database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(workspaceId, closed.preflightId);
  return {
    database,
    workspaceId,
    actorStore,
    rootStore,
    snapshotStore: createWorkspaceOrchestratorSnapshotStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 300,
    }),
    accepted,
    closed,
    admitted,
    root,
    stage,
    preflight,
    selectedChannelIds: policies.map(({ channelId }) => channelId),
    optionalFailure,
  };
}

function currentRoot(database, fixture) {
  return database
    .prepare(
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    )
    .get(fixture.workspaceId, fixture.admitted.root.root_request_id);
}

function currentStage(database, fixture) {
  return database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(fixture.workspaceId, fixture.admitted.claim.stage_request_id);
}

function sourceInput(fixture, overrides = {}) {
  const root = currentRoot(fixture.database, fixture);
  const stage = currentStage(fixture.database, fixture);
  const selectedChannelIds =
    overrides.selectedChannelIds ?? fixture.selectedChannelIds;
  const preflightResults = JSON.parse(
    String(fixture.preflight.results_json ?? "[]"),
  );
  const currentChannelFences =
    overrides.currentChannelFences ??
    selectedChannelIds.map((channelId) => {
      const result =
        preflightResults.find(
          (entry) => String(entry.channelId ?? entry.channel_id) === channelId,
        ) ?? {};
      return {
        ...result,
        channelId,
        profileRevision: Number(fixture.preflight.profile_revision),
        policyHash: String(fixture.preflight.policy_hash),
        status: "ready",
        ready: true,
        revoked: false,
        authStatus: "ready",
        configStatus: "ready",
        configRevision: Number(result.configRevision ?? 1),
        authRevision: Number(result.authRevision ?? 1),
        capabilityRevision: Number(result.capabilityRevision ?? 1),
        capabilityLeaseId: String(
          result.capabilityLeaseId ?? `cap-${channelId}`,
        ),
        expiresAtMono: Number(result.expiresAtMono ?? 90_000),
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
    overrides.successfulChannels ?? [
      {
        channelId: "official",
        requiredness: "required",
        preflightId: fixture.closed.preflightId,
        scanAttemptId: fixture.admitted.claim.stage_request_id,
        receiptId: "receipt-official",
        receiptRevision: 1,
        receiptPayloadHash: HEX_A,
        resultHash: HEX_A,
        configRevision: 1,
        authRevision: 1,
        capabilityLeaseId: "cap-official",
      },
    ]
  ).map((entry) => ({
    ...currentFenceByChannel.get(String(entry.channelId)),
    ...entry,
  }));
  const failedChannels =
    overrides.failedChannels ??
    (fixture.optionalFailure
      ? [
          {
            channelId: "x-list",
            requiredness: "optional",
            reasonCode: "NETWORK_TIMEOUT",
            receiptId: null,
          },
        ]
      : []);
  const unresolvedChannels = overrides.unresolvedChannels ?? [];
  const sourceBindings = overrides.sourceBindings ?? [];
  const receiptIds =
    overrides.receiptIds ??
    successfulChannels.map((entry) => entry.receiptId).filter(Boolean);
  const receiptBindings =
    overrides.receiptBindings ??
    Object.fromEntries(
      receiptIds.map((receiptId) => [
        receiptId,
        {
          receiptRevision: 1,
          receiptPayloadHash: HEX_A,
          resultHash: HEX_A,
        },
      ]),
    );
  const base = {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    scanAttemptId: String(stage.stage_request_id),
    preflightId: String(fixture.preflight.preflight_id),
    policyHash: String(fixture.preflight.policy_hash),
    profileRevision: Number(fixture.preflight.profile_revision),
    selectedChannelIds,
    currentChannelFences,
    successfulChannels,
    failedChannels,
    unresolvedChannels,
    sourceBindings,
    receiptIds,
    receiptBindings,
    watermarkUtc: NOW,
    watermarkMono: 300,
    capturedAtUtc: NOW,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedClaimRevision: Number(stage.claim_revision),
    nowUtc: NOW,
    nowMono: 300,
  };
  return {
    ...base,
    ...overrides,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedClaimRevision: Number(
      currentStage(fixture.database, fixture).claim_revision,
    ),
  };
}

function freezeSource(fixture, overrides = {}) {
  return fixture.snapshotStore.freezeSourceSnapshot(
    sourceInput(fixture, overrides),
  );
}

function planInput(
  fixture,
  {
    eligible = [],
    pending = [],
    invalid = [],
    coverageGap = [],
    trustedReceiptIds = ["receipt-official"],
    scope = {},
  } = {},
) {
  const source = fixture.snapshotStore.readSourceSnapshot(
    fixture.workspaceId,
    fixture.admitted.claim.stage_request_id,
  );
  assert.ok(source, "plan fixture requires a frozen source snapshot");
  const stage = currentStage(fixture.database, fixture);
  const ids = sortedIds([...eligible, ...pending, ...invalid]);
  const classificationById = new Map([
    ...eligible.map((id) => [id, "eligible"]),
    ...pending.map((id) => [id, "pending"]),
    ...invalid.map((id) => [id, "invalid"]),
  ]);
  const entries = ids.map((planItemId) => ({
    planItemId,
    planId: "plan-1",
    planDate: "2026-08-30",
    origin: "today",
    itemRevision: 1,
    itemContentHash: HEX_A,
    sourceReceiptIds: ["receipt-official"],
    classification: classificationById.get(planItemId),
  }));
  return {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(fixture.admitted.root.root_request_id),
    rootGeneration: Number(fixture.admitted.root.root_generation),
    rootInputHash: String(fixture.admitted.root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    sourceSnapshotHash: String(source.snapshotHash),
    attemptStage: "judge",
    allowedPlanIds: ["plan-1"],
    allowedPlanItemIds: ids,
    carryPlanItemIds: [],
    trustedReceiptIds,
    scope,
    planIds: ["plan-1"],
    asOf: { utc: NOW, mono: 300 },
    entries,
    candidatePlanItemIds: ids,
    eligiblePlanItemIds: sortedIds(eligible),
    pendingPlanItemIds: sortedIds(pending),
    invalidPlanItemIds: sortedIds(invalid),
    coverageGap,
    candidateInputCount: ids.length,
    classifiedCount: ids.length,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedClaimRevision: Number(stage.claim_revision),
    nowUtc: NOW,
    nowMono: 310,
  };
}

function freezePlan(fixture, options = {}) {
  return fixture.snapshotStore.freezePlanScopeProjection(
    planInput(fixture, options),
  );
}

function stageDInput(fixture, overrides = {}) {
  const root = currentRoot(fixture.database, fixture);
  const stage = currentStage(fixture.database, fixture);
  const base = {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    orchestrationId: String(root.orchestration_id),
    cycleId: "cycle-1",
    targets: [],
    effects: [],
    coverage: "all",
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedClaimRevision: Number(stage.claim_revision),
    nowUtc: NOW,
    nowMono: 320,
  };
  return {
    ...base,
    ...overrides,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedClaimRevision: Number(
      currentStage(fixture.database, fixture).claim_revision,
    ),
  };
}

function target(targetId, contentHash = HEX_A) {
  return {
    targetId,
    targetRevision: 1,
    targetContentHash: contentHash,
    planItemId: `item-${targetId}`,
    planItemRevision: 1,
    planItemContentHash: HEX_A,
  };
}

function effect(effectLogicalKey, effectAttemptOrdinal = 1) {
  return {
    roleId: "writer",
    action: "publish",
    effectLogicalKey,
    effectAttemptOrdinal,
    sinkName: "wechat",
    sinkRoleId: "writer",
    sinkContractVersion: "1",
    deliveryMode: "exactly_once",
  };
}

function freezeStageD(fixture, overrides = {}) {
  return fixture.snapshotStore.freezeStageDTargetEffect(
    stageDInput(fixture, overrides),
  );
}

function terminalizeSourceDispatch(fixture, resultHash = HEX_A) {
  const job = fixture.database
    .prepare(
      "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(fixture.workspaceId, fixture.admitted.claim.stage_request_id);
  assert.ok(job, "effect fixture requires the root source dispatch");
  fixture.database
    .prepare(
      `UPDATE managed_job_dispatches
    SET state='terminal', result_status='succeeded', result_hash=?, result_json=?, updated_at=?, finished_at=?
    WHERE workspace_id=? AND job_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')`,
    )
    .run(
      resultHash,
      JSON.stringify({ resultHash }),
      NOW,
      NOW,
      fixture.workspaceId,
      job.job_id,
    );
  return fixture.database
    .prepare(
      "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND job_id=?",
    )
    .get(fixture.workspaceId, job.job_id);
}

function effectInput(fixture, stageD, overrides = {}) {
  const spec = stageD.effects[0];
  const dispatch = fixture.database
    .prepare(
      "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(fixture.workspaceId, fixture.admitted.claim.stage_request_id);
  const root = currentRoot(fixture.database, fixture);
  const stage = currentStage(fixture.database, fixture);
  const base = {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    effectRequestId: String(spec.effectRequestId),
    effectLogicalKey: String(spec.effectLogicalKey),
    effectSetHash: String(stageD.effectSetHash),
    roleId: String(spec.roleId),
    sinkName: String(spec.sinkName),
    sinkRoleId: String(spec.sinkRoleId),
    sinkContractVersion: String(spec.sinkContractVersion),
    deliveryMode: String(spec.deliveryMode),
    payloadHash: HEX_B,
    sourceDispatchJobId: String(dispatch.job_id),
    sourceResultHash: String(dispatch.result_hash),
    operationKind: "effect.consume",
    operationOrdinal: 1,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedStageClaimRevision: Number(stage.claim_revision),
    nowUtc: NOW,
    nowMono: 330,
  };
  return {
    ...base,
    ...overrides,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedStageClaimRevision: Number(
      currentStage(fixture.database, fixture).claim_revision,
    ),
  };
}

function settleInput(fixture, reserved, state, overrides = {}) {
  const stage = currentStage(fixture.database, fixture);
  const base = {
    workspaceId: fixture.workspaceId,
    consumptionId: String(reserved.consumptionId),
    operationRequestId: String(reserved.operationRequestId),
    effectRequestId: String(reserved.effectRequestId),
    effectToken: String(reserved.effectToken),
    state,
    outcome: state === "succeeded" ? { delivered: true } : undefined,
    payloadHash: String(reserved.payloadHash),
    sinkName: String(reserved.sinkName),
    sinkRoleId: String(reserved.sinkRoleId),
    sinkContractVersion: String(reserved.sinkContractVersion),
    deliveryMode: String(reserved.deliveryMode),
    expectedStageClaimRevision: Number(stage.claim_revision),
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    nowUtc: NOW,
    nowMono: 340,
  };
  return {
    ...base,
    ...overrides,
    fence: fenceFrom(fixture.actorStore.readActor(fixture.workspaceId)),
    expectedStageClaimRevision: Number(
      currentStage(fixture.database, fixture).claim_revision,
    ),
  };
}

test("WMB-5368 snapshots reject overlapping or incomplete required/optional source partitions", () =>
  withDatabase((database) => {
    const duplicate = makeFixture(database, {
      workspaceId: "ws-partition-duplicate",
      includeOptional: true,
    });
    const duplicateResult = freezeSource(duplicate, {
      failedChannels: [
        {
          channelId: "official",
          requiredness: "required",
          reasonCode: "RUNTIME_FAILED",
          receiptId: null,
        },
      ],
      unresolvedChannels: [
        {
          channelId: "x-list",
          requiredness: "optional",
          reasonCode: "NOT_RUN",
          receiptId: null,
        },
      ],
    });
    assert.equal(duplicateResult.ok, false);
    assert.equal(duplicateResult.code, "SOURCE_PARTITION_MISMATCH");
    assert.equal(
      count(database, "source_snapshots", "workspace_id=?", [
        duplicate.workspaceId,
      ]),
      0,
    );

    const incomplete = makeFixture(database, {
      workspaceId: "ws-partition-incomplete",
      includeOptional: true,
    });

    const incompleteResult = freezeSource(incomplete, {
      selectedChannelIds: ["official", "x-list"],
      failedChannels: [],
      unresolvedChannels: [],
    });
    assert.equal(incompleteResult.ok, false);
    assert.equal(incompleteResult.code, "SOURCE_PARTITION_MISMATCH");
    assert.equal(
      count(database, "source_snapshots", "workspace_id=?", [
        incomplete.workspaceId,
      ]),
      0,
    );
  }));

test("WMB-5368 snapshots cap sources at 80 with stable priority then sourceId ordering", () =>
  withDatabase((database) => {
    const fixture = makeFixture(database, { workspaceId: "ws-source-cap" });
    const bindings = Array.from({ length: 81 }, (_, index) => {
      const number = index + 1;
      return {
        sourceId: `source-${String(number).padStart(3, "0")}`,
        sourceRevision: 1,
        sourceContentHash: `content-${number}`,
        priority: number === 81 ? 100 : number % 2,
        channelId: "official",
        receiptId: "receipt-official",
      };
    }).reverse();
    const frozen = expectOk(
      freezeSource(fixture, {
        sourceBindings: bindings,
        excludedByBudgetCount: 1,
      }),
      "source cap freeze",
    );
    assert.equal(frozen.value.sourceIds.length, 80);
    assert.equal(frozen.value.excludedByBudgetCount, 1);
    assert.equal(frozen.value.sourceIds[0], "source-081");
    assert.deepEqual(
      frozen.value.sourceIds,
      bindings
        .slice()
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            compareCodePoints(left.sourceId, right.sourceId),
        )
        .slice(0, 80)
        .map(({ sourceId }) => sourceId),
    );

    assert.deepEqual(
      frozen.value.sourceBindings.map((binding) => binding.provenanceOrdinal),
      Array.from({ length: 80 }, (_, index) => index + 1),
    );
  }));

test("WMB-5368 snapshots reject stale source revision/content bindings before durable freeze", () =>
  withDatabase((database) => {
    const fixture = makeFixture(database, { workspaceId: "ws-source-stale" });
    const stale = freezeSource(fixture, {
      sourceBindings: [
        { sourceId: "source-1", sourceRevision: 2, sourceContentHash: HEX_A },
      ],
      currentSourceBindings: [
        { sourceId: "source-1", sourceRevision: 1, sourceContentHash: HEX_A },
      ],
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "SOURCE_SNAPSHOT_STALE");
    assert.equal(
      count(database, "source_snapshots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assert.equal(
      count(
        database,
        "identity_hash_registry",
        "workspace_id=? AND registry_name='source-snapshot/v1'",
        [fixture.workspaceId],
      ),
      0,
    );
  }));

test("WMB-5368 source snapshot is immutable: same hash replays and changed hash conflicts with zero writes", () =>
  withDatabase((database) => {
    const fixture = makeFixture(database, { workspaceId: "ws-source-replay" });
    const input = sourceInput(fixture, {
      sourceBindings: [
        { sourceId: "source-1", sourceRevision: 1, sourceContentHash: HEX_A },
      ],
    });
    const first = expectOk(
      fixture.snapshotStore.freezeSourceSnapshot(input),
      "initial source freeze",
    );
    const before = {
      snapshots: count(database, "source_snapshots"),
      registry: count(database, "identity_hash_registry"),
      events: count(database, "orchestrator_events"),
      snapshot: database
        .prepare(
          "SELECT snapshot_hash, captured_at_utc FROM source_snapshots WHERE workspace_id=?",
        )
        .get(fixture.workspaceId),
    };
    const replay = expectOk(
      fixture.snapshotStore.freezeSourceSnapshot(
        sourceInput(fixture, {
          sourceBindings: [
            {
              sourceId: "source-1",
              sourceRevision: 1,
              sourceContentHash: HEX_A,
            },
          ],
        }),
      ),
      "source replay",
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.snapshotHash, first.value.snapshotHash);
    assert.deepEqual(
      {
        snapshots: count(database, "source_snapshots"),
        registry: count(database, "identity_hash_registry"),
        events: count(database, "orchestrator_events"),
      },
      {
        snapshots: before.snapshots,
        registry: before.registry,
        events: before.events,
      },
    );

    const conflict = fixture.snapshotStore.freezeSourceSnapshot(
      sourceInput(fixture, {
        sourceBindings: [
          { sourceId: "source-1", sourceRevision: 1, sourceContentHash: HEX_B },
        ],
      }),
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "SOURCE_SNAPSHOT_STALE");
    assert.deepEqual(
      database
        .prepare(
          "SELECT snapshot_hash, captured_at_utc FROM source_snapshots WHERE workspace_id=?",
        )
        .get(fixture.workspaceId),
      before.snapshot,
    );
  }));

test("WMB-5368 PlanScope projection priority enforces all seven eligible/pending/invalid combinations", () =>
  withDatabase((database) => {
    const combinations = [
      {
        name: "eligible",
        eligible: ["item-e"],
        expectedRoot: "waiting_owner",
        expectedReason: "READY_FOR_OWNER_APPROVAL",
      },
      {
        name: "pending",
        pending: ["item-p"],
        expectedRoot: "running",
        expectedReason: "SCORING_INCOMPLETE",
      },
      {
        name: "invalid",
        invalid: ["item-i"],
        expectedRoot: "partial",
        expectedReason: "INVALID_NEEDS_REPAIR",
      },
      {
        name: "eligible-pending",
        eligible: ["item-e"],
        pending: ["item-p"],
        expectedRoot: "running",
        expectedReason: "SCORING_INCOMPLETE",
      },
      {
        name: "eligible-invalid",
        eligible: ["item-e"],
        invalid: ["item-i"],
        expectedRoot: "partial",
        expectedReason: "INVALID_NEEDS_REPAIR",
      },
      {
        name: "pending-invalid",
        pending: ["item-p"],
        invalid: ["item-i"],
        expectedRoot: "running",
        expectedReason: "SCORING_INCOMPLETE_AND_INVALID",
      },
      {
        name: "eligible-pending-invalid",
        eligible: ["item-e"],
        pending: ["item-p"],
        invalid: ["item-i"],
        expectedRoot: "running",
        expectedReason: "SCORING_INCOMPLETE_AND_INVALID",
      },
    ];
    for (const combination of combinations) {
      const fixture = makeFixture(database, {
        workspaceId: `ws-plan-${combination.name}`,
      });
      expectOk(
        freezeSource(fixture, {
          sourceBindings: [
            {
              sourceId: "source-1",
              sourceRevision: 1,
              sourceContentHash: HEX_A,
            },
          ],
        }),
        `${combination.name} source freeze`,
      );
      const result = expectOk(
        freezePlan(fixture, combination),
        `${combination.name} plan freeze`,
      );
      assert.equal(result.value.scopeStatus, "frozen");
      assert.equal(result.readback.root.status, combination.expectedRoot);
      assert.equal(
        result.readback.stage.status,
        combination.expectedRoot === "waiting_owner" ? "succeeded" : "partial",
      );
      assert.equal(
        result.readback.index.terminal_reason,
        combination.expectedReason,
      );
      assert.equal(
        result.value.projection.candidatePlanItemIds.length,
        (combination.eligible?.length ?? 0) +
          (combination.pending?.length ?? 0) +
          (combination.invalid?.length ?? 0),
      );

      assert.deepEqual(
        result.value.projection.eligiblePlanItemIds,
        sortedIds(combination.eligible ?? []),
      );
      assert.deepEqual(
        result.value.projection.pendingPlanItemIds,
        sortedIds(combination.pending ?? []),
      );
      assert.deepEqual(
        result.value.projection.invalidPlanItemIds,
        sortedIds(combination.invalid ?? []),
      );
    }
  }));

test("WMB-5368 clean-empty requires complete receipts, while optional coverage gap remains partial", () =>
  withDatabase((database) => {
    const empty = makeFixture(database, { workspaceId: "ws-clean-empty" });
    expectOk(freezeSource(empty), "clean-empty source freeze");
    const emptyResult = expectOk(freezePlan(empty), "clean-empty plan freeze");
    assert.equal(emptyResult.value.projection.emptyQualified, true);
    assert.equal(emptyResult.readback.root.status, "succeeded");
    assert.equal(
      emptyResult.readback.index.terminal_reason,
      "NO_ELIGIBLE_OPPORTUNITY",
    );
    assert.equal(emptyResult.readback.index.projection_state, "frozen");

    const gap = makeFixture(database, {
      workspaceId: "ws-coverage-gap",
      includeOptional: true,
      optionalFailure: true,
    });
    expectOk(freezeSource(gap), "coverage-gap source freeze");
    const gapResult = expectOk(freezePlan(gap), "coverage-gap plan freeze");
    assert.equal(gapResult.value.projection.emptyQualified, false);
    assert.equal(gapResult.readback.root.status, "partial");
    assert.equal(
      gapResult.readback.index.terminal_reason,
      "OPTIONAL_CHANNEL_COVERAGE_GAP",
    );
    const coverageGap = JSON.parse(
      String(gapResult.readback.intent.coverage_gap_json),
    );
    assert.equal(
      coverageGap.some((entry) => entry.channelId === "x-list"),
      true,
    );

    assert.equal(gapResult.readback.index.projection_state, "frozen");
  }));

test("WMB-5368 Stage-D no-current-targets is skipped and never reported as planner clean-empty", () =>
  withDatabase((database) => {
    for (const [workspaceId, rootMode, expectedRoot] of [
      ["ws-no-targets-scheduler", "scheduler", "succeeded"],
      ["ws-no-targets-owner", "owner", "partial"],
    ]) {
      const fixture = makeFixture(database, { workspaceId, rootMode });
      const result = expectOk(
        freezeStageD(fixture, { targets: [], effects: [] }),
        `${rootMode} no-target Stage-D freeze`,
      );
      assert.equal(result.value.targetSetHash.length, 64);
      assert.equal(result.value.effectSetHash.length, 64);
      assert.equal(currentStage(database, fixture).status, "skipped");
      assert.equal(result.readback.root.status, expectedRoot);
      assert.equal(result.readback.index.terminal_reason, "NO_CURRENT_TARGETS");
      assert.equal(
        result.readback.index.projection_state,
        rootMode === "scheduler" ? "not_applicable" : "absent",
      );
      assert.equal(result.readback.index.scope_hash, null);
      assert.equal(result.readback.index.projection_hash, null);
      assert.equal(result.readback.index.eligible_ids_hash, null);
      assert.equal(
        fixture.snapshotStore.readPlanScopeProjection(
          workspaceId,
          fixture.admitted.claim.stage_request_id,
        ),
        null,
      );
    }
  }));

test("WMB-5368 Stage-D freezes sorted target/effect identities and rejects target drift without writes", () =>
  withDatabase((database) => {
    const fixture = makeFixture(database, {
      workspaceId: "ws-stage-d-identity",
    });
    const targets = [target("target-b"), target("target-a")];
    const effects = [effect("publish:2", 2), effect("publish:1", 1)];
    const frozen = expectOk(
      freezeStageD(fixture, { targets, effects }),
      "Stage-D identity freeze",
    );
    assert.deepEqual(
      frozen.value.targets.map((entry) => entry.targetId),
      ["target-a", "target-b"],
    );
    assert.deepEqual(
      frozen.value.effects.map((entry) => entry.effectLogicalKey),
      ["publish:1", "publish:2"],
    );
    assert.equal(
      frozen.value.effects.every(
        (entry) =>
          typeof entry.effectRequestId === "string" &&
          entry.effectRequestId.length === 64,
      ),
      true,
    );
    assert.equal(
      count(
        database,
        "identity_hash_registry",
        "workspace_id=? AND registry_name IN ('target-set/v1','effect-set/v1','effect/v2')",
        [fixture.workspaceId],
      ),
      4,
    );

    const before = {
      claims: count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      registry: count(database, "identity_hash_registry", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const replay = expectOk(
      freezeStageD(fixture, { targets, effects }),
      "Stage-D replay",
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      {
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        registry: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      before,
    );

    const drift = freezeStageD(fixture, {
      targets: [target("target-a", HEX_B), target("target-b")],
      effects,
    });
    assert.equal(drift.ok, false);
    assert.equal(drift.code, "TARGET_SNAPSHOT_STALE");
    assert.deepEqual(
      {
        claims: count(database, "daily_stage_claims", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        registry: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      before,
    );
  }));

test("WMB-5368 effect token uses canonical identity and replays without accepting sink/payload drift", () =>
  withDatabase((database) => {
    const fixture = makeFixture(database, { workspaceId: "ws-effect-replay" });
    const stageD = expectOk(
      freezeStageD(fixture, {
        targets: [target("target-a")],
        effects: [effect("publish", 1)],
      }),
      "effect Stage-D freeze",
    ).value;
    const dispatch = terminalizeSourceDispatch(fixture);
    const first = expectOk(
      fixture.snapshotStore.reserveEffectConsumption(
        effectInput(fixture, stageD),
      ),
      "effect reserve",
    );
    const spec = stageD.effects[0];
    assert.equal(
      first.value.effectToken,
      hashV1({
        r: "sink-token/v2",
        workspaceId: fixture.workspaceId,
        effectRequestId: spec.effectRequestId,
        roleId: spec.roleId,
        sinkName: spec.sinkName,
        sinkContractVersion: spec.sinkContractVersion,
        deliveryMode: spec.deliveryMode,
        payloadHash: HEX_B,
      }),
    );
    assert.equal(first.value.sourceDispatchJobId, dispatch.job_id);
    const before = {
      consumptions: count(
        database,
        "managed_effect_consumptions",
        "workspace_id=?",
        [fixture.workspaceId],
      ),
      registry: count(database, "identity_hash_registry", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      events: count(database, "orchestrator_events", "workspace_id=?", [
        fixture.workspaceId,
      ]),
    };
    const replay = expectOk(
      fixture.snapshotStore.reserveEffectConsumption(
        effectInput(fixture, stageD, {
          operationRequestId: first.value.operationRequestId,
          effectToken: first.value.effectToken,
        }),
      ),
      "effect canonical replay",
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.effectToken, first.value.effectToken);
    assert.deepEqual(
      {
        consumptions: count(
          database,
          "managed_effect_consumptions",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        registry: count(database, "identity_hash_registry", "workspace_id=?", [
          fixture.workspaceId,
        ]),
        events: count(database, "orchestrator_events", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
      before,
    );

    const drift = fixture.snapshotStore.reserveEffectConsumption(
      effectInput(fixture, stageD, {
        operationRequestId: first.value.operationRequestId,
        payloadHash: HEX_A,
      }),
    );
    assert.equal(drift.ok, false);
    assert.equal(drift.code, "EFFECT_REUSE_MISMATCH");
    assert.equal(
      count(database, "managed_effect_consumptions", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      before.consumptions,
    );
  }));

test("WMB-5368 failed, partial, and cancelled effect tokens cannot later settle as success", () =>
  withDatabase((database) => {
    for (const [workspaceId, firstState] of [
      ["ws-effect-failed", "failed"],
      ["ws-effect-partial", "partial"],
      ["ws-effect-cancelled", "cancelled"],
    ]) {
      const fixture = makeFixture(database, { workspaceId });
      const stageD = expectOk(
        freezeStageD(fixture, {
          targets: [target("target-a")],
          effects: [effect("publish", 1)],
        }),
        `${firstState} Stage-D freeze`,
      ).value;
      terminalizeSourceDispatch(fixture);
      const reserved = expectOk(
        fixture.snapshotStore.reserveEffectConsumption(
          effectInput(fixture, stageD),
        ),
        `${firstState} effect reserve`,
      );
      const settled = expectOk(
        fixture.snapshotStore.settleEffectConsumption(
          settleInput(fixture, reserved.value, firstState, {
            error:
              firstState === "partial"
                ? { terminalStatus: "partial" }
                : undefined,
          }),
        ),
        `${firstState} effect settlement`,
      );
      assert.equal(
        settled.value.state,
        "failed" === firstState || firstState === "partial"
          ? "failed"
          : "cancelled",
      );
      const failedBeforeSuccess = fixture.snapshotStore.readEffectConsumption({
        workspaceId,
        consumptionId: reserved.value.consumptionId,
      });
      const success = fixture.snapshotStore.settleEffectConsumption(
        settleInput(fixture, reserved.value, "succeeded", {
          outcome: { delivered: true },
        }),
      );
      assert.equal(success.ok, false);
      assert.equal(success.code, "EFFECT_REUSE_MISMATCH");
      const after = fixture.snapshotStore.readEffectConsumption({
        workspaceId,
        consumptionId: reserved.value.consumptionId,
      });
      assert.deepEqual(after, failedBeforeSuccess);
    }
  }));
