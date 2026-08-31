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
import { readManagerAdapterProjection } from "../src/main/workspace-orchestrator-manager-adapter.ts";

const NOW = "2026-08-31T08:00:00.000Z";
const BUILD_ID = "build-wmb-5372";
const MANIFEST_HASH = "d".repeat(64);
const SOURCE_COMMIT = "source-wmb-5372";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const ACCEPTANCE_COLUMNS = [
  "acceptance_run_id",
  "baseline_event_sequence",
  "baseline_checkpoint_revision",
  "created_after_event_sequence",
  "created_after_checkpoint_revision",
  "created_after_mono",
];
const PROVENANCE_TABLES = [
  "workspace_orchestrator_actors",
  "orchestrator_mailbox",
  "command_receipts",
  "orchestrator_intents",
  "channel_preflight_snapshots",
  "daily_orchestration_roots",
  "daily_stage_claims",
  "source_snapshots",
  "daily_repair_snapshot_bindings",
  "daily_plan_scopes",
  "managed_job_dispatches",
  "managed_effect_consumptions",
  "orchestrator_events",
  "orchestrator_outbox",
  "orchestrator_inbox",
];

function withDatabase(work) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmb-5372-acceptance-"),
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
  ) VALUES (?, 'producer.acceptance', ?, 1, 'tests/wmb-5372-workspace-orchestrator-acceptance.test.mjs', 'owner', 'trigger.acceptance',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_acceptance_test',
    'auth-wmb-5372', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`,
    )
    .run(workspaceId, BUILD_ID, "registry-wmb-5372", "census-wmb-5372", NOW);
}

function attestation(runtimeEpoch) {
  return {
    producerId: "producer.acceptance",
    registryEntryHash: "registry-wmb-5372",
    censusHash: "census-wmb-5372",
    triggerId: "trigger.acceptance",
    processId: "5372",
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
    authorizerRevision: "auth-wmb-5372",
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
    options.workspaceId ?? `wmb-5372-${scenarioId.toLowerCase()}`;
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
  const actor = actorStore.readActor(workspaceId);
  assert.ok(actor);
  const started = startAcceptanceRun(
    database,
    {
      workspaceId,
      scenarioId,
      acceptanceRunId: `acceptance-run-wmb-5372-${scenarioId}`,
      acceptanceNamespace: `acceptance/wmb-5372/${scenarioId}`,
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
      defaultEvidenceRoot: "acceptance-evidence/wmb-5372",
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

function policyWithOptional() {
  return [
    { channelId: "official", requiredness: "required", module: "official_web" },
    { channelId: "x-list", requiredness: "optional", module: "x_list" },
  ];
}

function policyRequiredOnly() {
  return [
    { channelId: "official", requiredness: "required", module: "official_web" },
  ];
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
  const channelPolicy = overrides.channelPolicy ?? policyWithOptional();
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    businessDate: overrides.businessDate ?? "2026-08-31",
    source,
    rootMode,
    requestedAction: overrides.requestedAction ?? "full",
    requestId,
    producerId: "producer.acceptance",
    producerAttestation: attestation(actor.runtimeEpoch),
    logicalInput: payload,
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

function closePreflight(fixture, accepted, channelResults, overrides = {}) {
  const actor = currentActor(fixture);
  const closed = fixture.actorStore.closePreflight(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      intentId: accepted.intentId,
      requestId: accepted.requestId,
      profileRevision: overrides.profileRevision ?? 7,
      channelResults,
      nowUtc: NOW,
      nowMono: overrides.nowMono ?? tick(fixture),
      fence: fenceFrom(actor),
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
  const closed = closePreflight(fixture, accepted, channelResults);
  return { accepted, closed };
}

function admitRoot(fixture, accepted, overrides = {}) {
  const actor = currentActor(fixture);
  const admitted = fixture.rootStore.admitRoot(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      intentId: accepted.intentId,
      requestId: accepted.requestId,
      fence: fenceFrom(actor),
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
  const stage =
    rootBundle.claims.find(
      (claim) => String(claim.attempt_stage) !== "judge",
    ) ?? rootBundle.claims[0];
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
  const successfulChannels = (
    options.successfulChannels ??
    selectedChannelIds.map((channelId) => ({
      channelId,
      requiredness: channelId === "official" ? "required" : "optional",
      receiptId: `receipt-${fixture.scenarioId}-${channelId}`,
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
  const failedChannels = options.failedChannels ?? [];
  const unresolvedChannels = options.unresolvedChannels ?? [];
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
    ...options.extra,
  });
}

function freezeSource(fixture, accepted, closed, options = {}) {
  const rootBundle = fixture.rootStore.readRoot(
    fixture.workspaceId,
    String(options.rootRequestId ?? accepted.rootRequestId ?? ""),
  );
  const root =
    rootBundle.root ??
    fixture.rootStore.readRoot(fixture.workspaceId, options.rootRequestId).root;
  const actualRootBundle = root
    ? rootBundle
    : fixture.rootStore.readRoot(
        fixture.workspaceId,
        String(options.rootRequestId),
      );
  const rootRow = actualRootBundle.root;
  assert.ok(rootRow);
  const preflight = fixture.database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(fixture.workspaceId, closed.preflightId);
  assert.ok(preflight);
  const input = sourceInput(fixture, actualRootBundle, preflight, options);
  const result = fixture.snapshotStore.freezeSourceSnapshot(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { result, bundle: actualRootBundle, preflight, input };
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

function stageDInput(fixture, bundle, options = {}) {
  const root = bundle.root;
  const stage = options.stageRequestId
    ? bundle.claims.find(
        (claim) =>
          String(claim.stage_request_id) === String(options.stageRequestId),
      )
    : (bundle.claims.find((claim) => String(claim.attempt_stage) !== "judge") ??
      bundle.claims[0]);
  assert.ok(root);
  assert.ok(stage);
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    cycleId: options.cycleId ?? `cycle-${fixture.scenarioId}`,
    targets: options.targets ?? [],
    effects: options.effects ?? [],
    retryTargetIds: options.retryTargetIds ?? [],
    targetSetHash: options.targetSetHash,
    effectSetHash: options.effectSetHash,
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: options.nowMono ?? tick(fixture),
  });
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
  const entries =
    options.entries ??
    all.map((planItemId) => ({
      planItemId,
      classification: eligible.includes(planItemId)
        ? "eligible"
        : pending.includes(planItemId)
          ? "pending"
          : "invalid",
      sourceReceiptIds: options.trustedReceiptIds ?? [
        `receipt-${fixture.scenarioId}-official`,
      ],
    }));
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    sourceSnapshotHash: String(
      options.sourceSnapshotHash ??
        source.snapshotHash ??
        source.result?.value?.snapshotHash ??
        source.value?.snapshotHash,
    ),
    managerTaskId: String(root.manager_task_id),
    orchestrationId: String(root.orchestration_id),
    attemptStage: String(stage.attempt_stage),
    allowedPlanIds: options.allowedPlanIds ?? ["plan-1"],
    allowedPlanItemIds: options.allowedPlanItemIds ?? all,
    carryPlanItemIds: options.carryPlanItemIds ?? [],
    trustedReceiptIds: options.trustedReceiptIds ?? [
      `receipt-${fixture.scenarioId}-official`,
    ],
    scope: options.scope ?? { purpose: "acceptance" },
    projection: {
      planIds: options.planIds ?? ["plan-1"],
      asOf: { utc: NOW, mono: fixture.nowMono },
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

function assertAllProvenance(fixture, expectedTables = []) {
  const { database, context, run } = fixture;
  const expected = new Set(expectedTables);
  for (const table of PROVENANCE_TABLES) {
    if (!tableExists(database, table)) continue;
    const columns = tableColumns(database, table);
    const complete = ACCEPTANCE_COLUMNS.every((column) =>
      columns.includes(column),
    );
    if (!columns.includes("workspace_id")) {
      if (expected.has(table))
        assert.fail(`${table} lacks workspace_id for scoped acceptance proof`);
      continue;
    }
    const rows = complete
      ? database
          .prepare(`SELECT * FROM "${table}" WHERE workspace_id=?`)
          .all(fixture.workspaceId)
      : [];
    const tagged = rows.filter((row) =>
      ACCEPTANCE_COLUMNS.some(
        (column) => row[column] !== null && row[column] !== undefined,
      ),
    );
    for (const row of tagged) {
      assert.ok(
        ACCEPTANCE_COLUMNS.every(
          (column) => row[column] !== null && row[column] !== undefined,
        ),
        `${table} has incomplete acceptance tuple`,
      );
      assert.equal(
        String(row.acceptance_run_id),
        run.acceptanceRunId,
        `${table} has wrong acceptance run`,
      );
      assert.equal(
        Number(row.baseline_event_sequence),
        run.baselineEventSequence,
        `${table} baseline event drift`,
      );
      assert.equal(
        Number(row.baseline_checkpoint_revision),
        run.baselineCheckpointRevision,
        `${table} baseline checkpoint drift`,
      );
      assert.ok(
        Number(row.created_after_event_sequence) > run.baselineEventSequence,
        `${table} event freshness`,
      );
      assert.ok(
        Number(row.created_after_checkpoint_revision) >
          run.baselineCheckpointRevision,
        `${table} checkpoint freshness`,
      );
      assert.ok(
        Number(row.created_after_mono) >= run.freshAfterMono,
        `${table} monotonic freshness`,
      );
    }
    if (expected.has(table)) {
      assert.ok(complete, `${table} missing acceptance columns`);
      assert.ok(
        rows.some(
          (row) => String(row.acceptance_run_id) === run.acceptanceRunId,
        ),
        `${table} has no tagged row`,
      );
    }
  }
  const taggedEvents = context.readEventProof();
  for (const event of taggedEvents) {
    assert.equal(String(event.acceptance_run_id), run.acceptanceRunId);
    assert.ok(Number(event.event_sequence) > run.baselineEventSequence);
  }
  return taggedEvents;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function finishScenario(fixture, observation) {
  const status =
    observation.status ?? (observation.passed === true ? "passed" : "failed");
  const evidencePointer =
    observation.evidencePointer ??
    `acceptance-evidence/wmb-5372/${fixture.scenarioId}/${fixture.run.acceptanceRunId}`;
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
      defaultEvidenceRoot: "acceptance-evidence/wmb-5372",
    },
  );
  assert.equal(finished.ok, true);
  assert.equal(finished.replayed, false);
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
      defaultEvidenceRoot: "acceptance-evidence/wmb-5372",
    },
  );
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.resultHash, finished.resultHash);
  return finished;
}

function assertNoChildren(fixture, rootRequestId = null) {
  const where = rootRequestId
    ? "workspace_id=? AND root_request_id=?"
    : "workspace_id=?";
  const params = rootRequestId
    ? [fixture.workspaceId, rootRequestId]
    : [fixture.workspaceId];
  assert.equal(
    count(fixture.database, "daily_orchestration_roots", where, params),
    0,
  );
  assert.equal(count(fixture.database, "daily_stage_claims", where, params), 0);
  assert.equal(
    count(fixture.database, "managed_job_dispatches", where, params),
    0,
  );
}

function reporterDispatch(fixture, bundle) {
  return (
    bundle.dispatches.find(
      (dispatch) => String(dispatch.role_id ?? dispatch.roleId) === "reporter",
    ) ?? bundle.dispatches[0]
  );
}

function settleReporter(fixture, dispatch, result = { sources: 1 }) {
  const settled = fixture.resourceStore.settleTerminal(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      jobId: String(dispatch.job_id ?? dispatch.jobId),
      childIdentityKey: String(
        dispatch.child_identity_key ?? dispatch.childIdentityKey,
      ),
      operationRequestId: String(
        dispatch.operation_request_id ?? dispatch.operationRequestId,
      ),
      fence: fenceFrom(currentActor(fixture)),
      expectedParentClaimRevision: Number(
        fixture.rootStore
          .readRoot(
            fixture.workspaceId,
            String(dispatch.root_request_id ?? dispatch.rootRequestId),
          )
          .claims.find(
            (claim) =>
              String(claim.stage_request_id) ===
              String(
                dispatch.parent_stage_request_id ??
                  dispatch.parentStageRequestId,
              ),
          )?.claim_revision ??
          dispatch.expected_parent_claim_revision ??
          dispatch.expectedParentClaimRevision,
      ),
      terminalStatus: "succeeded",
      resultStatus: "succeeded",
      resultHash: HEX_B,
      result,
      nowUtc: NOW,
      nowMono: tick(fixture),
    }),
  );
  assert.equal(settled.ok, true, JSON.stringify(settled));
  return settled;
}

function makeEffect(logicalKey = "publish-1", deliveryMode = "exactly_once") {
  return {
    action: "publish",
    effectLogicalKey: logicalKey,
    effectAttemptOrdinal: 1,
    roleId: "writer",
    sinkName: "content-publish",
    sinkRoleId: "writer",
    sinkContractVersion: "1",
    deliveryMode,
  };
}

function prepareRootWithSource(fixture, options = {}) {
  const { accepted, closed } = acceptAndClose(
    fixture,
    options.intent ?? {},
    options.channelResults ?? [
      readyChannel("official"),
      readyChannel("x-list", "optional"),
    ],
  );
  const admitted = admitRoot(fixture, accepted, options.root ?? {});
  const rootRequestId = String(admitted.root.root_request_id);
  const frozen = freezeSourceForRoot(
    fixture,
    accepted,
    closed,
    rootRequestId,
    options.source ?? {},
  );
  return { accepted, closed, admitted, rootRequestId, frozen };
}

// A01

test("WMB-5372 A01 required ready plus optional login gap freezes preflight before root", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A01");
    const { accepted, closed } = acceptAndClose(fixture, {}, [
      readyChannel("official", "required"),
      {
        channelId: "x-list",
        status: "login_required",
        reasonCode: "CHANNEL_LOGIN_REQUIRED",
        requiredness: "optional",
      },
    ]);
    assert.equal(closed.status, "admitted");
    assert.deepEqual(closed.snapshot.readyChannelIds, ["official"]);
    assert.deepEqual(closed.snapshot.excludedOptionalChannelIds, ["x-list"]);
    const admitted = admitRoot(fixture, accepted);
    const rootId = String(admitted.root.root_request_id);
    const frozen = freezeSourceForRoot(fixture, accepted, closed, rootId, {
      selectedChannelIds: ["official", "x-list"],
      successfulChannels: [
        {
          channelId: "official",
          requiredness: "required",
          receiptId: `receipt-${fixture.scenarioId}-official`,
          receiptRevision: 1,
          receiptPayloadHash: HEX_A,
          resultHash: HEX_B,
          configRevision: 1,
          authRevision: 1,
          capabilityLeaseId: "cap-official",
        },
      ],
      failedChannels: [
        {
          channelId: "x-list",
          requiredness: "optional",
          reasonCode: "CHANNEL_LOGIN_REQUIRED",
        },
      ],
    });
    assert.equal(frozen.result.value.successfulChannels.length, 1);
    assert.equal(frozen.result.value.failedChannels.length, 1);
    assertAllProvenance(fixture, [
      "orchestrator_intents",
      "channel_preflight_snapshots",
      "daily_orchestration_roots",
      "daily_stage_claims",
      "source_snapshots",
      "managed_job_dispatches",
      "orchestrator_events",
      "orchestrator_outbox",
    ]);
    finishScenario(fixture, {
      proof: {
        preflight: closed.snapshot,
        root: admitted.root,
        source: frozen.result.value,
      },
      readbacks: [closed.snapshot, admitted.root, frozen.result.value],
      expectedChildren: {
        required: [
          {
            table: "source_snapshots",
            count: 1,
            where: {
              stage_request_id: String(frozen.result.value.stageRequestId),
            },
          },
        ],
      },
    });
  }));

// A02

test("WMB-5372 A02 required login blocks children and a repaired request creates a new preflight/root", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A02");
    const first = acceptAndClose(fixture, {}, [
      {
        channelId: "official",
        status: "login_required",
        reasonCode: "CHANNEL_LOGIN_REQUIRED",
        requiredness: "required",
      },
      readyChannel("x-list", "optional"),
    ]);
    assert.equal(first.closed.status, "needs_user");
    assert.equal(first.closed.code, "CHANNEL_CONFIGURATION_REQUIRED");
    assertNoChildren(fixture);
    const second = acceptAndClose(
      fixture,
      { requestId: "request-a02-repaired" },
      [
        readyChannel("official", "required"),
        readyChannel("x-list", "optional"),
      ],
    );
    assert.equal(second.closed.status, "admitted");
    const admitted = admitRoot(fixture, second.accepted);
    assert.equal(
      count(database, "channel_preflight_snapshots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      2,
    );
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    assert.equal(
      String(admitted.root.intent_id),
      String(second.accepted.intentId),
    );
    assertAllProvenance(fixture, [
      "orchestrator_intents",
      "channel_preflight_snapshots",
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        blocked: first.closed.readback,
        repaired: second.closed.readback,
        root: admitted.root,
      },
      readbacks: [first.closed.snapshot, second.closed.snapshot, admitted.root],
    });
  }));

// A03

test("WMB-5372 A03 all selected channels fail with durable CHANNELS_ALL_FAILED and no clean-empty root", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A03");
    const { accepted, closed } = acceptAndClose(fixture, {}, [
      {
        channelId: "official",
        status: "timeout",
        reasonCode: "CHANNEL_TIMEOUT",
        requiredness: "required",
      },
      {
        channelId: "x-list",
        status: "timeout",
        reasonCode: "CHANNEL_TIMEOUT",
        requiredness: "optional",
      },
    ]);
    assert.equal(closed.status, "partial");
    assert.equal(closed.code, "CHANNELS_ALL_FAILED");
    assert.equal(closed.snapshot.readyChannelIds.length, 0);
    assert.equal(closed.snapshot.coverageGap.length, 1);
    assertNoChildren(fixture);
    assert.ok(
      fixture.context.readEventProof("preflight.completed").length >= 1,
    );
    assertAllProvenance(fixture, [
      "orchestrator_intents",
      "channel_preflight_snapshots",
      "orchestrator_events",
      "orchestrator_outbox",
    ]);
    finishScenario(fixture, {
      proof: {
        accepted,
        preflight: closed.snapshot,
        reasonCode: closed.reasonCode,
        rootCount: 0,
      },
      readbacks: [closed.snapshot],
    });
  }));

// A04

test("WMB-5372 A04 full root creates independent F/J stages and atomic handoff", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A04");
    const prepared = prepareRootWithSource(fixture);
    const handoff = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: prepared.rootRequestId,
        stageRequestId: String(
          prepared.frozen.bundle.claims.find(
            (claim) => String(claim.attempt_stage) !== "judge",
          ).stage_request_id,
        ),
        sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
        currentChannelFences: prepared.frozen.input.currentChannelFences,
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(handoff.ok, true, JSON.stringify(handoff));
    const claims = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    ).claims;
    assert.equal(
      claims.filter((claim) => String(claim.attempt_stage) !== "judge").length,
      1,
    );
    assert.equal(
      claims.filter((claim) => String(claim.attempt_stage) === "judge").length,
      1,
    );
    assert.equal(
      claims.find((claim) => String(claim.attempt_stage) !== "judge").status,
      "succeeded",
    );
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=? AND role_id=?",
        [fixture.workspaceId, prepared.rootRequestId, "judge"],
      ),
      1,
    );
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "source_snapshots",
      "managed_job_dispatches",
      "orchestrator_events",
      "orchestrator_outbox",
    ]);
    finishScenario(fixture, {
      proof: {
        source: prepared.frozen.result.value,
        handoff: handoff.readback,
        claims,
      },
      readbacks: [prepared.frozen.result.value, handoff.readback, claims],
    });
  }));

// A05

test("WMB-5372 A05 frozen scan automatically hands off one judge and replay adds no child", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A05");
    const prepared = prepareRootWithSource(fixture);
    const rootBundle = prepared.frozen.bundle;
    const scan = rootBundle.claims.find(
      (claim) => String(claim.attempt_stage) !== "judge",
    );
    const handoffInput = acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      rootRequestId: prepared.rootRequestId,
      stageRequestId: String(scan.stage_request_id),
      sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
      fence: fenceFrom(currentActor(fixture)),
      currentChannelFences: prepared.frozen.input.currentChannelFences,
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    const first = fixture.rootStore.handoffToJudge(handoffInput);
    assert.equal(first.ok, true, JSON.stringify(first));
    const before = {
      claims: count(database, "daily_stage_claims"),
      jobs: count(database, "managed_job_dispatches"),
      events: count(database, "orchestrator_events"),
    };
    const replay = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        ...handoffInput,
        fence: fenceFrom(currentActor(fixture)),
        nowMono: tick(fixture),
      }),
    );
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
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "source_snapshots",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { first: first.readback, replay: replay.readback },
      readbacks: [first.readback, replay.readback],
    });
  }));

// A06

test("WMB-5372 A06 trusted frozen predecessor completes one constrained judge handoff without rescanning", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A06");
    const prepared = prepareRootWithSource(fixture);
    const scan = prepared.frozen.bundle.claims.find(
      (claim) => String(claim.attempt_stage) !== "judge",
    );
    const handoff = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: prepared.rootRequestId,
        stageRequestId: String(scan.stage_request_id),
        sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
        expectedClaimRevision: Number(scan.claim_revision),
        expectedRootCheckpointRevision: Number(
          prepared.frozen.bundle.root.checkpoint_revision,
        ),
        currentChannelFences: prepared.frozen.input.currentChannelFences,
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(handoff.ok, true, JSON.stringify(handoff));
    const after = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    assert.equal(
      after.claims.filter((claim) => String(claim.attempt_stage) === "judge")
        .length,
      1,
    );
    assert.equal(
      after.claims.filter((claim) => String(claim.attempt_stage) !== "judge")
        .length,
      1,
    );
    assert.equal(
      after.claims.filter((claim) => String(claim.attempt_stage) !== "judge")[0]
        .status,
      "succeeded",
    );
    assertAllProvenance(fixture, [
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        predecessor: scan,
        sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
        handoff: handoff.readback,
      },
      readbacks: [scan, handoff.readback],
    });
  }));

// A07

test("WMB-5372 A07 no trusted continuation material settles reporter partial without a judge", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A07");
    const { accepted, closed } = acceptAndClose(fixture);
    const admitted = admitRoot(fixture, accepted);
    const rootId = String(admitted.root.root_request_id);
    const claim = fixture.rootStore.readRoot(fixture.workspaceId, rootId)
      .claims[0];
    const settled = fixture.rootStore.settleStage(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        stageRequestId: String(claim.stage_request_id),
        expectedClaimRevision: Number(claim.claim_revision),
        expectedRootCheckpointRevision: Number(
          admitted.root.checkpoint_revision,
        ),
        status: "partial",
        rootStatus: "partial",
        reasonCode: "NO_CONTINUATION_MATERIAL",
        result: { trustedSources: 0, sourceSnapshotHash: null },
        nextAction: {
          kind: "no_action",
          reasonCode: "NO_CONTINUATION_MATERIAL",
        },
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(
      count(
        database,
        "daily_stage_claims",
        "workspace_id=? AND root_request_id=? AND attempt_stage=?",
        [fixture.workspaceId, rootId, "judge"],
      ),
      0,
    );
    assert.equal(
      fixture.rootStore.readRoot(fixture.workspaceId, rootId).root.status,
      "partial",
    );
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { preflight: closed.snapshot, settled: settled.readback },
      readbacks: [closed.snapshot, settled.readback],
    });
  }));

// A08

test("WMB-5372 A08 changed source revision is rejected as SOURCE_SNAPSHOT_STALE and old snapshot remains immutable", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A08");
    const prepared = prepareRootWithSource(fixture);
    const oldSnapshot = prepared.frozen.result.value;
    const drifted = fixture.snapshotStore.freezeSourceSnapshot(
      acceptanceInput(fixture.context, {
        ...prepared.frozen.input,
        currentSourceBindings: [
          {
            sourceId: `source-${fixture.scenarioId}-1`,
            sourceRevision: 2,
            sourceContentHash: HEX_A,
          },
        ],
        sourceBindings: [
          {
            sourceId: `source-${fixture.scenarioId}-1`,
            sourceRevision: 2,
            sourceContentHash: HEX_A,
          },
        ],
        sourceIds: [`source-${fixture.scenarioId}-1`],
        nowMono: tick(fixture),
      }),
    );
    assert.equal(drifted.ok, false, JSON.stringify(drifted));
    assert.equal(drifted.code, "SOURCE_SNAPSHOT_STALE");
    const reread = fixture.snapshotStore.readSourceSnapshot(
      fixture.workspaceId,
      oldSnapshot.stageRequestId,
    );
    assert.ok(reread);
    assert.equal(reread.snapshotHash, oldSnapshot.snapshotHash);
    assert.equal(reread.sourceBindings[0].sourceRevision, 1);
    assertAllProvenance(fixture, [
      "source_snapshots",
      "daily_stage_claims",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { oldSnapshot, drifted, reread },
      readbacks: [oldSnapshot, drifted, reread],
    });
  }));

// A09

test("WMB-5372 A09 eligible projection freezes with waiting_owner and approval IDs", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A09");
    const prepared = prepareRootWithSource(fixture);
    const stage = prepared.frozen.bundle.claims[0];
    const scope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          allowedPlanItemIds: ["item-eligible"],
          candidatePlanItemIds: ["item-eligible"],
          eligiblePlanItemIds: ["item-eligible"],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
          entries: [
            {
              planItemId: "item-eligible",
              classification: "eligible",
              sourceReceiptIds: [`receipt-${fixture.scenarioId}-official`],
            },
          ],
        },
      ),
    );
    assert.equal(scope.ok, true, JSON.stringify(scope));
    assert.equal(
      scope.value.projection.eligiblePlanItemIds[0],
      "item-eligible",
    );
    const root = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    ).root;
    assert.equal(root.status, "waiting_owner");
    const manager = readManagerAdapterProjection(database, {
      workspaceId: fixture.workspaceId,
      rootRequestId: prepared.rootRequestId,
    });
    assert.equal(manager.roots.length, 1, JSON.stringify(manager));
    const managerRoot = manager.roots[0];
    assert.deepEqual(managerRoot.eligiblePlanItemIds, ["item-eligible"]);
    assertAllProvenance(fixture, [
      "daily_plan_scopes",
      "daily_stage_claims",
      "daily_orchestration_roots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { scope: scope.value, root, manager },
      readbacks: [scope.value, root, manager],
    });
  }));

// A10

test("WMB-5372 A10 empty projection is frozen and settles succeeded with emptyQualified", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A10");
    const prepared = prepareRootWithSource(fixture);
    const scope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          allowedPlanItemIds: [],
          candidatePlanItemIds: [],
          eligiblePlanItemIds: [],
          pendingPlanItemIds: [],
          invalidPlanItemIds: [],
          trustedReceiptIds: prepared.frozen.result.value.receiptIds,
          candidateInputCount: 0,
          classifiedCount: 0,
          entries: [],
          coverageGap: [],
          emptyQualified: true,
        },
      ),
    );
    assert.equal(scope.ok, true, JSON.stringify(scope));
    assert.equal(scope.value.projection.emptyQualified, true);
    const root = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    ).root;
    assert.equal(root.status, "succeeded");
    assert.equal(root.finished_at !== null, true);
    const index = fixture.database
      .prepare(
        "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
      )
      .get(fixture.workspaceId, prepared.rootRequestId);
    assert.equal(index.projection_state, "frozen");
    assertAllProvenance(fixture, [
      "daily_plan_scopes",
      "daily_stage_claims",
      "daily_orchestration_roots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { scope: scope.value, root, index },
      readbacks: [scope.value, root, index],
    });
  }));

// A11

test("WMB-5372 A11 seven projection classification combinations preserve priority and approval scope", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A11");
    const combinations = [
      { name: "E", eligiblePlanItemIds: ["e"], candidatePlanItemIds: ["e"] },
      { name: "P", pendingPlanItemIds: ["p"], candidatePlanItemIds: ["p"] },
      { name: "I", invalidPlanItemIds: ["i"], candidatePlanItemIds: ["i"] },
      {
        name: "EP",
        eligiblePlanItemIds: ["e"],
        pendingPlanItemIds: ["p"],
        candidatePlanItemIds: ["e", "p"],
      },
      {
        name: "EI",
        eligiblePlanItemIds: ["e"],
        invalidPlanItemIds: ["i"],
        candidatePlanItemIds: ["e", "i"],
      },
      {
        name: "PI",
        pendingPlanItemIds: ["p"],
        invalidPlanItemIds: ["i"],
        candidatePlanItemIds: ["i", "p"],
      },
      {
        name: "EPI",
        eligiblePlanItemIds: ["e"],
        pendingPlanItemIds: ["p"],
        invalidPlanItemIds: ["i"],
        candidatePlanItemIds: ["e", "i", "p"],
      },
    ];
    const readbacks = [];
    for (let index = 0; index < combinations.length; index += 1) {
      const combo = combinations[index];
      const requestId = `request-a11-${combo.name.toLowerCase()}`;
      const source = [
        "today_ui",
        "proposal_ui",
        "mcp",
        "scheduler_0900",
        "rolling_scan",
        "content_cycle",
        "orphan_reconcile",
      ][index];
      const pair = acceptAndClose(fixture, {
        requestId,
        source,
        businessDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
      });
      const admitted = admitRoot(fixture, pair.accepted);
      const rootId = String(admitted.root.root_request_id);
      const frozen = freezeSourceForRoot(
        fixture,
        pair.accepted,
        pair.closed,
        rootId,
        {},
      );
      const all = combo.candidatePlanItemIds;
      const scope = fixture.snapshotStore.freezePlanScopeProjection(
        projectionInput(
          fixture,
          fixture.rootStore.readRoot(fixture.workspaceId, rootId),
          frozen.result.value,
          {
            allowedPlanItemIds: all,
            candidatePlanItemIds: combo.candidatePlanItemIds,
            eligiblePlanItemIds: combo.eligiblePlanItemIds ?? [],
            pendingPlanItemIds: combo.pendingPlanItemIds ?? [],
            invalidPlanItemIds: combo.invalidPlanItemIds ?? [],
            trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
            entries: all.map((planItemId) => ({
              planItemId,
              classification: combo.eligiblePlanItemIds?.includes(planItemId)
                ? "eligible"
                : combo.pendingPlanItemIds?.includes(planItemId)
                  ? "pending"
                  : "invalid",
              sourceReceiptIds: [`receipt-${fixture.scenarioId}-official`],
            })),
          },
        ),
      );
      assert.equal(scope.ok, true, JSON.stringify(scope));
      const root = fixture.rootStore.readRoot(fixture.workspaceId, rootId).root;
      if (combo.name === "E") assert.equal(root.status, "waiting_owner");
      else assert.notEqual(root.status, "waiting_owner");
      readbacks.push({ combo: combo.name, scope: scope.value, root });
    }
    assert.equal(readbacks.length, 7);
    assert.ok(readbacks.every(({ scope }) => scope.scopeStatus === "frozen"));
    assert.ok(
      readbacks.every(({ combo, root }) =>
        combo === "E"
          ? root.status === "waiting_owner"
          : root.status !== "waiting_owner",
      ),
    );
    assertAllProvenance(fixture, [
      "daily_plan_scopes",
      "daily_stage_claims",
      "daily_orchestration_roots",
      "source_snapshots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, { proof: { combinations: readbacks }, readbacks });
  }));

// A12

test("WMB-5372 A12 evidence successor hard limit rejects a third successor after a durable gap", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A12");
    const prepared = prepareRootWithSource(fixture, {
      intent: { requestId: "request-a12-gap" },
    });
    const first = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          allowedPlanItemIds: ["item-pending"],
          candidatePlanItemIds: ["item-pending"],
          pendingPlanItemIds: ["item-pending"],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
          entries: [
            {
              planItemId: "item-pending",
              classification: "pending",
              sourceReceiptIds: [`receipt-${fixture.scenarioId}-official`],
            },
          ],
          coverageGap: [
            { code: "CHANNEL_LOGIN_REQUIRED", channelId: "x-list" },
          ],
          evidenceSuccessorOrdinal: 0,
        },
      ),
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.readback.root.status, "running");
    const third = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          allowedPlanItemIds: ["item-pending"],
          candidatePlanItemIds: ["item-pending"],
          pendingPlanItemIds: ["item-pending"],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
          entries: [
            {
              planItemId: "item-pending",
              classification: "pending",
              sourceReceiptIds: [`receipt-${fixture.scenarioId}-official`],
            },
          ],
          evidenceSuccessorOrdinal: 3,
          nowMono: tick(fixture),
        },
      ),
    );
    assert.equal(third.ok, false, JSON.stringify(third));
    assert.equal(third.code, "EVIDENCE_SUCCESSOR_LIMIT");
    assert.equal(
      count(database, "daily_plan_scopes", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    assertAllProvenance(fixture, [
      "daily_plan_scopes",
      "daily_stage_claims",
      "daily_orchestration_roots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { first: first.value, third },
      readbacks: [first.value, third],
    });
  }));

// A13

test("WMB-5372 A13 Reporter resource cap creates at most five active dispatches and a durable sixth wait", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A13");
    const sources = [
      "today_ui",
      "proposal_ui",
      "mcp",
      "scheduler_0900",
      "rolling_scan",
      "content_cycle",
    ];
    const dispatches = [];
    for (let index = 0; index < sources.length; index += 1) {
      const pair = acceptAndClose(fixture, {
        requestId: `request-a13-${index}`,
        source: sources[index],
        businessDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
      });
      const admitted = admitRoot(fixture, pair.accepted);
      const dispatch = reporterDispatch(
        fixture,
        fixture.rootStore.readRoot(
          fixture.workspaceId,
          String(admitted.root.root_request_id),
        ),
      );
      dispatches.push(dispatch);
    }
    const active = count(
      database,
      "managed_job_dispatches",
      "workspace_id=? AND role_id='reporter' AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running') AND (result_status IS NULL OR result_status!='waiting_resource')",
      [fixture.workspaceId],
    );
    assert.ok(active <= 5);
    assert.equal(dispatches.length, 6);
    const sixth = dispatches[5];
    assert.equal(String(sixth.result_status), "waiting_resource");
    const decoded = JSON.parse(String(sixth.result_json));
    assert.equal(decoded.reasonCode, "RESOURCE_REPORTER_CAPACITY");
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { activeReporterCount: active, dispatches },
      readbacks: dispatches,
    });
  }));
// A14

test("WMB-5372 A14 Judge resource cap leaves the second judge waiting without a second active judge", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A14");
    const first = prepareRootWithSource(fixture, {
      intent: {
        requestId: "request-a14-first",
        source: "today_ui",
        businessDate: "2026-08-01",
      },
    });
    const firstScan = first.frozen.bundle.claims[0];
    const firstHandoff = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: first.rootRequestId,
        stageRequestId: String(firstScan.stage_request_id),
        sourceSnapshotHash: first.frozen.result.value.snapshotHash,
        currentChannelFences: first.frozen.input.currentChannelFences,
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(firstHandoff.ok, true, JSON.stringify(firstHandoff));
    const second = prepareRootWithSource(fixture, {
      intent: {
        requestId: "request-a14-second",
        source: "proposal_ui",
        businessDate: "2026-08-02",
      },
    });
    const secondScan = second.frozen.bundle.claims[0];
    const secondHandoff = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: second.rootRequestId,
        stageRequestId: String(secondScan.stage_request_id),
        sourceSnapshotHash: second.frozen.result.value.snapshotHash,
        currentChannelFences: second.frozen.input.currentChannelFences,
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(secondHandoff.ok, true, JSON.stringify(secondHandoff));
    const activeJudges = count(
      database,
      "managed_job_dispatches",
      "workspace_id=? AND role_id='judge' AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running') AND (result_status IS NULL OR result_status!='waiting_resource')",
      [fixture.workspaceId],
    );
    assert.ok(activeJudges <= 1);
    const secondJudge = fixture.rootStore
      .readRoot(fixture.workspaceId, second.rootRequestId)
      .dispatches.find((dispatch) => String(dispatch.role_id) === "judge");
    assert.equal(String(secondJudge.result_status), "waiting_resource");
    assertAllProvenance(fixture, [
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        firstHandoff: firstHandoff.readback,
        secondHandoff: secondHandoff.readback,
        activeJudges,
      },
      readbacks: [firstHandoff.readback, secondHandoff.readback],
    });
  }));

// A15

test("WMB-5372 A15 source snapshot caps 81 supplied sources at exactly 80 with readable exclusion count", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A15");
    const prepared = prepareRootWithSource(fixture, {
      intent: {
        channelPolicy: policyRequiredOnly(),
        authorizedChannelPolicy: policyRequiredOnly(),
      },
      channelResults: [readyChannel("official", "required")],
      source: {
        sourceBindings: Array.from({ length: 81 }, (_, index) => ({
          sourceId: `source-${String(index + 1).padStart(3, "0")}`,
          sourceRevision: 1,
          sourceContentHash: HEX_C,
        })),
        selectedChannelIds: ["official"],
        failedChannels: [],
        unresolvedChannels: [],
        successfulChannels: [
          {
            channelId: "official",
            requiredness: "required",
            receiptId: `receipt-${fixture.scenarioId}-official`,
            receiptRevision: 1,
            receiptPayloadHash: HEX_A,
            resultHash: HEX_B,
          },
        ],
      },
    });
    assert.equal(prepared.frozen.result.value.sourceBindings.length, 80);
    assert.equal(prepared.frozen.result.value.excludedByBudgetCount, 1);
    assert.equal(prepared.frozen.result.value.sourceIds.length, 80);
    assert.equal(new Set(prepared.frozen.result.value.sourceIds).size, 80);
    assertAllProvenance(fixture, [
      "source_snapshots",
      "daily_stage_claims",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        sourceCount: prepared.frozen.result.value.sourceIds.length,
        excludedByBudgetCount:
          prepared.frozen.result.value.excludedByBudgetCount,
      },
      readbacks: [prepared.frozen.result.value],
    });
  }));

// A16

test("WMB-5372 A16 stage deadline settlement is terminal and cannot create a third attempt", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A16", {
      leaseExpiresAtMono: 200_000,
      gateDeadlineMono: 190_000,
      controlStallDeadlineMono: 180_000,
    });
    const prepared = prepareRootWithSource(fixture);
    const claim = prepared.frozen.bundle.claims[0];
    const settled = fixture.rootStore.settleStage(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        stageRequestId: String(claim.stage_request_id),
        expectedClaimRevision: Number(claim.claim_revision),
        expectedRootCheckpointRevision: Number(
          prepared.frozen.bundle.root.checkpoint_revision,
        ),
        status: "partial",
        rootStatus: "partial",
        reasonCode: "ROOT_DEADLINE_EXCEEDED",
        result: { finishedWithinDeadline: true },
        nextAction: { kind: "stop", reasonCode: "ROOT_DEADLINE_EXCEEDED" },
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: 120_000,
      }),
    );
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const before = count(database, "daily_stage_claims", "workspace_id=?", [
      fixture.workspaceId,
    ]);
    const replay = fixture.rootStore.settleStage(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        stageRequestId: String(claim.stage_request_id),
        status: "succeeded",
        result: { shouldNotWin: true },
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: 120_010,
      }),
    );
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "replayed");
    assert.equal(
      count(database, "daily_stage_claims", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      before,
    );
    assert.equal(
      fixture.rootStore.readRoot(fixture.workspaceId, prepared.rootRequestId)
        .root.status,
      "partial",
    );
    assertAllProvenance(fixture, [
      "daily_stage_claims",
      "daily_orchestration_roots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { settled: settled.readback, replay: replay.readback },
      readbacks: [settled.readback, replay.readback],
    });
  }));

// A17

test("WMB-5372 A17 manager failure before accept is receipt-only and after accept preserves the committed boundary", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A17");
    const before = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "request-a17-before",
        producerAttestation: {
          ...attestation(currentActor(fixture).runtimeEpoch),
          registryEntryHash: "wrong-registry",
        },
      }),
    );
    assert.equal(before.ok, false, JSON.stringify(before));
    assert.equal(before.code, "CUTOVER_REQUIRED");
    assert.equal(
      count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    const afterAccepted = fixture.actorStore.acceptIntent(
      intentInput(fixture, { requestId: "request-a17-after" }),
    );
    assert.equal(afterAccepted.ok, true, JSON.stringify(afterAccepted));
    const afterFailed = fixture.rootStore.admitRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        intentId: afterAccepted.intentId,
        requestId: afterAccepted.requestId,
        envelope: { executable: "", argv: [], cwd: "" },
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.ok(
      typeof afterFailed.code === "string" && afterFailed.code.length > 0,
    );
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assertAllProvenance(fixture, ["command_receipts"]);
    finishScenario(fixture, {
      proof: { before, afterAccepted, afterFailed, rootCount: 0 },
      readbacks: [before, afterAccepted, afterFailed],
    });
  }));

// A18

test("WMB-5372 A18 owner and scheduler commands serialize through one Actor while keeping source/root identity separate", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A18");
    const owner = acceptAndClose(fixture, {
      requestId: "request-a18-owner",
      source: "today_ui",
      rootMode: "owner",
      businessDate: "2026-08-31",
    });
    const ownerRoot = admitRoot(fixture, owner.accepted);
    const scheduler = acceptAndClose(fixture, {
      requestId: "request-a18-scheduler",
      source: "scheduler_0900",
      rootMode: "scheduler",
      businessDate: "2026-08-31",
    });
    const schedulerRoot = admitRoot(fixture, scheduler.accepted);
    assert.notEqual(
      String(ownerRoot.root.root_request_id),
      String(schedulerRoot.root.root_request_id),
    );
    assert.notEqual(
      String(ownerRoot.root.orchestration_id),
      String(schedulerRoot.root.orchestration_id),
    );
    assert.equal(String(ownerRoot.root.source), "today_ui");
    assert.equal(String(schedulerRoot.root.source), "scheduler_0900");
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      2,
    );
    assert.equal(
      count(
        database,
        "orchestrator_events",
        "workspace_id=? AND event_type=?",
        [fixture.workspaceId, "root.created"],
      ),
      2,
    );
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { owner: ownerRoot.root, scheduler: schedulerRoot.root },
      readbacks: [ownerRoot.root, schedulerRoot.root],
    });
  }));

// A19

test("WMB-5372 A19 Stage-D no-target skips without projection while explicit targets freeze only supplied triples", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A19");
    const noTarget = prepareRootWithSource(fixture, {
      intent: {
        requestId: "request-a19-empty",
        rootMode: "scheduler",
        source: "scheduler_0900",
      },
    });
    const empty = fixture.snapshotStore.freezeStageDTargetEffect(
      stageDInput(fixture, noTarget.frozen.bundle, {
        targets: [],
        effects: [],
      }),
    );
    assert.equal(empty.ok, true, JSON.stringify(empty));
    assert.equal(empty.value.targetSetHash !== undefined, true);
    assert.equal(
      fixture.rootStore.readRoot(fixture.workspaceId, noTarget.rootRequestId)
        .root.status,
      "succeeded",
    );
    const withTarget = prepareRootWithSource(fixture, {
      intent: {
        requestId: "request-a19-target",
        rootMode: "owner",
        source: "proposal_ui",
      },
    });
    const target = {
      targetId: "target-1",
      targetRevision: 2,
      targetContentHash: HEX_A,
      planItemId: "item-1",
      planItemRevision: 3,
      planItemContentHash: HEX_B,
    };
    const frozen = fixture.snapshotStore.freezeStageDTargetEffect(
      stageDInput(fixture, withTarget.frozen.bundle, {
        targets: [target],
        effects: [],
      }),
    );
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    assert.deepEqual(
      frozen.value.targets.map((entry) => entry.targetId),
      ["target-1"],
    );
    assert.equal(
      fixture.rootStore.readRoot(fixture.workspaceId, withTarget.rootRequestId)
        .root.status,
      "running",
    );
    assertAllProvenance(fixture, [
      "daily_stage_claims",
      "daily_orchestration_roots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { empty: empty.value, targeted: frozen.value },
      readbacks: [empty.value, frozen.value],
    });
  }));

// A20

test("WMB-5372 A20 effect consumption binds source result and replays the same token without a second consumption", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A20");
    const prepared = prepareRootWithSource(fixture, {
      intent: {
        channelPolicy: policyRequiredOnly(),
        authorizedChannelPolicy: policyRequiredOnly(),
      },
      channelResults: [readyChannel("official", "required")],
      source: { selectedChannelIds: ["official"] },
    });
    const dispatch = reporterDispatch(fixture, prepared.frozen.bundle);
    const settledDispatch = settleReporter(fixture, dispatch);
    const stageD = fixture.snapshotStore.freezeStageDTargetEffect(
      stageDInput(fixture, prepared.frozen.bundle, {
        targets: [
          {
            targetId: "target-1",
            targetRevision: 1,
            targetContentHash: HEX_A,
            planItemId: "item-1",
            planItemRevision: 1,
            planItemContentHash: HEX_B,
          },
        ],
        effects: [makeEffect()],
      }),
    );
    assert.equal(stageD.ok, true, JSON.stringify(stageD));
    const effect = stageD.value.effects[0];
    const root = prepared.frozen.bundle.root;
    const stage = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    ).claims[0];
    const reserveInput = acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      rootRequestId: prepared.rootRequestId,
      rootGeneration: Number(root.root_generation),
      rootInputHash: String(root.root_input_hash),
      stageRequestId: String(stage.stage_request_id),
      orchestrationId: String(root.orchestration_id),
      managerTaskId: String(root.manager_task_id),
      operationRequestId: hashV1({
        r: "a20-operation",
        scenario: fixture.scenarioId,
      }),
      operationKind: "effect.consume",
      operationOrdinal: 1,
      effectLogicalKey: String(effect.effectLogicalKey),
      effectSetHash: String(stageD.value.effectSetHash),
      roleId: "writer",
      sinkName: "content-publish",
      sinkRoleId: "writer",
      sinkContractVersion: "1",
      deliveryMode: "exactly_once",
      payloadHash: HEX_C,
      sinkCapabilityProof: { capability: "test-sink" },
      sourceDispatchJobId: String(dispatch.job_id ?? dispatch.jobId),
      sourceResultHash: HEX_B,
      stageClaimRevision: Number(stage.claim_revision),
      fence: fenceFrom(currentActor(fixture)),
      nowUtc: NOW,
      nowMono: tick(fixture),
    });
    const reserved =
      fixture.snapshotStore.reserveEffectConsumption(reserveInput);
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    const replayed = fixture.snapshotStore.reserveEffectConsumption(
      acceptanceInput(fixture.context, {
        ...reserveInput,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(replayed.ok, true, JSON.stringify(replayed));
    assert.equal(replayed.replayed, true);
    assert.equal(
      count(database, "managed_effect_consumptions", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    const settled = fixture.snapshotStore.settleEffectConsumption(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        consumptionId: reserved.value.consumptionId,
        state: "consumed",
        outcome: { externalId: "published-once" },
        payloadHash: HEX_C,
        sinkName: "content-publish",
        sinkRoleId: "writer",
        sinkContractVersion: "1",
        deliveryMode: "exactly_once",
        effectToken: reserved.value.effectToken,
        expectedStageClaimRevision: Number(stage.claim_revision),
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.value.state, "consumed");
    assertAllProvenance(fixture, [
      "managed_job_dispatches",
      "managed_effect_consumptions",
      "daily_stage_claims",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        dispatch: settledDispatch.dispatch,
        stageD: stageD.value,
        reserved: reserved.value,
        replayed: replayed.value,
        settled: settled.value,
      },
      readbacks: [stageD.value, reserved.value, replayed.value, settled.value],
    });
  }));

// A21

test("WMB-5372 A21 authorized cancel cascades to root, claim and dispatch and late replay is zero-write", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A21");
    const prepared = prepareRootWithSource(fixture);
    const cancelled = fixture.rootStore.cancelRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: prepared.rootRequestId,
        reasonCode: "OWNER_CANCELLED",
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const bundle = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    );
    assert.equal(bundle.root.status, "cancelled");
    assert.ok(
      bundle.claims.every((claim) =>
        ["cancelled", "orphaned", "succeeded"].includes(String(claim.status)),
      ),
    );
    assert.ok(
      bundle.dispatches.every((dispatch) =>
        ["cancelled", "orphaned", "terminal"].includes(String(dispatch.state)),
      ),
    );
    const before = {
      roots: count(database, "daily_orchestration_roots"),
      claims: count(database, "daily_stage_claims"),
      jobs: count(database, "managed_job_dispatches"),
      events: count(database, "orchestrator_events"),
    };
    const late = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: prepared.rootRequestId,
        sourceSnapshotHash: prepared.frozen.result.value.snapshotHash,
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(late.ok, false, JSON.stringify(late));
    assert.deepEqual(
      {
        roots: count(database, "daily_orchestration_roots"),
        claims: count(database, "daily_stage_claims"),
        jobs: count(database, "managed_job_dispatches"),
        events: count(database, "orchestrator_events"),
      },
      before,
    );
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { cancelled: cancelled.readback, late },
      readbacks: [cancelled.readback, late],
    });
  }));

// A22

test("WMB-5372 A22 restart rotates runtime epoch and leaves prior terminal rows readable", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A22");
    const prepared = prepareRootWithSource(fixture);
    const firstEpoch = currentActor(fixture).runtimeEpoch;
    const takeover = fixture.actorStore.acquireActor({
      workspaceId: fixture.workspaceId,
      currentBuildId: BUILD_ID,
      leaseToken: "lease-a22-restart",
      runtimeId: "runtime-a22-restart",
      nowUtc: NOW,
      nowMono: 100_001,
      leaseExpiresAtMono: 200_000,
      gateDeadlineMono: 190_000,
      controlStallDeadlineMono: 180_000,
      migrationEpoch: 1,
      writeFence: "allow",
    });
    assert.equal(takeover.ok, true, JSON.stringify(takeover));
    assert.equal(takeover.actor.runtimeEpoch, firstEpoch + 1);
    const gate = fixture.actorStore.completeStartupReconcile({
      workspaceId: fixture.workspaceId,
      fence: takeover.fence,
      nowUtc: NOW,
      nowMono: 100_010,
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
    const oldRoot = fixture.rootStore.readRoot(
      fixture.workspaceId,
      prepared.rootRequestId,
    ).root;
    assert.ok(oldRoot);
    assert.equal(oldRoot.status, "running");
    const oldEventCount = count(
      database,
      "orchestrator_events",
      "workspace_id=?",
      [fixture.workspaceId],
    );
    assert.ok(oldEventCount > 0);
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    assertAllProvenance(fixture, [
      "workspace_orchestrator_actors",
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { firstEpoch, takeover: takeover.actor, gate: gate.gate, oldRoot },
      readbacks: [takeover.actor, gate.gate, oldRoot],
    });
  }));

// A23

test("WMB-5372 A23 wrong parent identity is rejected and the valid parent remains unchanged", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A23");
    const prepared = prepareRootWithSource(fixture);
    const wrong = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          allowedPlanItemIds: [],
          candidatePlanItemIds: [],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
          sourceSnapshotHash: HEX_A,
          entries: [],
          candidateInputCount: 0,
          classifiedCount: 0,
        },
      ),
    );
    assert.equal(wrong.ok, false, JSON.stringify(wrong));
    assert.ok(
      [
        "SOURCE_SNAPSHOT_STALE",
        "WORKSPACE_STALE",
        "ORCHESTRATOR_CONTRACT_ERROR",
      ].includes(wrong.code),
    );
    const source = fixture.snapshotStore.readSourceSnapshot(
      fixture.workspaceId,
      prepared.frozen.result.value.stageRequestId,
    );
    assert.equal(
      source.snapshotHash,
      prepared.frozen.result.value.snapshotHash,
    );
    assert.equal(
      count(database, "daily_plan_scopes", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assertAllProvenance(fixture, [
      "source_snapshots",
      "daily_stage_claims",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { invalidParent: wrong, source },
      readbacks: [wrong, source],
    });
  }));

// A24

test("WMB-5372 A24 Manager and DB read the same projection eligible ID set and hash", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A24");
    const prepared = prepareRootWithSource(fixture);
    const scope = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(
        fixture,
        prepared.frozen.bundle,
        prepared.frozen.result.value,
        {
          allowedPlanItemIds: ["item-a"],
          candidatePlanItemIds: ["item-a"],
          eligiblePlanItemIds: ["item-a"],
          pendingPlanItemIds: [],
          trustedReceiptIds: [`receipt-${fixture.scenarioId}-official`],
          entries: [
            {
              planItemId: "item-a",
              classification: "eligible",
              sourceReceiptIds: [`receipt-${fixture.scenarioId}-official`],
            },
          ],
        },
      ),
    );
    assert.equal(scope.ok, true, JSON.stringify(scope));
    const dbRow = database
      .prepare(
        "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
      )
      .get(fixture.workspaceId, String(scope.value.stageRequestId));
    assert.ok(dbRow);
    const manager = readManagerAdapterProjection(database, {
      workspaceId: fixture.workspaceId,
      rootRequestId: prepared.rootRequestId,
    });
    assert.equal(manager.roots.length, 1, JSON.stringify(manager));
    const managerRoot = manager.roots[0];
    assert.deepEqual(
      JSON.parse(String(dbRow.scope_json)).projection.eligiblePlanItemIds,
      managerRoot.eligiblePlanItemIds,
    );
    assert.equal(
      String(managerRoot.eligibleIdsHash),
      String(
        database
          .prepare(
            "SELECT eligible_ids_hash FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
          )
          .get(fixture.workspaceId, prepared.rootRequestId).eligible_ids_hash,
      ),
    );
    assert.equal(managerRoot.eligiblePlanItemIds.length, 1);
    assertAllProvenance(fixture, [
      "daily_plan_scopes",
      "daily_stage_claims",
      "daily_orchestration_roots",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: { scope: scope.value, manager },
      readbacks: [scope.value, manager],
    });
  }));

// A25

test("WMB-5372 A25 unknown producer and malformed policy are rejected before any root or child write", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A25");
    const unknownProducer = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "request-a25-unknown",
        producerId: "producer.not-registered",
        producerAttestation: {
          ...attestation(currentActor(fixture).runtimeEpoch),
          producerId: "producer.not-registered",
        },
      }),
    );
    assert.equal(unknownProducer.ok, false, JSON.stringify(unknownProducer));
    assert.equal(unknownProducer.code, "CUTOVER_REQUIRED");
    const malformedPolicy = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "request-a25-policy",
        channelPolicy: [
          {
            channelId: "official",
            requiredness: "required",
            module: "official_web",
          },
          {
            channelId: "official",
            requiredness: "required",
            module: "official_web",
          },
        ],
      }),
    );
    assert.equal(malformedPolicy.ok, false, JSON.stringify(malformedPolicy));
    assert.ok(
      ["CHANNEL_POLICY_INVALID", "ORCHESTRATOR_CONTRACT_ERROR"].includes(
        malformedPolicy.code,
      ),
    );
    assert.equal(
      count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assert.equal(
      count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      0,
    );
    assertAllProvenance(fixture, ["command_receipts"]);
    finishScenario(fixture, {
      proof: { unknownProducer, malformedPolicy },
      readbacks: [unknownProducer, malformedPolicy],
    });
  }));

// A26

test("WMB-5372 A26 old runtime epoch mutation is rejected while the new epoch gate remains usable", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A26");
    const oldActor = currentActor(fixture);
    const oldFence = fenceFrom(oldActor);
    const oldAccepted = fixture.actorStore.acceptIntent(
      intentInput(fixture, { requestId: "request-a26-old" }),
    );
    assert.equal(oldAccepted.ok, true, JSON.stringify(oldAccepted));
    const takeover = fixture.actorStore.acquireActor({
      workspaceId: fixture.workspaceId,
      currentBuildId: BUILD_ID,
      leaseToken: "lease-a26-new",
      runtimeId: "runtime-a26-new",
      nowUtc: NOW,
      nowMono: 100_001,
      leaseExpiresAtMono: 200_000,
      gateDeadlineMono: 190_000,
      controlStallDeadlineMono: 180_000,
      migrationEpoch: 1,
      writeFence: "allow",
    });
    assert.equal(takeover.ok, true, JSON.stringify(takeover));
    const oldWrite = fixture.actorStore.closePreflight(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        requestId: oldAccepted.requestId,
        profileRevision: 7,
        channelResults: [
          readyChannel("official", "required"),
          readyChannel("x-list", "optional"),
        ],
        fence: oldFence,
        nowUtc: NOW,
        nowMono: 100_010,
      }),
    );
    assert.equal(oldWrite.ok, false, JSON.stringify(oldWrite));
    assert.ok(
      [
        "EXECUTION_AUTHORIZATION_INVALID",
        "WORKSPACE_STALE",
        "CUTOVER_REQUIRED",
      ].includes(oldWrite.code),
    );
    const gate = fixture.actorStore.completeStartupReconcile({
      workspaceId: fixture.workspaceId,
      fence: takeover.fence,
      nowUtc: NOW,
      nowMono: 100_020,
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
    const newWrite = fixture.actorStore.acceptIntent(
      intentInput(fixture, { requestId: "request-a26-new" }),
    );
    assert.equal(newWrite.ok, true, JSON.stringify(newWrite));
    assert.equal(currentActor(fixture).runtimeEpoch, oldActor.runtimeEpoch + 1);
    assertAllProvenance(fixture, [
      "workspace_orchestrator_actors",
      "orchestrator_intents",
      "command_receipts",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        oldAccepted,
        oldWrite,
        takeover: takeover.actor,
        gate: gate.gate,
        newWrite,
      },
      readbacks: [oldAccepted, oldWrite, takeover.actor, gate.gate, newWrite],
    });
  }));

// A27

test("WMB-5372 A27 terminal old root retry creates a new generation and duplicate retry is replay-only", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A27");
    const first = prepareRootWithSource(fixture, {
      intent: {
        requestId: "request-a27-first",
        source: "today_ui",
        businessDate: "2026-08-31",
      },
    });
    const cancelled = fixture.rootStore.cancelRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId: first.rootRequestId,
        reasonCode: "RETRY_AFTER_FAILURE",
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const retry = acceptAndClose(fixture, {
      requestId: "request-a27-retry",
      source: "today_ui",
      businessDate: "2026-08-31",
    });
    const retryRoot = admitRoot(fixture, retry.accepted, {
      predecessorRootId: first.rootRequestId,
    });
    assert.equal(
      Number(retryRoot.root.root_generation),
      Number(first.admitted.root.root_generation) + 1,
    );
    assert.equal(
      Number(retryRoot.root.retry_invocation_ordinal),
      Number(first.admitted.root.retry_invocation_ordinal) + 1,
    );
    assert.notEqual(
      String(retryRoot.root.root_request_id),
      first.rootRequestId,
    );
    const replay = admitRoot(fixture, retry.accepted);
    assert.equal(replay.status, "replayed");
    assert.equal(
      String(replay.root.root_request_id),
      String(retryRoot.root.root_request_id),
    );
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      2,
    );
    assert.equal(
      fixture.rootStore.readRoot(fixture.workspaceId, first.rootRequestId).root
        .status,
      "cancelled",
    );
    assertAllProvenance(fixture, [
      "daily_orchestration_roots",
      "daily_stage_claims",
      "managed_job_dispatches",
      "orchestrator_events",
    ]);
    finishScenario(fixture, {
      proof: {
        oldRoot: first.admitted.root,
        cancelled: cancelled.readback,
        retry: retryRoot.root,
        replay: replay.readback,
      },
      readbacks: [
        first.admitted.root,
        cancelled.readback,
        retryRoot.root,
        replay.readback,
      ],
    });
  }));

// A28 is intentionally not executed until the installed runtime evidence gate is available.

test("WMB-5372 A28 is explicitly not_executed pending WMB-5374 installation evidence", () =>
  withDatabase((database) => {
    const fixture = beginScenario(database, "A28");
    const finished = finishScenario(fixture, {
      status: "not_executed",
      blocker: "INSTALL_RUNTIME_REQUIRED",
      reason:
        "WMB-5374 must provide package/app.asar/data-root/runtime identity evidence from the installed build.",
      proof: { scenarioId: "A28", notExecuted: true },
      readbacks: [{ blocker: "INSTALL_RUNTIME_REQUIRED" }],
    });
    assert.equal(finished.run.status, "not_executed");
    assert.equal(finished.run.resultHash !== null, true);
    assert.equal(finished.run.evidencePointer.includes("A28"), true);
  }));
