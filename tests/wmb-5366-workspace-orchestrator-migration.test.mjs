import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const { migrations, migrateDatabase } = await import('../src/main/db/migrations.ts');
const { workspaceOrchestratorMigrations } = await import('../src/main/db/workspace-orchestrator-migrations.ts');

const ORCHESTRATOR_VERSION = 79;
const NOW = '2026-08-30T00:00:00.000Z';
const HEX = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

const REQUIRED_TABLES = [
  'identity_hash_registry',
  'workspace_orchestrator_actors',
  'orchestrator_mailbox',
  'command_receipts',
  'orchestrator_intents',
  'channel_preflight_snapshots',
  'daily_orchestration_roots',
  'daily_stage_claims',
  'source_snapshots',
  'daily_repair_snapshot_bindings',
  'daily_plan_scopes',
  'managed_job_dispatches',
  'managed_effect_consumptions',
  'orchestrator_events',
  'orchestrator_outbox',
  'orchestrator_inbox',
  'daily_reconcile_gates',
  'workspace_active_root_index',
  'workspace_migration_state',
  'workspace_rollback_state',
  'workspace_migration_journal',
  'producer_registry',
  'build_manifests',
  'acceptance_runs'
];

const REQUIRED_COLUMNS = {
  identity_hash_registry: ['workspace_id', 'registry_name', 'registry_version', 'preimage_schema_version', 'preimage_hash', 'canonical_bytes_hash', 'preimage_bytes', 'derived_value', 'created_at'],
  workspace_orchestrator_actors: ['workspace_id', 'actor_status', 'runtime_epoch', 'owner_epoch', 'authority_revision', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'control_stall_deadline_utc', 'control_stall_deadline_mono', 'gate_deadline_utc', 'gate_deadline_mono', 'invocation_ordinal', 'mailbox_sequence', 'checkpoint_revision', 'migration_epoch', 'write_fence', 'current_build_id'],
  orchestrator_mailbox: ['workspace_id', 'mailbox_sequence', 'command_replay_key', 'request_id', 'intent_id', 'producer', 'priority', 'enqueued_at_utc', 'enqueued_at_mono', 'expires_at_utc', 'expires_at_mono', 'coalescing_key', 'coalescing_mode', 'causation_id', 'logical_input_hash', 'normalized_policy_hash', 'payload_hash', 'state', 'claimed_actor_epoch', 'finished_at_utc', 'finished_at_mono'],
  command_receipts: ['workspace_id', 'request_id', 'command', 'command_replay_key', 'logical_input_hash', 'execution_envelope_json', 'response_json', 'response_hash', 'terminal_status', 'conflict_json'],
  orchestrator_intents: ['intent_id', 'workspace_id', 'business_date', 'source', 'root_mode', 'requested_action', 'request_id', 'command_replay_key', 'invocation_id', 'invocation_ordinal', 'causation_id', 'logical_input_hash', 'normalized_policy_hash', 'channel_policy_json', 'status', 'checkpoint_revision', 'created_at', 'updated_at', 'finished_at'],
  channel_preflight_snapshots: ['preflight_id', 'workspace_id', 'intent_id', 'business_date', 'source', 'profile_revision', 'policy_hash', 'preflight_version', 'selected_channels_json', 'results_json', 'ready_channel_ids_json', 'excluded_optional_channel_ids_json', 'required_failures_json', 'coverage_gap_json', 'preflight_hash', 'status', 'created_at', 'finished_at'],
  daily_orchestration_roots: ['root_id', 'workspace_id', 'business_date', 'root_mode', 'source', 'root_generation', 'root_request_id', 'root_input_hash', 'orchestration_id', 'manager_task_id', 'retry_invocation_ordinal', 'predecessor_root_id', 'status', 'checkpoint_revision', 'owner_epoch', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'root_deadline_utc', 'root_deadline_mono', 'gate_deadline_utc', 'gate_deadline_mono', 'created_at', 'updated_at', 'finished_at'],
  daily_stage_claims: ['claim_id', 'workspace_id', 'claim_kind', 'cycle_id', 'gap_id', 'claim_scope_key', 'stage_request_id', 'request_id', 'root_request_id', 'root_generation', 'root_input_hash', 'manager_task_id', 'orchestration_id', 'parent_task_id', 'parent_stage_request_id', 'root_mode', 'attempt_stage', 'retry_generation', 'logical_input_hash', 'status', 'is_active', 'claim_revision', 'owner_epoch', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'stage_deadline_utc', 'stage_deadline_mono', 'control_stall_deadline_utc', 'control_stall_deadline_mono', 'snapshot_json', 'child_ids_json', 'result_json', 'created_at', 'updated_at', 'finished_at'],
  source_snapshots: ['snapshot_id', 'workspace_id', 'business_date', 'source_task_id', 'root_request_id', 'root_generation', 'stage_request_id', 'scan_attempt_id', 'preflight_id', 'policy_hash', 'profile_revision', 'selected_channel_ids_json', 'successful_channels_json', 'failed_channels_json', 'unresolved_channels_json', 'source_ids_json', 'source_bindings_json', 'receipt_ids_json', 'receipt_bindings_json', 'watermark_utc', 'watermark_mono', 'captured_at_utc', 'excluded_by_budget_count', 'snapshot_hash', 'status'],
  daily_repair_snapshot_bindings: ['repair_snapshot_id', 'workspace_id', 'predecessor_scope_id', 'predecessor_source_snapshot_id', 'predecessor_stage_request_id', 'binding_kind', 'prior_item_revision', 'prior_item_content_hash', 'repaired_item_revision', 'repaired_item_content_hash', 'repair_snapshot_hash', 'binding_hash', 'binding_revision'],
  daily_plan_scopes: ['scope_id', 'workspace_id', 'stage_request_id', 'root_request_id', 'root_generation', 'root_input_hash', 'manager_task_id', 'orchestration_id', 'attempt_stage', 'claim_revision', 'owner_epoch', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'source_snapshot_hash', 'binding_kind', 'repair_snapshot_hash', 'binding_hash', 'allowed_plan_ids_json', 'allowed_plan_item_ids_json', 'carry_plan_item_ids_json', 'trusted_receipt_ids_json', 'scope_status', 'scope_json', 'scope_hash', 'created_at', 'updated_at', 'finished_at'],
  managed_job_dispatches: ['job_id', 'workspace_id', 'child_identity_key', 'child_ordinal', 'role_id', 'operation_request_id', 'manager_task_id', 'orchestration_id', 'parent_task_id', 'parent_stage_request_id', 'root_request_id', 'root_generation', 'root_input_hash', 'preflight_id', 'policy_hash', 'stage_request_id', 'retry_generation', 'expected_parent_claim_revision', 'expected_parent_owner_epoch', 'expected_parent_lease_token', 'launch_attempt_id', 'launch_token_hash', 'process_handle', 'pid', 'argv_hash', 'cwd_fingerprint', 'session_key', 'spawn_deadline_utc', 'spawn_deadline_mono', 'state', 'result_hash', 'envelope_json', 'result_json', 'owner_epoch', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'finished_at'],
  managed_effect_consumptions: ['consumption_id', 'workspace_id', 'operation_request_id', 'effect_request_id', 'effect_logical_key', 'effect_set_hash', 'effect_token', 'payload_hash', 'manager_task_id', 'orchestration_id', 'root_request_id', 'root_generation', 'stage_request_id', 'source_dispatch_job_id', 'source_result_hash', 'role_id', 'sink_name', 'sink_role_id', 'sink_contract_version', 'delivery_mode', 'sink_capability_proof_hash', 'outcome_query_key', 'outcome_hash', 'state', 'consumption_revision', 'expected_stage_claim_revision', 'owner_epoch', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'finished_at'],
  orchestrator_events: ['workspace_id', 'event_sequence', 'event_id', 'event_type', 'event_ordinal', 'business_date', 'source', 'intent_id', 'invocation_id', 'root_request_id', 'root_generation', 'orchestration_id', 'manager_task_id', 'stage_request_id', 'request_id', 'operation_request_id', 'parent_task_id', 'job_id', 'causation_id', 'actor_epoch', 'owner_epoch', 'lease_token_fingerprint', 'claim_revision', 'checkpoint_revision', 'snapshot_hash', 'scope_hash', 'projection_hash', 'producer_id', 'registry_entry_hash', 'census_hash', 'trigger_id', 'occurred_at_utc'],
  orchestrator_outbox: ['outbox_id', 'workspace_id', 'aggregate_id', 'aggregate_revision', 'event_type', 'event_ordinal', 'causation_id', 'payload_hash', 'payload_bytes', 'status', 'attempt', 'lease', 'created_at', 'delivered_at'],
  orchestrator_inbox: ['consumer_id', 'message_id', 'aggregate_id', 'aggregate_revision', 'event_type', 'event_ordinal', 'processed_result_hash', 'cursor'],
  daily_reconcile_gates: ['workspace_id', 'runtime_epoch', 'owner_epoch', 'lease_token', 'lease_expires_at_utc', 'lease_expires_at_mono', 'gate_deadline_utc', 'gate_deadline_mono', 'checkpoint_revision', 'status', 'reason', 'finished_at_utc', 'finished_at_mono'],
  workspace_active_root_index: ['workspace_id', 'root_request_id', 'orchestration_id', 'manager_task_id', 'root_generation', 'source', 'root_mode', 'status', 'terminal_reason', 'is_active', 'priority', 'mailbox_sequence', 'checkpoint_revision', 'index_revision', 'stage_request_id', 'projection_state', 'scope_hash', 'projection_hash', 'eligible_ids_hash', 'next_action', 'visible_since', 'updated_at'],
  workspace_migration_state: ['workspace_id', 'migration_epoch', 'status', 'manifest_hash', 'schema_epoch', 'cutover_epoch', 'owner_runtime_epoch', 'fence_token_hash', 'checkpoint_seq', 'before_hash', 'after_hash', 'started_at_utc', 'started_at_mono', 'finished_at_utc', 'finished_at_mono', 'failure_reason'],
  workspace_rollback_state: ['workspace_id', 'rollback_epoch', 'source_migration_epoch', 'target_build_manifest_hash', 'target_schema_epoch', 'target_min_supported_build', 'target_cutover_epoch', 'status', 'started_at_utc', 'started_at_mono', 'barrier_receipt_hash'],
  workspace_migration_journal: ['workspace_id', 'migration_epoch', 'step_seq', 'step_key', 'input_hash', 'before_hash', 'after_hash', 'row_count', 'winner_set_hash', 'status', 'committed_at_utc', 'committed_at_mono'],
  producer_registry: ['workspace_id', 'producer_id', 'build_id', 'source_location', 'trigger', 'trigger_id', 'allowed_intent_kind', 'owner', 'replacement_route', 'write_tables', 'write_principal', 'authorizer_revision', 'process_image_path', 'resources_path', 'registry_entry_hash', 'enabled', 'census_hash'],
  build_manifests: ['build_id', 'source_commit', 'package_hash', 'app_asar_hash', 'schema_epoch', 'cutover_epoch', 'read_schema_min', 'read_schema_max', 'write_schema_epoch', 'manifest_hash', 'resources_path'],
  acceptance_runs: ['acceptance_run_id', 'workspace_id', 'build_id', 'acceptance_namespace', 'baseline_event_sequence', 'baseline_checkpoint_revision', 'baseline_table_hashes', 'baseline_counts', 'baseline_data_root_hash', 'fresh_after_mono']
};

const STATUS_VALUES = {
  workspace_orchestrator_actors: { actor_status: 'active', write_fence: 'allow' },
  orchestrator_mailbox: { state: 'enqueued', coalescing_mode: 'none' },
  command_receipts: { terminal_status: 'received' },
  orchestrator_intents: { status: 'received', source: 'today_ui', root_mode: 'owner', requested_action: 'full' },
  channel_preflight_snapshots: { status: 'frozen', source: 'today_ui' },
  daily_orchestration_roots: { status: 'created', source: 'today_ui', root_mode: 'owner' },
  daily_stage_claims: { claim_kind: 'daily', status: 'running', root_mode: 'owner', attempt_stage: 'scan' },
  source_snapshots: { status: 'frozen' },
  daily_repair_snapshot_bindings: { binding_kind: 'repaired' },
  daily_plan_scopes: { binding_kind: 'initial_source', scope_status: 'building', attempt_stage: 'scan' },
  managed_job_dispatches: { state: 'reserved' },
  managed_effect_consumptions: { state: 'reserved', delivery_mode: 'exactly_once' },
  daily_reconcile_gates: { status: 'pending' },
  workspace_migration_state: { status: 'running', write_fence: 'deny' },
  workspace_rollback_state: { status: 'requested' },
  workspace_migration_journal: { status: 'committed' },
  workspace_active_root_index: { status: 'created', source: 'today_ui', root_mode: 'owner', projection_state: 'absent' },
  producer_registry: { owner: 'workspace_orchestrator', write_principal: 'wmb_actor_store', enabled: 1 },
  orchestrator_outbox: { status: 'pending' }
};

function withTempDir(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5366-'));
  try { return work(directory); } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableInfo(database, table) {
  return database.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all();
}

function tableColumns(database, table) {
  return new Set(tableInfo(database, table).map(({ name }) => name));
}

function q(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function rowValue(table, column, info, overrides) {
  if (Object.hasOwn(overrides, column)) return overrides[column];
  const lower = column.toLowerCase();
  const tableStatus = STATUS_VALUES[table] ?? {};
  if (Object.hasOwn(tableStatus, column)) return tableStatus[column];
  if (lower === 'workspace_id') return 'ws-5366';
  if (lower === 'claim_id') return 'claim-5366';
  if (lower === 'root_id') return 'root-5366';
  if (lower === 'root_request_id') return 'root-request-5366';
  if (lower === 'intent_id') return 'intent-5366';
  if (lower === 'preflight_id') return 'preflight-5366';
  if (lower === 'stage_request_id') return 'stage-5366';
  if (lower === 'request_id') return 'request-5366';
  if (lower === 'orchestration_id') return 'orchestration-5366';
  if (lower === 'manager_task_id') return 'manager-5366';
  if (lower === 'registry_name') return 'command-replay/v1';
  if (lower === 'registry_version' || lower.endsWith('_schema_version') || lower.endsWith('_version')) return 1;
  if (lower.includes('hash')) return HEX;
  if (lower.includes('json')) return '{}';
  if (lower.endsWith('_bytes')) return '{}';
  if (lower.endsWith('_at_utc') || lower.endsWith('_at')) return NOW;
  if (lower.endsWith('_mono') || lower.endsWith('_epoch') || lower.endsWith('_revision') || lower.endsWith('_ordinal') || lower.endsWith('_sequence') || lower.endsWith('_count') || lower === 'priority' || lower === 'attempt' || lower === 'pid') return 1;
  if (lower === 'is_active' || lower === 'enabled') return 1;
  if (info.type?.toUpperCase().includes('INT')) return 1;
  if (info.type?.toUpperCase().includes('BLOB')) return Buffer.from('{}');
  if (lower === 'actor_status') return 'active';
  if (lower === 'root_mode') return 'owner';
  if (lower === 'source') return 'today_ui';
  if (lower === 'claim_kind') return 'daily';
  if (lower === 'attempt_stage') return 'scan';
  if (lower === 'binding_kind') return 'initial_source';
  if (lower === 'coalescing_mode') return 'none';
  if (lower === 'delivery_mode') return 'exactly_once';
  if (lower === 'write_fence') return 'allow';
  if (lower === 'projection_state') return 'absent';
  if (lower === 'terminal_status') return 'received';
  if (lower === 'status') return STATUS_VALUES[table]?.status ?? 'pending';
  if (lower === 'state') return STATUS_VALUES[table]?.state ?? 'reserved';
  if (lower === 'reason' || lower.endsWith('_reason') || lower.endsWith('_code')) return 'test';
  if (lower === 'preimage_bytes') return '{}';
  if (lower === 'derived_value') return 'derived-5366';
  if (lower === 'event_type') return 'test.event';
  if (lower === 'event_id' || lower === 'outbox_id' || lower === 'message_id' || lower === 'consumer_id' || lower === 'snapshot_id' || lower === 'scope_id' || lower === 'job_id' || lower === 'consumption_id' || lower === 'repair_snapshot_id' || lower === 'acceptance_run_id' || lower === 'migration_epoch' || lower === 'rollback_epoch') return `${table}-${column}-5366`;
  if (info.notnull || info.pk) return `test-${table}-${column}`;
  return undefined;
}

function insertDynamic(database, table, overrides = {}) {
  const infos = tableInfo(database, table);
  const columns = [];
  const values = [];
  for (const info of infos) {
    if (info.hidden) continue;
    const value = rowValue(table, info.name, info, overrides);
    if (value === undefined && !info.notnull && !info.pk) continue;
    columns.push(info.name);
    values.push(value === undefined ? null : value);
  }
  const placeholders = columns.map(() => '?').join(',');
  database.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(',')}) VALUES (${placeholders})`).run(...values);
  return database.prepare(`SELECT * FROM ${q(table)} WHERE rowid = last_insert_rowid()`).get() ?? database.prepare(`SELECT * FROM ${q(table)} ORDER BY rowid DESC LIMIT 1`).get();
}

function insertWithRow(database, table, row, overrides = {}) {
  const infos = tableInfo(database, table).filter((info) => !info.hidden);
  const columns = infos.map(({ name }) => name);
  const values = columns.map((column) => Object.hasOwn(overrides, column) ? overrides[column] : row[column]);
  database.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
}

function applyMigrationsThrough(databasePath, maximumVersion) {
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
  for (const migration of migrations.filter(({ version }) => version <= maximumVersion)) {
    if (applied.has(migration.version)) continue;
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      migration.run?.(database);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, NOW);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      database.close();
      throw error;
    }
    database.exec('PRAGMA foreign_keys = ON');
  }
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function createLegacyDailyStageClaims(database) {
  if (tableExists(database, 'daily_stage_claims')) return;
  database.exec(`
    CREATE TABLE daily_stage_claims (
      claim_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      claim_kind TEXT NOT NULL,
      cycle_id TEXT,
      gap_id TEXT,
      claim_scope_key TEXT NOT NULL,
      stage_request_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      root_request_id TEXT,
      root_generation INTEGER NOT NULL,
      root_input_hash TEXT,
      manager_task_id TEXT,
      orchestration_id TEXT,
      parent_task_id TEXT,
      parent_stage_request_id TEXT,
      root_mode TEXT NOT NULL,
      attempt_stage TEXT NOT NULL,
      retry_generation INTEGER NOT NULL,
      logical_input_hash TEXT,
      status TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      claim_revision INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at TEXT,
      acceptance_scenario_id TEXT,
      barrier_id TEXT,
      runner_epoch INTEGER,
      snapshot_json TEXT,
      child_ids_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )
  `);
}

function seedLegacyClaim(database) {
  createLegacyDailyStageClaims(database);
  database.prepare(`INSERT INTO daily_stage_claims (
    claim_id, workspace_id, claim_kind, claim_scope_key, stage_request_id, request_id,
    root_generation, root_mode, attempt_stage, retry_generation, status, is_active,
    claim_revision, owner_epoch, snapshot_json, child_ids_json, result_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-claim-5366', 'ws-5366', 'daily', 'daily:ws-5366:manager:orchestration:scan', 'legacy-stage-5366', 'legacy-request-5366', 0, 'owner', 'scan', 0, 'running', 1, 1, 1, '{}', '[]', '{}', NOW, NOW);
  return database.prepare("SELECT * FROM daily_stage_claims WHERE claim_id='legacy-claim-5366'").get();
}

function indexDefinitions(database, table) {
  return database.prepare(`PRAGMA index_list(${q(table)})`).all().map((index) => ({
    ...index,
    columns: database.prepare(`PRAGMA index_info(${q(index.name)})`).all().sort((a, b) => a.seqno - b.seqno).map(({ name }) => name)
  }));
}

function assertIndex(database, table, expectedColumns, { unique = true, partial = undefined } = {}) {
  const match = indexDefinitions(database, table).find((index) => index.unique === (unique ? 1 : 0)
    && (partial === undefined || index.partial === (partial ? 1 : 0))
    && index.columns.length === expectedColumns.length
    && index.columns.every((column, position) => column === expectedColumns[position]));
  assert.ok(match, `${table} missing ${unique ? 'unique ' : ''}${expectedColumns.join(',')} index`);
}

function foreignKeys(database, table) {
  return database.prepare(`PRAGMA foreign_key_list(${q(table)})`).all();
}

function assertForeignKey(database, table, targetTable) {
  const matches = foreignKeys(database, table).filter((key) => key.table === targetTable);
  assert.ok(matches.length > 0, `${table} must reference ${targetTable}`);
  for (const key of matches) assert.equal(String(key.on_delete).toUpperCase(), 'RESTRICT', `${table} -> ${targetTable} must be ON DELETE RESTRICT`);
}

function claimAfterUpgrade(database) {
  return database.prepare("SELECT * FROM daily_stage_claims WHERE claim_id='legacy-claim-5366'").get();
}

function cloneClaim(database, overrides = {}) {
  const original = claimAfterUpgrade(database);
  const suffix = overrides.claim_id ?? `claim-${Math.random().toString(16).slice(2)}`;
  return { ...original, ...overrides, claim_id: suffix };
}

function insertClaimClone(database, overrides = {}) {
  const row = cloneClaim(database, overrides);
  insertWithRow(database, 'daily_stage_claims', row);
  return row;
}

function actor(database, workspaceId = 'ws-5366') {
  database.prepare(`INSERT OR IGNORE INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('build-5366', 'source-5366', HEX, HEX_B, ORCHESTRATOR_VERSION, 0,
      ORCHESTRATOR_VERSION, ORCHESTRATOR_VERSION, ORCHESTRATOR_VERSION, 'manifest-5366', 'resources-5366', NOW);
  return insertDynamic(database, 'workspace_orchestrator_actors', {
    workspace_id: workspaceId,
    actor_status: 'active',
    runtime_epoch: 1,
    owner_epoch: 1,
    authority_revision: 1,
    lease_token: `lease-${workspaceId}`,
    lease_expires_at_utc: NOW,
    lease_expires_at_mono: 100,
    control_stall_deadline_utc: NOW,
    control_stall_deadline_mono: 100,
    gate_deadline_utc: NOW,
    gate_deadline_mono: 100,
    invocation_ordinal: 0,
    mailbox_sequence: 0,
    checkpoint_revision: 0,
    migration_epoch: 1,
    write_fence: 'allow',
    current_build_id: 'build-5366'
  });
}

test('WMB-5366 fresh v79 inventory exposes durable orchestrator schema and contract indexes', () => withTempDir((directory) => {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    assert.ok(workspaceOrchestratorMigrations.some(({ version }) => version === ORCHESTRATOR_VERSION));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=?').get(ORCHESTRATOR_VERSION).count, 1);
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => name));
    for (const table of REQUIRED_TABLES) assert.ok(tables.has(table), `missing ${table}`);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const actual = tableColumns(database, table);
      for (const column of columns) assert.ok(actual.has(column), `${table} missing ${column}`);
    }

    assertIndex(database, 'orchestrator_intents', ['workspace_id', 'request_id']);
    assertIndex(database, 'orchestrator_intents', ['workspace_id', 'invocation_id']);
    assertIndex(database, 'daily_orchestration_roots', ['workspace_id', 'root_request_id']);
    assertIndex(database, 'daily_orchestration_roots', ['workspace_id', 'orchestration_id']);
    assertIndex(database, 'daily_orchestration_roots', ['workspace_id', 'business_date', 'root_mode', 'source', 'root_generation']);
    assertIndex(database, 'daily_stage_claims', ['workspace_id', 'stage_request_id']);
    assertIndex(database, 'daily_stage_claims', ['workspace_id', 'claim_scope_key'], { partial: true });
    assertIndex(database, 'daily_plan_scopes', ['workspace_id', 'stage_request_id']);
    assertIndex(database, 'managed_job_dispatches', ['workspace_id', 'child_identity_key']);
    assertIndex(database, 'managed_effect_consumptions', ['workspace_id', 'operation_request_id', 'effect_request_id']);
    assertIndex(database, 'orchestrator_outbox', ['workspace_id', 'aggregate_id', 'aggregate_revision', 'event_type', 'event_ordinal']);
    assertIndex(database, 'orchestrator_inbox', ['consumer_id', 'aggregate_id', 'aggregate_revision', 'event_type', 'event_ordinal']);
    assertIndex(database, 'workspace_rollback_state', ['workspace_id'], { partial: true });

    for (const table of REQUIRED_TABLES) {
      for (const key of foreignKeys(database, table)) assert.equal(String(key.on_delete).toUpperCase(), 'RESTRICT', `${table} FK ${key.table} must not cascade`);
    }
    assertForeignKey(database, 'identity_hash_registry', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'orchestrator_mailbox', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'orchestrator_mailbox', 'orchestrator_intents');
    assertForeignKey(database, 'daily_stage_claims', 'daily_orchestration_roots');
    assertForeignKey(database, 'daily_plan_scopes', 'daily_stage_claims');
    assertForeignKey(database, 'managed_job_dispatches', 'daily_stage_claims');
    assertForeignKey(database, 'managed_effect_consumptions', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'orchestrator_events', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'orchestrator_outbox', 'orchestrator_events');
    assertForeignKey(database, 'orchestrator_inbox', 'orchestrator_outbox');
    assertForeignKey(database, 'daily_reconcile_gates', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'workspace_migration_state', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'workspace_rollback_state', 'workspace_orchestrator_actors');
    assertForeignKey(database, 'workspace_migration_journal', 'workspace_migration_state');
    assertForeignKey(database, 'producer_registry', 'workspace_migration_state');
    assertForeignKey(database, 'acceptance_runs', 'workspace_orchestrator_actors');
  } finally { database.close(); }
}));

test('WMB-5366 v77 predecessor upgrades through v79 without losing daily_stage_claims columns or row', () => withTempDir((directory) => {
  const dbPath = path.join(directory, 'wmb.db');
  const predecessor = applyMigrationsThrough(dbPath, 77);
  const legacy = seedLegacyClaim(predecessor);
  const legacyColumns = tableInfo(predecessor, 'daily_stage_claims').map(({ name }) => name);
  predecessor.close();

  const upgraded = migrateDatabase(dbPath);
  try {
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=?').get(ORCHESTRATOR_VERSION).count, 1);
    const upgradedColumns = tableColumns(upgraded, 'daily_stage_claims');
    for (const column of legacyColumns) assert.ok(upgradedColumns.has(column), `legacy column ${column} was dropped`);
    const preserved = claimAfterUpgrade(upgraded);
    assert.ok(preserved, 'legacy daily_stage_claims row disappeared');
    for (const column of legacyColumns) assert.deepEqual(preserved[column], legacy[column], `legacy ${column} changed`);
    assert.ok(upgradedColumns.has('lease_expires_at_utc'), 'new UTC lease column missing after rebuild');
    assert.ok(upgradedColumns.has('lease_expires_at_mono'), 'new monotonic lease column missing after rebuild');
    assert.ok(upgradedColumns.has('stage_deadline_utc'), 'new stage deadline column missing after rebuild');
    assert.ok(upgradedColumns.has('control_stall_deadline_mono'), 'new control stall column missing after rebuild');
  } finally { upgraded.close(); }
}));

test('WMB-5366 duplicate, partial-active, enum, non-negative, and terminal consistency checks reject bad SQLite writes', () => withTempDir((directory) => {
  const dbPath = path.join(directory, 'wmb.db');
  const predecessor = applyMigrationsThrough(dbPath, 77);
  seedLegacyClaim(predecessor);
  predecessor.close();
  const database = migrateDatabase(dbPath);
  try {
    const active = claimAfterUpgrade(database);
    assert.ok(active && active.is_active === 1, 'compatibility row must remain active');

    assert.throws(() => insertClaimClone(database, {
      claim_id: 'duplicate-scope-5366', stage_request_id: 'different-stage-5366', request_id: 'different-request-5366'
    }), /UNIQUE|constraint/i, 'active claim scope must be partial-unique');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'duplicate-stage-5366', stage_request_id: active.stage_request_id, request_id: 'different-request-2-5366', claim_scope_key: 'different-scope-5366'
    }), /UNIQUE|constraint/i, 'stage_request_id must be unique within a workspace');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'bad-enum-5366', claim_scope_key: 'bad-enum-scope', stage_request_id: 'bad-enum-stage', request_id: 'bad-enum-request', status: 'not-a-stage-status'
    }), /CHECK|constraint/i, 'unknown stage status must be rejected');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'negative-revision-5366', claim_scope_key: 'negative-revision-scope', stage_request_id: 'negative-revision-stage', request_id: 'negative-revision-request', claim_revision: -1
    }), /CHECK|constraint/i, 'negative claim revision must be rejected');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'negative-generation-5366', claim_scope_key: 'negative-generation-scope', stage_request_id: 'negative-generation-stage', request_id: 'negative-generation-request', root_generation: -1
    }), /CHECK|constraint/i, 'negative root generation must be rejected');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'terminal-without-finished-5366', claim_scope_key: 'terminal-without-finished-scope', stage_request_id: 'terminal-without-finished-stage', request_id: 'terminal-without-finished-request', status: 'succeeded', is_active: 0, finished_at: null
    }), /CHECK|constraint/i, 'terminal claim must have finished_at');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'active-with-finished-5366', claim_scope_key: 'active-with-finished-scope', stage_request_id: 'active-with-finished-stage', request_id: 'active-with-finished-request', status: 'running', is_active: 1, finished_at: NOW
    }), /CHECK|constraint/i, 'non-terminal claim cannot have finished_at');
    assert.throws(() => insertClaimClone(database, {
      claim_id: 'partial-acceptance-5366', claim_scope_key: 'partial-acceptance-scope', stage_request_id: 'partial-acceptance-stage', request_id: 'partial-acceptance-request', acceptance_run_id: 'acceptance-5366', baseline_event_sequence: null, baseline_checkpoint_revision: null, created_after_event_sequence: null, created_after_checkpoint_revision: null, created_after_mono: null
    }), /CHECK|constraint/i, 'acceptance baseline must be all-or-none');
  } finally { database.close(); }
}));

test('WMB-5366 identity registry enforces duplicate/FK/append-only contracts and migration is idempotent', () => withTempDir((directory) => {
  const dbPath = path.join(directory, 'wmb.db');
  let database = migrateDatabase(dbPath);
  try {
    actor(database, 'ws-registry-5366');
    const registry = insertDynamic(database, 'identity_hash_registry', {
      workspace_id: 'ws-registry-5366',
      registry_name: 'command-replay/v1',
      registry_version: 1,
      preimage_schema_version: 1,
      preimage_hash: HEX,
      canonical_bytes_hash: HEX,
      preimage_bytes: '{}',
      derived_value: 'derived-registry-5366',
      created_at: NOW
    });
    assert.ok(registry);
    assert.throws(() => insertDynamic(database, 'identity_hash_registry', {
      workspace_id: 'ws-registry-5366', registry_name: 'command-replay/v1', registry_version: 1,
      preimage_schema_version: 1, preimage_hash: HEX_B, canonical_bytes_hash: HEX_B,
      preimage_bytes: '{}', derived_value: 'derived-registry-5366', created_at: NOW
    }), /UNIQUE|constraint/i, 'derived value duplicate must be rejected');
    assert.throws(() => insertDynamic(database, 'identity_hash_registry', {
      workspace_id: 'missing-actor-5366', registry_name: 'command-replay/v1', registry_version: 1,
      preimage_schema_version: 1, preimage_hash: 'c'.repeat(64), canonical_bytes_hash: 'c'.repeat(64),
      preimage_bytes: '{}', derived_value: 'derived-missing-actor-5366', created_at: NOW
    }), /FOREIGN KEY|constraint/i, 'registry workspace must reference an actor');
    assert.throws(() => database.prepare("UPDATE identity_hash_registry SET derived_value='changed' WHERE workspace_id='ws-registry-5366'").run(), /IDENTITY|IMMUTABLE|constraint/i, 'identity registry is append-only');
    assert.throws(() => database.prepare("DELETE FROM identity_hash_registry WHERE workspace_id='ws-registry-5366'").run(), /IDENTITY|IMMUTABLE|constraint/i, 'identity registry rows cannot be deleted');
  } finally {
    const before = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
    database.close();
    database = migrateDatabase(dbPath);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, before, 'reopening must not apply migrations twice');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM identity_hash_registry').get().count, 1, 'reopening must not duplicate registry rows');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type=\'table\' AND name=\'daily_stage_claims\'').get().count, 1);
    } finally { database.close(); }
  }
}));
