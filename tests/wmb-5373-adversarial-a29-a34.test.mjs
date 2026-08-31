import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/main/db/migrations.ts";
import {
  finishAcceptanceRun,
  readAcceptanceRun,
  startAcceptanceRun,
} from "../src/main/workspace-orchestrator-acceptance.ts";
import {
  WorkspaceOrchestratorActorStore,
  hashV1,
} from "../src/main/workspace-orchestrator-actor.ts";
import { WorkspaceOrchestratorRootStageStore } from "../src/main/workspace-orchestrator-root-stage.ts";
import { createWorkspaceOrchestratorResourceAdmissionStore } from "../src/main/workspace-orchestrator-resource-admission.ts";
import { createWorkspaceOrchestratorSnapshotStore } from "../src/main/workspace-orchestrator-snapshots.ts";
import { createExternalEffectAdapter } from "../src/main/workspace-orchestrator-external-effect.ts";
import { ORCHESTRATOR_CRASH_INJECTED } from "../src/main/workspace-orchestrator-crash-barrier.ts";

const NOW = "2026-08-31T08:00:00.000Z";
const BUILD_ID = "build-wmb-5373";
const MANIFEST_HASH = "d".repeat(64);
const SOURCE_COMMIT = "source-wmb-5373";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

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

function count(database, table, where = "", params = []) {
  return Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM "${table}"${where ? ` WHERE ${where}` : ""}`,
      )
      .get(...params).count,
  );
}

function row(database, sql, params = []) {
  return database.prepare(sql).get(...params);
}

function rows(database, sql, params = []) {
  return database.prepare(sql).all(...params);
}

function seedBuild(database) {
  if (
    count(database, "build_manifests", "manifest_hash=?", [MANIFEST_HASH]) > 0
  )
    return;
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
  ) VALUES (?, 'producer.acceptance', ?, 1, 'tests/wmb-5373-adversarial-a29-a34.test.mjs', 'owner', 'trigger.acceptance',
    'full', 'today_ui', 'actor-mailbox', 'orchestrator_mailbox', 'wmb_acceptance_test',
    'auth-wmb-5373', 'J:/WMB/WeMediaBuddy.exe', 'J:/WMB/resources', ?, 1, ?, ?)`,
    )
    .run(workspaceId, BUILD_ID, "registry-wmb-5373", "census-wmb-5373", NOW);
}

function attestation(runtimeEpoch) {
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
  assert.ok(actor, `missing actor ${fixture.workspaceId}`);
  return actor;
}

function acceptanceInput(context, input) {
  return context.withAcceptance(input);
}

function beginScenario(scenarioId, options = {}) {
  const workspaceId =
    options.workspaceId ??
    `wmb-5373-${scenarioId.toLowerCase()}-${options.suffix ?? "one"}`;
  const requestId =
    options.requestId ??
    `request-${scenarioId.toLowerCase()}-${options.suffix ?? "one"}`;
  seedBuild(options.database);
  const actorStore = new WorkspaceOrchestratorActorStore(options.database, {
    nowUtc: () => NOW,
    nowMono: () => 100,
  });
  const acquired = actorStore.acquireActor({
    workspaceId,
    currentBuildId: BUILD_ID,
    leaseToken: `lease-${scenarioId}-${options.suffix ?? "one"}`,
    runtimeId: `runtime-${scenarioId}-${options.suffix ?? "one"}`,
    nowUtc: NOW,
    nowMono: 100,
    leaseExpiresAtMono: options.leaseExpiresAtMono ?? 100_000,
    gateDeadlineMono: options.gateDeadlineMono ?? 90_000,
    controlStallDeadlineMono: options.controlStallDeadlineMono ?? 80_000,
    migrationEpoch: 1,
    writeFence: "allow",
  });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  seedProducer(options.database, workspaceId, acquired.actor);
  assert.equal(
    actorStore.createStartupReconcileGate({
      workspaceId,
      fence: acquired.fence,
      nowUtc: NOW,
      nowMono: 110,
    }).ok,
    true,
  );
  assert.equal(
    actorStore.completeStartupReconcile({
      workspaceId,
      fence: acquired.fence,
      nowUtc: NOW,
      nowMono: 120,
    }).ok,
    true,
  );
  const started = startAcceptanceRun(
    options.database,
    {
      workspaceId,
      scenarioId,
      acceptanceRunId: `acceptance-run-wmb-5373-${scenarioId}-${options.suffix ?? "one"}`,
      acceptanceNamespace: `acceptance/wmb-5373/${scenarioId}/${options.suffix ?? "one"}`,
      scenarioInput: {
        scenarioId,
        workspaceId,
        requestId,
        suffix: options.suffix ?? "one",
      },
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
  return {
    database: options.database,
    workspaceId,
    requestId,
    scenarioId,
    actorStore,
    rootStore: new WorkspaceOrchestratorRootStageStore(options.database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    }),
    resourceStore: createWorkspaceOrchestratorResourceAdmissionStore(
      options.database,
      { nowUtc: () => NOW, nowMono: () => 200 },
    ),
    snapshotStore: createWorkspaceOrchestratorSnapshotStore(options.database, {
      nowUtc: () => NOW,
      nowMono: () => 200,
    }),
    context: started.context,
    run: started.run,
    nowMono: 210,
  };
}

function fixture(scenarioId, options = {}) {
  let result;
  withDatabase((database) => {
    result = beginScenario(scenarioId, { ...options, database });
    if (typeof options.use === "function") options.use(result);
  });
  return result;
}

function tick(fixture, delta = 10) {
  fixture.nowMono += delta;
  return fixture.nowMono;
}

function policyWithOptional() {
  return [
    { channelId: "official", requiredness: "required", module: "official_web" },
    { channelId: "x-list", requiredness: "optional", module: "x_list" },
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
  const source = overrides.source ?? "today_ui";
  const rootMode = overrides.rootMode ?? "owner";
  const requestId = overrides.requestId ?? fixture.requestId;
  const payload = overrides.payload ?? {
    topic: "AI infrastructure",
    scenarioId: fixture.scenarioId,
    requestId,
  };
  const logicalInput = overrides.logicalInput ?? payload;
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
    logicalInput,
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
function closePreflight(
  fixture,
  accepted,
  channelResults = [
    readyChannel("official"),
    readyChannel("x-list", "optional"),
  ],
  overrides = {},
) {
  const actor = currentActor(fixture);
  const closed = fixture.actorStore.closePreflight(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      intentId: accepted.intentId,
      requestId: accepted.requestId,
      profileRevision: 7,
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
  return {
    accepted,
    closed: closePreflight(fixture, accepted, channelResults),
  };
}

function admitRoot(fixture, accepted, overrides = {}) {
  const actor = currentActor(fixture);
  const result = fixture.rootStore.admitRoot(
    acceptanceInput(fixture.context, {
      workspaceId: fixture.workspaceId,
      intentId: accepted.intentId,
      requestId: accepted.requestId,
      fence: fenceFrom(actor),
      envelope: {
        executable: "node",
        argv: ["orchestrator-worker"],
        cwd: "J:/WMB",
        preflightId: overrides.preflightId ?? null,
        policyHash: overrides.policyHash ?? null,
        scenarioId: fixture.scenarioId,
      },
      nowUtc: NOW,
      nowMono: tick(fixture),
      ...overrides,
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const rawJobId = result.dispatch?.jobId ?? result.dispatch?.job_id;
  const dispatch = rawJobId
    ? fixture.resourceStore.readDispatch({
        workspaceId: fixture.workspaceId,
        jobId: String(rawJobId),
      })
    : null;
  assert.ok(
    dispatch,
    "admitted reporter dispatch must read back through the resource Store",
  );
  return { ...result, dispatch };
}

function dispatchMutationInput(fixture, dispatch, overrides = {}) {
  const actor = currentActor(fixture);
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    jobId: dispatch.jobId,
    parentStageRequestId: dispatch.parentStageRequestId,
    expectedParentClaimRevision: dispatch.expectedParentClaimRevision,
    fence: fenceFrom(actor),
    nowUtc: NOW,
    nowMono: tick(fixture),
    ...overrides,
  });
}

function settleDispatch(
  fixture,
  dispatch,
  result = { ok: true, source: fixture.scenarioId },
) {
  const settled = fixture.resourceStore.settleTerminal(
    dispatchMutationInput(fixture, dispatch, {
      terminalStatus: "succeeded",
      result,
      resultHash: hashV1({ status: "succeeded", result }),
    }),
  );
  assert.equal(settled.ok, true, JSON.stringify(settled));
  return settled;
}

function normalizeRootBundle(fixture, bundle) {
  if (bundle?.claims && bundle?.root) return bundle;
  const rootRequestId =
    bundle?.root?.root_request_id ??
    bundle?.rootRequestId ??
    bundle?.root?.rootRequestId;
  assert.ok(
    rootRequestId,
    "root request id is required to read the root bundle",
  );
  const readback = fixture.rootStore.readRoot(
    fixture.workspaceId,
    String(rootRequestId),
  );
  assert.ok(readback?.root, `missing root bundle ${rootRequestId}`);
  return readback;
}

function sourceInput(fixture, rootBundle, preflight, options = {}) {
  const actualBundle = normalizeRootBundle(fixture, rootBundle);
  const root = actualBundle.root;
  const stage =
    actualBundle.claims.find(
      (claim) => String(claim.attempt_stage) !== "judge",
    ) ?? actualBundle.claims[0];
  const selectedChannelIds =
    options.selectedChannelIds ??
    JSON.parse(String(preflight.selected_channels_json ?? "[]")).map((entry) =>
      String(entry.channelId ?? entry.channel_id ?? entry),
    );
  const successfulChannels =
    options.successfulChannels ??
    selectedChannelIds.map((channelId) => ({
      channelId,
      requiredness: channelId === "official" ? "required" : "optional",
      receiptId: `receipt-${fixture.scenarioId}-${root.root_request_id}-${channelId}`,
      receiptRevision: 1,
      receiptPayloadHash: HEX_A,
      resultHash: HEX_B,
      configRevision: 1,
      authRevision: 1,
      capabilityLeaseId: `cap-${channelId}`,
      capabilityRevision: 1,
      expiresAtMono: 90_000,
    }));
  const sourceBindings = options.sourceBindings ?? [
    {
      sourceId: `source-${fixture.scenarioId}-${root.root_request_id}-1`,
      sourceRevision: 1,
      sourceContentHash: HEX_C,
    },
  ];
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
    successfulChannels,
    failedChannels: options.failedChannels ?? [],
    unresolvedChannels: options.unresolvedChannels ?? [],
    sourceBindings,
    sourceIds: sourceBindings.map((entry) => entry.sourceId),
    receiptIds: successfulChannels.map((entry) => entry.receiptId),
    receiptBindings: successfulChannels.map((entry) => ({
      receiptId: entry.receiptId,
      receiptRevision: entry.receiptRevision,
      receiptPayloadHash: entry.receiptPayloadHash,
    })),
    watermarkUtc: NOW,
    watermarkMono: options.watermarkMono ?? tick(fixture),
    capturedAtUtc: NOW,
    currentChannelFences: successfulChannels.map((entry) => ({
      channelId: entry.channelId,
      profileRevision: Number(preflight.profile_revision),
      policyHash: String(preflight.policy_hash),
      status: "ready",
      ready: true,
      revoked: false,
      authStatus: "ready",
      configStatus: "ready",
      configRevision: 1,
      authRevision: 1,
      capabilityRevision: 1,
      capabilityLeaseId: entry.capabilityLeaseId,
      expiresAtMono: 90_000,
    })),
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: options.nowMono ?? fixture.nowMono,
    ...options.extra,
  });
}

function freezeSource(fixture, rootBundle, closed, options = {}) {
  const actualBundle = normalizeRootBundle(fixture, rootBundle);
  const preflightId = closed?.preflightId ?? closed?.preflight_id;
  const preflight = row(
    fixture.database,
    "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    [fixture.workspaceId, preflightId],
  );
  assert.ok(preflight, `missing preflight ${preflightId}`);
  const input = sourceInput(fixture, actualBundle, preflight, options);
  const result = fixture.snapshotStore.freezeSourceSnapshot(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...result, input };
}

function projectionInput(fixture, rootBundle, source, options = {}) {
  const actualBundle = normalizeRootBundle(fixture, rootBundle);
  const root = actualBundle.root;
  const stage =
    actualBundle.claims.find(
      (claim) => String(claim.attempt_stage) !== "judge",
    ) ?? actualBundle.claims[0];
  const sourceReadback = source.value ?? source;
  const receiptId = String(
    sourceReadback.receiptIds?.[0] ??
      `receipt-${fixture.scenarioId}-${root.root_request_id}-official`,
  );
  const allowed =
    options.allowedPlanItemIds ?? (options.empty ? [] : ["item-1"]);
  const eligible =
    options.eligiblePlanItemIds ?? (options.empty ? [] : ["item-1"]);
  const entries =
    options.entries ??
    (options.empty
      ? []
      : [
          {
            planItemId: "item-1",
            classification: "eligible",
            sourceReceiptIds: [receiptId],
          },
        ]);
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    sourceSnapshotHash: String(sourceReadback.snapshotHash),
    managerTaskId: String(root.manager_task_id),
    orchestrationId: String(root.orchestration_id),
    attemptStage: "full",
    allowedPlanIds: options.allowedPlanIds ?? (options.empty ? [] : ["plan-1"]),
    allowedPlanItemIds: allowed,
    carryPlanItemIds: [],
    trustedReceiptIds:
      options.trustedReceiptIds ??
      (options.empty ? sourceReadback.receiptIds : [receiptId]),
    planIds: options.planIds ?? (options.empty ? [] : ["plan-1"]),
    candidatePlanItemIds: options.candidatePlanItemIds ?? eligible,
    eligiblePlanItemIds: eligible,
    pendingPlanItemIds: options.pendingPlanItemIds ?? [],
    invalidPlanItemIds: options.invalidPlanItemIds ?? [],
    entries,
    candidateInputCount: options.empty ? 0 : 1,
    classifiedCount: options.empty ? 0 : 1,
    ...(options.empty ? { emptyQualified: true } : {}),
    coverageGap: [],
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture),
    ...options.extra,
  });
}

function freezeScope(fixture, rootBundle, source, options = {}) {
  const result = fixture.snapshotStore.freezePlanScopeProjection(
    projectionInput(fixture, rootBundle, source, options),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function setupRoot(fixture, overrides = {}) {
  const { accepted, closed } = acceptAndClose(fixture, {
    requestId: overrides.requestId ?? fixture.requestId,
    payload: overrides.payload,
  });
  const root = admitRoot(fixture, accepted, {
    preflightId: closed.preflightId,
    policyHash: closed.snapshot.policyHash,
  });
  return { accepted, closed, root };
}

function processFor(dispatch, options = {}) {
  return {
    workspaceId: dispatch.workspaceId,
    launchAttemptId: dispatch.launchAttemptId,
    launchTokenHash: dispatch.launchTokenHash,
    processHandle:
      options.processHandle ?? `handle-${dispatch.launchAttemptId}`,
    pid: options.pid ?? 53730,
    processStartTimeUtc: options.processStartTimeUtc ?? NOW,
    processStartTimeMono: options.processStartTimeMono ?? 300,
    argvHash: dispatch.argvHash,
    cwdFingerprint: dispatch.cwdFingerprint,
    sessionKey: options.sessionKey ?? dispatch.sessionKey,
    sessionProof: true,
    startTimeProof: true,
    parentProof: true,
  };
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  return value;
}

function finish(fixture, input) {
  const cleaned = stripUndefined(input);
  const result = finishAcceptanceRun(
    fixture.database,
    {
      acceptanceRunId: fixture.run.acceptanceRunId,
      ...cleaned,
    },
    {
      nowUtc: () => NOW,
      nowMono: () => fixture.nowMono,
      defaultEvidenceRoot: "acceptance-evidence/wmb-5373",
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const persisted = readAcceptanceRun(
    fixture.database,
    fixture.run.acceptanceRunId,
  );
  assert.ok(persisted);
  assert.equal(
    persisted.status,
    cleaned.status ?? (cleaned.passed === true ? "passed" : "failed"),
  );
  assert.equal(persisted.evidencePointer, cleaned.evidencePointer);
  return result;
}

function commonProof(fixture, extra = {}) {
  return {
    finding: extra.finding ?? fixture.context.scenario.description,
    injection: extra.injection ?? [],
    uniqueCondition: extra.uniqueCondition ?? {
      acceptanceRunId: fixture.run.acceptanceRunId,
      workspaceId: fixture.workspaceId,
    },
    durableReadbacks: extra.durableReadbacks ?? [],
    zeroWriteCounts: extra.zeroWriteCounts ?? {},
    ...extra,
  };
}

function createDurableExternalSink(database) {
  database.exec(`CREATE TABLE external_effect_sink_receipts (
    effect_token TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    sink_name TEXT NOT NULL,
    sink_role_id TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    delivery_mode TEXT NOT NULL,
    result_json TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    outcome_query_key TEXT NOT NULL,
    commit_count INTEGER NOT NULL DEFAULT 1
  )`);
  const identityFields = [
    "effect_token",
    "payload_hash",
    "sink_name",
    "sink_role_id",
    "contract_version",
    "delivery_mode",
  ];
  const identityValues = (identity) => [
    identity.effectToken,
    identity.payloadHash,
    identity.sinkName,
    identity.sinkRoleId,
    identity.contractVersion,
    identity.deliveryMode,
  ];
  const conflict = () =>
    Object.assign(new Error("external sink identity conflict"), {
      code: "EXTERNAL_EFFECT_IDENTITY_MISMATCH",
    });
  const assertIdentity = (stored, identity) => {
    const values = identityValues(identity);
    for (let index = 0; index < identityFields.length; index += 1) {
      if (String(stored[identityFields[index]]) !== String(values[index]))
        throw conflict();
    }
  };
  const readReceipt = (identity) =>
    row(
      database,
      "SELECT * FROM external_effect_sink_receipts WHERE effect_token=?",
      [identity.effectToken],
    );
  return {
    sinkName: "acceptance-sink",
    sinkRoleId: "publisher",
    contractVersion: "1",
    deliveryMode: "exactly_once",
    commit(request) {
      const identity = request.identity;
      const existing = readReceipt(identity);
      if (existing) {
        assertIdentity(existing, identity);
        return {
          ...identity,
          result: JSON.parse(String(existing.result_json)),
          resultHash: String(existing.result_hash),
          outcomeQueryKey: String(existing.outcome_query_key),
        };
      }
      const result = {
        committed: true,
        effectToken: identity.effectToken,
        payloadHash: identity.payloadHash,
      };
      const resultHash = hashV1(result);
      const outcomeQueryKey = `sink-query-${identity.effectToken}`;
      database
        .prepare(
          `INSERT INTO external_effect_sink_receipts (
        effect_token, payload_hash, sink_name, sink_role_id, contract_version, delivery_mode,
        result_json, result_hash, outcome_query_key, commit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          identity.effectToken,
          identity.payloadHash,
          identity.sinkName,
          identity.sinkRoleId,
          identity.contractVersion,
          identity.deliveryMode,
          JSON.stringify(result),
          resultHash,
          outcomeQueryKey,
        );
      return { ...identity, result, resultHash, outcomeQueryKey };
    },
    query(request) {
      const identity = request.identity;
      const existing = readReceipt(identity);
      if (!existing) {
        return {
          ...identity,
          status: "not_committed",
          outcomeQueryKey:
            request.outcomeQueryKey ?? `sink-query-${identity.effectToken}`,
        };
      }
      assertIdentity(existing, identity);
      return {
        ...identity,
        status: "committed",
        result: JSON.parse(String(existing.result_json)),
        resultHash: String(existing.result_hash),
        outcomeQueryKey: String(existing.outcome_query_key),
      };
    },
  };
}

// A29 — request/replay identity is separate from logical invocation identity and repaired bindings form a stable hash DAG.
test("WMB-5373 A29 logical invocation/replay and repaired binding hash DAG", () =>
  withDatabase((database) => {
    const fixture = beginScenario("A29", {
      database,
      suffix: "logical-replay",
    });
    const evidencePointer = `acceptance-evidence/wmb-5373/A29/${fixture.run.acceptanceRunId}`;
    const first = acceptAndClose(fixture, {
      requestId: "request-a29-a",
      payload: { topic: "same logical input", revision: 1 },
    });
    const second = acceptAndClose(fixture, {
      requestId: "request-a29-b",
      payload: { topic: "same logical input", revision: 1 },
    });
    assert.notEqual(first.accepted.intentId, second.accepted.intentId);
    assert.notEqual(first.accepted.invocationId, second.accepted.invocationId);
    assert.equal(
      first.accepted.logicalInputHash,
      second.accepted.logicalInputHash,
    );

    const intentCountBeforeConflict = count(
      database,
      "orchestrator_intents",
      "workspace_id=?",
      [fixture.workspaceId],
    );
    const receiptCountBeforeConflict = count(
      database,
      "command_receipts",
      "workspace_id=?",
      [fixture.workspaceId],
    );
    const replayConflict = fixture.actorStore.acceptIntent(
      intentInput(fixture, {
        requestId: "request-a29-a",
        payload: { topic: "same logical input", revision: 2 },
        logicalInput: { topic: "same logical input", revision: 2 },
      }),
    );
    assert.equal(replayConflict.ok, false);
    assert.equal(replayConflict.code, "REQUEST_REPLAY_CONFLICT");
    assert.equal(
      count(database, "orchestrator_intents", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      intentCountBeforeConflict,
    );
    assert.equal(
      count(database, "command_receipts", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      receiptCountBeforeConflict,
    );

    const rootA = admitRoot(fixture, first.accepted, {
      preflightId: first.closed.preflightId,
      policyHash: first.closed.snapshot.policyHash,
    });
    const dispatchA = rootA.dispatch;
    settleDispatch(fixture, dispatchA, { root: "a29-a" });
    const sourceA = freezeSource(fixture, rootA, first.closed);
    const scopeA = freezeScope(fixture, rootA, sourceA, { empty: true });
    const scopeRowA = row(
      database,
      "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
      [fixture.workspaceId, scopeA.value.stageRequestId],
    );
    assert.ok(scopeRowA);

    const rootB = admitRoot(fixture, second.accepted, {
      preflightId: second.closed.preflightId,
      policyHash: second.closed.snapshot.policyHash,
    });
    const dispatchB = rootB.dispatch;
    settleDispatch(fixture, dispatchB, { root: "a29-b" });
    const sourceB = freezeSource(fixture, rootB, second.closed);
    const repairInput = {
      predecessorScopeId: String(scopeA.value.scopeId),
      predecessorScopeHash: String(scopeA.value.scopeHash),
      repairOrdinal: 1,
      items: [
        {
          planItemId: "item-1",
          priorItemRevision: 1,
          priorItemContentHash: HEX_A,
          repairedItemRevision: 2,
          repairedItemContentHash: HEX_B,
          receiptId: String((sourceB.value ?? sourceB).receiptIds[0]),
          receiptRevision: 1,
          receiptPayloadHash: HEX_C,
          childOrdinal: 1,
        },
      ],
    };
    const scopeB = freezeScope(fixture, rootB, sourceB, {
      allowedPlanIds: ["plan-1"],
      allowedPlanItemIds: ["item-1"],
      trustedReceiptIds: [(sourceB.value ?? sourceB).receiptIds[0]],
      repair: repairInput,
      extra: { repair: repairInput },
    });
    const scopeBReplay = fixture.snapshotStore.freezePlanScopeProjection(
      projectionInput(fixture, rootB, sourceB, {
        allowedPlanIds: ["plan-1"],
        allowedPlanItemIds: ["item-1"],
        trustedReceiptIds: [(sourceB.value ?? sourceB).receiptIds[0]],
        extra: { repair: repairInput },
      }),
    );
    assert.equal(scopeBReplay.ok, true, JSON.stringify(scopeBReplay));
    assert.equal(scopeBReplay.replayed, true);
    assert.equal(
      scopeB.value.repairSnapshotId,
      scopeBReplay.value.repairSnapshotId,
    );
    assert.equal(
      scopeB.value.repairSnapshotHash,
      scopeBReplay.value.repairSnapshotHash,
    );
    assert.equal(scopeB.value.bindingHash, scopeBReplay.value.bindingHash);

    const projection = JSON.parse(
      String(
        row(
          database,
          "SELECT scope_json FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
          [fixture.workspaceId, scopeB.value.stageRequestId],
        ).scope_json,
      ),
    ).projection;
    const expectedProjectionHash = hashV1({
      r: "projection/v2",
      workspaceId: projection.workspaceId,
      businessDate: projection.businessDate,
      managerTaskId: projection.managerTaskId,
      orchestrationId: projection.orchestrationId,
      stageRequestId: projection.stageRequestId,
      scopeHash: projection.scopeHash,
      bindingHash: projection.bindingHash,
      repairSnapshotHash: projection.repairSnapshotHash,
      planIds: projection.planIds,
      asOf: projection.asOf,
      orderedEntries: projection.entries,
      candidatePlanItemIds: projection.candidatePlanItemIds,
      eligiblePlanItemIds: projection.eligiblePlanItemIds,
      pendingPlanItemIds: projection.pendingPlanItemIds,
      invalidPlanItemIds: projection.invalidPlanItemIds,
      trustedReceiptIds: projection.trustedReceiptIds,
      emptyQualified: projection.emptyQualified,
    });
    assert.equal(projection.projectionHash, expectedProjectionHash);
    const repairRow = row(
      database,
      "SELECT * FROM daily_repair_snapshot_bindings WHERE workspace_id=? AND binding_hash=?",
      [fixture.workspaceId, scopeB.value.bindingHash],
    );
    assert.ok(repairRow);
    const childHashes = JSON.parse(String(repairRow.child_hashes_json));
    assert.ok(childHashes.length >= 1);
    for (const childHash of childHashes) {
      assert.ok(
        row(
          database,
          "SELECT 1 FROM identity_hash_registry WHERE workspace_id=? AND registry_name=? AND derived_value=?",
          [fixture.workspaceId, "repair-binding-child/v1", childHash],
        ),
      );
    }
    const proof = commonProof(fixture, {
      injection: [
        "two requestIds with identical logical input",
        "same requestId replay with changed payload",
        "second root repaired from frozen predecessor scope",
      ],
      uniqueCondition: {
        requestIds: ["request-a29-a", "request-a29-b"],
        invocationIds: [
          first.accepted.invocationId,
          second.accepted.invocationId,
        ],
        conflictCode: replayConflict.code,
        repairSnapshotId: scopeB.value.repairSnapshotId,
        bindingHash: scopeB.value.bindingHash,
      },
      durableReadbacks: [
        first.accepted,
        second.accepted,
        replayConflict,
        scopeA.value,
        scopeB.value,
        repairRow,
        projection,
      ],
      zeroWriteCounts: {
        intentsBeforeConflict: intentCountBeforeConflict,
        intentsAfterConflict: count(
          database,
          "orchestrator_intents",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        receiptsBeforeConflict: receiptCountBeforeConflict,
        receiptsAfterConflict: count(
          database,
          "command_receipts",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
      },
    });
    finish(fixture, {
      status: "passed",
      passed: true,
      proof,
      readbacks: [
        first.accepted,
        second.accepted,
        replayConflict,
        scopeB.value,
        projection,
      ],
      evidencePointer,
    });
  }));

// A30 — each launch boundary is exercised against matching and mismatching process inventory.
test("WMB-5373 A30 spawn crash boundaries adopt-or-kill exactly one process", () =>
  withDatabase((database) => {
    const boundaries = [
      "reserved",
      "task_bound",
      "spawn_uncertain",
      "spawn_started",
      "register",
      "stdout_drain",
    ];
    const observations = [];
    for (const boundary of boundaries) {
      for (const inventoryKind of ["matching", "mismatching"]) {
        const fixture = beginScenario("A30", {
          database,
          suffix: `${boundary}-${inventoryKind}`,
        });
        const evidencePointer = `acceptance-evidence/wmb-5373/A30/${fixture.run.acceptanceRunId}`;
        const setup = setupRoot(fixture);
        const dispatch = setup.root.dispatch;
        const process = processFor(dispatch, {
          pid: 53000 + observations.length,
        });
        if (boundary === "task_bound") {
          const bound = fixture.resourceStore.bindTaskIdentity(
            dispatchMutationInput(fixture, dispatch, {
              taskId: `task-${boundary}`,
            }),
          );
          assert.equal(bound.ok, true, JSON.stringify(bound));
        } else if (boundary === "spawn_uncertain") {
          const uncertain = fixture.resourceStore.markSpawnUncertain(
            dispatchMutationInput(fixture, dispatch, process),
          );
          assert.equal(uncertain.ok, true, JSON.stringify(uncertain));
        } else if (
          ["spawn_started", "register", "stdout_drain"].includes(boundary)
        ) {
          const started = fixture.resourceStore.markSpawnStarted(
            dispatchMutationInput(fixture, dispatch, process),
          );
          assert.equal(started.ok, true, JSON.stringify(started));
        }
        const before = count(
          database,
          "managed_job_dispatches",
          "workspace_id=?",
          [fixture.workspaceId],
        );
        let recovery;
        if (inventoryKind === "matching") {
          recovery = fixture.resourceStore.adoptOrKill(
            dispatchMutationInput(fixture, dispatch, {
              inventory: [process],
              inventoryKnown: true,
            }),
          );
          assert.equal(recovery.ok, true, JSON.stringify(recovery));
          assert.equal(recovery.action, "adopt");
          assert.equal(
            recovery.dispatch.launchAttemptId,
            dispatch.launchAttemptId,
          );
          assert.equal(recovery.dispatch.pid, process.pid);
        } else {
          const mismatching = {
            ...process,
            pid: process.pid + 1,
            sessionKey: `${process.sessionKey}-wrong`,
          };
          recovery = fixture.resourceStore.adoptOrKill(
            dispatchMutationInput(fixture, dispatch, {
              inventory: [mismatching],
              inventoryKnown: true,
            }),
          );
          assert.equal(recovery.ok, true, JSON.stringify(recovery));
          assert.equal(recovery.action, "kill_drain");
          assert.equal(recovery.status, "spawn_uncertain");
          const orphaned = fixture.resourceStore.adoptOrKill(
            dispatchMutationInput(fixture, dispatch, {
              inventory: [],
              inventoryKnown: true,
              spawnConfirmed: false,
              terminationConfirmed: true,
              drainConfirmed: true,
              confirmedNoProcess: true,
              sessionClosed: true,
              cwdCleaned: true,
            }),
          );
          assert.equal(orphaned.ok, true, JSON.stringify(orphaned));
          assert.equal(orphaned.action, "orphaned");
          assert.equal(orphaned.dispatch.state, "orphaned");
          recovery = orphaned;
        }
        assert.equal(
          count(database, "managed_job_dispatches", "workspace_id=?", [
            fixture.workspaceId,
          ]),
          before,
        );
        const persisted = row(
          database,
          "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND job_id=?",
          [fixture.workspaceId, dispatch.jobId],
        );
        assert.ok(persisted);
        observations.push({ boundary, inventoryKind, recovery, persisted });
        const proof = commonProof(fixture, {
          injection: [
            `crash at ${boundary}`,
            `${inventoryKind} PID/session inventory`,
          ],
          uniqueCondition: {
            boundary,
            inventoryKind,
            launchAttemptId: dispatch.launchAttemptId,
            jobId: dispatch.jobId,
          },
          durableReadbacks: [recovery, persisted],
          zeroWriteCounts: {
            dispatchesBeforeRecovery: before,
            dispatchesAfterRecovery: count(
              database,
              "managed_job_dispatches",
              "workspace_id=?",
              [fixture.workspaceId],
            ),
            duplicateSpawnCount: 0,
          },
        });
        finish(fixture, {
          status: "passed",
          passed: true,
          proof,
          readbacks: [recovery, persisted],
          evidencePointer,
        });
      }
    }
    assert.equal(observations.length, boundaries.length * 2);
  }));

// A31 — durable external sink commit/query is reconciled exactly once, alongside the existing delivery-mode semantics.
test("WMB-5373 A31 effect delivery modes and external exactly-once sink reconciliation", () =>
  withDatabase((database) => {
    const fixture = beginScenario("A31", { database, suffix: "effect-modes" });
    const evidencePointer = `acceptance-evidence/wmb-5373/A31/${fixture.run.acceptanceRunId}`;
    const sinkDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "wmb-5373-a31-sink-"),
    );
    const sinkDatabase = new DatabaseSync(path.join(sinkDirectory, "sink.db"));
    try {
      const sink = createDurableExternalSink(sinkDatabase);
      const adapter = createExternalEffectAdapter(database, sink);
      const setup = setupRoot(fixture);
      const dispatch = setup.root.dispatch;
      const settled = settleDispatch(fixture, dispatch, {
        source: "a31-source",
      });
      const source = freezeSource(fixture, setup.root, setup.closed);
      const stage =
        normalizeRootBundle(fixture, setup.root).claims.find(
          (claim) => String(claim.attempt_stage) !== "judge",
        ) ?? normalizeRootBundle(fixture, setup.root).claims[0];
      const effects = ["exactly_once", "at_most_once", "at_least_once"].map(
        (deliveryMode) => ({
          roleId: "publisher",
          action: "publish",
          effectLogicalKey: `effect-${deliveryMode}`,
          effectAttemptOrdinal: 1,
          sinkName: "acceptance-sink",
          sinkRoleId: "publisher",
          sinkContractVersion: "1",
          deliveryMode,
        }),
      );
      const frozen = fixture.snapshotStore.freezeStageDTargetEffect(
        acceptanceInput(fixture.context, {
          workspaceId: fixture.workspaceId,
          rootRequestId: String(setup.root.root.root_request_id),
          rootGeneration: Number(setup.root.root.root_generation),
          rootInputHash: String(setup.root.root.root_input_hash),
          stageRequestId: String(stage.stage_request_id),
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
          effects,
          fence: fenceFrom(currentActor(fixture)),
          nowUtc: NOW,
          nowMono: tick(fixture),
        }),
      );
      assert.equal(frozen.ok, true, JSON.stringify(frozen));
      const sourceResultHash = String(settled.dispatch.resultHash);
      const modeReadbacks = [];
      for (const mode of effects.map((entry) => entry.deliveryMode)) {
        const spec = frozen.value.effects.find(
          (entry) => entry.deliveryMode === mode,
        );
        assert.ok(spec);
        const payload = { mode, payload: "immutable-effect-payload" };
        const payloadHash = hashV1(payload);
        const currentRoot = row(
          database,
          "SELECT root_request_id, root_generation, root_input_hash, orchestration_id, manager_task_id FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
          [fixture.workspaceId, setup.root.root.root_request_id],
        );
        assert.ok(currentRoot);
        const reservationInput = acceptanceInput(fixture.context, {
          workspaceId: fixture.workspaceId,
          rootRequestId: String(currentRoot.root_request_id),
          rootGeneration: Number(currentRoot.root_generation),
          rootInputHash: String(currentRoot.root_input_hash),
          stageRequestId: String(stage.stage_request_id),
          orchestrationId: String(currentRoot.orchestration_id),
          managerTaskId: String(currentRoot.manager_task_id),
          operationRequestId: `operation-${mode}`,
          operationKind: "effect.consume",
          operationOrdinal: 1,
          effectRequestId: String(spec.effectRequestId),
          effectLogicalKey: String(spec.effectLogicalKey),
          effectSetHash: String(frozen.value.effectSetHash),
          roleId: String(spec.roleId),
          sinkName: String(spec.sinkName),
          sinkRoleId: String(spec.sinkRoleId),
          sinkContractVersion: String(spec.sinkContractVersion),
          deliveryMode: mode,
          payloadHash,
          sinkCapabilityProofHash: HEX_C,
          sourceDispatchJobId: dispatch.jobId,
          sourceResultHash,
          fence: fenceFrom(currentActor(fixture)),
          nowUtc: NOW,
          nowMono: tick(fixture),
        });
        const reserved = adapter.reserveEffectConsumption(reservationInput);
        assert.equal(reserved.ok, true, JSON.stringify(reserved));
        if (mode === "exactly_once") {
          const externalInput = {
            workspaceId: fixture.workspaceId,
            consumptionId: reserved.value.consumptionId,
            sinkName: String(spec.sinkName),
            sinkRoleId: String(spec.sinkRoleId),
            contractVersion: String(spec.sinkContractVersion),
            deliveryMode: mode,
            effectToken: reserved.value.effectToken,
            payloadHash,
            payload,
          };
          const committed = adapter.commitReservedEffect(externalInput);
          assert.equal(committed.ok, true, JSON.stringify(committed));
          assert.equal(committed.value.effectToken, reserved.value.effectToken);
          assert.equal(committed.value.payloadHash, payloadHash);
          assert.ok(committed.value.resultHash);
          assert.ok(committed.value.outcomeQueryKey);
          assert.equal(
            adapter.readEffectConsumption({
              workspaceId: fixture.workspaceId,
              consumptionId: reserved.value.consumptionId,
            }).state,
            "reserved",
          );
          const duplicateCommit = adapter.commitReservedEffect(externalInput);
          assert.equal(
            duplicateCommit.ok,
            true,
            JSON.stringify(duplicateCommit),
          );
          assert.deepEqual(duplicateCommit.value, committed.value);
          const adapterPayloadConflict = adapter.commitReservedEffect({
            ...externalInput,
            payloadHash: `${payloadHash}-drift`,
          });
          assert.equal(adapterPayloadConflict.ok, false);
          assert.equal(
            adapterPayloadConflict.code,
            "EXTERNAL_EFFECT_IDENTITY_MISMATCH",
          );
          const adapterSinkConflict = adapter.commitReservedEffect({
            ...externalInput,
            sinkName: "acceptance-sink-drift",
          });
          assert.equal(adapterSinkConflict.ok, false);
          assert.equal(
            adapterSinkConflict.code,
            "EXTERNAL_EFFECT_IDENTITY_MISMATCH",
          );
          assert.throws(
            () =>
              sink.commit({
                consumptionId: reserved.value.consumptionId,
                effectRequestId: reserved.value.effectRequestId,
                identity: {
                  ...externalInput,
                  payloadHash: `${payloadHash}-drift`,
                },
              }),
            (error) => error.code === "EXTERNAL_EFFECT_IDENTITY_MISMATCH",
          );
          assert.throws(
            () =>
              sink.commit({
                consumptionId: reserved.value.consumptionId,
                effectRequestId: reserved.value.effectRequestId,
                identity: {
                  ...externalInput,
                  sinkName: "acceptance-sink-drift",
                },
              }),
            (error) => error.code === "EXTERNAL_EFFECT_IDENTITY_MISMATCH",
          );
          const restartedAdapter = createExternalEffectAdapter(database, sink);
          const reconciled = restartedAdapter.reconcileEffectConsumption({
            ...externalInput,
            outcomeQueryKey: committed.value.outcomeQueryKey,
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          });
          assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
          assert.equal(
            reconciled.value.consumptionId,
            reserved.value.consumptionId,
          );
          assert.equal(reconciled.value.state, "consumed");
          assert.equal(
            reconciled.value.outcomeHash,
            committed.value.resultHash,
          );
          const consumptionCountAfterReconcile = count(
            database,
            "managed_effect_consumptions",
            "workspace_id=?",
            [fixture.workspaceId],
          );
          const replayedReconcile = restartedAdapter.reconcileEffectConsumption(
            {
              ...externalInput,
              fence: fenceFrom(currentActor(fixture)),
              nowUtc: NOW,
              nowMono: tick(fixture),
            },
          );
          assert.equal(
            replayedReconcile.ok,
            true,
            JSON.stringify(replayedReconcile),
          );
          assert.equal(replayedReconcile.replayed, true);
          assert.equal(
            count(database, "managed_effect_consumptions", "workspace_id=?", [
              fixture.workspaceId,
            ]),
            consumptionCountAfterReconcile,
          );
          const readback = restartedAdapter.readEffectConsumption({
            workspaceId: fixture.workspaceId,
            consumptionId: reserved.value.consumptionId,
          });
          assert.equal(readback.state, "consumed");
          const sinkReceipt = row(
            sinkDatabase,
            "SELECT * FROM external_effect_sink_receipts WHERE effect_token=?",
            [reserved.value.effectToken],
          );
          assert.ok(sinkReceipt);
          assert.equal(Number(sinkReceipt.commit_count), 1);
          modeReadbacks.push({
            mode,
            reserved,
            committed,
            duplicateCommit,
            adapterPayloadConflict,
            adapterSinkConflict,
            reconciled,
            replayedReconcile,
            readback,
            sinkReceipt,
          });
          continue;
        }
        const unknown = fixture.snapshotStore.settleEffectConsumption(
          acceptanceInput(fixture.context, {
            workspaceId: fixture.workspaceId,
            consumptionId: reserved.value.consumptionId,
            state: "unknown",
            outcomeQueryKey: `query-${mode}`,
            payloadHash,
            sinkName: String(spec.sinkName),
            sinkRoleId: String(spec.sinkRoleId),
            sinkContractVersion: String(spec.sinkContractVersion),
            deliveryMode: mode,
            effectToken: reserved.value.effectToken,
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          }),
        );
        assert.equal(unknown.ok, true, JSON.stringify(unknown));
        const terminal = fixture.snapshotStore.settleEffectConsumption(
          acceptanceInput(fixture.context, {
            workspaceId: fixture.workspaceId,
            consumptionId: reserved.value.consumptionId,
            state: mode === "at_most_once" ? "failed" : "consumed",
            outcome: { mode, committed: mode !== "at_most_once" },
            outcomeHash: hashV1({ mode, committed: mode !== "at_most_once" }),
            outcomeQueryKey: `query-${mode}`,
            error:
              mode === "at_most_once"
                ? { unknownOutcome: true, compensation: "required" }
                : undefined,
            payloadHash,
            sinkName: String(spec.sinkName),
            sinkRoleId: String(spec.sinkRoleId),
            sinkContractVersion: String(spec.sinkContractVersion),
            deliveryMode: mode,
            effectToken: reserved.value.effectToken,
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          }),
        );
        assert.equal(terminal.ok, true, JSON.stringify(terminal));
        const beforeConflict = count(
          database,
          "managed_effect_consumptions",
          "workspace_id=?",
          [fixture.workspaceId],
        );
        const conflict = fixture.snapshotStore.reserveEffectConsumption(
          acceptanceInput(fixture.context, {
            workspaceId: fixture.workspaceId,
            rootRequestId: String(setup.root.root.root_request_id),
            rootGeneration: Number(setup.root.root.root_generation),
            rootInputHash: String(setup.root.root.root_input_hash),
            stageRequestId: String(stage.stage_request_id),
            orchestrationId: String(setup.root.root.orchestration_id),
            managerTaskId: String(setup.root.root.manager_task_id),
            operationRequestId: `operation-${mode}`,
            operationKind: "effect.consume",
            operationOrdinal: 1,
            effectRequestId: String(spec.effectRequestId),
            effectLogicalKey: String(spec.effectLogicalKey),
            effectSetHash: String(frozen.value.effectSetHash),
            roleId: String(spec.roleId),
            sinkName: `${spec.sinkName}-drift`,
            sinkRoleId: String(spec.sinkRoleId),
            sinkContractVersion: String(spec.sinkContractVersion),
            deliveryMode: mode,
            payloadHash: `${payloadHash}-drift`,
            sinkCapabilityProofHash: HEX_C,
            sourceDispatchJobId: dispatch.jobId,
            sourceResultHash,
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          }),
        );
        assert.equal(conflict.ok, false);
        assert.equal(conflict.code, "EFFECT_REUSE_MISMATCH");
        assert.equal(
          count(database, "managed_effect_consumptions", "workspace_id=?", [
            fixture.workspaceId,
          ]),
          beforeConflict,
        );
        modeReadbacks.push({ mode, reserved, unknown, terminal, conflict });
      }
      const exact = modeReadbacks.find(
        (entry) => entry.mode === "exactly_once",
      );
      const proof = commonProof(fixture, {
        injection: [
          "durable sink commit before local settlement",
          "adapter restart and committed outcome query",
          "same token/payload replay and sink/payload identity drift",
        ],
        uniqueCondition: {
          deliveryModes: effects.map((entry) => entry.deliveryMode),
          effectSetHash: frozen.value.effectSetHash,
          sourceResultHash,
          exactEffectToken: exact.committed.value.effectToken,
          exactOutcomeQueryKey: exact.committed.value.outcomeQueryKey,
        },
        durableReadbacks: [frozen, modeReadbacks],
        zeroWriteCounts: {
          effectRowsAfterReconcile: count(
            database,
            "managed_effect_consumptions",
            "workspace_id=?",
            [fixture.workspaceId],
          ),
          sinkCommitCount: Number(exact.sinkReceipt.commit_count),
          sinkRows: count(sinkDatabase, "external_effect_sink_receipts"),
        },
      });
      finish(fixture, {
        status: "passed",
        passed: true,
        proof,
        readbacks: [frozen, modeReadbacks],
        evidencePointer,
      });
    } finally {
      sinkDatabase.close();
      fs.rmSync(sinkDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 25,
      });
    }
  }));

const A32_PHASES = Object.freeze([
  "identity_registry",
  "business_rows",
  "checkpoint_index",
  "event_outbox",
]);
const A32_TABLES = Object.freeze([
  "workspace_orchestrator_actors",
  "identity_hash_registry",
  "orchestrator_intents",
  "orchestrator_mailbox",
  "command_receipts",
  "channel_preflight_snapshots",
  "daily_orchestration_roots",
  "daily_stage_claims",
  "managed_job_dispatches",
  "workspace_active_root_index",
  "source_snapshots",
  "daily_repair_snapshot_bindings",
  "daily_plan_scopes",
  "managed_effect_consumptions",
  "orchestrator_events",
  "orchestrator_outbox",
]);

function a32SnapshotValue(value) {
  if (value instanceof Uint8Array)
    return `blob:${Buffer.from(value).toString("base64")}`;
  if (
    value &&
    typeof value === "object" &&
    value.type === "Buffer" &&
    Array.isArray(value.data)
  )
    return `blob:${Buffer.from(value.data).toString("base64")}`;
  return value;
}

function a32Snapshot(database, workspaceId) {
  return Object.fromEntries(
    A32_TABLES.map((table) => [
      table,
      rows(database, `SELECT * FROM "${table}" WHERE workspace_id=?`, [
        workspaceId,
      ])
        .map((item) =>
          Object.fromEntries(
            Object.entries(item).map(([key, value]) => [
              key,
              a32SnapshotValue(value),
            ]),
          ),
        )
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
    ]),
  );
}

function a32Counts(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([table, tableRows]) => [
      table,
      tableRows.length,
    ]),
  );
}

function a32Stores(fixture, crashBarrier) {
  const options = {
    nowUtc: () => NOW,
    nowMono: () => fixture.nowMono,
    ...(crashBarrier ? { crashBarrier } : {}),
  };
  return {
    actorStore: new WorkspaceOrchestratorActorStore(fixture.database, options),
    rootStore: new WorkspaceOrchestratorRootStageStore(
      fixture.database,
      options,
    ),
    snapshotStore: createWorkspaceOrchestratorSnapshotStore(
      fixture.database,
      options,
    ),
    resourceStore: createWorkspaceOrchestratorResourceAdmissionStore(
      fixture.database,
      { nowUtc: () => NOW, nowMono: () => fixture.nowMono },
    ),
  };
}

function a32ResultSummary(result) {
  const summary = {
    ok: result?.ok === true,
    status: result?.status ?? null,
    code: result?.code ?? null,
    replayed: result?.replayed === true,
  };
  for (const key of [
    "intentId",
    "preflightId",
    "rootRequestId",
    "stageRequestId",
    "operationRequestId",
    "effectRequestId",
    "consumptionId",
    "effectToken",
  ]) {
    if (result?.[key] !== undefined) summary[key] = result[key];
    else if (result?.value?.[key] !== undefined)
      summary[key] = result.value[key];
  }
  return summary;
}

function a32RunAttempt(
  database,
  bundle,
  phase,
  operation,
  prepare,
  invoke,
  verifyReplay,
  suffix,
) {
  const fixture = beginScenario("A32", {
    database,
    suffix: `matrix-${suffix}`,
  });
  const prepared = prepare(fixture);
  const before = a32Snapshot(database, fixture.workspaceId);
  const barrier = (context) =>
    context.bundle === bundle && context.phase === phase;
  const failed = invoke(a32Stores(fixture, barrier), prepared);
  assert.equal(
    failed.ok,
    false,
    `${bundle}/${phase} must fail at injected barrier: ${JSON.stringify(failed)}`,
  );
  assert.equal(
    failed.code,
    ORCHESTRATOR_CRASH_INJECTED,
    `${bundle}/${phase} must use stable crash code: ${JSON.stringify(failed)}`,
  );
  const afterCrash = a32Snapshot(database, fixture.workspaceId);
  assert.deepEqual(
    afterCrash,
    before,
    `${bundle}/${phase} left a partial bundle after rollback`,
  );
  const replay = invoke(a32Stores(fixture), prepared);
  assert.equal(
    replay.ok,
    true,
    `${bundle}/${phase} restart replay must commit: ${JSON.stringify(replay)}`,
  );
  verifyReplay(fixture, prepared, replay);
  const afterReplay = a32Snapshot(database, fixture.workspaceId);
  const beforeCounts = a32Counts(before);
  const afterCrashCounts = a32Counts(afterCrash);
  const afterReplayCounts = a32Counts(afterReplay);
  return {
    fixture,
    evidence: {
      bundle,
      phase,
      operation,
      failed: a32ResultSummary(failed),
      restarted: a32ResultSummary(replay),
      unchangedAfterCrash: true,
      beforeCounts,
      afterCrashCounts,
      afterReplayCounts,
      partialBundleCountAfterCrash: 0,
      completeBundleAfterRestart: true,
    },
  };
}

function a32CloseInput(fixture, accepted) {
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    intentId: accepted.intentId,
    requestId: accepted.requestId,
    profileRevision: 7,
    channelResults: [
      readyChannel("official"),
      readyChannel("x-list", "optional"),
    ],
    nowUtc: NOW,
    nowMono: tick(fixture),
    fence: fenceFrom(currentActor(fixture)),
  });
}

function a32AdmitInput(fixture, accepted, closed) {
  const actor = currentActor(fixture);
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    intentId: accepted.intentId,
    requestId: accepted.requestId,
    fence: fenceFrom(actor),
    envelope: {
      executable: "node",
      argv: ["orchestrator-worker"],
      cwd: "J:/WMB",
      preflightId: closed.preflightId,
      policyHash: closed.snapshot.policyHash,
      scenarioId: fixture.scenarioId,
    },
    nowUtc: NOW,
    nowMono: tick(fixture),
  });
}

function a32StageDInput(fixture, rootBundle) {
  const root = rootBundle.root;
  const stage =
    rootBundle.claims.find(
      (claim) => String(claim.attempt_stage) !== "judge",
    ) ?? rootBundle.claims[0];
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    targets: [
      {
        targetId: "target-a32",
        targetRevision: 1,
        targetContentHash: HEX_A,
        planItemId: "item-1",
        planItemRevision: 1,
        planItemContentHash: HEX_B,
      },
    ],
    effects: [
      {
        roleId: "publisher",
        action: "publish",
        effectLogicalKey: "effect-a32",
        effectAttemptOrdinal: 1,
        sinkName: "acceptance-sink",
        sinkRoleId: "publisher",
        sinkContractVersion: "1",
        deliveryMode: "at_least_once",
      },
    ],
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture),
  });
}

function a32EffectInput(fixture, rootBundle, dispatch, stageD) {
  const root = rootBundle.root;
  const stage =
    rootBundle.claims.find(
      (claim) =>
        String(claim.stage_request_id) === String(stageD.stageRequestId),
    ) ?? rootBundle.claims[0];
  const spec = stageD.effects[0];
  return acceptanceInput(fixture.context, {
    workspaceId: fixture.workspaceId,
    rootRequestId: String(root.root_request_id),
    rootGeneration: Number(root.root_generation),
    rootInputHash: String(root.root_input_hash),
    stageRequestId: String(stage.stage_request_id),
    operationRequestId: `operation-a32-${fixture.requestId}`,
    operationKind: "effect.consume",
    operationOrdinal: 1,
    effectRequestId: String(spec.effectRequestId),
    effectLogicalKey: String(spec.effectLogicalKey),
    effectSetHash: String(stageD.effectSetHash),
    roleId: String(spec.roleId),
    sinkName: String(spec.sinkName),
    sinkRoleId: String(spec.sinkRoleId),
    sinkContractVersion: String(spec.sinkContractVersion),
    deliveryMode: String(spec.deliveryMode),
    payloadHash: HEX_C,
    sinkCapabilityProofHash: HEX_A,
    sourceDispatchJobId: String(dispatch.jobId),
    sourceResultHash: String(dispatch.resultHash),
    fence: fenceFrom(currentActor(fixture)),
    nowUtc: NOW,
    nowMono: tick(fixture),
  });
}

// A32 — every exposed T1–T8 transaction boundary is injected, rolled back, restarted, and replayed.
test("WMB-5373 A32 T1-T8 bundle replay and crash barrier atomicity", () =>
  withDatabase((database) => {
    const outcomes = [];
    let reportFixture;
    const run = (
      bundle,
      phase,
      operation,
      prepare,
      invoke,
      verifyReplay,
      suffix,
    ) => {
      const attempt = a32RunAttempt(
        database,
        bundle,
        phase,
        operation,
        prepare,
        invoke,
        verifyReplay,
        suffix,
      );
      if (!reportFixture) reportFixture = attempt.fixture;
      outcomes.push(attempt.evidence);
    };

    for (const phase of A32_PHASES) {
      run(
        "T1",
        phase,
        "intent_accept",
        (fixture) => ({ input: intentInput(fixture) }),
        (stores, prepared) => stores.actorStore.acceptIntent(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.intentId, "string"),
        `t1-${phase}`,
      );

      if (phase !== "checkpoint_index") {
        run(
          "T2",
          phase,
          "preflight_close",
          (fixture) => {
            const accepted = fixture.actorStore.acceptIntent(
              intentInput(fixture),
            );
            assert.equal(accepted.ok, true, JSON.stringify(accepted));
            return { input: a32CloseInput(fixture, accepted) };
          },
          (stores, prepared) =>
            stores.actorStore.closePreflight(prepared.input),
          (_fixture, _prepared, replay) =>
            assert.equal(typeof replay.preflightId, "string"),
          `t2-${phase}`,
        );
      }

      run(
        "T3",
        phase,
        "root_admission",
        (fixture) => {
          const { accepted, closed } = acceptAndClose(fixture);
          return { input: a32AdmitInput(fixture, accepted, closed) };
        },
        (stores, prepared) => stores.rootStore.admitRoot(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.root?.root_request_id, "string"),
        `t3-${phase}`,
      );

      run(
        "T4",
        phase,
        "source_freeze",
        (fixture) => {
          const setup = setupRoot(fixture);
          const settled = settleDispatch(fixture, setup.root.dispatch, {
            source: "a32-t4",
          });
          const preflight = row(
            fixture.database,
            "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
            [fixture.workspaceId, setup.closed.preflightId],
          );
          assert.ok(preflight);
          return {
            input: sourceInput(fixture, setup.root, preflight),
            settled,
          };
        },
        (stores, prepared) =>
          stores.snapshotStore.freezeSourceSnapshot(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.value?.snapshotHash, "string"),
        `t4-${phase}`,
      );

      run(
        "T5",
        phase,
        "f_to_j_handoff",
        (fixture) => {
          const setup = setupRoot(fixture);
          const settled = settleDispatch(fixture, setup.root.dispatch, {
            source: "a32-t5",
          });
          const source = freezeSource(fixture, setup.root, setup.closed);
          const bundle = normalizeRootBundle(fixture, setup.root);
          const root = bundle.root;
          const stage =
            bundle.claims.find(
              (claim) => String(claim.attempt_stage) !== "judge",
            ) ?? bundle.claims[0];
          const input = acceptanceInput(fixture.context, {
            workspaceId: fixture.workspaceId,
            rootRequestId: String(root.root_request_id),
            stageRequestId: String(stage.stage_request_id),
            expectedRootCheckpointRevision: Number(root.checkpoint_revision),
            expectedClaimRevision: Number(stage.claim_revision),
            sourceSnapshotHash: String(source.value.snapshotHash),
            currentChannelFences: source.input.currentChannelFences,
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          });
          return { input, settled };
        },
        (stores, prepared) => stores.rootStore.handoffToJudge(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.root?.root_request_id, "string"),
        `t5-${phase}`,
      );

      run(
        "T6",
        phase,
        "scope_freeze",
        (fixture) => {
          const setup = setupRoot(fixture);
          settleDispatch(fixture, setup.root.dispatch, {
            source: "a32-t6-scope",
          });
          const source = freezeSource(fixture, setup.root, setup.closed);
          return {
            input: projectionInput(fixture, setup.root, source, {
              empty: false,
            }),
          };
        },
        (stores, prepared) =>
          stores.snapshotStore.freezePlanScopeProjection(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.value?.scopeHash, "string"),
        `t6-scope-${phase}`,
      );

      run(
        "T6",
        phase,
        "stage_d_target_effect_freeze",
        (fixture) => {
          const setup = setupRoot(fixture);
          settleDispatch(fixture, setup.root.dispatch, {
            source: "a32-t6-stage-d",
          });
          freezeSource(fixture, setup.root, setup.closed);
          const bundle = normalizeRootBundle(fixture, setup.root);
          return { input: a32StageDInput(fixture, bundle) };
        },
        (stores, prepared) =>
          stores.snapshotStore.freezeStageDTargetEffect(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.value?.effectSetHash, "string"),
        `t6-stage-d-${phase}`,
      );
    }

    for (const phase of A32_PHASES.filter(
      (value) => value !== "checkpoint_index",
    )) {
      run(
        "T7",
        phase,
        "effect_reserve",
        (fixture) => {
          const setup = setupRoot(fixture);
          const settled = settleDispatch(fixture, setup.root.dispatch, {
            source: "a32-t7-reserve",
          });
          const source = freezeSource(fixture, setup.root, setup.closed);
          const bundle = normalizeRootBundle(fixture, setup.root);
          const stageD = fixture.snapshotStore.freezeStageDTargetEffect(
            a32StageDInput(fixture, bundle),
          );
          assert.equal(stageD.ok, true, JSON.stringify(stageD));
          return {
            input: a32EffectInput(
              fixture,
              normalizeRootBundle(fixture, setup.root),
              settled.dispatch,
              stageD.value,
            ),
          };
        },
        (stores, prepared) =>
          stores.snapshotStore.reserveEffectConsumption(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(typeof replay.value?.consumptionId, "string"),
        `t7-reserve-${phase}`,
      );

      run(
        "T7",
        phase,
        "effect_settle",
        (fixture) => {
          const setup = setupRoot(fixture);
          const settled = settleDispatch(fixture, setup.root.dispatch, {
            source: "a32-t7-settle",
          });
          freezeSource(fixture, setup.root, setup.closed);
          const bundleBeforeStageD = normalizeRootBundle(fixture, setup.root);
          const stageD = fixture.snapshotStore.freezeStageDTargetEffect(
            a32StageDInput(fixture, bundleBeforeStageD),
          );
          assert.equal(stageD.ok, true, JSON.stringify(stageD));
          const effectInput = a32EffectInput(
            fixture,
            normalizeRootBundle(fixture, setup.root),
            settled.dispatch,
            stageD.value,
          );
          const reserved =
            fixture.snapshotStore.reserveEffectConsumption(effectInput);
          assert.equal(reserved.ok, true, JSON.stringify(reserved));
          const rootBundle = normalizeRootBundle(fixture, setup.root);
          const stage =
            rootBundle.claims.find(
              (claim) =>
                String(claim.stage_request_id) ===
                String(effectInput.stageRequestId),
            ) ?? rootBundle.claims[0];
          const settleInput = acceptanceInput(fixture.context, {
            workspaceId: fixture.workspaceId,
            consumptionId: String(reserved.value.consumptionId),
            state: "consumed",
            outcome: { source: "a32", committed: true },
            outcomeHash: hashV1({ source: "a32", committed: true }),
            outcomeQueryKey: "a32-settle-query",
            payloadHash: HEX_C,
            sinkName: String(effectInput.sinkName),
            sinkRoleId: String(effectInput.sinkRoleId),
            sinkContractVersion: String(effectInput.sinkContractVersion),
            deliveryMode: String(effectInput.deliveryMode),
            effectToken: String(reserved.value.effectToken),
            expectedStageClaimRevision: Number(stage.claim_revision),
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          });
          return { input: settleInput };
        },
        (stores, prepared) =>
          stores.snapshotStore.settleEffectConsumption(prepared.input),
        (_fixture, _prepared, replay) =>
          assert.equal(replay.value?.state, "consumed"),
        `t7-settle-${phase}`,
      );
    }

    for (const phase of A32_PHASES) {
      run(
        "T8",
        phase,
        "cancel_root",
        (fixture) => {
          const setup = setupRoot(fixture);
          const bundle = normalizeRootBundle(fixture, setup.root);
          const input = acceptanceInput(fixture.context, {
            workspaceId: fixture.workspaceId,
            rootRequestId: String(bundle.root.root_request_id),
            expectedRootCheckpointRevision: Number(
              bundle.root.checkpoint_revision,
            ),
            reasonCode: "A32_CRASH_CANCEL",
            fence: fenceFrom(currentActor(fixture)),
            nowUtc: NOW,
            nowMono: tick(fixture),
          });
          return { input };
        },
        (stores, prepared) => stores.rootStore.cancelRoot(prepared.input),
        (fixture, _prepared, replay) => {
          const bundle = normalizeRootBundle(fixture, replay);
          assert.equal(bundle.root.status, "cancelled");
          assert.equal(bundle.index?.is_active, 0);
        },
        `t8-${phase}`,
      );
    }

    assert.equal(outcomes.length, 37);
    assert.deepEqual(
      new Set(outcomes.map((entry) => entry.bundle)),
      new Set(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]),
    );
    const evidencePointer = `acceptance-evidence/wmb-5373/A32/${reportFixture.run.acceptanceRunId}`;
    const proof = commonProof(reportFixture, {
      injection: outcomes.map(
        (entry) => `${entry.bundle}/${entry.phase}/${entry.operation}`,
      ),
      uniqueCondition: {
        stableCrashCode: ORCHESTRATOR_CRASH_INJECTED,
        attemptedBoundaries: outcomes.length,
        bundles: [...new Set(outcomes.map((entry) => entry.bundle))],
      },
      durableReadbacks: outcomes,
      zeroWriteCounts: {
        partialBundleCountAfterCrash: outcomes.filter(
          (entry) => entry.partialBundleCountAfterCrash !== 0,
        ).length,
        rollbackNoWriteCount: outcomes.filter(
          (entry) => entry.unchangedAfterCrash !== true,
        ).length,
        completeBundleAfterRestartCount: outcomes.filter(
          (entry) => entry.completeBundleAfterRestart !== true,
        ).length,
      },
    });
    finish(reportFixture, {
      status: "passed",
      passed: true,
      proof,
      readbacks: outcomes,
      evidencePointer,
    });
  }));

// A33 — a stall-deadline takeover races the old owner and leaves the new gate pending.
test("WMB-5373 A33 stall takeover has one authority winner", () =>
  withDatabase((database) => {
    const fixture = beginScenario("A33", { database, suffix: "stall-race" });
    const evidencePointer = `acceptance-evidence/wmb-5373/A33/${fixture.run.acceptanceRunId}`;
    const setup = setupRoot(fixture);
    const oldActor = currentActor(fixture);
    const oldFence = fenceFrom(oldActor);
    const oldRootCount = count(
      database,
      "daily_orchestration_roots",
      "workspace_id=?",
      [fixture.workspaceId],
    );
    const takeoverStore = new WorkspaceOrchestratorActorStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 80_000,
    });
    const takeover = takeoverStore.acquireActor({
      workspaceId: fixture.workspaceId,
      currentBuildId: BUILD_ID,
      leaseToken: "lease-A33-r2",
      runtimeId: "runtime-A33-r2",
      nowUtc: NOW,
      nowMono: 80_000,
      leaseExpiresAtMono: 180_000,
      gateDeadlineMono: 170_000,
      controlStallDeadlineMono: 160_000,
      migrationEpoch: 1,
      writeFence: "allow",
      ...fixture.context.withAcceptance({}),
    });
    assert.equal(takeover.ok, true, JSON.stringify(takeover));
    assert.equal(takeover.status, "taken_over");
    assert.equal(takeover.actor.runtimeEpoch, oldActor.runtimeEpoch + 1);
    assert.notEqual(takeover.actor.leaseToken, oldActor.leaseToken);
    const staleMutation = fixture.rootStore.admitRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        intentId: setup.accepted.intentId,
        requestId: setup.accepted.requestId,
        fence: oldFence,
        envelope: {
          executable: "node",
          argv: ["late-old-runtime"],
          cwd: "J:/WMB",
        },
        nowUtc: NOW,
        nowMono: 80_010,
      }),
    );
    assert.equal(staleMutation.ok, false);
    assert.equal(staleMutation.code, "EXECUTION_AUTHORIZATION_INVALID");
    const gates = rows(
      database,
      "SELECT * FROM daily_reconcile_gates WHERE workspace_id=? ORDER BY runtime_epoch",
      [fixture.workspaceId],
    );
    assert.equal(gates.length, 2);
    assert.equal(gates[0].status, "complete");
    assert.equal(gates[1].status, "pending");
    assert.equal(
      count(database, "daily_orchestration_roots", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      oldRootCount,
    );
    assert.equal(
      count(database, "managed_job_dispatches", "workspace_id=?", [
        fixture.workspaceId,
      ]),
      1,
    );
    const proof = commonProof(fixture, {
      injection: [
        "R1 heartbeat continues through control-stall deadline",
        "R2 takeover at exactly stall deadline",
        "old R1 mutation after takeover",
      ],
      uniqueCondition: {
        oldRuntimeEpoch: oldActor.runtimeEpoch,
        winnerRuntimeEpoch: takeover.actor.runtimeEpoch,
        winnerLeaseToken: takeover.actor.leaseToken,
        staleCode: staleMutation.code,
      },
      durableReadbacks: [takeover.actor, takeover.gate, gates, staleMutation],
      zeroWriteCounts: {
        rootsBeforeStaleMutation: oldRootCount,
        rootsAfterStaleMutation: count(
          database,
          "daily_orchestration_roots",
          "workspace_id=?",
          [fixture.workspaceId],
        ),
        children: count(database, "managed_job_dispatches", "workspace_id=?", [
          fixture.workspaceId,
        ]),
      },
    });
    finish(fixture, {
      status: "passed",
      passed: true,
      proof,
      readbacks: [takeover.actor, gates, staleMutation],
      evidencePointer,
    });
  }));

function a34InsertScopeRows(
  database,
  fixture,
  rootRequestId,
  sourceSnapshotHash,
  reporterStage,
  judgeStage,
) {
  const root = row(
    database,
    "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    [fixture.workspaceId, rootRequestId],
  );
  assert.ok(root);
  const acceptance = [
    root.acceptance_run_id,
    root.baseline_event_sequence,
    root.baseline_checkpoint_revision,
    root.created_after_event_sequence,
    root.created_after_checkpoint_revision,
    root.created_after_mono,
  ];
  const insert = (stage, scopeStatus) => {
    const stageRequestId = String(stage.stage_request_id);
    const scopeHash = hashV1({
      r: "a34-plan-scope/v1",
      workspaceId: fixture.workspaceId,
      rootRequestId,
      stageRequestId,
      scopeStatus,
    });
    const scopeId = hashV1({
      r: "a34-plan-scope-id/v1",
      workspaceId: fixture.workspaceId,
      stageRequestId,
      scopeHash,
    });
    const scopeJson = JSON.stringify({
      scope: {
        version: "PlanScopeV1",
        workspaceId: fixture.workspaceId,
        rootRequestId,
        stageRequestId,
        scopeHash,
      },
      projection: {},
    });
    database
      .prepare(
        `INSERT INTO daily_plan_scopes (
      scope_id,workspace_id,stage_request_id,root_request_id,root_generation,root_input_hash,manager_task_id,orchestration_id,
      attempt_stage,claim_revision,owner_epoch,lease_token,lease_expires_at_utc,lease_expires_at_mono,source_snapshot_hash,
      binding_kind,repair_snapshot_id,repair_snapshot_hash,binding_hash,allowed_plan_ids_json,allowed_plan_item_ids_json,
      carry_plan_item_ids_json,trusted_receipt_ids_json,scope_status,scope_json,scope_hash,acceptance_run_id,baseline_event_sequence,
      baseline_checkpoint_revision,created_after_event_sequence,created_after_checkpoint_revision,created_after_mono,created_at,updated_at,frozen_at,finished_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scopeId,
        fixture.workspaceId,
        stageRequestId,
        rootRequestId,
        Number(root.root_generation),
        String(root.root_input_hash),
        String(root.manager_task_id),
        String(root.orchestration_id),
        String(stage.attempt_stage),
        Number(stage.claim_revision),
        Number(stage.owner_epoch),
        String(stage.lease_token),
        String(root.lease_expires_at_utc),
        Number(root.lease_expires_at_mono),
        sourceSnapshotHash,
        "initial_source",
        null,
        null,
        null,
        "[]",
        "[]",
        "[]",
        "[]",
        scopeStatus,
        scopeJson,
        scopeHash,
        ...acceptance,
        NOW,
        NOW,
        scopeStatus === "frozen" ? NOW : null,
        scopeStatus === "frozen" ? NOW : null,
      );
    return row(
      database,
      "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
      [fixture.workspaceId, stageRequestId],
    );
  };
  return {
    frozen: insert(reporterStage, "frozen"),
    building: insert(judgeStage, "building"),
  };
}

function a34LifecycleSnapshot(database, fixture, rootRequestId) {
  const root = row(
    database,
    "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    [fixture.workspaceId, rootRequestId],
  );
  const intentId =
    root?.intent_id === null || root?.intent_id === undefined
      ? null
      : String(root.intent_id);
  const snapshotRows = (query, params) =>
    rows(database, query, params).map((item) =>
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => [
          key,
          a32SnapshotValue(value),
        ]),
      ),
    );
  return {
    root: root
      ? Object.fromEntries(
          Object.entries(root).map(([key, value]) => [
            key,
            a32SnapshotValue(value),
          ]),
        )
      : null,
    intent: intentId
      ? snapshotRows(
          "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
          [fixture.workspaceId, intentId],
        )
      : [],
    claims: snapshotRows(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? ORDER BY rowid",
      [fixture.workspaceId, rootRequestId],
    ),
    dispatches: snapshotRows(
      "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND root_request_id=? ORDER BY child_ordinal, rowid",
      [fixture.workspaceId, rootRequestId],
    ),
    consumptions: snapshotRows(
      "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND root_request_id=? ORDER BY consumption_id",
      [fixture.workspaceId, rootRequestId],
    ),
    scopes: snapshotRows(
      "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND root_request_id=? ORDER BY stage_request_id",
      [fixture.workspaceId, rootRequestId],
    ),
    mailbox: intentId
      ? snapshotRows(
          "SELECT * FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=? ORDER BY mailbox_sequence",
          [fixture.workspaceId, intentId],
        )
      : [],
    index: snapshotRows(
      "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
      [fixture.workspaceId, rootRequestId],
    ),
    cancellationRegistry: snapshotRows(
      "SELECT * FROM identity_hash_registry WHERE workspace_id=? AND registry_name='cancellation-settlement/v1' ORDER BY derived_value",
      [fixture.workspaceId],
    ),
    events: snapshotRows(
      "SELECT * FROM orchestrator_events WHERE workspace_id=? ORDER BY event_sequence",
      [fixture.workspaceId],
    ),
    outbox: snapshotRows(
      "SELECT * FROM orchestrator_outbox WHERE workspace_id=? ORDER BY event_sequence",
      [fixture.workspaceId],
    ),
  };
}

// A34 — terminal first writer, cancel/drain cascade, and old-fence late mutation are executable.
test("WMB-5373 A34 terminal first-writer and old epoch late result", () =>
  withDatabase((database) => {
    const fixture = beginScenario("A34", {
      database,
      suffix: "terminal-first-writer",
    });
    const evidencePointer = `acceptance-evidence/wmb-5373/A34/${fixture.run.acceptanceRunId}`;
    const setup = setupRoot(fixture);
    const rootRequestId = String(setup.root.root.root_request_id);
    const reporterDispatch = setup.root.dispatch;
    const winner = settleDispatch(fixture, reporterDispatch, {
      winner: "source",
    });
    const beforeSource = normalizeRootBundle(fixture, setup.root);
    const reporterStage =
      beforeSource.claims.find(
        (claim) => String(claim.attempt_stage) !== "judge",
      ) ?? beforeSource.claims[0];
    const source = freezeSource(fixture, beforeSource, setup.closed);
    const stageD = fixture.snapshotStore.freezeStageDTargetEffect(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId,
        rootGeneration: Number(beforeSource.root.root_generation),
        rootInputHash: String(beforeSource.root.root_input_hash),
        stageRequestId: String(reporterStage.stage_request_id),
        targets: [
          {
            targetId: "target-a34",
            targetRevision: 1,
            targetContentHash: HEX_A,
            planItemId: "item-a34",
            planItemRevision: 1,
            planItemContentHash: HEX_B,
          },
        ],
        effects: [
          {
            roleId: "publisher",
            action: "publish",
            effectLogicalKey: "effect-a34",
            effectAttemptOrdinal: 1,
            sinkName: "acceptance-sink",
            sinkRoleId: "publisher",
            sinkContractVersion: "1",
            deliveryMode: "at_least_once",
          },
        ],
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(stageD.ok, true, JSON.stringify(stageD));
    const effectSpec = stageD.value.effects[0];
    const currentRoot = row(
      database,
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
      [fixture.workspaceId, rootRequestId],
    );
    const currentReporterStage = row(
      database,
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
      [fixture.workspaceId, String(reporterStage.stage_request_id)],
    );
    const reserved = fixture.snapshotStore.reserveEffectConsumption(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId,
        rootGeneration: Number(currentRoot.root_generation),
        rootInputHash: String(currentRoot.root_input_hash),
        stageRequestId: String(reporterStage.stage_request_id),
        orchestrationId: String(currentRoot.orchestration_id),
        managerTaskId: String(currentRoot.manager_task_id),
        operationRequestId: `operation-a34-${fixture.requestId}`,
        operationKind: "effect.consume",
        operationOrdinal: 1,
        effectRequestId: String(effectSpec.effectRequestId),
        effectLogicalKey: String(effectSpec.effectLogicalKey),
        effectSetHash: String(stageD.value.effectSetHash),
        roleId: String(effectSpec.roleId),
        sinkName: String(effectSpec.sinkName),
        sinkRoleId: String(effectSpec.sinkRoleId),
        sinkContractVersion: String(effectSpec.sinkContractVersion),
        deliveryMode: String(effectSpec.deliveryMode),
        payloadHash: HEX_C,
        sinkCapabilityProofHash: HEX_A,
        sourceDispatchJobId: String(reporterDispatch.jobId),
        sourceResultHash: String(winner.dispatch.resultHash),
        expectedStageClaimRevision: Number(currentReporterStage.claim_revision),
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    const handoffRoot = fixture.rootStore.readRoot(
      fixture.workspaceId,
      rootRequestId,
    );
    const handoffStage = row(
      database,
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
      [fixture.workspaceId, String(reporterStage.stage_request_id)],
    );
    const handoff = fixture.rootStore.handoffToJudge(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId,
        stageRequestId: String(reporterStage.stage_request_id),
        expectedRootCheckpointRevision: Number(
          handoffRoot.root.checkpoint_revision,
        ),
        expectedClaimRevision: Number(handoffStage.claim_revision),
        sourceSnapshotHash: String(source.value.snapshotHash),
        currentChannelFences: source.input.currentChannelFences,
        envelope: { executable: "node", argv: ["judge-worker"], cwd: "J:/WMB" },
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: tick(fixture),
      }),
    );
    assert.equal(handoff.ok, true, JSON.stringify(handoff));
    const judgeStage = handoff.judge;
    const judgeDispatch = handoff.dispatch;
    assert.ok(judgeStage?.stage_request_id);
    assert.ok(judgeDispatch?.jobId);
    const scopes = a34InsertScopeRows(
      database,
      fixture,
      rootRequestId,
      String(source.value.snapshotHash),
      reporterStage,
      judgeStage,
    );
    const frozenScopeBefore = scopes.frozen;
    const oldFence = fenceFrom(currentActor(fixture));
    const cancelRoot = row(
      database,
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
      [fixture.workspaceId, rootRequestId],
    );
    const cancelMono = tick(fixture);
    const cancelled = fixture.rootStore.cancelRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId,
        expectedRootCheckpointRevision: Number(cancelRoot.checkpoint_revision),
        reasonCode: "A34_CANCEL_CASCADE",
        fence: oldFence,
        nowUtc: NOW,
        nowMono: cancelMono,
      }),
    );
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.status, "cancelled");
    const cancelledSnapshot = a34LifecycleSnapshot(
      database,
      fixture,
      rootRequestId,
    );
    const cancelledRoot = cancelledSnapshot.root;
    const cancelledClaim = cancelledSnapshot.claims.find(
      (claim) =>
        String(claim.stage_request_id) === String(judgeStage.stage_request_id),
    );
    const cancelledDispatch = cancelledSnapshot.dispatches.find(
      (dispatch) => String(dispatch.job_id) === String(judgeDispatch.jobId),
    );
    const cancelledConsumption = cancelledSnapshot.consumptions.find(
      (consumption) =>
        String(consumption.consumption_id) ===
        String(reserved.value.consumptionId),
    );
    const cancelledBuildingScope = cancelledSnapshot.scopes.find(
      (scope) =>
        String(scope.stage_request_id) === String(judgeStage.stage_request_id),
    );
    const cancelledFrozenScope = cancelledSnapshot.scopes.find(
      (scope) =>
        String(scope.stage_request_id) ===
        String(reporterStage.stage_request_id),
    );
    assert.equal(cancelledRoot.status, "cancelled");
    assert.equal(String(cancelledRoot.lease_expires_at_utc), NOW);
    assert.equal(Number(cancelledRoot.lease_expires_at_mono), cancelMono);
    assert.equal(
      count(
        database,
        "daily_stage_claims",
        "workspace_id=? AND root_request_id=? AND is_active=1",
        [fixture.workspaceId, rootRequestId],
      ),
      0,
    );
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')",
        [fixture.workspaceId, rootRequestId],
      ),
      0,
    );
    assert.equal(
      count(
        database,
        "managed_effect_consumptions",
        "workspace_id=? AND root_request_id=? AND state IN ('reserved','consuming','unknown')",
        [fixture.workspaceId, rootRequestId],
      ),
      0,
    );
    assert.equal(
      count(
        database,
        "daily_plan_scopes",
        "workspace_id=? AND root_request_id=? AND scope_status='building'",
        [fixture.workspaceId, rootRequestId],
      ),
      0,
    );
    assert.equal(cancelledClaim.status, "cancelled");
    assert.equal(
      Number(cancelledClaim.claim_revision),
      Number(judgeStage.claim_revision) + 1,
    );
    assert.equal(String(cancelledClaim.lease_expires_at_utc), NOW);
    assert.equal(Number(cancelledClaim.lease_expires_at_mono), cancelMono);
    assert.equal(cancelledDispatch.state, "cancelled");
    assert.equal(cancelledDispatch.result_status, "cancelled");
    assert.equal(
      String(cancelledDispatch.result_hash),
      hashV1({
        status: "cancelled",
        result: {
          status: "cancelled",
          reasonCode: "A34_CANCEL_CASCADE",
          terminalReason: "A34_CANCEL_CASCADE",
        },
      }),
    );
    assert.equal(String(cancelledDispatch.lease_expires_at_utc), NOW);
    assert.equal(Number(cancelledDispatch.lease_expires_at_mono), cancelMono);
    assert.equal(cancelledConsumption.state, "cancelled");
    assert.equal(
      Number(cancelledConsumption.consumption_revision),
      Number(reserved.value.consumptionRevision) + 1,
    );
    assert.equal(String(cancelledConsumption.lease_expires_at_utc), NOW);
    assert.equal(
      Number(cancelledConsumption.lease_expires_at_mono),
      cancelMono,
    );
    assert.equal(cancelledBuildingScope.scope_status, "cancelled");
    assert.equal(String(cancelledBuildingScope.finished_at), NOW);
    assert.equal(
      Number(cancelledBuildingScope.lease_expires_at_mono),
      cancelMono,
    );
    assert.deepEqual({ ...cancelledFrozenScope }, { ...frozenScopeBefore });
    assert.equal(cancelledSnapshot.intent[0].status, "cancelled");
    assert.equal(
      cancelledSnapshot.mailbox.every((item) =>
        [
          "cancelled",
          "succeeded",
          "partial",
          "failed",
          "needs_user",
          "expired",
          "rejected",
        ].includes(String(item.state)),
      ),
      true,
    );
    assert.equal(cancelledSnapshot.index[0].status, "cancelled");
    assert.equal(Number(cancelledSnapshot.index[0].is_active), 0);
    assert.equal(cancelledSnapshot.cancellationRegistry.length, 1);
    assert.equal(
      String(cancelledSnapshot.cancellationRegistry[0].derived_value),
      String(cancelled.readback.cancellationHash),
    );
    assert.equal(cancelledSnapshot.events.at(-1).event_type, "root.cancelled");
    assert.equal(cancelledSnapshot.outbox.at(-1).event_type, "root.cancelled");
    const currentFenceConflict = fixture.resourceStore.settleTerminal(
      dispatchMutationInput(fixture, judgeDispatch, {
        terminalStatus: "succeeded",
        result: { winner: "different-current-writer" },
        resultHash: hashV1({
          status: "succeeded",
          result: { winner: "different-current-writer" },
        }),
      }),
    );
    assert.equal(currentFenceConflict.ok, false);
    assert.equal(currentFenceConflict.code, "TERMINAL_IMMUTABILITY_CONFLICT");
    assert.deepEqual(
      a34LifecycleSnapshot(database, fixture, rootRequestId),
      cancelledSnapshot,
    );
    const takeoverStore = new WorkspaceOrchestratorActorStore(database, {
      nowUtc: () => NOW,
      nowMono: () => 80_000,
    });
    const takeover = takeoverStore.acquireActor({
      workspaceId: fixture.workspaceId,
      currentBuildId: BUILD_ID,
      leaseToken: "lease-A34-r2",
      runtimeId: "runtime-A34-r2",
      nowUtc: NOW,
      nowMono: 80_000,
      leaseExpiresAtMono: 180_000,
      gateDeadlineMono: 170_000,
      controlStallDeadlineMono: 160_000,
      migrationEpoch: 1,
      writeFence: "allow",
      ...fixture.context.withAcceptance({}),
    });
    assert.equal(takeover.ok, true, JSON.stringify(takeover));
    const lateDispatch = fixture.resourceStore.settleTerminal(
      dispatchMutationInput(fixture, judgeDispatch, {
        terminalStatus: "succeeded",
        result: { winner: "late-old-worker" },
        resultHash: hashV1({
          status: "succeeded",
          result: { winner: "late-old-worker" },
        }),
        fence: oldFence,
        nowMono: 80_001,
      }),
    );
    const lateEffect = fixture.snapshotStore.settleEffectConsumption(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        consumptionId: String(reserved.value.consumptionId),
        state: "consumed",
        outcome: { winner: "late-old-worker" },
        outcomeHash: hashV1({ winner: "late-old-worker" }),
        outcomeQueryKey: "a34-late-effect",
        payloadHash: HEX_C,
        sinkName: String(effectSpec.sinkName),
        sinkRoleId: String(effectSpec.sinkRoleId),
        sinkContractVersion: String(effectSpec.sinkContractVersion),
        deliveryMode: String(effectSpec.deliveryMode),
        effectToken: String(reserved.value.effectToken),
        fence: oldFence,
        nowUtc: NOW,
        nowMono: 80_001,
      }),
    );
    const lateStage = fixture.rootStore.settleStage(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        stageRequestId: String(judgeStage.stage_request_id),
        expectedClaimRevision: Number(cancelledClaim.claim_revision),
        status: "succeeded",
        reasonCode: "A34_LATE_STAGE",
        result: { winner: "late-old-worker" },
        fence: oldFence,
        nowUtc: NOW,
        nowMono: 80_001,
      }),
    );
    for (const late of [lateDispatch, lateEffect, lateStage]) {
      assert.equal(late.ok, false, JSON.stringify(late));
      assert.equal(
        late.code,
        "EXECUTION_AUTHORIZATION_INVALID",
        JSON.stringify(late),
      );
    }
    const afterLateSnapshot = a34LifecycleSnapshot(
      database,
      fixture,
      rootRequestId,
    );
    const {
      events: cancelledEvents,
      outbox: cancelledOutbox,
      ...cancelledTerminalRows
    } = cancelledSnapshot;
    const {
      events: afterEvents,
      outbox: afterOutbox,
      ...afterTerminalRows
    } = afterLateSnapshot;
    assert.deepEqual(afterTerminalRows, cancelledTerminalRows);
    assert.deepEqual(
      afterEvents.slice(0, cancelledEvents.length),
      cancelledEvents,
    );
    assert.deepEqual(
      afterOutbox.slice(0, cancelledOutbox.length),
      cancelledOutbox,
    );
    assert.equal(afterEvents.at(-1).event_type, "authority.taken_over");
    assert.equal(afterOutbox.at(-1).event_type, "authority.taken_over");
    assert.equal(
      count(
        database,
        "managed_job_dispatches",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, rootRequestId],
      ),
      cancelledSnapshot.dispatches.length,
    );
    assert.equal(
      count(
        database,
        "managed_effect_consumptions",
        "workspace_id=? AND root_request_id=?",
        [fixture.workspaceId, rootRequestId],
      ),
      cancelledSnapshot.consumptions.length,
    );
    const replay = fixture.rootStore.cancelRoot(
      acceptanceInput(fixture.context, {
        workspaceId: fixture.workspaceId,
        rootRequestId,
        reasonCode: "A34_CANCEL_CASCADE",
        fence: fenceFrom(currentActor(fixture)),
        nowUtc: NOW,
        nowMono: 80_002,
      }),
    );
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.status, "replayed");
    assert.deepEqual(
      normalizeRootBundle(fixture, replay),
      normalizeRootBundle(fixture, cancelled),
    );
    const proof = commonProof(fixture, {
      injection: [
        "frozen Stage-D effect",
        "reserved effect consumption",
        "building/frozen scope split",
        "atomic cancel/drain cascade",
        "different terminal hash first-writer conflict",
        "old dispatch/effect/stage fence after takeover",
      ],
      uniqueCondition: {
        cancellationHash: cancelled.readback.cancellationHash,
        winnerDispatchHash: cancelledDispatch.result_hash,
        oldRuntimeEpoch: takeover.actor.runtimeEpoch - 1,
        winnerRuntimeEpoch: takeover.actor.runtimeEpoch,
        lateCodes: [lateDispatch.code, lateEffect.code, lateStage.code],
      },
      durableReadbacks: [
        cancelledSnapshot,
        currentFenceConflict,
        lateDispatch,
        lateEffect,
        lateStage,
        replay,
      ],
      zeroWriteCounts: {
        activeClaimsAfterCancel: count(
          database,
          "daily_stage_claims",
          "workspace_id=? AND root_request_id=? AND is_active=1",
          [fixture.workspaceId, rootRequestId],
        ),
        activeDispatchesAfterCancel: count(
          database,
          "managed_job_dispatches",
          "workspace_id=? AND root_request_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')",
          [fixture.workspaceId, rootRequestId],
        ),
        activeConsumptionsAfterCancel: count(
          database,
          "managed_effect_consumptions",
          "workspace_id=? AND root_request_id=? AND state IN ('reserved','consuming','unknown')",
          [fixture.workspaceId, rootRequestId],
        ),
        childRowsAfterLate: count(
          database,
          "managed_job_dispatches",
          "workspace_id=? AND root_request_id=?",
          [fixture.workspaceId, rootRequestId],
        ),
        effectRowsAfterLate: count(
          database,
          "managed_effect_consumptions",
          "workspace_id=? AND root_request_id=?",
          [fixture.workspaceId, rootRequestId],
        ),
      },
    });
    finish(fixture, {
      status: "passed",
      passed: true,
      proof,
      readbacks: [
        cancelledSnapshot,
        currentFenceConflict,
        lateDispatch,
        lateEffect,
        lateStage,
        replay,
      ],
      evidencePointer,
    });
  }));
