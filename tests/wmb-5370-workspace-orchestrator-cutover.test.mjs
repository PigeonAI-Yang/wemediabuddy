import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS } from '../src/main/workspace-orchestrator-stage0.ts';
import {
  initializeWorkspaceOrchestratorRuntime,
  submitWorkspaceOrchestratorIntent
} from '../src/main/workspace-orchestrator-runtime.ts';

const BUSINESS_DATE = '2026-08-30';
const NOW = '2026-08-30T10:00:00.000Z';
const WORKSPACE_ID = 'wmb-5370-cutover';
const OWNER_PRODUCER = 'today.agent-start-daily-intelligence';

// Control-plane rows are durable identity, admission, audit, and transport
// state. Every other migrated table is a business table for this acceptance.
const CONTROL_PLANE_TABLES = new Set([
  'acceptance_runs',
  'app_meta',
  'build_manifests',
  'command_receipts',
  'daily_reconcile_gates',
  'identity_hash_registry',
  'operation_log',
  'orchestrator_events',
  'orchestrator_inbox',
  'orchestrator_intents',
  'orchestrator_mailbox',
  'orchestrator_outbox',
  'producer_registry',
  'schema_migrations',
  'sqlite_sequence',
  'workspace_active_root_index',
  'workspace_migration_journal',
  'workspace_migration_state',
  'workspace_orchestrator_actors',
  'workspace_rollback_state'
]);

const ACCEPTED_TRANSPORT_TABLES = new Set([
  'command_receipts',
  'identity_hash_registry',
  'orchestrator_events',
  'orchestrator_intents',
  'orchestrator_mailbox',
  'orchestrator_outbox'
]);

const ACCEPTED_UPDATED_CONTROL_TABLES = new Set([
  'daily_reconcile_gates',
  'workspace_orchestrator_actors'
]);

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(absolute));
    else if (/\.(?:[cm]?js|tsx?|jsx?)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

/** Mask strings/comments while preserving line breaks for static callsite checks. */
function maskNonCode(source) {
  let state = 'code';
  let escaped = false;
  let masked = '';
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      masked += current === '\n' ? '\n' : ' ';
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      masked += current === '\n' ? '\n' : ' ';
      if (current === '*' && next === '/') {
        masked += ' ';
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      masked += current === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if ((state === 'single' && current === "'")
        || (state === 'double' && current === '"')
        || (state === 'template' && current === '`')) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      masked += '  ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (current === '/' && next === '*') {
      masked += '  ';
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (current === "'") {
      masked += ' ';
      state = 'single';
      escaped = false;
      continue;
    }
    if (current === '"') {
      masked += ' ';
      state = 'double';
      escaped = false;
      continue;
    }
    if (current === '`') {
      masked += ' ';
      state = 'template';
      escaped = false;
      continue;
    }
    masked += current;
  }
  return masked;
}

function lineAt(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset) + 1;
  const lineEnd = source.indexOf('\n', offset);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function isFunctionDeclaration(masked, offset) {
  const prefix = masked.slice(Math.max(0, offset - 160), offset);
  return /\bfunction\s+$/.test(prefix);
}

function findCallsites(masked, name) {
  const expression = new RegExp(`\\b${name}\\s*\\(`, 'g');
  const matches = [];
  for (const match of masked.matchAll(expression)) {
    if (!isFunctionDeclaration(masked, match.index)) matches.push(match.index);
  }
  return matches;
}

function sourceLocationFiles() {
  const matches = new Set();
  for (const producer of WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.filter(({ legacyDirect }) => legacyDirect)) {
    for (const match of producer.sourceLocation.matchAll(/src\/main\/[A-Za-z0-9_.-]+/g)) {
      matches.add(match[0].replaceAll('/', path.sep));
    }
  }
  return [...matches].sort();
}

function staticProductionCallerFiles() {
  const root = fileURLToPath(new URL('../src/main/', import.meta.url));
  const censusFiles = sourceLocationFiles().map((relative) => path.resolve(process.cwd(), relative));
  const extra = [
    path.join(root, 'agent-task-commands.ts'),
    path.join(root, 'daily-orchestration.ts'),
    path.join(root, 'manager-dispatch.ts'),
    path.join(root, 'manager-orchestration.ts'),
    path.join(root, 'planning-stage-intake.ts')
  ];
  return [...new Set([...censusFiles, ...extra])].filter((file) => fs.existsSync(file));
}

function allTableNames(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => String(name));
}
function numericCell(value) {
  const text = typeof value === 'string' && /^-?\d+n$/.test(value) ? value.slice(0, -1) : value;
  return Number(text);
}

function canonicalCell(value) {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function tableRows(database, table) {
  const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all().map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, canonicalCell(value)])
  ));
  return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function snapshotTables(database, predicate = () => true) {
  return Object.fromEntries(allTableNames(database).filter(predicate).sort().map((table) => [table, tableRows(database, table)]));
}

function changedTables(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((table) => JSON.stringify(before[table] ?? []) !== JSON.stringify(after[table] ?? []))
    .sort();
}

function assertNoBusinessWrites(before, after, message) {
  assert.deepEqual(after, before, message);
}

function assertRejectedTransportDelta(before, after) {
  const changed = changedTables(before, after);
  assert.ok(changed.every((table) => table === 'command_receipts'), `rejection changed forbidden control rows: ${changed.join(', ')}`);
  assert.deepEqual(after.orchestrator_intents, before.orchestrator_intents);
  assert.deepEqual(after.orchestrator_mailbox, before.orchestrator_mailbox);
  assert.deepEqual(after.orchestrator_events, before.orchestrator_events);
  assert.deepEqual(after.orchestrator_outbox, before.orchestrator_outbox);
}

function seedWorkspace(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  database.prepare(`INSERT INTO app_meta(key, value, created_at, updated_at, revision)
    VALUES('workspace_id', ?, ?, ?, 1)`).run(WORKSPACE_ID, NOW, NOW);
  database.close();
}

function mutateDatabase(directory, callback) {
  const database = new DatabaseSync(path.join(directory, 'wmb.db'));
  try { callback(database); } finally { database.close(); }
}

async function withRuntime(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5370-'));
  let runtime;
  try {
    seedWorkspace(directory);
    runtime = ActiveWorkspaceRuntime.open(directory, {
      openDatabase: migrateDatabase,
      createEpoch: () => 'runtime-wmb-5370'
    });
    await initializeWorkspaceOrchestratorRuntime(runtime);
    return await work({ directory, runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function validIntent(overrides = {}) {
  const logicalInput = { topic: 'AI infrastructure', modules: ['official_web'] };
  return {
    producerId: OWNER_PRODUCER,
    businessDate: BUSINESS_DATE,
    requestId: 'request-typed-5370',
    action: 'full',
    logicalInput,
    payload: logicalInput,
    channelPolicy: [],
    profileRevision: 1,
    rootMode: 'owner',
    ...overrides
  };
}

test('A25/A39-A41/A54/A57: census-listed producer entries have typed intent descriptors and no legacy callers', () => {
  const sourceRoot = fileURLToPath(new URL('../src/main/', import.meta.url));
  const allSourceFiles = listSourceFiles(sourceRoot);
  const missingLocations = sourceLocationFiles().filter((relative) => !fs.existsSync(path.resolve(process.cwd(), relative)));
  assert.deepEqual(missingLocations, [], 'producer census source locations must resolve to production files');

  const callerFiles = staticProductionCallerFiles();
  const forbiddenCallers = [];
  const forbiddenCalls = [
    'startWorkspaceDailyIntelligence',
    'orchestrateDailyContent',
    'continueAfterScan',
    'runManagerDailyStage',
    'getLatestDailyIntelligenceTask',
    'getLatestDailyIntelligenceTaskSince',
    'getActiveDailyIntelligenceTask',
    'dispatchRecoverInterruptedAgentTasks',
    'getLatestAgentTask',
    'sweepOrphanDailyTasks'
  ];
  for (const file of callerFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const masked = maskNonCode(source);
    for (const name of forbiddenCalls) {
      for (const offset of findCallsites(masked, name)) {
        forbiddenCallers.push(`${path.relative(process.cwd(), file)}:${source.slice(0, offset).split('\n').length}:${name}(): ${lineAt(source, offset)}`);
      }
    }
    for (const match of masked.matchAll(/\b(?:spawner|managerSpawner|jobSpawner)\s*(?:\?\.|\.)?\s*spawn\s*\(/g)) {
      forbiddenCallers.push(`${path.relative(process.cwd(), file)}:${source.slice(0, match.index).split('\n').length}:direct .spawn(): ${lineAt(source, match.index)}`);
    }
    for (const token of ['legacyPipeline', 'shouldStartLegacyPipeline']) {
      if (new RegExp(`\\b${token}\\b`).test(masked)) {
        forbiddenCallers.push(`${path.relative(process.cwd(), file)}:${token}: legacy manager fallback token remains in a production caller`);
      }
    }
  }
  assert.deepEqual(forbiddenCallers, [], `legacy production callers must be absent; violations:\n${forbiddenCallers.join('\n')}`);

  const descriptorMissing = [];
  for (const relative of sourceLocationFiles()) {
    const file = path.resolve(process.cwd(), relative);
    const masked = maskNonCode(fs.readFileSync(file, 'utf8'));
    const hasGatewayCall = /\bsubmitWorkspaceOrchestratorIntent\s*\(/.test(masked);
    const hasTypedDescriptor = /\bkind\s*:\s*['"]submitWorkspaceOrchestratorIntent['"]/.test(masked)
      && /\bproducerId\s*:/.test(masked);
    const submitIntentOffset = masked.search(/\bsubmitIntent\s*\(/);
    const submitIntentContext = submitIntentOffset < 0
      ? ''
      : masked.slice(Math.max(0, submitIntentOffset - 1_200), submitIntentOffset + 1_200);
    const hasTypedCallback = submitIntentOffset >= 0
      && /\bproducerId\s*:/.test(submitIntentContext)
      && /\brootMode\s*:/.test(submitIntentContext)
      && /\b(?:action|requestedAction)\s*:/.test(submitIntentContext);
    if (!hasGatewayCall && !hasTypedDescriptor && !hasTypedCallback) descriptorMissing.push(relative);
  }
  assert.deepEqual(descriptorMissing, [], 'every legacyDirect census source file must expose a typed intent route or descriptor');
  assert.ok(allSourceFiles.length >= callerFiles.length, 'static production inventory must be non-empty');
});

test('A25/A39-A41/A54/A57: legal typed intent returns one canonical receipt with transport-only business delta', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const before = snapshotTables(database);
    const receipt = await submitWorkspaceOrchestratorIntent(runtime, validIntent());

    assert.equal(receipt.version, 'WorkspaceOrchestratorReceiptV1');
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.code, null);
    assert.equal(receipt.workspaceId, WORKSPACE_ID);
    assert.equal(receipt.requestId, 'request-typed-5370');
    assert.ok(receipt.receiptId);
    assert.ok(receipt.intentId);
    assert.ok(receipt.invocationId);
    const after = snapshotTables(database);
    const expectedChanged = new Set([...ACCEPTED_TRANSPORT_TABLES, ...ACCEPTED_UPDATED_CONTROL_TABLES]);
    assert.deepEqual(new Set(changedTables(before, after)), expectedChanged, 'typed intent may only add transport rows and advance actor/gate checkpoints');
    for (const table of ACCEPTED_TRANSPORT_TABLES) {
      const delta = after[table].length - before[table].length;
      assert.equal(delta, table === 'identity_hash_registry' ? 5 : 1, `${table} changed by an unexpected number of rows`);
    }
    const beforeActor = before.workspace_orchestrator_actors[0];
    const afterActor = after.workspace_orchestrator_actors[0];
    assert.equal(numericCell(afterActor.invocation_ordinal), numericCell(beforeActor.invocation_ordinal) + 1);
    assert.equal(numericCell(afterActor.mailbox_sequence), numericCell(beforeActor.mailbox_sequence) + 1);
    assert.equal(numericCell(afterActor.checkpoint_revision), numericCell(beforeActor.checkpoint_revision) + 1);
    const beforeGate = before.daily_reconcile_gates[0];
    const afterGate = after.daily_reconcile_gates[0];
    for (const [key, value] of Object.entries(beforeActor)) {
      if (new Set(['invocation_ordinal', 'mailbox_sequence', 'checkpoint_revision', 'updated_at']).has(key)) continue;
      assert.deepEqual(afterActor[key], value, `actor field ${key} must not change during intent admission`);
    }
    for (const [key, value] of Object.entries(beforeGate)) {
      if (key === 'checkpoint_revision') continue;
      assert.deepEqual(afterGate[key], value, `gate field ${key} must not change during intent admission`);
    }
    assert.equal(numericCell(afterGate.checkpoint_revision), numericCell(beforeGate.checkpoint_revision) + 1);
    for (const [table, rows] of Object.entries(after)) {
      if (ACCEPTED_TRANSPORT_TABLES.has(table) || ACCEPTED_UPDATED_CONTROL_TABLES.has(table)) continue;
      assert.deepEqual(rows, before[table], `${table} must not change on pre-root intent acceptance`);
    }
  });
});

test('A39-A41/A54/A57: unregistered producer and live attestation mismatch reject before business writes', async () => {
  await withRuntime(async ({ directory, runtime, database }) => {
    const beforeBusiness = snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table));
    const beforeControl = snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table));
    const rejected = await submitWorkspaceOrchestratorIntent(runtime, validIntent({
      producerId: 'unregistered.producer',
      requestId: 'request-unregistered-5370'
    }));
    assert.equal(rejected.version, 'WorkspaceOrchestratorReceiptV1');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.code, 'CUTOVER_REQUIRED');
    assertNoBusinessWrites(beforeBusiness, snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table)), 'unknown producer must be business-write free');
    assertRejectedTransportDelta(beforeControl, snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table)));
  });

  await withRuntime(async ({ directory, runtime, database }) => {
    const registry = database.prepare(`SELECT producer_id FROM producer_registry WHERE workspace_id=? AND producer_id=?`).get(WORKSPACE_ID, OWNER_PRODUCER);
    assert.ok(registry, 'runtime initialization must install the owner producer registry entry');
    mutateDatabase(directory, (tampered) => {
      tampered.prepare(`UPDATE producer_registry SET registry_entry_hash=? WHERE workspace_id=? AND producer_id=?`)
        .run('f'.repeat(64), WORKSPACE_ID, OWNER_PRODUCER);
    });
    const beforeBusiness = snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table));
    const beforeControl = snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table));
    const rejected = await submitWorkspaceOrchestratorIntent(runtime, validIntent({ requestId: 'request-attestation-mismatch-5370' }));
    assert.equal(rejected.version, 'WorkspaceOrchestratorReceiptV1');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.code, 'CUTOVER_REQUIRED');
    assertNoBusinessWrites(beforeBusiness, snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table)), 'attestation mismatch must be business-write free');
    assertRejectedTransportDelta(beforeControl, snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table)));
  });
});

test('A39-A41/A54/A57: durable write fence and startup gate rejection leave business tables unchanged', async () => {
  await withRuntime(async ({ directory, runtime, database }) => {
    mutateDatabase(directory, (tampered) => {
      tampered.prepare(`UPDATE workspace_orchestrator_actors SET write_fence='deny' WHERE workspace_id=?`).run(WORKSPACE_ID);
    });
    const beforeBusiness = snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table));
    const beforeControl = snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table));
    const rejected = await submitWorkspaceOrchestratorIntent(runtime, validIntent({ requestId: 'request-write-fence-5370' }));
    assert.equal(rejected.version, 'WorkspaceOrchestratorReceiptV1');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.code, 'EXECUTION_AUTHORIZATION_INVALID');
    assertNoBusinessWrites(beforeBusiness, snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table)), 'write-fence rejection must not touch business rows');
    assertRejectedTransportDelta(beforeControl, snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table)));
  });

  await withRuntime(async ({ directory, runtime, database }) => {
    mutateDatabase(directory, (tampered) => {
      tampered.prepare(`UPDATE daily_reconcile_gates
        SET status='pending', reason='WMB-5370 gate rejection fixture', finished_at_utc=NULL, finished_at_mono=NULL
        WHERE workspace_id=? AND runtime_epoch=(SELECT runtime_epoch FROM workspace_orchestrator_actors WHERE workspace_id=?)`)
        .run(WORKSPACE_ID, WORKSPACE_ID);
    });
    const beforeBusiness = snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table));
    const beforeControl = snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table));
    const rejected = await submitWorkspaceOrchestratorIntent(runtime, validIntent({ requestId: 'request-gate-5370' }));
    assert.equal(rejected.version, 'WorkspaceOrchestratorReceiptV1');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.code, 'STARTUP_RECONCILE_REQUIRED');
    assertNoBusinessWrites(beforeBusiness, snapshotTables(database, (table) => !CONTROL_PLANE_TABLES.has(table)), 'startup-gate rejection must not touch business rows');
    assertRejectedTransportDelta(beforeControl, snapshotTables(database, (table) => CONTROL_PLANE_TABLES.has(table)));
  });
});
