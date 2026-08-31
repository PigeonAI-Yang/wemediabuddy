import type { DatabaseSync } from 'node:sqlite';

const ACCEPTANCE_COLUMNS = `
  acceptance_run_id TEXT,
  baseline_event_sequence INTEGER,
  baseline_checkpoint_revision INTEGER,
  created_after_event_sequence INTEGER,
  created_after_checkpoint_revision INTEGER,
  created_after_mono INTEGER`;

const ACCEPTANCE_CHECK = `CHECK (
  (acceptance_run_id IS NULL AND baseline_event_sequence IS NULL AND baseline_checkpoint_revision IS NULL
    AND created_after_event_sequence IS NULL AND created_after_checkpoint_revision IS NULL AND created_after_mono IS NULL)
  OR
  (acceptance_run_id IS NOT NULL AND baseline_event_sequence IS NOT NULL AND baseline_checkpoint_revision IS NOT NULL
    AND created_after_event_sequence IS NOT NULL AND created_after_checkpoint_revision IS NOT NULL AND created_after_mono IS NOT NULL)
)`;

const DAILY_STAGE_CLAIMS_SQL = `
CREATE TABLE daily_stage_claims (
  claim_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  claim_kind TEXT NOT NULL CHECK (claim_kind IN ('daily','stage_d','research')),
  cycle_id TEXT,
  gap_id TEXT,
  claim_scope_key TEXT NOT NULL,
  stage_request_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  root_request_id TEXT,
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  root_input_hash TEXT,
  manager_task_id TEXT,
  orchestration_id TEXT,
  parent_task_id TEXT,
  parent_stage_request_id TEXT,
  root_mode TEXT NOT NULL CHECK (root_mode IN ('owner','scheduler')),
  attempt_stage TEXT NOT NULL CHECK (attempt_stage IN ('scan','full','judge','stage_d','research')),
  retry_generation INTEGER NOT NULL CHECK (retry_generation >= 0 AND retry_generation <= 2),
  logical_input_hash TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'claimed_unbound','claimed','dispatching_scan','snapshot_frozen','awaiting_judge','dispatching_judge',
    'manifest_frozen','dispatching','settling','running','succeeded','skipped','partial','failed','needs_user','cancelled','orphaned'
  )),
  is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
  claim_revision INTEGER NOT NULL CHECK (claim_revision >= 0),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token TEXT,
  lease_expires_at TEXT,
  lease_expires_at_utc TEXT,
  lease_expires_at_mono INTEGER,
  stage_deadline_utc TEXT,
  stage_deadline_mono INTEGER,
  control_stall_deadline_utc TEXT,
  control_stall_deadline_mono INTEGER,
  acceptance_scenario_id TEXT,
  barrier_id TEXT,
  runner_epoch INTEGER,
  snapshot_json TEXT,
  child_ids_json TEXT,
  result_json TEXT,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (workspace_id, root_request_id) REFERENCES daily_orchestration_roots(workspace_id, root_request_id) ON DELETE RESTRICT,
  CHECK ((lease_expires_at_utc IS NULL) = (lease_expires_at_mono IS NULL)),
  CHECK ((stage_deadline_utc IS NULL) = (stage_deadline_mono IS NULL)),
  CHECK ((control_stall_deadline_utc IS NULL) = (control_stall_deadline_mono IS NULL)),
  CHECK (
    (status IN ('succeeded','skipped','partial','failed','needs_user','cancelled','orphaned') AND is_active=0 AND finished_at IS NOT NULL)
    OR
    (status NOT IN ('succeeded','skipped','partial','failed','needs_user','cancelled','orphaned') AND is_active=1 AND finished_at IS NULL)
  ),
  ${ACCEPTANCE_CHECK}
)`;

function rebuildDailyStageClaims(database: DatabaseSync): void {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_stage_claims'").get();
  if (!exists) {
    database.exec(DAILY_STAGE_CLAIMS_SQL);
    return;
  }
  const columns = new Set((database.prepare('PRAGMA table_info(daily_stage_claims)').all() as { name: string }[]).map(({ name }) => name));
  if (columns.has('lease_expires_at_utc') && columns.has('control_stall_deadline_mono')) return;
  database.exec('ALTER TABLE daily_stage_claims RENAME TO daily_stage_claims_v78');
  database.exec(DAILY_STAGE_CLAIMS_SQL);
  const targetColumns = (database.prepare('PRAGMA table_info(daily_stage_claims)').all() as { name: string }[]).map(({ name }) => name);
  const shared = targetColumns.filter((name) => columns.has(name));
  database.exec(`INSERT INTO daily_stage_claims (${shared.map((name) => `"${name}"`).join(',')}) SELECT ${shared.map((name) => `"${name}"`).join(',')} FROM daily_stage_claims_v78`);
  database.exec('DROP TABLE daily_stage_claims_v78');
}

function extendCommandReceipts(database: DatabaseSync): void {
  const existing = new Set((database.prepare('PRAGMA table_info(command_receipts)').all() as { name: string }[]).map(({ name }) => name));
  const additions: readonly [string, string][] = [
    ['command_replay_key', 'TEXT'], ['logical_input_hash', 'TEXT'], ['execution_envelope_json', 'TEXT'],
    ['response_json', 'TEXT'], ['response_hash', 'TEXT'], ['terminal_status', 'TEXT'], ['conflict_json', 'TEXT'],
    ['intent_id', 'TEXT'], ['acceptance_run_id', 'TEXT'], ['baseline_event_sequence', 'INTEGER'],
    ['baseline_checkpoint_revision', 'INTEGER'], ['created_after_event_sequence', 'INTEGER'],
    ['created_after_checkpoint_revision', 'INTEGER'], ['created_after_mono', 'INTEGER']
  ];
  for (const [name, type] of additions) {
    if (!existing.has(name)) database.exec(`ALTER TABLE command_receipts ADD COLUMN ${name} ${type}`);
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS command_receipts_replay_key ON command_receipts(workspace_id, command_replay_key) WHERE command_replay_key IS NOT NULL');
}

export const workspaceOrchestratorMigrations = [
  {
    version: 79,
    sql: `
CREATE TABLE build_manifests (
  build_id TEXT PRIMARY KEY,
  source_commit TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  app_asar_hash TEXT NOT NULL,
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch >= 1),
  cutover_epoch INTEGER NOT NULL CHECK (cutover_epoch >= 0),
  read_schema_min INTEGER NOT NULL CHECK (read_schema_min >= 1),
  read_schema_max INTEGER NOT NULL CHECK (read_schema_max >= read_schema_min),
  write_schema_epoch INTEGER NOT NULL CHECK (write_schema_epoch >= 1),
  manifest_hash TEXT NOT NULL UNIQUE,
  resources_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE workspace_orchestrator_actors (
  workspace_id TEXT PRIMARY KEY,
  actor_status TEXT NOT NULL CHECK (actor_status IN ('active','stopping','failed')),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 1),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  lease_token TEXT,
  lease_expires_at_utc TEXT,
  lease_expires_at_mono INTEGER,
  control_stall_deadline_utc TEXT,
  control_stall_deadline_mono INTEGER,
  gate_deadline_utc TEXT,
  gate_deadline_mono INTEGER,
  invocation_ordinal INTEGER NOT NULL CHECK (invocation_ordinal >= 0),
  mailbox_sequence INTEGER NOT NULL CHECK (mailbox_sequence >= 0),
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 0),
  migration_epoch INTEGER NOT NULL CHECK (migration_epoch >= 0),
  write_fence TEXT NOT NULL CHECK (write_fence IN ('allow','deny','maintenance')),
  current_build_id TEXT NOT NULL,
  last_business_progress_at TEXT,
  acceptance_run_id TEXT,
  baseline_event_sequence INTEGER,
  baseline_checkpoint_revision INTEGER,
  created_after_event_sequence INTEGER,
  created_after_checkpoint_revision INTEGER,
  created_after_mono INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (current_build_id) REFERENCES build_manifests(build_id) ON DELETE RESTRICT,
  CHECK ((lease_expires_at_utc IS NULL) = (lease_expires_at_mono IS NULL)),
  CHECK ((control_stall_deadline_utc IS NULL) = (control_stall_deadline_mono IS NULL)),
  CHECK ((gate_deadline_utc IS NULL) = (gate_deadline_mono IS NULL)),
  CHECK ((actor_status IN ('active','stopping') AND lease_token IS NOT NULL) OR (actor_status='failed')),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE identity_hash_registry (
  workspace_id TEXT NOT NULL,
  registry_name TEXT NOT NULL,
  registry_version INTEGER NOT NULL CHECK (registry_version >= 1),
  preimage_schema_version INTEGER NOT NULL CHECK (preimage_schema_version >= 1),
  preimage_hash TEXT NOT NULL CHECK (length(preimage_hash)=64),
  canonical_bytes_hash TEXT NOT NULL CHECK (length(canonical_bytes_hash)=64),
  preimage_bytes BLOB NOT NULL,
  derived_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, registry_name, registry_version, preimage_hash),
  UNIQUE (workspace_id, registry_name, registry_version, derived_value),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT
);

CREATE TABLE orchestrator_intents (
  intent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('today_ui','proposal_ui','mcp','scheduler_0900','rolling_scan','content_cycle','orphan_reconcile')),
  root_mode TEXT NOT NULL CHECK (root_mode IN ('owner','scheduler')),
  requested_action TEXT NOT NULL CHECK (requested_action IN ('full','scan','judge','stage_d','approve_candidates','repair_required_channel','configure_optional_channels','select_channel','repair_invalid_candidate','cancel_root','start_new_intent')),
  request_id TEXT NOT NULL,
  command_replay_key TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  invocation_ordinal INTEGER NOT NULL CHECK (invocation_ordinal >= 0),
  causation_id TEXT NOT NULL,
  producer_id TEXT,
  producer_registry_entry_hash TEXT,
  producer_census_hash TEXT,
  trigger_id TEXT,
  producer_attestation_hash TEXT,
  logical_input_hash TEXT NOT NULL,
  normalized_policy_hash TEXT NOT NULL,
  predecessor_intent_id TEXT,
  channel_policy_json TEXT NOT NULL,
  preflight_id TEXT,
  root_request_id TEXT,
  orchestration_id TEXT,
  next_action_json TEXT,
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('received','preflight_pending','preflight_running','waiting_resource','admitted','running','waiting_owner','succeeded','partial','failed','needs_user','cancelled')),
  preflight_deadline_utc TEXT,
  preflight_deadline_mono INTEGER,
  budget_json TEXT,
  coverage_gap_json TEXT,
  stop_reason_json TEXT,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id, request_id),
  UNIQUE (workspace_id, invocation_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (predecessor_intent_id) REFERENCES orchestrator_intents(intent_id) ON DELETE RESTRICT,
  CHECK ((preflight_deadline_utc IS NULL) = (preflight_deadline_mono IS NULL)),
  CHECK ((status IN ('succeeded','partial','failed','needs_user','cancelled')) = (finished_at IS NOT NULL)),
  CHECK (status!='needs_user' OR next_action_json IS NOT NULL),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE orchestrator_mailbox (
  workspace_id TEXT NOT NULL,
  mailbox_sequence INTEGER NOT NULL CHECK (mailbox_sequence >= 1),
  command_replay_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority >= 0),
  enqueued_at_utc TEXT NOT NULL,
  enqueued_at_mono INTEGER NOT NULL CHECK (enqueued_at_mono >= 0),
  expires_at_utc TEXT NOT NULL,
  expires_at_mono INTEGER NOT NULL CHECK (expires_at_mono >= 0),
  coalescing_key TEXT,
  coalescing_mode TEXT NOT NULL CHECK (coalescing_mode IN ('none','equivalent_scheduler_work')),
  causation_id TEXT NOT NULL,
  logical_input_hash TEXT NOT NULL,
  normalized_policy_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('enqueued','claimed','succeeded','partial','failed','needs_user','cancelled','expired','rejected')),
  claimed_actor_epoch INTEGER,
  claimed_at_utc TEXT,
  claimed_at_mono INTEGER,
  finished_at_utc TEXT,
  finished_at_mono INTEGER,
  ${ACCEPTANCE_COLUMNS},
  PRIMARY KEY (workspace_id, mailbox_sequence),
  UNIQUE (workspace_id, command_replay_key),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES orchestrator_intents(intent_id) ON DELETE RESTRICT,
  CHECK (expires_at_mono >= enqueued_at_mono),
  CHECK ((finished_at_utc IS NULL) = (finished_at_mono IS NULL)),
  CHECK ((state IN ('succeeded','partial','failed','needs_user','cancelled','expired','rejected')) = (finished_at_utc IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);
CREATE UNIQUE INDEX orchestrator_mailbox_active_coalescing ON orchestrator_mailbox(workspace_id,coalescing_key,logical_input_hash,normalized_policy_hash)
  WHERE coalescing_mode='equivalent_scheduler_work' AND state IN ('enqueued','claimed');

CREATE TABLE channel_preflight_snapshots (
  preflight_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('today_ui','proposal_ui','mcp','scheduler_0900','rolling_scan','content_cycle','orphan_reconcile')),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  policy_hash TEXT NOT NULL,
  preflight_version INTEGER NOT NULL CHECK (preflight_version >= 1),
  selected_channels_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  ready_channel_ids_json TEXT NOT NULL,
  excluded_optional_channel_ids_json TEXT NOT NULL,
  required_failures_json TEXT NOT NULL,
  coverage_gap_json TEXT NOT NULL,
  aggregate_deadline_utc TEXT,
  aggregate_deadline_mono INTEGER,
  preflight_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('frozen','failed','needs_user')),
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  UNIQUE (workspace_id,intent_id,preflight_version),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES orchestrator_intents(intent_id) ON DELETE RESTRICT,
  CHECK ((aggregate_deadline_utc IS NULL) = (aggregate_deadline_mono IS NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE daily_orchestration_roots (
  root_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  intent_id TEXT,
  preflight_id TEXT,
  business_date TEXT NOT NULL,
  root_mode TEXT NOT NULL CHECK (root_mode IN ('owner','scheduler')),
  source TEXT NOT NULL CHECK (source IN ('today_ui','proposal_ui','mcp','scheduler_0900','rolling_scan','content_cycle','orphan_reconcile')),
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  root_request_id TEXT NOT NULL,
  root_input_hash TEXT NOT NULL,
  orchestration_id TEXT NOT NULL,
  manager_task_id TEXT NOT NULL,
  retry_invocation_ordinal INTEGER NOT NULL CHECK (retry_invocation_ordinal >= 0),
  predecessor_root_id TEXT,
  supersedes_manager_task_id TEXT,
  supersedes_orchestration_id TEXT,
  supersedes_stage_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created','running','waiting_owner','succeeded','partial','failed','needs_user','cancelled')),
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 0),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token TEXT NOT NULL,
  lease_expires_at_utc TEXT NOT NULL,
  lease_expires_at_mono INTEGER NOT NULL,
  root_deadline_utc TEXT NOT NULL,
  root_deadline_mono INTEGER NOT NULL,
  gate_deadline_utc TEXT NOT NULL,
  gate_deadline_mono INTEGER NOT NULL,
  last_business_progress_at TEXT,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id,root_request_id),
  UNIQUE (workspace_id,orchestration_id),
  UNIQUE (workspace_id,business_date,root_mode,source,root_generation),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES orchestrator_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (preflight_id) REFERENCES channel_preflight_snapshots(preflight_id) ON DELETE RESTRICT,
  FOREIGN KEY (predecessor_root_id) REFERENCES daily_orchestration_roots(root_id) ON DELETE RESTRICT,
  CHECK ((status IN ('succeeded','partial','failed','needs_user','cancelled')) = (finished_at IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE IF NOT EXISTS daily_stage_claims_placeholder (id INTEGER PRIMARY KEY);

CREATE TABLE source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  source_task_id TEXT,
  root_request_id TEXT NOT NULL,
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  stage_request_id TEXT NOT NULL,
  scan_attempt_id TEXT NOT NULL,
  preflight_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  selected_channel_ids_json TEXT NOT NULL,
  successful_channels_json TEXT NOT NULL,
  failed_channels_json TEXT NOT NULL,
  unresolved_channels_json TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  source_bindings_json TEXT NOT NULL,
  receipt_ids_json TEXT NOT NULL,
  receipt_bindings_json TEXT NOT NULL,
  watermark_utc TEXT NOT NULL,
  watermark_mono INTEGER NOT NULL,
  captured_at_utc TEXT NOT NULL,
  excluded_by_budget_count INTEGER NOT NULL CHECK (excluded_by_budget_count >= 0),
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('frozen','stale','superseded')),
  ${ACCEPTANCE_COLUMNS},
  UNIQUE (workspace_id,stage_request_id),
  UNIQUE (workspace_id,snapshot_hash),
  FOREIGN KEY (workspace_id,root_request_id) REFERENCES daily_orchestration_roots(workspace_id,root_request_id) ON DELETE RESTRICT,
  FOREIGN KEY (preflight_id) REFERENCES channel_preflight_snapshots(preflight_id) ON DELETE RESTRICT,
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE daily_repair_snapshot_bindings (
  repair_snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  predecessor_scope_id TEXT NOT NULL,
  predecessor_source_snapshot_id TEXT NOT NULL,
  predecessor_stage_request_id TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind='repaired'),
  prior_item_revision INTEGER NOT NULL CHECK (prior_item_revision >= 1),
  prior_item_content_hash TEXT NOT NULL,
  repaired_item_revision INTEGER NOT NULL CHECK (repaired_item_revision >= prior_item_revision),
  repaired_item_content_hash TEXT NOT NULL,
  repair_snapshot_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  child_hashes_json TEXT NOT NULL,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id,binding_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (predecessor_source_snapshot_id) REFERENCES source_snapshots(snapshot_id) ON DELETE RESTRICT,
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE daily_plan_scopes (
  scope_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stage_request_id TEXT NOT NULL,
  root_request_id TEXT NOT NULL,
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  root_input_hash TEXT NOT NULL,
  manager_task_id TEXT NOT NULL,
  orchestration_id TEXT NOT NULL,
  attempt_stage TEXT NOT NULL CHECK (attempt_stage IN ('scan','full','judge','stage_d','research')),
  claim_revision INTEGER NOT NULL CHECK (claim_revision >= 0),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token TEXT NOT NULL,
  lease_expires_at_utc TEXT NOT NULL,
  lease_expires_at_mono INTEGER NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('initial_source','repaired')),
  repair_snapshot_id TEXT,
  repair_snapshot_hash TEXT,
  binding_hash TEXT,
  allowed_plan_ids_json TEXT NOT NULL,
  allowed_plan_item_ids_json TEXT NOT NULL,
  carry_plan_item_ids_json TEXT NOT NULL,
  trusted_receipt_ids_json TEXT NOT NULL,
  scope_status TEXT NOT NULL CHECK (scope_status IN ('building','frozen','failed','cancelled','superseded')),
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_at TEXT,
  finished_at TEXT,
  UNIQUE (workspace_id,stage_request_id),
  UNIQUE (workspace_id,scope_hash),
  FOREIGN KEY (workspace_id,stage_request_id) REFERENCES daily_stage_claims(workspace_id,stage_request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,root_request_id) REFERENCES daily_orchestration_roots(workspace_id,root_request_id) ON DELETE RESTRICT,
  FOREIGN KEY (repair_snapshot_id) REFERENCES daily_repair_snapshot_bindings(repair_snapshot_id) ON DELETE RESTRICT,
  CHECK ((binding_kind='initial_source' AND repair_snapshot_id IS NULL AND repair_snapshot_hash IS NULL AND binding_hash IS NULL)
    OR (binding_kind='repaired' AND repair_snapshot_id IS NOT NULL AND repair_snapshot_hash IS NOT NULL AND binding_hash IS NOT NULL)),
  CHECK ((scope_status IN ('frozen','failed','cancelled','superseded')) = (finished_at IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE managed_job_dispatches (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  child_identity_key TEXT NOT NULL,
  child_ordinal INTEGER NOT NULL CHECK (child_ordinal >= 1),
  role_id TEXT NOT NULL,
  operation_request_id TEXT NOT NULL,
  effect_request_id TEXT,
  effect_logical_key TEXT,
  manager_task_id TEXT NOT NULL,
  orchestration_id TEXT NOT NULL,
  parent_task_id TEXT NOT NULL,
  parent_stage_request_id TEXT NOT NULL,
  root_request_id TEXT NOT NULL,
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  root_input_hash TEXT NOT NULL,
  preflight_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  stage_request_id TEXT NOT NULL,
  retry_generation INTEGER NOT NULL CHECK (retry_generation >= 0 AND retry_generation <= 2),
  expected_parent_claim_revision INTEGER NOT NULL CHECK (expected_parent_claim_revision >= 0),
  expected_parent_owner_epoch INTEGER NOT NULL CHECK (expected_parent_owner_epoch >= 1),
  expected_parent_lease_token TEXT NOT NULL,
  launch_attempt_id TEXT NOT NULL,
  launch_token_hash TEXT NOT NULL,
  process_handle TEXT,
  pid INTEGER,
  process_start_time_utc TEXT,
  process_start_time_mono INTEGER,
  argv_hash TEXT NOT NULL,
  cwd_fingerprint TEXT NOT NULL,
  session_key TEXT NOT NULL,
  spawn_deadline_utc TEXT NOT NULL,
  spawn_deadline_mono INTEGER NOT NULL,
  register_at TEXT,
  stdout_drain_watermark INTEGER NOT NULL DEFAULT 0 CHECK (stdout_drain_watermark >= 0),
  stderr_drain_watermark INTEGER NOT NULL DEFAULT 0 CHECK (stderr_drain_watermark >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running','terminal','cancelled','orphaned')),
  result_status TEXT,
  result_hash TEXT,
  envelope_json TEXT NOT NULL,
  result_json TEXT,
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token TEXT NOT NULL,
  lease_expires_at_utc TEXT NOT NULL,
  lease_expires_at_mono INTEGER NOT NULL,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id,child_identity_key),
  UNIQUE (workspace_id,launch_attempt_id),
  FOREIGN KEY (workspace_id,stage_request_id) REFERENCES daily_stage_claims(workspace_id,stage_request_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,root_request_id) REFERENCES daily_orchestration_roots(workspace_id,root_request_id) ON DELETE RESTRICT,
  CHECK ((state IN ('terminal','cancelled','orphaned')) = (finished_at IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE managed_effect_consumptions (
  consumption_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation_request_id TEXT NOT NULL,
  effect_request_id TEXT NOT NULL,
  effect_logical_key TEXT NOT NULL,
  effect_set_hash TEXT NOT NULL,
  effect_token TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  manager_task_id TEXT NOT NULL,
  orchestration_id TEXT NOT NULL,
  root_request_id TEXT NOT NULL,
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  stage_request_id TEXT NOT NULL,
  source_dispatch_job_id TEXT NOT NULL,
  source_result_hash TEXT NOT NULL,
  role_id TEXT NOT NULL,
  sink_name TEXT NOT NULL,
  sink_role_id TEXT NOT NULL,
  sink_contract_version TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('exactly_once','at_most_once','at_least_once')),
  sink_capability_proof_hash TEXT NOT NULL,
  compensation_request_key TEXT,
  compensation_result_hash TEXT,
  outcome_query_key TEXT,
  outcome_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','consuming','unknown','consumed','failed','cancelled','orphaned')),
  consumption_revision INTEGER NOT NULL CHECK (consumption_revision >= 0),
  expected_stage_claim_revision INTEGER NOT NULL CHECK (expected_stage_claim_revision >= 0),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token TEXT NOT NULL,
  lease_expires_at_utc TEXT NOT NULL,
  lease_expires_at_mono INTEGER NOT NULL,
  unknown_since TEXT,
  error_json TEXT,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id,operation_request_id,effect_request_id),
  UNIQUE (workspace_id,effect_token),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_dispatch_job_id) REFERENCES managed_job_dispatches(job_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,stage_request_id) REFERENCES daily_stage_claims(workspace_id,stage_request_id) ON DELETE RESTRICT,
  CHECK (state!='consumed' OR outcome_hash IS NOT NULL),
  CHECK (state!='unknown' OR outcome_query_key IS NOT NULL),
  CHECK ((state IN ('consumed','failed','cancelled','orphaned')) = (finished_at IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE orchestrator_events (
  workspace_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 1),
  business_date TEXT,
  source TEXT,
  intent_id TEXT,
  invocation_id TEXT,
  root_request_id TEXT,
  root_generation INTEGER,
  orchestration_id TEXT,
  manager_task_id TEXT,
  stage_request_id TEXT,
  request_id TEXT,
  operation_request_id TEXT,
  parent_task_id TEXT,
  job_id TEXT,
  causation_id TEXT NOT NULL,
  actor_epoch INTEGER NOT NULL CHECK (actor_epoch >= 1),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token_fingerprint TEXT NOT NULL,
  claim_revision INTEGER,
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 0),
  snapshot_hash TEXT,
  scope_hash TEXT,
  projection_hash TEXT,
  producer_id TEXT,
  registry_entry_hash TEXT,
  census_hash TEXT,
  trigger_id TEXT,
  payload_json TEXT NOT NULL,
  ${ACCEPTANCE_COLUMNS},
  occurred_at_utc TEXT NOT NULL,
  PRIMARY KEY (workspace_id,event_sequence),
  UNIQUE (workspace_id,causation_id,event_type,event_ordinal),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE orchestrator_outbox (
  outbox_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
  event_type TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 1),
  causation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_bytes BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivering','delivered','failed')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  lease TEXT,
  ${ACCEPTANCE_COLUMNS},
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (workspace_id,aggregate_id,aggregate_revision,event_type,event_ordinal),
  FOREIGN KEY (workspace_id,event_sequence) REFERENCES orchestrator_events(workspace_id,event_sequence) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  CHECK ((status='delivered') = (delivered_at IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE orchestrator_inbox (
  consumer_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
  event_type TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 1),
  processed_result_hash TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  processed_at TEXT NOT NULL,
  ${ACCEPTANCE_COLUMNS},
  PRIMARY KEY (consumer_id,message_id),
  UNIQUE (consumer_id,aggregate_id,aggregate_revision,event_type,event_ordinal),
  FOREIGN KEY (outbox_id) REFERENCES orchestrator_outbox(outbox_id) ON DELETE RESTRICT,
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE daily_reconcile_gates (
  workspace_id TEXT NOT NULL,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 1),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  lease_token TEXT NOT NULL,
  lease_expires_at_utc TEXT NOT NULL,
  lease_expires_at_mono INTEGER NOT NULL,
  gate_deadline_utc TEXT NOT NULL,
  gate_deadline_mono INTEGER NOT NULL,
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending','running','complete','maintenance','failed')),
  reason TEXT,
  finished_at_utc TEXT,
  finished_at_mono INTEGER,
  ${ACCEPTANCE_COLUMNS},
  PRIMARY KEY (workspace_id,runtime_epoch),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  CHECK ((finished_at_utc IS NULL) = (finished_at_mono IS NULL)),
  CHECK ((status IN ('complete','maintenance','failed')) = (finished_at_utc IS NOT NULL)),
  ${ACCEPTANCE_CHECK}
);

CREATE TABLE workspace_active_root_index (
  workspace_id TEXT NOT NULL,
  root_request_id TEXT NOT NULL,
  orchestration_id TEXT NOT NULL,
  manager_task_id TEXT NOT NULL,
  root_generation INTEGER NOT NULL CHECK (root_generation >= 0),
  source TEXT NOT NULL,
  root_mode TEXT NOT NULL CHECK (root_mode IN ('owner','scheduler')),
  status TEXT NOT NULL CHECK (status IN ('created','running','waiting_owner','succeeded','partial','failed','needs_user','cancelled')),
  terminal_reason TEXT,
  is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
  priority INTEGER NOT NULL CHECK (priority >= 0),
  mailbox_sequence INTEGER NOT NULL CHECK (mailbox_sequence >= 1),
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 0),
  index_revision INTEGER NOT NULL CHECK (index_revision >= 0),
  stage_request_id TEXT,
  projection_state TEXT NOT NULL CHECK (projection_state IN ('absent','not_applicable','frozen')),
  scope_hash TEXT,
  projection_hash TEXT,
  eligible_ids_hash TEXT,
  next_action TEXT,
  visible_since TEXT NOT NULL,
  ${ACCEPTANCE_COLUMNS},
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,root_request_id),
  FOREIGN KEY (workspace_id,root_request_id) REFERENCES daily_orchestration_roots(workspace_id,root_request_id) ON DELETE RESTRICT,
  CHECK ((projection_state='frozen' AND scope_hash IS NOT NULL AND projection_hash IS NOT NULL AND eligible_ids_hash IS NOT NULL)
    OR (projection_state!='frozen' AND scope_hash IS NULL AND projection_hash IS NULL AND eligible_ids_hash IS NULL)),
  ${ACCEPTANCE_CHECK}
);
CREATE INDEX workspace_active_root_priority ON workspace_active_root_index(workspace_id,is_active,priority,mailbox_sequence,root_generation);

CREATE TABLE workspace_migration_state (
  workspace_id TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL CHECK (migration_epoch >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending','running','complete','failed','maintenance')),
  manifest_hash TEXT NOT NULL,
  schema_epoch INTEGER NOT NULL CHECK (schema_epoch >= 1),
  cutover_epoch INTEGER NOT NULL CHECK (cutover_epoch >= 0),
  owner_runtime_epoch INTEGER NOT NULL CHECK (owner_runtime_epoch >= 1),
  fence_token_hash TEXT NOT NULL,
  write_fence TEXT NOT NULL DEFAULT 'deny' CHECK (write_fence IN ('deny','maintenance','allow')),
  checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq >= 0),
  before_hash TEXT NOT NULL,
  after_hash TEXT,
  started_at_utc TEXT NOT NULL,
  started_at_mono INTEGER NOT NULL,
  finished_at_utc TEXT,
  finished_at_mono INTEGER,
  failure_reason TEXT,
  PRIMARY KEY (workspace_id,migration_epoch),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  CHECK ((finished_at_utc IS NULL) = (finished_at_mono IS NULL)),
  CHECK ((status IN ('complete','failed','maintenance')) = (finished_at_utc IS NOT NULL))
);

CREATE TABLE workspace_rollback_state (
  workspace_id TEXT NOT NULL,
  rollback_epoch INTEGER NOT NULL CHECK (rollback_epoch >= 1),
  source_migration_epoch INTEGER NOT NULL,
  target_build_manifest_hash TEXT NOT NULL,
  target_schema_epoch INTEGER NOT NULL CHECK (target_schema_epoch >= 1),
  target_min_supported_build TEXT NOT NULL,
  target_cutover_epoch INTEGER NOT NULL CHECK (target_cutover_epoch >= 0),
  status TEXT NOT NULL CHECK (status IN ('requested','fencing','draining','verifying','complete','maintenance','rollback_required')),
  started_at_utc TEXT NOT NULL,
  started_at_mono INTEGER NOT NULL,
  barrier_receipt_hash TEXT NOT NULL,
  reason TEXT,
  finished_at_utc TEXT,
  finished_at_mono INTEGER,
  PRIMARY KEY (workspace_id,rollback_epoch),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,source_migration_epoch) REFERENCES workspace_migration_state(workspace_id,migration_epoch) ON DELETE RESTRICT,
  CHECK ((finished_at_utc IS NULL) = (finished_at_mono IS NULL)),
  CHECK ((status IN ('complete','maintenance','rollback_required')) = (finished_at_utc IS NOT NULL))
);
CREATE UNIQUE INDEX workspace_rollback_current ON workspace_rollback_state(workspace_id)
  WHERE status IN ('requested','fencing','draining','verifying');

CREATE TABLE workspace_migration_journal (
  workspace_id TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL,
  step_seq INTEGER NOT NULL CHECK (step_seq >= 1),
  step_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  winner_set_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed','failed')),
  committed_at_utc TEXT NOT NULL,
  committed_at_mono INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,migration_epoch,step_seq),
  UNIQUE (workspace_id,migration_epoch,step_key),
  FOREIGN KEY (workspace_id,migration_epoch) REFERENCES workspace_migration_state(workspace_id,migration_epoch) ON DELETE RESTRICT
);

CREATE TABLE producer_registry (
  workspace_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL,
  source_location TEXT NOT NULL,
  trigger TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  allowed_intent_kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  replacement_route TEXT NOT NULL,
  write_tables TEXT NOT NULL,
  write_principal TEXT NOT NULL,
  authorizer_revision TEXT NOT NULL,
  process_image_path TEXT NOT NULL,
  resources_path TEXT NOT NULL,
  registry_entry_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  census_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,producer_id,build_id),
  UNIQUE (workspace_id,producer_id,census_hash),
  UNIQUE (workspace_id,producer_id,build_id,registry_entry_hash),
  FOREIGN KEY (workspace_id,migration_epoch) REFERENCES workspace_migration_state(workspace_id,migration_epoch) ON DELETE RESTRICT,
  FOREIGN KEY (build_id) REFERENCES build_manifests(build_id) ON DELETE RESTRICT
);

CREATE TABLE acceptance_runs (
  acceptance_run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  acceptance_namespace TEXT NOT NULL,
  baseline_event_sequence INTEGER NOT NULL CHECK (baseline_event_sequence >= 0),
  baseline_checkpoint_revision INTEGER NOT NULL CHECK (baseline_checkpoint_revision >= 0),
  baseline_table_hashes TEXT NOT NULL,
  baseline_counts TEXT NOT NULL,
  baseline_data_root_hash TEXT NOT NULL,
  fresh_after_mono INTEGER NOT NULL CHECK (fresh_after_mono >= 0),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id,acceptance_run_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (build_id) REFERENCES build_manifests(build_id) ON DELETE RESTRICT,
  CHECK ((status IN ('passed','failed')) = (finished_at IS NOT NULL))
);

CREATE TRIGGER identity_hash_registry_no_update BEFORE UPDATE ON identity_hash_registry BEGIN SELECT RAISE(ABORT,'IDENTITY_REGISTRY_IMMUTABLE'); END;
CREATE TRIGGER identity_hash_registry_no_delete BEFORE DELETE ON identity_hash_registry BEGIN SELECT RAISE(ABORT,'IDENTITY_REGISTRY_IMMUTABLE'); END;
CREATE TRIGGER source_snapshots_no_update BEFORE UPDATE ON source_snapshots BEGIN SELECT RAISE(ABORT,'SOURCE_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER source_snapshots_no_delete BEFORE DELETE ON source_snapshots BEGIN SELECT RAISE(ABORT,'SOURCE_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER orchestrator_events_no_update BEFORE UPDATE ON orchestrator_events BEGIN SELECT RAISE(ABORT,'ORCHESTRATOR_EVENT_IMMUTABLE'); END;
CREATE TRIGGER orchestrator_events_no_delete BEFORE DELETE ON orchestrator_events BEGIN SELECT RAISE(ABORT,'ORCHESTRATOR_EVENT_IMMUTABLE'); END;
    `,
    run(database: DatabaseSync): void {
      rebuildDailyStageClaims(database);
      database.exec('DROP TABLE daily_stage_claims_placeholder');
      database.exec('CREATE UNIQUE INDEX daily_stage_claims_stage_request ON daily_stage_claims(workspace_id,stage_request_id)');
      database.exec("CREATE UNIQUE INDEX daily_stage_claims_active_scope ON daily_stage_claims(workspace_id,claim_scope_key) WHERE is_active=1");
      extendCommandReceipts(database);
    }
  },
  {
    version: 80,
    sql: `
CREATE TABLE workspace_legacy_runtime_inventory (
  inventory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 1),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('process','session','browser','mcp','scheduler','worker','xhs','other')),
  resource_key TEXT NOT NULL,
  root_request_id TEXT,
  stage_request_id TEXT,
  operation_request_id TEXT,
  job_id TEXT,
  pid INTEGER,
  parent_pid INTEGER,
  process_start_time_utc TEXT,
  process_start_time_mono INTEGER,
  argv_json TEXT NOT NULL,
  argv_hash TEXT NOT NULL,
  session_key TEXT NOT NULL,
  browser_profile_id TEXT,
  browser_cdp_port INTEGER,
  mcp_endpoint TEXT,
  launch_attempt_id TEXT NOT NULL,
  lease_id TEXT,
  lease_token TEXT NOT NULL,
  lease_expires_at_utc TEXT,
  lease_expires_at_mono INTEGER,
  cwd TEXT NOT NULL,
  stdout_watermark INTEGER NOT NULL DEFAULT 0 CHECK (stdout_watermark >= 0),
  stderr_watermark INTEGER NOT NULL DEFAULT 0 CHECK (stderr_watermark >= 0),
  state TEXT NOT NULL CHECK (state IN ('registered','running','draining','exited','closed','cleaned','authorization_rejected','orphaned')),
  exit_code INTEGER,
  exit_signal TEXT,
  exit_at_utc TEXT,
  close_at_utc TEXT,
  cleanup_at_utc TEXT,
  authorization_rejected_at_utc TEXT,
  authorization_reject_reason TEXT,
  close_proof_hash TEXT,
  cleanup_proof_hash TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id, launch_attempt_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  CHECK ((lease_expires_at_utc IS NULL) = (lease_expires_at_mono IS NULL)),
  CHECK ((state IN ('exited','closed','cleaned','authorization_rejected','orphaned')) = (finished_at IS NOT NULL))
);
CREATE INDEX workspace_legacy_runtime_inventory_resource
  ON workspace_legacy_runtime_inventory(workspace_id, resource_kind, resource_key);
CREATE INDEX workspace_legacy_runtime_inventory_process
  ON workspace_legacy_runtime_inventory(workspace_id, pid, process_start_time_utc, process_start_time_mono);
CREATE INDEX workspace_legacy_runtime_inventory_session
  ON workspace_legacy_runtime_inventory(workspace_id, session_key);
CREATE INDEX workspace_legacy_runtime_inventory_state
  ON workspace_legacy_runtime_inventory(workspace_id, state, owner_epoch);
CREATE INDEX workspace_migration_journal_status
  ON workspace_migration_journal(workspace_id, migration_epoch, status, step_seq);
CREATE TRIGGER workspace_legacy_runtime_inventory_identity_no_update
BEFORE UPDATE ON workspace_legacy_runtime_inventory
WHEN OLD.inventory_id != NEW.inventory_id
  OR OLD.workspace_id != NEW.workspace_id
  OR OLD.runtime_epoch != NEW.runtime_epoch
  OR OLD.owner_epoch != NEW.owner_epoch
  OR OLD.resource_kind != NEW.resource_kind
  OR OLD.resource_key != NEW.resource_key
  OR COALESCE(OLD.root_request_id, '') != COALESCE(NEW.root_request_id, '')
  OR COALESCE(OLD.stage_request_id, '') != COALESCE(NEW.stage_request_id, '')
  OR COALESCE(OLD.operation_request_id, '') != COALESCE(NEW.operation_request_id, '')
  OR COALESCE(OLD.job_id, '') != COALESCE(NEW.job_id, '')
  OR COALESCE(OLD.pid, -1) != COALESCE(NEW.pid, -1)
  OR COALESCE(OLD.parent_pid, -1) != COALESCE(NEW.parent_pid, -1)
  OR COALESCE(OLD.process_start_time_utc, '') != COALESCE(NEW.process_start_time_utc, '')
  OR COALESCE(OLD.process_start_time_mono, -1) != COALESCE(NEW.process_start_time_mono, -1)
  OR OLD.argv_json != NEW.argv_json
  OR OLD.argv_hash != NEW.argv_hash
  OR OLD.session_key != NEW.session_key
  OR COALESCE(OLD.browser_profile_id, '') != COALESCE(NEW.browser_profile_id, '')
  OR COALESCE(OLD.browser_cdp_port, -1) != COALESCE(NEW.browser_cdp_port, -1)
  OR COALESCE(OLD.mcp_endpoint, '') != COALESCE(NEW.mcp_endpoint, '')
  OR OLD.launch_attempt_id != NEW.launch_attempt_id
  OR COALESCE(OLD.lease_id, '') != COALESCE(NEW.lease_id, '')
  OR OLD.lease_token != NEW.lease_token
  OR OLD.cwd != NEW.cwd
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_RUNTIME_INVENTORY_IDENTITY_IMMUTABLE');
END;
CREATE TRIGGER workspace_migration_journal_no_update
BEFORE UPDATE ON workspace_migration_journal BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_MIGRATION_JOURNAL_IMMUTABLE');
END;
CREATE TRIGGER workspace_migration_journal_no_delete
BEFORE DELETE ON workspace_migration_journal BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_MIGRATION_JOURNAL_IMMUTABLE');
END;
CREATE TRIGGER workspace_migration_complete_no_update
BEFORE UPDATE ON workspace_migration_state
WHEN OLD.status IN ('complete','failed','maintenance')
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_MIGRATION_TERMINAL_IMMUTABLE');
END;
CREATE TRIGGER workspace_rollback_terminal_no_update
BEFORE UPDATE ON workspace_rollback_state
WHEN OLD.status IN ('complete','maintenance','rollback_required')
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_ROLLBACK_TERMINAL_IMMUTABLE');
END;
    `
  },
  {
    version: 81,
    sql: `
CREATE TABLE acceptance_runs_v81 (
  acceptance_run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL CHECK (length(trim(scenario_id)) > 0),
  scenario_input_hash TEXT NOT NULL CHECK (length(scenario_input_hash) = 64),
  build_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  acceptance_namespace TEXT NOT NULL CHECK (length(trim(acceptance_namespace)) > 0),
  started_at_utc TEXT NOT NULL,
  started_at_mono INTEGER NOT NULL CHECK (started_at_mono >= 0),
  baseline_event_sequence INTEGER NOT NULL CHECK (baseline_event_sequence >= 0),
  baseline_checkpoint_revision INTEGER NOT NULL CHECK (baseline_checkpoint_revision >= 0),
  baseline_table_hashes TEXT NOT NULL,
  baseline_counts TEXT NOT NULL,
  baseline_data_root_hash TEXT NOT NULL CHECK (length(baseline_data_root_hash) = 64),
  fresh_after_mono INTEGER NOT NULL CHECK (fresh_after_mono >= 0),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','not_executed')),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  evidence_pointer TEXT,
  created_at TEXT NOT NULL,
  finished_at_utc TEXT,
  finished_at_mono INTEGER CHECK (finished_at_mono IS NULL OR finished_at_mono >= 0),
  UNIQUE (workspace_id, acceptance_run_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace_orchestrator_actors(workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (build_id) REFERENCES build_manifests(build_id) ON DELETE RESTRICT,
  CHECK ((finished_at_utc IS NULL) = (finished_at_mono IS NULL)),
  CHECK (
    (status = 'running' AND finished_at_utc IS NULL AND result_hash IS NULL AND evidence_pointer IS NULL)
    OR
    (status IN ('passed','failed','not_executed') AND finished_at_utc IS NOT NULL AND result_hash IS NOT NULL AND evidence_pointer IS NOT NULL AND length(trim(evidence_pointer)) > 0)
  )
);

INSERT INTO acceptance_runs_v81 (
  acceptance_run_id, workspace_id, scenario_id, scenario_input_hash, build_id, manifest_hash,
  acceptance_namespace, started_at_utc, started_at_mono, baseline_event_sequence,
  baseline_checkpoint_revision, baseline_table_hashes, baseline_counts, baseline_data_root_hash,
  fresh_after_mono, status, result_hash, evidence_pointer, created_at, finished_at_utc, finished_at_mono
)
SELECT
  a.acceptance_run_id,
  a.workspace_id,
  'legacy:' || a.acceptance_run_id,
  lower(hex(zeroblob(32))),
  a.build_id,
  COALESCE((SELECT b.manifest_hash FROM build_manifests b WHERE b.build_id = a.build_id), lower(hex(zeroblob(32)))),
  a.acceptance_namespace,
  a.created_at,
  a.fresh_after_mono,
  a.baseline_event_sequence,
  a.baseline_checkpoint_revision,
  a.baseline_table_hashes,
  a.baseline_counts,
  a.baseline_data_root_hash,
  a.fresh_after_mono,
  CASE WHEN a.status = 'running' THEN 'running' ELSE a.status END,
  CASE WHEN a.status = 'running' THEN NULL ELSE lower(hex(zeroblob(32))) END,
  CASE WHEN a.status = 'running' THEN NULL ELSE 'legacy/acceptance_runs/v79/' || a.acceptance_run_id END,
  a.created_at,
  CASE WHEN a.status = 'running' THEN NULL ELSE COALESCE(a.finished_at, a.created_at) END,
  CASE WHEN a.status = 'running' THEN NULL ELSE a.fresh_after_mono END
FROM acceptance_runs a;

DROP TABLE acceptance_runs;
ALTER TABLE acceptance_runs_v81 RENAME TO acceptance_runs;
CREATE INDEX acceptance_runs_workspace_scenario
  ON acceptance_runs(workspace_id, scenario_id, started_at_mono);
CREATE INDEX acceptance_runs_workspace_namespace
  ON acceptance_runs(workspace_id, acceptance_namespace, started_at_mono);
CREATE UNIQUE INDEX acceptance_runs_result_identity
  ON acceptance_runs(workspace_id, acceptance_run_id, result_hash)
  WHERE result_hash IS NOT NULL;

CREATE TRIGGER acceptance_runs_identity_no_update
BEFORE UPDATE ON acceptance_runs
WHEN OLD.acceptance_run_id != NEW.acceptance_run_id
  OR OLD.workspace_id != NEW.workspace_id
  OR OLD.scenario_id != NEW.scenario_id
  OR OLD.scenario_input_hash != NEW.scenario_input_hash
  OR OLD.build_id != NEW.build_id
  OR OLD.manifest_hash != NEW.manifest_hash
  OR OLD.acceptance_namespace != NEW.acceptance_namespace
  OR OLD.started_at_utc != NEW.started_at_utc
  OR OLD.started_at_mono != NEW.started_at_mono
  OR OLD.baseline_event_sequence != NEW.baseline_event_sequence
  OR OLD.baseline_checkpoint_revision != NEW.baseline_checkpoint_revision
  OR OLD.baseline_table_hashes != NEW.baseline_table_hashes
  OR OLD.baseline_counts != NEW.baseline_counts
  OR OLD.baseline_data_root_hash != NEW.baseline_data_root_hash
  OR OLD.fresh_after_mono != NEW.fresh_after_mono
  OR OLD.created_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_RUN_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER acceptance_runs_terminal_no_update
BEFORE UPDATE ON acceptance_runs
WHEN OLD.status != 'running'
  AND (
    OLD.status != NEW.status
    OR COALESCE(OLD.result_hash, '') != COALESCE(NEW.result_hash, '')
    OR COALESCE(OLD.evidence_pointer, '') != COALESCE(NEW.evidence_pointer, '')
    OR COALESCE(OLD.finished_at_utc, '') != COALESCE(NEW.finished_at_utc, '')
    OR COALESCE(OLD.finished_at_mono, -1) != COALESCE(NEW.finished_at_mono, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_RUN_TERMINAL_IMMUTABLE');
END;

CREATE TRIGGER acceptance_runs_running_fields_no_update
BEFORE UPDATE ON acceptance_runs
WHEN OLD.status = 'running'
  AND NEW.status = 'running'
  AND (NEW.result_hash IS NOT NULL OR NEW.evidence_pointer IS NOT NULL OR NEW.finished_at_utc IS NOT NULL OR NEW.finished_at_mono IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_RUN_TERMINAL_REQUIRED');
END;

CREATE TRIGGER acceptance_runs_no_delete
BEFORE DELETE ON acceptance_runs
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTANCE_RUN_IMMUTABLE');
END;
    `
  }
 ] as const;
