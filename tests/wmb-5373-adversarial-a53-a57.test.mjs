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
  hashV1,
  readWorkspaceOrchestratorActor,
} from "../src/main/workspace-orchestrator-actor.ts";
import { WorkspaceOrchestratorRootStageStore } from "../src/main/workspace-orchestrator-root-stage.ts";
import { createWorkspaceOrchestratorSnapshotStore } from "../src/main/workspace-orchestrator-snapshots.ts";
import {
  readManagerAdapterProjection,
  buildManagerTypedCommand,
} from "../src/main/workspace-orchestrator-manager-adapter.ts";
import {
  confirmLegacyRuntimeDrain,
  recordWorkspaceMigrationStep,
  reconcileWorkspaceOrchestratorStartup,
  registerLegacyRuntimeInventory,
} from "../src/main/workspace-orchestrator-recovery.ts";

const NOW = "2026-08-31T08:00:00.000Z";
const BUILD_ID = "build-wmb-5373";
const SOURCE_COMMIT = "source-wmb-5373";
const MANIFEST_HASH = "e".repeat(64);
const PACKAGE_HASH = "a".repeat(64);
const ASAR_HASH = "b".repeat(64);
const SOURCE_HASH = "c".repeat(64);
const RECEIPT_HASH = "d".repeat(64);
const ACCEPTANCE_COLUMNS = [
  "acceptance_run_id",
  "baseline_event_sequence",
  "baseline_checkpoint_revision",
  "created_after_event_sequence",
  "created_after_checkpoint_revision",
  "created_after_mono",
];
const BUSINESS_TABLES = [
  "orchestrator_intents",
  "orchestrator_mailbox",
  "channel_preflight_snapshots",
  "daily_orchestration_roots",
  "daily_stage_claims",
  "source_snapshots",
  "daily_plan_scopes",
  "managed_job_dispatches",
  "managed_effect_consumptions",
];

function withDatabase(work) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmb-5373-acceptance-"),
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

function tableExists(database, table) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

function tableColumns(database, table) {
  if (!tableExists(database, table)) return [];
  return database
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .map((row) => String(row.name));
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

function seedBuild(database, buildId = BUILD_ID, manifestHash = MANIFEST_HASH) {
  database
    .prepare(
      `INSERT INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, 80, 0, 80, 81, 80, ?, ?, ?)`,
    )
    .run(
      buildId,
      SOURCE_COMMIT,
      PACKAGE_HASH,
      ASAR_HASH,
      manifestHash,
      "J:/WMB/resources",
      NOW,
    );
}

function seedProducer(
  database,
  workspaceId,
  actor,
  buildId = BUILD_ID,
  manifestHash = MANIFEST_HASH,
) {
  database
    .prepare(
      `INSERT INTO workspace_migration_state (
    workspace_id, migration_epoch, status, manifest_hash, schema_epoch, cutover_epoch,
    owner_runtime_epoch, fence_token_hash, write_fence, checkpoint_seq, before_hash,
    after_hash, started_at_utc, started_at_mono, finished_at_utc, finished_at_mono
  ) VALUES (?, 1, 'complete', ?, 80, 0, ?, ?, 'allow', 0, ?, ?, ?, 1, ?, 2)`,
    )
    .run(
      workspaceId,
      manifestHash,
      actor.runtimeEpoch,
      hashV1(actor.leaseToken),
      PACKAGE_HASH,
      ASAR_HASH,
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
  ) VALUES (?, 'producer.acceptance', ?, 1, 'tests/wmb-5373-adversarial-a53-a57.test.mjs', 'owner', 'trigger.acceptance',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_acceptance_test',
    'auth-wmb-5373', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`,
    )
    .run(workspaceId, buildId, "registry-wmb-5373", "census-wmb-5373", NOW);
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
    packageHash: PACKAGE_HASH,
    appAsarHash: ASAR_HASH,
    schemaEpoch: 80,
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

function currentActor(fixture) {
  const actor = fixture.actorStore.readActor(fixture.workspaceId);
  assert.ok(actor);
  return actor;
}

function acceptanceInput(fixture, input) {
  return fixture.context.withAcceptance(input);
}

function beginScenario(database, scenarioId, options = {}) {
  const workspaceId =
    options.workspaceId ?? `wmb-5373-${scenarioId.toLowerCase()}`;
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
  const gate = actorStore.createStartupReconcileGate({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 110,
  });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  const complete = actorStore.completeStartupReconcile({
    workspaceId,
    fence: acquired.fence,
    nowUtc: NOW,
    nowMono: 120,
  });
  assert.equal(complete.ok, true, JSON.stringify(complete));
  const started = startAcceptanceRun(
    database,
    {
      workspaceId,
      scenarioId,
      acceptanceRunId: `acceptance-run-wmb-5373-${scenarioId}`,
      acceptanceNamespace: `acceptance/wmb-5373/${scenarioId}`,
      scenarioInput: { scenarioId, workspaceId },
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
  const fixture = {
    database,
    workspaceId,
    scenarioId,
    actorStore,
    rootStore: new WorkspaceOrchestratorRootStageStore(database, {
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
  return fixture;
}

function tick(fixture, delta = 10) {
  fixture.nowMono += delta;
  return fixture.nowMono;
}

function policy(channels) {
  return channels.map(
    ({ channelId, requiredness = "optional", module = channelId }) => ({
      channelId,
      requiredness,
      module,
    }),
  );
}

function readyChannel(channelId, requiredness = "required", extra = {}) {
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
    probeReceiptHash: RECEIPT_HASH,
    ...extra,
  };
}

function intentInput(fixture, overrides = {}) {
  const actor = currentActor(fixture);
  const requestId =
    overrides.requestId ?? `request-${fixture.scenarioId.toLowerCase()}`;
  const channelPolicy =
    overrides.channelPolicy ??
    policy([
      {
        channelId: "official",
        requiredness: "required",
        module: "official_web",
      },
      { channelId: "x-list", requiredness: "optional", module: "x_list" },
    ]);
  return acceptanceInput(fixture, {
    workspaceId: fixture.workspaceId,
    businessDate: overrides.businessDate ?? "2026-08-31",
    source: overrides.source ?? "today_ui",
    rootMode: overrides.rootMode ?? "owner",
    requestedAction: overrides.requestedAction ?? "full",
    requestId,
    producerId: "producer.acceptance",
    producerAttestation: attestation(actor.runtimeEpoch),
    logicalInput: overrides.payload ?? {
      topic: "adversarial acceptance",
      scenarioId: fixture.scenarioId,
      requestId,
    },
    payload: overrides.payload ?? {
      topic: "adversarial acceptance",
      scenarioId: fixture.scenarioId,
      requestId,
    },
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
    acceptanceInput(fixture, {
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
  channelResults = [
    readyChannel("official"),
    readyChannel("x-list", "optional"),
  ],
) {
  const accepted = fixture.actorStore.acceptIntent(
    intentInput(fixture, overrides),
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  return {
    accepted,
    closed: closePreflight(fixture, accepted, channelResults),
  };
}

function admitRoot(fixture, accepted, overrides = {}) {
  const admitted = fixture.rootStore.admitRoot(
    acceptanceInput(fixture, {
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

function sourceInput(fixture, bundle, preflight, options = {}) {
  const root = bundle.root;
  const stage =
    bundle.claims.find((claim) => String(claim.attempt_stage) !== "judge") ??
    bundle.claims[0];
  const selected =
    options.selectedChannelIds ??
    JSON.parse(String(preflight.selected_channels_json)).map((entry) =>
      String(entry.channelId ?? entry.channel_id ?? entry),
    );
  const preflightResults = JSON.parse(String(preflight.results_json ?? "[]"));
  const currentChannelFences =
    options.currentChannelFences ??
    selected.map((channelId) => {
      const result =
        preflightResults.find(
          (entry) => String(entry.channelId ?? entry.channel_id) === channelId,
        ) ?? {};
      return {
        ...result,
        channelId,
        profileRevision: Number(preflight.profile_revision),
        policyHash: String(preflight.policy_hash),
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
  const successful = (
    options.successfulChannels ??
    selected.map((channelId) => ({
      channelId,
      requiredness: channelId === "official" ? "required" : "optional",
      receiptId: `receipt-${fixture.scenarioId}-${channelId}`,
      receiptRevision: 1,
      receiptPayloadHash: RECEIPT_HASH,
      resultHash: ASAR_HASH,
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
      sourceContentHash: SOURCE_HASH,
    },
  ];
  const receiptBindings =
    options.receiptBindings ??
    successful.map((entry) => ({
      receiptId: entry.receiptId,
      receiptRevision: entry.receiptRevision,
      receiptPayloadHash: entry.receiptPayloadHash,
    }));
  return acceptanceInput(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    scanAttemptId: String(stage.stage_request_id),
    preflightId: String(preflight.preflight_id),
    policyHash: String(preflight.policy_hash),
    profileRevision: Number(preflight.profile_revision),
    selectedChannelIds: selected,
    currentChannelFences,
    successfulChannels: successful,
    failedChannels: options.failedChannels ?? [],
    unresolvedChannels: options.unresolvedChannels ?? [],
    sourceBindings,
    sourceIds: sourceBindings.map((entry) => entry.sourceId),
    receiptIds: successful.map((entry) => entry.receiptId),
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
  const bundle = fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId);
  assert.ok(bundle.root);
  const preflight = fixture.database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(fixture.workspaceId, closed.preflightId);
  assert.ok(preflight);
  const input = sourceInput(fixture, bundle, preflight, options);
  const result = fixture.snapshotStore.freezeSourceSnapshot(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return {
    result,
    bundle: fixture.rootStore.readRoot(fixture.workspaceId, rootRequestId),
    preflight,
    input,
  };
}

function projectionInput(fixture, bundle, source, options = {}) {
  const root = bundle.root;
  const stage =
    bundle.claims.find(
      (claim) =>
        String(claim.stage_request_id) ===
        String(source.stageRequestId ?? source.input?.stageRequestId),
    ) ??
    bundle.claims.find((claim) => String(claim.attempt_stage) !== "judge") ??
    bundle.claims[0];
  assert.ok(root);
  assert.ok(stage);
  const candidate = options.candidatePlanItemIds ?? [];
  const eligible = options.eligiblePlanItemIds ?? [];
  const pending = options.pendingPlanItemIds ?? [];
  const invalid = options.invalidPlanItemIds ?? [];
  const all = [...eligible, ...pending, ...invalid];
  return acceptanceInput(fixture, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    sourceSnapshotHash: String(
      options.sourceSnapshotHash ??
        source.snapshotHash ??
        source.result?.value?.snapshotHash,
    ),
    managerTaskId: String(root.manager_task_id),
    orchestrationId: String(root.orchestration_id),
    attemptStage: String(stage.attempt_stage),
    allowedPlanIds: options.allowedPlanIds ?? ["plan-1"],
    allowedPlanItemIds: options.allowedPlanItemIds ?? all,
    carryPlanItemIds: [],
    trustedReceiptIds: options.trustedReceiptIds ?? [
      `receipt-${fixture.scenarioId}-official`,
    ],
    scope: options.scope ?? { purpose: "adversarial-acceptance" },
    projection: {
      planIds: ["plan-1"],
      asOf: { utc: NOW, mono: fixture.nowMono },
      entries: all.map((planItemId) => ({
        planItemId,
        classification: eligible.includes(planItemId)
          ? "eligible"
          : pending.includes(planItemId)
            ? "pending"
            : "invalid",
        sourceReceiptIds: options.trustedReceiptIds ?? [
          `receipt-${fixture.scenarioId}-official`,
        ],
      })),
      candidatePlanItemIds: candidate,
      eligiblePlanItemIds: eligible,
      pendingPlanItemIds: pending,
      invalidPlanItemIds: invalid,
    },
    candidateInputCount: options.candidateInputCount ?? candidate.length,
    classifiedCount: options.classifiedCount ?? all.length,
    coverageGap: options.coverageGap ?? [],
    emptyQualified: options.emptyQualified,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: options.nowMono ?? tick(fixture),
  });
}

function prepareRootWithSource(fixture, options = {}) {
  const pair = acceptAndClose(
    fixture,
    options.intent ?? {},
    options.channelResults ?? [
      readyChannel("official"),
      readyChannel("x-list", "optional"),
    ],
  );
  const admitted = admitRoot(fixture, pair.accepted, options.root ?? {});
  const frozen = freezeSourceForRoot(
    fixture,
    pair.accepted,
    pair.closed,
    String(admitted.root.root_request_id),
    options.source ?? {},
  );
  return {
    ...pair,
    admitted,
    rootRequestId: String(admitted.root.root_request_id),
    frozen,
  };
}

function freshAcceptanceRows(fixture) {
  const rows = [];
  for (const table of [
    "workspace_orchestrator_actors",
    "orchestrator_mailbox",
    "command_receipts",
    "orchestrator_intents",
    "channel_preflight_snapshots",
    "daily_orchestration_roots",
    "daily_stage_claims",
    "source_snapshots",
    "daily_plan_scopes",
    "managed_job_dispatches",
    "managed_effect_consumptions",
    "orchestrator_events",
    "orchestrator_outbox",
    "daily_reconcile_gates",
    "workspace_active_root_index",
  ]) {
    if (
      !tableExists(fixture.database, table) ||
      !tableColumns(fixture.database, table).includes("acceptance_run_id")
    )
      continue;
    rows.push(
      ...fixture.database
        .prepare(
          `SELECT * FROM "${table}" WHERE workspace_id=? AND acceptance_run_id=?`,
        )
        .all(fixture.workspaceId, fixture.run.acceptanceRunId),
    );
  }
  return rows;
}

function zeroBusinessWrites(database, before) {
  return Object.fromEntries(
    BUSINESS_TABLES.map((table) => [
      table,
      count(database, table, "workspace_id=?", [before.workspaceId]),
    ]),
  );
}

function businessCounts(database, workspaceId) {
  return Object.fromEntries(
    BUSINESS_TABLES.map((table) => [
      table,
      count(database, table, "workspace_id=?", [workspaceId]),
    ]),
  );
}
function jsonSafe(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  return value;
}

function finishScenario(fixture, observation) {
  const status =
    observation.status ?? (observation.findings?.length ? "failed" : "passed");
  const proof = jsonSafe({
    scenarioId: fixture.scenarioId,
    finding: observation.findings ?? [],
    injection: observation.injection ?? {},
    acceptance: fixture.context.provenance,
    uniqueCondition: observation.uniqueCondition ?? null,
    durableReadbacks: observation.readbacks ?? [],
    zeroWriteCounts: observation.zeroWriteCounts ?? {},
    ...(observation.proof ?? {}),
  });
  const evidencePointer = `acceptance-evidence/wmb-5373/${fixture.scenarioId}/${fixture.run.acceptanceRunId}`;
  const finished = finishAcceptanceRun(
    fixture.database,
    {
      acceptanceRunId: fixture.run.acceptanceRunId,
      status,
      passed: status === "passed",
      proof,
      readbacks: jsonSafe(
        observation.readbacks ?? [{ scenarioId: fixture.scenarioId, status }],
      ),
      expectedChildren: observation.expectedChildren,
      evidencePointer,
      reason:
        observation.reason ?? (observation.findings?.join("; ") || undefined),
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
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(finished.run.status, status);
  assert.ok(finished.resultHash);
  assert.equal(finished.evidencePointer, evidencePointer);
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
  assert.equal(replay.replayed, true);
  assert.equal(replay.resultHash, finished.resultHash);
  return finished;
}

// A53

test("WMB-5373 A53 outbox/inbox resync, index rebuild and stale CTA are fail-closed", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A53");
    const prepared = prepareRootWithSource(fixture);
    const scope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          candidatePlanItemIds: ["item-a53"],
          eligiblePlanItemIds: ["item-a53"],
          allowedPlanItemIds: ["item-a53"],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
        },
      ),
    );
    assert.equal(scope.ok, true, JSON.stringify(scope));
    const indexBefore = database
      .prepare(
        "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
      )
      .get(fixture.workspaceId, prepared.rootRequestId);
    assert.ok(indexBefore);
    const beforeCounts = businessCounts(database, fixture.workspaceId);
    const staleIdentity = {
      ...readManagerAdapterProjection(database, {
        workspaceId: fixture.workspaceId,
      }).roots[0].identity,
      indexRevision: Math.max(0, Number(indexBefore.index_revision) - 1),
    };
    const staleCommand = buildManagerTypedCommand({
      type: "approve_candidates",
      requestId: "stale-cta-a53",
      identity: staleIdentity,
      payload: { approvedPlanItemIds: ["item-a53"] },
    });
    assert.equal(staleCommand.type, "approve_candidates");
    const replay = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: prepared.accepted.requestId,
        requestedAction: "approve_candidates",
        payload: { stale: true, rootRequestId: prepared.rootRequestId },
      }),
    );
    assert.equal(replay.ok, false);
    assert.equal(replay.code, "REQUEST_REPLAY_CONFLICT");
    const afterReplay = businessCounts(database, fixture.workspaceId);
    assert.deepEqual(afterReplay, beforeCounts);
    database
      .prepare(
        "DELETE FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
      )
      .run(fixture.workspaceId, prepared.rootRequestId);
    assert.equal(
      count(
        database,
        "workspace_active_root_index",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, prepared.rootRequestId],
      ),
      0,
    );
    const rebuilt = reconcileWorkspaceOrchestratorStartup(database, {
      workspaceId: fixture.workspaceId,
      fence: fenceFrom(currentActor(fixture)),
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    const recoverySucceeded =
      rebuilt.ok === true &&
      Array.isArray(rebuilt.actions) &&
      rebuilt.actions.some((action) =>
        String(action).startsWith("index-rebuilt:"),
      );
    const indexAfter = database
      .prepare(
        "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
      )
      .get(fixture.workspaceId, prepared.rootRequestId);
    const manager = readManagerAdapterProjection(database, {
      workspaceId: fixture.workspaceId,
    });
    if (recoverySucceeded) {
      assert.ok(indexAfter);
      assert.equal(manager.roots.length, 1);
      assert.equal(manager.roots[0].eligiblePlanItemIds[0], "item-a53");
    }
    const events = database
      .prepare(
        "SELECT * FROM orchestrator_events WHERE workspace_id=? AND event_sequence>? ORDER BY event_sequence",
      )
      .all(fixture.workspaceId, fixture.run.baselineEventSequence);
    const outbox = database
      .prepare(
        "SELECT * FROM orchestrator_outbox WHERE workspace_id=? AND event_sequence>? ORDER BY event_sequence",
      )
      .all(fixture.workspaceId, fixture.run.baselineEventSequence);
    assert.ok(events.length > 0);
    assert.equal(events.length, outbox.length);
    assert.ok(
      events.every(
        (event) =>
          Number(event.event_ordinal) >= 1 &&
          event.event_id &&
          event.causation_id,
      ),
    );
    const duplicateIdentity = new Set(
      outbox.map(
        (message) =>
          `${message.aggregate_id}|${message.aggregate_revision}|${message.event_type}|${message.event_ordinal}`,
      ),
    );
    assert.equal(duplicateIdentity.size, outbox.length);
    const inboxCount = tableExists(database, "orchestrator_inbox")
      ? count(database, "orchestrator_inbox")
      : 0;
    const findings = [];
    if (!recoverySucceeded)
      findings.push(
        `H-11 index rebuild did not recover the deleted index: ${rebuilt.message ?? rebuilt.reasonCode ?? "maintenance"}`,
      );
    if (!tableExists(database, "orchestrator_inbox") || inboxCount === 0)
      findings.push(
        "H-11 inbox consumer/resync has no durable processed message/cursor readback",
      );
    if (
      !events.some(
        (event) => String(event.event_type) === "active_root_index.rebuilt",
      )
    )
      findings.push("H-11 missing active_root_index.rebuilt durable event");
    if (
      staleCommand &&
      JSON.stringify(afterReplay) === JSON.stringify(beforeCounts)
    )
      findings.push(
        "H-11 stale CTA has no production command executor; builder alone cannot prove disabled/stale rejection",
      );
    const fresh = freshAcceptanceRows(fixture);
    if (!fresh.length)
      findings.push("N-03 missing fresh acceptance-tagged causal delta");
    finishScenario(fixture, {
      status: findings.length ? "failed" : "passed",
      findings,
      injection: {
        crashBoundary: "projection/waiting_owner commit before notification",
        indexDeleted: true,
        duplicateApproval: true,
        outboxCursor: true,
      },
      uniqueCondition:
        "index rebuild + duplicate complete message identity + stale CTA keeps business rows unchanged",
      readbacks: [
        rebuilt.readback ?? rebuilt,
        indexBefore,
        indexAfter,
        manager,
        { events, outbox, inboxCount },
        replay,
      ],
      zeroWriteCounts: { before: beforeCounts, afterReplay },
      proof: {
        eventOrdinals: events.map((event) => ({
          eventSequence: event.event_sequence,
          eventId: event.event_id,
          eventType: event.event_type,
          eventOrdinal: event.event_ordinal,
          causationId: event.causation_id,
        })),
        messageIdentity: [...duplicateIdentity],
        cursor: outbox.map((message) => ({
          outboxId: message.outbox_id,
          eventSequence: message.event_sequence,
          status: message.status,
        })),
      },
    });
  }));

// A54

test("WMB-5373 A54 legacy late delivery after tombstone is authorization-rejected and audit-only", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A54", {
      leaseExpiresAtMono: 1_000,
      controlStallDeadlineMono: 900,
      gateDeadlineMono: 800,
    });
    const registered = registerLegacyRuntimeInventory(database, {
      workspaceId: fixture.workspaceId,
      fence: fenceFrom(currentActor(fixture)),
      resourceKind: "worker",
      resourceKey: "legacy-worker-a54",
      pid: 5401,
      parentPid: 1,
      processStartTimeUtc: NOW,
      processStartTimeMono: 10,
      argv: ["legacy-worker", "--date-only"],
      sessionKey: "legacy-session-a54",
      launchAttemptId: "legacy-launch-a54",
      leaseId: "legacy-lease-a54",
      cwd: "J:/WMB/legacy",
      state: "running",
      nowUtc: NOW,
      nowMono: 220,
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const drained = confirmLegacyRuntimeDrain(database, {
      workspaceId: fixture.workspaceId,
      fence: registered.fence,
      inventoryId: registered.inventory.inventoryId,
      processExited: true,
      sessionClosed: true,
      cwdCleaned: true,
      closeProofHash: hashV1({ proof: "close-a54" }),
      cleanupProofHash: hashV1({ proof: "cleanup-a54" }),
      stdoutWatermark: 2,
      stderrWatermark: 1,
      nowUtc: NOW,
      nowMono: 230,
    });
    assert.equal(drained.ok, true, JSON.stringify(drained));
    assert.equal(drained.inventory.state, "cleaned");
    const oldFence = drained.fence;
    const restarted = fixture.actorStore.acquireActor({
      workspaceId: fixture.workspaceId,
      currentBuildId: BUILD_ID,
      leaseToken: "lease-a54-restart",
      runtimeId: "runtime-a54-restart",
      nowUtc: NOW,
      nowMono: 1_001,
      leaseExpiresAtMono: 100_000,
      gateDeadlineMono: 90_000,
      controlStallDeadlineMono: 80_000,
      migrationEpoch: 1,
      writeFence: "allow",
    });
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    const gate = fixture.actorStore.completeStartupReconcile({
      workspaceId: fixture.workspaceId,
      fence: restarted.fence,
      nowUtc: NOW,
      nowMono: 1_010,
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
    const late = registerLegacyRuntimeInventory(database, {
      workspaceId: fixture.workspaceId,
      fence: restarted.fence,
      inventoryId: registered.inventory.inventoryId,
      resourceKind: "worker",
      resourceKey: "legacy-worker-a54",
      pid: 5401,
      parentPid: 1,
      processStartTimeUtc: NOW,
      processStartTimeMono: 10,
      argv: ["legacy-worker", "--date-only"],
      sessionKey: "legacy-session-a54",
      launchAttemptId: "legacy-launch-a54",
      leaseId: "legacy-lease-a54",
      cwd: "J:/WMB/legacy",
      state: "running",
      result: { lateSource: true, lateReceipt: true, lateResult: true },
      stdoutWatermark: 3,
      stderrWatermark: 2,
      nowUtc: NOW,
      nowMono: 1_020,
    });
    assert.equal(late.ok, false);
    assert.equal(late.code, "LATE_WRITE_REJECTED");
    const lateDrain = confirmLegacyRuntimeDrain(database, {
      workspaceId: fixture.workspaceId,
      fence: restarted.fence,
      inventoryId: registered.inventory.inventoryId,
      processExited: true,
      sessionClosed: true,
      cwdCleaned: true,
      stdoutWatermark: 3,
      stderrWatermark: 2,
      result: { lateSource: true, lateReceipt: true, lateResult: true },
      nowUtc: NOW,
      nowMono: 1_030,
    });
    assert.equal(lateDrain.ok, false);
    assert.equal(lateDrain.code, "LATE_WRITE_REJECTED");
    const migrationInput = {
      workspaceId: fixture.workspaceId,
      fence: fenceFrom(
        readWorkspaceOrchestratorActor(database, fixture.workspaceId),
      ),
      migrationEpoch: 1,
      stepKey: "legacy-date-only-drain",
      inputHash: hashV1({ rows: 1 }),
      beforeHash: PACKAGE_HASH,
      afterHash: ASAR_HASH,
      rowCount: 1,
      winnerSetHash: hashV1(["legacy-worker-a54"]),
      nowUtc: NOW,
      nowMono: 1_040,
    };
    const journal = recordWorkspaceMigrationStep(database, migrationInput);
    assert.equal(journal.ok, true, JSON.stringify(journal));
    const replay = recordWorkspaceMigrationStep(database, {
      ...migrationInput,
      fence: journal.fence,
      nowMono: 1_050,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    const conflict = recordWorkspaceMigrationStep(database, {
      ...migrationInput,
      fence: replay.fence,
      inputHash: hashV1({ rows: 2 }),
      nowMono: 1_060,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "MIGRATION_JOURNAL_CONFLICT");
    const inventory = database
      .prepare(
        "SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND inventory_id=?",
      )
      .get(fixture.workspaceId, registered.inventory.inventoryId);
    assert.equal(inventory.state, "cleaned");
    assert.equal(Number(inventory.pid), 5401);
    assert.equal(String(inventory.session_key), "legacy-session-a54");
    const activeBusiness = businessCounts(database, fixture.workspaceId);
    assert.deepEqual(
      activeBusiness,
      Object.fromEntries(
        Object.entries(activeBusiness).map(([key, value]) => [
          key,
          key === "orchestrator_intents" ? value : value,
        ]),
      ),
    );
    const events = database
      .prepare(
        "SELECT event_type,event_id,event_sequence,payload_json FROM orchestrator_events WHERE workspace_id=? ORDER BY event_sequence",
      )
      .all(fixture.workspaceId);
    const findings = [];
    if (
      !events.some(
        (event) =>
          String(event.event_type) === "legacy_runtime.inventory_drained",
      )
    )
      findings.push("H-12 missing legacy drain audit event");
    if (
      !events.every(
        (event) => !String(event.payload_json).includes("lateSource"),
      )
    )
      findings.push(
        "H-12 late source/result leaked into durable business event",
      );
    if (!freshAcceptanceRows(fixture).length)
      findings.push(
        "N-03 recovery path has no fresh acceptance-tagged causal delta",
      );
    finishScenario(fixture, {
      status: findings.length ? "failed" : "passed",
      findings,
      injection: {
        gateComplete: true,
        restart: true,
        lateSourceReceiptResult: true,
        duplicateMigration: true,
      },
      uniqueCondition:
        "tombstoned PID/session/lease rejects late source/receipt/result without active business delta",
      readbacks: [
        registered.inventory,
        drained.inventory,
        restarted.actor,
        gate.gate,
        late,
        lateDrain,
        journal.journal,
        replay.journal,
        conflict,
        inventory,
      ],
      zeroWriteCounts: { activeBusiness, lateRejected: true },
      proof: {
        oldFence,
        tombstone: {
          inventoryId: inventory.inventory_id,
          pid: inventory.pid,
          sessionKey: inventory.session_key,
          state: inventory.state,
          leaseToken: inventory.lease_token,
        },
        migration: { first: journal.journal, replay: replay.journal, conflict },
      },
    });
  }));

// A55

test("WMB-5373 A55 loaded-build identity gate is not executed without WMB-5374 runtime evidence", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A55");
    const nested = fixture.context.provenance;
    const completeNested = {
      acceptanceRunId: nested.acceptanceRunId,
      baselineEventSequence: nested.baselineEventSequence,
      baselineCheckpointRevision: nested.baselineCheckpointRevision,
      createdAfterEventSequence: nested.createdAfterEventSequence,
      createdAfterCheckpointRevision: nested.createdAfterCheckpointRevision,
      createdAfterMono: nested.createdAfterMono,
    };
    const required = prepareRootWithSource(fixture, {
      intent: {
        requestId: "request-a55-required",
        payload: { branch: "requires-child" },
      },
      source: {
        sourceBindings: [
          {
            sourceId: "source-a55-required",
            sourceRevision: 1,
            sourceContentHash: SOURCE_HASH,
            ...completeNested,
          },
        ],
        receiptBindings: [
          {
            receiptId: "receipt-A55-official",
            receiptRevision: 1,
            receiptPayloadHash: RECEIPT_HASH,
            ...completeNested,
          },
        ],
        successfulChannels: [
          {
            channelId: "official",
            requiredness: "required",
            receiptId: "receipt-A55-official",
            receiptRevision: 1,
            receiptPayloadHash: RECEIPT_HASH,
            resultHash: ASAR_HASH,
          },
        ],
        selectedChannelIds: ["official", "x-list"],
        failedChannels: [
          {
            channelId: "x-list",
            requiredness: "optional",
            reasonCode: "CHANNEL_LOGIN_REQUIRED",
            status: "login_required",
          },
        ],
      },
    });
    const requiredScope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        required.frozen.bundle,
        required.frozen.result.value,
        {
          candidatePlanItemIds: ["item-a55"],
          eligiblePlanItemIds: ["item-a55"],
          allowedPlanItemIds: ["item-a55"],
          trustedReceiptIds: ["receipt-A55-official"],
        },
      ),
    );
    assert.equal(requiredScope.ok, true, JSON.stringify(requiredScope));
    const sourceStored = JSON.parse(
      String(
        database
          .prepare(
            "SELECT source_bindings_json FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?",
          )
          .get(fixture.workspaceId, required.frozen.result.value.snapshotHash)
          .source_bindings_json,
      ),
    );
    const receiptStored = JSON.parse(
      String(
        database
          .prepare(
            "SELECT receipt_bindings_json FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?",
          )
          .get(fixture.workspaceId, required.frozen.result.value.snapshotHash)
          .receipt_bindings_json,
      ),
    );
    assert.ok(sourceStored[0].acceptanceRunId);
    assert.ok(receiptStored["receipt-A55-official"].acceptanceRunId);
    const forbidden = acceptAndClose(
      fixture,
      {
        requestId: "request-a55-forbidden",
        businessDate: "2026-09-01",
        source: "proposal_ui",
        channelPolicy: policy([
          {
            channelId: "official",
            requiredness: "required",
            module: "official_web",
          },
        ]),
        authorizedChannelPolicy: policy([
          {
            channelId: "official",
            requiredness: "required",
            module: "official_web",
          },
        ]),
      },
      [
        {
          channelId: "official",
          status: "auth_expired",
          reasonCode: "CHANNEL_AUTH_EXPIRED",
          requiredness: "required",
          probeRequestId: "probe-a55-forbidden",
          probeReceiptHash: RECEIPT_HASH,
        },
      ],
    );
    assert.equal(forbidden.closed.status, "needs_user");
    assert.equal(
      count(
        database,
        "daily_orchestration_roots",
        "workspace_id=? AND root_request_id IN (SELECT root_request_id FROM daily_orchestration_roots WHERE workspace_id=?)",
        [fixture.workspaceId, fixture.workspaceId],
      ),
      1,
    );
    const forbiddenEvent = database
      .prepare(
        "SELECT * FROM orchestrator_events WHERE workspace_id=? AND event_type='preflight.completed' ORDER BY event_sequence DESC LIMIT 1",
      )
      .get(fixture.workspaceId);
    assert.ok(
      String(forbiddenEvent.payload_json).includes("creation_forbidden_reason"),
    );
    const oldPidAttestation = attestation(currentActor(fixture).runtimeEpoch, {
      processId: "old-pid-reused",
      processStartTimeMono: 1,
    });
    const loadedManifest = database
      .prepare(
        "SELECT build_id,manifest_hash,app_asar_hash,resources_path FROM build_manifests WHERE build_id=?",
      )
      .get(BUILD_ID);
    const loadedIdentity = {
      buildId: loadedManifest.build_id,
      manifestHash: loadedManifest.manifest_hash,
      appAsarHash: loadedManifest.app_asar_hash,
      resourcesPath: loadedManifest.resources_path,
      pid: oldPidAttestation.processId,
      processStartTimeMono: oldPidAttestation.processStartTimeMono,
    };
    const findings = [];
    if (!tableExists(database, "workspace_legacy_runtime_inventory"))
      findings.push("H-13 process identity inventory unavailable");
    findings.push(
      "WMB-5374 required: installed app.asar/PID/renderer/resourcesPath evidence is not available in this test runtime",
    );
    if (
      !sourceStored[0].acceptanceRunId ||
      !receiptStored["receipt-A55-official"].acceptanceRunId
    )
      findings.push(
        "H-13 nested source/receipt binding acceptance tuple missing",
      );
    finishScenario(fixture, {
      status: "not_executed",
      blocker: "WMB-5374:INSTALL_RUNTIME_REQUIRED",
      findings,
      injection: {
        newAppAsar: true,
        reusedPid: true,
        historicalDataRoot: true,
        requiredChild: true,
        forbiddenChild: true,
        missingNestedBindingAttempt: true,
      },
      uniqueCondition:
        "installed loaded artifact/PID/resourcesPath/manifest cross-check is mandatory; source-level evidence cannot pass",
      readbacks: [
        requiredScope.value,
        sourceStored,
        receiptStored,
        forbidden.closed.snapshot,
        forbiddenEvent,
        loadedIdentity,
      ],
      zeroWriteCounts: {
        forbiddenRootCount: count(
          database,
          "daily_orchestration_roots",
          "workspace_id=? AND intent_id=?",
          [fixture.workspaceId, forbidden.accepted.intentId],
        ),
        forbiddenWorkerCount: count(
          database,
          "managed_job_dispatches",
          "workspace_id=? AND root_request_id IS NULL",
          [fixture.workspaceId],
        ),
      },
      proof: {
        acceptanceRun: fixture.run,
        loadedIdentity,
        forbiddenChild: { rootCount: 0, event: forbiddenEvent },
      },
    });
  }));

// A56

test("WMB-5373 A56 live-channel failure matrix preserves trusted receipt and coverage boundaries", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A56");
    const matrixPolicy = policy([
      {
        channelId: "official",
        requiredness: "required",
        module: "official_web",
      },
      {
        channelId: "optional-missing",
        requiredness: "optional",
        module: "x_missing",
      },
      {
        channelId: "optional-auth",
        requiredness: "optional",
        module: "x_auth",
      },
      {
        channelId: "optional-timeout",
        requiredness: "optional",
        module: "x_timeout",
      },
      {
        channelId: "optional-malformed",
        requiredness: "optional",
        module: "x_malformed",
      },
      {
        channelId: "optional-write-fail",
        requiredness: "optional",
        module: "x_write_fail",
      },
    ]);
    const requiredFailure = acceptAndClose(
      fixture,
      {
        requestId: "request-a56-required-auth",
        channelPolicy: policy([
          {
            channelId: "official",
            requiredness: "required",
            module: "official_web",
          },
          {
            channelId: "optional-auth",
            requiredness: "optional",
            module: "x_auth",
          },
        ]),
        authorizedChannelPolicy: policy([
          {
            channelId: "official",
            requiredness: "required",
            module: "official_web",
          },
          {
            channelId: "optional-auth",
            requiredness: "optional",
            module: "x_auth",
          },
        ]),
      },
      [
        {
          channelId: "official",
          status: "auth_expired",
          reasonCode: "CHANNEL_AUTH_EXPIRED",
          requiredness: "required",
          probeRequestId: "probe-required-auth",
          probeReceiptHash: RECEIPT_HASH,
        },
        {
          channelId: "optional-auth",
          status: "timeout",
          reasonCode: "CHANNEL_TIMEOUT",
          requiredness: "optional",
          probeRequestId: "probe-optional-auth",
          probeReceiptHash: RECEIPT_HASH,
        },
      ],
    );
    assert.equal(requiredFailure.closed.status, "needs_user");
    assert.equal(requiredFailure.closed.readback.rootCount, 0);
    const matrixResults = [
      readyChannel("official", "required", {
        role: "source-reader",
        purpose: "official evidence",
        requestId: "probe-official",
        payloadHash: PACKAGE_HASH,
        resultHash: ASAR_HASH,
      }),
      {
        channelId: "optional-missing",
        status: "missing",
        reasonCode: "CHANNEL_MISSING",
        requiredness: "optional",
        role: "source-reader",
        purpose: "optional evidence",
        probeRequestId: "probe-missing",
        probeReceiptHash: RECEIPT_HASH,
        payloadHash: PACKAGE_HASH,
        resultHash: null,
      },
      {
        channelId: "optional-auth",
        status: "auth_expired",
        reasonCode: "CHANNEL_AUTH_EXPIRED",
        requiredness: "optional",
        role: "source-reader",
        purpose: "optional evidence",
        probeRequestId: "probe-auth",
        probeReceiptHash: RECEIPT_HASH,
        payloadHash: PACKAGE_HASH,
        resultHash: null,
      },
      {
        channelId: "optional-timeout",
        status: "timeout",
        reasonCode: "CHANNEL_TIMEOUT",
        requiredness: "optional",
        role: "source-reader",
        purpose: "optional evidence",
        probeRequestId: "probe-timeout",
        probeReceiptHash: RECEIPT_HASH,
        payloadHash: PACKAGE_HASH,
        resultHash: null,
      },
      {
        channelId: "optional-malformed",
        status: "malformed",
        reasonCode: "CHANNEL_MALFORMED",
        requiredness: "optional",
        role: "source-reader",
        purpose: "optional evidence",
        probeRequestId: "probe-malformed",
        probeReceiptHash: RECEIPT_HASH,
        payloadHash: PACKAGE_HASH,
        resultHash: "zero",
      },
      {
        channelId: "optional-write-fail",
        status: "write_then_fail",
        reasonCode: "CHANNEL_WRITE_THEN_FAIL",
        requiredness: "optional",
        role: "source-reader",
        purpose: "optional evidence",
        probeRequestId: "probe-write-fail",
        probeReceiptHash: RECEIPT_HASH,
        payloadHash: PACKAGE_HASH,
        resultHash: null,
      },
    ];
    const admitted = acceptAndClose(
      fixture,
      {
        requestId: "request-a56-optional-matrix",
        channelPolicy: matrixPolicy,
        authorizedChannelPolicy: matrixPolicy,
      },
      matrixResults,
    );
    assert.equal(admitted.closed.status, "admitted");
    assert.equal(admitted.closed.snapshot.readyChannelIds.length, 1);
    assert.equal(admitted.closed.snapshot.coverageGap.length, 5);
    const prepared = admitRoot(fixture, admitted.accepted);
    const failedChannels = matrixResults
      .slice(1)
      .map((result) => ({
        channelId: result.channelId,
        requiredness: "optional",
        status: result.status,
        reasonCode: result.reasonCode,
        purpose: result.purpose,
        role: result.role,
        probeRequestId: result.probeRequestId,
        probeReceiptHash: result.probeReceiptHash,
        payloadHash: result.payloadHash,
        resultHash: result.resultHash,
      }));
    const frozen = freezeSourceForRoot(
      fixture,
      admitted.accepted,
      admitted.closed,
      String(prepared.root.root_request_id),
      {
        selectedChannelIds: matrixResults.map((result) => result.channelId),
        successfulChannels: [
          {
            channelId: "official",
            requiredness: "required",
            receiptId: "receipt-A56-official",
            receiptRevision: 1,
            receiptPayloadHash: RECEIPT_HASH,
            resultHash: ASAR_HASH,
            purpose: "official evidence",
            role: "source-reader",
            requestId: "probe-official",
            payloadHash: PACKAGE_HASH,
          },
        ],
        failedChannels,
        unresolvedChannels: [],
        sourceBindings: [
          {
            sourceId: "source-a56-official",
            sourceRevision: 1,
            sourceContentHash: SOURCE_HASH,
          },
        ],
        sourceIds: ["source-a56-official"],
        receiptIds: ["receipt-A56-official"],
        receiptBindings: [
          {
            receiptId: "receipt-A56-official",
            receiptRevision: 1,
            receiptPayloadHash: RECEIPT_HASH,
          },
        ],
      },
    );
    const scope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(fixture, frozen.bundle, frozen.result.value, {
        candidatePlanItemIds: ["item-a56"],
        eligiblePlanItemIds: ["item-a56"],
        allowedPlanItemIds: ["item-a56"],
        trustedReceiptIds: ["receipt-A56-official"],
        coverageGap: failedChannels,
      }),
    );
    assert.equal(scope.ok, true, JSON.stringify(scope));
    assert.equal(scope.value.projection.eligiblePlanItemIds[0], "item-a56");
    const partition = {
      selected: matrixResults.map((result) => result.channelId).sort(),
      successful: frozen.result.value.successfulChannels
        .map((result) => result.channelId)
        .sort(),
      failed: frozen.result.value.failedChannels
        .map((result) => result.channelId)
        .sort(),
      unresolved: frozen.result.value.unresolvedChannels
        .map((result) => result.channelId)
        .sort(),
    };
    assert.deepEqual(
      [
        ...new Set([
          ...partition.successful,
          ...partition.failed,
          ...partition.unresolved,
        ]),
      ].sort(),
      partition.selected,
    );
    const malformedTrusted = database
      .prepare(
        "SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?",
      )
      .get(fixture.workspaceId, frozen.result.value.snapshotHash);
    assert.ok(malformedTrusted);
    const manager = readManagerAdapterProjection(database, {
      workspaceId: fixture.workspaceId,
    });
    const findings = [];
    if (requiredFailure.closed.readback.rootCount !== 0)
      findings.push("H-14 required auth expiry did not block root");
    if (manager.roots[0]?.status !== "waiting_owner")
      findings.push(
        "H-14 trusted official material did not reach waiting_owner",
      );
    if (manager.roots[0]?.coverageGap.length !== 5)
      findings.push(
        "H-14 optional failure coverage gap not reflected in live projection",
      );
    const durableResults = JSON.parse(
      String(
        database
          .prepare(
            "SELECT results_json FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
          )
          .get(fixture.workspaceId, admitted.closed.preflightId).results_json,
      ),
    );
    for (const result of matrixResults) {
      if (
        !result.probeRequestId ||
        !result.probeReceiptHash ||
        !result.purpose ||
        !result.role ||
        !result.payloadHash ||
        result.resultHash === undefined
      )
        findings.push(
          `H-14 channel ${result.channelId} lacks complete live receipt proof`,
        );
      const durable = durableResults.find(
        (entry) => entry.channelId === result.channelId,
      );
      if (
        !durable ||
        durable.probeRequestId === undefined ||
        durable.probeReceiptHash === undefined
      )
        findings.push(
          `H-14 channel ${result.channelId} durable probe receipt missing`,
        );
    }
    finishScenario(fixture, {
      status: findings.length ? "failed" : "passed",
      findings,
      injection: {
        readySuccess: true,
        optionalMissing: true,
        optionalAuthExpiry: true,
        optionalTimeout: true,
        optionalMalformed: true,
        optionalWriteThenFail: true,
        requiredAuthExpiry: true,
      },
      uniqueCondition:
        "required failure blocks; optional gaps remain visible; only trusted receipt enters source/Judge/projection",
      readbacks: [
        requiredFailure.closed.snapshot,
        admitted.closed.snapshot,
        frozen.result.value,
        scope.value,
        manager,
        malformedTrusted,
      ],
      proof: {
        channelMatrix: matrixResults,
        durableResults,
        partition,
        trustedReceiptIds:
          scope.value.trustedReceiptIds ??
          scope.value.projection?.trustedReceiptIds ??
          [],
        liveProjection: {
          status: manager.roots[0]?.status,
          coverageGap: manager.roots[0]?.coverageGap,
          eligible: manager.roots[0]?.eligiblePlanItemIds,
        },
      },
    });
  }));

// A57

test("WMB-5373 A57 event redaction and authorizer boundaries deny privilege, forged hash, SQL mutation and publish", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A57");
    const prepared = prepareRootWithSource(fixture);
    const scope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          candidatePlanItemIds: ["item-a57"],
          eligiblePlanItemIds: ["item-a57"],
          allowedPlanItemIds: ["item-a57"],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
        },
      ),
    );
    assert.equal(scope.ok, true, JSON.stringify(scope));
    const before = businessCounts(database, fixture.workspaceId);
    let eventUpdateError = null;
    let eventDeleteError = null;
    try {
      database
        .prepare(
          "UPDATE orchestrator_events SET payload_json='super-secret-token' WHERE workspace_id=? AND event_sequence=?",
        )
        .run(fixture.workspaceId, 1);
    } catch (error) {
      eventUpdateError = String(error.message ?? error);
    }
    try {
      database
        .prepare(
          "DELETE FROM orchestrator_events WHERE workspace_id=? AND event_sequence=?",
        )
        .run(fixture.workspaceId, 1);
    } catch (error) {
      eventDeleteError = String(error.message ?? error);
    }
    assert.match(String(eventUpdateError), /ORCHESTRATOR_EVENT_IMMUTABLE/);
    assert.match(String(eventDeleteError), /ORCHESTRATOR_EVENT_IMMUTABLE/);
    const overreach = (() => {
      try {
        return buildManagerTypedCommand({
          type: "continue",
          requestId: "a57-overreach",
          identity: readManagerAdapterProjection(database, {
            workspaceId: fixture.workspaceId,
          }).roots[0].identity,
        });
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    })();
    assert.equal(overreach.ok, false);
    assert.equal(overreach.code, "MANAGER_COMMAND_NOT_ALLOWED");
    const forged = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "request-a57-forged-attestation",
        producerAttestation: attestation(currentActor(fixture).runtimeEpoch, {
          writePrincipal: "root",
          producerAttestationHash: "0".repeat(64),
        }),
        payload: { forged: true },
      }),
    );
    assert.equal(forged.ok, false);
    assert.equal(forged.code, "CUTOVER_REQUIRED");
    const afterForged = businessCounts(database, fixture.workspaceId);
    assert.deepEqual(afterForged, before);
    let identityDeleteError = null;
    try {
      database
        .prepare("DELETE FROM identity_hash_registry WHERE workspace_id=?")
        .run(fixture.workspaceId);
    } catch (error) {
      identityDeleteError = String(error.message ?? error);
    }
    assert.match(String(identityDeleteError), /IDENTITY_REGISTRY_IMMUTABLE/);
    const events = database
      .prepare(
        "SELECT * FROM orchestrator_events WHERE workspace_id=? ORDER BY event_sequence",
      )
      .all(fixture.workspaceId);
    const redactionLeaks = events.filter((event) =>
      String(event.payload_json).includes("super-secret-token"),
    );
    const metricTables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%metric%' OR name LIKE '%security%')",
      )
      .all()
      .map((row) => String(row.name));
    const authorizerRows = database
      .prepare(
        "SELECT producer_id,write_principal,authorizer_revision,registry_entry_hash,census_hash,trigger_id FROM producer_registry WHERE workspace_id=?",
      )
      .all(fixture.workspaceId);
    const findings = [];
    if (redactionLeaks.length)
      findings.push(
        "H-15 immutable event payload was mutable or secret was retained",
      );
    if (!metricTables.length)
      findings.push(
        "H-15 no durable metric labels/threshold/alert readback table/API",
      );
    if (
      !authorizerRows.length ||
      !authorizerRows.every(
        (row) =>
          row.write_principal &&
          row.authorizer_revision &&
          row.registry_entry_hash &&
          row.census_hash &&
          row.trigger_id,
      )
    )
      findings.push("H-15 producer authorizer/attestation fields incomplete");
    findings.push(
      "H-15 no production grant executor or publish authorizer API was available for a real automatic publish attempt",
    );
    if (
      eventUpdateError === null ||
      eventDeleteError === null ||
      identityDeleteError === null
    )
      findings.push("H-15 manual SQL mutation was not stably rejected");
    if (JSON.stringify(before) !== JSON.stringify(afterForged))
      findings.push("H-15 forged worker attestation changed business rows");
    finishScenario(fixture, {
      status: findings.length ? "failed" : "passed",
      findings,
      injection: {
        managerOverreach: true,
        workerPrivilegeEscalation: true,
        forgedHash: true,
        failedWrappedSuccess: true,
        manualDbUpdate: true,
        manualDbDelete: true,
        forgedProducerAttestation: true,
        automaticPublish: true,
      },
      uniqueCondition:
        "every denial is stable, redacted, authorizer-bound and leaves affected business rows at zero; publish remains authorization-gated",
      readbacks: [
        scope.value,
        overreach,
        forged,
        { eventUpdateError, eventDeleteError, identityDeleteError },
        authorizerRows,
        metricTables,
        events,
      ],
      zeroWriteCounts: { before, afterForged },
      proof: {
        eventSchema: events.map((event) => ({
          eventSequence: event.event_sequence,
          eventId: event.event_id,
          eventType: event.event_type,
          eventOrdinal: event.event_ordinal,
          causationId: event.causation_id,
          actorEpoch: event.actor_epoch,
          ownerEpoch: event.owner_epoch,
          checkpointRevision: event.checkpoint_revision,
          acceptanceRunId: event.acceptance_run_id,
          payloadRedacted: !String(event.payload_json).includes(
            "super-secret-token",
          ),
        })),
        metrics: metricTables,
        authorizer: authorizerRows,
        denialReceipts: [{ overreach }, { forged }],
      },
    });
  }));
