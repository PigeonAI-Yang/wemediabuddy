import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  canonicalJsonV1,
  createWorkspaceOrchestratorActorStore,
  hashV1,
  readWorkspaceOrchestratorActor,
  sha256Hex,
  type ActorFence,
  type PreflightRecoveryInput,
  type PreflightRecoveryResult,
  type WorkspaceOrchestratorActor
} from './workspace-orchestrator-actor.ts';
import { reserveManagedDispatchInTransaction } from './workspace-orchestrator-resource-admission.ts';
import {
  isWorkspaceOrchestratorCrashInjectedError,
  invokeWorkspaceOrchestratorCrashBarrier,
  type CrashBarrierBundle,
  type CrashBarrierContext,
  type CrashBarrierPhase,
  type WorkspaceOrchestratorCrashBarrier
} from './workspace-orchestrator-crash-barrier.ts';


const CURRENT_SCHEMA_EPOCH = 80;
const ACTIVE_ROOT_STATUSES: Record<string, true> = Object.freeze({ created: true, running: true, waiting_owner: true });
const TERMINAL_ROOT_STATUSES: Record<string, true> = Object.freeze({ succeeded: true, partial: true, failed: true, needs_user: true, cancelled: true });
const ACTIVE_CLAIM_STATUSES: Record<string, true> = Object.freeze({ claimed_unbound: true, claimed: true, dispatching_scan: true, snapshot_frozen: true, awaiting_judge: true, dispatching_judge: true, manifest_frozen: true, dispatching: true, settling: true, running: true });
const TERMINAL_CLAIM_STATUSES: Record<string, true> = Object.freeze({ succeeded: true, skipped: true, partial: true, failed: true, needs_user: true, cancelled: true, orphaned: true });
const ACTIVE_DISPATCH_STATES: Record<string, true> = Object.freeze({ reserved: true, task_bound: true, spawn_uncertain: true, spawn_started: true, running: true });
const TERMINAL_DISPATCH_STATES: Record<string, true> = Object.freeze({ terminal: true, cancelled: true, orphaned: true });
const ACTIVE_CONSUMPTION_STATES: Record<string, true> = Object.freeze({ reserved: true, consuming: true, unknown: true });
const TERMINAL_INVENTORY_STATES: Record<string, true> = Object.freeze({ exited: true, closed: true, cleaned: true, authorization_rejected: true, orphaned: true });
const TERMINAL_ROLLBACK_STATES: Record<string, true> = Object.freeze({ complete: true, maintenance: true, rollback_required: true });
const ACTIVE_ROLLBACK_STATES: Record<string, true> = Object.freeze({ requested: true, fencing: true, draining: true, verifying: true });
const FENCE_WRITE_STATES: Record<string, true> = Object.freeze({ allow: true, deny: true, maintenance: true });

type Row = Record<string, SQLInputValue>;
type Pair = { utc: string; mono: number };
type AnyInput = Record<string, unknown>;
type RecoveryStatus = 'complete' | 'maintenance' | 'failed';
type RollbackStatus = 'requested' | 'fencing' | 'draining' | 'verifying' | 'complete' | 'maintenance' | 'rollback_required';

type RecoveryFenceInput = Readonly<{
  workspaceId: string;
  fence: ActorFence;
  nowUtc?: string;
  nowMono?: number;
  crashBarrier?: WorkspaceOrchestratorCrashBarrier;
}>;

type MigrationStepInput = RecoveryFenceInput & Readonly<{
  migrationEpoch: number;
  stepKey: string;
  inputHash: string;
  beforeHash: string;
  afterHash: string;
  rowCount: number;
  winnerSetHash: string;
}>;

type InventoryInput = RecoveryFenceInput & Readonly<{
  inventoryId?: string;
  resourceKind: string;
  resourceKey: string;
  rootRequestId?: string | null;
  stageRequestId?: string | null;
  operationRequestId?: string | null;
  jobId?: string | null;
  pid?: number | null;
  parentPid?: number | null;
  processStartTimeUtc?: string | null;
  processStartTimeMono?: number | null;
  argv?: unknown;
  argvJson?: string;
  argvHash?: string;
  sessionKey: string;
  browserProfileId?: string | null;
  browserCdpPort?: number | null;
  mcpEndpoint?: string | null;
  launchAttemptId: string;
  leaseId?: string | null;
  cwd: string;
  stdoutWatermark?: number;
  stderrWatermark?: number;
  state?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  result?: unknown;
  resultJson?: unknown;
  authorizationRejectReason?: string | null;
}>;

type DrainInput = RecoveryFenceInput & Readonly<{
  inventoryId?: string;
  launchAttemptId?: string;
  resourceKey?: string;
  exitConfirmed?: boolean;
  processExited?: boolean;
  closeConfirmed?: boolean;
  sessionClosed?: boolean;
  cleanupConfirmed?: boolean;
  cwdCleaned?: boolean;
  authorizationRejected?: boolean;
  authorizationRejectReason?: string | null;
  exitCode?: number | null;
  exitSignal?: string | null;
  stdoutWatermark?: number;
  stderrWatermark?: number;
  closeProofHash?: string | null;
  cleanupProofHash?: string | null;
  result?: unknown;
  resultJson?: unknown;
}>;

type RollbackRequestInput = RecoveryFenceInput & Readonly<{
  sourceMigrationEpoch?: number;
  targetBuildManifestHash: string;
  targetSchemaEpoch: number;
  targetMinSupportedBuild: string;
  targetCutoverEpoch: number;
  reason?: string | null;
}>;

type RollbackAdvanceInput = RecoveryFenceInput & Readonly<{
  rollbackEpoch: number;
  status?: RollbackStatus;
  reason?: string | null;
  compatibility?: boolean | Readonly<Record<string, unknown>>;
}>;

function nowPair(input: AnyInput, defaults?: Pair): Pair {
  const utcCandidate = input.nowUtc ?? defaults?.utc ?? new Date().toISOString();
  const monoCandidate = input.nowMono ?? defaults?.mono ?? Date.now();
  const date = new Date(String(utcCandidate));
  return {
    utc: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    mono: Number.isFinite(Number(monoCandidate)) ? Math.max(0, Math.trunc(Number(monoCandidate))) : Date.now()
  };
}

function stringValue(value: unknown, name: string, optional = false): string | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (optional) return null;
    throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', `${name} is required.`);
  }
  return String(value);
}

function integerValue(value: unknown, name: string, minimum = 0, optional = false): number | null {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', `${name} is required.`);
  }
  const n = Math.trunc(Number(value));
  if (!Number.isSafeInteger(n) || n < minimum) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', `${name} must be an integer >= ${minimum}.`);
  return n;
}

function rowNumber(row: Row, key: string, fallback = 0): number {
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : fallback;
}

function rowString(row: Row, key: string, fallback = ''): string {
  return row[key] === null || row[key] === undefined ? fallback : String(row[key]);
}

function parseObject(value: unknown): AnyInput {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as AnyInput;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as AnyInput;
    } catch { /* malformed optional result is handled as empty */ }
  }
  return {};
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function canonicalValue(value: unknown): string {
  return canonicalJsonV1(value === undefined ? null : value);
}

function withTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

class RecoveryError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.details = details;
  }
}

function errorResult(error: unknown, fallbackStatus: RecoveryStatus | 'rejected' = 'failed'): Record<string, unknown> {
  if (isWorkspaceOrchestratorCrashInjectedError(error)) return Object.freeze({ ok: false, status: fallbackStatus, code: error.code, reasonCode: error.code, message: error.message, readback: error.context });
  if (error instanceof RecoveryError) return Object.freeze({ ok: false, status: fallbackStatus, code: error.code, reasonCode: error.code, message: error.message, readback: error.details });
  if (error instanceof Error) return Object.freeze({ ok: false, status: fallbackStatus, code: 'ORCHESTRATOR_CONTRACT_ERROR', reasonCode: 'ORCHESTRATOR_CONTRACT_ERROR', message: error.message });
  return Object.freeze({ ok: false, status: fallbackStatus, code: 'ORCHESTRATOR_CONTRACT_ERROR', reasonCode: 'ORCHESTRATOR_CONTRACT_ERROR', message: String(error) });
}
function invokeRecoveryCrashBarrier(barrier: WorkspaceOrchestratorCrashBarrier | undefined, bundle: CrashBarrierBundle, phase: CrashBarrierPhase, context: Omit<CrashBarrierContext, 'bundle' | 'phase'>): void {
  if (!barrier) return;
  invokeWorkspaceOrchestratorCrashBarrier(barrier, { ...context, bundle, phase });
}

function fenceOf(actor: WorkspaceOrchestratorActor): ActorFence {
  if (!actor.leaseToken) throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', '当前 Actor 没有 lease token。');
  return Object.freeze({
    workspaceId: actor.workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    checkpointRevision: actor.checkpointRevision
  });
}

function suppliedFence(input: AnyInput): ActorFence {
  const value = (input.fence ?? input.actorFence) as AnyInput | ActorFence | undefined;
  const candidate = value && typeof value === 'object' && 'fence' in value ? (value as AnyInput).fence : value;
  const fence = candidate as Partial<ActorFence> | undefined;
  if (!fence || typeof fence !== 'object') throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', 'recovery write 需要 Actor fence。');
  return {
    workspaceId: String(fence.workspaceId ?? ''),
    runtimeEpoch: Math.trunc(Number(fence.runtimeEpoch)),
    ownerEpoch: Math.trunc(Number(fence.ownerEpoch)),
    authorityRevision: Math.trunc(Number(fence.authorityRevision)),
    leaseToken: String(fence.leaseToken ?? ''),
    checkpointRevision: fence.checkpointRevision === undefined ? undefined : Math.trunc(Number(fence.checkpointRevision))
  };
}

function requireActor(database: DatabaseSync, workspaceId: string, input: AnyInput, pair: Pair, allowDenied = false): WorkspaceOrchestratorActor {
  const supplied = suppliedFence(input);
  if (supplied.workspaceId !== workspaceId || !supplied.leaseToken) throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', 'Actor fence identity 不完整。');
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  if (!actor || actor.leaseToken === null) throw new RecoveryError('WORKSPACE_STALE', 'workspace Actor 不存在或没有 lease。');
  if (actor.runtimeEpoch !== supplied.runtimeEpoch
    || actor.ownerEpoch !== supplied.ownerEpoch
    || actor.authorityRevision !== supplied.authorityRevision
    || actor.leaseToken !== supplied.leaseToken
    || (supplied.checkpointRevision !== undefined && actor.checkpointRevision !== supplied.checkpointRevision)) {
    throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', 'Actor fence 已过期。', { expected: fenceOf(actor), supplied });
  }
  if (!FENCE_WRITE_STATES[actor.writeFence]) throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', 'Actor write fence 非法。');
  if (!allowDenied && actor.writeFence !== 'allow') throw new RecoveryError('WRITE_FENCE_DENIED', '当前 Actor write fence 不允许 recovery 写入。', { writeFence: actor.writeFence });
  if (actor.leaseExpiresAtMono !== null && pair.mono > actor.leaseExpiresAtMono) throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', 'Actor lease 已过期。');
  if (actor.controlStallDeadlineMono !== null && pair.mono > actor.controlStallDeadlineMono) throw new RecoveryError('EXECUTION_AUTHORIZATION_INVALID', 'Actor control-stall deadline 已过期。');
  return actor;
}

function touchActor(database: DatabaseSync, actor: WorkspaceOrchestratorActor, pair: Pair, writeFence = actor.writeFence, syncGate: boolean | 'complete' = false): WorkspaceOrchestratorActor {
  const gatePredecessor = syncGate === 'complete' ? readRuntimeGate(database, actor.workspaceId, actor.runtimeEpoch) : null;
  if (syncGate === 'complete') {
    if (!gatePredecessor) throw new RecoveryError('WORKSPACE_STALE', '当前 runtime startup gate 不存在，无法完成 rollback。');
    if (rowNumber(gatePredecessor, 'runtime_epoch', -1) !== actor.runtimeEpoch
      || rowString(gatePredecessor, 'status') !== 'complete'
      || rowNumber(gatePredecessor, 'owner_epoch', -1) < 1
      || !rowString(gatePredecessor, 'lease_token')
      || rowNumber(gatePredecessor, 'checkpoint_revision', -1) < 0) {
      throw new RecoveryError('STATE_CONFLICT', '当前 runtime startup gate 不是可重绑的 complete predecessor。', {
        runtimeEpoch: actor.runtimeEpoch,
        gate: gateReadback(gatePredecessor)
      });
    }
  }
  const nextCheckpoint = actor.checkpointRevision + 1;
  const update = database.prepare(`UPDATE workspace_orchestrator_actors SET checkpoint_revision=?, write_fence=?, last_business_progress_at=?, updated_at=?
    WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=? AND authority_revision=? AND lease_token=? AND checkpoint_revision=?`).run(
    nextCheckpoint, writeFence, pair.utc, pair.utc, actor.workspaceId, actor.runtimeEpoch, actor.ownerEpoch,
    actor.authorityRevision, actor.leaseToken, actor.checkpointRevision);
  if (Number(update.changes ?? 0) !== 1) throw new RecoveryError('WORKSPACE_STALE', 'Actor checkpoint CAS 失败。');
  if (syncGate === true) {
    database.prepare(`UPDATE daily_reconcile_gates SET checkpoint_revision=?
      WHERE workspace_id=? AND runtime_epoch=? AND status IN ('pending','running')`).run(nextCheckpoint, actor.workspaceId, actor.runtimeEpoch);
  }
  if (syncGate === 'complete') {
    const rebound = database.prepare(`UPDATE daily_reconcile_gates SET owner_epoch=?, lease_token=?, lease_expires_at_utc=?, lease_expires_at_mono=?,
        gate_deadline_utc=?, gate_deadline_mono=?, checkpoint_revision=?, status='complete'
      WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=? AND lease_token=? AND status='complete' AND checkpoint_revision=?`).run(
      actor.ownerEpoch, actor.leaseToken, actor.leaseExpiresAtUtc, actor.leaseExpiresAtMono,
      actor.gateDeadlineUtc, actor.gateDeadlineMono, nextCheckpoint,
      actor.workspaceId, actor.runtimeEpoch, rowNumber(gatePredecessor!, 'owner_epoch'), rowString(gatePredecessor!, 'lease_token'),
      rowNumber(gatePredecessor!, 'checkpoint_revision'));
    if (Number(rebound.changes ?? 0) !== 1) throw new RecoveryError('WORKSPACE_STALE', 'startup gate rebind CAS 失败。', {
      runtimeEpoch: actor.runtimeEpoch,
      ownerEpoch: actor.ownerEpoch,
      leaseToken: actor.leaseToken,
      status: rowString(gatePredecessor!, 'status'),
      checkpointPredecessor: rowNumber(gatePredecessor!, 'checkpoint_revision')
    });
  }
  const next = readWorkspaceOrchestratorActor(database, actor.workspaceId);
  if (!next) throw new RecoveryError('WORKSPACE_STALE', 'Actor checkpoint readback 缺失。');
  return next;
}

function readRuntimeGate(database: DatabaseSync, workspaceId: string, runtimeEpoch: number): Row | null {
  return database.prepare('SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?').get(workspaceId, runtimeEpoch) as Row | undefined ?? null;
}

function gateReadback(row: Row | null): Record<string, unknown> | null {
  if (!row) return null;
  return Object.freeze({
    workspaceId: rowString(row, 'workspace_id'), runtimeEpoch: rowNumber(row, 'runtime_epoch'), ownerEpoch: rowNumber(row, 'owner_epoch'),
    leaseToken: rowString(row, 'lease_token'), leaseExpiresAtUtc: rowString(row, 'lease_expires_at_utc'), leaseExpiresAtMono: rowNumber(row, 'lease_expires_at_mono'),
    gateDeadlineUtc: rowString(row, 'gate_deadline_utc'), gateDeadlineMono: rowNumber(row, 'gate_deadline_mono'), checkpointRevision: rowNumber(row, 'checkpoint_revision'),
    status: rowString(row, 'status'), reason: row['reason'] ?? null, finishedAtUtc: row['finished_at_utc'] ?? null, finishedAtMono: row['finished_at_mono'] ?? null
  });
}

function exactMigration(database: DatabaseSync, actor: WorkspaceOrchestratorActor): Row | null {
  return database.prepare('SELECT * FROM workspace_migration_state WHERE workspace_id=? AND migration_epoch=?').get(actor.workspaceId, actor.migrationEpoch) as Row | undefined ?? null;
}

function migrationReadback(row: Row | null): Record<string, unknown> | null {
  if (!row) return null;
  return Object.freeze({
    workspaceId: rowString(row, 'workspace_id'), migrationEpoch: rowNumber(row, 'migration_epoch'), status: rowString(row, 'status'),
    manifestHash: rowString(row, 'manifest_hash'), schemaEpoch: rowNumber(row, 'schema_epoch'), cutoverEpoch: rowNumber(row, 'cutover_epoch'),
    ownerRuntimeEpoch: rowNumber(row, 'owner_runtime_epoch'), fenceTokenHash: rowString(row, 'fence_token_hash'),
    writeFence: rowString(row, 'write_fence'), checkpointSeq: rowNumber(row, 'checkpoint_seq'), beforeHash: rowString(row, 'before_hash'),
    afterHash: row[keyOr(row, 'after_hash')] ?? null, startedAtUtc: rowString(row, 'started_at_utc'), startedAtMono: rowNumber(row, 'started_at_mono'),
    finishedAtUtc: row[keyOr(row, 'finished_at_utc')] ?? null, finishedAtMono: row[keyOr(row, 'finished_at_mono')] ?? null,
    failureReason: row[keyOr(row, 'failure_reason')] ?? null
  });
}

function keyOr(_row: Row, key: string): string { return key; }

function appendEvent(database: DatabaseSync, actor: WorkspaceOrchestratorActor, pair: Pair, eventType: string, causationId: string, payload: AnyInput, aggregateId = actor.workspaceId): Record<string, unknown> {
  const existing = database.prepare('SELECT * FROM orchestrator_events WHERE workspace_id=? AND causation_id=? AND event_type=? ORDER BY event_sequence LIMIT 1').get(actor.workspaceId, causationId, eventType) as Row | undefined;
  if (existing) {
    const outbox = database.prepare('SELECT * FROM orchestrator_outbox WHERE workspace_id=? AND event_sequence=?').get(actor.workspaceId, rowNumber(existing, 'event_sequence')) as Row | undefined;
    if (!outbox) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', 'causation replay 缺少对应 outbox。', {
      workspaceId: actor.workspaceId, eventSequence: rowNumber(existing, 'event_sequence'), eventType, causationId
    });
    return Object.freeze({
      eventId: rowString(existing, 'event_id'), eventSequence: rowNumber(existing, 'event_sequence'),
      outboxId: rowString(outbox, 'outbox_id'), replayed: true
    });
  }
  const aggregateRevision = actor.checkpointRevision;
  const ordinal = rowNumber(database.prepare(`SELECT COALESCE(MAX(event_ordinal),0) AS value FROM orchestrator_outbox
    WHERE workspace_id=? AND aggregate_id=? AND aggregate_revision=?`).get(actor.workspaceId, aggregateId, aggregateRevision) as Row, 'value') + 1;
  const payloadJson = canonicalValue(payload);
  const eventSequence = rowNumber(database.prepare('SELECT COALESCE(MAX(event_sequence),0) AS value FROM orchestrator_events WHERE workspace_id=?').get(actor.workspaceId) as Row, 'value') + 1;
  const eventId = hashV1({ r: 'orchestrator-event/v1', workspaceId: actor.workspaceId, runtimeEpoch: actor.runtimeEpoch, checkpointRevision: actor.checkpointRevision, eventType, causationId });
  database.prepare(`INSERT INTO orchestrator_events (
    workspace_id,event_sequence,event_id,event_type,event_ordinal,causation_id,actor_epoch,owner_epoch,
    lease_token_fingerprint,checkpoint_revision,payload_json,occurred_at_utc
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    actor.workspaceId, eventSequence, eventId, eventType, ordinal, causationId, actor.runtimeEpoch, actor.ownerEpoch,
    sha256Hex(actor.leaseToken ?? ''), actor.checkpointRevision, payloadJson, pair.utc);
  const outboxId = hashV1({ r: 'orchestrator-outbox/v1', workspaceId: actor.workspaceId, aggregateId, aggregateRevision, eventType, ordinal, causationId });
  database.prepare(`INSERT INTO orchestrator_outbox (
    outbox_id,workspace_id,event_sequence,aggregate_id,aggregate_revision,event_type,event_ordinal,causation_id,
    payload_hash,payload_bytes,status,attempt,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?, 'pending',0,?)`).run(
    outboxId, actor.workspaceId, eventSequence, aggregateId, aggregateRevision, eventType, ordinal, causationId,
    sha256Hex(payloadJson), Buffer.from(payloadJson, 'utf8'), pair.utc);
  return Object.freeze({ eventId, eventSequence, outboxId, replayed: false });
}
function readEvent(database: DatabaseSync, workspaceId: string, eventType: string, causationId: string): Record<string, unknown> | null {
  const event = database.prepare('SELECT * FROM orchestrator_events WHERE workspace_id=? AND causation_id=? AND event_type=? ORDER BY event_sequence LIMIT 1').get(workspaceId, causationId, eventType) as Row | undefined;
  if (!event) return null;
  const outbox = database.prepare('SELECT * FROM orchestrator_outbox WHERE workspace_id=? AND event_sequence=?').get(workspaceId, rowNumber(event, 'event_sequence')) as Row | undefined;
  if (!outbox) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', 'terminal rollback event 缺少对应 outbox。', {
    workspaceId, eventSequence: rowNumber(event, 'event_sequence'), eventType, causationId
  });
  return Object.freeze({
    eventId: rowString(event, 'event_id'), eventSequence: rowNumber(event, 'event_sequence'),
    outboxId: rowString(outbox, 'outbox_id'), replayed: true
  });
}

function inventoryReadback(row: Row | null): Record<string, unknown> | null {
  if (!row) return null;
  return Object.freeze({
    inventoryId: rowString(row, 'inventory_id'), workspaceId: rowString(row, 'workspace_id'), runtimeEpoch: rowNumber(row, 'runtime_epoch'), ownerEpoch: rowNumber(row, 'owner_epoch'),
    resourceKind: rowString(row, 'resource_kind'), resourceKey: rowString(row, 'resource_key'), rootRequestId: row[rowKey('root_request_id')] ?? null,
    stageRequestId: row[rowKey('stage_request_id')] ?? null, operationRequestId: row[rowKey('operation_request_id')] ?? null, jobId: row[rowKey('job_id')] ?? null,
    pid: row[rowKey('pid')] ?? null, parentPid: row[rowKey('parent_pid')] ?? null, processStartTimeUtc: row[rowKey('process_start_time_utc')] ?? null,
    processStartTimeMono: row[rowKey('process_start_time_mono')] ?? null, argv: parseArray(row['argv_json']), argvJson: rowString(row, 'argv_json'), argvHash: rowString(row, 'argv_hash'),
    sessionKey: rowString(row, 'session_key'), browserProfileId: row[rowKey('browser_profile_id')] ?? null, browserCdpPort: row[rowKey('browser_cdp_port')] ?? null,
    mcpEndpoint: row[rowKey('mcp_endpoint')] ?? null, launchAttemptId: rowString(row, 'launch_attempt_id'), leaseId: row[rowKey('lease_id')] ?? null,
    leaseToken: rowString(row, 'lease_token'), leaseExpiresAtUtc: row[rowKey('lease_expires_at_utc')] ?? null, leaseExpiresAtMono: row[rowKey('lease_expires_at_mono')] ?? null,
    cwd: rowString(row, 'cwd'), stdoutWatermark: rowNumber(row, 'stdout_watermark'), stderrWatermark: rowNumber(row, 'stderr_watermark'), state: rowString(row, 'state'),
    exitCode: row[rowKey('exit_code')] ?? null, exitSignal: row[rowKey('exit_signal')] ?? null, exitAtUtc: row[rowKey('exit_at_utc')] ?? null,
    closeAtUtc: row[rowKey('close_at_utc')] ?? null, cleanupAtUtc: row[rowKey('cleanup_at_utc')] ?? null, authorizationRejectedAtUtc: row[rowKey('authorization_rejected_at_utc')] ?? null,
    authorizationRejectReason: row[rowKey('authorization_reject_reason')] ?? null, closeProofHash: row[rowKey('close_proof_hash')] ?? null, cleanupProofHash: row[rowKey('cleanup_proof_hash')] ?? null,
    result: parseObject(row['result_json']), createdAt: rowString(row, 'created_at'), updatedAt: rowString(row, 'updated_at'), finishedAt: row[rowKey('finished_at')] ?? null
  });
}

function rowKey(key: string): string { return key; }

function journalReadback(row: Row | null): Record<string, unknown> | null {
  if (!row) return null;
  return Object.freeze({
    workspaceId: rowString(row, 'workspace_id'), migrationEpoch: rowNumber(row, 'migration_epoch'), stepSeq: rowNumber(row, 'step_seq'),
    stepKey: rowString(row, 'step_key'), inputHash: rowString(row, 'input_hash'), beforeHash: rowString(row, 'before_hash'),
    afterHash: rowString(row, 'after_hash'), rowCount: rowNumber(row, 'row_count'), winnerSetHash: rowString(row, 'winner_set_hash'),
    status: rowString(row, 'status'), committedAtUtc: rowString(row, 'committed_at_utc'), committedAtMono: rowNumber(row, 'committed_at_mono')
  });
}

function readRecoveryBundle(database: DatabaseSync, workspaceId: string): Record<string, unknown> {
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  const rows = (table: string, order = '') => database.prepare(`SELECT * FROM ${table} WHERE workspace_id=?${order ? ` ORDER BY ${order}` : ''}`).all(workspaceId) as Row[];
  const migration = actor ? exactMigration(database, actor) : null;
  return Object.freeze({
    actor: actor ? Object.freeze({ ...actor }) : null,
    migration: migrationReadback(migration),
    roots: rows('daily_orchestration_roots', 'root_generation,root_request_id'),
    claims: rows('daily_stage_claims', 'root_request_id,stage_request_id'),
    dispatches: rows('managed_job_dispatches', 'root_request_id,job_id'),
    consumptions: rows('managed_effect_consumptions', 'root_request_id,consumption_id'),
    activeRootIndex: rows('workspace_active_root_index', 'root_generation,root_request_id'),
    inventory: rows('workspace_legacy_runtime_inventory', 'created_at,inventory_id'),
    events: rows('orchestrator_events', 'event_sequence'),
    outbox: rows('orchestrator_outbox', 'event_sequence'),
    migrationJournal: actor ? database.prepare('SELECT * FROM workspace_migration_journal WHERE workspace_id=? AND migration_epoch=? ORDER BY step_seq').all(workspaceId, actor.migrationEpoch) as Row[] : []
  });
}

function inventoryIdentityFromInput(input: AnyInput): { inventoryId: string; argvJson: string; argvHash: string; resourceKind: string; resourceKey: string; sessionKey: string; launchAttemptId: string; cwd: string } {
  const resourceKind = String(input.resourceKind ?? '').trim();
  const resourceKey = String(input.resourceKey ?? '').trim();
  const sessionKey = String(input.sessionKey ?? '').trim();
  const launchAttemptId = String(input.launchAttemptId ?? '').trim();
  const cwd = String(input.cwd ?? '').trim();
  if (!resourceKind || !resourceKey || !sessionKey || !launchAttemptId || !cwd) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', 'legacy inventory identity 字段不完整。');
  const allowed: Record<string, true> = { process: true, session: true, browser: true, mcp: true, scheduler: true, worker: true, xhs: true, other: true };
  if (!allowed[resourceKind]) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', `非法 resourceKind: ${resourceKind}`);
  let argvJson = String(input.argvJson ?? '').trim();
  if (!argvJson) argvJson = canonicalValue(input.argv ?? []);
  let argv: unknown;
  try { argv = JSON.parse(argvJson); } catch { throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', 'argvJson 必须是合法 JSON。'); }
  argvJson = canonicalValue(argv);
  const argvHash = String(input.argvHash ?? hashV1(argv));
  if (argvHash !== hashV1(argv)) throw new RecoveryError('STATE_CONFLICT', 'argvHash 与 argv 不匹配。');
  const suppliedId = String(input.inventoryId ?? '').trim();
  const inventoryId = suppliedId || hashV1({ r: 'legacy-runtime-inventory/v1', workspaceId: input.workspaceId, resourceKind, resourceKey, launchAttemptId });
  return { inventoryId, argvJson, argvHash, resourceKind, resourceKey, sessionKey, launchAttemptId, cwd };
}

function sameInventoryIdentity(row: Row, identity: AnyInput): boolean {
  const fields: Array<[string, unknown]> = [
    ['inventory_id', identity.inventoryId], ['workspace_id', identity.workspaceId], ['resource_kind', identity.resourceKind], ['resource_key', identity.resourceKey],
    ['root_request_id', identity.rootRequestId ?? null], ['stage_request_id', identity.stageRequestId ?? null], ['operation_request_id', identity.operationRequestId ?? null], ['job_id', identity.jobId ?? null],
    ['pid', identity.pid ?? null], ['parent_pid', identity.parentPid ?? null], ['process_start_time_utc', identity.processStartTimeUtc ?? null], ['process_start_time_mono', identity.processStartTimeMono ?? null],
    ['argv_json', identity.argvJson], ['argv_hash', identity.argvHash], ['session_key', identity.sessionKey], ['browser_profile_id', identity.browserProfileId ?? null], ['browser_cdp_port', identity.browserCdpPort ?? null],
    ['mcp_endpoint', identity.mcpEndpoint ?? null], ['launch_attempt_id', identity.launchAttemptId], ['lease_id', identity.leaseId ?? null], ['cwd', identity.cwd]
  ];
  return fields.every(([key, value]) => (row[key] ?? null) === (value ?? null));
}

export function registerLegacyRuntimeInventory(database: DatabaseSync, input: InventoryInput): Record<string, unknown> {
  const raw = input as AnyInput;
  const pair = nowPair(raw);
  try {
    return withTransaction(database, () => {
      const actor = requireActor(database, input.workspaceId, raw, pair);
      const identity = inventoryIdentityFromInput(raw);
      const normalized: Record<string, SQLInputValue> = {
        ...identity, workspaceId: input.workspaceId, runtimeEpoch: actor.runtimeEpoch, ownerEpoch: actor.ownerEpoch,
        rootRequestId: input.rootRequestId ?? null, stageRequestId: input.stageRequestId ?? null, operationRequestId: input.operationRequestId ?? null,
        jobId: input.jobId ?? null, pid: integerValue(input.pid, 'pid', 1, true), parentPid: integerValue(input.parentPid, 'parentPid', 1, true),
        processStartTimeUtc: input.processStartTimeUtc ?? null, processStartTimeMono: integerValue(input.processStartTimeMono, 'processStartTimeMono', 0, true),
        browserProfileId: input.browserProfileId ?? null, browserCdpPort: integerValue(input.browserCdpPort, 'browserCdpPort', 1, true), mcpEndpoint: input.mcpEndpoint ?? null,
        leaseId: input.leaseId ?? null, leaseToken: actor.leaseToken, leaseExpiresAtUtc: actor.leaseExpiresAtUtc, leaseExpiresAtMono: actor.leaseExpiresAtMono,
        stdoutWatermark: integerValue(input.stdoutWatermark ?? 0, 'stdoutWatermark', 0)!, stderrWatermark: integerValue(input.stderrWatermark ?? 0, 'stderrWatermark', 0)!,
        state: String(input.state ?? 'registered'), exitCode: input.exitCode ?? null, exitSignal: input.exitSignal ?? null,
        resultJson: input.resultJson === undefined && input.result === undefined ? null : canonicalValue(input.resultJson ?? input.result)
      };
      if (!['registered', 'running', 'draining', ...Object.keys(TERMINAL_INVENTORY_STATES)].includes(String(normalized.state))) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', `非法 legacy inventory state: ${normalized.state}`);
      const existing = database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND inventory_id=?').get(input.workspaceId, identity.inventoryId) as Row | undefined;
      const launchCollision = database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND launch_attempt_id=?').get(input.workspaceId, identity.launchAttemptId) as Row | undefined;
      if (launchCollision && (!existing || rowString(launchCollision, 'inventory_id') !== rowString(existing, 'inventory_id'))) throw new RecoveryError('STATE_CONFLICT', 'launchAttemptId 已绑定其他 inventory。', { launchAttemptId: identity.launchAttemptId });
      if (existing) {
        if (!sameInventoryIdentity(existing, normalized)) throw new RecoveryError('STATE_CONFLICT', 'legacy inventory immutable identity 冲突。', { inventoryId: identity.inventoryId, existing: inventoryReadback(existing) });
        if (TERMINAL_INVENTORY_STATES[rowString(existing, 'state')]) {
          const sameTerminal = rowString(existing, 'state') === String(normalized.state)
            && rowNumber(existing, 'stdout_watermark') >= Number(normalized.stdoutWatermark)
            && rowNumber(existing, 'stderr_watermark') >= Number(normalized.stderrWatermark);
          if (!sameTerminal) throw new RecoveryError('LATE_WRITE_REJECTED', 'terminal legacy inventory 拒绝 late write。', { inventoryId: identity.inventoryId, existing: inventoryReadback(existing) });
          return Object.freeze({ ok: true, status: 'replayed', replayed: true, inventory: inventoryReadback(existing), fence: fenceOf(actor), readback: readRecoveryBundle(database, input.workspaceId) });
        }
        const state = String(normalized.state);
        const terminal = Boolean(TERMINAL_INVENTORY_STATES[state]);
        database.prepare(`UPDATE workspace_legacy_runtime_inventory SET stdout_watermark=?, stderr_watermark=?, state=?, exit_code=?, exit_signal=?, result_json=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND inventory_id=? AND state NOT IN ('exited','closed','cleaned','authorization_rejected','orphaned')`).run(
          Math.max(rowNumber(existing, 'stdout_watermark'), Number(normalized.stdoutWatermark)), Math.max(rowNumber(existing, 'stderr_watermark'), Number(normalized.stderrWatermark)), state,
          normalized.exitCode, normalized.exitSignal, normalized.resultJson, pair.utc, terminal ? pair.utc : null, input.workspaceId, identity.inventoryId);
        const next = readInventory(database, input.workspaceId, identity.inventoryId)!;
        const nextActor = touchActor(database, actor, pair);
        const event = appendEvent(database, nextActor, pair, 'legacy_runtime.inventory_updated', hashV1({ r: 'legacy-inventory-update/v1', inventoryId: identity.inventoryId, state, stdout: normalized.stdoutWatermark, stderr: normalized.stderrWatermark }), { inventoryId: identity.inventoryId, state });
        return Object.freeze({ ok: true, status: terminal ? 'terminal' : state, replayed: false, inventory: inventoryReadback(next), fence: fenceOf(nextActor), event, readback: readRecoveryBundle(database, input.workspaceId) });
      }
      const terminal = Boolean(TERMINAL_INVENTORY_STATES[String(normalized.state)]);
      const authorizationRejected = String(normalized.state) === 'authorization_rejected';
      database.prepare(`INSERT INTO workspace_legacy_runtime_inventory (
        inventory_id,workspace_id,runtime_epoch,owner_epoch,resource_kind,resource_key,root_request_id,stage_request_id,operation_request_id,job_id,
        pid,parent_pid,process_start_time_utc,process_start_time_mono,argv_json,argv_hash,session_key,browser_profile_id,browser_cdp_port,mcp_endpoint,
        launch_attempt_id,lease_id,lease_token,lease_expires_at_utc,lease_expires_at_mono,cwd,stdout_watermark,stderr_watermark,state,exit_code,exit_signal,
        authorization_rejected_at_utc,authorization_reject_reason,result_json,created_at,updated_at,finished_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        identity.inventoryId, input.workspaceId, actor.runtimeEpoch, actor.ownerEpoch, identity.resourceKind, identity.resourceKey,
        normalized.rootRequestId, normalized.stageRequestId, normalized.operationRequestId, normalized.jobId, normalized.pid, normalized.parentPid,
        normalized.processStartTimeUtc, normalized.processStartTimeMono, identity.argvJson, identity.argvHash, identity.sessionKey, normalized.browserProfileId,
        normalized.browserCdpPort, normalized.mcpEndpoint, identity.launchAttemptId, normalized.leaseId, actor.leaseToken, normalized.leaseExpiresAtUtc,
        normalized.leaseExpiresAtMono, identity.cwd, normalized.stdoutWatermark, normalized.stderrWatermark, normalized.state, normalized.exitCode,
        normalized.exitSignal, authorizationRejected ? pair.utc : null, authorizationRejected ? String(input.authorizationRejectReason ?? '') : null,
        normalized.resultJson, pair.utc, pair.utc, terminal ? pair.utc : null);
      const inserted = readInventory(database, input.workspaceId, identity.inventoryId);
      if (!inserted) throw new RecoveryError('STATE_CONFLICT', 'legacy inventory insert readback 缺失。');
      const nextActor = touchActor(database, actor, pair);
      const event = appendEvent(database, nextActor, pair, 'legacy_runtime.inventory_registered', hashV1({ r: 'legacy-inventory-register/v1', inventoryId: identity.inventoryId, launchAttemptId: identity.launchAttemptId }), { inventory: inserted });
      return Object.freeze({ ok: true, status: normalized.state, replayed: false, inventory: inventoryReadback(inserted), fence: fenceOf(nextActor), event, readback: readRecoveryBundle(database, input.workspaceId) });
    });
  } catch (error) { return errorResult(error, 'rejected'); }
}

function readInventory(database: DatabaseSync, workspaceId: string, inventoryId: string): Row | null {
  return database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND inventory_id=?').get(workspaceId, inventoryId) as Row | undefined ?? null;
}

export function confirmLegacyRuntimeDrain(database: DatabaseSync, input: DrainInput): Record<string, unknown> {
  const raw = input as AnyInput;
  const pair = nowPair(raw);
  try {
    return withTransaction(database, () => {
      const actor = requireActor(database, input.workspaceId, raw, pair, true);
      const inventoryId = String(input.inventoryId ?? '').trim();
      const launchAttemptId = String(input.launchAttemptId ?? '').trim();
      const resourceKey = String(input.resourceKey ?? '').trim();
      let row: Row | undefined;
      if (inventoryId) row = database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND inventory_id=?').get(input.workspaceId, inventoryId) as Row | undefined;
      else if (launchAttemptId) row = database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND launch_attempt_id=?').get(input.workspaceId, launchAttemptId) as Row | undefined;
      else if (resourceKey) {
        const rows = database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND resource_key=? ORDER BY created_at,inventory_id').all(input.workspaceId, resourceKey) as Row[];
        if (rows.length === 1) row = rows[0];
        else if (rows.length > 1) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', 'resourceKey 不是唯一 inventory identity。');
      }
      if (!row) throw new RecoveryError('NOT_FOUND', 'legacy inventory 不存在。');
      if (inventoryId && rowString(row, 'inventory_id') !== inventoryId) throw new RecoveryError('STATE_CONFLICT', 'inventoryId readback 不匹配。');
      if (launchAttemptId && rowString(row, 'launch_attempt_id') !== launchAttemptId) throw new RecoveryError('STATE_CONFLICT', 'launchAttemptId readback 不匹配。');
      const authorizationRejected = input.authorizationRejected === true || input.authorizationRejectReason !== undefined;
      const exitConfirmed = input.exitConfirmed === true || input.processExited === true;
      const closeConfirmed = input.closeConfirmed === true || input.sessionClosed === true;
      const cleanupConfirmed = input.cleanupConfirmed === true || input.cwdCleaned === true;
      const state = authorizationRejected ? 'authorization_rejected' : cleanupConfirmed ? 'cleaned' : closeConfirmed ? 'closed' : exitConfirmed ? 'exited' : 'draining';
      const stdout = Math.max(rowNumber(row, 'stdout_watermark'), integerValue(input.stdoutWatermark ?? rowNumber(row, 'stdout_watermark'), 'stdoutWatermark', 0)!);
      const stderr = Math.max(rowNumber(row, 'stderr_watermark'), integerValue(input.stderrWatermark ?? rowNumber(row, 'stderr_watermark'), 'stderrWatermark', 0)!);
      if (TERMINAL_INVENTORY_STATES[rowString(row, 'state')]) {
        const sameEvidence = rowString(row, 'state') === state && rowNumber(row, 'stdout_watermark') >= stdout && rowNumber(row, 'stderr_watermark') >= stderr
          && (input.closeProofHash === undefined || String(row.close_proof_hash ?? '') === String(input.closeProofHash ?? ''))
          && (input.cleanupProofHash === undefined || String(row.cleanup_proof_hash ?? '') === String(input.cleanupProofHash ?? ''));
        if (!sameEvidence) throw new RecoveryError('LATE_WRITE_REJECTED', 'terminal legacy inventory 拒绝 late write。', { inventory: inventoryReadback(row) });
        return Object.freeze({ ok: true, status: 'replayed', replayed: true, inventory: inventoryReadback(row), fence: fenceOf(actor), readback: readRecoveryBundle(database, input.workspaceId) });
      }
      const terminal = Boolean(TERMINAL_INVENTORY_STATES[state]);
      database.prepare(`UPDATE workspace_legacy_runtime_inventory SET stdout_watermark=?, stderr_watermark=?, state=?, exit_code=?, exit_signal=?,
        exit_at_utc=?, close_at_utc=?, cleanup_at_utc=?, authorization_rejected_at_utc=?, authorization_reject_reason=?, close_proof_hash=?, cleanup_proof_hash=?, result_json=?, updated_at=?, finished_at=?
        WHERE workspace_id=? AND inventory_id=? AND state NOT IN ('exited','closed','cleaned','authorization_rejected','orphaned')`).run(
        stdout, stderr, state, input.exitCode ?? row.exit_code ?? null, input.exitSignal ?? row.exit_signal ?? null,
        exitConfirmed ? pair.utc : row.exit_at_utc ?? null, closeConfirmed ? pair.utc : row.close_at_utc ?? null, cleanupConfirmed ? pair.utc : row.cleanup_at_utc ?? null,
        authorizationRejected ? pair.utc : row.authorization_rejected_at_utc ?? null, authorizationRejected ? String(input.authorizationRejectReason ?? '') : row.authorization_reject_reason ?? null,
        input.closeProofHash ?? row.close_proof_hash ?? null, input.cleanupProofHash ?? row.cleanup_proof_hash ?? null,
        input.resultJson !== undefined || input.result !== undefined ? canonicalValue(input.resultJson ?? input.result) : row.result_json ?? null,
        pair.utc, terminal ? pair.utc : null, input.workspaceId, row.inventory_id);
      const nextRow = readInventory(database, input.workspaceId, rowString(row, 'inventory_id'))!;
      const nextActor = touchActor(database, actor, pair);
      const event = appendEvent(database, nextActor, pair, 'legacy_runtime.inventory_drained', hashV1({ r: 'legacy-inventory-drain/v1', inventoryId: row.inventory_id, state, stdout, stderr }), { inventory: inventoryReadback(nextRow) });
      return Object.freeze({ ok: true, status: state, replayed: false, inventory: inventoryReadback(nextRow), fence: fenceOf(nextActor), event, readback: readRecoveryBundle(database, input.workspaceId) });
    });
  } catch (error) { return errorResult(error, 'rejected'); }
}

export function recordWorkspaceMigrationStep(database: DatabaseSync, input: MigrationStepInput): Record<string, unknown> {
  const raw = input as AnyInput;
  const pair = nowPair(raw);
  try {
    return withTransaction(database, () => {
      let actor = requireActor(database, input.workspaceId, raw, pair);
      if (actor.migrationEpoch !== input.migrationEpoch) throw new RecoveryError('STATE_CONFLICT', 'migrationEpoch 必须精确匹配当前 Actor。');
      const migration = exactMigration(database, actor);
      if (!migration) throw new RecoveryError('WORKSPACE_STALE', 'current migration state 不存在。');
      const existing = database.prepare('SELECT * FROM workspace_migration_journal WHERE workspace_id=? AND migration_epoch=? AND step_key=?').get(input.workspaceId, input.migrationEpoch, input.stepKey) as Row | undefined;
      const same = existing && rowString(existing, 'input_hash') === input.inputHash && rowString(existing, 'before_hash') === input.beforeHash && rowString(existing, 'after_hash') === input.afterHash
        && rowNumber(existing, 'row_count') === input.rowCount && rowString(existing, 'winner_set_hash') === input.winnerSetHash;
      if (existing) {
        if (same) return Object.freeze({ ok: true, status: 'replayed', replayed: true, journal: journalReadback(existing), fence: fenceOf(actor), readback: readRecoveryBundle(database, input.workspaceId) });
        actor = touchActor(database, actor, pair, 'maintenance');
        if (!TERMINAL_ROLLBACK_STATES[rowString(migration, 'status')] && !['complete', 'failed', 'maintenance'].includes(rowString(migration, 'status'))) {
          database.prepare(`UPDATE workspace_migration_state SET status='maintenance', write_fence='maintenance', finished_at_utc=?, finished_at_mono=?, failure_reason=?
            WHERE workspace_id=? AND migration_epoch=? AND status NOT IN ('complete','failed','maintenance')`).run(pair.utc, pair.mono, 'MIGRATION_JOURNAL_CONFLICT', input.workspaceId, input.migrationEpoch);
        }
        const event = appendEvent(database, actor, pair, 'migration.journal_conflict', hashV1({ r: 'migration-journal-conflict/v1', workspaceId: input.workspaceId, migrationEpoch: input.migrationEpoch, stepKey: input.stepKey }), { stepKey: input.stepKey, existing: journalReadback(existing), requested: input });
        return Object.freeze({ ok: false, status: 'maintenance', code: 'MIGRATION_JOURNAL_CONFLICT', reasonCode: 'MIGRATION_JOURNAL_CONFLICT', message: 'stepKey 已绑定不同 migration input。', fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
      }
      const stepSeq = rowNumber(database.prepare('SELECT COALESCE(MAX(step_seq),0) AS value FROM workspace_migration_journal WHERE workspace_id=? AND migration_epoch=?').get(input.workspaceId, input.migrationEpoch) as Row, 'value') + 1;
      database.prepare(`INSERT INTO workspace_migration_journal (
        workspace_id,migration_epoch,step_seq,step_key,input_hash,before_hash,after_hash,row_count,winner_set_hash,status,committed_at_utc,committed_at_mono
      ) VALUES (?,?,?,?,?,?,?,?,?,'committed',?,?)`).run(input.workspaceId, input.migrationEpoch, stepSeq, input.stepKey, input.inputHash, input.beforeHash, input.afterHash, input.rowCount, input.winnerSetHash, pair.utc, pair.mono);
      actor = touchActor(database, actor, pair);
      const inserted = database.prepare('SELECT * FROM workspace_migration_journal WHERE workspace_id=? AND migration_epoch=? AND step_seq=?').get(input.workspaceId, input.migrationEpoch, stepSeq) as Row;
      const event = appendEvent(database, actor, pair, 'migration.journal_committed', hashV1({ r: 'migration-journal-commit/v1', workspaceId: input.workspaceId, migrationEpoch: input.migrationEpoch, stepKey: input.stepKey }), { journal: journalReadback(inserted) });
      return Object.freeze({ ok: true, status: 'committed', replayed: false, journal: journalReadback(inserted), fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
    });
  } catch (error) { return errorResult(error, 'maintenance'); }
}



function updateRootOwnership(database: DatabaseSync, actor: WorkspaceOrchestratorActor, root: Row, pair: Pair): void {
  database.prepare(`UPDATE daily_orchestration_roots SET owner_epoch=?, lease_token=?, lease_expires_at_utc=?, lease_expires_at_mono=?, checkpoint_revision=?, updated_at=?
    WHERE workspace_id=? AND root_request_id=? AND status IN ('created','running','waiting_owner')`).run(
    actor.ownerEpoch, actor.leaseToken, actor.leaseExpiresAtUtc, actor.leaseExpiresAtMono, actor.checkpointRevision, pair.utc, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE daily_stage_claims SET owner_epoch=?, lease_token=?, lease_expires_at=?, lease_expires_at_utc=?, lease_expires_at_mono=?, updated_at=?
    WHERE workspace_id=? AND root_request_id=? AND is_active=1 AND status NOT IN ('succeeded','skipped','partial','failed','needs_user','cancelled','orphaned')`).run(
    actor.ownerEpoch, actor.leaseToken, actor.leaseExpiresAtUtc, actor.leaseExpiresAtUtc, actor.leaseExpiresAtMono, pair.utc, actor.workspaceId, root.root_request_id);
}

function cancelRootBundle(database: DatabaseSync, actor: WorkspaceOrchestratorActor, root: Row, pair: Pair, reason: string, crashBarrier?: WorkspaceOrchestratorCrashBarrier): void {
  const finished = pair.utc;
  database.prepare(`UPDATE daily_orchestration_roots SET status='cancelled', checkpoint_revision=?, updated_at=?, finished_at=?
    WHERE workspace_id=? AND root_request_id=? AND status IN ('created','running','waiting_owner')`).run(actor.checkpointRevision, pair.utc, finished, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE daily_stage_claims SET status='orphaned', is_active=0, claim_revision=claim_revision+1, result_json=?, updated_at=?, finished_at=?
    WHERE workspace_id=? AND root_request_id=? AND is_active=1 AND status NOT IN ('succeeded','skipped','partial','failed','needs_user','cancelled','orphaned')`).run(canonicalValue({ reasonCode: 'CANCELLED_ANCESTOR', reason }), pair.utc, finished, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE managed_job_dispatches SET state='orphaned', result_status='cancelled', result_hash=?, result_json=?, updated_at=?, finished_at=?
    WHERE workspace_id=? AND root_request_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')`).run(hashV1({ reasonCode: 'CANCELLED_ANCESTOR', reason }), canonicalValue({ reasonCode: 'CANCELLED_ANCESTOR', reason }), pair.utc, finished, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE managed_effect_consumptions SET state='orphaned', error_json=?, updated_at=?, finished_at=?
    WHERE workspace_id=? AND root_request_id=? AND state IN ('reserved','consuming','unknown')`).run(canonicalValue({ reasonCode: 'CANCELLED_ANCESTOR', reason }), pair.utc, finished, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE orchestrator_intents SET status='cancelled', stop_reason_json=?, checkpoint_revision=?, updated_at=?, finished_at=?
    WHERE workspace_id=? AND root_request_id=? AND status NOT IN ('succeeded','partial','failed','needs_user','cancelled')`).run(canonicalValue({ reasonCode: 'CANCELLED_ANCESTOR', reason }), actor.checkpointRevision, pair.utc, finished, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE orchestrator_mailbox SET state='cancelled', finished_at_utc=?, finished_at_mono=?
    WHERE workspace_id=? AND intent_id=? AND state IN ('enqueued','claimed')`).run(pair.utc, pair.mono, actor.workspaceId, root.intent_id);
  invokeRecoveryCrashBarrier(crashBarrier, 'T8', 'business_rows', { workspaceId: actor.workspaceId, rootRequestId: rowString(root, 'root_request_id'), intentId: root.intent_id ? String(root.intent_id) : undefined, phaseBoundary: 'business_rows' });
}

function activeDispatches(database: DatabaseSync, workspaceId: string, rootRequestId: string): Row[] {
  return database.prepare(`SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND root_request_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running') ORDER BY job_id`).all(workspaceId, rootRequestId) as Row[];
}

function adoptDispatch(database: DatabaseSync, actor: WorkspaceOrchestratorActor, dispatch: Row, inventory: Row, pair: Pair): void {
  database.prepare(`UPDATE managed_job_dispatches SET owner_epoch=?, lease_token=?, lease_expires_at_utc=?, lease_expires_at_mono=? ,
      pid=?, process_start_time_utc=?, process_start_time_mono=?, register_at=COALESCE(register_at,?), stdout_drain_watermark=?, stderr_drain_watermark=?, state='running', updated_at=?
    WHERE workspace_id=? AND job_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')`).run(
    actor.ownerEpoch, actor.leaseToken, actor.leaseExpiresAtUtc, actor.leaseExpiresAtMono,
    inventory.pid ?? null, inventory.process_start_time_utc ?? null,
    inventory.process_start_time_mono ?? null, pair.utc, inventory.stdout_watermark, inventory.stderr_watermark, pair.utc, actor.workspaceId, dispatch.job_id);
}

function adoptClaims(database: DatabaseSync, actor: WorkspaceOrchestratorActor, rootRequestId: string, pair: Pair): void {
  database.prepare(`UPDATE daily_stage_claims SET owner_epoch=?, lease_token=?, lease_expires_at=?, lease_expires_at_utc=?, lease_expires_at_mono=?, updated_at=?
    WHERE workspace_id=? AND root_request_id=? AND is_active=1 AND status IN ('claimed_unbound','claimed','dispatching_scan','snapshot_frozen','awaiting_judge','dispatching_judge','manifest_frozen','dispatching','settling','running')`).run(
    actor.ownerEpoch, actor.leaseToken, actor.leaseExpiresAtUtc, actor.leaseExpiresAtUtc, actor.leaseExpiresAtMono, pair.utc, actor.workspaceId, rootRequestId);
}

function intentRootCancellation(database: DatabaseSync, root: Row): string | null {
  const workspaceId = rowString(root, 'workspace_id');
  const intentId = rowString(root, 'intent_id');
  if (intentId) {
    const intent = database.prepare('SELECT status FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?').get(workspaceId, intentId) as Row | undefined;
    if (intent && rowString(intent, 'status') === 'cancelled') return 'intent_cancelled';
  }
  const seen = new Set<string>();
  let predecessorId = rowString(root, 'predecessor_root_id');
  while (predecessorId && !seen.has(predecessorId)) {
    seen.add(predecessorId);
    const predecessor = database.prepare('SELECT root_id,status,predecessor_root_id FROM daily_orchestration_roots WHERE workspace_id=? AND root_id=?').get(workspaceId, predecessorId) as Row | undefined;
    if (!predecessor) break;
    if (rowString(predecessor, 'status') === 'cancelled') return 'predecessor_cancelled';
    predecessorId = rowString(predecessor, 'predecessor_root_id');
  }
  const superseding = database.prepare(`SELECT root_request_id FROM daily_orchestration_roots
    WHERE workspace_id=? AND root_request_id<>? AND (
      supersedes_manager_task_id=? OR supersedes_orchestration_id=? OR supersedes_stage_request_id IN (SELECT stage_request_id FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=?)
    ) LIMIT 1`).get(workspaceId, rowString(root, 'root_request_id'), root.manager_task_id, root.orchestration_id, workspaceId, rowString(root, 'root_request_id')) as Row | undefined;
  return superseding ? 'superseded' : null;
}

function parseScope(scopeRow: Row | null): { projectionState: 'absent' | 'not_applicable' | 'frozen'; scopeHash: string | null; projectionHash: string | null; eligibleIdsHash: string | null } {
  if (!scopeRow) return { projectionState: 'absent', scopeHash: null, projectionHash: null, eligibleIdsHash: null };
  const frozen = rowString(scopeRow, 'scope_status') === 'frozen';
  if (!frozen) return { projectionState: 'not_applicable', scopeHash: null, projectionHash: null, eligibleIdsHash: null };
  const scopeHash = rowString(scopeRow, 'scope_hash');
  const scope = parseObject(scopeRow.scope_json);
  const projectionHash = String(scope.projectionHash ?? scope.projection_hash ?? hashV1({ r: 'scope-projection/v1', scopeHash }));
  const allowed = parseArray(scopeRow.allowed_plan_item_ids_json).map(String).sort();
  return { projectionState: 'frozen', scopeHash, projectionHash, eligibleIdsHash: hashV1({ r: 'eligible-plan-items/v1', ids: allowed }) };
}

function rebuildActiveRootIndex(database: DatabaseSync, actor: WorkspaceOrchestratorActor, root: Row, pair: Pair): { changed: boolean; maintenance: string | null } {
  const workspaceId = actor.workspaceId;
  const rootRequestId = rowString(root, 'root_request_id');
  const current = database.prepare('SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?').get(workspaceId, rootRequestId) as Row | undefined;
  const claims = database.prepare(`SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? AND is_active=1
    AND status NOT IN ('succeeded','skipped','partial','failed','needs_user','cancelled','orphaned') ORDER BY stage_request_id`).all(workspaceId, rootRequestId) as Row[];
  const active = Boolean(ACTIVE_ROOT_STATUSES[rowString(root, 'status')]);
  if (active && claims.length > 1) return { changed: false, maintenance: `root ${rootRequestId} has multiple active stage claims` };
  if (active && claims.length === 0) return { changed: false, maintenance: `root ${rootRequestId} has no active stage claim` };
  if (active && current && Number(current.is_active) === 0) return { changed: false, maintenance: `root ${rootRequestId} index is terminal and cannot revive` };
  const claim = claims[0] ?? null;
  const scopeRow = claim ? database.prepare('SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?').get(workspaceId, claim.stage_request_id) as Row | undefined ?? null : null;
  const intent = root.intent_id ? database.prepare('SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?').get(workspaceId, root.intent_id) as Row | undefined : undefined;
  const nextAction = parseObject(intent?.next_action_json);
  const terminalReason = active ? null : String(nextAction.reasonCode ?? rowString(root, 'status'));
  const schedulerNoTargets = !active && rowString(root, 'root_mode') === 'scheduler' && terminalReason === 'NO_CURRENT_TARGETS';
  const scope = scopeRow
    ? parseScope(scopeRow)
    : schedulerNoTargets
      ? { projectionState: 'not_applicable' as const, scopeHash: null, projectionHash: null, eligibleIdsHash: null }
      : parseScope(null);
  const mailbox = root.intent_id ? database.prepare('SELECT mailbox_sequence,priority FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=? ORDER BY mailbox_sequence LIMIT 1').get(workspaceId, root.intent_id) as Row | undefined : undefined;
  const mailboxSequence = Math.max(1, rowNumber(current ?? {}, 'mailbox_sequence', rowNumber(mailbox ?? {}, 'mailbox_sequence', 1)));
  const priority = Math.max(0, rowNumber(current ?? {}, 'priority', rowNumber(mailbox ?? {}, 'priority', 0)));
  const desired: Record<string, SQLInputValue> = {
    workspace_id: workspaceId, root_request_id: rootRequestId, orchestration_id: root.orchestration_id, manager_task_id: root.manager_task_id,
    root_generation: root.root_generation, source: root.source, root_mode: root.root_mode, status: root.status, terminal_reason: terminalReason,
    is_active: active ? 1 : 0, priority, mailbox_sequence: mailboxSequence, checkpoint_revision: root.checkpoint_revision,
    index_revision: current ? rowNumber(current, 'index_revision') + 1 : 0, stage_request_id: claim?.stage_request_id ?? null,
    projection_state: scope.projectionState, scope_hash: scope.scopeHash, projection_hash: scope.projectionHash, eligible_ids_hash: scope.eligibleIdsHash,
    next_action: intent?.next_action_json ?? null, visible_since: current?.visible_since ?? root.created_at, updated_at: pair.utc
  };
  if (current) {
    const same = ['orchestration_id', 'manager_task_id', 'root_generation', 'source', 'root_mode', 'status', 'terminal_reason', 'is_active', 'priority', 'mailbox_sequence', 'checkpoint_revision', 'stage_request_id', 'projection_state', 'scope_hash', 'projection_hash', 'eligible_ids_hash', 'next_action', 'visible_since']
      .every((key) => String(current[key] ?? null) === String(desired[key] ?? null));
    if (same) return { changed: false, maintenance: null };
    database.prepare(`UPDATE workspace_active_root_index SET orchestration_id=?, manager_task_id=?, root_generation=?, source=?, root_mode=?, status=?, terminal_reason=?, is_active=?, priority=?, mailbox_sequence=?, checkpoint_revision=?, index_revision=?, stage_request_id=?, projection_state=?, scope_hash=?, projection_hash=?, eligible_ids_hash=?, next_action=?, visible_since=?, updated_at=?
      WHERE workspace_id=? AND root_request_id=?`).run(
      desired.orchestration_id, desired.manager_task_id, desired.root_generation, desired.source, desired.root_mode, desired.status, desired.terminal_reason, desired.is_active,
      desired.priority, desired.mailbox_sequence, desired.checkpoint_revision, desired.index_revision, desired.stage_request_id, desired.projection_state, desired.scope_hash,
      desired.projection_hash, desired.eligible_ids_hash, desired.next_action, desired.visible_since, pair.utc, workspaceId, rootRequestId);
    return { changed: true, maintenance: null };
  }
  database.prepare(`INSERT INTO workspace_active_root_index (
    workspace_id,root_request_id,orchestration_id,manager_task_id,root_generation,source,root_mode,status,terminal_reason,is_active,priority,mailbox_sequence,checkpoint_revision,index_revision,stage_request_id,projection_state,scope_hash,projection_hash,eligible_ids_hash,next_action,visible_since,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    desired.workspace_id, desired.root_request_id, desired.orchestration_id, desired.manager_task_id, desired.root_generation, desired.source, desired.root_mode, desired.status,
    desired.terminal_reason, desired.is_active, desired.priority, desired.mailbox_sequence, desired.checkpoint_revision, desired.index_revision, desired.stage_request_id,
    desired.projection_state, desired.scope_hash, desired.projection_hash, desired.eligible_ids_hash, desired.next_action, desired.visible_since, desired.updated_at);
  return { changed: true, maintenance: null };
}

function findExactInventory(database: DatabaseSync, workspaceId: string, dispatch: Row): Row | null {
  const launchAttemptId = rowString(dispatch, 'launch_attempt_id');
  if (!launchAttemptId) return null;
  return database.prepare('SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND launch_attempt_id=?').get(workspaceId, launchAttemptId) as Row | undefined ?? null;
}

function insertIdentity(database: DatabaseSync, workspaceId: string, registryName: string, preimage: AnyInput, derivedValue: string, nowUtc: string): void {
  const bytes = canonicalValue(preimage);
  const preimageHash = sha256Hex(bytes);
  const existing = database.prepare('SELECT * FROM identity_hash_registry WHERE workspace_id=? AND registry_name=? AND registry_version=1 AND preimage_hash=?').get(workspaceId, registryName, preimageHash) as Row | undefined;
  if (existing) {
    if (rowString(existing, 'derived_value') !== derivedValue) throw new RecoveryError('STATE_CONFLICT', `${registryName} identity registry conflict.`);
    return;
  }
  database.prepare(`INSERT INTO identity_hash_registry (workspace_id,registry_name,registry_version,preimage_schema_version,preimage_hash,canonical_bytes_hash,preimage_bytes,derived_value,created_at)
    VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)`).run(workspaceId, registryName, preimageHash, sha256Hex(bytes), Buffer.from(bytes, 'utf8'), derivedValue, nowUtc);
}

function handoffJudge(database: DatabaseSync, actor: WorkspaceOrchestratorActor, root: Row, parent: Row, pair: Pair): boolean {
  const existing = database.prepare(`SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? AND attempt_stage='judge'
    AND status NOT IN ('cancelled','orphaned') ORDER BY stage_request_id LIMIT 1`).get(actor.workspaceId, root.root_request_id) as Row | undefined;
  if (existing) {
    if (rowString(existing, 'parent_stage_request_id') !== rowString(parent, 'stage_request_id')) return false;
    if (rowString(parent, 'status') === 'awaiting_judge' && Number(parent.is_active) === 1) {
      database.prepare(`UPDATE daily_stage_claims SET status='succeeded',is_active=0,claim_revision=claim_revision+1,result_json=?,updated_at=?,finished_at=?
        WHERE workspace_id=? AND stage_request_id=? AND is_active=1 AND status='awaiting_judge'`).run(canonicalValue({ reasonCode: 'HANDOFF_CONSUMED', judgeStageRequestId: existing.stage_request_id }), pair.utc, pair.utc, actor.workspaceId, parent.stage_request_id);
    }
    return true;
  }
  if (rowString(parent, 'attempt_stage') === 'judge' || rowString(parent, 'status') !== 'awaiting_judge' || Number(parent.is_active) !== 1) return false;
  const snapshot = parseObject(parent.snapshot_json);
  const sourceSnapshotHash = String(snapshot.sourceSnapshotHash ?? snapshot.snapshotHash ?? '').trim();
  const preflightId = String(snapshot.preflightId ?? root.preflight_id ?? '').trim();
  const preflight = preflightId ? database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=? AND status=\'frozen\'').get(actor.workspaceId, preflightId) as Row | undefined : undefined;
  if (!sourceSnapshotHash || !preflight) return false;
  const sourceSnapshot = database.prepare('SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=? AND status=\'frozen\'').get(actor.workspaceId, sourceSnapshotHash) as Row | undefined;
  if (!sourceSnapshot) return false;
  if (rowString(sourceSnapshot, 'root_request_id') !== rowString(root, 'root_request_id')
    || rowNumber(sourceSnapshot, 'root_generation') !== rowNumber(root, 'root_generation')
    || rowString(sourceSnapshot, 'stage_request_id') !== rowString(parent, 'stage_request_id')
    || rowString(sourceSnapshot, 'preflight_id') !== preflightId
    || rowString(sourceSnapshot, 'policy_hash') !== rowString(preflight, 'policy_hash')
    || rowString(preflight, 'intent_id') !== rowString(root, 'intent_id')) return false;
  const stageRequestId = hashV1({ r: 'stage-request/v1', workspaceId: actor.workspaceId, rootRequestId: root.root_request_id, rootGeneration: root.root_generation, attemptStage: 'judge', retryGeneration: 0, childOrdinal: 1 });
  const operationRequestId = hashV1({ r: 'operation-request/v1', workspaceId: actor.workspaceId, stageRequestId, operation: 'judge' });
  const claimId = hashV1({ r: 'stage-claim/v1', workspaceId: actor.workspaceId, stageRequestId });
  const claimScopeKey = `${root.manager_task_id}:${root.orchestration_id}:judge`;
  const logicalInputHash = hashV1({ r: 'judge/logical-input/v1', workspaceId: actor.workspaceId, rootRequestId: root.root_request_id, sourceSnapshotHash, preflightId });
  insertIdentity(database, actor.workspaceId, 'stage-request/v1', { r: 'stage-request/v1', workspaceId: actor.workspaceId, rootRequestId: root.root_request_id, attemptStage: 'judge', retryGeneration: 0, childOrdinal: 1 }, stageRequestId, pair.utc);
  insertIdentity(database, actor.workspaceId, 'operation-request/v1', { r: 'operation-request/v1', workspaceId: actor.workspaceId, stageRequestId, operation: 'judge' }, operationRequestId, pair.utc);
  insertIdentity(database, actor.workspaceId, 'stage-claim/v1', { r: 'stage-claim/v1', workspaceId: actor.workspaceId, stageRequestId }, claimId, pair.utc);
  const nextParentRevision = rowNumber(parent, 'claim_revision') + 1;
  database.prepare(`UPDATE daily_stage_claims SET status='succeeded',is_active=0,claim_revision=?,result_json=?,updated_at=?,finished_at=?
    WHERE workspace_id=? AND stage_request_id=? AND claim_revision=? AND is_active=1 AND status='awaiting_judge'`).run(nextParentRevision, canonicalValue({ reasonCode: 'HANDOFF_CONSUMED', sourceSnapshotHash, judgeStageRequestId: stageRequestId }), pair.utc, pair.utc, actor.workspaceId, parent.stage_request_id, rowNumber(parent, 'claim_revision'));
  database.prepare(`INSERT INTO daily_stage_claims (
    claim_id,workspace_id,claim_kind,cycle_id,gap_id,claim_scope_key,stage_request_id,request_id,root_request_id,root_generation,root_input_hash,manager_task_id,orchestration_id,parent_task_id,parent_stage_request_id,root_mode,attempt_stage,retry_generation,logical_input_hash,status,is_active,claim_revision,owner_epoch,lease_token,lease_expires_at,lease_expires_at_utc,lease_expires_at_mono,stage_deadline_utc,stage_deadline_mono,control_stall_deadline_utc,control_stall_deadline_mono,snapshot_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    claimId, actor.workspaceId, 'daily', null, null, claimScopeKey, stageRequestId, operationRequestId, root.root_request_id, root.root_generation, root.root_input_hash,
    root.manager_task_id, root.orchestration_id, parent.parent_task_id ?? root.manager_task_id, parent.stage_request_id, root.root_mode, 'judge', 0, logicalInputHash, 'dispatching_judge', 1, 0,
    actor.ownerEpoch, actor.leaseToken, actor.leaseExpiresAtUtc, actor.leaseExpiresAtUtc, actor.leaseExpiresAtMono, root.gate_deadline_utc, root.gate_deadline_mono,
    actor.controlStallDeadlineUtc, actor.controlStallDeadlineMono, canonicalValue({ sourceSnapshotHash, preflightId, handoff: true }), pair.utc, pair.utc);
  const envelope = {
    version: 'ExecutionEnvelopeV2', workspaceId: actor.workspaceId, rootRequestId: root.root_request_id, rootGeneration: root.root_generation,
    rootInputHash: root.root_input_hash, managerTaskId: root.manager_task_id, orchestrationId: root.orchestration_id, parentTaskId: parent.parent_task_id ?? root.manager_task_id,
    parentStageRequestId: parent.stage_request_id, stageRequestId, retryGeneration: 0, roleId: 'judge', operationRequestId, sourceSnapshotHash,
    preflightId, policyHash: preflight.policy_hash, ownerEpoch: actor.ownerEpoch, runtimeEpoch: actor.runtimeEpoch, checkpointRevision: actor.checkpointRevision,
    handoffIdentity: hashV1({ r: 'f-to-j-handoff/v1', parentStageRequestId: parent.stage_request_id, sourceSnapshotHash, preflightId })
  };
  const reserve = reserveManagedDispatchInTransaction(database, {
    workspaceId: actor.workspaceId, fence: fenceOf(actor), rootRequestId: String(root.root_request_id), rootGeneration: rowNumber(root, 'root_generation'), rootInputHash: String(root.root_input_hash),
    managerTaskId: String(root.manager_task_id), orchestrationId: String(root.orchestration_id), parentTaskId: String(parent.parent_task_id ?? root.manager_task_id), parentStageRequestId: String(parent.stage_request_id),
    stageRequestId, retryGeneration: 0, roleId: 'judge', childOrdinal: 1, operationRequestId, envelope, argvHash: hashV1(['judge']), cwdFingerprint: hashV1(process.cwd()),
    sessionKey: `workspace:${actor.workspaceId}:judge`, nowUtc: pair.utc, nowMono: pair.mono, leaseExpiresAtUtc: actor.leaseExpiresAtUtc!, leaseExpiresAtMono: actor.leaseExpiresAtMono!,
    spawnDeadlineUtc: root.gate_deadline_utc as string, spawnDeadlineMono: rowNumber(root, 'gate_deadline_mono'), expectedParentClaimRevision: nextParentRevision
  } as never);
  if (!reserve.ok) throw new RecoveryError(reserve.code, reserve.message, { reserve });
  database.prepare(`UPDATE daily_orchestration_roots SET status='running',checkpoint_revision=?,updated_at=?,last_business_progress_at=?
    WHERE workspace_id=? AND root_request_id=? AND status IN ('created','running','waiting_owner')`).run(actor.checkpointRevision, pair.utc, pair.utc, actor.workspaceId, root.root_request_id);
  database.prepare(`UPDATE orchestrator_intents SET status='running',checkpoint_revision=?,updated_at=? WHERE workspace_id=? AND intent_id=? AND status NOT IN ('succeeded','partial','failed','needs_user','cancelled')`).run(actor.checkpointRevision, pair.utc, actor.workspaceId, root.intent_id);
  appendEvent(database, actor, pair, 'stage.handoff_f_to_j', hashV1({ r: 'f-to-j-handoff/v1', workspaceId: actor.workspaceId, rootRequestId: root.root_request_id, parentStageRequestId: parent.stage_request_id, sourceSnapshotHash, preflightId }), { parentStageRequestId: parent.stage_request_id, judgeStageRequestId: stageRequestId, sourceSnapshotHash, preflightId });
  return true;
}

export function reconcileWorkspaceOrchestratorStartup(database: DatabaseSync, input: RecoveryFenceInput): Record<string, unknown> {
  const raw = input as AnyInput;
  const pair = nowPair(raw);
  try {
    const startup = withTransaction(database, () => {
      let actor = requireActor(database, input.workspaceId, raw, pair);
      const migration = exactMigration(database, actor);
      const reasons: string[] = [];
      const actions: string[] = [];
      if (!migration) reasons.push('current migration row missing');
      else if (rowString(migration, 'status') !== 'complete' || rowNumber(migration, 'schema_epoch') !== CURRENT_SCHEMA_EPOCH || rowString(migration, 'write_fence') !== 'allow') reasons.push('current migration is not complete/allow for schema 80');
      let touched = false;
      const touch = () => { if (!touched) { actor = touchActor(database, actor, pair, actor.writeFence, true); touched = true; } return actor; };
      if (reasons.length === 0) {
        const roots = database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=? ORDER BY root_generation,root_request_id').all(input.workspaceId) as Row[];
        for (const root of roots) {
          const status = rowString(root, 'status');
          if (!ACTIVE_ROOT_STATUSES[status]) continue;
          const cancellation = intentRootCancellation(database, root);
          if (cancellation) {
            touch();
            cancelRootBundle(database, actor, root, pair, cancellation, input.crashBarrier);
            actions.push(`cancelled:${root.root_request_id}:${cancellation}`);
            continue;
          }
          const rootDeadlineMono = rowNumber(root, 'root_deadline_mono');
          if (rootDeadlineMono > 0 && pair.mono >= rootDeadlineMono) {
            touch();
            cancelRootBundle(database, actor, root, pair, 'ROOT_DEADLINE_EXPIRED', input.crashBarrier);
            actions.push(`cancelled:${root.root_request_id}:ROOT_DEADLINE_EXPIRED`);
            continue;
          }
          const dispatches = activeDispatches(database, input.workspaceId, rowString(root, 'root_request_id'));
          let adoptable = true;
          for (const dispatch of dispatches) {
            const inventory = findExactInventory(database, input.workspaceId, dispatch);
            if (!inventory || !dispatchInventoryMatches(dispatch, inventory)) {
              adoptable = false;
              reasons.push(`dispatch ${rowString(dispatch, 'job_id')} inventory proof missing or drifted`);
              continue;
            }
            if (TERMINAL_INVENTORY_STATES[rowString(inventory, 'state')]) {
              touch();
              database.prepare(`UPDATE managed_job_dispatches SET state='orphaned',result_status='orphaned',result_hash=?,result_json=?,updated_at=?,finished_at=?
                WHERE workspace_id=? AND job_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')`).run(hashV1({ r: 'dispatch-orphaned-terminal-inventory/v1', inventoryId: inventory.inventory_id }), canonicalValue({ reasonCode: 'TERMINAL_INVENTORY' }), pair.utc, pair.utc, input.workspaceId, dispatch.job_id);
              actions.push(`orphaned:${dispatch.job_id}`);
              adoptable = false;
              continue;
            }
            touch();
            adoptDispatch(database, actor, dispatch, inventory, pair);
            actions.push(`adopted:${dispatch.job_id}`);
          }
          if (!adoptable) continue;
          touch();
          updateRootOwnership(database, actor, root, pair);
          adoptClaims(database, actor, rowString(root, 'root_request_id'), pair);
          const fClaims = database.prepare(`SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? AND attempt_stage<>'judge' AND status='awaiting_judge' AND is_active=1 ORDER BY stage_request_id`).all(input.workspaceId, root.root_request_id) as Row[];
          for (const parent of fClaims) {
            try {
              if (handoffJudge(database, actor, root, parent, pair)) actions.push(`handoff:${parent.stage_request_id}`);
              else reasons.push(`F awaiting_judge ${parent.stage_request_id} lacks exact snapshot/preflight identity`);
            } catch (error) {
              reasons.push(`F awaiting_judge ${parent.stage_request_id} handoff failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        const activeClaims = database.prepare(`SELECT * FROM daily_stage_claims WHERE workspace_id=? AND is_active=1 AND status IN ('claimed_unbound','claimed','dispatching_scan','snapshot_frozen','awaiting_judge','dispatching_judge','manifest_frozen','dispatching','settling','running') ORDER BY root_request_id,stage_request_id`).all(input.workspaceId) as Row[];
        for (const claim of activeClaims) {
          const root = database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?').get(input.workspaceId, claim.root_request_id) as Row | undefined;
          if (!root || !ACTIVE_ROOT_STATUSES[rowString(root, 'status')]) {
            touch();
            database.prepare(`UPDATE daily_stage_claims SET status='orphaned',is_active=0,claim_revision=claim_revision+1,result_json=?,updated_at=?,finished_at=?
              WHERE workspace_id=? AND stage_request_id=? AND is_active=1`).run(canonicalValue({ reasonCode: 'ORPHANED_ROOT' }), pair.utc, pair.utc, input.workspaceId, claim.stage_request_id);
            actions.push(`orphaned-claim:${claim.stage_request_id}`);
          }
        }
        const activeConsumptions = database.prepare(`SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND state IN ('reserved','consuming','unknown') ORDER BY root_request_id,consumption_id`).all(input.workspaceId) as Row[];
        for (const consumption of activeConsumptions) {
          const root = database.prepare('SELECT status FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?').get(input.workspaceId, consumption.root_request_id) as Row | undefined;
          const dispatch = database.prepare('SELECT state FROM managed_job_dispatches WHERE workspace_id=? AND job_id=?').get(input.workspaceId, consumption.source_dispatch_job_id) as Row | undefined;
          if (!root || rowString(root, 'status') === 'cancelled' || !dispatch || rowString(dispatch, 'state') === 'orphaned') {
            touch();
            database.prepare(`UPDATE managed_effect_consumptions SET state='orphaned',error_json=?,updated_at=?,finished_at=? WHERE workspace_id=? AND consumption_id=? AND state IN ('reserved','consuming','unknown')`).run(canonicalValue({ reasonCode: 'ORPHANED_DEPENDENCY' }), pair.utc, pair.utc, input.workspaceId, consumption.consumption_id);
            actions.push(`orphaned-consumption:${consumption.consumption_id}`);
          }
        }
        const allRoots = database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=? ORDER BY root_generation,root_request_id').all(input.workspaceId) as Row[];
        for (const root of allRoots) {
          const rebuilt = rebuildActiveRootIndex(database, actor, root, pair);
          if (rebuilt.maintenance) reasons.push(rebuilt.maintenance);
          if (rebuilt.changed) {
            touch();
            const indexIdentity = hashV1({ r: 'active-root-index-rebuild/v1', workspaceId: input.workspaceId, rootRequestId: root.root_request_id, rootGeneration: root.root_generation, checkpointRevision: actor.checkpointRevision });
            appendEvent(database, actor, pair, 'active_root_index.rebuild_requested', `${indexIdentity}:requested`, { rootRequestId: root.root_request_id, rootGeneration: root.root_generation });
            appendEvent(database, actor, pair, 'active_root_index.rebuilt', `${indexIdentity}:rebuilt`, { rootRequestId: root.root_request_id, rootGeneration: root.root_generation });
            actions.push(`index-rebuilt:${root.root_request_id}`);
          }
        }
      }
      const status: RecoveryStatus = reasons.length > 0 ? 'maintenance' : 'complete';
      if (status === 'maintenance' && actor.writeFence === 'allow') {
        actor = touchActor(database, actor, pair, 'maintenance', true);
        touched = true;
      } else if (!touched) touch();
      const event = appendEvent(database, actor, pair, `startup_reconcile.${status}`, hashV1({ r: 'startup-reconcile/v1', workspaceId: input.workspaceId, runtimeEpoch: actor.runtimeEpoch, checkpointRevision: actor.checkpointRevision, status, actions, reasons }), { status, actions, reasons, schemaEpoch: CURRENT_SCHEMA_EPOCH });
      const readback = readRecoveryBundle(database, input.workspaceId);
      return Object.freeze({ ok: status === 'complete', status, code: status === 'complete' ? null : 'STARTUP_RECONCILE_MAINTENANCE', reasonCode: status === 'complete' ? null : 'STARTUP_RECONCILE_MAINTENANCE', message: status === 'complete' ? null : reasons.join('; '), fence: fenceOf(actor), event, actions, maintenanceReasons: reasons, readback });
    });
    const preflightRecovery = reconcileWorkspaceOrchestratorPreflightStartup(database, { ...input, fence: startup.fence as ActorFence });
    return Object.freeze({ ...startup, preflightRecovery });
  } catch (error) { return errorResult(error, 'failed'); }
}

export type PreflightStartupRecoveryInput = Readonly<RecoveryFenceInput & {
  preflightId?: string;
  intentId?: string;
  interrupted?: boolean;
}>;

export function recoverWorkspaceOrchestratorPreflight(database: DatabaseSync, input: PreflightStartupRecoveryInput): PreflightRecoveryResult {
  const pair = nowPair(input as AnyInput);
  const actorStore = createWorkspaceOrchestratorActorStore(database, { nowUtc: () => pair.utc, nowMono: () => pair.mono, crashBarrier: input.crashBarrier });
  return actorStore.recoverPreflight({
    workspaceId: input.workspaceId, preflightId: input.preflightId, intentId: input.intentId, interrupted: input.interrupted,
    fence: input.fence, nowUtc: pair.utc, nowMono: pair.mono, startup: false
  });
}

export function watchdogWorkspaceOrchestratorPreflight(database: DatabaseSync, input: PreflightStartupRecoveryInput): PreflightRecoveryResult {
  return recoverWorkspaceOrchestratorPreflight(database, input);
}

export function reconcileWorkspaceOrchestratorPreflightStartup(database: DatabaseSync, input: RecoveryFenceInput): Record<string, unknown> {
  const pair = nowPair(input as AnyInput);
  let fence: ActorFence = input.fence;
  const actions: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  const rows = database.prepare(`SELECT cps.preflight_id
    FROM channel_preflight_snapshots cps JOIN orchestrator_intents oi ON oi.workspace_id=cps.workspace_id AND oi.intent_id=cps.intent_id
    WHERE cps.workspace_id=? AND cps.status='frozen' AND oi.status IN ('received','preflight_pending','preflight_running','waiting_resource','running')
    ORDER BY cps.created_at,cps.preflight_id`).all(input.workspaceId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const result = recoverWorkspaceOrchestratorPreflight(database, { ...input, fence, preflightId: String(row.preflight_id), nowUtc: pair.utc, nowMono: pair.mono });
    actions.push(result);
    if (result.fence) fence = result.fence;
    if (!result.ok) failures.push(result);
  }
  return Object.freeze({ ok: failures.length === 0, status: failures.length === 0 ? 'complete' : 'maintenance', code: failures.length === 0 ? null : 'PREFLIGHT_RECOVERY_MAINTENANCE', reasonCode: failures.length === 0 ? null : 'PREFLIGHT_RECOVERY_MAINTENANCE', workspaceId: input.workspaceId, fence, actions: Object.freeze(actions), failures: Object.freeze(failures) });
}

function readRollbackRow(database: DatabaseSync, workspaceId: string, rollbackEpoch: number): Row | null {
  return database.prepare('SELECT * FROM workspace_rollback_state WHERE workspace_id=? AND rollback_epoch=?').get(workspaceId, rollbackEpoch) as Row | undefined ?? null;
}

function rollbackReadback(row: Row | null): Record<string, unknown> | null {
  if (!row) return null;
  return Object.freeze({
    workspaceId: rowString(row, 'workspace_id'), rollbackEpoch: rowNumber(row, 'rollback_epoch'), sourceMigrationEpoch: rowNumber(row, 'source_migration_epoch'),
    targetBuildManifestHash: rowString(row, 'target_build_manifest_hash'), targetSchemaEpoch: rowNumber(row, 'target_schema_epoch'), targetMinSupportedBuild: rowString(row, 'target_min_supported_build'),
    targetCutoverEpoch: rowNumber(row, 'target_cutover_epoch'), status: rowString(row, 'status'), startedAtUtc: rowString(row, 'started_at_utc'), startedAtMono: rowNumber(row, 'started_at_mono'),
    barrierReceiptHash: rowString(row, 'barrier_receipt_hash'), reason: row[rowKey('reason')] ?? null, finishedAtUtc: row[rowKey('finished_at_utc')] ?? null, finishedAtMono: row[rowKey('finished_at_mono')] ?? null
  });
}

export function requestWorkspaceRollback(database: DatabaseSync, input: RollbackRequestInput): Record<string, unknown> {
  const raw = input as AnyInput;
  const pair = nowPair(raw);
  try {
    return withTransaction(database, () => {
      let actor = requireActor(database, input.workspaceId, raw, pair);
      const sourceMigrationEpoch = input.sourceMigrationEpoch ?? actor.migrationEpoch;
      if (sourceMigrationEpoch !== actor.migrationEpoch) throw new RecoveryError('STATE_CONFLICT', 'rollback sourceMigrationEpoch 必须精确匹配当前 migration epoch。');
      const migration = exactMigration(database, actor);
      if (!migration) throw new RecoveryError('WORKSPACE_STALE', 'rollback source migration 不存在。');
      const existing = database.prepare(`SELECT * FROM workspace_rollback_state WHERE workspace_id=? AND status IN ('requested','fencing','draining','verifying')`).get(input.workspaceId) as Row | undefined;
      const barrier = hashV1({ r: 'rollback-barrier/v1', workspaceId: input.workspaceId, sourceMigrationEpoch, targetBuildManifestHash: input.targetBuildManifestHash, targetSchemaEpoch: input.targetSchemaEpoch, targetMinSupportedBuild: input.targetMinSupportedBuild, targetCutoverEpoch: input.targetCutoverEpoch });
      if (existing) {
        const same = rowNumber(existing, 'source_migration_epoch') === sourceMigrationEpoch && rowString(existing, 'target_build_manifest_hash') === input.targetBuildManifestHash
          && rowNumber(existing, 'target_schema_epoch') === input.targetSchemaEpoch && rowString(existing, 'target_min_supported_build') === input.targetMinSupportedBuild && rowNumber(existing, 'target_cutover_epoch') === input.targetCutoverEpoch;
        if (same) return Object.freeze({ ok: true, status: rowString(existing, 'status'), replayed: true, rollback: rollbackReadback(existing), fence: fenceOf(actor), readback: readRecoveryBundle(database, input.workspaceId) });
        actor = touchActor(database, actor, pair, 'maintenance');
        const update = database.prepare(`UPDATE workspace_rollback_state SET status='maintenance',reason=?,finished_at_utc=?,finished_at_mono=?
          WHERE workspace_id=? AND rollback_epoch=? AND status IN ('requested','fencing','draining','verifying')`).run('ROLLBACK_REQUEST_CONFLICT', pair.utc, pair.mono, input.workspaceId, existing.rollback_epoch);
        if (Number(update.changes ?? 0) !== 1) throw new RecoveryError('STATE_CONFLICT', 'rollback conflict maintenance CAS 失败。');
        const event = appendEvent(database, actor, pair, 'rollback.request_conflict', hashV1({ r: 'rollback-request-conflict/v1', workspaceId: input.workspaceId, rollbackEpoch: existing.rollback_epoch }), { requested: input, existing: rollbackReadback(existing) });
        return Object.freeze({ ok: false, status: 'maintenance', code: 'ROLLBACK_REQUEST_CONFLICT', reasonCode: 'ROLLBACK_REQUEST_CONFLICT', message: 'active rollback barrier 已绑定不同 target。', fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
      }
      const rollbackEpoch = rowNumber(database.prepare('SELECT COALESCE(MAX(rollback_epoch),0) AS value FROM workspace_rollback_state WHERE workspace_id=?').get(input.workspaceId) as Row, 'value') + 1;
      database.prepare(`INSERT INTO workspace_rollback_state (
        workspace_id,rollback_epoch,source_migration_epoch,target_build_manifest_hash,target_schema_epoch,target_min_supported_build,target_cutover_epoch,status,started_at_utc,started_at_mono,barrier_receipt_hash,reason
      ) VALUES (?,?,?,?,?,?,?,'requested',?,?,?,?)`).run(input.workspaceId, rollbackEpoch, sourceMigrationEpoch, input.targetBuildManifestHash, input.targetSchemaEpoch, input.targetMinSupportedBuild, input.targetCutoverEpoch, pair.utc, pair.mono, barrier, input.reason ?? null);
      actor = touchActor(database, actor, pair, 'deny');
      const row = readRollbackRow(database, input.workspaceId, rollbackEpoch)!;
      const event = appendEvent(database, actor, pair, 'rollback.requested', hashV1({ r: 'rollback-request/v1', workspaceId: input.workspaceId, rollbackEpoch, barrier }), { rollback: rollbackReadback(row) });
      return Object.freeze({ ok: true, status: 'requested', replayed: false, rollback: rollbackReadback(row), fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
    });
  } catch (error) { return errorResult(error, 'maintenance'); }
}

function allInventoryDrained(database: DatabaseSync, workspaceId: string): { drained: boolean; active: Row[] } {
  const active = database.prepare(`SELECT * FROM workspace_legacy_runtime_inventory WHERE workspace_id=? AND state NOT IN ('exited','closed','cleaned','authorization_rejected','orphaned') ORDER BY inventory_id`).all(workspaceId) as Row[];
  return { drained: active.length === 0, active };
}

function rollbackCompatibility(database: DatabaseSync, input: RollbackAdvanceInput, row: Row): { ok: boolean; reason: string | null } {
  if (typeof input.compatibility === 'boolean') return { ok: input.compatibility, reason: input.compatibility ? null : 'explicit compatibility proof rejected' };
  const proof = parseObject(input.compatibility);
  if (proof.ok === false || proof.compatible === false) return { ok: false, reason: String(proof.reason ?? 'compatibility proof rejected') };
  const target = database.prepare('SELECT * FROM build_manifests WHERE manifest_hash=?').get(row.target_build_manifest_hash) as Row | undefined;
  if (!target) return { ok: false, reason: 'target build manifest missing' };
  if (rowNumber(target, 'schema_epoch') !== rowNumber(row, 'target_schema_epoch') || rowNumber(target, 'cutover_epoch') !== rowNumber(row, 'target_cutover_epoch')) return { ok: false, reason: 'target manifest schema/cutover mismatch' };
  return { ok: true, reason: null };
}

export function advanceWorkspaceRollback(database: DatabaseSync, input: RollbackAdvanceInput): Record<string, unknown> {
  const raw = input as AnyInput;
  const pair = nowPair(raw);
  try {
    return withTransaction(database, () => {
      let actor = requireActor(database, input.workspaceId, raw, pair, true);
      const row = readRollbackRow(database, input.workspaceId, input.rollbackEpoch);
      if (!row) throw new RecoveryError('NOT_FOUND', 'rollback barrier 不存在。');
      const current = rowString(row, 'status') as RollbackStatus;
      if (TERMINAL_ROLLBACK_STATES[current]) {
        if (!input.status || input.status === current) {
          const gate = readRuntimeGate(database, input.workspaceId, actor.runtimeEpoch);
          const event = current === 'complete'
            ? readEvent(database, input.workspaceId, 'rollback.complete', hashV1({ r: 'rollback-transition/v1', workspaceId: input.workspaceId, rollbackEpoch: input.rollbackEpoch, status: 'complete' }))
            : null;
          return Object.freeze({ ok: true, status: current, replayed: true, rollback: rollbackReadback(row), fence: fenceOf(actor), gate: gateReadback(gate), event, readback: readRecoveryBundle(database, input.workspaceId) });
        }
        throw new RecoveryError('STATE_CONFLICT', 'terminal rollback barrier 不可回退。', { rollback: rollbackReadback(row) });
      }

      const inferred: RollbackStatus = input.status ?? (current === 'requested' ? 'fencing' : current === 'fencing' ? 'draining' : current === 'draining' ? 'verifying' : 'complete');
      if (!['fencing', 'draining', 'verifying', 'complete', 'maintenance', 'rollback_required'].includes(inferred)) throw new RecoveryError('ORCHESTRATOR_CONTRACT_ERROR', `非法 rollback status: ${inferred}`);
      const order: Record<string, string[]> = { requested: ['fencing', 'maintenance'], fencing: ['draining', 'maintenance'], draining: ['verifying', 'maintenance'], verifying: ['complete', 'rollback_required', 'maintenance'] };
      if (!(order[current] ?? []).includes(inferred)) throw new RecoveryError('STATE_CONFLICT', `rollback barrier 不允许 ${current} -> ${inferred}。`);
      if (inferred === 'draining') {
        database.prepare(`UPDATE workspace_legacy_runtime_inventory SET state='draining',updated_at=? WHERE workspace_id=? AND state IN ('registered','running')`).run(pair.utc, input.workspaceId);
      }
      if (inferred === 'verifying') {
        const pending = allInventoryDrained(database, input.workspaceId);
        if (!pending.drained) {
          database.prepare(`UPDATE workspace_rollback_state SET status='maintenance',reason=?,finished_at_utc=?,finished_at_mono=? WHERE workspace_id=? AND rollback_epoch=? AND status='draining'`).run('ROLLBACK_INVENTORY_NOT_DRAINED', pair.utc, pair.mono, input.workspaceId, input.rollbackEpoch);
          actor = touchActor(database, actor, pair, 'maintenance');
          const maintenance = readRollbackRow(database, input.workspaceId, input.rollbackEpoch)!;
          const event = appendEvent(database, actor, pair, 'rollback.maintenance', hashV1({ r: 'rollback-maintenance/v1', workspaceId: input.workspaceId, rollbackEpoch: input.rollbackEpoch, reason: 'ROLLBACK_INVENTORY_NOT_DRAINED' }), { rollback: rollbackReadback(maintenance), activeInventory: pending.active.map(inventoryReadback) });
          return Object.freeze({ ok: true, status: 'maintenance', code: 'ROLLBACK_INVENTORY_NOT_DRAINED', reasonCode: 'ROLLBACK_INVENTORY_NOT_DRAINED', rollback: rollbackReadback(maintenance), fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
        }
      }
      if (inferred === 'complete' || inferred === 'rollback_required') {
        const pending = allInventoryDrained(database, input.workspaceId);
        if (!pending.drained) {
          database.prepare(`UPDATE workspace_rollback_state SET status='maintenance',reason=?,finished_at_utc=?,finished_at_mono=? WHERE workspace_id=? AND rollback_epoch=? AND status='verifying'`).run('ROLLBACK_INVENTORY_NOT_DRAINED', pair.utc, pair.mono, input.workspaceId, input.rollbackEpoch);
          actor = touchActor(database, actor, pair, 'maintenance');
          const maintenance = readRollbackRow(database, input.workspaceId, input.rollbackEpoch)!;
          const event = appendEvent(database, actor, pair, 'rollback.maintenance', hashV1({ r: 'rollback-maintenance-v1', workspaceId: input.workspaceId, rollbackEpoch: input.rollbackEpoch, reason: 'ROLLBACK_INVENTORY_NOT_DRAINED' }), { rollback: rollbackReadback(maintenance) });
          return Object.freeze({ ok: true, status: 'maintenance', code: 'ROLLBACK_INVENTORY_NOT_DRAINED', reasonCode: 'ROLLBACK_INVENTORY_NOT_DRAINED', rollback: rollbackReadback(maintenance), fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
        }
        const compatibility = rollbackCompatibility(database, input, row);
        if (inferred === 'complete' && !compatibility.ok) {
          database.prepare(`UPDATE workspace_rollback_state SET status='rollback_required',reason=?,finished_at_utc=?,finished_at_mono=? WHERE workspace_id=? AND rollback_epoch=? AND status='verifying'`).run(compatibility.reason ?? 'ROLLBACK_COMPATIBILITY_FAILED', pair.utc, pair.mono, input.workspaceId, input.rollbackEpoch);
          actor = touchActor(database, actor, pair, 'maintenance');
          const required = readRollbackRow(database, input.workspaceId, input.rollbackEpoch)!;
          const event = appendEvent(database, actor, pair, 'rollback.rollback_required', hashV1({ r: 'rollback-required/v1', workspaceId: input.workspaceId, rollbackEpoch: input.rollbackEpoch, reason: compatibility.reason }), { rollback: rollbackReadback(required) });
          return Object.freeze({ ok: true, status: 'rollback_required', code: 'ROLLBACK_COMPATIBILITY_FAILED', reasonCode: 'ROLLBACK_COMPATIBILITY_FAILED', rollback: rollbackReadback(required), fence: fenceOf(actor), event, readback: readRecoveryBundle(database, input.workspaceId) });
        }
      }
      const terminal = inferred === 'complete' || inferred === 'maintenance' || inferred === 'rollback_required';
      const nextFence = inferred === 'complete' ? 'allow' : terminal ? 'maintenance' : actor.writeFence;
      const gatePredecessor = inferred === 'complete' ? readRuntimeGate(database, input.workspaceId, actor.runtimeEpoch) : null;
      database.prepare(`UPDATE workspace_rollback_state SET status=?,reason=?,finished_at_utc=?,finished_at_mono=? WHERE workspace_id=? AND rollback_epoch=? AND status=?`).run(
        inferred, input.reason ?? null, terminal ? pair.utc : null, terminal ? pair.mono : null, input.workspaceId, input.rollbackEpoch, current);
      actor = touchActor(database, actor, pair, nextFence, inferred === 'complete' ? 'complete' : false);
      const next = readRollbackRow(database, input.workspaceId, input.rollbackEpoch)!;
      const gate = inferred === 'complete' ? readRuntimeGate(database, input.workspaceId, actor.runtimeEpoch) : null;
      const gateRebinding = inferred === 'complete' ? Object.freeze({
        applied: true,
        runtimeEpoch: actor.runtimeEpoch,
        ownerEpoch: actor.ownerEpoch,
        leaseToken: actor.leaseToken,
        status: 'complete',
        checkpointPredecessor: gatePredecessor ? rowNumber(gatePredecessor, 'checkpoint_revision') : null,
        checkpointRevision: gate ? rowNumber(gate, 'checkpoint_revision') : null,
        predecessor: gateReadback(gatePredecessor),
        current: gateReadback(gate)
      }) : null;
      const event = appendEvent(database, actor, pair, `rollback.${inferred}`, hashV1({ r: 'rollback-transition/v1', workspaceId: input.workspaceId, rollbackEpoch: input.rollbackEpoch, status: inferred }), {
        rollback: rollbackReadback(next),
        ...(gateRebinding ? { gateRebinding } : {})
      });
      return Object.freeze({ ok: true, status: inferred, replayed: false, rollback: rollbackReadback(next), fence: fenceOf(actor), gate: gateReadback(gate), gateRebinding, event, readback: readRecoveryBundle(database, input.workspaceId) });
    });
  } catch (error) { return errorResult(error, 'maintenance'); }
}

export function readWorkspaceRollbackState(database: DatabaseSync, input: { workspaceId: string; rollbackEpoch: number }): Record<string, unknown> | null {
  const row = readRollbackRow(database, input.workspaceId, input.rollbackEpoch);
  return rollbackReadback(row);
}

function dispatchInventoryMatches(dispatch: Row, inventory: Row): boolean {
  return dispatchInventoryMatchesInternal(dispatch, inventory);
}

function dispatchInventoryMatchesInternal(dispatch: Row, inventory: Row): boolean {
  const fields: Array<[string, string]> = [
    ['root_request_id', 'root_request_id'], ['stage_request_id', 'stage_request_id'], ['operation_request_id', 'operation_request_id'], ['job_id', 'job_id'],
    ['launch_attempt_id', 'launch_attempt_id'], ['session_key', 'session_key'], ['argv_hash', 'argv_hash']
  ];
  for (const [left, right] of fields) {
    if (dispatch[left] !== null && dispatch[left] !== undefined && String(dispatch[left]) !== String(inventory[right] ?? '')) return false;
  }
  const cwdFingerprint = dispatch.cwd_fingerprint;
  if (cwdFingerprint !== null && cwdFingerprint !== undefined && String(cwdFingerprint) !== hashV1(String(inventory.cwd ?? ''))) return false;
  for (const [left, right] of [['pid', 'pid'], ['process_start_time_utc', 'process_start_time_utc'], ['process_start_time_mono', 'process_start_time_mono']] as Array<[string, string]>) {
    if (dispatch[left] !== null && dispatch[left] !== undefined && String(dispatch[left]) !== String(inventory[right] ?? '')) return false;
  }
  return true;
}
