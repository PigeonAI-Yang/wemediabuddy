import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateDatabase } from "../src/main/db/migrations.ts";
import { WorkspaceOrchestratorActorStore } from "../src/main/workspace-orchestrator-actor.ts";
import { WorkspaceOrchestratorRootStageStore } from "../src/main/workspace-orchestrator-root-stage.ts";
import { WorkspaceOrchestratorResourceAdmissionStore } from "../src/main/workspace-orchestrator-resource-admission.ts";

const NOW = "2026-08-30T10:00:00.000Z";
const LEASE_UTC = "2026-08-30T10:30:00.000Z";
const SPAWN_UTC = "2026-08-30T10:20:00.000Z";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const BUILD_ID = "build-wmb-5368-resource";

function withDatabase(work) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmb-5368-resource-"),
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
      "source-wmb-5368-resource",
      HEX_A,
      HEX_B,
      "manifest-wmb-5368-resource",
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
      "manifest-wmb-5368-resource",
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
    .run(
      workspaceId,
      BUILD_ID,
      "registry-wmb-5368-resource",
      "census-wmb-5368-resource",
      NOW,
    );
}

function attestation(runtimeEpoch) {
  return {
    producerId: "producer.today",
    registryEntryHash: "registry-wmb-5368-resource",
    censusHash: "census-wmb-5368-resource",
    triggerId: "trigger.today",
    processId: "5368-resource",
    processStartTimeUtc: NOW,
    processStartTimeMono: 1,
    processImagePath: "J:/WMB/WeMediaBuddy.exe",
    resourcesPath: "J:/WMB/resources",
    buildId: BUILD_ID,
    sourceCommit: "source-wmb-5368-resource",
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

function makeControl(database, workspaceId) {
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
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  seedProducer(database, workspaceId, acquired.actor);
  const created = actorStore.createStartupReconcileGate({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 110,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const completed = actorStore.completeStartupReconcile({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 120,
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  return {
    actorStore,
    rootStore: new WorkspaceOrchestratorRootStageStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 150,
    }),
    resourceStore: new WorkspaceOrchestratorResourceAdmissionStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 150,
    }),
  };
}

function admitRootFixture(
  control,
  database,
  workspaceId,
  { requestId, businessDate = "2026-08-30", offset = 0 },
) {
  const current = control.actorStore.readActor(workspaceId);
  const accepted = control.actorStore.acceptIntent({
    workspaceId,
    businessDate,
    source: "today_ui",
    rootMode: "owner",
    requestedAction: "full",
    requestId,
    producerId: "producer.today",
    producerAttestation: attestation(current.runtimeEpoch),
    logicalInput: { topic: "AI", requestId },
    payload: { topic: "AI", requestId },
    channelPolicy: [
      {
        channelId: "official",
        requiredness: "required",
        module: "official_web",
      },
      { channelId: "x-list", requiredness: "optional", module: "x_list" },
    ],
    authorizedChannelPolicy: [
      {
        channelId: "official",
        requiredness: "required",
        module: "official_web",
      },
      { channelId: "x-list", requiredness: "optional", module: "x_list" },
    ],
    profileRevision: 7,
    priority: 10,
    fence: fenceFrom(current),
    nowUtc: NOW,
    nowMono: 130 + offset,
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const afterAccept = control.actorStore.readActor(workspaceId);
  const closed = control.actorStore.closePreflight({
    workspaceId,
    requestId,
    profileRevision: 7,
    channelResults: [
      {
        channelId: "official",
        status: "ready",
        capability: { ok: true },
        capabilityLeaseId: "cap-official",
      },
      {
        channelId: "x-list",
        status: "ready",
        capability: { ok: true },
        capabilityLeaseId: "cap-x-list",
      },
    ],
    fence: fenceFrom(afterAccept),
    nowUtc: NOW,
    nowMono: 140 + offset,
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.status, "admitted", JSON.stringify(closed));

  const admitted = control.rootStore.admitRoot({
    workspaceId,
    intentId: accepted.intentId,
    fence: fenceFrom(control.actorStore.readActor(workspaceId)),
    envelope: {
      executable: "node",
      argv: ["worker"],
      cwd: "J:/WMB",
      source: "resource-contract-test",
    },
    nowUtc: NOW,
    nowMono: 150 + offset,
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));

  const root = database
    .prepare(
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND intent_id=?",
    )
    .get(workspaceId, accepted.intentId);
  const stage = database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? ORDER BY created_at, stage_request_id LIMIT 1",
    )
    .get(workspaceId, root.root_request_id);
  const preflight = database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(workspaceId, root.preflight_id);
  return {
    ...control,
    workspaceId,
    accepted,
    admitted,
    root,
    stage,
    preflight,
    actor: control.actorStore.readActor(workspaceId),
  };
}

function resourceInput(fixture, key, overrides = {}) {
  const actor = fixture.actorStore.readActor(fixture.workspaceId);
  const root = fixture.root;
  const stageRequestId =
    overrides.stageRequestId ?? fixture.stage.stage_request_id;
  const parentStageRequestId =
    overrides.parentStageRequestId ?? fixture.stage.stage_request_id;
  const operationRequestId =
    overrides.operationRequestId ??
    `resource-operation-${fixture.workspaceId}-${key}`;
  const childOrdinal = overrides.childOrdinal ?? key;
  const envelopeOverride = overrides.envelope ?? {};
  const { envelope: _ignoredEnvelope, ...scalarOverrides } = overrides;
  const base = {
    workspaceId: fixture.workspaceId,
    fence: fenceFrom(actor),
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    managerTaskId: String(root.manager_task_id),
    orchestrationId: String(root.orchestration_id),
    parentTaskId: String(root.manager_task_id),
    parentStageRequestId,
    stageRequestId,
    retryGeneration: 0,
    expectedParentClaimRevision: Number(
      overrides.expectedParentClaimRevision ?? fixture.stage.claim_revision,
    ),
    roleId: "reporter",
    childOrdinal,
    operationRequestId,
    envelope: {
      preflightId: String(fixture.preflight.preflight_id),
      policyHash: String(fixture.preflight.policy_hash),
      ...envelopeOverride,
    },
    argvHash: `argv-${fixture.workspaceId}-${key}`,
    cwdFingerprint: `cwd-${fixture.workspaceId}-${key}`,
    sessionKey: `session-${fixture.workspaceId}-${key}`,
    nowUtc: NOW,
    nowMono: 300 + Number(key),
    leaseExpiresAtUtc: LEASE_UTC,
    leaseExpiresAtMono: 10_000,
    spawnDeadlineUtc: SPAWN_UTC,
    spawnDeadlineMono: 9_000,
  };
  return {
    ...base,
    ...scalarOverrides,
    envelope: { ...base.envelope, ...envelopeOverride },
  };
}

function mutationInput(fixture, overrides = {}) {
  const actor = fixture.actorStore.readActor(fixture.workspaceId);
  return {
    workspaceId: fixture.workspaceId,
    fence: fenceFrom(actor),
    jobId: String(fixture.admitted.dispatch.jobId),
    parentStageRequestId: String(fixture.stage.stage_request_id),
    expectedParentClaimRevision: Number(fixture.stage.claim_revision),
    nowUtc: NOW,
    nowMono: 300,
    ...overrides,
  };
}

function dispatchRow(database, jobId) {
  return database
    .prepare("SELECT * FROM managed_job_dispatches WHERE job_id=?")
    .get(jobId);
}

function activeCount(database, workspaceId, roleId) {
  return count(
    database,
    "managed_job_dispatches",
    `workspace_id=? AND role_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running') AND (result_status IS NULL OR result_status!='waiting_resource')`,
    [workspaceId, roleId],
  );
}

function channelFenceRows(fixture) {
  const selected = JSON.parse(
    String(fixture.preflight.selected_channels_json ?? "[]"),
  ).map((entry) => String(entry.channelId ?? entry.channel_id ?? entry));
  return selected.map((channelId) => ({
    channelId,
    status: "ready",
    ready: true,
    revoked: false,
    authStatus: "ready",
    configStatus: "ready",
    profileRevision: Number(fixture.preflight.profile_revision),
    policyHash: String(fixture.preflight.policy_hash),
    configRevision: 1,
    authRevision: 1,
    capabilityRevision: 1,
    capabilityLeaseId: `cap-${channelId}`,
    expiresAtMono: 90_000,
  }));
}

function freezeReporter(database, fixture, snapshotHash) {
  const channels = channelFenceRows(fixture).map((fence) => ({
    ...fence,
    requiredness: fence.channelId === "official" ? "required" : "optional",
    preflightId: String(fixture.preflight.preflight_id),
    scanAttemptId: String(fixture.stage.stage_request_id),
    receiptId: `receipt-${fence.channelId}`,
    receiptRevision: 1,
    receiptPayloadHash: HEX_A,
    resultHash: HEX_A,
  }));
  database
    .prepare(
      `INSERT INTO source_snapshots (
    snapshot_id, workspace_id, business_date, source_task_id, root_request_id, root_generation,
    stage_request_id, scan_attempt_id, preflight_id, policy_hash, profile_revision,
    selected_channel_ids_json, successful_channels_json, failed_channels_json, unresolved_channels_json,
    source_ids_json, source_bindings_json, receipt_ids_json, receipt_bindings_json,
    watermark_utc, watermark_mono, captured_at_utc, excluded_by_budget_count, snapshot_hash, status
  ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, 0, ?, 'frozen')`,
    )
    .run(
      snapshotHash,
      fixture.workspaceId,
      String(fixture.root.business_date),
      String(fixture.root.root_request_id),
      Number(fixture.root.root_generation),
      String(fixture.stage.stage_request_id),
      String(fixture.stage.stage_request_id),
      String(fixture.preflight.preflight_id),
      String(fixture.preflight.policy_hash),
      Number(fixture.preflight.profile_revision),
      JSON.stringify(channels.map((entry) => entry.channelId)),
      JSON.stringify(channels),
      JSON.stringify(channels.map((entry) => entry.receiptId)),
      JSON.stringify(
        Object.fromEntries(
          channels.map((entry) => [
            entry.receiptId,
            {
              receiptRevision: entry.receiptRevision,
              receiptPayloadHash: entry.receiptPayloadHash,
              resultHash: entry.resultHash,
            },
          ]),
        ),
      ),
      NOW,
      150,
      NOW,
      snapshotHash,
    );
  database
    .prepare(
      `UPDATE daily_stage_claims SET status='snapshot_frozen', snapshot_json=?
    WHERE workspace_id=? AND stage_request_id=?`,
    )
    .run(
      JSON.stringify({ sourceSnapshotHash: snapshotHash }),
      fixture.workspaceId,
      fixture.stage.stage_request_id,
    );
  return channels;
}

function insertParentClaim(
  database,
  fixture,
  stageRequestId,
  ownerEpoch,
  leaseToken,
) {
  database
    .prepare(
      `INSERT INTO daily_stage_claims (
    claim_id, workspace_id, claim_kind, claim_scope_key, stage_request_id, request_id,
    root_request_id, root_generation, root_input_hash, manager_task_id, orchestration_id,
    parent_task_id, parent_stage_request_id, root_mode, attempt_stage, retry_generation,
    logical_input_hash, status, is_active, claim_revision, owner_epoch, lease_token,
    lease_expires_at_utc, lease_expires_at_mono, stage_deadline_utc, stage_deadline_mono,
    control_stall_deadline_utc, control_stall_deadline_mono, child_ids_json, created_at, updated_at
  ) VALUES (?, ?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'full', 0, ?,
    'dispatching_scan', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(
      `claim-${stageRequestId}`,
      fixture.workspaceId,
      `resource-parent:${stageRequestId}`,
      stageRequestId,
      `parent-request-${stageRequestId}`,
      fixture.root.root_request_id,
      Number(fixture.root.root_generation),
      String(fixture.root.root_input_hash),
      String(fixture.root.manager_task_id),
      String(fixture.root.orchestration_id),
      String(fixture.root.manager_task_id),
      fixture.stage.stage_request_id,
      "parent-logical-input",
      ownerEpoch,
      leaseToken,
      LEASE_UTC,
      10_000,
      SPAWN_UTC,
      9_000,
      SPAWN_UTC,
      8_000,
      NOW,
      NOW,
    );
  return database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(fixture.workspaceId, stageRequestId);
}

test("WMB-5368 resource reserve replay and conflict preserve one durable identity with zero extra writes", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-resource-replay"),
      database,
      "ws-resource-replay",
      { requestId: "request-resource-replay" },
    );
    const { resourceStore } = fixture;
    const input = resourceInput(fixture, 2);
    const first = resourceStore.reserve(input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.status, "reserved");

    const before = {
      jobs: count(database, "managed_job_dispatches"),
      registry: count(database, "identity_hash_registry"),
      row: dispatchRow(database, first.dispatch.jobId),
    };
    const replay = resourceStore.reserve({ ...input, nowMono: 301 });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "reserved");
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      {
        jobs: count(database, "managed_job_dispatches"),
        registry: count(database, "identity_hash_registry"),
      },
      { jobs: before.jobs, registry: before.registry },
    );
    assert.deepEqual(dispatchRow(database, first.dispatch.jobId), before.row);

    const conflict = resourceStore.reserve({
      ...input,
      rootInputHash: "different-root-input",
      nowMono: 302,
    });
    assert.equal(conflict.ok, false, JSON.stringify(conflict));
    assert.equal(conflict.code, "RESOURCE_ADMISSION_REPLAY_CONFLICT");
    assert.deepEqual(
      {
        jobs: count(database, "managed_job_dispatches"),
        registry: count(database, "identity_hash_registry"),
      },
      { jobs: before.jobs, registry: before.registry },
    );
    assert.deepEqual(dispatchRow(database, first.dispatch.jobId), before.row);
  }));

test("WMB-5368 Reporter active cap is five and the sixth reserve is durable waiting_resource", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-reporter-cap"),
      database,
      "ws-reporter-cap",
      { requestId: "request-reporter-cap" },
    );
    for (let ordinal = 2; ordinal <= 5; ordinal += 1) {
      const result = fixture.resourceStore.reserve(
        resourceInput(fixture, ordinal, { childOrdinal: ordinal }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.status, "reserved");
    }
    assert.equal(activeCount(database, fixture.workspaceId, "reporter"), 5);

    const waitingInput = resourceInput(fixture, 6, { childOrdinal: 6 });
    const waiting = fixture.resourceStore.reserve(waitingInput);
    assert.equal(waiting.ok, true, JSON.stringify(waiting));
    assert.equal(waiting.status, "waiting_resource");
    assert.equal(waiting.reasonCode, "RESOURCE_REPORTER_CAPACITY");
    assert.equal(activeCount(database, fixture.workspaceId, "reporter"), 5);
    const waitingRow = dispatchRow(database, waiting.dispatch.jobId);
    assert.equal(waitingRow.state, "reserved");
    assert.equal(waitingRow.result_status, "waiting_resource");
    assert.equal(
      JSON.parse(waitingRow.result_json).reasonCode,
      "RESOURCE_REPORTER_CAPACITY",
    );

    const reopened = new WorkspaceOrchestratorResourceAdmissionStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 150,
    });
    const replay = reopened.reserve({ ...waitingInput, nowMono: 307 });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "waiting_resource");
    assert.equal(replay.replayed, true);
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND role_id='reporter'",
        [fixture.workspaceId],
      ),
      6,
    );
  }));

test("WMB-5368 Judge active cap is one and a second root remains durably waiting_resource", () =>
  withDatabase((database) => {
    const control = makeControl(database, "ws-judge-cap");
    const first = admitRootFixture(control, database, "ws-judge-cap", {
      requestId: "request-judge-one",
      businessDate: "2026-08-30",
    });
    const firstFences = freezeReporter(database, first, "snapshot-judge-one");
    const handoffOne = control.rootStore.handoffToJudge({
      workspaceId: "ws-judge-cap",
      rootRequestId: first.root.root_request_id,
      stageRequestId: first.stage.stage_request_id,
      sourceSnapshotHash: "snapshot-judge-one",
      fence: fenceFrom(control.actorStore.readActor("ws-judge-cap")),
      currentChannelFences: firstFences,
      nowUtc: NOW,
      nowMono: 170,
    });
    assert.equal(handoffOne.ok, true, JSON.stringify(handoffOne));
    assert.equal(handoffOne.status, "handoff");
    assert.equal(activeCount(database, "ws-judge-cap", "judge"), 1);

    const second = admitRootFixture(control, database, "ws-judge-cap", {
      requestId: "request-judge-two",
      businessDate: "2026-08-31",
      offset: 60,
    });
    const secondFences = freezeReporter(database, second, "snapshot-judge-two");
    const handoffTwo = control.rootStore.handoffToJudge({
      workspaceId: "ws-judge-cap",
      rootRequestId: second.root.root_request_id,
      stageRequestId: second.stage.stage_request_id,
      sourceSnapshotHash: "snapshot-judge-two",
      fence: fenceFrom(control.actorStore.readActor("ws-judge-cap")),
      currentChannelFences: secondFences,
      nowUtc: NOW,
      nowMono: 230,
    });
    assert.equal(handoffTwo.ok, true, JSON.stringify(handoffTwo));
    assert.equal(handoffTwo.status, "handoff");
    assert.equal(activeCount(database, "ws-judge-cap", "judge"), 1);
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND role_id='judge' AND result_status='waiting_resource'",
        ["ws-judge-cap"],
      ),
      1,
    );
    const waiting = database
      .prepare(
        "SELECT state,result_status,result_json FROM managed_job_dispatches WHERE workspace_id=? AND role_id='judge' AND result_status='waiting_resource'",
      )
      .get("ws-judge-cap");
    assert.equal(waiting.state, "reserved");
    assert.equal(
      JSON.parse(waiting.result_json).reasonCode,
      "RESOURCE_JUDGE_CAPACITY",
    );
  }));

test("WMB-5368 task binding, launch attempt, spawn uncertainty, and running registration retain task/process identity", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-resource-lifecycle"),
      database,
      "ws-resource-lifecycle",
      { requestId: "request-resource-lifecycle" },
    );
    const base = fixture.admitted.dispatch;
    const task = fixture.resourceStore.bindTask(
      mutationInput(fixture, {
        taskId: "agent-task-resource-lifecycle",
        taskIdentity: {
          taskId: "agent-task-resource-lifecycle",
          worker: "reporter",
        },
        nowMono: 310,
      }),
    );
    assert.equal(task.ok, true, JSON.stringify(task));
    assert.equal(task.status, "task_bound");
    assert.equal(
      JSON.parse(dispatchRow(database, base.jobId).envelope_json).taskId,
      "agent-task-resource-lifecycle",
    );

    const taskReplay = fixture.resourceStore.bindTask(
      mutationInput(fixture, {
        taskId: "agent-task-resource-lifecycle",
        nowMono: 311,
      }),
    );
    assert.equal(taskReplay.ok, true, JSON.stringify(taskReplay));
    assert.equal(taskReplay.status, "task_bound");
    assert.equal(taskReplay.replayed, true);
    const taskConflict = fixture.resourceStore.bindTask(
      mutationInput(fixture, { taskId: "different-task", nowMono: 312 }),
    );
    assert.equal(taskConflict.ok, false, JSON.stringify(taskConflict));
    assert.equal(taskConflict.code, "RESOURCE_ADMISSION_REPLAY_CONFLICT");

    const launch = fixture.resourceStore.markLaunchAttempt(
      mutationInput(fixture, {
        launchAttemptId: base.launchAttemptId,
        launchTokenHash: base.launchTokenHash,
        nowMono: 320,
      }),
    );
    assert.equal(launch.ok, true, JSON.stringify(launch));
    assert.equal(launch.status, "task_bound");

    const uncertain = fixture.resourceStore.markSpawnUncertain(
      mutationInput(fixture, { nowMono: 330 }),
    );
    assert.equal(uncertain.ok, true, JSON.stringify(uncertain));
    assert.equal(uncertain.status, "spawn_uncertain");
    assert.equal(dispatchRow(database, base.jobId).state, "spawn_uncertain");

    const running = fixture.resourceStore.markSpawnStarted(
      mutationInput(fixture, {
        launchAttemptId: base.launchAttemptId,
        launchTokenHash: base.launchTokenHash,
        processHandle: "process-handle-resource-lifecycle",
        pid: 5368001,
        processStartTimeUtc: "2026-08-30T10:00:01.000Z",
        argvHash: base.argvHash,
        cwdFingerprint: base.cwdFingerprint,
        sessionKey: base.sessionKey,
        nowMono: 340,
      }),
    );
    assert.equal(running.ok, true, JSON.stringify(running));
    assert.equal(running.status, "running");
    assert.equal(running.dispatch.state, "running");
    assert.equal(running.dispatch.pid, 5368001);
    assert.equal(
      running.dispatch.processHandle,
      "process-handle-resource-lifecycle",
    );
  }));

test("WMB-5368 adopt-or-kill adopts one proven process and rejects a mismatched identity into kill_drain", () =>
  withDatabase((database) => {
    const control = makeControl(database, "ws-adopt-kill");
    const exact = admitRootFixture(control, database, "ws-adopt-kill", {
      requestId: "request-adopt-exact",
      businessDate: "2026-08-30",
    });
    const exactBase = exact.admitted.dispatch;
    const exactProcess = {
      workspaceId: exact.workspaceId,
      launchAttemptId: exactBase.launchAttemptId,
      launchTokenHash: exactBase.launchTokenHash,
      processHandle: "process-handle-adopted",
      pid: 5368002,
      processStartTimeUtc: "2026-08-30T10:00:02.000Z",
      argvHash: exactBase.argvHash,
      cwdFingerprint: exactBase.cwdFingerprint,
      sessionKey: exactBase.sessionKey,
      sessionProof: true,
      startTimeProof: true,
      parentProof: true,
    };
    const adopted = exact.resourceStore.adoptOrKill(
      mutationInput(exact, {
        inventory: [exactProcess],
        inventoryKnown: true,
        nowMono: 400,
      }),
    );
    assert.equal(adopted.ok, true, JSON.stringify(adopted));
    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.action, "adopt");
    assert.equal(adopted.dispatch.state, "running");
    assert.equal(adopted.dispatch.pid, 5368002);

    const mismatch = admitRootFixture(control, database, "ws-adopt-kill", {
      requestId: "request-adopt-mismatch",
      businessDate: "2026-08-31",
      offset: 60,
    });
    const mismatchBase = mismatch.admitted.dispatch;
    const mismatchedProcess = {
      workspaceId: mismatch.workspaceId,
      launchAttemptId: mismatchBase.launchAttemptId,
      launchTokenHash: mismatchBase.launchTokenHash,
      processHandle: "process-handle-wrong",
      pid: 5368003,
      processStartTimeUtc: "2026-08-30T10:00:03.000Z",
      argvHash: "wrong-argv-hash",
      cwdFingerprint: mismatchBase.cwdFingerprint,
      sessionKey: mismatchBase.sessionKey,
      sessionProof: true,
      startTimeProof: true,
      parentProof: true,
    };
    const uncertain = mismatch.resourceStore.adoptOrKill(
      mutationInput(mismatch, {
        inventory: [mismatchedProcess],
        inventoryKnown: true,
        nowMono: 410,
      }),
    );
    assert.equal(uncertain.ok, true, JSON.stringify(uncertain));
    assert.equal(uncertain.status, "spawn_uncertain");
    assert.equal(uncertain.action, "kill_drain");
    assert.deepEqual(uncertain.requiredActions, [
      "stop_process",
      "drain_stdout",
      "drain_stderr",
      "close_session",
      "cleanup_cwd",
    ]);
    assert.equal(
      dispatchRow(database, mismatchBase.jobId).state,
      "spawn_uncertain",
    );

    const orphaned = mismatch.resourceStore.adoptOrKill(
      mutationInput(mismatch, {
        inventory: [],
        inventoryKnown: true,
        spawnConfirmed: false,
        reasonCode: "SPAWN_TERMINATED_CONFIRMED",
        nowMono: 420,
      }),
    );
    assert.equal(orphaned.ok, true, JSON.stringify(orphaned));
    assert.equal(orphaned.status, "orphaned");
    assert.equal(orphaned.action, "orphaned");
    assert.equal(dispatchRow(database, mismatchBase.jobId).state, "orphaned");
  }));

test("WMB-5368 stale Actor fence rejects reserve without identity or dispatch writes", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-fence-actor"),
      database,
      "ws-fence-actor",
      { requestId: "request-fence-actor" },
    );
    const before = {
      jobs: count(database, "managed_job_dispatches"),
      registry: count(database, "identity_hash_registry"),
    };
    const actor = fixture.actorStore.readActor(fixture.workspaceId);
    const rejected = fixture.resourceStore.reserve(
      resourceInput(fixture, 2, {
        fence: { ...fenceFrom(actor), ownerEpoch: actor.ownerEpoch + 1 },
      }),
    );
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.code, "EXECUTION_AUTHORIZATION_INVALID");
    assert.deepEqual(
      {
        jobs: count(database, "managed_job_dispatches"),
        registry: count(database, "identity_hash_registry"),
      },
      before,
    );
  }));

test("WMB-5368 stale root owner fence rejects reserve after Actor authorization succeeds", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-fence-root"),
      database,
      "ws-fence-root",
      { requestId: "request-fence-root" },
    );
    const actor = fixture.actorStore.readActor(fixture.workspaceId);
    database
      .prepare(
        "UPDATE daily_orchestration_roots SET owner_epoch=? WHERE workspace_id=? AND root_request_id=?",
      )
      .run(
        actor.ownerEpoch + 1,
        fixture.workspaceId,
        fixture.root.root_request_id,
      );
    const before = count(database, "managed_job_dispatches");
    const rejected = fixture.resourceStore.reserve(resourceInput(fixture, 2));
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.code, "EXECUTION_AUTHORIZATION_INVALID");
    assert.equal(count(database, "managed_job_dispatches"), before);
  }));

test("WMB-5368 stale stage lease fence rejects reserve while root identity remains current", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-fence-stage"),
      database,
      "ws-fence-stage",
      { requestId: "request-fence-stage" },
    );
    database
      .prepare(
        "UPDATE daily_stage_claims SET lease_token=? WHERE workspace_id=? AND stage_request_id=?",
      )
      .run(
        "stale-stage-lease",
        fixture.workspaceId,
        fixture.stage.stage_request_id,
      );
    const before = count(database, "managed_job_dispatches");
    const rejected = fixture.resourceStore.reserve(resourceInput(fixture, 2));
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.code, "EXECUTION_AUTHORIZATION_INVALID");
    assert.equal(count(database, "managed_job_dispatches"), before);
  }));

test("WMB-5368 stale parent claim owner fence rejects reserve with no child admission", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-fence-parent"),
      database,
      "ws-fence-parent",
      { requestId: "request-fence-parent" },
    );
    const actor = fixture.actorStore.readActor(fixture.workspaceId);
    const parentStageRequestId = "resource-parent-stage-fence";
    insertParentClaim(
      database,
      fixture,
      parentStageRequestId,
      actor.ownerEpoch + 1,
      actor.leaseToken,
    );
    const before = count(database, "managed_job_dispatches");
    const rejected = fixture.resourceStore.reserve(
      resourceInput(fixture, 2, {
        parentStageRequestId,
        expectedParentClaimRevision: 0,
      }),
    );
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.code, "EXECUTION_AUTHORIZATION_INVALID");
    assert.equal(count(database, "managed_job_dispatches"), before);
  }));

test("WMB-5368 terminal settlement is immutable: same result replays and a different first writer is rejected", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-terminal-immutable"),
      database,
      "ws-terminal-immutable",
      { requestId: "request-terminal-immutable" },
    );
    const jobId = fixture.admitted.dispatch.jobId;
    const first = fixture.resourceStore.settleTerminal(
      mutationInput(fixture, {
        terminalStatus: "succeeded",
        result: { answer: 42 },
        nowMono: 500,
      }),
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.status, "terminal");
    const before = dispatchRow(database, jobId);

    const replay = fixture.resourceStore.settleTerminal(
      mutationInput(fixture, {
        terminalStatus: "succeeded",
        result: { answer: 42 },
        nowMono: 501,
      }),
    );
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "terminal");
    assert.equal(replay.replayed, true);
    assert.deepEqual(dispatchRow(database, jobId), before);

    const conflict = fixture.resourceStore.settleTerminal(
      mutationInput(fixture, {
        terminalStatus: "failed",
        result: { answer: 0 },
        nowMono: 502,
      }),
    );
    assert.equal(conflict.ok, false, JSON.stringify(conflict));
    assert.equal(conflict.code, "TERMINAL_IMMUTABILITY_CONFLICT");
    assert.deepEqual(dispatchRow(database, jobId), before);
  }));

test("WMB-5368 lease release writes the current durable expiry without changing dispatch state", () =>
  withDatabase((database) => {
    const fixture = admitRootFixture(
      makeControl(database, "ws-lease-release"),
      database,
      "ws-lease-release",
      { requestId: "request-lease-release" },
    );
    const jobId = fixture.admitted.dispatch.jobId;
    const before = dispatchRow(database, jobId);
    const released = fixture.resourceStore.releaseLeases(
      mutationInput(fixture, { nowMono: 600 }),
    );
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(released.released.length, 1);
    assert.equal(released.released[0].jobId, jobId);
    const after = dispatchRow(database, jobId);
    assert.equal(after.state, before.state);
    assert.equal(after.result_status, before.result_status);
    assert.equal(after.lease_expires_at_utc, NOW);
    assert.equal(Number(after.lease_expires_at_mono), 600);
    assert.equal(after.finished_at, null);
  }));
