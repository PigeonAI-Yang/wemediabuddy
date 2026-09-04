import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateDatabase } from "../src/main/db/migrations.ts";
import {
  ORCHESTRATOR_IDENTITY_REGISTRY,
  WORKSPACE_ORCHESTRATOR_DESIGN,
  WORKSPACE_ORCHESTRATOR_ERROR_MATRIX,
  WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS,
  WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS,
  WorkspaceOrchestratorCutoverError,
  collectWorkspaceOrchestratorBaseline,
  freezeWorkspaceOrchestratorProducerManifest,
  requireRegisteredOrchestratorProducer,
} from "../src/main/workspace-orchestrator-stage0.ts";
const EXPECTED_PRODUCERS = [
  "maintenance.topic-reproposal",
  "mcp.daily-run-stage",
  "mcp.jobs-spawn",
  "proposal.candidate-decision",
  "reconcile.agent-tasks-recover",
  "reconcile.daily-handoff-sweeper",
  "reconcile.research-successor-scheduler",
  "scheduler.daily-0900",
  "scheduler.rolling-official-web",
  "scheduler.rolling-x-lists",
  "startup.daily-resume",
  "startup.refresh-runtime-daily-handoff",
  "today.agent-start-daily-intelligence",
  "ui.jobs-spawn",
];

function withDatabase(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmb-5365-stage0-"));
  const database = migrateDatabase(path.join(root, "wmb.db"));
  try {
    const now = "2026-08-30T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO app_meta (key, value, created_at, updated_at, revision)
      VALUES ('workspace_id', 'workspace-stage0', ?, ?, 1)`,
      )
      .run(now, now);
    return run({ root, database });
  } finally {
    database.close();
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

function tableCardinality(database) {
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      Number(
        database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count,
      ),
    ]),
  );
}

test("WMB-5365 freezes the approved design identity and bounded defaults", () => {
  assert.equal(
    WORKSPACE_ORCHESTRATOR_DESIGN.path,
    "docs/spark/2026-08-29-workspace-orchestrator-design.md",
  );
  assert.equal(
    WORKSPACE_ORCHESTRATOR_DESIGN.sha256,
    "fb61cd119233f933a743a8a8bee0f63887f10f62755216535d53777bc1a880c6",
  );
  assert.deepEqual(WORKSPACE_ORCHESTRATOR_DESIGN.defaultBudget, {
    maxSourcesPerRoot: 80,
    reporterConcurrency: 5,
    judgeConcurrency: 1,
    maxEvidenceSuccessors: 2,
    maxStageAttempts: 2,
    rootWallClockMs: 1_200_000,
    waitingResourceMs: 90_000,
  });
  assert.equal(
    new Set(ORCHESTRATOR_IDENTITY_REGISTRY).size,
    ORCHESTRATOR_IDENTITY_REGISTRY.length,
  );
  assert.equal(ORCHESTRATOR_IDENTITY_REGISTRY.length, 26);
  assert(ORCHESTRATOR_IDENTITY_REGISTRY.includes("execution-envelope/v2"));
  assert(ORCHESTRATOR_IDENTITY_REGISTRY.includes("sink-token/v2"));
  assert(ORCHESTRATOR_IDENTITY_REGISTRY.includes("projection/v2"));
});

test("WMB-5365 producer and runtime census is explicit, unique, and replacement-bound", () => {
  assert.deepEqual(
    WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.map(
      ({ producerId }) => producerId,
    ).sort(),
    EXPECTED_PRODUCERS,
  );
  assert.equal(
    new Set(
      WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.map(
        ({ sourceLocation }) => sourceLocation,
      ),
    ).size,
    EXPECTED_PRODUCERS.length,
  );
  for (const producer of WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS) {
    assert.equal(producer.legacyDirect, false);
    assert.match(
      producer.replacementRoute,
      /Actor|submitWorkspaceOrchestratorIntent/,
    );
    assert(producer.writeTables.length > 0);
    assert(producer.currentDirectAction.length > 0);
  }
  assert.equal(
    new Set(
      WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS.map(
        ({ inventoryId }) => inventoryId,
      ),
    ).size,
    WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS.length,
  );
  assert(
    WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS.some(
      ({ kind }) => kind === "process",
    ),
  );
  assert(
    WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS.some(
      ({ kind }) => kind === "session",
    ),
  );
  assert(
    WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS.some(
      ({ kind }) => kind === "store-writer",
    ),
  );
});

test("WMB-5365 freezes a build-bound producer registry manifest", () => {
  const manifest = freezeWorkspaceOrchestratorProducerManifest({
    buildId: "build-stage0",
    sourceCommit: "commit-stage0",
    packageHash: "package-stage0",
    appAsarHash: "asar-stage0",
    schemaEpoch: 78,
    cutoverEpoch: 0,
    authorizerRevision: "dispatcher-v1",
    processImagePath: "C:/Program Files/WeMediaBuddy/WeMediaBuddy.exe",
    resourcesPath: "C:/Program Files/WeMediaBuddy/resources",
    enabledProducerIds: ["today.agent-start-daily-intelligence"],
  });
  assert.match(manifest.censusHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.entries.length, EXPECTED_PRODUCERS.length);
  assert.equal(manifest.entries.filter(({ enabled }) => enabled).length, 1);
  for (const entry of manifest.entries) {
    assert.match(entry.registryEntryHash, /^[a-f0-9]{64}$/);
    assert.equal(entry.censusHash, manifest.censusHash);
    assert.equal(entry.owner, "workspace_orchestrator");
    assert.equal(entry.authorizerRevision, "dispatcher-v1");
  }
  assert.throws(
    () =>
      freezeWorkspaceOrchestratorProducerManifest({
        buildId: "build-stage0",
        sourceCommit: "commit-stage0",
        packageHash: "package-stage0",
        appAsarHash: "asar-stage0",
        schemaEpoch: 78,
        cutoverEpoch: 0,
        authorizerRevision: "dispatcher-v1",
        processImagePath: "app.exe",
        resourcesPath: "resources",
        enabledProducerIds: ["unknown.direct-producer"],
      }),
    (error) =>
      error instanceof WorkspaceOrchestratorCutoverError &&
      error.code === "CUTOVER_REQUIRED",
  );
});

test("WMB-5365 producer allowlist fails closed on unknown or drifted call sites", () => {
  const known = WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS[0];
  assert.equal(
    requireRegisteredOrchestratorProducer(
      known.producerId,
      known.sourceLocation,
    ),
    known,
  );
  for (const [producerId, sourceLocation] of [
    ["unknown.direct-producer", "src/main/unknown.ts"],
    [known.producerId, "src/main/drifted-callsite.ts"],
  ]) {
    assert.throws(
      () => requireRegisteredOrchestratorProducer(producerId, sourceLocation),
      (error) =>
        error instanceof WorkspaceOrchestratorCutoverError &&
        error.code === "CUTOVER_REQUIRED",
    );
  }
});

test("WMB-5365 error matrix is exhaustive, unique, and fail-closed", () => {
  const codes = WORKSPACE_ORCHESTRATOR_ERROR_MATRIX.map(
    ({ reasonCode }) => reasonCode,
  );
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes.length, 49);
  for (const required of [
    "CHANNEL_CONFIGURATION_REQUIRED",
    "SOURCE_SNAPSHOT_STALE",
    "EFFECT_OUTCOME_UNKNOWN",
    "MAILBOX_BACKPRESSURE",
    "OWNER_APPROVAL_STALE",
    "WORKSPACE_STALE",
    "EXECUTION_AUTHORIZATION_INVALID",
    "ORCHESTRATOR_CONTRACT_ERROR",
  ])
    assert(codes.includes(required), `missing ${required}`);
  assert.equal(
    WORKSPACE_ORCHESTRATOR_ERROR_MATRIX.at(-1).reasonCode,
    "ORCHESTRATOR_CONTRACT_ERROR",
  );
});

test("WMB-5365 baseline collection is read-only and fingerprints the current workspace", () =>
  withDatabase(({ root, database }) => {
    const before = tableCardinality(database);
    const baseline = collectWorkspaceOrchestratorBaseline(database, {
      dataRootPath: root,
      capturedAt: "2026-08-30T00:00:01.000Z",
      buildId: "test-build",
      packageHash: "package-sha256",
      appAsarHash: "asar-sha256",
    });
    const after = tableCardinality(database);

    assert.deepEqual(
      after,
      before,
      "Stage 0 baseline must not mutate any durable table",
    );
    assert.equal(baseline.workspaceId, "workspace-stage0");
    assert.equal(baseline.dataRootPath, path.resolve(root));
    assert.match(baseline.dataRootFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(
      baseline.schema.maxVersion,
      Math.max(
        ...database
          .prepare("SELECT version FROM schema_migrations")
          .all()
          .map(({ version }) => Number(version)),
      ),
    );
    assert.equal(baseline.build.buildId, "test-build");
    assert.equal(baseline.active.dailyTasks, 0);
    assert.equal(baseline.active.managerTasks, 0);
    assert.equal(baseline.active.dailyClaims, 0);
    assert.equal(baseline.active.jobsPending, 0);
    assert.equal(baseline.active.jobsRunning, 0);
    assert.match(baseline.producerCensusHash, /^[a-f0-9]{64}$/);
    assert.match(baseline.runtimeCensusHash, /^[a-f0-9]{64}$/);
  }));
