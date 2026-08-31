import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalJsonV1,
  hashV1,
  readStartupReconcileGate,
  readWorkspaceOrchestratorActor,
  type StartupReconcileGate,
  type WorkspaceOrchestratorActor
} from './workspace-orchestrator-actor.ts';

/**
 * WMB-5369 read-only bridge for the Manager, Today and Proposals surfaces.
 *
 * The adapter deliberately reads the durable active-root index first.  It does
 * not select a root by date, recency, plan id, child count or business result.
 * A frozen row is useful only when its index, root, stage and PlanScope agree;
 * otherwise the row is returned as an explicit projection error and all
 * candidate sets are fail-closed to empty.
 */

export const MANAGER_TYPED_COMMANDS = [
  'approve_candidates',
  'repair_required_channel',
  'repair_invalid_candidate',
  'cancel_root',
  'configure_optional_channels',
  'select_channel',
  'start_new_intent'
] as const;

export type ManagerTypedCommandType = (typeof MANAGER_TYPED_COMMANDS)[number];

export type ManagerProjectionError = Readonly<{
  code: 'PROJECTION_MISSING' | 'PROJECTION_MISMATCH' | 'ROOT_MISSING' | 'STAGE_MISSING' | 'ACTOR_MISSING';
  message: string;
  fields: readonly string[];
}>;

export type ManagerAdapterIdentity = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  orchestrationId: string;
  managerTaskId: string;
  stageRequestId: string | null;
  scopeHash: string | null;
  projectionHash: string | null;
  eligibleIdsHash: string | null;
  checkpointRevision: number;
  indexRevision: number;
}>;

export type ManagerAdapterProjection = Readonly<{
  origin: Readonly<{ source: string; rootMode: string; businessDate: string }>;
  identity: ManagerAdapterIdentity;
  root: Readonly<Record<string, unknown>>;
  stage: Readonly<Record<string, unknown>> | null;
  manager: Readonly<Record<string, unknown>>;
  status: string;
  terminalReason: string | null;
  nextAction: unknown;
  projectionState: 'absent' | 'not_applicable' | 'frozen' | 'error';
  preflight: Readonly<Record<string, unknown>> | null;
  gate: StartupReconcileGate | null;
  budget: unknown;
  resources: Readonly<{
    summary: Readonly<Record<string, number>>;
    jobs: readonly Readonly<Record<string, unknown>>[];
  }>;
  termination: Readonly<Record<string, unknown>>;
  coverageGap: readonly unknown[];
  candidatePlanItemIds: readonly string[];
  eligiblePlanItemIds: readonly string[];
  pendingPlanItemIds: readonly string[];
  invalidPlanItemIds: readonly string[];
  emptyQualified: boolean;
  projectionHash: string | null;
  eligibleIdsHash: string | null;
  opportunityCount: number;
  projectionError: ManagerProjectionError | null;
}>;

export type ManagerAdapterReadModel = Readonly<{
  actor: WorkspaceOrchestratorActor | null;
  startupGate: StartupReconcileGate | null;
  roots: readonly ManagerAdapterProjection[];
  asOf: string;
}>;

export type ManagerTypedCommand = Readonly<{
  type: ManagerTypedCommandType;
  requestId: string;
  identity: ManagerAdapterIdentity;
  payload: Readonly<Record<string, unknown>>;
}>;

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

function parseJsonRecord(value: unknown): Row | null {
  const parsed = parseJson(value, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : null;
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function workspaceIdFromDatabase(database: DatabaseSync, requested?: string): string {
  if (requested && requested.trim()) return requested.trim();
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as Row | undefined;
    const value = stringValue(row?.value).trim();
    if (value) return value;
  } catch {
    // app_meta is optional in focused read-model fixtures
  }
  for (const table of ['workspace_active_root_index', 'workspace_orchestrator_actors']) {
    try {
      const row = database.prepare(`SELECT workspace_id FROM ${table} ORDER BY workspace_id LIMIT 1`).get() as Row | undefined;
      const value = stringValue(row?.workspace_id).trim();
      if (value) return value;
    } catch {
      // schema may not have been migrated yet
    }
  }
  return '';
}

function uniqueJson(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const value of values) if (!out.some((entry) => canonicalJsonV1(entry) === canonicalJsonV1(value))) out.push(value);
  return out;
}

function indexNextAction(row: Row): unknown {
  return parseJson(row.next_action, null);
}

function rootIdentity(index: Row): ManagerAdapterIdentity {
  return Object.freeze({
    workspaceId: stringValue(index.workspace_id),
    rootRequestId: stringValue(index.root_request_id),
    rootGeneration: numberValue(index.root_generation),
    orchestrationId: stringValue(index.orchestration_id),
    managerTaskId: stringValue(index.manager_task_id),
    stageRequestId: nullableString(index.stage_request_id),
    scopeHash: nullableString(index.scope_hash),
    projectionHash: nullableString(index.projection_hash),
    eligibleIdsHash: nullableString(index.eligible_ids_hash),
    checkpointRevision: numberValue(index.checkpoint_revision),
    indexRevision: numberValue(index.index_revision)
  });
}

function projectionError(
  code: ManagerProjectionError['code'],
  message: string,
  fields: readonly string[]
): ManagerProjectionError {
  return Object.freeze({ code, message, fields: Object.freeze([...fields]) });
}

function eligibleIdsHash(identity: ManagerAdapterIdentity, eligible: readonly string[]): string {
  return hashV1({
    r: 'eligible-ids/v1',
    workspaceId: identity.workspaceId,
    rootRequestId: identity.rootRequestId,
    stageRequestId: identity.stageRequestId,
    scopeHash: identity.scopeHash,
    projectionHash: identity.projectionHash,
    orderedEligiblePlanItemIds: eligible
  });
}

function recomputeScopeHash(scope: Row, scopeRow: Row): string {
  const { scopeHash: _scopeHash, ...scopeWithoutHash } = scope;
  return hashV1({
    r: 'plan-scope/v1',
    workspaceId: stringValue(scopeRow.workspace_id),
    stageRequestId: stringValue(scopeRow.stage_request_id),
    rootRequestId: stringValue(scopeRow.root_request_id),
    sourceSnapshotHash: stringValue(scopeRow.source_snapshot_hash),
    bindingHash: scope.bindingHash ?? null,
    orderedAllowedPlanIds: strings(scope.allowedPlanIds),
    orderedAllowedItemIds: strings(scope.allowedPlanItemIds),
    orderedCarryItemIds: strings(scope.carryPlanItemIds),
    trustedReceiptIds: strings(scope.trustedReceiptIds),
    scopeJson: scopeWithoutHash
  });
}

function recomputeProjectionHash(projection: Row, scope: Row): string {
  return hashV1({
    r: 'projection/v2',
    workspaceId: stringValue(projection.workspaceId),
    businessDate: stringValue(projection.businessDate),
    managerTaskId: stringValue(projection.managerTaskId),
    orchestrationId: stringValue(projection.orchestrationId),
    stageRequestId: stringValue(projection.stageRequestId),
    scopeHash: stringValue(projection.scopeHash),
    bindingHash: scope.bindingHash ?? null,
    repairSnapshotHash: scope.repairSnapshotHash ?? null,
    planIds: strings(projection.planIds),
    asOf: projection.asOf ?? null,
    orderedEntries: Array.isArray(projection.entries) ? projection.entries : [],
    candidatePlanItemIds: strings(projection.candidatePlanItemIds),
    eligiblePlanItemIds: strings(projection.eligiblePlanItemIds),
    pendingPlanItemIds: strings(projection.pendingPlanItemIds),
    invalidPlanItemIds: strings(projection.invalidPlanItemIds),
    trustedReceiptIds: strings(projection.trustedReceiptIds),
    emptyQualified: projection.emptyQualified === true
  });
}

function resourceReadback(database: DatabaseSync, workspaceId: string, rootRequestId: string): ManagerAdapterProjection['resources'] {
  if (!tableExists(database, 'managed_job_dispatches')) return Object.freeze({ summary: Object.freeze({}), jobs: Object.freeze([]) });
  const jobs = database.prepare(`SELECT * FROM managed_job_dispatches
    WHERE workspace_id=? AND root_request_id=? ORDER BY child_ordinal ASC, rowid ASC`).all(workspaceId, rootRequestId) as Row[];
  const summary: Record<string, number> = {};
  for (const job of jobs) {
    const state = stringValue(job.state, 'unknown');
    summary[state] = (summary[state] ?? 0) + 1;
    const role = stringValue(job.role_id, 'unknown');
    const roleKey = `${role}:${state}`;
    summary[roleKey] = (summary[roleKey] ?? 0) + 1;
  }
  return Object.freeze({ summary: Object.freeze(summary), jobs: Object.freeze(jobs.map((job) => Object.freeze({ ...job }))) });
}

function preflightReadback(database: DatabaseSync, root: Row, intent: Row | null): Row | null {
  const preflightId = nullableString(root.preflight_id) ?? nullableString(intent?.preflight_id);
  if (!preflightId || !tableExists(database, 'channel_preflight_snapshots')) return null;
  const row = database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?')
    .get(stringValue(root.workspace_id), preflightId) as Row | undefined;
  if (!row) return null;
  return Object.freeze({
    preflightId: stringValue(row.preflight_id),
    preflightHash: stringValue(row.preflight_hash),
    workspaceId: stringValue(row.workspace_id),
    intentId: stringValue(row.intent_id),
    businessDate: stringValue(row.business_date),
    source: stringValue(row.source),
    profileRevision: numberValue(row.profile_revision),
    policyHash: stringValue(row.policy_hash),
    preflightVersion: numberValue(row.preflight_version),
    selectedChannels: parseJsonArray(row.selected_channels_json),
    results: parseJsonArray(row.results_json),
    readyChannelIds: strings(parseJson(row.ready_channel_ids_json, [])),
    excludedOptionalChannelIds: strings(parseJson(row.excluded_optional_channel_ids_json, [])),
    requiredFailures: parseJsonArray(row.required_failures_json),
    coverageGap: parseJsonArray(row.coverage_gap_json),
    aggregateDeadlineUtc: nullableString(row.aggregate_deadline_utc),
    aggregateDeadlineMono: row.aggregate_deadline_mono === null ? null : numberValue(row.aggregate_deadline_mono),
    status: stringValue(row.status),
    createdAt: stringValue(row.created_at),
    finishedAt: stringValue(row.finished_at)
  });
}

function frozenProjection(database: DatabaseSync, index: Row, root: Row, stage: Row | null): {
  projectionState: ManagerAdapterProjection['projectionState'];
  candidate: string[];
  eligible: string[];
  pending: string[];
  invalid: string[];
  emptyQualified: boolean;
  projectionHash: string | null;
  eligibleIdsHash: string | null;
  coverageGap: unknown[];
  error: ManagerProjectionError | null;
} {
  const state = stringValue(index.projection_state) as ManagerAdapterProjection['projectionState'];
  if (state !== 'frozen') {
    const fields: string[] = [];
    if (state !== 'absent' && state !== 'not_applicable') fields.push('projectionState');
    // A stage request may already exist while its projection is absent, or for
    // Stage-D no-current-targets (not_applicable). Only the projection hashes
    // are forbidden outside the frozen state; rejecting stageRequestId here
    // would hide a legitimate pre-projection/skip state.
    if (nullableString(index.scope_hash)) fields.push('scopeHash');
    if (nullableString(index.projection_hash)) fields.push('projectionHash');
    if (nullableString(index.eligible_ids_hash)) fields.push('eligibleIdsHash');
    if (fields.length) {
      return {
        projectionState: 'error', candidate: [], eligible: [], pending: [], invalid: [], emptyQualified: false,
        projectionHash: null, eligibleIdsHash: null, coverageGap: [],
        error: projectionError('PROJECTION_MISMATCH', '非 frozen projection 携带了不一致的 stage/hash 状态，已 fail-closed。', fields)
      };
    }
    return {
      projectionState: state === 'not_applicable' ? 'not_applicable' : 'absent',
      candidate: [], eligible: [], pending: [], invalid: [], emptyQualified: false,
      projectionHash: null, eligibleIdsHash: null, coverageGap: [], error: null
    };
  }
  const errors: string[] = [];
  const stageRequestId = nullableString(index.stage_request_id);
  const scopeHash = nullableString(index.scope_hash);
  const projectionHash = nullableString(index.projection_hash);
  const indexedEligibleHash = nullableString(index.eligible_ids_hash);
  if (!stageRequestId) errors.push('stageRequestId');
  if (!scopeHash) errors.push('scopeHash');
  if (!projectionHash) errors.push('projectionHash');
  if (!indexedEligibleHash) errors.push('eligibleIdsHash');
  const scopeRow = stageRequestId && tableExists(database, 'daily_plan_scopes')
    ? database.prepare('SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?')
      .get(stringValue(index.workspace_id), stageRequestId) as Row | undefined ?? null
    : null;
  if (!stage || !scopeRow) {
    return {
      projectionState: 'error', candidate: [], eligible: [], pending: [], invalid: [], emptyQualified: false,
      projectionHash, eligibleIdsHash: indexedEligibleHash, coverageGap: [],
      error: projectionError('PROJECTION_MISSING', 'frozen projection 缺少对应 stage/PlanScope。', [
        ...(!stage ? ['stageRequestId'] : []), ...(!scopeRow ? ['scopeId', 'scopeHash'] : []), ...errors
      ])
    };
  }
  const stored = parseJsonRecord(scopeRow.scope_json);
  const scope = stored ? asRecord(stored.scope) : {};
  const projection = stored ? asRecord(stored.projection ?? parseJson(stage.result_json, null)) : {};
  const projectionCandidate = strings(projection.candidatePlanItemIds);
  const eligible = strings(projection.eligiblePlanItemIds);
  const pending = strings(projection.pendingPlanItemIds);
  const invalid = strings(projection.invalidPlanItemIds);
  const candidate = projectionCandidate;
  const owner = new Map<string, string>();
  for (const [kind, values] of [['eligible', eligible], ['pending', pending], ['invalid', invalid]] as const) {
    for (const id of values) {
      if (owner.has(id)) errors.push(`duplicate:${id}`);
      owner.set(id, kind);
    }
  }
  const union = [...owner.keys()].sort();
  if (canonicalJsonV1(union) !== canonicalJsonV1([...candidate].sort())) errors.push('candidateSet');
  const allowed = new Set(strings(scope.allowedPlanItemIds));
  for (const id of candidate) if (!allowed.has(id)) errors.push(`scope.allowedPlanItemIds:${id}`);
  const entries = Array.isArray(projection.entries) ? projection.entries : [];
  const entryIds = entries.map((entry) => stringValue(asRecord(entry).planItemId)).filter(Boolean).sort();
  if (canonicalJsonV1(entryIds) !== canonicalJsonV1([...candidate].sort())) errors.push('projectionEntries');
  if (projection.emptyQualified === true && candidate.length > 0) errors.push('emptyQualified');
  const identity = rootIdentity(index);
  if (stringValue(root.workspace_id) !== identity.workspaceId) errors.push('root.workspaceId');
  if (stringValue(root.root_request_id) !== identity.rootRequestId) errors.push('root.rootRequestId');
  if (numberValue(root.root_generation, -1) !== identity.rootGeneration) errors.push('root.rootGeneration');
  if (stringValue(root.orchestration_id) !== identity.orchestrationId) errors.push('root.orchestrationId');
  if (stringValue(root.manager_task_id) !== identity.managerTaskId) errors.push('root.managerTaskId');
  if (stringValue(scopeRow.workspace_id) !== identity.workspaceId) errors.push('scope.workspaceId');
  if (stringValue(scopeRow.root_request_id) !== identity.rootRequestId) errors.push('scope.rootRequestId');
  if (numberValue(scopeRow.root_generation, -1) !== identity.rootGeneration) errors.push('scope.rootGeneration');
  if (stringValue(scopeRow.stage_request_id) !== stageRequestId) errors.push('scope.stageRequestId');
  if (stringValue(scopeRow.root_input_hash) !== stringValue(root.root_input_hash)) errors.push('scope.rootInputHash');
  if (stringValue(scopeRow.manager_task_id) !== identity.managerTaskId) errors.push('scope.managerTaskId');
  if (stringValue(scopeRow.orchestration_id) !== identity.orchestrationId) errors.push('scope.orchestrationId');
  if (stringValue(scope.workspaceId) !== identity.workspaceId) errors.push('workspaceId');
  if (stringValue(scope.rootRequestId) !== identity.rootRequestId) errors.push('rootRequestId');
  if (numberValue(scope.rootGeneration, -1) !== identity.rootGeneration) errors.push('rootGeneration');
  if (stringValue(scope.stageRequestId) !== stageRequestId) errors.push('scopeJson.stageRequestId');
  if (stringValue(scope.rootInputHash) !== stringValue(root.root_input_hash)) errors.push('scopeJson.rootInputHash');
  if (stringValue(projection.workspaceId) !== identity.workspaceId) errors.push('projection.workspaceId');
  if (stringValue(projection.rootRequestId ?? identity.rootRequestId) !== identity.rootRequestId) errors.push('projection.rootRequestId');
  if (stringValue(projection.managerTaskId) !== identity.managerTaskId) errors.push('projection.managerTaskId');
  if (stringValue(projection.orchestrationId) !== identity.orchestrationId) errors.push('projection.orchestrationId');
  if (stringValue(projection.stageRequestId) !== stageRequestId) errors.push('projection.stageRequestId');
  if (stringValue(scope.scopeHash ?? scopeRow.scope_hash) !== scopeHash) errors.push('scopeHash');
  const derivedScopeHash = recomputeScopeHash(scope, scopeRow);
  if (derivedScopeHash !== scopeHash) errors.push('scopeHashPreimage');
  if (stringValue(projection.projectionHash) !== projectionHash) errors.push('projectionHash');
  const derivedProjectionHash = recomputeProjectionHash(projection, scope);
  if (derivedProjectionHash !== projectionHash) errors.push('projectionHashPreimage');
  const derivedEligibleHash = eligibleIdsHash(identity, eligible);
  if (derivedEligibleHash !== indexedEligibleHash) errors.push('eligibleIdsHash');
  if (scopeHash !== nullableString(scopeRow.scope_hash)) errors.push('scopeRow.scopeHash');
  if (stringValue(stage.workspace_id) !== identity.workspaceId) errors.push('stage.workspaceId');
  if (numberValue(stage.root_generation, -1) !== identity.rootGeneration) errors.push('stage.rootGeneration');
  if (stringValue(stage.root_request_id) !== identity.rootRequestId) errors.push('stage.rootRequestId');
  if (stringValue(stage.manager_task_id) !== identity.managerTaskId) errors.push('stage.managerTaskId');
  if (stringValue(stage.orchestration_id) !== identity.orchestrationId) errors.push('stage.orchestrationId');
  if (stringValue(stage.stage_request_id) !== stageRequestId) errors.push('stageRequestId');
  if (stringValue(scopeRow.scope_status) !== 'frozen') errors.push('scopeStatus');
  const coverageGap = [
    ...(Array.isArray(projection.coverageGap) ? projection.coverageGap : []),
    ...(parseJsonArray(root.coverage_gap_json))
  ];
  if (errors.length) {
    return {
      projectionState: 'error', candidate: [], eligible: [], pending: [], invalid: [], emptyQualified: false,
      projectionHash, eligibleIdsHash: indexedEligibleHash, coverageGap: uniqueJson(coverageGap),
      error: projectionError('PROJECTION_MISMATCH', 'frozen projection identity/hash/eligible set 不匹配，已 fail-closed。', errors)
    };
  }
  return {
    projectionState: 'frozen', candidate, eligible, pending, invalid,
    emptyQualified: projection.emptyQualified === true,
    projectionHash, eligibleIdsHash: indexedEligibleHash,
    coverageGap: uniqueJson(coverageGap), error: null
  };
}

function readOneRoot(database: DatabaseSync, index: Row, actor: WorkspaceOrchestratorActor | null): ManagerAdapterProjection {
  const identity = rootIdentity(index);
  const root = tableExists(database, 'daily_orchestration_roots')
    ? database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?')
      .get(identity.workspaceId, identity.rootRequestId) as Row | undefined
    : undefined;
  const rootRow = root ?? {};
  const intent = rootRow.intent_id && tableExists(database, 'orchestrator_intents')
    ? database.prepare('SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?')
      .get(identity.workspaceId, String(rootRow.intent_id)) as Row | undefined ?? null
    : null;
  const stage = identity.stageRequestId && tableExists(database, 'daily_stage_claims')
    ? database.prepare('SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?')
      .get(identity.workspaceId, identity.stageRequestId) as Row | undefined ?? null
    : null;
  const gate = actor ? readStartupReconcileGate(database, identity.workspaceId, actor.runtimeEpoch) : null;
  const projection = root
    ? frozenProjection(database, index, rootRow, stage)
    : {
        projectionState: 'error' as const, candidate: [], eligible: [], pending: [], invalid: [], emptyQualified: false,
        projectionHash: identity.projectionHash, eligibleIdsHash: identity.eligibleIdsHash, coverageGap: [],
        error: projectionError('ROOT_MISSING', 'active-root index 缺少对应 daily orchestration root。', ['rootRequestId'])
      };
  const preflight = root ? preflightReadback(database, rootRow, intent ?? null) : null;
  const coverageGap = uniqueJson([
    ...projection.coverageGap,
    ...parseJsonArray(intent?.coverage_gap_json),
    ...(preflight?.coverageGap as unknown[] ?? [])
  ]);
  const status = stringValue(index.status, stringValue(rootRow.status, 'unknown'));
  const terminalReason = nullableString(index.terminal_reason) ?? nullableString(rootRow.stop_reason_json);
  const stageRecord = stage ? Object.freeze({ ...stage }) : null;
  const rootRecord = Object.freeze({ ...rootRow });
  const managerRecord = Object.freeze({
    managerTaskId: identity.managerTaskId,
    checkpointRevision: identity.checkpointRevision,
    indexRevision: identity.indexRevision,
    intentId: nullableString(rootRow.intent_id),
    status: nullableString(intent?.status),
    nextAction: indexNextAction(index)
  });
  const termination = Object.freeze({
    status,
    terminalReason,
    rootFinishedAt: nullableString(rootRow.finished_at),
    stageFinishedAt: nullableString(stage?.finished_at),
    rootDeadlineUtc: nullableString(rootRow.root_deadline_utc),
    rootDeadlineMono: rootRow.root_deadline_mono === null ? null : numberValue(rootRow.root_deadline_mono),
    gateDeadlineUtc: nullableString(rootRow.gate_deadline_utc),
    gateDeadlineMono: rootRow.gate_deadline_mono === null ? null : numberValue(rootRow.gate_deadline_mono),
    stageDeadlineUtc: nullableString(stage?.stage_deadline_utc),
    stageDeadlineMono: stage?.stage_deadline_mono === null || stage?.stage_deadline_mono === undefined ? null : numberValue(stage.stage_deadline_mono)
  });
  return Object.freeze({
    origin: Object.freeze({ source: stringValue(index.source, stringValue(rootRow.source)), rootMode: stringValue(index.root_mode, stringValue(rootRow.root_mode)), businessDate: stringValue(rootRow.business_date) }),
    identity,
    root: rootRecord,
    stage: stageRecord,
    manager: managerRecord,
    status,
    terminalReason,
    nextAction: indexNextAction(index),
    projectionState: projection.projectionState,
    preflight,
    gate,
    budget: parseJson(intent?.budget_json, null),
    resources: resourceReadback(database, identity.workspaceId, identity.rootRequestId),
    termination,
    coverageGap: Object.freeze(coverageGap),
    candidatePlanItemIds: Object.freeze([...projection.candidate]),
    eligiblePlanItemIds: Object.freeze([...projection.eligible]),
    pendingPlanItemIds: Object.freeze([...projection.pending]),
    invalidPlanItemIds: Object.freeze([...projection.invalid]),
    emptyQualified: projection.emptyQualified,
    projectionHash: projection.projectionHash,
    eligibleIdsHash: projection.eligibleIdsHash,
    opportunityCount: projection.eligible.length,
    projectionError: projection.error
  });
}

/** Read Actor, this runtime's startup gate, and every active root in the index. */
export function readManagerAdapterProjection(
  database: DatabaseSync,
  options: { workspaceId?: string; businessDate?: string; includeInactive?: boolean } = {}
): ManagerAdapterReadModel {
  const workspaceId = workspaceIdFromDatabase(database, options.workspaceId);
  let actor: WorkspaceOrchestratorActor | null = null;
  try { actor = workspaceId ? readWorkspaceOrchestratorActor(database, workspaceId) : null; } catch { actor = null; }
  let startupGate: StartupReconcileGate | null = null;
  try { startupGate = actor ? readStartupReconcileGate(database, workspaceId, actor.runtimeEpoch) : null; } catch { startupGate = null; }
  if (!workspaceId || !tableExists(database, 'workspace_active_root_index')) {
    return Object.freeze({ actor, startupGate, roots: Object.freeze([]), asOf: new Date().toISOString() });
  }
  const activeClause = options.includeInactive ? '' : ' AND i.is_active=1';
  const rows = database.prepare(`SELECT i.* FROM workspace_active_root_index i
    WHERE i.workspace_id=?${activeClause}
    ORDER BY i.priority ASC, i.mailbox_sequence ASC, i.root_generation ASC, i.root_request_id ASC`).all(workspaceId) as Row[];
  const roots = rows.map((row) => readOneRoot(database, row, actor));
  const filtered = options.businessDate
    ? roots.filter((root) => !root.origin.businessDate || root.origin.businessDate === options.businessDate)
    : roots;
  return Object.freeze({ actor, startupGate, roots: Object.freeze(filtered), asOf: new Date().toISOString() });
}

/** Alias kept intentionally descriptive for read-surface call sites. */
export const readWorkspaceOrchestratorManagerProjection = readManagerAdapterProjection;
export const readManagerOrchestratorProjection = readManagerAdapterProjection;

export function hasActiveOrchestratorRoot(
  database: DatabaseSync,
  options: { workspaceId?: string; businessDate?: string } = {}
): boolean {
  return readManagerAdapterProjection(database, options).roots.length > 0;
}

function requireIdentity(identity: Partial<ManagerAdapterIdentity> | null | undefined): ManagerAdapterIdentity {
  const value = identity as ManagerAdapterIdentity | null | undefined;
  const required: Array<keyof ManagerAdapterIdentity> = [
    'workspaceId', 'rootRequestId', 'orchestrationId', 'managerTaskId', 'stageRequestId',
    'scopeHash', 'projectionHash', 'eligibleIdsHash'
  ];
  const missing = required.filter((key) => value?.[key] === null || value?.[key] === undefined || String(value?.[key] ?? '').trim() === '');
  const invalidFence = (['rootGeneration', 'checkpointRevision', 'indexRevision'] as const)
    .filter((key) => !Number.isFinite(Number(value?.[key])) || Number(value?.[key]) < 0);
  if (missing.length || invalidFence.length) {
    const fields = [...missing, ...invalidFence];
    throw Object.assign(new Error(`Manager typed command 缺少具体 root/stage/scope/projection identity 或有效 fence: ${fields.join(', ')}`), { code: 'MANAGER_COMMAND_IDENTITY_REQUIRED', fields });
  }
  return Object.freeze({
    workspaceId: String(value!.workspaceId),
    rootRequestId: String(value!.rootRequestId),
    rootGeneration: numberValue(value!.rootGeneration),
    orchestrationId: String(value!.orchestrationId),
    managerTaskId: String(value!.managerTaskId),
    stageRequestId: String(value!.stageRequestId),
    scopeHash: String(value!.scopeHash),
    projectionHash: String(value!.projectionHash),
    eligibleIdsHash: String(value!.eligibleIdsHash),
    checkpointRevision: numberValue(value!.checkpointRevision),
    indexRevision: numberValue(value!.indexRevision)
  });
}

/** Build only fenced, specific Manager commands; generic Continue is rejected. */
export function buildManagerTypedCommand(input: {
  type: ManagerTypedCommandType | string;
  requestId: string;
  identity: Partial<ManagerAdapterIdentity> | null | undefined;
  payload?: Record<string, unknown>;
}): ManagerTypedCommand {
  if (!MANAGER_TYPED_COMMANDS.includes(input.type as ManagerTypedCommandType)) {
    throw Object.assign(new Error(`Manager command 不允许 ${String(input.type)}；禁止 generic Continue。`), { code: 'MANAGER_COMMAND_NOT_ALLOWED' });
  }
  if (!input.requestId || !input.requestId.trim()) {
    throw Object.assign(new Error('Manager typed command 缺少 requestId。'), { code: 'MANAGER_COMMAND_REQUEST_REQUIRED' });
  }
  const identity = requireIdentity(input.identity);
  return Object.freeze({
    type: input.type as ManagerTypedCommandType,
    requestId: input.requestId.trim(),
    identity,
    payload: Object.freeze({
      ...input.payload,
      workspaceId: identity.workspaceId,
      rootRequestId: identity.rootRequestId,
      rootGeneration: identity.rootGeneration,
      orchestrationId: identity.orchestrationId,
      managerTaskId: identity.managerTaskId,
      stageRequestId: identity.stageRequestId,
      scopeHash: identity.scopeHash,
      projectionHash: identity.projectionHash,
      eligibleIdsHash: identity.eligibleIdsHash,
      expectedCheckpointRevision: identity.checkpointRevision,
      expectedIndexRevision: identity.indexRevision
    })
  });
}

export const buildManagerCommand = buildManagerTypedCommand;
