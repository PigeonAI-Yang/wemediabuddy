import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateDatabase } from "../src/main/db/migrations.ts";
import { WorkspaceOrchestratorActorStore } from "../src/main/workspace-orchestrator-actor.ts";
import { WorkspaceOrchestratorRootStageStore } from "../src/main/workspace-orchestrator-root-stage.ts";

const NOW = "2026-08-30T10:00:00.000Z";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const BUILD_ID = "build-wmb-5368";

function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmb-5368-"));
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
    fence: created.fence,
    nowUtc: NOW,
    nowMono: 120,
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  return actorStore;
}

function admitIntent(
  database,
  workspaceId,
  requestId = `request-${workspaceId}`,
) {
  const actorStore = makeActorAndGate(database, workspaceId);
  const accepted = actorStore.acceptIntent({
    workspaceId,
    businessDate: "2026-08-30",
    source: "today_ui",
    rootMode: "owner",
    requestedAction: "full",
    requestId,
    producerId: "producer.today",
    producerAttestation: attestation(
      actorStore.readActor(workspaceId).runtimeEpoch,
    ),
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
    nowUtc: NOW,
    nowMono: 130,
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const closed = actorStore.closePreflight({
    workspaceId,
    requestId,
    nowUtc: NOW,
    nowMono: 140,
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
        capabilityLeaseId: "cap-x",
      },
    ],
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.status, "admitted");
  const actor = actorStore.readActor(workspaceId);
  return {
    actorStore,
    actor,
    intentId: accepted.intentId,
    fence: fenceFrom(actor),
  };
}

function admitRoot(database, workspaceId) {
  const fixture = admitIntent(database, workspaceId);
  const rootStore = new WorkspaceOrchestratorRootStageStore(database, {
    nowUtc: () => NOW,
    nowMono: () => 150,
  });
  const admitted = rootStore.admitRoot({
    workspaceId,
    intentId: fixture.intentId,
    fence: fixture.fence,
    nowUtc: NOW,
    nowMono: 150,
    envelope: {
      executable: "node",
      argv: ["scan"],
      cwd: "J:/WMB",
      source: "test",
    },
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  return { ...fixture, workspaceId, rootStore, admitted };
}

function insertFrozenSource(database, fixture, snapshotHash) {
  const rootRequestId = String(fixture.admitted.root.root_request_id);
  const root = database
    .prepare(
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    )
    .get(fixture.workspaceId, rootRequestId);
  const stage = database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? AND attempt_stage<>'judge'",
    )
    .get(fixture.workspaceId, rootRequestId);
  const preflight = database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(fixture.workspaceId, root.preflight_id);
  const selected = JSON.parse(
    String(preflight.selected_channels_json ?? "[]"),
  ).map((entry) => String(entry.channelId ?? entry.channel_id ?? entry));
  const channels = selected.map((channelId) => ({
    channelId,
    status: "ready",
    ready: true,
    revoked: false,
    authStatus: "ready",
    configStatus: "ready",
    profileRevision: Number(preflight.profile_revision),
    policyHash: String(preflight.policy_hash),
    configRevision: 1,
    authRevision: 1,
    capabilityRevision: 1,
    capabilityLeaseId: `cap-${channelId}`,
    expiresAtMono: 90_000,
    requiredness: channelId === "official" ? "required" : "optional",
    preflightId: String(preflight.preflight_id),
    scanAttemptId: String(stage.stage_request_id),
    receiptId: `receipt-${channelId}`,
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
      String(root.business_date),
      rootRequestId,
      Number(root.root_generation),
      String(stage.stage_request_id),
      String(stage.stage_request_id),
      String(preflight.preflight_id),
      String(preflight.policy_hash),
      Number(preflight.profile_revision),
      JSON.stringify(selected),
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
      "UPDATE daily_stage_claims SET status='snapshot_frozen', snapshot_json=? WHERE workspace_id=? AND stage_request_id=?",
    )
    .run(
      JSON.stringify({ sourceSnapshotHash: snapshotHash }),
      fixture.workspaceId,
      stage.stage_request_id,
    );
  return channels;
}

test("WMB-5368 T3 root admission atomically creates root, F claim, reserved Reporter and active index; replay is zero-write", () =>
  withDatabase((database) => {
    const { rootStore, admitted, actor, intentId, fence } = admitRoot(
      database,
      "ws-root-admission",
    );
    assert.equal(admitted.status, "admitted");
    assert.equal(count(database, "daily_orchestration_roots"), 1);
    assert.equal(count(database, "daily_stage_claims"), 1);
    assert.equal(
      count(database, "managed_job_dispatches", "state='reserved'"),
      1,
    );
    assert.equal(
      count(database, "workspace_active_root_index", "is_active=1"),
      1,
    );
    assert.equal(
      count(database, "orchestrator_events", "event_type='root.created'"),
      1,
    );
    assert.equal(
      database
        .prepare("SELECT status FROM orchestrator_intents WHERE intent_id=?")
        .get(intentId).status,
      "running",
    );
    const before = {
      roots: count(database, "daily_orchestration_roots"),
      claims: count(database, "daily_stage_claims"),
      jobs: count(database, "managed_job_dispatches"),
      events: count(database, "orchestrator_events"),
      outbox: count(database, "orchestrator_outbox"),
    };
    const replay = rootStore.admitRoot({
      workspaceId: "ws-root-admission",
      intentId,
      fence,
      nowUtc: NOW,
      nowMono: 151,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "replayed");
    assert.deepEqual(
      {
        roots: count(database, "daily_orchestration_roots"),
        claims: count(database, "daily_stage_claims"),
        jobs: count(database, "managed_job_dispatches"),
        events: count(database, "orchestrator_events"),
        outbox: count(database, "orchestrator_outbox"),
      },
      before,
    );
    assert.equal(
      String(replay.root.root_request_id),
      String(admitted.root.root_request_id),
    );
    assert.equal(actor.workspaceId, "ws-root-admission");
  }));

test("WMB-5368 T5 handoff terminalizes exactly one F and creates exactly one J; repeated handoff cannot create attempt 3", () =>
  withDatabase((database) => {
    const fixture = admitRoot(database, "ws-handoff");
    const { rootStore, admitted, actorStore } = fixture;
    const rootRequestId = admitted.root.root_request_id;
    const f = database
      .prepare("SELECT * FROM daily_stage_claims WHERE root_request_id=?")
      .get(rootRequestId);
    const currentChannelFences = insertFrozenSource(
      database,
      fixture,
      "snapshot-wmb-5368",
    );
    const actor = actorStore.readActor("ws-handoff");
    const handoff = rootStore.handoffToJudge({
      workspaceId: "ws-handoff",
      rootRequestId,
      stageRequestId: f.stage_request_id,
      fence: fenceFrom(actor),
      sourceSnapshotHash: "snapshot-wmb-5368",
      currentChannelFences,
      nowUtc: NOW,
      nowMono: 170,
    });
    assert.equal(handoff.ok, true, JSON.stringify(handoff));
    assert.equal(handoff.status, "handoff");
    assert.equal(
      count(
        database,
        "daily_stage_claims",
        "root_request_id=? AND attempt_stage='judge'",
        [rootRequestId],
      ),
      1,
    );
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "root_request_id=? AND role_id='judge'",
        [rootRequestId],
      ),
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT status,is_active FROM daily_stage_claims WHERE stage_request_id=?",
        )
        .get(f.stage_request_id).is_active,
      0,
    );
    const before = {
      claims: count(database, "daily_stage_claims"),
      jobs: count(database, "managed_job_dispatches"),
      events: count(database, "orchestrator_events"),
    };
    const replay = rootStore.handoffToJudge({
      workspaceId: "ws-handoff",
      rootRequestId,
      fence: fenceFrom(actorStore.readActor("ws-handoff")),
      nowUtc: NOW,
      nowMono: 171,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "replayed");
    assert.deepEqual(
      {
        claims: count(database, "daily_stage_claims"),
        jobs: count(database, "managed_job_dispatches"),
        events: count(database, "orchestrator_events"),
      },
      before,
    );
    assert.equal(
      count(
        database,
        "daily_stage_claims",
        "root_request_id=? AND attempt_stage=3",
        [rootRequestId],
      ),
      0,
    );
  }));
test("WMB-5368 T8 cancel wins over handoff with zero post-cancel child, while handoff then cancel leaves one cancelled J", () =>
  withDatabase((database) => {
    const first = admitRoot(database, "ws-cancel-first");
    const rootRequestId = first.admitted.root.root_request_id;
    const cancelled = first.rootStore.cancelRoot({
      workspaceId: "ws-cancel-first",
      rootRequestId,
      fence: fenceFrom(first.actorStore.readActor("ws-cancel-first")),
      reasonCode: "OWNER_CANCELLED",
      nowUtc: NOW,
      nowMono: 180,
    });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const afterCancel = first.rootStore.handoffToJudge({
      workspaceId: "ws-cancel-first",
      rootRequestId,
      fence: fenceFrom(first.actorStore.readActor("ws-cancel-first")),
      sourceSnapshotHash: "late",
      nowUtc: NOW,
      nowMono: 181,
    });
    assert.equal(afterCancel.ok, false);
    assert.equal(
      count(
        database,
        "daily_stage_claims",
        "root_request_id=? AND attempt_stage='judge'",
        [rootRequestId],
      ),
      0,
    );
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "root_request_id=? AND role_id='judge'",
        [rootRequestId],
      ),
      0,
    );

    const second = admitRoot(database, "ws-handoff-cancel");
    const secondRoot = second.admitted.root.root_request_id;
    const secondFences = insertFrozenSource(database, second, "snapshot-2");
    const handed = second.rootStore.handoffToJudge({
      workspaceId: "ws-handoff-cancel",
      rootRequestId: secondRoot,
      fence: fenceFrom(second.actorStore.readActor("ws-handoff-cancel")),
      sourceSnapshotHash: "snapshot-2",
      currentChannelFences: secondFences,
      nowUtc: NOW,
      nowMono: 190,
    });
    assert.equal(handed.ok, true, JSON.stringify(handed));
    const canceledAfter = second.rootStore.cancelRoot({
      workspaceId: "ws-handoff-cancel",
      rootRequestId: secondRoot,
      fence: fenceFrom(second.actorStore.readActor("ws-handoff-cancel")),
      reasonCode: "OWNER_CANCELLED",
      nowUtc: NOW,
      nowMono: 191,
    });
    assert.equal(canceledAfter.ok, true, JSON.stringify(canceledAfter));
    assert.equal(
      database
        .prepare(
          "SELECT status,is_active FROM daily_stage_claims WHERE root_request_id=? AND attempt_stage='judge'",
        )
        .get(secondRoot).status,
      "cancelled",
    );
    assert.equal(
      database
        .prepare(
          "SELECT state FROM managed_job_dispatches WHERE root_request_id=? AND role_id='judge'",
        )
        .get(secondRoot).state,
      "cancelled",
    );
  }));

test("WMB-5368 terminal settlement is first-writer and replay-only; no later settlement can rewrite result", () =>
  withDatabase((database) => {
    const { rootStore, admitted, actorStore } = admitRoot(
      database,
      "ws-settle",
    );
    const rootRequestId = admitted.root.root_request_id;
    const claim = database
      .prepare("SELECT * FROM daily_stage_claims WHERE root_request_id=?")
      .get(rootRequestId);
    const settled = rootStore.settleStage({
      workspaceId: "ws-settle",
      stageRequestId: claim.stage_request_id,
      fence: fenceFrom(actorStore.readActor("ws-settle")),
      status: "partial",
      reasonCode: "OPTIONAL_SOURCE_GAP",
      result: { gap: ["x-list"] },
      nextAction: { kind: "retry_optional" },
      nowUtc: NOW,
      nowMono: 200,
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.status, "partial");
    const row = database
      .prepare(
        "SELECT status,result_json FROM daily_stage_claims WHERE stage_request_id=?",
      )
      .get(claim.stage_request_id);
    const before = {
      status: row.status,
      result: row.result_json,
      events: count(database, "orchestrator_events"),
    };
    const replay = rootStore.settleStage({
      workspaceId: "ws-settle",
      stageRequestId: claim.stage_request_id,
      fence: fenceFrom(actorStore.readActor("ws-settle")),
      status: "succeeded",
      result: { shouldNotWin: true },
      nowUtc: NOW,
      nowMono: 201,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "replayed");
    const after = database
      .prepare(
        "SELECT status,result_json FROM daily_stage_claims WHERE stage_request_id=?",
      )
      .get(claim.stage_request_id);
    assert.deepEqual(
      {
        status: after.status,
        result: after.result_json,
        events: count(database, "orchestrator_events"),
      },
      before,
    );
    assert.equal(
      database
        .prepare(
          "SELECT status FROM daily_orchestration_roots WHERE root_request_id=?",
        )
        .get(rootRequestId).status,
      "partial",
    );
    assert.equal(
      database
        .prepare(
          "SELECT status FROM orchestrator_intents WHERE root_request_id=?",
        )
        .get(rootRequestId).status,
      "partial",
    );
  }));
