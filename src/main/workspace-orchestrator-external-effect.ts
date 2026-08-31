import type { DatabaseSync } from 'node:sqlite';
import {
  createWorkspaceOrchestratorSnapshotStore,
  type EffectConsumptionReadback,
  type ReserveEffectConsumptionInput,
  type SettleEffectConsumptionInput,
  type SnapshotFailure,
  type WorkspaceOrchestratorSnapshotStore
} from './workspace-orchestrator-snapshots.ts';
import { hashV1, type ActorFence } from './workspace-orchestrator-actor.ts';

export type ExternalEffectDeliveryMode = 'exactly_once' | 'at_most_once' | 'at_least_once';

export const EXTERNAL_EFFECT_IDENTITY_MISMATCH = 'EXTERNAL_EFFECT_IDENTITY_MISMATCH';
export const EXTERNAL_EFFECT_SINK_ERROR = 'EXTERNAL_EFFECT_SINK_ERROR';
export const EXTERNAL_EFFECT_STATE_CONFLICT = 'EXTERNAL_EFFECT_STATE_CONFLICT';
export const EXTERNAL_EFFECT_RECONCILE_REQUIRED = 'EXTERNAL_EFFECT_RECONCILE_REQUIRED';
export const EXTERNAL_EFFECT_NOT_FOUND = 'EXTERNAL_EFFECT_NOT_FOUND';

export type ExternalEffectSinkIdentity = Readonly<{
  sinkName: string;
  sinkRoleId: string;
  contractVersion: string;
  deliveryMode: ExternalEffectDeliveryMode;
}>;

export type ExternalEffectIdentity = Readonly<ExternalEffectSinkIdentity & {
  effectToken: string;
  payloadHash: string;
}>;

export type ExternalEffectCommitRequest = Readonly<{
  consumptionId: string;
  effectRequestId: string;
  identity: ExternalEffectIdentity;
  payload?: unknown;
}>;

export type ExternalEffectCommitReceipt = Readonly<ExternalEffectIdentity & {
  resultHash: string;
  outcomeQueryKey: string;
  result?: unknown;
}>;

export type ExternalEffectOutcomeQueryRequest = Readonly<{
  consumptionId: string;
  outcomeQueryKey: string | null;
  identity: ExternalEffectIdentity;
}>;

export type ExternalEffectOutcomeReadback = Readonly<ExternalEffectIdentity & {
  status: 'committed' | 'not_committed' | 'unknown';
  outcomeQueryKey: string;
  resultHash?: string | null;
  result?: unknown;
  error?: unknown;
}>;

/**
 * A sink owns the external idempotency boundary.  It must persist effectToken
 * before acknowledging a commit and return the same receipt for an identical
 * token/payload replay.
 */
export type ExternalEffectSink = Readonly<ExternalEffectSinkIdentity & {
  commit(request: ExternalEffectCommitRequest): ExternalEffectCommitReceipt;
  query(request: ExternalEffectOutcomeQueryRequest): ExternalEffectOutcomeReadback;
}>;

export type ExternalEffectIdentityInput = Readonly<{
  sinkName: string;
  sinkRoleId: string;
  contractVersion?: string;
  sinkContractVersion?: string;
  deliveryMode: ExternalEffectDeliveryMode;
  effectToken: string;
  payloadHash: string;
}>;

export type ExternalEffectConsumptionReference = Readonly<{
  workspaceId: string;
  consumptionId?: string;
  operationRequestId?: string;
  effectRequestId?: string;
}>;

type ConsumptionReference = ExternalEffectConsumptionReference;

type ExternalEffectRequestBase = ConsumptionReference & ExternalEffectIdentityInput & Readonly<{
  payload?: unknown;
  nowUtc?: string;
  nowMono?: number;
}>;

export type CommitReservedEffectInput = ExternalEffectRequestBase;

export type ReconcileEffectConsumptionInput = ExternalEffectRequestBase & Readonly<{
  fence: ActorFence;
  outcomeQueryKey?: string | null;
  expectedStageClaimRevision?: number;
  stageClaimRevision?: number;
  acceptance?: SettleEffectConsumptionInput['acceptance'];
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
}>;

export type ExternalEffectStoreResult<T> = Readonly<{
  ok: true;
  value: T;
  replayed?: boolean;
  readback?: unknown;
}> | SnapshotFailure;

export type ExternalEffectAdapterResult<T> = Readonly<{
  ok: true;
  value: T;
  replayed?: boolean;
  readback?: unknown;
}> | Readonly<{
  ok: false;
  code: string;
  reasonCode: string;
  message: string;
  readback?: unknown;
}>;

export type ExternalEffectAdapterOptions = Readonly<{
  snapshotStore?: WorkspaceOrchestratorSnapshotStore;
  nowUtc?: () => string;
  nowMono?: () => number;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function required(value: unknown, field: string): string {
  const result = String(value ?? '');
  if (!result.trim()) throw new Error(`${field} is required`);
  return result;
}

function failure(code: string, message: string, readback?: unknown): ExternalEffectAdapterResult<never> {
  return Object.freeze({ ok: false, code, reasonCode: code, message, readback });
}

function errorCode(error: unknown): string | null {
  const code = record(error).code;
  return typeof code === 'string' && code ? code : null;
}

function sinkFailure(error: unknown): ExternalEffectAdapterResult<never> {
  const code = errorCode(error);
  if (code === EXTERNAL_EFFECT_IDENTITY_MISMATCH) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink rejected a conflicting effect identity.');
  }
  return failure(EXTERNAL_EFFECT_SINK_ERROR, error instanceof Error ? error.message : String(error));
}

function sameField(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && actual === expected;
}

function identityFromInput(input: ExternalEffectIdentityInput): ExternalEffectIdentity | null {
  if (input.contractVersion !== undefined && input.sinkContractVersion !== undefined
    && String(input.contractVersion) !== String(input.sinkContractVersion)) return null;
  const contractVersion = input.contractVersion ?? input.sinkContractVersion;
  try {
    return Object.freeze({
      sinkName: required(input.sinkName, 'sinkName'),
      sinkRoleId: required(input.sinkRoleId, 'sinkRoleId'),
      contractVersion: required(contractVersion, 'contractVersion'),
      deliveryMode: input.deliveryMode,
      effectToken: required(input.effectToken, 'effectToken'),
      payloadHash: required(input.payloadHash, 'payloadHash')
    });
  } catch {
    return null;
  }
}

function localIdentity(consumption: EffectConsumptionReadback): ExternalEffectIdentity {
  return Object.freeze({
    sinkName: consumption.sinkName,
    sinkRoleId: consumption.sinkRoleId,
    contractVersion: consumption.sinkContractVersion,
    deliveryMode: consumption.deliveryMode as ExternalEffectDeliveryMode,
    effectToken: consumption.effectToken,
    payloadHash: consumption.payloadHash
  });
}

function identityMatches(actual: unknown, expected: ExternalEffectIdentity): boolean {
  const value = record(actual);
  return sameField(value.sinkName, expected.sinkName)
    && sameField(value.sinkRoleId, expected.sinkRoleId)
    && sameField(value.contractVersion, expected.contractVersion)
    && sameField(value.deliveryMode, expected.deliveryMode)
    && sameField(value.effectToken, expected.effectToken)
    && sameField(value.payloadHash, expected.payloadHash);
}
function sinkIdentityMatches(actual: unknown, expected: ExternalEffectSinkIdentity): boolean {
  const value = record(actual);
  return sameField(value.sinkName, expected.sinkName)
    && sameField(value.sinkRoleId, expected.sinkRoleId)
    && sameField(value.contractVersion, expected.contractVersion)
    && sameField(value.deliveryMode, expected.deliveryMode);
}

function validateIdentity(
  consumption: EffectConsumptionReadback,
  input: ExternalEffectIdentityInput & Partial<ExternalEffectConsumptionReference>,
  sink: ExternalEffectSink
): ExternalEffectAdapterResult<ExternalEffectIdentity> {
  if ((input.consumptionId !== undefined && input.consumptionId !== consumption.consumptionId)
    || (input.operationRequestId !== undefined && input.operationRequestId !== consumption.operationRequestId)
    || (input.effectRequestId !== undefined && input.effectRequestId !== consumption.effectRequestId)) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External effect consumption reference drifted.', consumption);
  }
  const supplied = identityFromInput(input);
  const expected = localIdentity(consumption);
  if (!supplied || !identityMatches(supplied, expected) || !sinkIdentityMatches(sink, expected)) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External effect identity does not match the reserved consumption and sink contract.', consumption);
  }
  return { ok: true, value: expected };
}

function validatePayload(payload: unknown, expectedHash: string): ExternalEffectAdapterResult<null> {
  try {
    if (payload !== undefined && hashV1(payload) !== expectedHash) {
      return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External effect payloadHash does not match the reserved payload.', { payloadHash: expectedHash });
    }
    return { ok: true, value: null };
  } catch {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External effect payloadHash could not be verified.', { payloadHash: expectedHash });
  }
}

function validateReceipt(
  receipt: unknown,
  expected: ExternalEffectIdentity
): ExternalEffectAdapterResult<ExternalEffectCommitReceipt> {
  const value = record(receipt);
  if (!identityMatches(value, expected)) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink commit receipt identity drifted.', value);
  }
  const resultHash = value.resultHash;
  const outcomeQueryKey = value.outcomeQueryKey;
  if (typeof resultHash !== 'string' || !resultHash.trim() || typeof outcomeQueryKey !== 'string' || !outcomeQueryKey.trim()) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink commit receipt is missing resultHash or outcomeQueryKey.', value);
  }
  if (value.result !== undefined) {
    try {
      if (hashV1(value.result) !== resultHash) return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink commit receipt resultHash drifted.', value);
    } catch {
      return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink commit receipt resultHash could not be verified.', value);
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...expected,
      resultHash,
      outcomeQueryKey,
      ...(value.result === undefined ? {} : { result: value.result })
    })
  };
}

function validateOutcome(
  outcome: unknown,
  expected: ExternalEffectIdentity,
  expectedQueryKey: string | null
): ExternalEffectAdapterResult<ExternalEffectOutcomeReadback> {
  const value = record(outcome);
  if (!identityMatches(value, expected)) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink outcome readback identity drifted.', value);
  }
  const status = value.status;
  if (status !== 'committed' && status !== 'not_committed' && status !== 'unknown') {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink outcome status is invalid.', value);
  }
  const outcomeQueryKey = value.outcomeQueryKey;
  if (typeof outcomeQueryKey !== 'string' || !outcomeQueryKey.trim() || (expectedQueryKey !== null && outcomeQueryKey !== expectedQueryKey)) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink outcome query key drifted.', value);
  }
  if (value.resultHash !== null && value.resultHash !== undefined && typeof value.resultHash !== 'string') {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink outcome resultHash is invalid.', value);
  }
  const resultHash = value.resultHash === null || value.resultHash === undefined ? null : value.resultHash;
  if (status === 'committed' && !resultHash?.trim()) {
    return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'Committed external outcome is missing resultHash.', value);
  }
  if (resultHash && value.result !== undefined) {
    try {
      if (hashV1(value.result) !== resultHash) return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink outcome resultHash drifted.', value);
    } catch {
      return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External sink outcome resultHash could not be verified.', value);
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...expected,
      status,
      outcomeQueryKey,
      resultHash,
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.error === undefined ? {} : { error: value.error })
    })
  };
}

function terminalState(state: string): boolean {
  return state === 'consumed' || state === 'failed' || state === 'cancelled' || state === 'orphaned';
}

export class ExternalEffectAdapter {
  private readonly snapshotStore: WorkspaceOrchestratorSnapshotStore;
  private readonly sink: ExternalEffectSink;

  constructor(database: DatabaseSync, sink: ExternalEffectSink, options: ExternalEffectAdapterOptions = {}) {
    this.snapshotStore = options.snapshotStore ?? createWorkspaceOrchestratorSnapshotStore(database, {
      nowUtc: options.nowUtc,
      nowMono: options.nowMono
    });
    this.sink = sink;
  }

  readEffectConsumption(input: ExternalEffectConsumptionReference): EffectConsumptionReadback | null {
    return this.snapshotStore.readEffectConsumption(input);
  }

  reserveEffectConsumption(input: ReserveEffectConsumptionInput): ExternalEffectStoreResult<EffectConsumptionReadback> {
    return this.snapshotStore.reserveEffectConsumption(input);
  }

  commitReservedEffect(input: CommitReservedEffectInput): ExternalEffectAdapterResult<ExternalEffectCommitReceipt> {
    const consumption = this.snapshotStore.readEffectConsumption(input);
    if (!consumption) return failure(EXTERNAL_EFFECT_NOT_FOUND, 'Reserved effect consumption does not exist.');
    const identity = validateIdentity(consumption, input, this.sink);
    if (!identity.ok) return identity;
    const payload = validatePayload(input.payload, identity.value.payloadHash);
    if (!payload.ok) return payload;
    if (terminalState(consumption.state)) {
      return failure(EXTERNAL_EFFECT_STATE_CONFLICT, 'Terminal effect consumption cannot be externally committed again.', consumption);
    }
    if (consumption.state === 'unknown') {
      return failure(EXTERNAL_EFFECT_RECONCILE_REQUIRED, 'Unknown effect consumption must be reconciled by outcome query before commit.', consumption);
    }
    try {
      const receipt = this.sink.commit({
        consumptionId: consumption.consumptionId,
        effectRequestId: consumption.effectRequestId,
        identity: identity.value,
        ...(input.payload === undefined ? {} : { payload: input.payload })
      });
      const validated = validateReceipt(receipt, identity.value);
      if (!validated.ok) return validated;
      return { ok: true, value: validated.value, readback: { consumption, receipt: validated.value } };
    } catch (error) {
      return sinkFailure(error);
    }
  }

  reconcileEffectConsumption(input: ReconcileEffectConsumptionInput): ExternalEffectAdapterResult<EffectConsumptionReadback> {
    const consumption = this.snapshotStore.readEffectConsumption(input);
    if (!consumption) return failure(EXTERNAL_EFFECT_NOT_FOUND, 'Effect consumption does not exist.');
    const identity = validateIdentity(consumption, input, this.sink);
    if (!identity.ok) return identity;
    const payload = validatePayload(input.payload, identity.value.payloadHash);
    if (!payload.ok) return payload;
    if (terminalState(consumption.state)) {
      return { ok: true, value: consumption, replayed: true, readback: { consumption } };
    }
    const requestedQueryKey = consumption.outcomeQueryKey ?? input.outcomeQueryKey ?? null;
    if (consumption.outcomeQueryKey !== null && input.outcomeQueryKey !== undefined && input.outcomeQueryKey !== null
      && input.outcomeQueryKey !== consumption.outcomeQueryKey) {
      return failure(EXTERNAL_EFFECT_IDENTITY_MISMATCH, 'External effect outcomeQueryKey drifted.', consumption);
    }
    try {
      const outcome = this.sink.query({
        consumptionId: consumption.consumptionId,
        outcomeQueryKey: requestedQueryKey,
        identity: identity.value
      });
      const validated = validateOutcome(outcome, identity.value, requestedQueryKey);
      if (!validated.ok) return validated;
      const query = validated.value;
      const settleInput: SettleEffectConsumptionInput = {
        workspaceId: consumption.workspaceId,
        consumptionId: consumption.consumptionId,
        effectToken: identity.value.effectToken,
        payloadHash: identity.value.payloadHash,
        sinkName: identity.value.sinkName,
        sinkRoleId: identity.value.sinkRoleId,
        sinkContractVersion: identity.value.contractVersion,
        deliveryMode: identity.value.deliveryMode,
        state: query.status === 'committed' ? 'consumed' : query.status === 'unknown' ? 'unknown' : 'failed',
        outcome: query.result,
        outcomeHash: query.resultHash ?? null,
        outcomeQueryKey: query.outcomeQueryKey,
        error: query.status === 'not_committed'
          ? { reasonCode: 'EXTERNAL_EFFECT_NOT_COMMITTED' }
          : query.status === 'unknown'
            ? (query.error ?? { reasonCode: 'EXTERNAL_EFFECT_OUTCOME_UNKNOWN' })
            : undefined,
        expectedStageClaimRevision: input.expectedStageClaimRevision ?? input.stageClaimRevision ?? consumption.expectedStageClaimRevision,
        acceptance: input.acceptance,
        acceptanceRunId: input.acceptanceRunId,
        baselineEventSequence: input.baselineEventSequence,
        baselineCheckpointRevision: input.baselineCheckpointRevision,
        createdAfterEventSequence: input.createdAfterEventSequence,
        createdAfterCheckpointRevision: input.createdAfterCheckpointRevision,
        createdAfterMono: input.createdAfterMono,
        fence: input.fence,
        nowUtc: input.nowUtc,
        nowMono: input.nowMono
      };
      const settled = this.snapshotStore.settleEffectConsumption(settleInput);
      if (!settled.ok) return failure(settled.code, settled.message, { query, settlement: settled });
      return { ok: true, value: settled.value, readback: { query, settlement: settled.readback, consumption: settled.value } };
    } catch (error) {
      return sinkFailure(error);
    }
  }
}

export function createExternalEffectAdapter(
  database: DatabaseSync,
  sink: ExternalEffectSink,
  options: ExternalEffectAdapterOptions = {}
): ExternalEffectAdapter {
  return new ExternalEffectAdapter(database, sink, options);
}

export const WorkspaceOrchestratorExternalEffectAdapter = ExternalEffectAdapter;
export const createWorkspaceOrchestratorExternalEffectAdapter = createExternalEffectAdapter;
