import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  canonicalJsonV1,
  hashV1,
  readWorkspaceOrchestratorActor,
  sha256Hex,
  type ActorFence,
  type WorkspaceOrchestratorActor
} from './workspace-orchestrator-actor.ts';

export const RESOURCE_ADMISSION_SCHEMA_VERSION = 79;
export const RESOURCE_ACTIVE_STATES = Object.freeze([
  'reserved',
  'task_bound',
  'spawn_uncertain',
  'spawn_started',
  'running'
] as const);
export const RESOURCE_TERMINAL_STATES = Object.freeze(['terminal', 'cancelled', 'orphaned'] as const);
export const RESOURCE_ROLES = Object.freeze(['reporter', 'judge', 'research', 'planner', 'writer'] as const);

export type WorkspaceOrchestratorResourceRole = (typeof RESOURCE_ROLES)[number];
export type ManagedJobDispatchState = (typeof RESOURCE_ACTIVE_STATES)[number] | (typeof RESOURCE_TERMINAL_STATES)[number];
export type ResourceAdmissionStatus = 'reserved' | 'waiting_resource' | 'task_bound' | 'spawn_uncertain' | 'running' | 'terminal' | 'cancelled' | 'orphaned' | 'adopted';
export type ResourceFenceInput = ActorFence | Readonly<{ fence: ActorFence }>;


export type ResourceAcceptanceProvenance = Readonly<{
  acceptanceRunId: string;
  baselineEventSequence: number;
  baselineCheckpointRevision: number;
  createdAfterEventSequence: number;
  createdAfterCheckpointRevision: number;
  createdAfterMono: number;
}>;

type ResourceAcceptanceInput = Readonly<{
  acceptance?: Partial<ResourceAcceptanceProvenance> | null;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
}>;

export type ReserveManagedDispatchInput = ResourceAcceptanceInput & Readonly<{
  workspaceId: string;
  fence?: ResourceFenceInput;
  actorFence?: ActorFence;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  managerTaskId: string;
  orchestrationId: string;
  parentTaskId: string;
  parentStageRequestId: string;
  stageRequestId: string;
  retryGeneration: number;
  roleId: WorkspaceOrchestratorResourceRole;
  childOrdinal: number;
  operationRequestId: string;
  envelope: Readonly<Record<string, unknown>>;
  argvHash: string;
  cwdFingerprint: string;
  sessionKey: string;
  nowUtc: string;
  nowMono: number;
  leaseExpiresAtUtc: string;
  leaseExpiresAtMono: number;
  spawnDeadlineUtc: string;
  spawnDeadlineMono: number;
}>;

export type ResourceProcessInventory = Readonly<{
  workspaceId?: string;
  launchAttemptId?: string;
  launchTokenHash?: string;
  processHandle?: string | null;
  pid?: number | null;
  processStartTimeUtc?: string | null;
  processStartTimeMono?: number | null;
  argvHash?: string;
  cwdFingerprint?: string;
  sessionKey?: string;
  parentPid?: number | null;
  parentStartTimeUtc?: string | null;
  parentStartTimeMono?: number | null;
  parentLaunchAttemptId?: string | null;
  sessionProof?: boolean;
  startTimeProof?: boolean;
  parentProof?: boolean;
  [key: string]: unknown;
}>;

export type ManagedJobDispatchReadback = Readonly<{
  jobId: string;
  workspaceId: string;
  childIdentityKey: string;
  childOrdinal: number;
  roleId: WorkspaceOrchestratorResourceRole;
  operationRequestId: string;
  effectRequestId: string | null;
  managerTaskId: string;
  orchestrationId: string;
  parentTaskId: string;
  parentStageRequestId: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  preflightId: string;
  policyHash: string;
  stageRequestId: string;
  retryGeneration: number;
  expectedParentClaimRevision: number;
  expectedParentOwnerEpoch: number;
  expectedParentLeaseToken: string;
  launchAttemptId: string;
  launchTokenHash: string;
  processHandle: string | null;
  pid: number | null;
  processStartTimeUtc: string | null;
  processStartTimeMono: number | null;
  argvHash: string;
  cwdFingerprint: string;
  sessionKey: string;
  spawnDeadlineUtc: string;
  spawnDeadlineMono: number;
  registerAt: string | null;
  stdoutDrainWatermark: number;
  stderrDrainWatermark: number;
  state: ManagedJobDispatchState;
  resultStatus: string | null;
  resultHash: string | null;
  envelope: Readonly<Record<string, unknown>>;
  result: unknown;
  ownerEpoch: number;
  leaseToken: string;
  leaseExpiresAtUtc: string;
  leaseExpiresAtMono: number;
  acceptanceRunId: string | null;
  baselineEventSequence: number | null;
  baselineCheckpointRevision: number | null;
  createdAfterEventSequence: number | null;
  createdAfterCheckpointRevision: number | null;
  createdAfterMono: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}>;


export type ResourceAdmissionSuccess = Readonly<{
  ok: true;
  status: ResourceAdmissionStatus;
  reasonCode?: string;
  replayed?: boolean;
  dispatch: ManagedJobDispatchReadback;
  readback?: Readonly<Record<string, unknown>>;
}>;

export type ResourceAdmissionFailure = Readonly<{
  ok: false;
  status: 'rejected';
  code: string;
  reasonCode: string;
  message: string;
  readback?: unknown;
}>;

export type ResourceAdmissionResult = ResourceAdmissionSuccess | ResourceAdmissionFailure;
export type JudgeSchedulingInput = Readonly<{
  workspaceId: string;
  fence?: ResourceFenceInput;
  actorFence?: ActorFence;
  nowUtc: string;
  nowMono: number;
}>;

export type JudgeSchedulingReadback = Readonly<{
  workspaceId: string;
  roleId: 'judge';
  activeJudgeCount: number;
  activeJudgeJobId: string | null;
  orderedWaitingJudgeJobIds: readonly string[];
  winnerJobId: string | null;
}>;

export type JudgeSchedulingSuccess = Readonly<{
  ok: true;
  status: 'scheduled' | 'waiting_resource' | 'unchanged';
  reasonCode: string;
  replayed?: boolean;
  dispatch: ManagedJobDispatchReadback | null;
  readback: JudgeSchedulingReadback;
}>;

export type JudgeSchedulingResult = JudgeSchedulingSuccess | ResourceAdmissionFailure;


export type ResourceDispatchMutationInput = ResourceAcceptanceInput & Readonly<{
  workspaceId: string;
  fence?: ResourceFenceInput;
  actorFence?: ActorFence;
  jobId?: string;
  childIdentityKey?: string;
  operationRequestId?: string;
  parentStageRequestId?: string;
  expectedParentClaimRevision?: number;
  taskId?: string;
  agentTaskId?: string;
  launchAttemptId?: string;
  launchToken?: string;
  launchSecret?: string;
  launchTokenHash?: string;
  processHandle?: string | null;
  pid?: number | null;
  processStartTimeUtc?: string | null;
  processStartTimeMono?: number | null;
  argvHash?: string;
  cwdFingerprint?: string;
  sessionKey?: string;
  inventory?: ResourceProcessInventory | readonly ResourceProcessInventory[] | Readonly<{ processes?: readonly ResourceProcessInventory[]; known?: boolean }>;
  processInventory?: ResourceProcessInventory | readonly ResourceProcessInventory[] | Readonly<{ processes?: readonly ResourceProcessInventory[]; known?: boolean }>;
  inventoryKnown?: boolean;
  confirmedNoProcess?: boolean;
  spawnConfirmed?: boolean;
  terminationConfirmed?: boolean;
  drainConfirmed?: boolean;
  sessionClosed?: boolean;
  cwdCleaned?: boolean;
  terminalStatus?: string;
  resultStatus?: string;
  resultHash?: string | null;
  result?: unknown;
  resultJson?: unknown;
  reasonCode?: string;
  nowUtc?: string;
  nowMono?: number;
  [key: string]: unknown;
}>;

export type AdoptOrKillResult = ResourceAdmissionResult & Readonly<{
  action?: 'adopt' | 'kill_drain' | 'orphaned';
  requiredActions?: readonly string[];
}>;

class ResourceAdmissionError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ResourceAdmissionError';
    this.code = code;
    this.details = details;
  }
}

type Row = Record<string, unknown>;
type NormalizedReserve = {
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  managerTaskId: string;
  orchestrationId: string;
  parentTaskId: string;
  parentStageRequestId: string;
  stageRequestId: string;
  retryGeneration: number;
  roleId: WorkspaceOrchestratorResourceRole;
  childOrdinal: number;
  operationRequestId: string;
  effectRequestId: string | null;
  childIdentityKey: string;
  jobId: string;
  launchAttemptId: string;
  launchTokenHash: string;
  preflightId: string;
  policyHash: string;
  envelopeJson: string;
  envelope: Readonly<Record<string, unknown>>;
  argvHash: string;
  cwdFingerprint: string;
  sessionKey: string;
  nowUtc: string;
  nowMono: number;
  leaseExpiresAtUtc: string;
  leaseExpiresAtMono: number;
  spawnDeadlineUtc: string;
  spawnDeadlineMono: number;
  acceptance: ResourceAcceptanceProvenance | null;
};

type Context = {
  actor: WorkspaceOrchestratorActor;
  root: Row;
  stage: Row;
  parent: Row;
};

const ACTIVE_STATE_SQL = "'reserved','task_bound','spawn_uncertain','spawn_started','running'";
const TERMINAL_STATE_SQL = "'terminal','cancelled','orphaned'";
export const RESOURCE_JUDGE_AGING_QUANTUM_MS = 60_000;
const JUDGE_WAITING_REASON = 'RESOURCE_JUDGE_CAPACITY';
const JUDGE_PREEMPTED_REASON = 'JUDGE_PREEMPTED_FOR_HIGHER_PRIORITY';
const JUDGE_PROMOTED_REASON = 'JUDGE_WAITING_PROMOTED';
const JUDGE_BLOCKED_REASON = 'JUDGE_ACTIVE_NOT_PREEMPTABLE';
const JUDGE_ORDERED_BEHIND_REASON = 'JUDGE_WAITING_BEHIND_ACTIVE';
const JUDGE_NO_WAITING_REASON = 'JUDGE_NO_WAITING';

const REQUIRED_DRAIN_ACTIONS = Object.freeze([
  'stop_process',
  'drain_stdout',
  'drain_stderr',
  'close_session',
  'cleanup_cwd'
]);

function numberValue(value: unknown, fallback = 0): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function integerValue(value: unknown, name: string, minimum = 0): number {
  const n = Math.trunc(Number(value));
  if (!Number.isSafeInteger(n) || n < minimum) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', `${name} must be a non-negative integer.`);
  return n;
}

function requiredString(value: unknown, name: string): string {
  const result = String(value ?? '').trim();
  if (!result) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', `${name} is required.`);
  return result;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value);
}

function normalizeUtc(value: unknown, name: string): string {
  const candidate = requiredString(value, name);
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', `${name} must be a valid UTC instant.`);
  return parsed.toISOString();
}

function nowFor(options: { nowUtc: () => string; nowMono: () => number }, input: ResourceDispatchMutationInput | ReserveManagedDispatchInput): { utc: string; mono: number } {
  const mono = input.nowMono === undefined ? Number(options.nowMono()) : Number(input.nowMono);
  if (!Number.isFinite(mono) || mono < 0) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', 'nowMono must be a finite non-negative number.');
  const utc = normalizeUtc(input.nowUtc ?? options.nowUtc(), 'nowUtc');
  return { utc, mono };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', `${name} must be an object.`);
  return value as Record<string, unknown>;
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseObject(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

const ACCEPTANCE_FIELDS = Object.freeze([
  'acceptanceRunId',
  'baselineEventSequence',
  'baselineCheckpointRevision',
  'createdAfterEventSequence',
  'createdAfterCheckpointRevision',
  'createdAfterMono'
] as const);

type AcceptanceRowSource = Readonly<{ name: string; row: Row }>;

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function acceptanceFromSource(source: Readonly<Record<string, unknown>>, name: string, allowSnakeCase: boolean): ResourceAcceptanceProvenance | null {
  const values = ACCEPTANCE_FIELDS.map((field) => {
    if (source[field] !== undefined) return source[field];
    if (allowSnakeCase) {
      const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      return source[snake];
    }
    return undefined;
  });
  const present = values.some((value) => value !== undefined && value !== null);
  if (!present) return null;
  if (values.some((value) => value === undefined || value === null)) {
    throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', `${name} acceptance 字段必须完整成套。`);
  }
  return Object.freeze({
    acceptanceRunId: requiredString(values[0], `${name}.acceptanceRunId`),
    baselineEventSequence: integerValue(values[1], `${name}.baselineEventSequence`, 0),
    baselineCheckpointRevision: integerValue(values[2], `${name}.baselineCheckpointRevision`, 0),
    createdAfterEventSequence: integerValue(values[3], `${name}.createdAfterEventSequence`, 0),
    createdAfterCheckpointRevision: integerValue(values[4], `${name}.createdAfterCheckpointRevision`, 0),
    createdAfterMono: integerValue(values[5], `${name}.createdAfterMono`, 0)
  });
}

function sameAcceptance(left: ResourceAcceptanceProvenance | null, right: ResourceAcceptanceProvenance | null): boolean {
  if (!left || !right) return left === right;
  return left.acceptanceRunId === right.acceptanceRunId
    && left.baselineEventSequence === right.baselineEventSequence
    && left.baselineCheckpointRevision === right.baselineCheckpointRevision
    && left.createdAfterEventSequence === right.createdAfterEventSequence
    && left.createdAfterCheckpointRevision === right.createdAfterCheckpointRevision
    && left.createdAfterMono === right.createdAfterMono;
}

function acceptanceFromInput(input: Readonly<Record<string, unknown>>): ResourceAcceptanceProvenance | null {
  const topLevel = acceptanceFromSource(input, 'top-level', false);
  let nested: ResourceAcceptanceProvenance | null = null;
  if (input.acceptance !== undefined && input.acceptance !== null) {
    nested = acceptanceFromSource(asRecord(input.acceptance, 'acceptance'), 'acceptance', true);
  }
  if (topLevel && nested && !sameAcceptance(topLevel, nested)) {
    throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', 'top-level acceptance 与 acceptance 对象不一致。');
  }
  return topLevel ?? nested;
}

function acceptanceFromRow(row: Row, name: string): ResourceAcceptanceProvenance | null {
  return acceptanceFromSource({
    acceptanceRunId: row.acceptance_run_id,
    baselineEventSequence: row.baseline_event_sequence,
    baselineCheckpointRevision: row.baseline_checkpoint_revision,
    createdAfterEventSequence: row.created_after_event_sequence,
    createdAfterCheckpointRevision: row.created_after_checkpoint_revision,
    createdAfterMono: row.created_after_mono
  }, name, false);
}

function acceptanceValues(acceptance: ResourceAcceptanceProvenance | null): readonly SQLInputValue[] {
  return acceptance ? [
    acceptance.acceptanceRunId,
    acceptance.baselineEventSequence,
    acceptance.baselineCheckpointRevision,
    acceptance.createdAfterEventSequence,
    acceptance.createdAfterCheckpointRevision,
    acceptance.createdAfterMono
  ] : [null, null, null, null, null, null];
}

function resolveAcceptance(input: Readonly<Record<string, unknown>>, sources: readonly AcceptanceRowSource[]): ResourceAcceptanceProvenance | null {
  const supplied = acceptanceFromInput(input);
  let inherited: ResourceAcceptanceProvenance | null = null;
  let inheritedFrom: string | null = null;
  for (const source of sources) {
    const candidate = acceptanceFromRow(source.row, source.name);
    if (!candidate) continue;
    if (inherited && !sameAcceptance(inherited, candidate)) {
      throw new ResourceAdmissionError('STATE_CONFLICT', 'durable provenance ancestors are inconsistent.', { inheritedFrom, conflictingSource: source.name });
    }
    inherited = candidate;
    inheritedFrom = source.name;
  }
  if (supplied && !inherited) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'acceptance provenance has no durable parent.');
  }
  if (supplied && inherited && !sameAcceptance(supplied, inherited)) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'acceptance provenance differs from durable parent.', { inheritedFrom });
  }
  return inherited;
}

function assertInputMatchesDispatch(row: Row, input: Readonly<Record<string, unknown>>): void {
  const supplied = acceptanceFromInput(input);
  if (!supplied) return;
  const existing = acceptanceFromRow(row, 'dispatch');
  if (!existing || !sameAcceptance(supplied, existing)) {
    throw new ResourceAdmissionError('RESOURCE_ADMISSION_REPLAY_CONFLICT', 'acceptance provenance differs from durable dispatch.', { jobId: String(row.job_id) });
  }
}

function changed(result: unknown): number {
  const raw = (result as { changes?: number | bigint } | undefined)?.changes;
  return raw === undefined ? 0 : Number(raw);
}

function unwrapFence(input: ResourceFenceInput | ActorFence | undefined): ActorFence {
  const candidate = input && typeof input === 'object' && 'fence' in input
    ? (input as Readonly<{ fence: ActorFence }>).fence
    : input as ActorFence | undefined;
  const fence = asRecord(candidate, 'fence');
  return {
    workspaceId: requiredString(fence.workspaceId, 'fence.workspaceId'),
    runtimeEpoch: integerValue(fence.runtimeEpoch, 'fence.runtimeEpoch', 1),
    ownerEpoch: integerValue(fence.ownerEpoch, 'fence.ownerEpoch', 1),
    authorityRevision: integerValue(fence.authorityRevision, 'fence.authorityRevision', 1),
    leaseToken: requiredString(fence.leaseToken, 'fence.leaseToken'),
    checkpointRevision: fence.checkpointRevision === undefined ? undefined : integerValue(fence.checkpointRevision, 'fence.checkpointRevision', 0)
  };
}

function fenceFrom(input: { fence?: ResourceFenceInput; actorFence?: ActorFence; workspaceId: string }): ActorFence {
  return unwrapFence(input.fence ?? input.actorFence);
}

function assertFence(database: DatabaseSync, workspaceId: string, input: { fence?: ResourceFenceInput; actorFence?: ActorFence; workspaceId: string }, nowMono: number): WorkspaceOrchestratorActor {
  const supplied = fenceFrom(input);
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  if (!actor) throw new ResourceAdmissionError('WORKSPACE_STALE', 'workspace Actor does not exist.', { workspaceId });
  if (supplied.workspaceId !== workspaceId
    || actor.runtimeEpoch !== supplied.runtimeEpoch
    || actor.ownerEpoch !== supplied.ownerEpoch
    || actor.authorityRevision !== supplied.authorityRevision
    || actor.leaseToken !== supplied.leaseToken) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'Actor fence is stale.', { workspaceId });
  }
  if (actor.actorStatus === 'failed' || !actor.leaseToken) throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'Actor is not writable.', { workspaceId });
  if ((actor.leaseExpiresAtMono !== null && nowMono >= actor.leaseExpiresAtMono)
    || (actor.controlStallDeadlineMono !== null && nowMono >= actor.controlStallDeadlineMono)) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'Actor lease or control-stall deadline has expired.', { workspaceId });
  }
  return actor;
}

function identityRegistry(database: DatabaseSync, workspaceId: string, registryName: string, preimage: unknown, derivedValue: string, createdAt: string): void {
  const bytes = Buffer.from(canonicalJsonV1(preimage), 'utf8');
  const preimageHash = sha256Hex(bytes);
  const canonicalBytesHash = sha256Hex(bytes);
  const existing = database.prepare(`SELECT preimage_schema_version, canonical_bytes_hash, preimage_bytes, derived_value
    FROM identity_hash_registry
    WHERE workspace_id=? AND registry_name=? AND registry_version=1 AND preimage_hash=?`)
    .get(workspaceId, registryName, preimageHash) as Row | undefined;
  if (existing) {
    const existingBytes = Buffer.from(existing.preimage_bytes as Uint8Array);
    if (numberValue(existing.preimage_schema_version) !== 1
      || String(existing.canonical_bytes_hash) !== canonicalBytesHash
      || !existingBytes.equals(bytes)
      || String(existing.derived_value) !== derivedValue) {
      throw new ResourceAdmissionError('IDENTITY_REPLAY_CONFLICT', `${registryName} is already bound to a different value.`);
    }
    return;
  }
  database.prepare(`INSERT INTO identity_hash_registry (
    workspace_id, registry_name, registry_version, preimage_schema_version, preimage_hash,
    canonical_bytes_hash, preimage_bytes, derived_value, created_at
  ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)`)
    .run(workspaceId, registryName, preimageHash, canonicalBytesHash, bytes, derivedValue, createdAt);
}

function stripLaunchSecret(envelope: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...envelope };
  delete copy.launchToken;
  delete copy.launchSecret;
  delete copy.launch_token;
  delete copy.launch_secret;
  return copy;
}

function launchTokenHash(envelope: Record<string, unknown>, workspaceId: string, launchAttemptId: string, childIdentityKey: string): string {
  const explicit = optionalString(envelope.launchTokenHash ?? envelope.launch_token_hash);
  if (explicit) return explicit;
  const raw = envelope.launchToken ?? envelope.launchSecret ?? envelope.launch_token ?? envelope.launch_secret;
  if (raw !== undefined && raw !== null) return sha256Hex(String(raw));
  return hashV1({ r: 'launch-token/v1', workspaceId, launchAttemptId, childIdentityKey });
}

function normalizeReserve(input: ReserveManagedDispatchInput): NormalizedReserve {
  const workspaceId = requiredString(input.workspaceId, 'workspaceId');
  const rootRequestId = requiredString(input.rootRequestId, 'rootRequestId');
  const rootGeneration = integerValue(input.rootGeneration, 'rootGeneration', 0);
  const rootInputHash = requiredString(input.rootInputHash, 'rootInputHash');
  const managerTaskId = requiredString(input.managerTaskId, 'managerTaskId');
  const orchestrationId = requiredString(input.orchestrationId, 'orchestrationId');
  const parentTaskId = requiredString(input.parentTaskId, 'parentTaskId');
  const parentStageRequestId = requiredString(input.parentStageRequestId, 'parentStageRequestId');
  const stageRequestId = requiredString(input.stageRequestId, 'stageRequestId');
  const retryGeneration = integerValue(input.retryGeneration, 'retryGeneration', 0);
  if (retryGeneration > 2) throw new ResourceAdmissionError('RESOURCE_RETRY_BUDGET_EXHAUSTED', 'retryGeneration must be at most 2.');
  const roleId = requiredString(input.roleId, 'roleId') as WorkspaceOrchestratorResourceRole;
  if (!(RESOURCE_ROLES as readonly string[]).includes(roleId)) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', `Unsupported roleId: ${roleId}.`);
  const childOrdinal = integerValue(input.childOrdinal, 'childOrdinal', 1);
  const operationRequestId = requiredString(input.operationRequestId, 'operationRequestId');
  const envelope = asRecord(input.envelope, 'envelope');
  const argvHash = requiredString(input.argvHash, 'argvHash');
  const cwdFingerprint = requiredString(input.cwdFingerprint, 'cwdFingerprint');
  const sessionKey = requiredString(input.sessionKey, 'sessionKey');
  const nowUtc = normalizeUtc(input.nowUtc, 'nowUtc');
  const nowMono = Number(input.nowMono);
  if (!Number.isFinite(nowMono) || nowMono < 0) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', 'nowMono must be a finite non-negative number.');
  const leaseExpiresAtUtc = normalizeUtc(input.leaseExpiresAtUtc, 'leaseExpiresAtUtc');
  const leaseExpiresAtMono = integerValue(input.leaseExpiresAtMono, 'leaseExpiresAtMono', 0);
  const spawnDeadlineUtc = normalizeUtc(input.spawnDeadlineUtc, 'spawnDeadlineUtc');
  const spawnDeadlineMono = integerValue(input.spawnDeadlineMono, 'spawnDeadlineMono', 0);
  if (leaseExpiresAtMono < nowMono || spawnDeadlineMono < nowMono) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', 'lease and spawn deadlines cannot precede nowMono.');
  const effectRequestId = optionalString(envelope.effectRequestId ?? envelope.effect_request_id);
  const childPreimage = { r: 'child/v1', workspaceId, operationRequestId, effectRequestId, roleId, childOrdinal };
  const childIdentityKey = hashV1(childPreimage);
  const launchAttemptId = hashV1({ r: 'launch-attempt/v1', workspaceId, childIdentityKey, retryGeneration });
  const jobId = hashV1({ r: 'managed-job/v1', workspaceId, childIdentityKey });
  const launchTokenHashValue = launchTokenHash(envelope, workspaceId, launchAttemptId, childIdentityKey);
  const preflightId = requiredString(envelope.preflightId ?? envelope.preflight_id ?? hashV1({ r: 'preflight-ref/v1', workspaceId, rootRequestId, rootGeneration, rootInputHash }), 'preflightId');
  const policyHash = requiredString(envelope.policyHash ?? envelope.policy_hash ?? hashV1({ r: 'policy-ref/v1', workspaceId, rootRequestId, rootInputHash }), 'policyHash');
  const persistedEnvelope: Record<string, unknown> = {
    ...stripLaunchSecret(envelope),
    workspaceId,
    rootRequestId,
    rootGeneration,
    stageRequestId,
    operationRequestId,
    childIdentityKey,
    launchAttemptId,
    launchTokenHash: launchTokenHashValue,
    argvHash,
    cwdFingerprint,
    sessionKey
  };
  return {
    workspaceId,
    rootRequestId,
    rootGeneration,
    rootInputHash,
    managerTaskId,
    orchestrationId,
    parentTaskId,
    parentStageRequestId,
    stageRequestId,
    retryGeneration,
    roleId,
    childOrdinal,
    operationRequestId,
    effectRequestId,
    childIdentityKey,
    jobId,
    launchAttemptId,
    launchTokenHash: launchTokenHashValue,
    preflightId,
    policyHash,
    envelopeJson: canonicalJsonV1(persistedEnvelope),
    envelope: persistedEnvelope,
    argvHash,
    cwdFingerprint,
    sessionKey,
    nowUtc,
    nowMono,
    leaseExpiresAtUtc,
    leaseExpiresAtMono,
    spawnDeadlineUtc,
    spawnDeadlineMono,
    acceptance: acceptanceFromInput(input as unknown as Readonly<Record<string, unknown>>)
  };
}

function readDispatch(database: DatabaseSync, workspaceId: string, input: { jobId?: string; childIdentityKey?: string; operationRequestId?: string; stageRequestId?: string }): Row | undefined {
  if (input.jobId) return database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND job_id=?').get(workspaceId, input.jobId) as Row | undefined;
  if (input.childIdentityKey) return database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND child_identity_key=?').get(workspaceId, input.childIdentityKey) as Row | undefined;
  if (input.operationRequestId && input.stageRequestId) return database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND operation_request_id=? AND stage_request_id=? ORDER BY child_ordinal LIMIT 1').get(workspaceId, input.operationRequestId, input.stageRequestId) as Row | undefined;
  return undefined;
}

function rowToDispatch(row: Row): ManagedJobDispatchReadback {
  return Object.freeze({
    jobId: String(row.job_id),
    workspaceId: String(row.workspace_id),
    childIdentityKey: String(row.child_identity_key),
    childOrdinal: numberValue(row.child_ordinal),
    roleId: String(row.role_id) as WorkspaceOrchestratorResourceRole,
    operationRequestId: String(row.operation_request_id),
    effectRequestId: optionalString(row.effect_request_id),
    managerTaskId: String(row.manager_task_id),
    orchestrationId: String(row.orchestration_id),
    parentTaskId: String(row.parent_task_id),
    parentStageRequestId: String(row.parent_stage_request_id),
    rootRequestId: String(row.root_request_id),
    rootGeneration: numberValue(row.root_generation),
    rootInputHash: String(row.root_input_hash),
    preflightId: String(row.preflight_id),
    policyHash: String(row.policy_hash),
    stageRequestId: String(row.stage_request_id),
    retryGeneration: numberValue(row.retry_generation),
    expectedParentClaimRevision: numberValue(row.expected_parent_claim_revision),
    expectedParentOwnerEpoch: numberValue(row.expected_parent_owner_epoch),
    expectedParentLeaseToken: String(row.expected_parent_lease_token),
    launchAttemptId: String(row.launch_attempt_id),
    launchTokenHash: String(row.launch_token_hash),
    processHandle: optionalString(row.process_handle),
    pid: row.pid === null || row.pid === undefined ? null : numberValue(row.pid),
    processStartTimeUtc: optionalString(row.process_start_time_utc),
    processStartTimeMono: row.process_start_time_mono === null || row.process_start_time_mono === undefined ? null : numberValue(row.process_start_time_mono),
    argvHash: String(row.argv_hash),
    cwdFingerprint: String(row.cwd_fingerprint),
    sessionKey: String(row.session_key),
    spawnDeadlineUtc: String(row.spawn_deadline_utc),
    spawnDeadlineMono: numberValue(row.spawn_deadline_mono),
    registerAt: optionalString(row.register_at),
    stdoutDrainWatermark: numberValue(row.stdout_drain_watermark),
    stderrDrainWatermark: numberValue(row.stderr_drain_watermark),
    state: String(row.state) as ManagedJobDispatchState,
    resultStatus: optionalString(row.result_status),
    resultHash: optionalString(row.result_hash),
    envelope: parseObject(row.envelope_json),
    result: parseJson(row.result_json, null),
    ownerEpoch: numberValue(row.owner_epoch),
    leaseToken: String(row.lease_token),
    leaseExpiresAtUtc: String(row.lease_expires_at_utc),
    leaseExpiresAtMono: numberValue(row.lease_expires_at_mono),
    acceptanceRunId: optionalString(row.acceptance_run_id),
    baselineEventSequence: nullableNumber(row.baseline_event_sequence),
    baselineCheckpointRevision: nullableNumber(row.baseline_checkpoint_revision),
    createdAfterEventSequence: nullableNumber(row.created_after_event_sequence),
    createdAfterCheckpointRevision: nullableNumber(row.created_after_checkpoint_revision),
    createdAfterMono: nullableNumber(row.created_after_mono),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: optionalString(row.finished_at)
  });
}

function sameReserveIdentity(row: Row, input: NormalizedReserve): boolean {
  return String(row.workspace_id) === input.workspaceId
    && String(row.job_id) === input.jobId
    && String(row.child_identity_key) === input.childIdentityKey
    && numberValue(row.child_ordinal) === input.childOrdinal
    && String(row.role_id) === input.roleId
    && String(row.operation_request_id) === input.operationRequestId
    && String(row.manager_task_id) === input.managerTaskId
    && String(row.orchestration_id) === input.orchestrationId
    && String(row.parent_task_id) === input.parentTaskId
    && String(row.parent_stage_request_id) === input.parentStageRequestId
    && String(row.root_request_id) === input.rootRequestId
    && numberValue(row.root_generation) === input.rootGeneration
    && String(row.root_input_hash) === input.rootInputHash
    && String(row.stage_request_id) === input.stageRequestId
    && numberValue(row.retry_generation) === input.retryGeneration
    && String(row.launch_attempt_id) === input.launchAttemptId
    && String(row.argv_hash) === input.argvHash
    && String(row.cwd_fingerprint) === input.cwdFingerprint
    && String(row.session_key) === input.sessionKey;
}

function validateContext(database: DatabaseSync, input: NormalizedReserve | ResourceDispatchMutationInput, actor: WorkspaceOrchestratorActor, row: Row, nowMono: number, allowTerminalParent = false): Context {
  const rootRequestId = String(row.root_request_id);
  const root = database.prepare('SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?').get(actor.workspaceId, rootRequestId) as Row | undefined;
  if (!root) throw new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch root does not exist.', { rootRequestId });
  if (numberValue(root.root_generation) !== numberValue(row.root_generation)
    || String(root.root_input_hash) !== String(row.root_input_hash)
    || String(root.orchestration_id) !== String(row.orchestration_id)
    || String(root.manager_task_id) !== String(row.manager_task_id)) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch root identity does not match.', { rootRequestId });
  }
  if (!allowTerminalParent && (String(root.status) === 'succeeded' || String(root.status) === 'partial' || String(root.status) === 'failed' || String(root.status) === 'needs_user' || String(root.status) === 'cancelled')) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch root is terminal.', { rootRequestId });
  }
  if (numberValue(root.owner_epoch) !== actor.ownerEpoch || String(root.lease_token) !== actor.leaseToken) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'dispatch root fence is stale.', { rootRequestId });
  }
  const stageRequestId = String(row.stage_request_id);
  const stage = database.prepare('SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?').get(actor.workspaceId, stageRequestId) as Row | undefined;
  if (!stage) throw new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch stage claim does not exist.', { stageRequestId });
  if (String(stage.root_request_id) !== rootRequestId || numberValue(stage.root_generation) !== numberValue(row.root_generation)) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch stage identity does not match.', { stageRequestId });
  }
  if (!allowTerminalParent && (numberValue(stage.is_active) !== 1 || (RESOURCE_TERMINAL_STATES as readonly string[]).includes(String(stage.status)))) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch stage claim is no longer active.', { stageRequestId });
  }
  if (stage.lease_token !== null && String(stage.lease_token) !== actor.leaseToken) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'dispatch stage fence is stale.', { stageRequestId });
  }
  if (stage.owner_epoch !== null && numberValue(stage.owner_epoch) !== actor.ownerEpoch) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'dispatch stage owner epoch is stale.', { stageRequestId });
  }
  const parentStageRequestId = String((input as ResourceDispatchMutationInput).parentStageRequestId ?? row.parent_stage_request_id);
  const parent = database.prepare('SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?').get(actor.workspaceId, parentStageRequestId) as Row | undefined;
  if (!parent) throw new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch parent stage claim does not exist.', { parentStageRequestId });
  const expectedRevision = (input as ResourceDispatchMutationInput).expectedParentClaimRevision === undefined
    ? numberValue(row.expected_parent_claim_revision)
    : integerValue((input as ResourceDispatchMutationInput).expectedParentClaimRevision, 'expectedParentClaimRevision', 0);
  if (numberValue(parent.claim_revision) !== expectedRevision) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'parent stage claim revision is stale.', { parentStageRequestId, expectedRevision, actualRevision: numberValue(parent.claim_revision) });
  }
  if (String(parent.root_request_id) !== rootRequestId || String(parent.manager_task_id ?? row.manager_task_id) !== String(row.manager_task_id)) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch parent claim identity does not match.', { parentStageRequestId });
  }
  if (!allowTerminalParent && (numberValue(parent.is_active) !== 1 || (RESOURCE_TERMINAL_STATES as readonly string[]).includes(String(parent.status)))) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch parent claim is no longer active.', { parentStageRequestId });
  }
  if (parent.lease_token !== null && String(parent.lease_token) !== actor.leaseToken) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'dispatch parent lease fence is stale.', { parentStageRequestId });
  }
  if (parent.owner_epoch !== null && numberValue(parent.owner_epoch) !== actor.ownerEpoch) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'dispatch parent owner epoch is stale.', { parentStageRequestId });
  }
  return { actor, root, stage, parent };
}

function validateDispatchOwner(actor: WorkspaceOrchestratorActor, row: Row): void {
  if (numberValue(row.owner_epoch) !== actor.ownerEpoch || String(row.lease_token) !== actor.leaseToken) {
    throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'dispatch owner fence is stale.', { jobId: String(row.job_id) });
  }
}

function admissionFailure(error: unknown): ResourceAdmissionFailure {
  if (error instanceof ResourceAdmissionError) return Object.freeze({ ok: false, status: 'rejected', code: error.code, reasonCode: error.code, message: error.message, readback: error.details });
  if (error instanceof Error) return Object.freeze({ ok: false, status: 'rejected', code: 'ORCHESTRATOR_CONTRACT_ERROR', reasonCode: 'ORCHESTRATOR_CONTRACT_ERROR', message: error.message });
  return Object.freeze({ ok: false, status: 'rejected', code: 'ORCHESTRATOR_CONTRACT_ERROR', reasonCode: 'ORCHESTRATOR_CONTRACT_ERROR', message: String(error) });
}

function success(status: ResourceAdmissionStatus, row: Row, extra: Partial<ResourceAdmissionSuccess> = {}): ResourceAdmissionSuccess {
  return Object.freeze({ ok: true, status, dispatch: rowToDispatch(row), ...extra });
}

function capFor(roleId: WorkspaceOrchestratorResourceRole): number | null {
  if (roleId === 'reporter') return 5;
  if (roleId === 'judge') return 1;
  return null;
}

function activeCount(database: DatabaseSync, workspaceId: string, roleId: WorkspaceOrchestratorResourceRole): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM managed_job_dispatches
    WHERE workspace_id=? AND role_id=? AND state IN (${ACTIVE_STATE_SQL})
      AND (result_status IS NULL OR result_status!='waiting_resource')`).get(workspaceId, roleId) as Row;
  return numberValue(row.count);
}
type JudgeQueueCandidate = {
  row: Row;
  priority: number;
  mailboxSequence: number;
  waitingSinceMs: number;
  ageMs: number;
  effectivePriority: number;
};

function scheduleNow(input: JudgeSchedulingInput): { utc: string; mono: number } {
  const utc = normalizeUtc(input.nowUtc, 'nowUtc');
  const mono = Number(input.nowMono);
  if (!Number.isFinite(mono) || mono < 0) throw new ResourceAdmissionError('ORCHESTRATOR_CONTRACT_ERROR', 'nowMono must be a finite non-negative number.');
  return { utc, mono };
}

function judgeTimestamp(value: unknown, name: string): number {
  const millis = Date.parse(String(value ?? ''));
  if (!Number.isFinite(millis)) throw new ResourceAdmissionError('STATE_CONFLICT', `${name} is not a valid durable UTC instant.`);
  return millis;
}

function readJudgeQueue(database: DatabaseSync, workspaceId: string): Row[] {
  return database.prepare(`SELECT d.*, i.priority AS root_priority, i.mailbox_sequence AS root_mailbox_sequence
    FROM managed_job_dispatches d
    LEFT JOIN workspace_active_root_index i
      ON i.workspace_id=d.workspace_id AND i.root_request_id=d.root_request_id AND i.is_active=1
    WHERE d.workspace_id=? AND d.role_id='judge' AND d.state IN (${ACTIVE_STATE_SQL})`).all(workspaceId) as Row[];
}

function judgeWaiting(row: Row): boolean {
  return String(row.state) === 'reserved' && String(row.result_status) === 'waiting_resource';
}

function judgeActive(row: Row): boolean {
  return (RESOURCE_ACTIVE_STATES as readonly string[]).includes(String(row.state)) && !judgeWaiting(row);
}

function judgeHasProcessIdentity(row: Row): boolean {
  return optionalString(row.process_handle) !== null
    || row.pid !== null && row.pid !== undefined
    || optionalString(row.process_start_time_utc) !== null
    || row.process_start_time_mono !== null && row.process_start_time_mono !== undefined
    || optionalString(row.register_at) !== null;
}

function judgePreemptable(row: Row): boolean {
  return String(row.state) === 'reserved' && row.result_status === null && !judgeHasProcessIdentity(row);
}

function judgeCandidate(row: Row, nowMs: number): JudgeQueueCandidate {
  const priority = integerValue(row.root_priority, 'root priority', 0);
  const mailboxSequence = integerValue(row.root_mailbox_sequence, 'root mailbox sequence', 1);
  const result = parseObject(row.result_json);
  const waitingSince = result.waitingSinceUtc ?? result.waiting_since_utc ?? row.created_at;
  const waitingSinceMs = judgeTimestamp(waitingSince, `Judge ${String(row.job_id)} waitingSinceUtc`);
  const ageMs = judgeWaiting(row) ? Math.max(0, nowMs - waitingSinceMs) : 0;
  const ageSteps = Math.floor(ageMs / RESOURCE_JUDGE_AGING_QUANTUM_MS);
  return { row, priority, mailboxSequence, waitingSinceMs, ageMs, effectivePriority: priority + ageSteps };
}

function compareJudgeCandidates(left: JudgeQueueCandidate, right: JudgeQueueCandidate): number {
  return right.effectivePriority - left.effectivePriority
    || left.mailboxSequence - right.mailboxSequence
    || (String(left.row.child_identity_key) < String(right.row.child_identity_key) ? -1 : String(left.row.child_identity_key) > String(right.row.child_identity_key) ? 1 : 0)
    || (String(left.row.job_id) < String(right.row.job_id) ? -1 : String(left.row.job_id) > String(right.row.job_id) ? 1 : 0)
    || (String(left.row.root_request_id) < String(right.row.root_request_id) ? -1 : String(left.row.root_request_id) > String(right.row.root_request_id) ? 1 : 0)
    || (String(left.row.stage_request_id) < String(right.row.stage_request_id) ? -1 : String(left.row.stage_request_id) > String(right.row.stage_request_id) ? 1 : 0);
}

function judgeQueueSnapshot(database: DatabaseSync, workspaceId: string, nowUtc: string): {
  rows: Row[];
  active: Row | null;
  waiting: JudgeQueueCandidate[];
  readback: JudgeSchedulingReadback;
} {
  const nowMs = judgeTimestamp(nowUtc, 'nowUtc');
  const rows = readJudgeQueue(database, workspaceId);
  const activeRows = rows.filter(judgeActive);
  if (activeRows.length > 1) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'Judge active count exceeds the hard cap.', { activeJudgeCount: activeRows.length });
  }
  const waiting = rows.filter(judgeWaiting).map((row) => judgeCandidate(row, nowMs)).sort(compareJudgeCandidates);
  const active = activeRows[0] ?? null;
  const winnerJobId = active ? String(active.job_id) : waiting[0] ? String(waiting[0].row.job_id) : null;
  return {
    rows,
    active,
    waiting,
    readback: Object.freeze({
      workspaceId,
      roleId: 'judge',
      activeJudgeCount: activeRows.length,
      activeJudgeJobId: active ? String(active.job_id) : null,
      orderedWaitingJudgeJobIds: Object.freeze(waiting.map((candidate) => String(candidate.row.job_id))),
      winnerJobId
    })
  };
}

function judgeWaitingResult(waitingSinceUtc: string, reasonCode: string, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { status: 'waiting_resource', reasonCode, spawned: false, roleId: 'judge', cap: 1, waitingSinceUtc, ...extra };
}

function promoteJudge(database: DatabaseSync, row: Row, actor: WorkspaceOrchestratorActor, nowUtc: string): Row {
  const update = database.prepare(`UPDATE managed_job_dispatches SET
      result_status=NULL, result_hash=NULL, result_json=NULL, updated_at=?
    WHERE workspace_id=? AND job_id=? AND state='reserved' AND result_status='waiting_resource'
      AND process_handle IS NULL AND pid IS NULL AND process_start_time_utc IS NULL
      AND process_start_time_mono IS NULL AND register_at IS NULL
      AND owner_epoch=? AND lease_token=?`).run(
    nowUtc, String(row.workspace_id), String(row.job_id), actor.ownerEpoch, actor.leaseToken);
  if (changed(update) !== 1) throw new ResourceAdmissionError('STATE_CONFLICT', 'Judge promotion compare-and-swap failed.', { jobId: String(row.job_id) });
  const promoted = readDispatch(database, String(row.workspace_id), { jobId: String(row.job_id) });
  if (!promoted) throw new ResourceAdmissionError('WORKSPACE_STALE', 'promoted Judge dispatch disappeared.', { jobId: String(row.job_id) });
  return promoted;
}

function preemptJudge(database: DatabaseSync, row: Row, winner: Row, actor: WorkspaceOrchestratorActor, nowUtc: string): Row {
  const result = judgeWaitingResult(nowUtc, JUDGE_WAITING_REASON, {
    preempted: true,
    preemptedByJobId: String(winner.job_id)
  });
  const update = database.prepare(`UPDATE managed_job_dispatches SET
      result_status='waiting_resource', result_hash=?, result_json=?, updated_at=?
    WHERE workspace_id=? AND job_id=? AND state='reserved' AND result_status IS NULL
      AND process_handle IS NULL AND pid IS NULL AND process_start_time_utc IS NULL
      AND process_start_time_mono IS NULL AND register_at IS NULL
      AND owner_epoch=? AND lease_token=?`).run(
    hashV1(result), canonicalJsonV1(result), nowUtc, String(row.workspace_id), String(row.job_id), actor.ownerEpoch, actor.leaseToken);
  if (changed(update) !== 1) throw new ResourceAdmissionError('STATE_CONFLICT', 'Judge preemption compare-and-swap failed.', { jobId: String(row.job_id) });
  const preempted = readDispatch(database, String(row.workspace_id), { jobId: String(row.job_id) });
  if (!preempted) throw new ResourceAdmissionError('WORKSPACE_STALE', 'preempted Judge dispatch disappeared.', { jobId: String(row.job_id) });
  return preempted;
}

function scheduleJudgeCore(database: DatabaseSync, input: JudgeSchedulingInput): JudgeSchedulingResult {
  const pair = scheduleNow(input);
  const actor = assertFence(database, requiredString(input.workspaceId, 'workspaceId'), input, pair.mono);
  const initial = judgeQueueSnapshot(database, actor.workspaceId, pair.utc);
  for (const row of initial.rows) validateDispatchOwner(actor, row);
  const bestWaiting = initial.waiting[0] ?? null;
  let transitioned = false;
  let reasonCode = JUDGE_NO_WAITING_REASON;
  if (bestWaiting) {
    if (!initial.active) {
      promoteJudge(database, bestWaiting.row, actor, pair.utc);
      transitioned = true;
      reasonCode = JUDGE_PROMOTED_REASON;
    } else if (judgePreemptable(initial.active)) {
      const activeCandidate = judgeCandidate(initial.active, judgeTimestamp(pair.utc, 'nowUtc'));
      if (compareJudgeCandidates(bestWaiting, activeCandidate) < 0) {
        preemptJudge(database, initial.active, bestWaiting.row, actor, pair.utc);
        promoteJudge(database, bestWaiting.row, actor, pair.utc);
        transitioned = true;
        reasonCode = JUDGE_PREEMPTED_REASON;
      } else {
        reasonCode = JUDGE_ORDERED_BEHIND_REASON;
      }
    } else {
      reasonCode = JUDGE_BLOCKED_REASON;
    }
  }
  const final = judgeQueueSnapshot(database, actor.workspaceId, pair.utc);
  if (final.readback.activeJudgeCount > 1) {
    throw new ResourceAdmissionError('STATE_CONFLICT', 'Judge active count exceeds the hard cap after scheduling.', { activeJudgeCount: final.readback.activeJudgeCount });
  }
  return Object.freeze({
    ok: true,
    status: transitioned ? 'scheduled' : bestWaiting ? 'waiting_resource' : 'unchanged',
    reasonCode,
    replayed: !transitioned,
    dispatch: final.active ? rowToDispatch(final.active) : null,
    readback: final.readback
  });
}


function reserveCore(database: DatabaseSync, input: ReserveManagedDispatchInput): ResourceAdmissionResult {
  const normalized = normalizeReserve(input);
  const existing = readDispatch(database, normalized.workspaceId, { jobId: normalized.jobId, childIdentityKey: normalized.childIdentityKey });
  if (existing) {
    assertInputMatchesDispatch(existing, input as unknown as Readonly<Record<string, unknown>>);
    if (!sameReserveIdentity(existing, normalized)) return admissionFailure(new ResourceAdmissionError('RESOURCE_ADMISSION_REPLAY_CONFLICT', 'child identity is already bound to different dispatch input.', { jobId: normalized.jobId, childIdentityKey: normalized.childIdentityKey }));
    const existingStatus = String(existing.result_status) === 'waiting_resource' ? 'waiting_resource' : String(existing.state) as ResourceAdmissionStatus;
    return success(existingStatus, existing, { replayed: true, reasonCode: String(existing.result_status) === 'waiting_resource' ? String(parseObject(existing.result_json).reasonCode ?? 'RESOURCE_CAPACITY') : undefined });
  }
  const launchCollision = database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND launch_attempt_id=?').get(normalized.workspaceId, normalized.launchAttemptId) as Row | undefined;
  if (launchCollision) return admissionFailure(new ResourceAdmissionError('RESOURCE_ADMISSION_REPLAY_CONFLICT', 'launchAttemptId is already bound to another child identity.', { launchAttemptId: normalized.launchAttemptId }));
  const actor = assertFence(database, normalized.workspaceId, input, normalized.nowMono);
  const allowConsumedParent = normalized.roleId === 'judge';
  const context = validateContext(database, normalized, actor, {
    workspace_id: normalized.workspaceId,
    root_request_id: normalized.rootRequestId,
    root_generation: normalized.rootGeneration,
    root_input_hash: normalized.rootInputHash,
    orchestration_id: normalized.orchestrationId,
    manager_task_id: normalized.managerTaskId,
    stage_request_id: normalized.stageRequestId,
    parent_stage_request_id: normalized.parentStageRequestId,
    expected_parent_claim_revision: Number((input as ReserveManagedDispatchInput & { expectedParentClaimRevision?: number }).expectedParentClaimRevision ?? 0)
  }, normalized.nowMono, allowConsumedParent);
  if (allowConsumedParent) {
    const parentResult = parseObject(context.parent.result_json);
    if (String(context.parent.status) !== 'succeeded' || Number(context.parent.is_active) !== 0 || String(parentResult.reasonCode) !== 'HANDOFF_CONSUMED') {
      throw new ResourceAdmissionError('STATE_CONFLICT', 'judge reservation requires a consumed F parent.', { parentStageRequestId: normalized.parentStageRequestId });
    }
  }
  const expectedParentRevision = numberValue(context.parent.claim_revision);
  const expectedParentOwnerEpoch = numberValue(context.parent.owner_epoch || actor.ownerEpoch);
  const acceptance = resolveAcceptance(input as unknown as Readonly<Record<string, unknown>>, [
    { name: 'root', row: context.root },
    { name: 'stage', row: context.stage },
    { name: 'parent', row: context.parent }
  ]);
  const expectedParentLeaseToken = String(context.parent.lease_token || actor.leaseToken);
  if (!expectedParentLeaseToken) throw new ResourceAdmissionError('EXECUTION_AUTHORIZATION_INVALID', 'parent stage claim has no lease token.');
  const cap = capFor(normalized.roleId);
  const waiting = cap !== null && activeCount(database, normalized.workspaceId, normalized.roleId) >= cap;
  const waitingReason = waiting ? (normalized.roleId === 'reporter' ? 'RESOURCE_REPORTER_CAPACITY' : 'RESOURCE_JUDGE_CAPACITY') : null;
  const result = waiting ? { status: 'waiting_resource', reasonCode: waitingReason, spawned: false, roleId: normalized.roleId, cap, waitingSinceUtc: normalized.nowUtc } : null;
  const resultJson = result ? canonicalJsonV1(result) : null;
  const resultHash = result ? hashV1(result) : null;
  identityRegistry(database, normalized.workspaceId, 'child/v1', {
    r: 'child/v1',
    workspaceId: normalized.workspaceId,
    operationRequestId: normalized.operationRequestId,
    effectRequestId: normalized.effectRequestId,
    roleId: normalized.roleId,
    childOrdinal: normalized.childOrdinal
  }, normalized.childIdentityKey, normalized.nowUtc);
  identityRegistry(database, normalized.workspaceId, 'launch-attempt/v1', {
    r: 'launch-attempt/v1', workspaceId: normalized.workspaceId, childIdentityKey: normalized.childIdentityKey, retryGeneration: normalized.retryGeneration
  }, normalized.launchAttemptId, normalized.nowUtc);
  identityRegistry(database, normalized.workspaceId, 'managed-job/v1', {
    r: 'managed-job/v1', workspaceId: normalized.workspaceId, childIdentityKey: normalized.childIdentityKey
  }, normalized.jobId, normalized.nowUtc);
  database.prepare(`INSERT INTO managed_job_dispatches (
    job_id, workspace_id, child_identity_key, child_ordinal, role_id, operation_request_id,
    effect_request_id, manager_task_id, orchestration_id, parent_task_id, parent_stage_request_id,
    root_request_id, root_generation, root_input_hash, preflight_id, policy_hash, stage_request_id,
    retry_generation, expected_parent_claim_revision, expected_parent_owner_epoch, expected_parent_lease_token,
    launch_attempt_id, launch_token_hash, process_handle, pid, process_start_time_utc, process_start_time_mono,
    argv_hash, cwd_fingerprint, session_key, spawn_deadline_utc, spawn_deadline_mono, state,
    result_status, result_hash, envelope_json, result_json, owner_epoch, lease_token,
    lease_expires_at_utc, lease_expires_at_mono, acceptance_run_id, baseline_event_sequence,
    baseline_checkpoint_revision, created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(normalized.jobId, normalized.workspaceId, normalized.childIdentityKey, normalized.childOrdinal, normalized.roleId,
      normalized.operationRequestId, normalized.effectRequestId, normalized.managerTaskId, normalized.orchestrationId,
      normalized.parentTaskId, normalized.parentStageRequestId, normalized.rootRequestId, normalized.rootGeneration,
      normalized.rootInputHash, normalized.preflightId, normalized.policyHash, normalized.stageRequestId,
      normalized.retryGeneration, expectedParentRevision, expectedParentOwnerEpoch, expectedParentLeaseToken,
      normalized.launchAttemptId, normalized.launchTokenHash, normalized.argvHash, normalized.cwdFingerprint,
      normalized.sessionKey, normalized.spawnDeadlineUtc, normalized.spawnDeadlineMono, waiting ? 'waiting_resource' : null,
      resultHash, normalized.envelopeJson, resultJson, actor.ownerEpoch, actor.leaseToken,
      normalized.leaseExpiresAtUtc, normalized.leaseExpiresAtMono, ...acceptanceValues(acceptance), normalized.nowUtc, normalized.nowUtc);
  const inserted = readDispatch(database, normalized.workspaceId, { jobId: normalized.jobId });
  if (!inserted) throw new ResourceAdmissionError('STATE_CONFLICT', 'reserved dispatch did not read back.');
  return success(waiting ? 'waiting_resource' : 'reserved', inserted, waiting ? { reasonCode: waitingReason! } : undefined);
}

export function reserveManagedDispatchInTransaction(database: DatabaseSync, input: ReserveManagedDispatchInput): ResourceAdmissionResult {
  try { return reserveCore(database, input); } catch (error) { return admissionFailure(error); }
}

function mutationIdentity(input: ResourceDispatchMutationInput, row: Row): { workspaceId: string; parentStageRequestId: string; expectedParentClaimRevision?: number } {
  return {
    workspaceId: requiredString(input.workspaceId, 'workspaceId'),
    parentStageRequestId: requiredString(input.parentStageRequestId ?? row.parent_stage_request_id, 'parentStageRequestId'),
    expectedParentClaimRevision: input.expectedParentClaimRevision === undefined ? numberValue(row.expected_parent_claim_revision) : input.expectedParentClaimRevision
  };
}

function inventoryList(input: ResourceDispatchMutationInput): { known: boolean; processes: readonly ResourceProcessInventory[] } {
  const raw = input.inventory ?? input.processInventory;
  if (Array.isArray(raw)) return { known: input.inventoryKnown !== false, processes: raw };
  if (raw && typeof raw === 'object') {
    const object = raw as { processes?: readonly ResourceProcessInventory[]; known?: boolean };
    return { known: input.inventoryKnown === undefined ? object.known !== false : input.inventoryKnown, processes: object.processes ?? [] };
  }
  return { known: input.inventoryKnown === true, processes: [] };
}

function processFromInput(input: ResourceDispatchMutationInput): ResourceProcessInventory {
  const raw = input.inventory && !Array.isArray(input.inventory) && typeof input.inventory === 'object' && !('processes' in input.inventory)
    ? input.inventory as ResourceProcessInventory
    : input.processInventory && !Array.isArray(input.processInventory) && typeof input.processInventory === 'object' && !('processes' in input.processInventory)
      ? input.processInventory as ResourceProcessInventory
      : input;
  const pick = (key: string, snake: string): unknown => raw[key] ?? raw[snake];
  return {
    workspaceId: optionalString(pick('workspaceId', 'workspace_id')) ?? undefined,
    launchAttemptId: optionalString(pick('launchAttemptId', 'launch_attempt_id')) ?? undefined,
    launchTokenHash: optionalString(pick('launchTokenHash', 'launch_token_hash')) ?? undefined,
    processHandle: pick('processHandle', 'process_handle') === undefined ? undefined : optionalString(pick('processHandle', 'process_handle')),
    pid: pick('pid', 'pid') === undefined || pick('pid', 'pid') === null ? undefined : numberValue(pick('pid', 'pid')),
    processStartTimeUtc: pick('processStartTimeUtc', 'process_start_time_utc') === undefined ? undefined : optionalString(pick('processStartTimeUtc', 'process_start_time_utc')),
    processStartTimeMono: pick('processStartTimeMono', 'process_start_time_mono') === undefined || pick('processStartTimeMono', 'process_start_time_mono') === null ? undefined : numberValue(pick('processStartTimeMono', 'process_start_time_mono')),
    argvHash: optionalString(pick('argvHash', 'argv_hash')) ?? undefined,
    cwdFingerprint: optionalString(pick('cwdFingerprint', 'cwd_fingerprint')) ?? undefined,
    sessionKey: optionalString(pick('sessionKey', 'session_key')) ?? undefined,
    parentPid: pick('parentPid', 'parent_pid') === undefined || pick('parentPid', 'parent_pid') === null ? undefined : numberValue(pick('parentPid', 'parent_pid')),
    parentStartTimeUtc: pick('parentStartTimeUtc', 'parent_start_time_utc') === undefined ? undefined : optionalString(pick('parentStartTimeUtc', 'parent_start_time_utc')),
    parentStartTimeMono: pick('parentStartTimeMono', 'parent_start_time_mono') === undefined || pick('parentStartTimeMono', 'parent_start_time_mono') === null ? undefined : numberValue(pick('parentStartTimeMono', 'parent_start_time_mono')),
    parentLaunchAttemptId: pick('parentLaunchAttemptId', 'parent_launch_attempt_id') === undefined ? undefined : optionalString(pick('parentLaunchAttemptId', 'parent_launch_attempt_id')),
    sessionProof: raw.sessionProof === true,
    startTimeProof: raw.startTimeProof === true,
    parentProof: raw.parentProof === true
  };
}

function processMatches(row: Row, item: ResourceProcessInventory): boolean {
  if (item.workspaceId !== undefined && item.workspaceId !== String(row.workspace_id)) return false;
  if (item.launchAttemptId !== String(row.launch_attempt_id)) return false;
  if (item.argvHash !== String(row.argv_hash) || item.cwdFingerprint !== String(row.cwd_fingerprint) || item.sessionKey !== String(row.session_key)) return false;
  if (item.launchTokenHash !== undefined && item.launchTokenHash !== String(row.launch_token_hash)) return false;
  if (row.pid !== null && row.pid !== undefined && item.pid !== numberValue(row.pid)) return false;
  if (row.process_start_time_utc !== null && row.process_start_time_utc !== undefined && item.processStartTimeUtc !== String(row.process_start_time_utc)) return false;
  if (row.process_start_time_mono !== null && row.process_start_time_mono !== undefined && item.processStartTimeMono !== numberValue(row.process_start_time_mono)) return false;
  if (row.process_handle !== null && row.process_handle !== undefined && item.processHandle !== String(row.process_handle)) return false;
  const envelope = parseObject(row.envelope_json);
  const expectedParentPid = envelope.parentPid ?? envelope.parent_pid;
  const expectedParentStartUtc = envelope.parentStartTimeUtc ?? envelope.parent_start_time_utc;
  if (expectedParentPid !== undefined && item.parentPid !== numberValue(expectedParentPid)) return false;
  if (expectedParentStartUtc !== undefined && item.parentStartTimeUtc !== String(expectedParentStartUtc)) return false;
  return true;
}

function processHasProof(item: ResourceProcessInventory): boolean {
  return Number.isSafeInteger(item.pid) && Number(item.pid) > 0
    && (item.processStartTimeUtc !== undefined || item.processStartTimeMono !== undefined)
    && typeof item.argvHash === 'string' && item.argvHash.length > 0
    && typeof item.cwdFingerprint === 'string' && item.cwdFingerprint.length > 0
    && typeof item.sessionKey === 'string' && item.sessionKey.length > 0;
}

function processColumns(item: ResourceProcessInventory, row: Row): {
  processHandle: string | null;
  pid: number | null;
  processStartTimeUtc: string | null;
  processStartTimeMono: number | null;
} {
  return {
    processHandle: item.processHandle === undefined ? optionalString(row.process_handle) : item.processHandle,
    pid: item.pid === undefined ? (row.pid === null || row.pid === undefined ? null : numberValue(row.pid)) : item.pid,
    processStartTimeUtc: item.processStartTimeUtc === undefined ? optionalString(row.process_start_time_utc) : item.processStartTimeUtc,
    processStartTimeMono: item.processStartTimeMono === undefined ? (row.process_start_time_mono === null || row.process_start_time_mono === undefined ? null : numberValue(row.process_start_time_mono)) : item.processStartTimeMono
  };
}

function mutationContext(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }, allowTerminalParent = false): { actor: WorkspaceOrchestratorActor; context: Context; pair: { utc: string; mono: number } } {
  const pair = nowFor(options, input);
  const identity = mutationIdentity(input, row);
  const actor = assertFence(database, identity.workspaceId, input, pair.mono);
  validateDispatchOwner(actor, row);
  const context = validateContext(database, { ...input, ...identity } as ResourceDispatchMutationInput, actor, row, pair.mono, allowTerminalParent);
  resolveAcceptance(input as unknown as Readonly<Record<string, unknown>>, [
    { name: 'dispatch', row },
    { name: 'root', row: context.root },
    { name: 'stage', row: context.stage },
    { name: 'parent', row: context.parent }
  ]);
  return { actor, context, pair };
}

function updateDispatch(database: DatabaseSync, row: Row, values: Readonly<Record<string, SQLInputValue>>, whereState = true): Row {
  const columns = Object.keys(values);
  const assignments = columns.map((column) => `${column}=?`).join(', ');
  const params: SQLInputValue[] = columns.map((column) => values[column]);
  let sql = `UPDATE managed_job_dispatches SET ${assignments} WHERE workspace_id=? AND job_id=?`;
  params.push(String(row.workspace_id), String(row.job_id));
  if (whereState) {
    sql += ` AND state IN (${ACTIVE_STATE_SQL})`;
  }
  const result = database.prepare(sql).run(...params);
  if (changed(result) !== 1) throw new ResourceAdmissionError('STATE_CONFLICT', 'dispatch compare-and-swap failed.', { jobId: String(row.job_id) });
  const updated = readDispatch(database, String(row.workspace_id), { jobId: String(row.job_id) });
  if (!updated) throw new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch disappeared after update.', { jobId: String(row.job_id) });
  return updated;
}

function activeOrReplay(row: Row, requestedStatus?: string, requestedHash?: string | null): ResourceAdmissionResult | null {
  const state = String(row.state);
  if (!(RESOURCE_TERMINAL_STATES as readonly string[]).includes(state)) return null;
  if (requestedStatus && String(row.result_status) !== requestedStatus) return admissionFailure(new ResourceAdmissionError('TERMINAL_IMMUTABILITY_CONFLICT', 'terminal dispatch result is immutable.', { jobId: String(row.job_id) }));
  if (requestedHash && String(row.result_hash) !== requestedHash) return admissionFailure(new ResourceAdmissionError('TERMINAL_IMMUTABILITY_CONFLICT', 'terminal dispatch result hash is immutable.', { jobId: String(row.job_id) }));
  return success(state as ResourceAdmissionStatus, row, { replayed: true });
}

function registerRunningCore(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }): ResourceAdmissionResult {
  assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
  const terminal = activeOrReplay(row, undefined, undefined);
  if (terminal) return terminal;
  if (String(row.result_status) === 'waiting_resource') return success('waiting_resource', row, { replayed: true, reasonCode: String(parseObject(row.result_json).reasonCode ?? 'RESOURCE_CAPACITY') });
  const { pair } = mutationContext(database, input, row, options);
  const process = processFromInput(input);
  if (!processHasProof(process)) return admissionFailure(new ResourceAdmissionError('PROCESS_INVENTORY_UNPROVEN', 'running registration requires PID, start time, argv, cwd and session proof.', { jobId: String(row.job_id) }));
  if (!processMatches(row, process)) return admissionFailure(new ResourceAdmissionError('PROCESS_IDENTITY_MISMATCH', 'process inventory does not match dispatch identity.', { jobId: String(row.job_id) }));
  if (!['reserved', 'task_bound', 'spawn_uncertain', 'spawn_started'].includes(String(row.state))) return admissionFailure(new ResourceAdmissionError('STATE_CONFLICT', `cannot register dispatch from state ${String(row.state)}.`));
  const columns = processColumns(process, row);
  const updated = updateDispatch(database, row, {
    state: 'running',
    process_handle: columns.processHandle,
    pid: columns.pid,
    process_start_time_utc: columns.processStartTimeUtc,
    process_start_time_mono: columns.processStartTimeMono,
    register_at: pair.utc,
    updated_at: pair.utc
  });
  return success('running', updated);
}

function settleCore(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }): ResourceAdmissionResult {
  const replayPair = nowFor(options, input);
  assertFence(database, String(row.workspace_id), input, replayPair.mono);
  assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
  const requestedStatus = String(input.terminalStatus ?? input.resultStatus ?? '').trim() || 'succeeded';
  const state = requestedStatus === 'cancelled' ? 'cancelled' : requestedStatus === 'orphaned' ? 'orphaned' : 'terminal';
  const resultValue = input.resultJson !== undefined ? input.resultJson : input.result;
  const computedHash = input.resultHash === undefined || input.resultHash === null ? hashV1({ status: requestedStatus, result: resultValue ?? null }) : String(input.resultHash);
  const replay = activeOrReplay(row, requestedStatus, computedHash);
  if (replay) return replay;
  const { pair } = mutationContext(database, input, row, options, requestedStatus === 'cancelled' || requestedStatus === 'orphaned');
  const resultJson = resultValue === undefined ? null : canonicalJsonV1(resultValue);
  const updated = updateDispatch(database, row, {
    state,
    result_status: requestedStatus,
    result_hash: computedHash,
    result_json: resultJson,
    lease_expires_at_utc: pair.utc,
    lease_expires_at_mono: pair.mono,
    updated_at: pair.utc,
    finished_at: pair.utc
  });
  return success(state as ResourceAdmissionStatus, updated, { readback: { terminalStatus: requestedStatus, resultHash: computedHash } });
}

function bindTaskCore(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }): ResourceAdmissionResult {
  assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
  const terminal = activeOrReplay(row);
  if (terminal) return terminal;
  if (String(row.result_status) === 'waiting_resource') return success('waiting_resource', row, { replayed: true, reasonCode: String(parseObject(row.result_json).reasonCode ?? 'RESOURCE_CAPACITY') });
  const taskId = requiredString(input.taskId ?? input.agentTaskId, 'taskId');
  const { pair } = mutationContext(database, input, row, options);
  if (String(row.state) === 'task_bound') {
    const envelope = parseObject(row.envelope_json);
    if (String(envelope.taskId ?? '') === taskId) return success('task_bound', row, { replayed: true });
    return admissionFailure(new ResourceAdmissionError('RESOURCE_ADMISSION_REPLAY_CONFLICT', 'dispatch is already bound to another task.', { jobId: String(row.job_id) }));
  }
  if (String(row.state) !== 'reserved') return admissionFailure(new ResourceAdmissionError('STATE_CONFLICT', `cannot bind task from state ${String(row.state)}.`));
  const envelope = { ...parseObject(row.envelope_json), taskId, taskIdentity: input.taskIdentity ?? { taskId } };
  const updated = updateDispatch(database, row, { state: 'task_bound', envelope_json: canonicalJsonV1(envelope), updated_at: pair.utc });
  return success('task_bound', updated);
}

function launchCore(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }): ResourceAdmissionResult {
  assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
  const terminal = activeOrReplay(row);
  if (terminal) return terminal;
  if (String(row.result_status) === 'waiting_resource') return success('waiting_resource', row, { replayed: true, reasonCode: String(parseObject(row.result_json).reasonCode ?? 'RESOURCE_CAPACITY') });
  const { pair } = mutationContext(database, input, row, options);
  const expectedAttempt = String(row.launch_attempt_id);
  if (input.launchAttemptId !== undefined && String(input.launchAttemptId) !== expectedAttempt) return admissionFailure(new ResourceAdmissionError('PROCESS_IDENTITY_MISMATCH', 'launchAttemptId differs from the reserved attempt.', { jobId: String(row.job_id) }));
  const suppliedTokenHash = optionalString(input.launchTokenHash)
    ?? (input.launchToken === undefined && input.launchSecret === undefined ? null : sha256Hex(String(input.launchToken ?? input.launchSecret)));
  if (suppliedTokenHash !== null && suppliedTokenHash !== String(row.launch_token_hash)) return admissionFailure(new ResourceAdmissionError('PROCESS_IDENTITY_MISMATCH', 'launch token differs from the reserved attempt.', { jobId: String(row.job_id) }));
  if (!['reserved', 'task_bound'].includes(String(row.state))) return success(String(row.state) as ResourceAdmissionStatus, row, { replayed: true });
  const envelope = { ...parseObject(row.envelope_json), launchAttemptId: expectedAttempt, launchTokenHash: String(row.launch_token_hash) };
  const updated = updateDispatch(database, row, { state: String(row.state) === 'reserved' ? 'task_bound' : 'task_bound', envelope_json: canonicalJsonV1(envelope), updated_at: pair.utc });
  return success('task_bound', updated);
}

function uncertainCore(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }): ResourceAdmissionResult {
  assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
  const terminal = activeOrReplay(row);
  if (terminal) return terminal;
  if (String(row.result_status) === 'waiting_resource') return success('waiting_resource', row, { replayed: true, reasonCode: String(parseObject(row.result_json).reasonCode ?? 'RESOURCE_CAPACITY') });
  const { pair } = mutationContext(database, input, row, options);
  if (String(row.state) === 'spawn_uncertain') return success('spawn_uncertain', row, { replayed: true });
  if (!(RESOURCE_ACTIVE_STATES as readonly string[]).includes(String(row.state))) return admissionFailure(new ResourceAdmissionError('STATE_CONFLICT', `cannot mark spawn uncertain from state ${String(row.state)}.`));
  const process = processFromInput(input);
  const columns = processColumns(process, row);
  const updated = updateDispatch(database, row, {
    state: 'spawn_uncertain',
    process_handle: columns.processHandle,
    pid: columns.pid,
    process_start_time_utc: columns.processStartTimeUtc,
    process_start_time_mono: columns.processStartTimeMono,
    updated_at: pair.utc
  });
  return success('spawn_uncertain', updated);
}

function orphanCore(database: DatabaseSync, input: ResourceDispatchMutationInput, row: Row, options: { nowUtc: () => string; nowMono: () => number }): ResourceAdmissionResult {
  assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
  const status = 'orphaned';
  const value = { status, reasonCode: input.reasonCode ?? 'SPAWN_TERMINATED_CONFIRMED' };
  const resultHash = input.resultHash === undefined || input.resultHash === null ? hashV1(value) : String(input.resultHash);
  const replay = activeOrReplay(row, status, resultHash);
  if (replay) return replay;
  const pair = nowFor(options, input);
  const actor = assertFence(database, String(row.workspace_id), input, pair.mono);
  validateDispatchOwner(actor, row);
  const context = validateContext(database, input, actor, row, pair.mono, true);
  resolveAcceptance(input as unknown as Readonly<Record<string, unknown>>, [
    { name: 'dispatch', row },
    { name: 'root', row: context.root },
    { name: 'stage', row: context.stage },
    { name: 'parent', row: context.parent }
  ]);
  const updated = updateDispatch(database, row, {
    state: 'orphaned',
    result_status: status,
    result_hash: resultHash,
    result_json: canonicalJsonV1(value),
    lease_expires_at_utc: pair.utc,
    lease_expires_at_mono: pair.mono,
    updated_at: pair.utc,
    finished_at: pair.utc
  });
  return success('orphaned', updated, { readback: value });
}

function runTransaction<T>(database: DatabaseSync, work: () => T): T {
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

export class WorkspaceOrchestratorResourceAdmissionStore {
  private readonly database: DatabaseSync;
  private readonly nowUtc: () => string;
  private readonly nowMono: () => number;

  constructor(database: DatabaseSync, options: { nowUtc?: () => string; nowMono?: () => number } = {}) {
    this.database = database;
    this.nowUtc = options.nowUtc ?? (() => new Date().toISOString());
    this.nowMono = options.nowMono ?? (() => Date.now());
  }

  readDispatch(input: { workspaceId: string; jobId?: string; childIdentityKey?: string; operationRequestId?: string; stageRequestId?: string }): ManagedJobDispatchReadback | null {
    const row = readDispatch(this.database, input.workspaceId, input);
    return row ? rowToDispatch(row) : null;
  }

  listDispatches(workspaceId: string, roleId?: WorkspaceOrchestratorResourceRole): readonly ManagedJobDispatchReadback[] {
    const rows = (roleId
      ? this.database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND role_id=? ORDER BY child_ordinal, job_id').all(workspaceId, roleId)
      : this.database.prepare('SELECT * FROM managed_job_dispatches WHERE workspace_id=? ORDER BY child_ordinal, job_id').all(workspaceId)) as Row[];
    return Object.freeze(rows.map(rowToDispatch));
  }

  scheduleJudge(input: JudgeSchedulingInput): JudgeSchedulingResult {
    try {
      return runTransaction(this.database, () => scheduleJudgeCore(this.database, input));
    } catch (error) { return admissionFailure(error) as JudgeSchedulingResult; }
  }

  reserveManagedDispatch(input: ReserveManagedDispatchInput): ResourceAdmissionResult {
    try { return runTransaction(this.database, () => reserveManagedDispatchInTransaction(this.database, input)); } catch (error) { return admissionFailure(error); }
  }

  reserve(input: ReserveManagedDispatchInput): ResourceAdmissionResult { return this.reserveManagedDispatch(input); }

  bindTaskIdentity(input: ResourceDispatchMutationInput): ResourceAdmissionResult {
    try {
      return runTransaction(this.database, () => {
        const row = readDispatch(this.database, input.workspaceId, input);
        if (!row) return admissionFailure(new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch does not exist.'));
        return bindTaskCore(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
      });
    } catch (error) { return admissionFailure(error); }
  }

  bindTask(input: ResourceDispatchMutationInput): ResourceAdmissionResult { return this.bindTaskIdentity(input); }

  persistLaunchAttempt(input: ResourceDispatchMutationInput): ResourceAdmissionResult {
    try {
      return runTransaction(this.database, () => {
        const row = readDispatch(this.database, input.workspaceId, input);
        if (!row) return admissionFailure(new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch does not exist.'));
        return launchCore(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
      });
    } catch (error) { return admissionFailure(error); }
  }

  markLaunchAttempt(input: ResourceDispatchMutationInput): ResourceAdmissionResult { return this.persistLaunchAttempt(input); }

  markSpawnUncertain(input: ResourceDispatchMutationInput): ResourceAdmissionResult {
    try {
      return runTransaction(this.database, () => {
        const row = readDispatch(this.database, input.workspaceId, input);
        if (!row) return admissionFailure(new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch does not exist.'));
        return uncertainCore(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
      });
    } catch (error) { return admissionFailure(error); }
  }

  registerRunning(input: ResourceDispatchMutationInput): ResourceAdmissionResult {
    try {
      return runTransaction(this.database, () => {
        const row = readDispatch(this.database, input.workspaceId, input);
        if (!row) return admissionFailure(new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch does not exist.'));
        return registerRunningCore(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
      });
    } catch (error) { return admissionFailure(error); }
  }

  registerProcess(input: ResourceDispatchMutationInput): ResourceAdmissionResult { return this.registerRunning(input); }

  markSpawnStarted(input: ResourceDispatchMutationInput): ResourceAdmissionResult { return this.registerRunning(input); }

  settleTerminal(input: ResourceDispatchMutationInput): ResourceAdmissionResult {
    try {
      return runTransaction(this.database, () => {
        const row = readDispatch(this.database, input.workspaceId, input);
        if (!row) return admissionFailure(new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch does not exist.'));
        return settleCore(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
      });
    } catch (error) { return admissionFailure(error); }
  }

  settle(input: ResourceDispatchMutationInput): ResourceAdmissionResult { return this.settleTerminal(input); }

  releaseLeases(input: ResourceDispatchMutationInput & { roleId?: WorkspaceOrchestratorResourceRole }): ResourceAdmissionResult | Readonly<{ ok: true; released: readonly ManagedJobDispatchReadback[] }> {
    try {
      return runTransaction(this.database, () => {
        const pair = nowFor({ nowUtc: this.nowUtc, nowMono: this.nowMono }, input);
        const actor = assertFence(this.database, input.workspaceId, input, pair.mono);
        const selected = input.jobId || input.childIdentityKey || input.operationRequestId
          ? [readDispatch(this.database, input.workspaceId, input)].filter((row): row is Row => Boolean(row))
          : (input.roleId
            ? this.database.prepare(`SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND role_id=? AND state IN (${ACTIVE_STATE_SQL}) ORDER BY child_ordinal, job_id`).all(input.workspaceId, input.roleId) as Row[]
            : this.database.prepare(`SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND state IN (${ACTIVE_STATE_SQL}) ORDER BY child_ordinal, job_id`).all(input.workspaceId) as Row[]);
        const released: ManagedJobDispatchReadback[] = [];
        for (const row of selected) {
          validateDispatchOwner(actor, row);
          const context = validateContext(this.database, input, actor, row, pair.mono, true);
          resolveAcceptance(input as unknown as Readonly<Record<string, unknown>>, [
            { name: 'dispatch', row },
            { name: 'root', row: context.root },
            { name: 'stage', row: context.stage },
            { name: 'parent', row: context.parent }
          ]);
          const updated = updateDispatch(this.database, row, { lease_expires_at_utc: pair.utc, lease_expires_at_mono: pair.mono, updated_at: pair.utc });
          released.push(rowToDispatch(updated));
        }
        return Object.freeze({ ok: true, released: Object.freeze(released) });
      });
    } catch (error) { return admissionFailure(error); }
  }

  releaseManagedJobLeases(input: ResourceDispatchMutationInput & { roleId?: WorkspaceOrchestratorResourceRole }): ResourceAdmissionResult | Readonly<{ ok: true; released: readonly ManagedJobDispatchReadback[] }> { return this.releaseLeases(input); }

  adoptOrKill(input: ResourceDispatchMutationInput): AdoptOrKillResult {
    try {
      return runTransaction(this.database, () => {
        const row = readDispatch(this.database, input.workspaceId, input);
        if (!row) return admissionFailure(new ResourceAdmissionError('WORKSPACE_STALE', 'dispatch does not exist.')) as AdoptOrKillResult;
        assertInputMatchesDispatch(row, input as unknown as Readonly<Record<string, unknown>>);
        const terminal = activeOrReplay(row);
        if (terminal) return { ...terminal, action: 'orphaned' } as AdoptOrKillResult;
        if (String(row.result_status) === 'waiting_resource') return { ...success('waiting_resource', row, { replayed: true, reasonCode: String(parseObject(row.result_json).reasonCode ?? 'RESOURCE_CAPACITY') }), action: 'kill_drain', requiredActions: [] } as AdoptOrKillResult;
        const { pair } = mutationContext(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
        const inventory = inventoryList(input);
        const exact = inventory.processes.filter((item) => processMatches(row, item) && processHasProof(item));
        const hasTerminationProof = input.spawnConfirmed === false || (input.terminationConfirmed === true && (input.drainConfirmed === true || input.confirmedNoProcess === true));
        if (inventory.known && exact.length === 1 && inventory.processes.length === 1) {
          const process = exact[0];
          const columns = processColumns(process, row);
          const adopted = updateDispatch(this.database, row, {
            state: 'running',
            process_handle: columns.processHandle,
            pid: columns.pid,
            process_start_time_utc: columns.processStartTimeUtc,
            process_start_time_mono: columns.processStartTimeMono,
            register_at: pair.utc,
            updated_at: pair.utc
          });
          return { ...success('adopted', adopted, { readback: { adopted: true, launchAttemptId: String(row.launch_attempt_id) } }), action: 'adopt', requiredActions: [] } as AdoptOrKillResult;
        }
        if (hasTerminationProof && (inventory.processes.length === 0 || exact.length === 0)) {
          const orphaned = orphanCore(this.database, input, row, { nowUtc: this.nowUtc, nowMono: this.nowMono });
          return { ...orphaned, action: 'orphaned', requiredActions: [] } as AdoptOrKillResult;
        }
        let uncertain = row;
        if (String(row.state) !== 'spawn_uncertain') {
          uncertain = updateDispatch(this.database, row, { state: 'spawn_uncertain', updated_at: pair.utc });
        }
        return {
          ...success('spawn_uncertain', uncertain, { readback: { inventoryKnown: inventory.known, candidateCount: inventory.processes.length, exactCount: exact.length } }),
          action: 'kill_drain',
          requiredActions: REQUIRED_DRAIN_ACTIONS
        } as AdoptOrKillResult;
      });
    } catch (error) { return admissionFailure(error) as AdoptOrKillResult; }
  }

  decideAdoptOrKill(input: ResourceDispatchMutationInput): AdoptOrKillResult { return this.adoptOrKill(input); }

  reconcileSpawn(input: ResourceDispatchMutationInput): AdoptOrKillResult { return this.adoptOrKill(input); }

  recoverDispatch(input: ResourceDispatchMutationInput): AdoptOrKillResult { return this.adoptOrKill(input); }
}

export function createWorkspaceOrchestratorResourceAdmissionStore(database: DatabaseSync, options: { nowUtc?: () => string; nowMono?: () => number } = {}): WorkspaceOrchestratorResourceAdmissionStore {
  return new WorkspaceOrchestratorResourceAdmissionStore(database, options);
}
