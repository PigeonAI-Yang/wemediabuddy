import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonV1,
  hashV1,
  readWorkspaceOrchestratorActor,
  sha256Hex,
  WorkspaceOrchestratorActorError,
  type ActorFence,
  type WorkspaceOrchestratorActor,
} from "./workspace-orchestrator-actor.ts";
import {
  isWorkspaceOrchestratorCrashInjectedError,
  invokeWorkspaceOrchestratorCrashBarrier,
  type CrashBarrierBundle,
  type CrashBarrierContext,
  type CrashBarrierPhase,
  type WorkspaceOrchestratorCrashBarrier,
} from "./workspace-orchestrator-crash-barrier.ts";

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
type ProgressMeasure = Readonly<{
  gapHash: string;
  projectionHash: string;
  missingRequiredEvidenceCount: number;
  invalidCount: number;
  pendingCount: number;
  coverageGapCount: number;
  trustedReceiptCount: number;
  eligibleCount: number;
  orderedMissingEvidenceIds: readonly string[];
  orderedGapItemIds: readonly string[];
  orderedCandidatePlanItemIds: readonly string[];
}>;

type ProgressState = Readonly<{
  progressBefore: ProgressMeasure;
  progressAfter: ProgressMeasure;
  progressMeasureVersion: 2;
  progressOrdinal: number;
  strictProgress: boolean;
}>;
type RepairBindingResult = Readonly<{
  bindingKind: "initial_source" | "repaired";
  repairSnapshotId: string | null;
  repairSnapshotHash: string | null;
  bindingHash: string | null;
  repairRow: Row | null;
  predecessorRow: Row | null;
}>;
type FenceInput = ActorFence | Readonly<{ fence: ActorFence }>;
export type AcceptanceProvenanceInput = Readonly<{
  acceptanceRunId: string | null;
  baselineEventSequence: number | null;
  baselineCheckpointRevision: number | null;
  createdAfterEventSequence: number | null;
  createdAfterCheckpointRevision: number | null;
  createdAfterMono: number | null;
}>;
type AcceptanceTuple = [
  string | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export type SnapshotFailure = Readonly<{
  ok: false;
  code: string;
  reasonCode: string;
  message: string;
  readback?: unknown;
}>;

export type SourceChannelPartition = Readonly<{
  channelId: string;
  requiredness?: "required" | "optional";
  reasonCode?: string | null;
  receiptId?: string | null;
  [key: string]: unknown;
}>;

export type SourceReceiptBinding = Readonly<{
  receiptId: string;
  receiptRevision: number;
  receiptPayloadHash: string;
  [key: string]: unknown;
}>;

export type SourceBinding = Readonly<{
  sourceId: string;
  sourceRevision: number;
  sourceContentHash: string;
  priority?: number;
  [key: string]: unknown;
}>;

export type FreezeSourceSnapshotInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  stageRequestId: string;
  sourceTaskId?: string | null;
  scanAttemptId?: string;
  preflightId: string;
  policyHash: string;
  profileRevision: number;
  selectedChannelIds?: readonly string[];
  selectedChannelPartition?: Readonly<{
    selectedChannelIds: readonly string[];
    successfulChannels?: readonly SourceChannelPartition[];
    failedChannels?: readonly SourceChannelPartition[];
    unresolvedChannels?: readonly SourceChannelPartition[];
  }>;
  successfulChannels?: readonly SourceChannelPartition[];
  failedChannels?: readonly SourceChannelPartition[];
  unresolvedChannels?: readonly SourceChannelPartition[];
  sourceIds?: readonly string[];
  sourceBindings?: readonly SourceBinding[];
  sources?: readonly SourceBinding[];
  receiptIds?: readonly string[];
  receiptBindings?:
    | readonly SourceReceiptBinding[]
    | Readonly<Record<string, Omit<SourceReceiptBinding, "receiptId">>>;
  watermarkUtc?: string;
  watermarkMono?: number;
  capturedAtUtc?: string;
  excludedByBudgetCount?: number;
  currentSourceBindings?: readonly SourceBinding[];
  currentChannelFences?:
    readonly JsonRecord[] | Readonly<Record<string, JsonRecord>>;
  acceptance?: AcceptanceProvenanceInput | null;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  expectedClaimRevision?: number;
  expectedIndexRevision?: number;
  fence?: FenceInput;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  nowUtc?: string;
  nowMono?: number;
}>;

export type FreezePlanScopeProjectionInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  stageRequestId: string;
  sourceSnapshotHash: string;
  sourceSnapshotStageRequestId?: string;
  managerTaskId?: string;
  orchestrationId?: string;
  attemptStage?: "scan" | "full" | "judge" | "stage_d" | "research";
  allowedPlanIds: readonly string[];
  allowedPlanItemIds: readonly string[];
  carryPlanItemIds?: readonly string[];
  trustedReceiptIds?: readonly string[];
  scope?: JsonRecord;
  acceptance?: AcceptanceProvenanceInput | null;
  projection?: JsonRecord;
  planIds?: readonly string[];
  asOf?: unknown;
  entries?: readonly JsonRecord[];
  candidatePlanItemIds?: readonly string[];
  eligiblePlanItemIds?: readonly string[];
  pendingPlanItemIds?: readonly string[];
  invalidPlanItemIds?: readonly string[];
  coverageGap?: readonly unknown[];
  orderedCandidatePlanItemIds?: readonly string[];
  missingRequiredEvidenceIds?: readonly string[];
  gapItemIds?: readonly string[];
  orderedGapItemIds?: readonly string[];
  gapHash?: string;
  progressBefore?: JsonRecord;
  progressAfter?: JsonRecord;
  progressMeasureVersion?: number;
  progressOrdinal?: number;
  predecessorScopeId?: string;
  predecessorScopeHash?: string;
  candidateInputCount?: number;
  classifiedCount?: number;
  emptyQualified?: boolean;
  evidenceSuccessorOrdinal?: number;
  successorOrdinal?: number;
  maxEvidenceSuccessors?: number;
  repair?: JsonRecord;
  repairItems?: readonly JsonRecord[];
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  expectedClaimRevision?: number;
  claimRevision?: number;
  expectedIndexRevision?: number;
  fence?: FenceInput;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  nowUtc?: string;
  nowMono?: number;
}>;

export type ArchivePlanScopeInput = Readonly<{
  workspaceId: string;
  scopeId: string;
  scopeHash: string;
  reasonCode: string;
  fence?: FenceInput;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  nowUtc?: string;
  nowMono?: number;
}>;

export type ArchivedPlanScopeReadback = PlanScopeProjectionReadback & Readonly<{
  archiveAnchorHash: string;
  archivedAt: string;
  archiveReasonCode: string;
}>;

export type FreezeStageDTargetEffectInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  stageRequestId: string;
  cycleId?: string | null;
  targets?: readonly JsonRecord[];
  targetSnapshots?: readonly JsonRecord[];
  targetIds?: readonly string[];
  effects?: readonly JsonRecord[];
  effectSpecs?: readonly JsonRecord[];
  coverage?: unknown;
  retryTargetIds?: readonly string[];
  acceptance?: AcceptanceProvenanceInput | null;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  targetSetHash?: string;
  effectSetHash?: string;
  expectedClaimRevision?: number;
  claimRevision?: number;
  expectedIndexRevision?: number;
  fence?: FenceInput;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  nowUtc?: string;
  nowMono?: number;
}>;

export type ReserveEffectConsumptionInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  stageRequestId: string;
  orchestrationId?: string;
  managerTaskId?: string;
  operationRequestId?: string;
  operationKind?: string;
  operationOrdinal?: number;
  operationInputHash?: string;
  effectRequestId?: string;
  effectLogicalKey?: string;
  effectSetHash: string;
  roleId: string;
  sinkName: string;
  sinkRoleId: string;
  sinkContractVersion: string;
  deliveryMode: "exactly_once" | "at_most_once" | "at_least_once";
  payloadHash: string;
  acceptance?: AcceptanceProvenanceInput | null;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  effectToken?: string;
  sinkCapabilityProofHash?: string;
  sinkCapabilityProof?: unknown;
  sourceDispatchJobId: string;
  sourceResultHash: string;
  expectedStageClaimRevision?: number;
  stageClaimRevision?: number;
  fence?: FenceInput;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  leaseExpiresAtUtc?: string;
  leaseExpiresAtMono?: number;
  nowUtc?: string;
  nowMono?: number;
}>;

export type SettleEffectConsumptionInput = Readonly<{
  workspaceId: string;
  consumptionId?: string;
  operationRequestId?: string;
  effectRequestId?: string;
  effectToken?: string;
  state?:
    | "unknown"
    | "consumed"
    | "failed"
    | "cancelled"
    | "orphaned"
    | "partial"
    | "succeeded"
    | "success";
  status?: string;
  outcome?: unknown;
  outcomeHash?: string | null;
  outcomeQueryKey?: string | null;
  error?: unknown;
  payloadHash?: string;
  sinkName?: string;
  sinkRoleId?: string;
  sinkContractVersion?: string;
  deliveryMode?: "exactly_once" | "at_most_once" | "at_least_once";
  expectedStageClaimRevision?: number;
  stageClaimRevision?: number;
  acceptance?: AcceptanceProvenanceInput | null;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  fence?: FenceInput;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  nowUtc?: string;
  nowMono?: number;
}>;

export type SourceSnapshotReadback = Readonly<
  JsonRecord & {
    snapshotId: string;
    snapshotHash: string;
    workspaceId: string;
    status: "frozen" | "stale" | "superseded";
  }
>;

export type PlanScopeProjectionReadback = Readonly<
  JsonRecord & {
    scopeId: string;
    scopeHash: string;
    projectionHash: string;
    scopeStatus: string;
    projection: JsonRecord;
  }
>;

export type StageDTargetEffectReadback = Readonly<
  JsonRecord & {
    stageRequestId: string;
    targetSetHash: string;
    effectSetHash: string;
  }
>;

export type EffectConsumptionReadback = Readonly<
  JsonRecord & {
    consumptionId: string;
    workspaceId: string;
    operationRequestId: string;
    effectRequestId: string;
    effectToken: string;
    payloadHash: string;
    sinkName: string;
    sinkRoleId: string;
    sinkContractVersion: string;
    deliveryMode: "exactly_once" | "at_most_once" | "at_least_once";
    outcomeQueryKey: string | null;
    state: string;
    expectedStageClaimRevision: number;
  }
>;

type AnyResult<T> =
  | Readonly<{ ok: true; value: T; replayed?: boolean; readback?: unknown }>
  | SnapshotFailure;

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function normalizedString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  const result = String(value ?? "")
    .normalize("NFC")
    .trim();
  if (!allowEmpty && !result)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 不能为空。`,
    );
  return result;
}

function finiteNumber(value: unknown, field: string, minimum = 0): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是 >= ${minimum} 的有限数。`,
    );
  return Math.trunc(result);
}
function acceptanceNumber(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是非负安全整数。`,
    );
  return result;
}

function numberOr(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是数组。`,
    );
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalizedString(item, `${field} item`);
    if (seen.has(normalized))
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        `${field} 包含重复值: ${normalized}`,
      );
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort(compareCodePoints);
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "持久 JSON 无法解析。",
    );
  }
}

function jsonArray(value: unknown): unknown[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonObject(value: unknown): JsonRecord {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : {};
}

function normalizeUtc(value: unknown, fallback: string): string {
  const candidate =
    value === undefined || value === null || value === ""
      ? fallback
      : String(value);
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime()))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `无效 UTC instant: ${candidate}`,
    );
  return parsed.toISOString();
}

function nowPair(
  inputUtc: unknown,
  inputMono: unknown,
  defaults: { nowUtc: () => string; nowMono: () => number },
): { utc: string; mono: number } {
  const utc = normalizeUtc(
    inputUtc,
    normalizeUtc(defaults.nowUtc(), new Date().toISOString()),
  );
  const rawMono =
    inputMono === undefined || inputMono === null
      ? defaults.nowMono()
      : Number(inputMono);
  if (!Number.isFinite(rawMono) || rawMono < 0)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "monotonic tick 必须是非负有限数。",
    );
  return { utc, mono: Math.trunc(rawMono) };
}

function affectedRows(result: unknown): number {
  const value = (result as { changes?: number | bigint } | undefined)?.changes;
  return value === undefined ? 0 : Number(value);
}

function failure(
  code: string,
  message: string,
  readback?: unknown,
): SnapshotFailure {
  return Object.freeze({
    ok: false,
    code,
    reasonCode: code,
    message,
    readback,
  });
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (isWorkspaceOrchestratorCrashInjectedError(error))
    return { code: error.code, message: error.message, details: error.context };
  if (error instanceof WorkspaceOrchestratorActorError)
    return { code: error.code, message: error.message, details: error.details };
  if (error instanceof Error)
    return { code: "ORCHESTRATOR_CONTRACT_ERROR", message: error.message };
  return { code: "ORCHESTRATOR_CONTRACT_ERROR", message: String(error) };
}

function extractFence(input: JsonRecord): Partial<ActorFence> | null {
  const source =
    input.fence && typeof input.fence === "object"
      ? (input.fence as JsonRecord)
      : input;
  const nested =
    source.fence && typeof source.fence === "object"
      ? (source.fence as JsonRecord)
      : source;
  const runtimeEpoch = nested.runtimeEpoch ?? nested.actorEpoch;
  const ownerEpoch = nested.ownerEpoch;
  const authorityRevision = nested.authorityRevision;
  const leaseToken = nested.leaseToken;
  const workspaceId = nested.workspaceId;
  if (
    runtimeEpoch === undefined &&
    ownerEpoch === undefined &&
    authorityRevision === undefined &&
    leaseToken === undefined &&
    workspaceId === undefined
  )
    return null;
  return {
    workspaceId: workspaceId === undefined ? undefined : String(workspaceId),
    runtimeEpoch:
      runtimeEpoch === undefined
        ? undefined
        : finiteNumber(runtimeEpoch, "runtimeEpoch", 1),
    ownerEpoch:
      ownerEpoch === undefined
        ? undefined
        : finiteNumber(ownerEpoch, "ownerEpoch", 1),
    authorityRevision:
      authorityRevision === undefined
        ? undefined
        : finiteNumber(authorityRevision, "authorityRevision", 1),
    leaseToken: leaseToken === undefined ? undefined : String(leaseToken),
  };
}

function requireActor(
  database: DatabaseSync,
  input: JsonRecord,
  workspaceId: string,
  nowMono: number,
): WorkspaceOrchestratorActor {
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  if (!actor)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "workspace Actor 不存在。",
      { workspaceId },
    );
  const fence = extractFence(input);
  if (
    !fence ||
    fence.workspaceId !== workspaceId ||
    fence.runtimeEpoch !== actor.runtimeEpoch ||
    fence.ownerEpoch !== actor.ownerEpoch ||
    fence.authorityRevision !== actor.authorityRevision ||
    fence.leaseToken !== actor.leaseToken
  ) {
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor fence 与当前 workspace 不一致。",
      { workspaceId },
    );
  }
  if (actor.actorStatus === "failed" || !actor.leaseToken)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "当前 Actor 不可写。",
    );
  if (actor.writeFence !== "allow")
    throw new WorkspaceOrchestratorActorError(
      "WRITE_FENCE_BLOCKED",
      "workspace write fence 未允许业务写。",
    );
  if (actor.leaseExpiresAtMono !== null && nowMono >= actor.leaseExpiresAtMono)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor lease 已过期。",
    );
  return actor;
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* preserve original error */
    }
    throw error;
  }
}

function insertIdentity(
  database: DatabaseSync,
  workspaceId: string,
  registryName: string,
  preimage: unknown,
  derivedValue: string,
  createdAt: string,
): void {
  const bytes = Buffer.from(canonicalJsonV1(preimage), "utf8");
  const preimageHash = sha256Hex(bytes);
  const canonicalBytesHash = sha256Hex(bytes);
  const existing = database
    .prepare(
      `SELECT preimage_schema_version, canonical_bytes_hash, preimage_bytes, derived_value
    FROM identity_hash_registry WHERE workspace_id=? AND registry_name=? AND registry_version=1 AND preimage_hash=?`,
    )
    .get(workspaceId, registryName, preimageHash) as Row | undefined;
  if (existing) {
    const existingBytes = Buffer.from(existing.preimage_bytes as Uint8Array);
    if (
      Number(existing.preimage_schema_version) !== 1 ||
      String(existing.canonical_bytes_hash) !== canonicalBytesHash ||
      !existingBytes.equals(bytes) ||
      String(existing.derived_value) !== derivedValue
    ) {
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        `identity registry ${registryName} 已绑定不同派生值。`,
      );
    }
    return;
  }
  try {
    database
      .prepare(
        `INSERT INTO identity_hash_registry (
      workspace_id, registry_name, registry_version, preimage_schema_version, preimage_hash,
      canonical_bytes_hash, preimage_bytes, derived_value, created_at
    ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        registryName,
        preimageHash,
        canonicalBytesHash,
        bytes,
        derivedValue,
        createdAt,
      );
  } catch (error) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `identity registry ${registryName} 派生值冲突。`,
      { cause: String(error) },
    );
  }
}

function touchActor(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  pair: { utc: string; mono: number },
): WorkspaceOrchestratorActor {
  const update = database
    .prepare(
      `UPDATE workspace_orchestrator_actors SET checkpoint_revision=checkpoint_revision+1,
    last_business_progress_at=?, updated_at=? WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=?
    AND authority_revision=? AND lease_token=?`,
    )
    .run(
      pair.utc,
      pair.utc,
      actor.workspaceId,
      actor.runtimeEpoch,
      actor.ownerEpoch,
      actor.authorityRevision,
      actor.leaseToken,
    );
  if (affectedRows(update) !== 1)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor checkpoint CAS 失败。",
    );
  const next = readWorkspaceOrchestratorActor(database, actor.workspaceId);
  if (!next)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "Actor checkpoint 提交后无法读回。",
    );
  const gate = database
    .prepare(
      "SELECT runtime_epoch,owner_epoch,lease_token FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?",
    )
    .get(next.workspaceId, next.runtimeEpoch) as Row | undefined;
  if (gate) {
    const synced = database
      .prepare(
        `UPDATE daily_reconcile_gates SET checkpoint_revision=?
      WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=? AND lease_token=?`,
      )
      .run(
        next.checkpointRevision,
        next.workspaceId,
        next.runtimeEpoch,
        next.ownerEpoch,
        next.leaseToken,
      );
    if (affectedRows(synced) !== 1)
      throw new WorkspaceOrchestratorActorError(
        "EXECUTION_AUTHORIZATION_INVALID",
        "reconcile gate projection CAS 失败。",
      );
  }
  return next;
}

function appendEvent(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  input: {
    eventType: string;
    causationId: string;
    payload: unknown;
    occurredAtUtc: string;
    businessDate?: string | null;
    source?: string | null;
    intentId?: string | null;
    invocationId?: string | null;
    requestId?: string | null;
    rootRequestId?: string | null;
    rootGeneration?: number | null;
    orchestrationId?: string | null;
    managerTaskId?: string | null;
    stageRequestId?: string | null;
    operationRequestId?: string | null;
    parentTaskId?: string | null;
    jobId?: string | null;
    snapshotHash?: string | null;
    scopeHash?: string | null;
    projectionHash?: string | null;
    acceptance?: AcceptanceTuple;
    aggregateId?: string;
  },
): {
  eventSequence: number;
  eventId: string;
  outboxId: string;
  replayed?: boolean;
} {
  const aggregateId =
    input.aggregateId ??
    input.rootRequestId ??
    input.stageRequestId ??
    actor.workspaceId;
  const aggregateRevision = actor.checkpointRevision;
  const existing = database
    .prepare(
      `SELECT * FROM orchestrator_events
    WHERE workspace_id=? AND causation_id=? AND event_type=? ORDER BY event_sequence LIMIT 1`,
    )
    .get(actor.workspaceId, input.causationId, input.eventType) as
    Row | undefined;
  if (existing) {
    const outbox = database
      .prepare(
        "SELECT * FROM orchestrator_outbox WHERE workspace_id=? AND event_sequence=?",
      )
      .get(actor.workspaceId, numberOr(existing.event_sequence, 0)) as
      Row | undefined;
    if (!outbox)
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "canonical causation event 缺少对应 outbox。",
      );
    return {
      eventSequence: numberOr(existing.event_sequence, 0),
      eventId: String(existing.event_id),
      outboxId: String(outbox.outbox_id),
      replayed: true,
    };
  }
  const parentRows: Array<Readonly<{ row?: Row | null; label: string }>> = [];
  if (input.rootRequestId)
    parentRows.push({
      row: database
        .prepare(
          "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
        )
        .get(actor.workspaceId, input.rootRequestId) as Row | undefined,
      label: "event root",
    });
  if (input.stageRequestId)
    parentRows.push({
      row: database
        .prepare(
          "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
        )
        .get(actor.workspaceId, input.stageRequestId) as Row | undefined,
      label: "event stage",
    });
  const acceptance = input.acceptance ?? resolveAcceptance({}, parentRows);
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(event_ordinal),0) AS value
    FROM orchestrator_outbox WHERE workspace_id=? AND aggregate_id=? AND aggregate_revision=?`,
    )
    .get(actor.workspaceId, aggregateId, aggregateRevision) as Row;
  const eventOrdinal = numberOr(row.value, 0) + 1;
  const eventRow = database
    .prepare(
      "SELECT COALESCE(MAX(event_sequence),0) AS value FROM orchestrator_events WHERE workspace_id=?",
    )
    .get(actor.workspaceId) as Row;
  const eventSequence = numberOr(eventRow.value, 0) + 1;
  const eventId = hashV1({
    r: "event/v1",
    workspaceId: actor.workspaceId,
    eventSequence,
    eventType: input.eventType,
    eventOrdinal,
    causationId: input.causationId,
  });
  const payloadJson = canonicalJsonV1(input.payload);
  database
    .prepare(
      `INSERT INTO orchestrator_events (
    workspace_id,event_sequence,event_id,event_type,event_ordinal,business_date,source,
    intent_id,invocation_id,root_request_id,root_generation,orchestration_id,manager_task_id,
    stage_request_id,request_id,operation_request_id,parent_task_id,job_id,causation_id,
    actor_epoch,owner_epoch,lease_token_fingerprint,claim_revision,checkpoint_revision,
    snapshot_hash,scope_hash,projection_hash,acceptance_run_id,baseline_event_sequence,
    baseline_checkpoint_revision,created_after_event_sequence,created_after_checkpoint_revision,
    created_after_mono,payload_json,occurred_at_utc
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )`,
    )
    .run(
      actor.workspaceId,
      eventSequence,
      eventId,
      input.eventType,
      eventOrdinal,
      input.businessDate ?? null,
      input.source ?? null,
      input.intentId ?? null,
      input.invocationId ?? null,
      input.rootRequestId ?? null,
      input.rootGeneration ?? null,
      input.orchestrationId ?? null,
      input.managerTaskId ?? null,
      input.stageRequestId ?? null,
      input.requestId ?? null,
      input.operationRequestId ?? null,
      input.parentTaskId ?? null,
      input.jobId ?? null,
      input.causationId,
      actor.runtimeEpoch,
      actor.ownerEpoch,
      sha256Hex(actor.leaseToken ?? ""),
      null,
      actor.checkpointRevision,
      input.snapshotHash ?? null,
      input.scopeHash ?? null,
      input.projectionHash ?? null,
      acceptance[0],
      acceptance[1],
      acceptance[2],
      acceptance[3],
      acceptance[4],
      acceptance[5],
      payloadJson,
      input.occurredAtUtc,
    );

  const payloadBytes = Buffer.from(payloadJson, "utf8");
  const outboxId = hashV1({
    r: "outbox/v1",
    workspaceId: actor.workspaceId,
    eventSequence,
    aggregateId,
    aggregateRevision,
    eventType: input.eventType,
    eventOrdinal,
    causationId: input.causationId,
  });
  database
    .prepare(
      `INSERT INTO orchestrator_outbox (
    outbox_id,workspace_id,event_sequence,aggregate_id,aggregate_revision,event_type,event_ordinal,
    causation_id,payload_hash,payload_bytes,status,attempt,acceptance_run_id,baseline_event_sequence,
    baseline_checkpoint_revision,created_after_event_sequence,created_after_checkpoint_revision,
    created_after_mono,created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      outboxId,
      actor.workspaceId,
      eventSequence,
      aggregateId,
      aggregateRevision,
      input.eventType,
      eventOrdinal,
      input.causationId,
      sha256Hex(payloadBytes),
      payloadBytes,
      acceptance[0],
      acceptance[1],
      acceptance[2],
      acceptance[3],
      acceptance[4],
      acceptance[5],
      input.occurredAtUtc,
    );
  return { eventSequence, eventId, outboxId };
}

const ACCEPTANCE_FIELDS = Object.freeze([
  "acceptanceRunId",
  "baselineEventSequence",
  "baselineCheckpointRevision",
  "createdAfterEventSequence",
  "createdAfterCheckpointRevision",
  "createdAfterMono",
] as const);

function emptyAcceptance(): AcceptanceTuple {
  return [null, null, null, null, null, null];
}

function acceptanceObject(values: AcceptanceTuple): AcceptanceProvenanceInput {
  return Object.freeze({
    acceptanceRunId: values[0],
    baselineEventSequence: values[1],
    baselineCheckpointRevision: values[2],
    createdAfterEventSequence: values[3],
    createdAfterCheckpointRevision: values[4],
    createdAfterMono: values[5],
  });
}

function hasAcceptance(values: AcceptanceTuple): boolean {
  return values[0] !== null;
}

function sameAcceptance(
  left: AcceptanceTuple,
  right: AcceptanceTuple,
): boolean {
  return left.every((value, index) => value === right[index]);
}

function parseAcceptanceRecord(
  input: JsonRecord,
  label: string,
): AcceptanceTuple | null {
  const values = ACCEPTANCE_FIELDS.map((field) => input[field]);
  const present = values.some((value) => value !== undefined && value !== null);
  if (!present) return null;
  if (values.some((value) => value === undefined || value === null)) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${label} 字段必须完整成套。`,
    );
  }
  return [
    normalizedString(values[0], `${label}.acceptanceRunId`),
    acceptanceNumber(values[1], `${label}.baselineEventSequence`),
    acceptanceNumber(values[2], `${label}.baselineCheckpointRevision`),
    acceptanceNumber(values[3], `${label}.createdAfterEventSequence`),
    acceptanceNumber(values[4], `${label}.createdAfterCheckpointRevision`),
    acceptanceNumber(values[5], `${label}.createdAfterMono`),
  ];
}

function parseAcceptance(input: JsonRecord): AcceptanceTuple {
  const topLevel = parseAcceptanceRecord(input, "acceptance");
  let nested: AcceptanceTuple | null = null;
  const rawNested = input.acceptance;
  if (rawNested !== undefined && rawNested !== null) {
    if (typeof rawNested !== "object" || Array.isArray(rawNested))
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "acceptance 必须是对象。",
      );
    nested = parseAcceptanceRecord(rawNested as JsonRecord, "acceptance");
  }
  if (topLevel && nested && !sameAcceptance(topLevel, nested))
    throw new WorkspaceOrchestratorActorError(
      "ACCEPTANCE_PROVENANCE_CONFLICT",
      "顶层 acceptance 与 acceptance 对象不一致。",
    );
  return topLevel ?? nested ?? emptyAcceptance();
}

function acceptanceFromRow(row: Row, label: string): AcceptanceTuple {
  return (
    parseAcceptanceRecord(
      {
        acceptanceRunId: row.acceptance_run_id,
        baselineEventSequence: row.baseline_event_sequence,
        baselineCheckpointRevision: row.baseline_checkpoint_revision,
        createdAfterEventSequence: row.created_after_event_sequence,
        createdAfterCheckpointRevision: row.created_after_checkpoint_revision,
        createdAfterMono: row.created_after_mono,
      },
      label,
    ) ?? emptyAcceptance()
  );
}

function resolveAcceptance(
  input: JsonRecord,
  parents: readonly Readonly<{ row?: Row | null; label: string }>[],
): AcceptanceTuple {
  const supplied = parseAcceptance(input);
  let parentSeen = false;
  let durable: AcceptanceTuple | null = null;
  for (const parent of parents) {
    if (!parent.row) continue;
    parentSeen = true;
    const candidate = acceptanceFromRow(parent.row, parent.label);
    if (!hasAcceptance(candidate)) continue;
    if (durable && !sameAcceptance(durable, candidate))
      throw new WorkspaceOrchestratorActorError(
        "ACCEPTANCE_PROVENANCE_CONFLICT",
        `${parent.label} durable acceptance provenance 不一致。`,
      );
    durable = candidate;
  }
  if (durable) {
    if (hasAcceptance(supplied) && !sameAcceptance(supplied, durable))
      throw new WorkspaceOrchestratorActorError(
        "ACCEPTANCE_PROVENANCE_CONFLICT",
        "调用方 acceptance 与 durable parent provenance 不一致。",
      );
    return durable;
  }
  if (parentSeen && hasAcceptance(supplied))
    throw new WorkspaceOrchestratorActorError(
      "ACCEPTANCE_PROVENANCE_CONFLICT",
      "durable parent 无 acceptance provenance，不接受调用方覆盖。",
    );
  return supplied;
}

function rowRoot(
  database: DatabaseSync,
  workspaceId: string,
  rootRequestId: string,
): Row {
  const row = database
    .prepare(
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    )
    .get(workspaceId, rootRequestId) as Row | undefined;
  if (!row)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "root predecessor 不存在。",
      { rootRequestId },
    );
  return row;
}

function rowStage(
  database: DatabaseSync,
  workspaceId: string,
  stageRequestId: string,
): Row {
  const row = database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(workspaceId, stageRequestId) as Row | undefined;
  if (!row)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "stage claim predecessor 不存在。",
      { stageRequestId },
    );
  return row;
}

function requireRootStage(
  database: DatabaseSync,
  input: JsonRecord,
  actor: WorkspaceOrchestratorActor,
  stageRequestId: string,
  rootRequestId: string,
): { root: Row; stage: Row } {
  const root = rowRoot(database, actor.workspaceId, rootRequestId);
  if (
    String(root.root_input_hash) !== String(input.rootInputHash) ||
    numberOr(root.root_generation, -1) !== numberOr(input.rootGeneration, -2)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "root identity 与当前持久 root 不一致。",
      { rootRequestId },
    );
  }
  if (
    numberOr(root.owner_epoch, -1) !== actor.ownerEpoch ||
    String(root.lease_token) !== String(actor.leaseToken)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "root fence 与 Actor 不一致。",
      { rootRequestId },
    );
  }
  if (
    ["succeeded", "partial", "failed", "needs_user", "cancelled"].includes(
      String(root.status),
    )
  ) {
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "root 已经 terminal。",
      { rootRequestId, status: root.status },
    );
  }
  const stage = rowStage(database, actor.workspaceId, stageRequestId);
  if (
    String(stage.root_request_id) !== rootRequestId ||
    numberOr(stage.root_generation, -1) !==
      numberOr(input.rootGeneration, -2) ||
    String(stage.root_input_hash) !== String(input.rootInputHash)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "stage identity 与 root predecessor 不一致。",
      { stageRequestId },
    );
  }
  if (
    numberOr(stage.owner_epoch, -1) !== actor.ownerEpoch ||
    String(stage.lease_token) !== String(actor.leaseToken)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "stage fence 与 Actor 不一致。",
      { stageRequestId },
    );
  }
  const expectedRevision = input.expectedClaimRevision ?? input.claimRevision;
  if (
    expectedRevision !== undefined &&
    numberOr(stage.claim_revision, -1) !== numberOr(expectedRevision, -2)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "parent stage claim revision 已变化。",
      {
        stageRequestId,
        expectedClaimRevision: expectedRevision,
        currentClaimRevision: stage.claim_revision,
      },
    );
  }
  return { root, stage };
}

function readIntent(database: DatabaseSync, root: Row): Row | null {
  if (root.intent_id === null || root.intent_id === undefined) return null;
  return (
    (database
      .prepare(
        "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
      )
      .get(String(root.workspace_id), String(root.intent_id)) as
      Row | undefined) ?? null
  );
}

function preflightSnapshot(database: DatabaseSync, input: JsonRecord): Row {
  const row = database
    .prepare(
      "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
    )
    .get(String(input.workspaceId), String(input.preflightId)) as
    Row | undefined;
  if (!row || String(row.status) !== "frozen")
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "preflight predecessor 不存在或未 frozen。",
      { preflightId: input.preflightId },
    );
  if (
    String(row.policy_hash) !== String(input.policyHash) ||
    numberOr(row.profile_revision, -1) !== numberOr(input.profileRevision, -2)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "preflight policy/profile fence 已变化。",
      { preflightId: input.preflightId },
    );
  }
  return row;
}

function normalizePartitionEntry(
  raw: unknown,
  field: string,
): SourceChannelPartition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} entry 必须是对象。`,
    );
  const record = raw as JsonRecord;
  const channelId = normalizedString(
    record.channelId ?? record.channel_id ?? record.id,
    `${field}.channelId`,
  );
  return Object.freeze({ ...record, channelId });
}

function normalizeSourceBinding(raw: unknown): SourceBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "source binding 必须是对象。",
    );
  const record = raw as JsonRecord;
  const sourceId = normalizedString(
    record.sourceId ?? record.source_id ?? record.id,
    "sourceId",
  );
  const sourceRevision = finiteNumber(
    record.sourceRevision ?? record.source_revision ?? record.revision,
    "sourceRevision",
    1,
  );
  const sourceContentHash = normalizedString(
    record.sourceContentHash ??
      record.source_content_hash ??
      record.contentHash ??
      record.content_hash,
    "sourceContentHash",
  );
  return Object.freeze({
    ...record,
    sourceId,
    sourceRevision,
    sourceContentHash,
  });
}

function normalizeReceiptBinding(
  raw: unknown,
  fallbackId?: string,
): SourceReceiptBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "receipt binding 必须是对象。",
    );
  const record = raw as JsonRecord;
  const receiptId = normalizedString(
    record.receiptId ?? record.receipt_id ?? fallbackId,
    "receiptId",
  );
  const receiptRevision = finiteNumber(
    record.receiptRevision ?? record.receipt_revision ?? record.revision,
    "receiptRevision",
    1,
  );
  const receiptPayloadHash = normalizedString(
    record.receiptPayloadHash ??
      record.receipt_payload_hash ??
      record.payloadHash ??
      record.payload_hash,
    "receiptPayloadHash",
  );
  return Object.freeze({
    ...record,
    receiptId,
    receiptRevision,
    receiptPayloadHash,
  });
}

function normalizeSourceChannels(input: JsonRecord): {
  selected: string[];
  successful: SourceChannelPartition[];
  failed: SourceChannelPartition[];
  unresolved: SourceChannelPartition[];
} {
  const partition =
    input.selectedChannelPartition &&
    typeof input.selectedChannelPartition === "object"
      ? (input.selectedChannelPartition as JsonRecord)
      : {};
  const selected = uniqueStrings(
    input.selectedChannelIds ?? partition.selectedChannelIds ?? [],
    "selectedChannelIds",
  );
  if (!selected.length)
    throw new WorkspaceOrchestratorActorError(
      "NO_CHANNEL_SELECTED",
      "source snapshot 没有显式 selected channel。",
    );
  const successful = jsonArray(
    input.successfulChannels ?? partition.successfulChannels,
  ).map((entry: unknown) =>
    normalizePartitionEntry(entry, "successfulChannels"),
  );
  const failed = jsonArray(
    input.failedChannels ?? partition.failedChannels,
  ).map((entry: unknown) => normalizePartitionEntry(entry, "failedChannels"));
  const unresolved = jsonArray(
    input.unresolvedChannels ?? partition.unresolvedChannels,
  ).map((entry: unknown) =>
    normalizePartitionEntry(entry, "unresolvedChannels"),
  );
  const categories = [successful, failed, unresolved];
  const owner = new Map<string, string>();
  for (const [index, category] of categories.entries()) {
    for (const entry of category) {
      const prior = owner.get(entry.channelId);
      if (prior)
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_PARTITION_MISMATCH",
          `channel ${entry.channelId} 同时属于 ${prior} 与 ${["successful", "failed", "unresolved"][index]}。`,
        );
      owner.set(entry.channelId, ["successful", "failed", "unresolved"][index]);
    }
  }
  const selectedSet = new Set(selected);
  for (const channelId of owner.keys())
    if (!selectedSet.has(channelId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_PARTITION_MISMATCH",
        `partition 包含未选择 channel: ${channelId}`,
      );
  for (const channelId of selected)
    if (!owner.has(channelId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_PARTITION_MISMATCH",
        `selected channel 没有 provenance partition: ${channelId}`,
      );
  const sort = (left: SourceChannelPartition, right: SourceChannelPartition) =>
    compareCodePoints(left.channelId, right.channelId);
  return {
    selected,
    successful: successful.sort(sort),
    failed: failed.sort(sort),
    unresolved: unresolved.sort(sort),
  };
}

function fenceValue(row: JsonRecord, aliases: readonly string[]): unknown {
  for (const alias of aliases) if (row[alias] !== undefined) return row[alias];
  return undefined;
}

function fenceStatus(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function fenceReady(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    [
      "ready",
      "ok",
      "success",
      "succeeded",
      "valid",
      "healthy",
      "passed",
      "active",
      "authenticated",
      "authorized",
      "logged_in",
      "available",
      "configured",
    ].includes(fenceStatus(value))
  );
}

function fenceRejected(value: unknown): boolean {
  return (
    value === false ||
    value === 0 ||
    [
      "false",
      "revoked",
      "revoke",
      "lease_revoked",
      "expired",
      "lease_expired",
      "auth_expired",
      "auth_revoked",
      "config_expired",
      "config_revoked",
      "invalid",
      "disabled",
      "failed",
      "error",
      "not_ready",
      "unavailable",
      "stale",
      "config_changed",
      "auth_changed",
    ].includes(fenceStatus(value))
  );
}
function fenceRevoked(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    [
      "true",
      "revoked",
      "revoke",
      "lease_revoked",
      "auth_revoked",
      "config_revoked",
    ].includes(fenceStatus(value))
  );
}

function fenceNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      `${field} current fence 非法。`,
    );
  return Math.trunc(number);
}

function fenceChannelId(row: JsonRecord, fallback?: string): string {
  const value = fenceValue(row, ["channelId", "channel_id", "id"]) ?? fallback;
  const channelId = String(value ?? "")
    .trim()
    .normalize("NFC");
  if (!channelId)
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "current channel fence 缺少 channelId。",
    );
  return channelId;
}

export function validateCurrentChannelFences(
  input: Readonly<{
    profileRevision: number;
    policyHash: string;
    selectedChannelIds: readonly string[];
    frozenChannels: readonly JsonRecord[];
    claimedChannels?: readonly JsonRecord[];
    currentChannelFences?:
      readonly JsonRecord[] | Readonly<Record<string, JsonRecord>>;
    nowMono: number;
  }>,
): readonly JsonRecord[] {
  const rawFences = input.currentChannelFences;
  if (
    !rawFences ||
    (Array.isArray(rawFences) && rawFences.length === 0) ||
    (!Array.isArray(rawFences) && Object.keys(rawFences).length === 0)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "缺少 currentChannelFences runtime authority readback。",
    );
  }
  const byChannel = new Map<string, JsonRecord>();
  const entries = Array.isArray(rawFences)
    ? rawFences.map((raw) => ({ raw, fallback: undefined }))
    : Object.entries(rawFences).map(([fallback, raw]) => ({ raw, fallback }));
  for (const { raw, fallback } of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        "current channel fence entry 必须是对象。",
      );
    const row = { ...(raw as JsonRecord) };
    const channelId = fenceChannelId(row, fallback);
    if (byChannel.has(channelId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `current channel fence 重复: ${channelId}`,
      );
    row.channelId = channelId;
    byChannel.set(channelId, row);
  }

  const expectedProfileRevision = fenceNumber(
    input.profileRevision,
    "profileRevision",
  );
  const expectedPolicyHash = String(input.policyHash ?? "").trim();
  if (!expectedPolicyHash)
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "frozen policyHash 为空。",
    );
  const requiredFields = [
    ["configRevision", ["configRevision", "config_revision"]],
    ["authRevision", ["authRevision", "auth_revision"]],
    ["capabilityRevision", ["capabilityRevision", "capability_revision"]],
    ["capabilityLeaseId", ["capabilityLeaseId", "capability_lease_id"]],
    ["expiresAtMono", ["expiresAtMono", "expires_at_mono"]],
  ] as const;
  const selected = new Set<string>();
  for (const rawChannelId of input.selectedChannelIds) {
    const channelId = String(rawChannelId).trim().normalize("NFC");
    if (!channelId || selected.has(channelId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        "selected channel fence 集合非法。",
      );
    selected.add(channelId);
    const current = byChannel.get(channelId);
    if (!current)
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} 缺少 current channel fence。`,
      );
    const profileRevision = fenceValue(current, [
      "profileRevision",
      "profile_revision",
    ]);
    const policyHash = fenceValue(current, ["policyHash", "policy_hash"]);
    if (
      profileRevision === undefined ||
      fenceNumber(profileRevision, `${channelId}.profileRevision`) !==
        expectedProfileRevision
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} profileRevision fence drift。`,
      );
    if (
      policyHash === undefined ||
      String(policyHash).trim() !== expectedPolicyHash
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} policyHash fence drift。`,
      );
    const status = fenceValue(current, ["status", "state"]);
    const ready = fenceValue(current, ["ready", "isReady", "is_ready"]);
    if (status === undefined && ready === undefined)
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} current channel readiness 缺失。`,
      );
    if (
      fenceRejected(status) ||
      fenceRejected(ready) ||
      (status !== undefined &&
        !fenceReady(status) &&
        ready !== true &&
        ready !== 1)
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} current channel status 非 ready。`,
      );
    const revoked = fenceValue(current, ["revoked", "isRevoked", "is_revoked"]);
    if (fenceRevoked(revoked))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} capability 已 revoked。`,
      );
    for (const [label, aliases] of [
      ["authStatus", ["authStatus", "auth_status", "authState", "auth_state"]],
      [
        "configStatus",
        ["configStatus", "config_status", "configState", "config_state"],
      ],
    ] as const) {
      const nested = fenceValue(current, [
        label === "authStatus" ? "auth" : "config",
      ]);
      const value =
        fenceValue(current, aliases) ??
        (nested && typeof nested === "object" && !Array.isArray(nested)
          ? fenceValue(nested as JsonRecord, ["status", "state", "ready", "ok"])
          : undefined);
      if (value === undefined || fenceRejected(value) || !fenceReady(value))
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} ${label} 非 ready。`,
        );
    }
    const capability = fenceValue(current, ["capability"]);
    if (
      capability &&
      typeof capability === "object" &&
      !Array.isArray(capability)
    ) {
      const capabilityRecord = capability as JsonRecord;
      if (
        fenceRejected(capabilityRecord.ok) ||
        fenceRejected(capabilityRecord.status) ||
        (capabilityRecord.status !== undefined &&
          !fenceReady(capabilityRecord.status))
      )
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} capability status 非 ready。`,
        );
    }
    for (const [label, aliases] of requiredFields) {
      const value = fenceValue(current, aliases);
      if (
        value === undefined ||
        value === null ||
        (label === "capabilityLeaseId"
          ? !String(value).trim()
          : !Number.isFinite(Number(value)))
      )
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} ${label} current fence 缺失。`,
        );
      if (
        label === "expiresAtMono" &&
        fenceNumber(value, `${channelId}.expiresAtMono`) <= input.nowMono
      )
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} capability lease 已过期。`,
        );
    }
  }

  const frozenByChannel = new Map<string, JsonRecord>();
  for (const raw of input.frozenChannels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        "frozen channel fence entry 必须是对象。",
      );
    const row = raw as JsonRecord;
    const channelId = fenceChannelId(row);
    if (!selected.has(channelId) || frozenByChannel.has(channelId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `frozen channel fence identity 非法: ${channelId}`,
      );
    frozenByChannel.set(channelId, row);
    const baselineProfile = fenceValue(row, [
      "profileRevision",
      "profile_revision",
    ]);
    const baselinePolicy = fenceValue(row, ["policyHash", "policy_hash"]);
    if (
      baselineProfile !== undefined &&
      fenceNumber(baselineProfile, `${channelId}.profileRevision`) !==
        expectedProfileRevision
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} frozen profileRevision drift。`,
      );
    if (
      baselinePolicy !== undefined &&
      String(baselinePolicy).trim() !== expectedPolicyHash
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} frozen policyHash drift。`,
      );
    const current = byChannel.get(channelId)!;
    for (const [label, aliases] of requiredFields) {
      const baseline = fenceValue(row, aliases);
      const live = fenceValue(current, aliases);
      if (
        baseline === undefined ||
        baseline === null ||
        (label === "capabilityLeaseId"
          ? !String(baseline).trim()
          : !Number.isFinite(Number(baseline)))
      )
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} frozen ${label} 缺失。`,
        );
      if (String(baseline) !== String(live))
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} ${label} fence drift。`,
        );
    }
    const baselineStatus = fenceValue(row, ["status", "state"]);
    if (
      baselineStatus !== undefined &&
      (fenceRejected(baselineStatus) || !fenceReady(baselineStatus))
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${channelId} frozen channel status 非 ready。`,
      );
  }
  for (const row of input.claimedChannels ?? []) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        "claimed channel fence entry 必须是对象。",
      );
    const channelId = fenceChannelId(row);
    const current = byChannel.get(channelId);
    if (!current || !selected.has(channelId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `claimed channel fence identity 非法: ${channelId}`,
      );
    for (const [label, aliases] of requiredFields) {
      const claimed = fenceValue(row, aliases);
      const live = fenceValue(current, aliases);
      if (
        claimed === undefined ||
        claimed === null ||
        String(claimed) !== String(live)
      )
        throw new WorkspaceOrchestratorActorError(
          "SOURCE_SNAPSHOT_STALE",
          `${channelId} claimed ${label} fence drift。`,
        );
    }
  }
  return [...frozenByChannel.entries()].map(([channelId, row]) => {
    const current = byChannel.get(channelId)!;
    const result: JsonRecord = {
      ...row,
      channelId,
      profileRevision: expectedProfileRevision,
      policyHash: expectedPolicyHash,
      configRevision: fenceNumber(
        fenceValue(current, ["configRevision", "config_revision"]),
        `${channelId}.configRevision`,
      ),
      authRevision: fenceNumber(
        fenceValue(current, ["authRevision", "auth_revision"]),
        `${channelId}.authRevision`,
      ),
      capabilityRevision: fenceNumber(
        fenceValue(current, ["capabilityRevision", "capability_revision"]),
        `${channelId}.capabilityRevision`,
      ),
      capabilityLeaseId: String(
        fenceValue(current, ["capabilityLeaseId", "capability_lease_id"]),
      ),
      expiresAtMono: fenceNumber(
        fenceValue(current, ["expiresAtMono", "expires_at_mono"]),
        `${channelId}.expiresAtMono`,
      ),
    };
    for (const [canonical, aliases] of [
      ["status", ["status", "state"]],
      ["ready", ["ready", "isReady", "is_ready"]],
      ["revoked", ["revoked", "isRevoked", "is_revoked"]],
      ["authStatus", ["authStatus", "auth_status"]],
      ["configStatus", ["configStatus", "config_status"]],
    ] as const) {
      const value = fenceValue(current, aliases);
      if (value !== undefined) result[canonical] = value;
    }
    return Object.freeze(result);
  });
}

function preflightChannelFences(
  database: DatabaseSync,
  input: JsonRecord &
    Readonly<{
      currentChannelFences?:
        readonly JsonRecord[] | Readonly<Record<string, JsonRecord>>;
    }>,
  partition: Readonly<{
    selected: readonly string[];
    successful: SourceChannelPartition[];
  }>,
  preflight: Row,
  nowMono: number,
): SourceChannelPartition[] {
  const preflightSelected = jsonArray(preflight.selected_channels_json)
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : String(
            (entry as JsonRecord).channelId ??
              (entry as JsonRecord).channel_id ??
              "",
          ),
    )
    .filter(Boolean)
    .sort(compareCodePoints);
  if (
    canonicalJsonV1(preflightSelected) !== canonicalJsonV1(partition.selected)
  )
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "selected channels 与 frozen preflight 不一致。",
    );
  const preflightResults = new Map(
    jsonArray(preflight.results_json).map((entry) => {
      const row = entry as JsonRecord;
      return [String(row.channelId ?? row.channel_id ?? ""), row] as const;
    }),
  );
  const frozenSuccessful = partition.successful.map((entry) => {
    const frozen = preflightResults.get(entry.channelId);
    if (!frozen)
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `${entry.channelId} frozen preflight fence 缺失。`,
      );
    return frozen;
  });
  const validated = validateCurrentChannelFences({
    profileRevision: numberOr(preflight.profile_revision, -1),
    policyHash: String(preflight.policy_hash ?? ""),
    selectedChannelIds: partition.selected,
    frozenChannels: frozenSuccessful,
    claimedChannels: partition.successful,
    currentChannelFences: input.currentChannelFences,
    nowMono,
  });
  const byChannel = new Map(
    validated.map((entry) => [String(entry.channelId), entry]),
  );
  void database;
  return partition.successful.map((entry) =>
    Object.freeze({ ...entry, ...(byChannel.get(entry.channelId) ?? {}) }),
  );
}

function sourceReadback(row: Row): SourceSnapshotReadback {
  const acceptance = acceptanceFromRow(row, "source snapshot");
  return Object.freeze({
    ...acceptanceObject(acceptance),
    acceptance: acceptanceObject(acceptance),
    snapshotId: String(row.snapshot_id),
    snapshotHash: String(row.snapshot_hash),
    workspaceId: String(row.workspace_id),
    status: String(row.status) as SourceSnapshotReadback["status"],
    businessDate: String(row.business_date),
    sourceTaskId:
      row.source_task_id === null ? null : String(row.source_task_id),
    rootRequestId: String(row.root_request_id),
    rootGeneration: numberOr(row.root_generation, 0),
    stageRequestId: String(row.stage_request_id),
    scanAttemptId: String(row.scan_attempt_id),
    preflightId: String(row.preflight_id),
    policyHash: String(row.policy_hash),
    profileRevision: numberOr(row.profile_revision, 0),
    selectedChannelIds: jsonArray(row.selected_channel_ids_json),
    successfulChannels: jsonArray(row.successful_channels_json),
    failedChannels: jsonArray(row.failed_channels_json),
    unresolvedChannels: jsonArray(row.unresolved_channels_json),
    sourceIds: jsonArray(row.source_ids_json),
    sourceBindings: jsonArray(row.source_bindings_json),
    receiptIds: jsonArray(row.receipt_ids_json),
    receiptBindings: jsonObject(row.receipt_bindings_json),
    watermarkUtc: String(row.watermark_utc),
    watermarkMono: numberOr(row.watermark_mono, 0),
    capturedAtUtc: String(row.captured_at_utc),
    excludedByBudgetCount: numberOr(row.excluded_by_budget_count, 0),
  });
}

function scopeReadback(row: Row): PlanScopeProjectionReadback {
  const stored = jsonObject(row.scope_json);
  const projection = jsonObject(stored.projection ?? row.result_json);
  const progress = jsonObject(stored.progress ?? projection.progress ?? {});
  const acceptance = acceptanceFromRow(row, "plan scope");
  return Object.freeze({
    ...(stored.scope as JsonRecord),
    ...progress,
    ...acceptanceObject(acceptance),
    acceptance: acceptanceObject(acceptance),
    scopeId: String(row.scope_id),
    scopeHash: String(row.scope_hash),
    projectionHash: String(projection.projectionHash ?? ""),
    scopeStatus: String(row.scope_status),
    projection,
  });
}

function stageDReadback(row: Row): StageDTargetEffectReadback {
  const snapshot = jsonObject(row.snapshot_json);
  const stageD = jsonObject(snapshot.stageD ?? snapshot.stage_d ?? snapshot);
  const acceptance = acceptanceFromRow(row, "stage D");
  return Object.freeze({
    ...stageD,
    ...acceptanceObject(acceptance),
    acceptance: acceptanceObject(acceptance),
    stageRequestId: String(row.stage_request_id),
    targetSetHash: String(stageD.targetSetHash ?? ""),
    effectSetHash: String(stageD.effectSetHash ?? ""),
  });
}

function effectReadback(row: Row): EffectConsumptionReadback {
  const acceptance = acceptanceFromRow(row, "effect consumption");
  return Object.freeze({
    ...acceptanceObject(acceptance),
    acceptance: acceptanceObject(acceptance),
    consumptionId: String(row.consumption_id),
    workspaceId: String(row.workspace_id),
    operationRequestId: String(row.operation_request_id),
    effectRequestId: String(row.effect_request_id),
    effectLogicalKey: String(row.effect_logical_key),
    effectSetHash: String(row.effect_set_hash),
    effectToken: String(row.effect_token),
    payloadHash: String(row.payload_hash),
    managerTaskId: String(row.manager_task_id),
    orchestrationId: String(row.orchestration_id),
    rootRequestId: String(row.root_request_id),
    rootGeneration: numberOr(row.root_generation, 0),
    stageRequestId: String(row.stage_request_id),
    sourceDispatchJobId: String(row.source_dispatch_job_id),
    sourceResultHash: String(row.source_result_hash),
    roleId: String(row.role_id),
    sinkName: String(row.sink_name),
    sinkRoleId: String(row.sink_role_id),
    sinkContractVersion: String(row.sink_contract_version),
    deliveryMode: String(row.delivery_mode) as EffectConsumptionReadback["deliveryMode"],
    sinkCapabilityProofHash: String(row.sink_capability_proof_hash),
    outcomeQueryKey:
      row.outcome_query_key === null ? null : String(row.outcome_query_key),
    outcomeHash: row.outcome_hash === null ? null : String(row.outcome_hash),
    state: String(row.state),
    consumptionRevision: numberOr(row.consumption_revision, 0),
    expectedStageClaimRevision: numberOr(row.expected_stage_claim_revision, 0),
    ownerEpoch: numberOr(row.owner_epoch, 0),
    leaseToken: String(row.lease_token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    error: row.error_json === null ? null : jsonObject(row.error_json),
  });
}

function normalizeSourceBindings(input: JsonRecord): {
  bindings: SourceBinding[];
  sourceIds: string[];
  excludedByBudgetCount: number;
} {
  const rawBindings = input.sourceBindings ?? input.sources ?? [];
  if (!Array.isArray(rawBindings))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "sourceBindings 必须是数组。",
    );
  const all = rawBindings.map(normalizeSourceBinding);
  const byId = new Map<string, SourceBinding>();
  for (const binding of all) {
    if (byId.has(binding.sourceId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_PARTITION_MISMATCH",
        `sourceId 重复: ${binding.sourceId}`,
      );
    byId.set(binding.sourceId, binding);
  }
  const declaredIds =
    input.sourceIds === undefined
      ? all.map((binding) => binding.sourceId)
      : uniqueStrings(input.sourceIds, "sourceIds");
  for (const sourceId of declaredIds)
    if (!byId.has(sourceId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_PARTITION_MISMATCH",
        `sourceId 缺少 binding: ${sourceId}`,
      );
  const selected = all
    .filter((binding) => declaredIds.includes(binding.sourceId))
    .sort((left, right) => {
      const priorityDifference =
        numberOr(right.priority, 0) - numberOr(left.priority, 0);
      return (
        priorityDifference || compareCodePoints(left.sourceId, right.sourceId)
      );
    });
  const bindings = selected
    .slice(0, 80)
    .map((binding, index) =>
      Object.freeze({ ...binding, provenanceOrdinal: index + 1 }),
    );
  const excludedByBudgetCount = selected.length - bindings.length;
  if (
    input.excludedByBudgetCount !== undefined &&
    finiteNumber(input.excludedByBudgetCount, "excludedByBudgetCount", 0) !==
      excludedByBudgetCount
  )
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "excludedByBudgetCount 与稳定 source cap 计算不一致。",
    );
  return {
    bindings,
    sourceIds: bindings.map((binding) => binding.sourceId),
    excludedByBudgetCount,
  };
}

function normalizeReceiptBindings(
  input: JsonRecord,
  receiptIds: string[],
): { ids: string[]; bindings: SourceReceiptBinding[]; map: JsonRecord } {
  const raw = input.receiptBindings;
  const bindings: SourceReceiptBinding[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) bindings.push(normalizeReceiptBinding(entry));
  } else if (raw && typeof raw === "object") {
    for (const [receiptId, value] of Object.entries(raw))
      bindings.push(normalizeReceiptBinding(value, receiptId));
  }
  const byId = new Map<string, SourceReceiptBinding>();
  for (const binding of bindings) {
    if (byId.has(binding.receiptId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_PARTITION_MISMATCH",
        `receiptId 重复: ${binding.receiptId}`,
      );
    byId.set(binding.receiptId, binding);
  }
  const ids =
    input.receiptIds === undefined
      ? receiptIds.slice().sort(compareCodePoints)
      : uniqueStrings(input.receiptIds, "receiptIds");
  for (const receiptId of ids)
    if (!byId.has(receiptId))
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `receipt binding 缺失: ${receiptId}`,
      );
  const map: JsonRecord = {};
  for (const receiptId of ids) map[receiptId] = byId.get(receiptId)!;
  return { ids, bindings: ids.map((receiptId) => byId.get(receiptId)!), map };
}

function verifyCurrentSources(
  input: JsonRecord,
  bindings: SourceBinding[],
): void {
  if (!input.currentSourceBindings) return;
  const current = (input.currentSourceBindings as unknown[]).map(
    normalizeSourceBinding,
  );
  const byId = new Map(current.map((binding) => [binding.sourceId, binding]));
  for (const binding of bindings) {
    const live = byId.get(binding.sourceId);
    if (
      !live ||
      live.sourceRevision !== binding.sourceRevision ||
      live.sourceContentHash !== binding.sourceContentHash
    )
      throw new WorkspaceOrchestratorActorError(
        "SOURCE_SNAPSHOT_STALE",
        `source ${binding.sourceId} revision/content hash 已变化。`,
      );
  }
}

function rootContext(root: Row): {
  businessDate: string;
  source: string;
  rootMode: string;
  intentId: string | null;
  orchestrationId: string;
  managerTaskId: string;
} {
  return {
    businessDate: String(root.business_date),
    source: String(root.source),
    rootMode: String(root.root_mode),
    intentId: root.intent_id === null ? null : String(root.intent_id),
    orchestrationId: String(root.orchestration_id),
    managerTaskId: String(root.manager_task_id),
  };
}

function ensureIndex(
  database: DatabaseSync,
  root: Row,
  intent: Row | null,
  pairUtc: string,
): Row {
  const workspaceId = String(root.workspace_id);
  const rootRequestId = String(root.root_request_id);
  let row = database
    .prepare(
      "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
    )
    .get(workspaceId, rootRequestId) as Row | undefined;
  if (row) return row;
  const mailbox = intent
    ? (database
        .prepare(
          "SELECT mailbox_sequence, priority FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=? ORDER BY mailbox_sequence ASC LIMIT 1",
        )
        .get(workspaceId, String(intent.intent_id)) as Row | undefined)
    : undefined;
  const mailboxSequence = numberOr(mailbox?.mailbox_sequence, 1);
  const priority = numberOr(mailbox?.priority, 0);
  database
    .prepare(
      `INSERT INTO workspace_active_root_index (
    workspace_id,root_request_id,orchestration_id,manager_task_id,root_generation,source,root_mode,status,
    terminal_reason,is_active,priority,mailbox_sequence,checkpoint_revision,index_revision,stage_request_id,
    projection_state,scope_hash,projection_hash,eligible_ids_hash,next_action,visible_since,updated_at
  ) VALUES (?,?,?,?,?,?,?,? ,NULL,?,?,?,?,?,NULL,'absent',NULL,NULL,NULL,NULL,?,?)`,
    )
    .run(
      workspaceId,
      rootRequestId,
      String(root.orchestration_id),
      String(root.manager_task_id),
      numberOr(root.root_generation, 0),
      String(root.source),
      String(root.root_mode),
      String(root.status),
      1,
      priority,
      mailboxSequence,
      numberOr(root.checkpoint_revision, 0),
      0,
      pairUtc,
      pairUtc,
    );
  row = database
    .prepare(
      "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
    )
    .get(workspaceId, rootRequestId) as Row | undefined;
  if (!row)
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "active-root index 插入后无法读回。",
    );
  return row;
}

function updateIndex(
  database: DatabaseSync,
  root: Row,
  intent: Row | null,
  values: {
    status: string;
    isActive: number;
    stageRequestId?: string | null;
    projectionState: "absent" | "not_applicable" | "frozen";
    scopeHash?: string | null;
    projectionHash?: string | null;
    eligibleIdsHash?: string | null;
    nextAction?: unknown;
    terminalReason?: string | null;
    checkpointRevision: number;
    expectedIndexRevision?: number;
    nowUtc: string;
  },
): Row {
  const current = ensureIndex(database, root, intent, values.nowUtc);
  if (
    values.expectedIndexRevision !== undefined &&
    numberOr(current.index_revision, -1) !==
      numberOr(values.expectedIndexRevision, -2)
  )
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "active-root index revision 已变化。",
    );
  const nextAction =
    values.nextAction === undefined || values.nextAction === null
      ? null
      : canonicalJsonV1(values.nextAction);
  const update = database
    .prepare(
      `UPDATE workspace_active_root_index SET status=?,terminal_reason=?,is_active=?,checkpoint_revision=?,index_revision=index_revision+1,
    stage_request_id=?,projection_state=?,scope_hash=?,projection_hash=?,eligible_ids_hash=?,next_action=?,updated_at=?
    WHERE workspace_id=? AND root_request_id=? AND index_revision=?`,
    )
    .run(
      values.status,
      values.terminalReason ?? null,
      values.isActive,
      values.checkpointRevision,
      values.stageRequestId ?? null,
      values.projectionState,
      values.scopeHash ?? null,
      values.projectionHash ?? null,
      values.eligibleIdsHash ?? null,
      nextAction,
      values.nowUtc,
      String(root.workspace_id),
      String(root.root_request_id),
      numberOr(current.index_revision, 0),
    );
  if (affectedRows(update) !== 1)
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "active-root index CAS 失败。",
    );
  return database
    .prepare(
      "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
    )
    .get(String(root.workspace_id), String(root.root_request_id)) as Row;
}

function updateRootAndIntent(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  root: Row,
  intent: Row | null,
  nextRootStatus: string,
  nextAction: unknown,
  terminalReason: string | null,
  nowUtc: string,
): { root: Row; intent: Row | null } {
  const rootTerminal = [
    "succeeded",
    "partial",
    "failed",
    "needs_user",
    "cancelled",
  ].includes(nextRootStatus);
  const nextRootRevision = numberOr(root.checkpoint_revision, 0) + 1;
  const rootUpdate = database
    .prepare(
      `UPDATE daily_orchestration_roots SET status=?,checkpoint_revision=?,last_business_progress_at=?,updated_at=?,finished_at=?
    WHERE workspace_id=? AND root_request_id=? AND checkpoint_revision=? AND owner_epoch=? AND lease_token=?
      AND status IN ('created','running','waiting_owner')`,
    )
    .run(
      nextRootStatus,
      nextRootRevision,
      nowUtc,
      nowUtc,
      rootTerminal ? nowUtc : null,
      actor.workspaceId,
      String(root.root_request_id),
      numberOr(root.checkpoint_revision, 0),
      actor.ownerEpoch,
      actor.leaseToken,
    );
  if (affectedRows(rootUpdate) !== 1)
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "root settlement CAS 失败。",
    );
  const nextIntent = intent
    ? (() => {
        const status =
          nextRootStatus === "waiting_owner" ? "waiting_owner" : nextRootStatus;
        const terminal = [
          "succeeded",
          "partial",
          "failed",
          "needs_user",
          "cancelled",
        ].includes(status);
        const intentUpdate = database
          .prepare(
            `UPDATE orchestrator_intents SET status=?,next_action_json=?,checkpoint_revision=checkpoint_revision+1,updated_at=?,finished_at=?
      WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=?
        AND status IN ('admitted','running','waiting_resource','preflight_pending','preflight_running','received','waiting_owner')`,
          )
          .run(
            status,
            nextAction === null || nextAction === undefined
              ? null
              : canonicalJsonV1(nextAction),
            nowUtc,
            terminal ? nowUtc : null,
            actor.workspaceId,
            String(intent.intent_id),
            numberOr(intent.checkpoint_revision, 0),
          );
        if (affectedRows(intentUpdate) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "intent settlement CAS 失败。",
          );
        return database
          .prepare(
            "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
          )
          .get(actor.workspaceId, String(intent.intent_id)) as Row;
      })()
    : null;
  return {
    root: database
      .prepare(
        "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
      )
      .get(actor.workspaceId, String(root.root_request_id)) as Row,
    intent: nextIntent,
  };
}

function updateStage(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  stage: Row,
  status: string,
  snapshotJson: string | null,
  resultJson: string | null,
  nowUtc: string,
  terminal: boolean,
  acceptance?: AcceptanceTuple,
): Row {
  const stageAcceptance =
    acceptance ??
    resolveAcceptance({}, [
      { row: stage, label: "stage" },
      {
        row: database
          .prepare(
            "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
          )
          .get(actor.workspaceId, String(stage.root_request_id)) as
          Row | undefined,
        label: "stage root",
      },
    ]);
  const nextRevision = numberOr(stage.claim_revision, 0) + 1;
  const update = database
    .prepare(
      `UPDATE daily_stage_claims SET status=?,is_active=?,claim_revision=?,snapshot_json=COALESCE(?,snapshot_json),result_json=COALESCE(?,result_json),updated_at=?,finished_at=?,
    acceptance_run_id=COALESCE(?,acceptance_run_id),baseline_event_sequence=COALESCE(?,baseline_event_sequence),baseline_checkpoint_revision=COALESCE(?,baseline_checkpoint_revision),
    created_after_event_sequence=COALESCE(?,created_after_event_sequence),created_after_checkpoint_revision=COALESCE(?,created_after_checkpoint_revision),created_after_mono=COALESCE(?,created_after_mono)
    WHERE workspace_id=? AND stage_request_id=? AND claim_revision=? AND owner_epoch=? AND lease_token=?
      AND status IN ('claimed_unbound','claimed','dispatching_scan','snapshot_frozen','awaiting_judge','dispatching_judge','manifest_frozen','dispatching','settling','running')`,
    )
    .run(
      status,
      terminal ? 0 : 1,
      nextRevision,
      snapshotJson,
      resultJson,
      nowUtc,
      terminal ? nowUtc : null,
      stageAcceptance[0],
      stageAcceptance[1],
      stageAcceptance[2],
      stageAcceptance[3],
      stageAcceptance[4],
      stageAcceptance[5],
      actor.workspaceId,
      String(stage.stage_request_id),
      numberOr(stage.claim_revision, 0),
      actor.ownerEpoch,
      actor.leaseToken,
    );
  if (affectedRows(update) !== 1)
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      "stage claim CAS 失败。",
    );
  return database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(actor.workspaceId, String(stage.stage_request_id)) as Row;
}

function stageIdentityFromRow(stage: Row): JsonRecord {
  return {
    stageRequestId: String(stage.stage_request_id),
    rootRequestId: String(stage.root_request_id),
    rootGeneration: numberOr(stage.root_generation, 0),
    rootInputHash: String(stage.root_input_hash),
    managerTaskId: String(stage.manager_task_id),
    orchestrationId: String(stage.orchestration_id),
    attemptStage: String(stage.attempt_stage),
  };
}

type NormalizedPlanProjection = {
  scope: JsonRecord;
  projection: JsonRecord;
  classification: {
    candidate: string[];
    eligible: string[];
    pending: string[];
    invalid: string[];
  };
  coverageGap: unknown[];
  rootStatus: "running" | "waiting_owner" | "succeeded" | "partial";
  stageStatus: "succeeded" | "partial";
  reasonCode: string;
  nextAction: JsonRecord;
  emptyQualified: boolean;
};

function normalizePlanProjection(
  input: JsonRecord,
  source: SourceSnapshotReadback,
  root: Row,
): NormalizedPlanProjection {
  const allowedPlanIds = uniqueStrings(input.allowedPlanIds, "allowedPlanIds");
  const allowedPlanItemIds = uniqueStrings(
    input.allowedPlanItemIds,
    "allowedPlanItemIds",
  );
  const carryPlanItemIds = uniqueStrings(
    input.carryPlanItemIds ?? [],
    "carryPlanItemIds",
  );
  const trustedReceiptIds = uniqueStrings(
    input.trustedReceiptIds ?? [],
    "trustedReceiptIds",
  );
  const allowedItemSet = new Set(allowedPlanItemIds);
  for (const id of carryPlanItemIds)
    if (!allowedItemSet.has(id))
      throw new WorkspaceOrchestratorActorError(
        "CANDIDATE_ADMISSION_GAP",
        `carry plan item 超出 scope: ${id}`,
      );
  const projectionInput =
    input.projection && typeof input.projection === "object"
      ? (input.projection as JsonRecord)
      : input;
  const candidate = uniqueStrings(
    projectionInput.candidatePlanItemIds ?? input.candidatePlanItemIds ?? [],
    "candidatePlanItemIds",
  );
  const eligible = uniqueStrings(
    projectionInput.eligiblePlanItemIds ?? input.eligiblePlanItemIds ?? [],
    "eligiblePlanItemIds",
  );
  const pending = uniqueStrings(
    projectionInput.pendingPlanItemIds ?? input.pendingPlanItemIds ?? [],
    "pendingPlanItemIds",
  );
  const invalid = uniqueStrings(
    projectionInput.invalidPlanItemIds ?? input.invalidPlanItemIds ?? [],
    "invalidPlanItemIds",
  );
  const owner = new Map<string, string>();
  for (const [name, values] of [
    ["eligible", eligible],
    ["pending", pending],
    ["invalid", invalid],
  ] as const)
    for (const id of values) {
      if (owner.has(id))
        throw new WorkspaceOrchestratorActorError(
          "CANDIDATE_ADMISSION_GAP",
          `candidate ${id} 分类重复。`,
        );
      owner.set(id, name);
      if (!allowedItemSet.has(id))
        throw new WorkspaceOrchestratorActorError(
          "CANDIDATE_ADMISSION_GAP",
          `candidate ${id} 超出显式 PlanScope。`,
        );
    }
  const union = Array.from(owner.keys()).sort(compareCodePoints);
  if (canonicalJsonV1(union) !== canonicalJsonV1(candidate))
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "candidate 分类未覆盖且仅覆盖每个 admitted candidate 一次。",
    );
  const entriesRaw = projectionInput.entries ?? input.entries ?? [];
  if (!Array.isArray(entriesRaw))
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "projection entries 必须是数组。",
    );
  const entries: JsonRecord[] = entriesRaw
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new WorkspaceOrchestratorActorError(
          "CANDIDATE_ADMISSION_GAP",
          "projection entry 必须是对象。",
        );
      const row = entry as JsonRecord;
      const planItemId = normalizedString(
        row.planItemId ?? row.plan_item_id ?? row.id,
        "projection.planItemId",
      );
      const classification = String(row.classification ?? "")
        .trim()
        .toLowerCase();
      if (
        !["eligible", "pending", "invalid"].includes(classification) ||
        owner.get(planItemId) !== classification
      )
        throw new WorkspaceOrchestratorActorError(
          "CANDIDATE_ADMISSION_GAP",
          `projection entry 分类不匹配: ${planItemId}`,
        );
      const sourceReceiptIds = uniqueStrings(
        row.sourceReceiptIds ?? row.source_receipt_ids ?? [],
        `entry ${planItemId}.sourceReceiptIds`,
      );
      for (const receiptId of sourceReceiptIds)
        if (!trustedReceiptIds.includes(receiptId))
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_ADMISSION_GAP",
            `candidate ${planItemId} 使用未信任 receipt: ${receiptId}`,
          );
      return Object.freeze({
        ...row,
        planItemId,
        classification,
        sourceReceiptIds,
      });
    })
    .sort((left, right) =>
      compareCodePoints(String(left.planItemId), String(right.planItemId)),
    );
  if (
    entries.length !== candidate.length ||
    canonicalJsonV1(entries.map((entry) => entry.planItemId)) !==
      canonicalJsonV1(candidate)
  )
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "projection entries 未覆盖所有 candidate。",
    );
  const sourceFailed = jsonArray(source.failedChannels);
  const sourceUnresolved = jsonArray(source.unresolvedChannels);
  const inputGap = projectionInput.coverageGap ?? input.coverageGap ?? [];
  if (!Array.isArray(inputGap))
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "coverageGap 必须是数组。",
    );
  const coverageGap = [...inputGap];
  for (const gap of [...sourceFailed, ...sourceUnresolved])
    if (
      !coverageGap.some(
        (item) => canonicalJsonV1(item) === canonicalJsonV1(gap),
      )
    )
      coverageGap.push(gap);
  const selectedReceipts = new Set(jsonArray(source.receiptIds).map(String));
  for (const receiptId of trustedReceiptIds)
    if (!selectedReceipts.has(receiptId))
      throw new WorkspaceOrchestratorActorError(
        "CANDIDATE_ADMISSION_GAP",
        `trusted receipt 不属于 frozen source snapshot: ${receiptId}`,
      );
  const sourceSuccessful = jsonArray(source.successfulChannels);
  const sourceReceiptsComplete =
    sourceSuccessful.every((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return false;
      const row = entry as JsonRecord;
      const receiptId = row.receiptId ?? row.receipt_id;
      return (
        receiptId !== undefined &&
        receiptId !== null &&
        trustedReceiptIds.includes(String(receiptId))
      );
    }) && sourceUnresolved.length === 0;
  const candidateInputCount =
    input.candidateInputCount === undefined
      ? candidate.length
      : finiteNumber(input.candidateInputCount, "candidateInputCount", 0);
  const classifiedCount =
    input.classifiedCount === undefined
      ? union.length
      : finiteNumber(input.classifiedCount, "classifiedCount", 0);
  if (
    candidateInputCount !== classifiedCount ||
    classifiedCount !== candidate.length
  )
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "candidateInputCount/classifiedCount 与分类集合不一致。",
    );
  const emptyQualified =
    candidateInputCount === 0 &&
    classifiedCount === 0 &&
    eligible.length === 0 &&
    pending.length === 0 &&
    invalid.length === 0 &&
    sourceReceiptsComplete &&
    sourceUnresolved.length === 0 &&
    coverageGap.length === 0;
  if (
    input.emptyQualified !== undefined &&
    Boolean(input.emptyQualified) !== emptyQualified
  )
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "emptyQualified 与完整 source/coverage 证据不一致。",
    );
  const planIds = uniqueStrings(
    projectionInput.planIds ?? input.planIds ?? allowedPlanIds,
    "planIds",
  );
  const scope = {
    ...jsonObject(input.scope),
    version: "PlanScopeV1",
    workspaceId: String(input.workspaceId),
    stageRequestId: String(input.stageRequestId),
    rootRequestId: String(input.rootRequestId),
    rootGeneration: finiteNumber(input.rootGeneration, "rootGeneration", 0),
    rootInputHash: String(input.rootInputHash),
    sourceSnapshotHash: String(source.snapshotHash),
    bindingKind: String(
      input.bindingKind ?? (input.repair ? "repaired" : "initial_source"),
    ),
    repairSnapshotId: input.repairSnapshotId ?? null,
    repairSnapshotHash: input.repairSnapshotHash ?? null,
    bindingHash: input.bindingHash ?? null,
    allowedPlanIds,
    allowedPlanItemIds,
    carryPlanItemIds,
    trustedReceiptIds,
  };
  const scopeHash = hashV1({
    r: "plan-scope/v1",
    workspaceId: String(input.workspaceId),
    stageRequestId: String(input.stageRequestId),
    rootRequestId: String(input.rootRequestId),
    sourceSnapshotHash: String(source.snapshotHash),
    bindingHash: scope.bindingHash,
    orderedAllowedPlanIds: allowedPlanIds,
    orderedAllowedItemIds: allowedPlanItemIds,
    orderedCarryItemIds: carryPlanItemIds,
    trustedReceiptIds,
    scopeJson: scope,
  });
  const asOf = projectionInput.asOf ??
    input.asOf ?? { utc: root.updated_at ?? null, mono: null };
  const baseProjection = {
    version: "TodayRecommendationProjectionV2",
    workspaceId: String(input.workspaceId),
    businessDate: String(root.business_date),
    managerTaskId: String(input.managerTaskId ?? root.manager_task_id),
    orchestrationId: String(input.orchestrationId ?? root.orchestration_id),
    stageRequestId: String(input.stageRequestId),
    scopeHash,
    bindingHash: scope.bindingHash,
    repairSnapshotHash: scope.repairSnapshotHash,
    planIds,
    asOf,
    entries,
    candidatePlanItemIds: candidate,
    eligiblePlanItemIds: eligible,
    pendingPlanItemIds: pending,
    invalidPlanItemIds: invalid,
    trustedReceiptIds,
    emptyQualified,
    acceptanceRunId: input.acceptanceRunId ?? null,
    baselineEventSequence: input.baselineEventSequence ?? null,
    baselineCheckpointRevision: input.baselineCheckpointRevision ?? null,
    createdAfterEventSequence: input.createdAfterEventSequence ?? null,
    createdAfterCheckpointRevision:
      input.createdAfterCheckpointRevision ?? null,
    createdAfterMono: input.createdAfterMono ?? null,
  };
  const projectionHash = hashV1({
    r: "projection/v2",
    workspaceId: baseProjection.workspaceId,
    businessDate: baseProjection.businessDate,
    managerTaskId: baseProjection.managerTaskId,
    orchestrationId: baseProjection.orchestrationId,
    stageRequestId: baseProjection.stageRequestId,
    scopeHash,
    bindingHash: scope.bindingHash,
    repairSnapshotHash: scope.repairSnapshotHash,
    planIds,
    asOf,
    orderedEntries: entries,
    candidatePlanItemIds: candidate,
    eligiblePlanItemIds: eligible,
    pendingPlanItemIds: pending,
    invalidPlanItemIds: invalid,
    trustedReceiptIds,
    emptyQualified,
  });
  const projection = Object.freeze({ ...baseProjection, projectionHash });
  const successorOrdinal = numberOr(
    input.evidenceSuccessorOrdinal ?? input.successorOrdinal,
    0,
  );
  const maxEvidenceSuccessors = Math.min(
    2,
    numberOr(input.maxEvidenceSuccessors, 2),
  );
  const successorAvailable = successorOrdinal < maxEvidenceSuccessors;
  let rootStatus: "running" | "waiting_owner" | "succeeded" | "partial";
  let stageStatus: "succeeded" | "partial";
  let reasonCode: string;
  let nextAction: JsonRecord;
  if (pending.length > 0 && invalid.length > 0) {
    rootStatus = successorAvailable ? "running" : "partial";
    stageStatus = "partial";
    reasonCode = "SCORING_INCOMPLETE_AND_INVALID";
    nextAction = {
      kind: "auto_bounded_successor_or_stop",
      reasonCode,
      rootRequestId: input.rootRequestId,
      stageRequestId: input.stageRequestId,
      scopeHash,
      projectionHash,
      pendingPlanItemIds: pending,
      invalidPlanItemIds: invalid,
      successorOrdinal,
      maxEvidenceSuccessors,
    };
  } else if (pending.length > 0) {
    rootStatus = successorAvailable ? "running" : "partial";
    stageStatus = "partial";
    reasonCode = "SCORING_INCOMPLETE";
    nextAction = {
      kind: "auto_bounded_successor_or_stop",
      reasonCode,
      rootRequestId: input.rootRequestId,
      stageRequestId: input.stageRequestId,
      scopeHash,
      projectionHash,
      pendingPlanItemIds: pending,
      invalidPlanItemIds: invalid,
      successorOrdinal,
      maxEvidenceSuccessors,
    };
  } else if (invalid.length > 0) {
    rootStatus = "partial";
    stageStatus = "partial";
    reasonCode = "INVALID_NEEDS_REPAIR";
    nextAction = {
      kind: "repair_invalid_candidate",
      rootRequestId: input.rootRequestId,
      stageRequestId: input.stageRequestId,
      scopeHash,
      projectionHash,
      invalidPlanItemIds: invalid,
      repairDeadline: input.repairDeadline ?? null,
    };
  } else if (eligible.length > 0) {
    rootStatus = "waiting_owner";
    stageStatus = "succeeded";
    reasonCode = "READY_FOR_OWNER_APPROVAL";
    nextAction = {
      kind: "approve_candidates",
      rootRequestId: input.rootRequestId,
      stageRequestId: input.stageRequestId,
      scopeHash,
      projectionHash,
      eligiblePlanItemIds: eligible,
    };
  } else if (emptyQualified) {
    rootStatus = "succeeded";
    stageStatus = "succeeded";
    reasonCode = "NO_ELIGIBLE_OPPORTUNITY";
    nextAction = { kind: "no_action", reasonCode, emptyQualified: true };
  } else {
    rootStatus = "partial";
    stageStatus = "partial";
    reasonCode = "OPTIONAL_CHANNEL_COVERAGE_GAP";
    nextAction = {
      kind: "no_action_until_next_intent",
      reasonCode,
      coverageGap,
    };
  }
  return {
    scope: { ...scope, scopeHash },
    projection,
    classification: { candidate, eligible, pending, invalid },
    coverageGap,
    rootStatus,
    stageStatus,
    reasonCode,
    nextAction,
    emptyQualified,
  };
}
const PROGRESS_HASH_PATTERN = /^[0-9a-f]{64}$/;

function progressRecord(value: unknown, field: string): JsonRecord {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是对象。`,
    );
  return value as JsonRecord;
}

function progressValue(
  records: readonly JsonRecord[],
  keys: readonly string[],
): unknown {
  for (const record of records)
    for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function progressIds(
  value: unknown,
  field: string,
  fallback: readonly string[] = [],
): string[] {
  if (value === undefined) return [...fallback].sort(compareCodePoints);
  if (!Array.isArray(value))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是数组。`,
    );
  const seen = new Set<string>();
  for (const item of value) seen.add(normalizedString(item, `${field} item`));
  return [...seen].sort(compareCodePoints);
}

function progressHash(
  value: unknown,
  field: string,
  fallback?: string,
): string {
  const candidate = value === undefined ? fallback : value;
  if (candidate === undefined)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须显式提供。`,
    );
  const normalized = normalizedString(candidate, field);
  if (!PROGRESS_HASH_PATTERN.test(normalized))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是 64 位 lowercase hex。`,
    );
  return normalized;
}

function progressCount(
  value: unknown,
  field: string,
  expected?: number,
): number {
  if (value === undefined && expected !== undefined) return expected;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 必须是有限非负整数。`,
    );
  if (expected !== undefined && number !== expected)
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      `${field} 与当前 projection 不一致。`,
    );
  return number;
}

function normalizeProgressAfter(
  input: JsonRecord,
  plan: NormalizedPlanProjection,
  requireExplicitGap: boolean,
): ProgressMeasure {
  const projectionInput =
    input.projection &&
    typeof input.projection === "object" &&
    !Array.isArray(input.projection)
      ? (input.projection as JsonRecord)
      : {};
  const raw = progressRecord(input.progressAfter, "progressAfter");
  const records = [raw, input, projectionInput];
  const missingValue = progressValue(records, [
    "orderedMissingEvidenceIds",
    "missingRequiredEvidenceIds",
  ]);
  const gapValue = progressValue(records, ["orderedGapItemIds", "gapItemIds"]);
  const candidateValue = progressValue(records, [
    "orderedCandidatePlanItemIds",
  ]);
  const gapHashValue = progressValue(records, ["gapHash"]);
  const projectionHashValue = progressValue(records, ["projectionHash"]);
  if (
    requireExplicitGap &&
    (missingValue === undefined ||
      gapValue === undefined ||
      gapHashValue === undefined)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "successor progressAfter 必须显式提供 missing/gap IDs 与 gapHash。",
    );
  }
  const orderedMissingEvidenceIds = progressIds(
    missingValue,
    "orderedMissingEvidenceIds",
  );
  const orderedGapItemIds = progressIds(gapValue, "orderedGapItemIds");
  const orderedCandidatePlanItemIds = progressIds(
    candidateValue,
    "orderedCandidatePlanItemIds",
    plan.classification.candidate,
  );
  if (
    canonicalJsonV1(orderedCandidatePlanItemIds) !==
    canonicalJsonV1(plan.classification.candidate)
  )
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "orderedCandidatePlanItemIds 与当前 projection 不一致。",
    );
  const expected = {
    missingRequiredEvidenceCount: orderedMissingEvidenceIds.length,
    invalidCount: plan.classification.invalid.length,
    pendingCount: plan.classification.pending.length,
    coverageGapCount: plan.coverageGap.length,
    trustedReceiptCount: jsonArray(input.trustedReceiptIds ?? []).length,
    eligibleCount: plan.classification.eligible.length,
  };
  const measure: ProgressMeasure = {
    gapHash: progressHash(
      gapHashValue,
      "gapHash",
      hashV1({
        r: "progress-gap/v2",
        orderedMissingEvidenceIds,
        orderedGapItemIds,
        coverageGap: plan.coverageGap,
      }),
    ),
    projectionHash: progressHash(
      projectionHashValue,
      "projectionHash",
      String(plan.projection.projectionHash),
    ),
    missingRequiredEvidenceCount: progressCount(
      progressValue(records, ["missingRequiredEvidenceCount"]),
      "missingRequiredEvidenceCount",
      expected.missingRequiredEvidenceCount,
    ),
    invalidCount: progressCount(
      progressValue(records, ["invalidCount"]),
      "invalidCount",
      expected.invalidCount,
    ),
    pendingCount: progressCount(
      progressValue(records, ["pendingCount"]),
      "pendingCount",
      expected.pendingCount,
    ),
    coverageGapCount: progressCount(
      progressValue(records, ["coverageGapCount"]),
      "coverageGapCount",
      expected.coverageGapCount,
    ),
    trustedReceiptCount: progressCount(
      progressValue(records, ["trustedReceiptCount"]),
      "trustedReceiptCount",
      expected.trustedReceiptCount,
    ),
    eligibleCount: progressCount(
      progressValue(records, ["eligibleCount"]),
      "eligibleCount",
      expected.eligibleCount,
    ),
    orderedMissingEvidenceIds,
    orderedGapItemIds,
    orderedCandidatePlanItemIds,
  };
  return Object.freeze(measure);
}

function normalizePersistedProgressMeasure(
  value: unknown,
  field: string,
): ProgressMeasure {
  const record = progressRecord(value, field);
  const orderedMissingEvidenceIds = progressIds(
    record.orderedMissingEvidenceIds ?? record.missingRequiredEvidenceIds,
    `${field}.orderedMissingEvidenceIds`,
  );
  const orderedGapItemIds = progressIds(
    record.orderedGapItemIds ?? record.gapItemIds,
    `${field}.orderedGapItemIds`,
  );
  const orderedCandidatePlanItemIds = progressIds(
    record.orderedCandidatePlanItemIds,
    `${field}.orderedCandidatePlanItemIds`,
  );
  return Object.freeze({
    gapHash: progressHash(record.gapHash, `${field}.gapHash`),
    projectionHash: progressHash(
      record.projectionHash,
      `${field}.projectionHash`,
    ),
    missingRequiredEvidenceCount: progressCount(
      record.missingRequiredEvidenceCount,
      `${field}.missingRequiredEvidenceCount`,
      orderedMissingEvidenceIds.length,
    ),
    invalidCount: progressCount(record.invalidCount, `${field}.invalidCount`),
    pendingCount: progressCount(record.pendingCount, `${field}.pendingCount`),
    coverageGapCount: progressCount(
      record.coverageGapCount,
      `${field}.coverageGapCount`,
    ),
    trustedReceiptCount: progressCount(
      record.trustedReceiptCount,
      `${field}.trustedReceiptCount`,
    ),
    eligibleCount: progressCount(
      record.eligibleCount,
      `${field}.eligibleCount`,
    ),
    orderedMissingEvidenceIds,
    orderedGapItemIds,
    orderedCandidatePlanItemIds,
  });
}

function progressStateFromScope(row: Row): ProgressState | null {
  const stored = jsonObject(row.scope_json);
  const projection = jsonObject(stored.projection ?? row.result_json);
  const state = jsonObject(stored.progress ?? projection.progress ?? {});
  const beforeRaw =
    state.progressBefore ?? projection.progressBefore ?? stored.progressBefore;
  const afterRaw =
    state.progressAfter ?? projection.progressAfter ?? stored.progressAfter;
  if (beforeRaw === undefined || afterRaw === undefined) return null;
  const version = progressCount(
    state.progressMeasureVersion ??
      projection.progressMeasureVersion ??
      stored.progressMeasureVersion,
    "progressMeasureVersion",
  );
  if (version !== 2) return null;
  const ordinal = progressCount(
    state.progressOrdinal ??
      projection.progressOrdinal ??
      stored.progressOrdinal,
    "progressOrdinal",
  );
  return Object.freeze({
    progressBefore: normalizePersistedProgressMeasure(
      beforeRaw,
      "progressBefore",
    ),
    progressAfter: normalizePersistedProgressMeasure(afterRaw, "progressAfter"),
    progressMeasureVersion: 2,
    progressOrdinal: ordinal,
    strictProgress: Boolean(
      state.strictProgress ??
      projection.strictProgress ??
      stored.strictProgress,
    ),
  });
}

function sameProgressState(left: ProgressState, right: ProgressState): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}
function sameProgressMeasure(
  left: ProgressMeasure,
  right: ProgressMeasure,
): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function strictProgressImprovement(
  before: ProgressMeasure,
  after: ProgressMeasure,
): boolean {
  const primary: readonly [keyof ProgressMeasure, "asc" | "desc"][] = [
    ["missingRequiredEvidenceCount", "asc"],
    ["invalidCount", "asc"],
    ["pendingCount", "asc"],
    ["coverageGapCount", "asc"],
    ["trustedReceiptCount", "desc"],
    ["eligibleCount", "desc"],
  ];
  for (const [field, direction] of primary) {
    const left = before[field] as number;
    const right = after[field] as number;
    if (left === right) continue;
    return direction === "asc" ? right < left : right > left;
  }
  return false;
}

function progressStateFor(
  input: JsonRecord,
  plan: NormalizedPlanProjection,
  predecessor: Row | null,
  successorOrdinal: number,
): ProgressState {
  const progressAfter = normalizeProgressAfter(
    input,
    plan,
    successorOrdinal > 0,
  );
  const predecessorState = predecessor
    ? progressStateFromScope(predecessor)
    : null;
  const beforeRecord =
    input.progressBefore === undefined
      ? null
      : progressRecord(input.progressBefore, "progressBefore");
  const progressBefore = beforeRecord
    ? normalizePersistedProgressMeasure(beforeRecord, "progressBefore")
    : (predecessorState?.progressAfter ?? progressAfter);
  if (
    predecessorState &&
    !sameProgressMeasure(progressBefore, predecessorState.progressAfter)
  )
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_ADMISSION_GAP",
      "progressBefore 与 predecessor progressAfter 不一致。",
    );
  const strictProgress =
    successorOrdinal > 0 &&
    strictProgressImprovement(progressBefore, progressAfter) &&
    progressBefore.gapHash !== progressAfter.gapHash;
  return Object.freeze({
    progressBefore,
    progressAfter,
    progressMeasureVersion: 2,
    progressOrdinal: successorOrdinal,
    strictProgress,
  });
}

function sameRootLineage(row: Row, root: Row): boolean {
  return (
    String(row.workspace_id ?? row.workspaceId ?? "") ===
      String(root.workspace_id ?? root.workspaceId ?? "") &&
    String(row.root_request_id ?? row.rootRequestId ?? "") ===
      String(root.root_request_id ?? root.rootRequestId ?? "") &&
    numberOr(row.root_generation ?? row.rootGeneration, -1) ===
      numberOr(root.root_generation ?? root.rootGeneration, -2) &&
    String(row.root_input_hash ?? row.rootInputHash ?? "") ===
      String(root.root_input_hash ?? root.rootInputHash ?? "")
  );
}

function assertCurrentSourceLineage(
  database: DatabaseSync,
  sourceRow: Row,
  root: Row,
  stageRequestId: string,
): void {
  const sourceRootRequestId = String(sourceRow.root_request_id ?? "");
  const sourceRootGeneration = numberOr(sourceRow.root_generation, -1);
  if (
    String(sourceRow.workspace_id ?? "") !== String(root.workspace_id ?? "") ||
    sourceRootRequestId !== String(root.root_request_id ?? "") ||
    sourceRootGeneration !== numberOr(root.root_generation, -2) ||
    String(sourceRow.stage_request_id ?? "") !== stageRequestId
  ) {
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "current source snapshot lineage 与 root/stage 不一致。",
      { stageRequestId, rootRequestId: root.root_request_id },
    );
  }
  const sourceRoot = database
    .prepare(
      "SELECT root_request_id,root_generation,root_input_hash FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    )
    .get(String(root.workspace_id), sourceRootRequestId) as Row | undefined;
  if (
    !sourceRoot ||
    !sameRootLineage({ ...sourceRoot, workspace_id: root.workspace_id }, root)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "SOURCE_SNAPSHOT_STALE",
      "current source snapshot root lineage 不可追溯。",
      { stageRequestId, rootRequestId: sourceRootRequestId },
    );
  }
}

function assertSuccessorPredecessorLineage(
  database: DatabaseSync,
  predecessor: Row,
  root: Row,
): void {
  if (!sameRootLineage(predecessor, root)) {
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "successor predecessor 必须属于当前 root lineage。",
      {
        predecessorScopeId: predecessor.scope_id,
        rootRequestId: root.root_request_id,
      },
    );
  }
  const predecessorStageRequestId = String(predecessor.stage_request_id ?? "");
  const predecessorStage = database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(String(root.workspace_id), predecessorStageRequestId) as
    Row | undefined;
  if (!predecessorStage || !sameRootLineage(predecessorStage, root)) {
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "successor predecessor parent stage 不可追溯到当前 root。",
      {
        predecessorScopeId: predecessor.scope_id,
        stageRequestId: predecessorStageRequestId,
      },
    );
  }
  const predecessorSnapshotHash = String(
    predecessor.source_snapshot_hash ?? "",
  );
  const predecessorSnapshot = predecessorSnapshotHash
    ? (database
        .prepare(
          "SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?",
        )
        .get(String(root.workspace_id), predecessorSnapshotHash) as
        Row | undefined)
    : undefined;
  if (!predecessorSnapshot || String(predecessorSnapshot.status) !== "frozen") {
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "successor predecessor source snapshot 不可追溯。",
      {
        predecessorScopeId: predecessor.scope_id,
        stageRequestId: predecessorStageRequestId,
      },
    );
  }
  const predecessorStageSnapshot = jsonObject(predecessorStage.snapshot_json);
  const expectedSourceStageRequestId = String(
    predecessorStageSnapshot.sourceSnapshotStageRequestId ??
      predecessorStageSnapshot.source_snapshot_stage_request_id ??
      predecessorStageRequestId,
  );
  if (
    String(predecessorSnapshot.stage_request_id) !==
    expectedSourceStageRequestId
  ) {
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "successor predecessor source stage lineage 不一致。",
      {
        predecessorScopeId: predecessor.scope_id,
        stageRequestId: predecessorStageRequestId,
      },
    );
  }
  assertCurrentSourceLineage(
    database,
    predecessorSnapshot,
    root,
    String(predecessorSnapshot.stage_request_id),
  );
}

function repairBinding(
  database: DatabaseSync,
  input: JsonRecord,
  source: SourceSnapshotReadback,
  pairUtc: string,
  persist = true,
): RepairBindingResult {
  const rawRepair = input.repair;
  if (!rawRepair && !input.repairItems)
    return {
      bindingKind: "initial_source",
      repairSnapshotId: null,
      repairSnapshotHash: null,
      bindingHash: null,
      repairRow: null,
      predecessorRow: null,
    };
  const repair =
    rawRepair && typeof rawRepair === "object" && !Array.isArray(rawRepair)
      ? (rawRepair as JsonRecord)
      : {};
  const predecessorScopeId = normalizedString(
    repair.predecessorScopeId ?? repair.predecessor_scope_id,
    "predecessorScopeId",
  );
  const predecessorScopeHash = normalizedString(
    repair.predecessorScopeHash ?? repair.predecessor_scope_hash,
    "predecessorScopeHash",
  );
  const predecessorScope = database
    .prepare(
      "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND scope_id=? AND scope_hash=?",
    )
    .get(
      String(input.workspaceId),
      predecessorScopeId,
      predecessorScopeHash,
    ) as Row | undefined;
  if (!predecessorScope)
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "repair predecessor scope 不存在。",
    );
  if (String(predecessorScope.scope_status) === "superseded")
    throw new WorkspaceOrchestratorActorError(
      "SCOPE_ARCHIVED",
      "repair predecessor scope 已归档；late repair 仅保留既有 archive audit。",
      { predecessorScopeId, predecessorScopeHash },
    );
  if (String(predecessorScope.scope_status) !== "frozen")
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "repair predecessor scope 未 frozen。",
    );
  const sourceAcceptance = parseAcceptance(source as unknown as JsonRecord);
  const acceptance = resolveAcceptance(input, [
    { row: predecessorScope, label: "repair predecessor scope" },
    {
      row: {
        acceptance_run_id: sourceAcceptance[0],
        baseline_event_sequence: sourceAcceptance[1],
        baseline_checkpoint_revision: sourceAcceptance[2],
        created_after_event_sequence: sourceAcceptance[3],
        created_after_checkpoint_revision: sourceAcceptance[4],
        created_after_mono: sourceAcceptance[5],
      },
      label: "source snapshot",
    },
  ]);
  const rawItems =
    input.repairItems ?? repair.items ?? repair.repairedItems ?? [];
  if (!Array.isArray(rawItems) || rawItems.length === 0)
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "repair binding 缺少显式修复 item。",
    );
  const items = rawItems
    .map((raw: unknown, index: number) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new WorkspaceOrchestratorActorError(
          "CANDIDATE_REPAIR_REJECTED",
          "repair item 必须是对象。",
        );
      const row = raw as JsonRecord;
      const planItemId = normalizedString(
        row.planItemId ?? row.plan_item_id,
        "repair.planItemId",
      );
      const priorItemRevision = finiteNumber(
        row.priorItemRevision ?? row.prior_item_revision,
        "priorItemRevision",
        1,
      );
      const priorItemContentHash = normalizedString(
        row.priorItemContentHash ?? row.prior_item_content_hash,
        "priorItemContentHash",
      );
      const repairedItemRevision = finiteNumber(
        row.repairedItemRevision ?? row.repaired_item_revision,
        "repairedItemRevision",
        priorItemRevision,
      );
      if (repairedItemRevision < priorItemRevision)
        throw new WorkspaceOrchestratorActorError(
          "CANDIDATE_REPAIR_REJECTED",
          `repair revision 回退: ${planItemId}`,
        );
      const repairedItemContentHash = normalizedString(
        row.repairedItemContentHash ?? row.repaired_item_content_hash,
        "repairedItemContentHash",
      );
      const receiptId = normalizedString(
        row.receiptId ?? row.receipt_id,
        "repair.receiptId",
      );
      const receiptRevision = finiteNumber(
        row.receiptRevision ?? row.receipt_revision,
        "repair.receiptRevision",
        1,
      );
      const receiptPayloadHash = normalizedString(
        row.receiptPayloadHash ?? row.receipt_payload_hash,
        "repair.receiptPayloadHash",
      );
      const childOrdinal = finiteNumber(
        row.childOrdinal ?? row.child_ordinal ?? index + 1,
        "repair.childOrdinal",
        1,
      );
      const childPreimage = {
        r: "repair-binding-child/v1",
        workspaceId: String(input.workspaceId),
        repairSnapshotId: "",
        childOrdinal,
        planItemId,
        priorItemRevision,
        priorItemContentHash,
        repairedItemRevision,
        repairedItemContentHash,
        receiptId,
        receiptRevision,
        receiptPayloadHash,
      };
      return {
        ...row,
        planItemId,
        priorItemRevision,
        priorItemContentHash,
        repairedItemRevision,
        repairedItemContentHash,
        receiptId,
        receiptRevision,
        receiptPayloadHash,
        childOrdinal,
        childPreimage,
      };
    })
    .sort(
      (left, right) =>
        numberOr(left.childOrdinal, 0) - numberOr(right.childOrdinal, 0) ||
        compareCodePoints(String(left.planItemId), String(right.planItemId)),
    );
  const repairOrdinal = finiteNumber(
    repair.repairOrdinal ?? input.repairOrdinal ?? 1,
    "repairOrdinal",
    1,
  );
  const orderedRepairIdentityKeys = items
    .map((item) => `${item.planItemId}:${item.receiptId}`)
    .sort(compareCodePoints);
  const repairSnapshotId = hashV1({
    r: "repair-snapshot-id/v1",
    workspaceId: String(input.workspaceId),
    predecessorStageRequestId: String(
      predecessorScope.predecessor_stage_request_id ??
        predecessorScope.stage_request_id,
    ),
    predecessorScopeHash,
    sourceSnapshotHash: source.snapshotHash,
    repairOrdinal,
    orderedRepairIdentityKeys,
  });
  const children = items.map((item, index) => {
    const child = {
      ...item.childPreimage,
      repairSnapshotId,
      childOrdinal: index + 1,
    };
    const childHash = hashV1(child);
    return {
      ...item,
      childOrdinal: index + 1,
      childHash,
      childPreimage: child,
    };
  });
  const orderedRepairBindingChildHashes = children.map(
    (item) => item.childHash,
  );
  const repairSnapshotHash = hashV1({
    r: "repair-snapshot/v2",
    workspaceId: String(input.workspaceId),
    repairSnapshotId,
    predecessorStageRequestId: String(
      predecessorScope.predecessor_stage_request_id ??
        predecessorScope.stage_request_id,
    ),
    predecessorScopeHash,
    sourceSnapshotHash: source.snapshotHash,
    orderedRepairBindingChildHashes,
  });
  const bindingHash = hashV1({
    r: "repair-binding/v2",
    workspaceId: String(input.workspaceId),
    predecessorStageRequestId: String(
      predecessorScope.predecessor_stage_request_id ??
        predecessorScope.stage_request_id,
    ),
    predecessorScopeHash,
    sourceSnapshotHash: source.snapshotHash,
    repairSnapshotId,
    repairSnapshotHash,
    orderedRepairBindingChildHashes,
  });
  const existing = database
    .prepare(
      "SELECT * FROM daily_repair_snapshot_bindings WHERE workspace_id=? AND binding_hash=?",
    )
    .get(String(input.workspaceId), bindingHash) as Row | undefined;
  if (existing) {
    if (
      !sameAcceptance(acceptanceFromRow(existing, "repair binding"), acceptance)
    )
      throw new WorkspaceOrchestratorActorError(
        "ACCEPTANCE_PROVENANCE_CONFLICT",
        "repair binding replay provenance 不一致。",
      );
    return {
      bindingKind: "repaired",
      repairSnapshotId,
      repairSnapshotHash,
      bindingHash,
      repairRow: existing,
      predecessorRow: predecessorScope,
    };
  }
  if (!persist)
    return {
      bindingKind: "repaired",
      repairSnapshotId,
      repairSnapshotHash,
      bindingHash,
      repairRow: null,
      predecessorRow: predecessorScope,
    };
  insertIdentity(
    database,
    String(input.workspaceId),
    "repair-snapshot-id/v1",
    {
      r: "repair-snapshot-id/v1",
      workspaceId: String(input.workspaceId),
      predecessorStageRequestId: String(
        predecessorScope.predecessor_stage_request_id ??
          predecessorScope.stage_request_id,
      ),
      predecessorScopeHash,
      sourceSnapshotHash: source.snapshotHash,
      repairOrdinal,
      orderedRepairIdentityKeys,
    },
    repairSnapshotId,
    pairUtc,
  );
  for (const child of children)
    insertIdentity(
      database,
      String(input.workspaceId),
      "repair-binding-child/v1",
      child.childPreimage,
      child.childHash,
      pairUtc,
    );
  insertIdentity(
    database,
    String(input.workspaceId),
    "repair-snapshot/v2",
    {
      r: "repair-snapshot/v2",
      workspaceId: String(input.workspaceId),
      repairSnapshotId,
      predecessorStageRequestId: String(
        predecessorScope.predecessor_stage_request_id ??
          predecessorScope.stage_request_id,
      ),
      predecessorScopeHash,
      sourceSnapshotHash: source.snapshotHash,
      orderedRepairBindingChildHashes,
    },
    repairSnapshotHash,
    pairUtc,
  );
  insertIdentity(
    database,
    String(input.workspaceId),
    "repair-binding/v2",
    {
      r: "repair-binding/v2",
      workspaceId: String(input.workspaceId),
      predecessorStageRequestId: String(
        predecessorScope.predecessor_stage_request_id ??
          predecessorScope.stage_request_id,
      ),
      predecessorScopeHash,
      sourceSnapshotHash: source.snapshotHash,
      repairSnapshotId,
      repairSnapshotHash,
      orderedRepairBindingChildHashes,
    },
    bindingHash,
    pairUtc,
  );
  const first = children[0];
  database
    .prepare(
      `INSERT INTO daily_repair_snapshot_bindings (
    repair_snapshot_id,workspace_id,predecessor_scope_id,predecessor_source_snapshot_id,predecessor_stage_request_id,
    binding_kind,prior_item_revision,prior_item_content_hash,repaired_item_revision,repaired_item_content_hash,
    repair_snapshot_hash,binding_hash,binding_revision,child_hashes_json,acceptance_run_id,baseline_event_sequence,
    baseline_checkpoint_revision,created_after_event_sequence,created_after_checkpoint_revision,created_after_mono,created_at
  ) VALUES (?, ?, ?, ?, ?, 'repaired', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repairSnapshotId,
      String(input.workspaceId),
      predecessorScopeId,
      source.snapshotId,
      String(
        predecessorScope.predecessor_stage_request_id ??
          predecessorScope.stage_request_id,
      ),
      first.priorItemRevision,
      first.priorItemContentHash,
      first.repairedItemRevision,
      first.repairedItemContentHash,
      repairSnapshotHash,
      bindingHash,
      canonicalJsonV1(orderedRepairBindingChildHashes),
      acceptance[0],
      acceptance[1],
      acceptance[2],
      acceptance[3],
      acceptance[4],
      acceptance[5],
      pairUtc,
    );
  const row = database
    .prepare(
      "SELECT * FROM daily_repair_snapshot_bindings WHERE workspace_id=? AND binding_hash=?",
    )
    .get(String(input.workspaceId), bindingHash) as Row;
  return {
    bindingKind: "repaired",
    repairSnapshotId,
    repairSnapshotHash,
    bindingHash,
    repairRow: row,
    predecessorRow: predecessorScope,
  };
}

function normalizeTarget(raw: unknown): JsonRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      "Stage-D target 必须是显式对象。",
    );
  const row = raw as JsonRecord;
  const targetId = normalizedString(
    row.targetId ?? row.target_id ?? row.id,
    "targetId",
  );
  const targetRevision = finiteNumber(
    row.targetRevision ?? row.target_revision ?? row.revision,
    "targetRevision",
    1,
  );
  const targetContentHash = normalizedString(
    row.targetContentHash ??
      row.target_content_hash ??
      row.contentHash ??
      row.content_hash,
    "targetContentHash",
  );
  const planItemId = normalizedString(
    row.planItemId ?? row.plan_item_id,
    "planItemId",
  );
  const planItemRevision = finiteNumber(
    row.planItemRevision ?? row.plan_item_revision,
    "planItemRevision",
    1,
  );
  const planItemContentHash = normalizedString(
    row.planItemContentHash ??
      row.plan_item_content_hash ??
      row.itemContentHash,
    "planItemContentHash",
  );
  return Object.freeze({
    ...row,
    targetId,
    targetRevision,
    targetContentHash,
    planItemId,
    planItemRevision,
    planItemContentHash,
  });
}

function normalizeEffect(raw: unknown): JsonRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      "Stage-D effect spec 必须是显式对象。",
    );
  const row = raw as JsonRecord;
  const roleId = normalizedString(
    row.roleId ?? row.role_id ?? row.role,
    "effect.roleId",
  );
  const action = normalizedString(row.action, "effect.action");
  const effectLogicalKey = normalizedString(
    row.effectLogicalKey ?? row.effect_logical_key ?? row.logicalKey,
    "effectLogicalKey",
  );
  const effectAttemptOrdinal = finiteNumber(
    row.effectAttemptOrdinal ??
      row.effect_attempt_ordinal ??
      row.attemptOrdinal ??
      1,
    "effectAttemptOrdinal",
    1,
  );
  const sinkName = normalizedString(
    row.sinkName ?? row.sink_name,
    "effect.sinkName",
  );
  const sinkRoleId = normalizedString(
    row.sinkRoleId ?? row.sink_role_id ?? roleId,
    "effect.sinkRoleId",
  );
  const sinkContractVersion = normalizedString(
    row.sinkContractVersion ?? row.sink_contract_version ?? "1",
    "effect.sinkContractVersion",
  );
  const deliveryMode = String(
    row.deliveryMode ?? row.delivery_mode ?? "exactly_once",
  ) as "exactly_once" | "at_most_once" | "at_least_once";
  if (!["exactly_once", "at_most_once", "at_least_once"].includes(deliveryMode))
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      `非法 deliveryMode: ${deliveryMode}`,
    );
  return Object.freeze({
    ...row,
    roleId,
    action,
    effectLogicalKey,
    effectAttemptOrdinal,
    sinkName,
    sinkRoleId,
    sinkContractVersion,
    deliveryMode,
  });
}

function stageDFromClaim(stage: Row): JsonRecord {
  const snapshot = jsonObject(stage.snapshot_json);
  return jsonObject(snapshot.stageD ?? snapshot.stage_d);
}

function targetEffectHashes(
  input: JsonRecord,
  stageRequestId: string,
): {
  targets: JsonRecord[];
  effects: JsonRecord[];
  targetSetHash: string;
  effectSetHash: string;
  retryTargetIds: string[];
  effectPreimages: JsonRecord[];
} {
  const explicitTargets = input.targets ?? input.targetSnapshots;
  const hasExplicitTargets =
    explicitTargets !== undefined || input.targetIds !== undefined;
  if (!hasExplicitTargets)
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_REQUIRED",
      "Stage-D 必须携带显式 target 快照；禁止查询实时 inventory。",
    );
  let targets: JsonRecord[];
  if (Array.isArray(explicitTargets))
    targets = explicitTargets.map(normalizeTarget);
  else if (Array.isArray(input.targetIds)) {
    if (input.targetIds.length)
      throw new WorkspaceOrchestratorActorError(
        "TARGET_SNAPSHOT_REQUIRED",
        "targetIds 不能替代 target revision/content hash。",
      );
    targets = [];
  } else targets = [];
  const targetById = new Set<string>();
  for (const target of targets) {
    if (targetById.has(String(target.targetId)))
      throw new WorkspaceOrchestratorActorError(
        "TARGET_SNAPSHOT_STALE",
        `targetId 重复: ${target.targetId}`,
      );
    targetById.add(String(target.targetId));
  }
  const retryTargetIds =
    input.retryTargetIds === undefined
      ? []
      : uniqueStrings(input.retryTargetIds, "retryTargetIds");
  for (const targetId of retryTargetIds)
    if (!targetById.has(targetId))
      throw new WorkspaceOrchestratorActorError(
        "TARGET_SNAPSHOT_STALE",
        `retryTargetId 不在显式 target set: ${targetId}`,
      );
  if (retryTargetIds.length)
    targets = targets.filter((target) =>
      retryTargetIds.includes(String(target.targetId)),
    );
  targets = targets.sort((left, right) =>
    compareCodePoints(String(left.targetId), String(right.targetId)),
  );
  const orderedTargetTriples = targets.map((target) => ({
    targetId: target.targetId,
    targetRevision: target.targetRevision,
    targetContentHash: target.targetContentHash,
    planItemId: target.planItemId,
    planItemRevision: target.planItemRevision,
    planItemContentHash: target.planItemContentHash,
  }));
  const targetSetHash = hashV1({
    r: "target-set/v1",
    workspaceId: String(input.workspaceId),
    cycleId: input.cycleId ?? null,
    orderedTargetTriples,
  });
  if (
    input.targetSetHash !== undefined &&
    String(input.targetSetHash) !== targetSetHash
  )
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      "targetSetHash 与显式 target subset 不一致。",
    );
  const rawEffects = input.effects ?? input.effectSpecs ?? [];
  if (!Array.isArray(rawEffects))
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      "Stage-D effectSpecs 必须是显式数组。",
    );
  let effects = rawEffects.map(normalizeEffect);
  if (!targets.length && effects.length)
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      "无 target 时不得创建 effect。",
    );
  const effectKeys = new Set<string>();
  for (const effect of effects) {
    const key = `${effect.effectLogicalKey}:${effect.effectAttemptOrdinal}`;
    if (effectKeys.has(key))
      throw new WorkspaceOrchestratorActorError(
        "TARGET_SNAPSHOT_STALE",
        `effect logical key 重复: ${key}`,
      );
    effectKeys.add(key);
  }
  effects = effects.sort((left, right) =>
    compareCodePoints(
      `${left.effectLogicalKey}:${left.effectAttemptOrdinal}`,
      `${right.effectLogicalKey}:${right.effectAttemptOrdinal}`,
    ),
  );
  const canonicalEffects = effects.map(
    ({ effectRequestId: _effectRequestId, ...effect }) => effect,
  );
  const effectSetHash = hashV1({
    r: "effect-set/v1",
    workspaceId: String(input.workspaceId),
    stageRequestId,
    targetSetHash,
    orderedEffectSpecs: canonicalEffects,
    coverage: input.coverage ?? null,
  });
  if (
    input.effectSetHash !== undefined &&
    String(input.effectSetHash) !== effectSetHash
  )
    throw new WorkspaceOrchestratorActorError(
      "TARGET_SNAPSHOT_STALE",
      "effectSetHash 与显式 effect specs 不一致。",
    );
  const effectPreimages = effects.map((effect) => ({
    r: "effect/v2",
    workspaceId: String(input.workspaceId),
    orchestrationId: String(input.orchestrationId ?? ""),
    stageRequestId,
    effectLogicalKey: effect.effectLogicalKey,
    effectAttemptOrdinal: effect.effectAttemptOrdinal,
    effectSetHash,
    roleId: effect.roleId,
    sinkName: effect.sinkName,
    sinkContractVersion: effect.sinkContractVersion,
    deliveryMode: effect.deliveryMode,
  }));
  return {
    targets,
    effects,
    targetSetHash,
    effectSetHash,
    retryTargetIds,
    effectPreimages,
  };
}

function effectToken(input: {
  workspaceId: string;
  effectRequestId: string;
  roleId: string;
  sinkName: string;
  sinkContractVersion: string;
  deliveryMode: string;
  payloadHash: string;
}): string {
  return hashV1({
    r: "sink-token/v2",
    workspaceId: input.workspaceId,
    effectRequestId: input.effectRequestId,
    roleId: input.roleId,
    sinkName: input.sinkName,
    sinkContractVersion: input.sinkContractVersion,
    deliveryMode: input.deliveryMode,
    payloadHash: input.payloadHash,
  });
}

function settleOutcome(input: JsonRecord): {
  state: "unknown" | "consumed" | "failed" | "cancelled" | "orphaned";
  requestedStatus: string;
  outcomeHash: string | null;
  outcomeQueryKey: string | null;
  errorJson: string | null;
} {
  const raw = String(input.state ?? input.status ?? "")
    .trim()
    .toLowerCase();
  const requestedStatus = raw || "failed";
  if (raw === "unknown") {
    const queryKey =
      input.outcomeQueryKey === null || input.outcomeQueryKey === undefined
        ? null
        : String(input.outcomeQueryKey);
    if (!queryKey)
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "unknown effect 必须有 outcomeQueryKey。",
      );
    return {
      state: "unknown",
      requestedStatus,
      outcomeHash: input.outcomeHash ? String(input.outcomeHash) : null,
      outcomeQueryKey: queryKey,
      errorJson:
        input.error === undefined ? null : canonicalJsonV1(input.error),
    };
  }
  const state =
    raw === "succeeded" || raw === "success"
      ? "consumed"
      : raw === "partial"
        ? "failed"
        : (raw as "consumed" | "failed" | "cancelled" | "orphaned");
  if (!["consumed", "failed", "cancelled", "orphaned"].includes(state))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `非法 effect settlement state: ${raw}`,
    );
  const outcomeHash =
    input.outcomeHash === null
      ? null
      : input.outcomeHash === undefined
        ? input.outcome === undefined
          ? null
          : hashV1(input.outcome)
        : String(input.outcomeHash);
  if (state === "consumed" && !outcomeHash)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "consumed effect 必须有 outcomeHash 或 outcome。",
    );
  const errorValue =
    input.error === undefined && raw !== "partial"
      ? null
      : (input.error ?? { terminalStatus: raw });
  return {
    state,
    requestedStatus,
    outcomeHash,
    outcomeQueryKey: null,
    errorJson: errorValue === null ? null : canonicalJsonV1(errorValue),
  };
}

export class WorkspaceOrchestratorSnapshotStore {
  private readonly database: DatabaseSync;
  private readonly nowUtc: () => string;
  private readonly nowMono: () => number;
  private readonly crashBarrier?: WorkspaceOrchestratorCrashBarrier;

  constructor(
    database: DatabaseSync,
    options: {
      nowUtc?: () => string;
      nowMono?: () => number;
      crashBarrier?: WorkspaceOrchestratorCrashBarrier;
    } = {},
  ) {
    this.database = database;
    this.nowUtc = options.nowUtc ?? (() => new Date().toISOString());
    this.nowMono = options.nowMono ?? (() => Date.now());
    this.crashBarrier = options.crashBarrier;
  }

  private invokeCrashBarrier(
    bundle: CrashBarrierBundle,
    phase: CrashBarrierPhase,
    context: Omit<CrashBarrierContext, "bundle" | "phase">,
  ): void {
    if (!this.crashBarrier) return;
    invokeWorkspaceOrchestratorCrashBarrier(this.crashBarrier, {
      ...context,
      bundle,
      phase,
    });
  }

  readSourceSnapshot(
    workspaceId: string,
    stageRequestId: string,
  ): SourceSnapshotReadback | null {
    const row = this.database
      .prepare(
        "SELECT * FROM source_snapshots WHERE workspace_id=? AND stage_request_id=?",
      )
      .get(workspaceId, stageRequestId) as Row | undefined;
    return row ? sourceReadback(row) : null;
  }

  readPlanScopeProjection(
    workspaceId: string,
    stageRequestId: string,
  ): PlanScopeProjectionReadback | null {
    const row = this.database
      .prepare(
        "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
      )
      .get(workspaceId, stageRequestId) as Row | undefined;
    return row ? scopeReadback(row) : null;
  }

  archivePlanScope(
    input: ArchivePlanScopeInput,
  ): AnyResult<ArchivedPlanScopeReadback> {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return transaction(this.database, () => {
        const actor = requireActor(
          this.database,
          input as unknown as JsonRecord,
          input.workspaceId,
          pair.mono,
        );
        const row = this.database
          .prepare(
            "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND scope_id=? AND scope_hash=?",
          )
          .get(input.workspaceId, input.scopeId, input.scopeHash) as
          | Row
          | undefined;
        if (!row)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "PlanScope 不存在。",
          );
        const stored = jsonObject(row.scope_json);
        const archive = jsonObject(stored.archive);
        if (String(row.scope_status) === "superseded") {
          if (String(archive.reasonCode ?? "") !== input.reasonCode)
            throw new WorkspaceOrchestratorActorError(
              "SCOPE_ARCHIVED",
              "PlanScope 已由不同原因归档。",
            );
          return {
            ok: true,
            value: Object.freeze({
              ...scopeReadback(row),
              archiveAnchorHash: String(archive.archiveAnchorHash),
              archivedAt: String(archive.archivedAt),
              archiveReasonCode: String(archive.reasonCode),
            }),
            replayed: true,
            readback: scopeReadback(row),
          };
        }
        if (String(row.scope_status) !== "frozen")
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "仅 frozen PlanScope 可归档。",
          );
        const archiveAnchor = {
          r: "plan-scope-archive/v1",
          workspaceId: input.workspaceId,
          scopeId: input.scopeId,
          scopeHash: input.scopeHash,
          rootRequestId: String(row.root_request_id),
          stageRequestId: String(row.stage_request_id),
          sourceSnapshotHash: String(row.source_snapshot_hash),
          bindingHash: row.binding_hash === null ? null : String(row.binding_hash),
          reasonCode: input.reasonCode,
          archivedAt: pair.utc,
        };
        const archiveAnchorHash = hashV1(archiveAnchor);
        insertIdentity(
          this.database,
          input.workspaceId,
          "plan-scope-archive/v1",
          archiveAnchor,
          archiveAnchorHash,
          pair.utc,
        );
        const nextStored = {
          ...stored,
          archive: {
            archiveAnchorHash,
            archivedAt: pair.utc,
            reasonCode: input.reasonCode,
          },
        };
        const updated = this.database
          .prepare(
            "UPDATE daily_plan_scopes SET scope_status='superseded',scope_json=?,updated_at=?,finished_at=COALESCE(finished_at,?) WHERE workspace_id=? AND scope_id=? AND scope_hash=? AND scope_status='frozen'",
          )
          .run(
            canonicalJsonV1(nextStored),
            pair.utc,
            pair.utc,
            input.workspaceId,
            input.scopeId,
            input.scopeHash,
          );
        if (affectedRows(updated) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "PlanScope archive CAS 失败。",
          );
        const nextActor = touchActor(this.database, actor, pair);
        const event = appendEvent(this.database, nextActor, {
          eventType: "plan.scope_archived",
          causationId: archiveAnchorHash,
          rootRequestId: String(row.root_request_id),
          stageRequestId: String(row.stage_request_id),
          scopeHash: input.scopeHash,
          payload: archiveAnchor,
          acceptance: acceptanceFromRow(row, "plan scope"),
          occurredAtUtc: pair.utc,
        });
        const archived = this.database
          .prepare(
            "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND scope_id=?",
          )
          .get(input.workspaceId, input.scopeId) as Row;
        const value = Object.freeze({
          ...scopeReadback(archived),
          archiveAnchorHash,
          archivedAt: pair.utc,
          archiveReasonCode: input.reasonCode,
        });
        return { ok: true, value, replayed: false, readback: { scope: value, event } };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  readStageDTargetEffect(
    workspaceId: string,
    stageRequestId: string,
  ): StageDTargetEffectReadback | null {
    const row = this.database
      .prepare(
        "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
      )
      .get(workspaceId, stageRequestId) as Row | undefined;
    return row && jsonObject(row.snapshot_json).stageD
      ? stageDReadback(row)
      : null;
  }

  readEffectConsumption(input: {
    workspaceId: string;
    consumptionId?: string;
    operationRequestId?: string;
    effectRequestId?: string;
  }): EffectConsumptionReadback | null {
    let row: Row | undefined;
    if (input.consumptionId)
      row = this.database
        .prepare(
          "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND consumption_id=?",
        )
        .get(input.workspaceId, input.consumptionId) as Row | undefined;
    else if (input.operationRequestId && input.effectRequestId)
      row = this.database
        .prepare(
          "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND operation_request_id=? AND effect_request_id=?",
        )
        .get(
          input.workspaceId,
          input.operationRequestId,
          input.effectRequestId,
        ) as Row | undefined;
    return row ? effectReadback(row) : null;
  }

  freezeSourceSnapshot(
    input: FreezeSourceSnapshotInput,
  ): AnyResult<SourceSnapshotReadback> {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return transaction(this.database, () => {
        const actor = requireActor(
          this.database,
          input as unknown as JsonRecord,
          input.workspaceId,
          pair.mono,
        );
        const { root, stage } = requireRootStage(
          this.database,
          input as unknown as JsonRecord,
          actor,
          input.stageRequestId,
          input.rootRequestId,
        );
        const preflight = preflightSnapshot(
          this.database,
          input as unknown as JsonRecord,
        );
        const partition = normalizeSourceChannels(
          input as unknown as JsonRecord,
        );
        const validatedSuccessful = preflightChannelFences(
          this.database,
          input as unknown as JsonRecord,
          partition,
          preflight,
          pair.mono,
        );
        const sourceSelection = normalizeSourceBindings(
          input as unknown as JsonRecord,
        );
        verifyCurrentSources(
          input as unknown as JsonRecord,
          sourceSelection.bindings,
        );
        const successful = validatedSuccessful.map((entry) => {
          const row: SourceChannelPartition &
            Readonly<{
              preflightId: string;
              scanAttemptId: string;
              receiptRevision?: number;
              receiptPayloadHash?: string;
              resultHash?: string;
            }> = {
            ...entry,
            channelId: entry.channelId,
            preflightId: String(entry.preflightId ?? input.preflightId),
            scanAttemptId: String(
              entry.scanAttemptId ??
                input.scanAttemptId ??
                input.stageRequestId,
            ),
            receiptRevision:
              entry.receiptRevision === undefined ||
              entry.receiptRevision === null
                ? undefined
                : finiteNumber(
                    entry.receiptRevision,
                    `${entry.channelId}.receiptRevision`,
                    1,
                  ),
            receiptPayloadHash:
              entry.receiptPayloadHash === undefined ||
              entry.receiptPayloadHash === null
                ? undefined
                : String(entry.receiptPayloadHash),
            resultHash:
              entry.resultHash === undefined || entry.resultHash === null
                ? undefined
                : String(entry.resultHash),
          };
          if (!row.receiptId)
            throw new WorkspaceOrchestratorActorError(
              "SOURCE_SNAPSHOT_STALE",
              `${entry.channelId} 缺少 receiptId。`,
            );
          if (
            row.receiptRevision === undefined ||
            row.receiptPayloadHash === undefined ||
            row.resultHash === undefined
          )
            throw new WorkspaceOrchestratorActorError(
              "SOURCE_SNAPSHOT_STALE",
              `${entry.channelId} receipt provenance 不完整。`,
            );
          return Object.freeze(row);
        });
        const receiptSeed = successful.map((entry) => String(entry.receiptId));
        const receiptData = normalizeReceiptBindings(
          input as unknown as JsonRecord,
          receiptSeed,
        );
        for (const entry of successful) {
          const prior = this.database
            .prepare(
              `SELECT source_snapshots.root_request_id AS root_request_id,
                      json_extract(receipt.value,'$.channelId') AS channel_id
                 FROM source_snapshots, json_each(source_snapshots.successful_channels_json) AS receipt
                WHERE source_snapshots.workspace_id=?
                  AND json_extract(receipt.value,'$.receiptId')=?
                LIMIT 1`,
            )
            .get(input.workspaceId, String(entry.receiptId)) as Row | undefined;
          if (
            prior &&
            (String(prior.root_request_id) !== input.rootRequestId ||
              String(prior.channel_id) !== String(entry.channelId))
          )
            throw new WorkspaceOrchestratorActorError(
              "SOURCE_PROVENANCE_MISMATCH",
              `${entry.receiptId} 不属于当前 root/channel partition。`,
              {
                receiptId: entry.receiptId,
                expectedRootRequestId: input.rootRequestId,
                actualRootRequestId: prior.root_request_id,
                expectedChannelId: entry.channelId,
                actualChannelId: prior.channel_id,
              },
            );
        }
        const orderedSourceBindings = sourceSelection.bindings;
        const watermarkUtc = normalizeUtc(input.watermarkUtc, pair.utc);
        const watermarkMono =
          input.watermarkMono === undefined
            ? pair.mono
            : finiteNumber(input.watermarkMono, "watermarkMono", 0);
        const capturedAtUtc = normalizeUtc(input.capturedAtUtc, pair.utc);
        const selectedChannelPartition = {
          selectedChannelIds: partition.selected,
          successfulChannelIds: successful.map((entry) => entry.channelId),
          failedChannelIds: partition.failed.map((entry) => entry.channelId),
          unresolvedChannelIds: partition.unresolved.map(
            (entry) => entry.channelId,
          ),
        };
        const snapshotHash = hashV1({
          r: "source-snapshot/v1",
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          preflightId: input.preflightId,
          policyHash: input.policyHash,
          selectedChannelPartition,
          successfulReceipts: successful,
          failedChannelPartition: partition.failed,
          unresolvedChannelPartition: partition.unresolved,
          orderedSourceBindings,
          sourceCap: 80,
          watermarkUtc,
          watermarkMono,
        });
        const acceptance = resolveAcceptance(input as unknown as JsonRecord, [
          { row: root, label: "root" },
          { row: stage, label: "stage" },
          { row: preflight, label: "preflight" },
        ]);
        const existing = this.database
          .prepare(
            "SELECT * FROM source_snapshots WHERE workspace_id=? AND stage_request_id=?",
          )
          .get(input.workspaceId, input.stageRequestId) as Row | undefined;
        if (existing) {
          if (String(existing.snapshot_hash) !== snapshotHash)
            return failure(
              "SOURCE_SNAPSHOT_STALE",
              "同一 stage 已冻结不同 source snapshot。",
              sourceReadback(existing),
            );
          if (
            !sameAcceptance(
              acceptanceFromRow(existing, "source snapshot"),
              acceptance,
            )
          )
            throw new WorkspaceOrchestratorActorError(
              "ACCEPTANCE_PROVENANCE_CONFLICT",
              "source snapshot replay provenance 不一致。",
            );
          return {
            ok: true,
            value: sourceReadback(existing),
            replayed: true,
            readback: sourceReadback(existing),
          };
        }
        const byHash = this.database
          .prepare(
            "SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?",
          )
          .get(input.workspaceId, snapshotHash) as Row | undefined;
        if (byHash && String(byHash.stage_request_id) !== input.stageRequestId)
          return failure(
            "SOURCE_SNAPSHOT_STALE",
            "snapshot hash 已绑定另一 stage identity。",
            sourceReadback(byHash),
          );
        insertIdentity(
          this.database,
          input.workspaceId,
          "source-snapshot/v1",
          {
            r: "source-snapshot/v1",
            workspaceId: input.workspaceId,
            rootRequestId: input.rootRequestId,
            stageRequestId: input.stageRequestId,
            preflightId: input.preflightId,
            policyHash: input.policyHash,
            selectedChannelPartition,
            successfulReceipts: successful,
            failedChannelPartition: partition.failed,
            unresolvedChannelPartition: partition.unresolved,
            orderedSourceBindings,
            sourceCap: 80,
            watermarkUtc,
            watermarkMono,
          },
          snapshotHash,
          capturedAtUtc,
        );
        this.invokeCrashBarrier("T4", "identity_registry", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          requestId: input.rootRequestId,
          phaseBoundary: "identity_registry",
        });
        this.database
          .prepare(
            `INSERT INTO source_snapshots (
          snapshot_id,workspace_id,business_date,source_task_id,root_request_id,root_generation,stage_request_id,scan_attempt_id,
          preflight_id,policy_hash,profile_revision,selected_channel_ids_json,successful_channels_json,failed_channels_json,
          unresolved_channels_json,source_ids_json,source_bindings_json,receipt_ids_json,receipt_bindings_json,watermark_utc,watermark_mono,
          captured_at_utc,excluded_by_budget_count,snapshot_hash,status,acceptance_run_id,baseline_event_sequence,baseline_checkpoint_revision,
          created_after_event_sequence,created_after_checkpoint_revision,created_after_mono
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'frozen',?,?,?,?,?,?)`,
          )
          .run(
            snapshotHash,
            input.workspaceId,
            String(root.business_date),
            input.sourceTaskId ?? null,
            input.rootRequestId,
            input.rootGeneration,
            input.stageRequestId,
            input.scanAttemptId ?? input.stageRequestId,
            input.preflightId,
            input.policyHash,
            input.profileRevision,
            canonicalJsonV1(partition.selected),
            canonicalJsonV1(successful),
            canonicalJsonV1(partition.failed),
            canonicalJsonV1(partition.unresolved),
            canonicalJsonV1(sourceSelection.sourceIds),
            canonicalJsonV1(orderedSourceBindings),
            canonicalJsonV1(receiptData.ids),
            canonicalJsonV1(receiptData.map),
            watermarkUtc,
            watermarkMono,
            capturedAtUtc,
            sourceSelection.excludedByBudgetCount,
            snapshotHash,
            acceptance[0],
            acceptance[1],
            acceptance[2],
            acceptance[3],
            acceptance[4],
            acceptance[5],
          );
        const snapshotRow = this.database
          .prepare(
            "SELECT * FROM source_snapshots WHERE workspace_id=? AND stage_request_id=?",
          )
          .get(input.workspaceId, input.stageRequestId) as Row;
        const snapshot = sourceReadback(snapshotRow);
        const nextActor = touchActor(this.database, actor, pair);
        const nextStage = updateStage(
          this.database,
          nextActor,
          stage,
          "snapshot_frozen",
          canonicalJsonV1(snapshot),
          null,
          pair.utc,
          false,
        );
        const nextRootRevision = numberOr(root.checkpoint_revision, 0) + 1;
        const rootUpdate = this.database
          .prepare(
            `UPDATE daily_orchestration_roots SET checkpoint_revision=?,last_business_progress_at=?,updated_at=?
          WHERE workspace_id=? AND root_request_id=? AND checkpoint_revision=? AND owner_epoch=? AND lease_token=? AND status IN ('created','running')`,
          )
          .run(
            nextRootRevision,
            pair.utc,
            pair.utc,
            input.workspaceId,
            input.rootRequestId,
            numberOr(root.checkpoint_revision, 0),
            nextActor.ownerEpoch,
            nextActor.leaseToken,
          );
        if (affectedRows(rootUpdate) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "source freeze root CAS 失败。",
          );
        const nextIntent = readIntent(this.database, root);
        if (
          nextIntent &&
          ["admitted", "running"].includes(String(nextIntent.status))
        )
          this.database
            .prepare(
              `UPDATE orchestrator_intents SET status='running',checkpoint_revision=checkpoint_revision+1,updated_at=? WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=?`,
            )
            .run(
              pair.utc,
              input.workspaceId,
              String(nextIntent.intent_id),
              numberOr(nextIntent.checkpoint_revision, 0),
            );
        this.invokeCrashBarrier("T4", "business_rows", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "business_rows",
        });
        const refreshedRoot = this.database
          .prepare(
            "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
          )
          .get(input.workspaceId, input.rootRequestId) as Row;
        updateIndex(this.database, refreshedRoot, nextIntent, {
          status: String(refreshedRoot.status),
          isActive: 1,
          stageRequestId: input.stageRequestId,
          projectionState: "absent",
          checkpointRevision: numberOr(refreshedRoot.checkpoint_revision, 0),
          nowUtc: pair.utc,
          expectedIndexRevision: input.expectedIndexRevision as
            number | undefined,
        });
        this.invokeCrashBarrier("T4", "checkpoint_index", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "checkpoint_index",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType: "source.snapshot_frozen",
          causationId: hashV1({
            r: "source-snapshot-event/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            snapshotHash,
          }),
          payload: {
            ...stageIdentityFromRow(nextStage),
            snapshotHash,
            sourceIds: snapshot.sourceIds,
            excludedByBudgetCount: sourceSelection.excludedByBudgetCount,
          },
          occurredAtUtc: pair.utc,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId: root.intent_id === null ? null : String(root.intent_id),
          rootRequestId: input.rootRequestId,
          rootGeneration: input.rootGeneration,
          orchestrationId: String(root.orchestration_id),
          managerTaskId: String(root.manager_task_id),
          stageRequestId: input.stageRequestId,
          snapshotHash,
          aggregateId: input.rootRequestId,
        });
        this.invokeCrashBarrier("T4", "event_outbox", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "event_outbox",
        });
        return {
          ok: true,
          value: snapshot,
          replayed: false,
          readback: { snapshot, stage: nextStage, root: refreshedRoot, event },
        };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  freezePlanScopeProjection(
    input: FreezePlanScopeProjectionInput,
  ): AnyResult<PlanScopeProjectionReadback> {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return transaction(this.database, () => {
        const actor = requireActor(
          this.database,
          input as unknown as JsonRecord,
          input.workspaceId,
          pair.mono,
        );
        const { root, stage } = requireRootStage(
          this.database,
          input as unknown as JsonRecord,
          actor,
          input.stageRequestId,
          input.rootRequestId,
        );
        const sourceRow = this.database
          .prepare(
            "SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?",
          )
          .get(input.workspaceId, input.sourceSnapshotHash) as Row | undefined;
        if (!sourceRow || String(sourceRow.status) !== "frozen")
          throw new WorkspaceOrchestratorActorError(
            "SOURCE_SNAPSHOT_STALE",
            "PlanScope 只允许引用 frozen source snapshot。",
          );
        const rawSuccessorOrdinal =
          input.evidenceSuccessorOrdinal ?? input.successorOrdinal;
        const successorOrdinal =
          rawSuccessorOrdinal === undefined
            ? 0
            : acceptanceNumber(rawSuccessorOrdinal, "successorOrdinal");
        const rawMaxSuccessors = input.maxEvidenceSuccessors;
        const requestedMaxSuccessors =
          rawMaxSuccessors === undefined
            ? 2
            : acceptanceNumber(rawMaxSuccessors, "maxEvidenceSuccessors");
        const maxSuccessors = Math.min(2, requestedMaxSuccessors);
        if (successorOrdinal > maxSuccessors || successorOrdinal > 2)
          throw new WorkspaceOrchestratorActorError(
            "EVIDENCE_SUCCESSOR_LIMIT",
            "evidence successor 已达到硬上限 2。",
          );
        if (
          input.progressMeasureVersion !== undefined &&
          acceptanceNumber(
            input.progressMeasureVersion,
            "progressMeasureVersion",
          ) !== 2
        )
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "progressMeasureVersion 必须为 2。",
          );
        if (
          input.progressOrdinal !== undefined &&
          acceptanceNumber(input.progressOrdinal, "progressOrdinal") !==
            successorOrdinal
        )
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "progressOrdinal 必须与 successorOrdinal 连续一致。",
          );
        const stageMetadata = jsonObject(stage.snapshot_json);
        const stageFamily = String(
          stageMetadata.stageFamily ??
            stageMetadata.stage_family ??
            (successorOrdinal > 0 ? "evidence_successor" : ""),
        );
        const sourceStageRequestId = String(sourceRow.stage_request_id);
        if (sourceStageRequestId !== input.stageRequestId) {
          if (stageFamily !== "evidence_successor" || successorOrdinal < 1)
            throw new WorkspaceOrchestratorActorError(
              "SOURCE_SNAPSHOT_STALE",
              "普通 stage 不得复用其他 stage 的 source snapshot。",
            );
          const expectedSourceStage = String(
            input.sourceSnapshotStageRequestId ??
              stageMetadata.sourceSnapshotStageRequestId ??
              stageMetadata.source_snapshot_stage_request_id ??
              stageMetadata.predecessorStageRequestId ??
              stageMetadata.predecessor_stage_request_id ??
              "",
          );
          if (
            !expectedSourceStage ||
            expectedSourceStage !== sourceStageRequestId
          )
            throw new WorkspaceOrchestratorActorError(
              "SOURCE_SNAPSHOT_STALE",
              "successor source snapshot predecessor stage 不一致。",
            );
        }
        assertCurrentSourceLineage(
          this.database,
          sourceRow,
          root,
          sourceStageRequestId,
        );
        const source = sourceReadback(sourceRow);

        const rawRepair =
          input.repair &&
          typeof input.repair === "object" &&
          !Array.isArray(input.repair)
            ? (input.repair as JsonRecord)
            : {};
        const rawRepairItems =
          input.repairItems ?? rawRepair.items ?? rawRepair.repairedItems;
        const hasRepairBinding =
          Array.isArray(rawRepairItems) && rawRepairItems.length > 0;
        let repair: RepairBindingResult = hasRepairBinding
          ? repairBinding(
              this.database,
              input as unknown as JsonRecord,
              source,
              pair.utc,
              false,
            )
          : {
              bindingKind: "initial_source",
              repairSnapshotId: null,
              repairSnapshotHash: null,
              bindingHash: null,
              repairRow: null,
              predecessorRow: null,
            };
        let predecessor = repair.predecessorRow;
        if (successorOrdinal > 0) {
          const predecessorScopeId = normalizedString(
            input.predecessorScopeId ??
              rawRepair.predecessorScopeId ??
              rawRepair.predecessor_scope_id,
            "predecessorScopeId",
          );
          const predecessorScopeHash = normalizedString(
            input.predecessorScopeHash ??
              rawRepair.predecessorScopeHash ??
              rawRepair.predecessor_scope_hash,
            "predecessorScopeHash",
          );
          const queried = this.database
            .prepare(
              "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND scope_id=? AND scope_hash=?",
            )
            .get(
              input.workspaceId,
              predecessorScopeId,
              predecessorScopeHash,
            ) as Row | undefined;
          if (!queried)
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor predecessor scope 不存在。",
            );
          if (String(queried.scope_status) === "superseded")
            throw new WorkspaceOrchestratorActorError(
              "SCOPE_ARCHIVED",
              "successor predecessor scope 已归档。",
              { predecessorScopeId, predecessorScopeHash },
            );
          if (String(queried.scope_status) !== "frozen")
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor predecessor scope 未 frozen。",
            );
          if (
            predecessor &&
            (String(predecessor.scope_id) !== predecessorScopeId ||
              String(predecessor.scope_hash) !== predecessorScopeHash)
          )
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor predecessor scope identity 不一致。",
            );
          predecessor = queried;
          assertSuccessorPredecessorLineage(this.database, predecessor, root);
          const predecessorProgress = progressStateFromScope(predecessor);
          if (!predecessorProgress)
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor predecessor 缺少 progressMeasure v2。",
            );
          if (
            successorOrdinal > 1 &&
            (predecessorProgress.progressOrdinal !== successorOrdinal - 1 ||
              !predecessorProgress.strictProgress)
          )
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor predecessor progressOrdinal/strictProgress 链无效。",
            );
        }
        const acceptance = resolveAcceptance(input as unknown as JsonRecord, [
          { row: root, label: "root" },
          { row: stage, label: "stage" },
          { row: sourceRow, label: "source snapshot" },
          { row: predecessor, label: "predecessor scope" },
          { row: repair.repairRow, label: "repair binding" },
        ]);
        const normalizedInput = {
          ...(input as unknown as JsonRecord),
          ...acceptanceObject(acceptance),
          acceptance: acceptanceObject(acceptance),
          bindingKind: repair.bindingKind,
          repairSnapshotId: repair.repairSnapshotId,
          repairSnapshotHash: repair.repairSnapshotHash,
          bindingHash: repair.bindingHash,
        };
        const plan = normalizePlanProjection(normalizedInput, source, root);
        const progress = progressStateFor(
          normalizedInput,
          plan,
          predecessor,
          successorOrdinal,
        );
        const progressProjection = Object.freeze({
          ...plan.projection,
          progressMeasureVersion: progress.progressMeasureVersion,
          progressOrdinal: progress.progressOrdinal,
          progressBefore: progress.progressBefore,
          progressAfter: progress.progressAfter,
          strictProgress: progress.strictProgress,
        });
        const progressNextAction = {
          ...plan.nextAction,
          progressMeasureVersion: progress.progressMeasureVersion,
          progressOrdinal: progress.progressOrdinal,
          progressBefore: progress.progressBefore,
          progressAfter: progress.progressAfter,
          strictProgress: progress.strictProgress,
        };
        if (successorOrdinal > 0 && !progress.strictProgress) {
          return failure(
            "NO_BUSINESS_PROGRESS",
            "successor 未产生 strict business progress；不创建新的 scope/claim/dispatch/event。",
            {
              progressMeasureVersion: progress.progressMeasureVersion,
              progressOrdinal: progress.progressOrdinal,
              progressBefore: progress.progressBefore,
              progressAfter: progress.progressAfter,
              strictProgress: false,
              projection: progressProjection,
              nextAction: {
                ...progressNextAction,
                reasonCode: "NO_BUSINESS_PROGRESS",
              },
            },
          );
        }
        const existing = this.database
          .prepare(
            "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
          )
          .get(input.workspaceId, input.stageRequestId) as Row | undefined;
        if (existing) {
          if (String(existing.scope_hash) !== String(plan.scope.scopeHash))
            return failure(
              "SCOPE_HASH_IMMUTABLE",
              "同一 stage 已冻结不同 PlanScope。",
              scopeReadback(existing),
            );
          if (
            !sameAcceptance(
              acceptanceFromRow(existing, "plan scope"),
              acceptance,
            )
          )
            throw new WorkspaceOrchestratorActorError(
              "ACCEPTANCE_PROVENANCE_CONFLICT",
              "PlanScope replay provenance 不一致。",
            );
          const existingProgress = progressStateFromScope(existing);
          if (
            existingProgress &&
            !sameProgressState(existingProgress, progress)
          )
            return failure(
              "SCOPE_HASH_IMMUTABLE",
              "同一 stage 已冻结不同 progressMeasure。",
              scopeReadback(existing),
            );
          if (String(existing.scope_status) === "frozen")
            return {
              ok: true,
              value: scopeReadback(existing),
              replayed: true,
              readback: scopeReadback(existing),
            };
        }
        if (hasRepairBinding && repair.repairRow === null)
          repair = repairBinding(
            this.database,
            input as unknown as JsonRecord,
            source,
            pair.utc,
            true,
          );
        const scopeId = hashV1({
          r: "plan-scope-id/v1",
          workspaceId: input.workspaceId,
          stageRequestId: input.stageRequestId,
          scopeHash: plan.scope.scopeHash,
        });
        insertIdentity(
          this.database,
          input.workspaceId,
          "plan-scope-id/v1",
          {
            r: "plan-scope-id/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            scopeHash: plan.scope.scopeHash,
          },
          scopeId,
          pair.utc,
        );
        insertIdentity(
          this.database,
          input.workspaceId,
          "plan-scope/v1",
          {
            r: "plan-scope/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            rootRequestId: input.rootRequestId,
            sourceSnapshotHash: input.sourceSnapshotHash,
            bindingHash: plan.scope.bindingHash,
            orderedAllowedPlanIds: plan.scope.allowedPlanIds,
            orderedAllowedItemIds: plan.scope.allowedPlanItemIds,
            orderedCarryItemIds: plan.scope.carryPlanItemIds,
            trustedReceiptIds: plan.scope.trustedReceiptIds,
            scopeJson: plan.scope,
          },
          String(plan.scope.scopeHash),
          pair.utc,
        );
        const eligibleIdsHash = hashV1({
          r: "eligible-ids/v1",
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          scopeHash: String(plan.scope.scopeHash),
          projectionHash: String(plan.projection.projectionHash),
          orderedEligiblePlanItemIds: plan.classification.eligible,
        });
        insertIdentity(
          this.database,
          input.workspaceId,
          "projection/v2",
          {
            r: "projection/v2",
            workspaceId: plan.projection.workspaceId,
            businessDate: plan.projection.businessDate,
            managerTaskId: plan.projection.managerTaskId,
            orchestrationId: plan.projection.orchestrationId,
            stageRequestId: plan.projection.stageRequestId,
            scopeHash: plan.scope.scopeHash,
            bindingHash: plan.scope.bindingHash,
            repairSnapshotHash: plan.scope.repairSnapshotHash,
            planIds: plan.projection.planIds,
            asOf: plan.projection.asOf,
            orderedEntries: plan.projection.entries,
            candidatePlanItemIds: plan.classification.candidate,
            eligiblePlanItemIds: plan.classification.eligible,
            pendingPlanItemIds: plan.classification.pending,
            invalidPlanItemIds: plan.classification.invalid,
            trustedReceiptIds: plan.projection.trustedReceiptIds,
            emptyQualified: plan.emptyQualified,
          },
          String(plan.projection.projectionHash),
          pair.utc,
        );
        insertIdentity(
          this.database,
          input.workspaceId,
          "eligible-ids/v1",
          {
            r: "eligible-ids/v1",
            workspaceId: input.workspaceId,
            rootRequestId: input.rootRequestId,
            stageRequestId: input.stageRequestId,
            scopeHash: String(plan.scope.scopeHash),
            projectionHash: String(plan.projection.projectionHash),
            orderedEligiblePlanItemIds: plan.classification.eligible,
          },
          eligibleIdsHash,
          pair.utc,
        );
        this.invokeCrashBarrier("T6", "identity_registry", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          requestId: input.rootRequestId,
          phaseBoundary: "identity_registry",
        });
        const storedScope = {
          scope: plan.scope,
          projection: progressProjection,
          progress,
        };
        const nextActor = touchActor(this.database, actor, pair);
        const stageCurrent = existing ?? stage;
        let scopeRow: Row;
        if (!existing) {
          this.database
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
              input.workspaceId,
              input.stageRequestId,
              input.rootRequestId,
              input.rootGeneration,
              input.rootInputHash,
              input.managerTaskId ?? String(root.manager_task_id),
              input.orchestrationId ?? String(root.orchestration_id),
              input.attemptStage ?? String(stage.attempt_stage),
              numberOr(stage.claim_revision, 0),
              nextActor.ownerEpoch,
              nextActor.leaseToken,
              String(root.lease_expires_at_utc),
              numberOr(root.lease_expires_at_mono, 0),
              input.sourceSnapshotHash,
              repair.bindingKind,
              repair.repairSnapshotId,
              repair.repairSnapshotHash,
              repair.bindingHash,
              canonicalJsonV1(plan.scope.allowedPlanIds),
              canonicalJsonV1(plan.scope.allowedPlanItemIds),
              canonicalJsonV1(plan.scope.carryPlanItemIds),
              canonicalJsonV1(plan.scope.trustedReceiptIds),
              "building",
              canonicalJsonV1(storedScope),
              String(plan.scope.scopeHash),
              acceptance[0],
              acceptance[1],
              acceptance[2],
              acceptance[3],
              acceptance[4],
              acceptance[5],
              pair.utc,
              pair.utc,
              null,
              null,
            );
          const building = this.database
            .prepare(
              "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
            )
            .get(input.workspaceId, input.stageRequestId) as Row;
          const freeze = this.database
            .prepare(
              `UPDATE daily_plan_scopes SET scope_status='frozen',frozen_at=?,finished_at=?,updated_at=?
            WHERE workspace_id=? AND stage_request_id=? AND scope_status='building' AND scope_hash=?`,
            )
            .run(
              pair.utc,
              pair.utc,
              pair.utc,
              input.workspaceId,
              input.stageRequestId,
              String(plan.scope.scopeHash),
            );
          if (affectedRows(freeze) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "PlanScope freeze CAS 失败。",
            );
          scopeRow = this.database
            .prepare(
              "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
            )
            .get(input.workspaceId, input.stageRequestId) as Row;
          void building;
        } else {
          const update = this.database
            .prepare(
              `UPDATE daily_plan_scopes SET scope_json=?,scope_status='frozen',frozen_at=?,finished_at=?,updated_at=?,
            acceptance_run_id=COALESCE(?,acceptance_run_id),baseline_event_sequence=COALESCE(?,baseline_event_sequence),baseline_checkpoint_revision=COALESCE(?,baseline_checkpoint_revision),
            created_after_event_sequence=COALESCE(?,created_after_event_sequence),created_after_checkpoint_revision=COALESCE(?,created_after_checkpoint_revision),created_after_mono=COALESCE(?,created_after_mono)
            WHERE workspace_id=? AND stage_request_id=? AND scope_status='building' AND scope_hash=?`,
            )
            .run(
              canonicalJsonV1(storedScope),
              pair.utc,
              pair.utc,
              pair.utc,
              acceptance[0],
              acceptance[1],
              acceptance[2],
              acceptance[3],
              acceptance[4],
              acceptance[5],
              input.workspaceId,
              input.stageRequestId,
              String(plan.scope.scopeHash),
            );
          if (affectedRows(update) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "existing building PlanScope freeze CAS 失败。",
            );
          scopeRow = this.database
            .prepare(
              "SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND stage_request_id=?",
            )
            .get(input.workspaceId, input.stageRequestId) as Row;
        }
        this.invokeCrashBarrier("T6", "business_rows", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "business_rows",
        });
        const storedStageSnapshot = {
          ...jsonObject(stageCurrent.snapshot_json),
          ...storedScope,
        };
        const nextStage = updateStage(
          this.database,
          nextActor,
          stageCurrent,
          plan.stageStatus,
          canonicalJsonV1(storedStageSnapshot),
          canonicalJsonV1({
            projection: progressProjection,
            reasonCode: plan.reasonCode,
            nextAction: progressNextAction,
          }),
          pair.utc,
          true,
        );
        const settlement = updateRootAndIntent(
          this.database,
          nextActor,
          root,
          readIntent(this.database, root),
          plan.rootStatus,
          progressNextAction,
          plan.reasonCode,
          pair.utc,
        );
        const index = updateIndex(
          this.database,
          settlement.root,
          settlement.intent,
          {
            status: plan.rootStatus,
            isActive:
              plan.rootStatus === "running" ||
              plan.rootStatus === "waiting_owner"
                ? 1
                : 0,
            stageRequestId: input.stageRequestId,
            projectionState: "frozen",
            scopeHash: String(plan.scope.scopeHash),
            projectionHash: String(plan.projection.projectionHash),
            eligibleIdsHash,
            nextAction: progressNextAction,
            terminalReason: plan.reasonCode,
            checkpointRevision: numberOr(
              settlement.root.checkpoint_revision,
              0,
            ),
            expectedIndexRevision: input.expectedIndexRevision,
            nowUtc: pair.utc,
          },
        );
        this.invokeCrashBarrier("T6", "checkpoint_index", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "checkpoint_index",
        });
        const settlementHash = hashV1({
          r: "settlement/v1",
          workspaceId: input.workspaceId,
          stageRequestId: input.stageRequestId,
          orderedTerminalResults: [
            {
              stageStatus: plan.stageStatus,
              rootStatus: plan.rootStatus,
              reasonCode: plan.reasonCode,
              progress,
            },
          ],
          consumptionResults: [],
          projectionHash: plan.projection.projectionHash,
          effectSetHash: null,
        });
        insertIdentity(
          this.database,
          input.workspaceId,
          "settlement/v1",
          {
            r: "settlement/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            orderedTerminalResults: [
              {
                stageStatus: plan.stageStatus,
                rootStatus: plan.rootStatus,
                reasonCode: plan.reasonCode,
                progress,
              },
            ],
            consumptionResults: [],
            projectionHash: plan.projection.projectionHash,
            effectSetHash: null,
          },
          settlementHash,
          pair.utc,
        );
        const event = appendEvent(this.database, nextActor, {
          eventType: "plan.scope_projection_frozen",
          causationId: hashV1({
            r: "scope-projection-event/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            scopeHash: plan.scope.scopeHash,
            projectionHash: plan.projection.projectionHash,
          }),
          payload: {
            stageRequestId: input.stageRequestId,
            scopeHash: plan.scope.scopeHash,
            projectionHash: plan.projection.projectionHash,
            eligiblePlanItemIds: plan.classification.eligible,
            pendingPlanItemIds: plan.classification.pending,
            invalidPlanItemIds: plan.classification.invalid,
            rootStatus: plan.rootStatus,
            reasonCode: plan.reasonCode,
            nextAction: progressNextAction,
            progress,
            settlementHash,
          },
          occurredAtUtc: pair.utc,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId:
            root.intent_id === null || root.intent_id === undefined
              ? null
              : String(root.intent_id),
          rootRequestId: input.rootRequestId,
          rootGeneration: input.rootGeneration,
          orchestrationId: String(root.orchestration_id),
          managerTaskId: String(root.manager_task_id),
          stageRequestId: input.stageRequestId,
          scopeHash: String(plan.scope.scopeHash),
          projectionHash: String(plan.projection.projectionHash),
          aggregateId: input.rootRequestId,
        });
        this.invokeCrashBarrier("T6", "event_outbox", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "event_outbox",
        });
        const readback = scopeReadback(scopeRow);
        return {
          ok: true,
          value: readback,
          replayed: false,
          readback: {
            scope: readback,
            stage: nextStage,
            root: settlement.root,
            intent: settlement.intent,
            index,
            event,
            settlementHash,
          },
        };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  freezeStageDTargetEffect(
    input: FreezeStageDTargetEffectInput,
  ): AnyResult<StageDTargetEffectReadback> {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return transaction(this.database, () => {
        const actor = requireActor(
          this.database,
          input as unknown as JsonRecord,
          input.workspaceId,
          pair.mono,
        );
        const { root, stage } = requireRootStage(
          this.database,
          input as unknown as JsonRecord,
          actor,
          input.stageRequestId,
          input.rootRequestId,
        );
        const hashes = targetEffectHashes(
          input as unknown as JsonRecord,
          input.stageRequestId,
        );
        const acceptance = resolveAcceptance(input as unknown as JsonRecord, [
          { row: root, label: "root" },
          { row: stage, label: "stage" },
        ]);
        const existingStageD = stageDFromClaim(stage);
        if (Object.keys(existingStageD).length) {
          if (
            String(existingStageD.targetSetHash) !== hashes.targetSetHash ||
            String(existingStageD.effectSetHash) !== hashes.effectSetHash
          )
            return failure(
              "TARGET_SNAPSHOT_STALE",
              "同一 Stage-D claim 已绑定不同 target/effect snapshot。",
              stageDReadback(stage),
            );
          if (!sameAcceptance(acceptanceFromRow(stage, "stage D"), acceptance))
            throw new WorkspaceOrchestratorActorError(
              "ACCEPTANCE_PROVENANCE_CONFLICT",
              "Stage-D replay provenance 不一致。",
            );
          return {
            ok: true,
            value: stageDReadback(stage),
            replayed: true,
            readback: stageDReadback(stage),
          };
        }
        const orderedSpecs = hashes.effects.map((effect, index) => ({
          ...effect,
          effectRequestId: hashV1({ ...hashes.effectPreimages[index] }),
        }));
        for (const [index, effect] of orderedSpecs.entries())
          insertIdentity(
            this.database,
            input.workspaceId,
            "effect/v2",
            hashes.effectPreimages[index],
            String(effect.effectRequestId),
            pair.utc,
          );
        insertIdentity(
          this.database,
          input.workspaceId,
          "target-set/v1",
          {
            r: "target-set/v1",
            workspaceId: input.workspaceId,
            cycleId: input.cycleId ?? null,
            orderedTargetTriples: hashes.targets.map((target) => ({
              targetId: target.targetId,
              targetRevision: target.targetRevision,
              targetContentHash: target.targetContentHash,
              planItemId: target.planItemId,
              planItemRevision: target.planItemRevision,
              planItemContentHash: target.planItemContentHash,
            })),
          },
          hashes.targetSetHash,
          pair.utc,
        );
        insertIdentity(
          this.database,
          input.workspaceId,
          "effect-set/v1",
          {
            r: "effect-set/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            targetSetHash: hashes.targetSetHash,
            orderedEffectSpecs: hashes.effects.map(
              ({ effectRequestId: _id, ...effect }) => effect,
            ),
            coverage: input.coverage ?? null,
          },
          hashes.effectSetHash,
          pair.utc,
        );
        this.invokeCrashBarrier("T6", "identity_registry", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          requestId: input.rootRequestId,
          phaseBoundary: "identity_registry",
        });
        const stageD = {
          version: "StageDTargetEffectSnapshotV1",
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          rootGeneration: input.rootGeneration,
          rootInputHash: input.rootInputHash,
          stageRequestId: input.stageRequestId,
          cycleId: input.cycleId ?? null,
          retryTargetIds: hashes.retryTargetIds,
          targets: hashes.targets,
          effects: orderedSpecs,
          targetSetHash: hashes.targetSetHash,
          effectSetHash: hashes.effectSetHash,
          coverage: input.coverage ?? null,
          projectionHash: null,
          targetCount: hashes.targets.length,
          effectCount: orderedSpecs.length,
        };
        const nextActor = touchActor(this.database, actor, pair);
        if (!hashes.targets.length) {
          const terminalStage = updateStage(
            this.database,
            nextActor,
            stage,
            "skipped",
            canonicalJsonV1({ stageD }),
            canonicalJsonV1({ reasonCode: "NO_CURRENT_TARGETS", stageD }),
            pair.utc,
            true,
          );
          const intent = readIntent(this.database, root);
          const scheduler = String(root.root_mode) === "scheduler";
          const rootStatus = scheduler ? "succeeded" : "partial";
          const nextAction = {
            kind: "no_action",
            reasonCode: "NO_CURRENT_TARGETS",
          };
          const settlement = updateRootAndIntent(
            this.database,
            nextActor,
            root,
            intent,
            rootStatus,
            nextAction,
            "NO_CURRENT_TARGETS",
            pair.utc,
          );
          this.invokeCrashBarrier("T6", "business_rows", {
            workspaceId: input.workspaceId,
            rootRequestId: input.rootRequestId,
            stageRequestId: input.stageRequestId,
            phaseBoundary: "business_rows",
          });
          const index = updateIndex(
            this.database,
            settlement.root,
            settlement.intent,
            {
              status: rootStatus,
              isActive: 0,
              stageRequestId: input.stageRequestId,
              projectionState: scheduler ? "not_applicable" : "absent",
              scopeHash: null,
              projectionHash: null,
              eligibleIdsHash: null,
              nextAction,
              terminalReason: "NO_CURRENT_TARGETS",
              checkpointRevision: numberOr(
                settlement.root.checkpoint_revision,
                0,
              ),
              expectedIndexRevision: input.expectedIndexRevision,
              nowUtc: pair.utc,
            },
          );
          this.invokeCrashBarrier("T6", "checkpoint_index", {
            workspaceId: input.workspaceId,
            rootRequestId: input.rootRequestId,
            stageRequestId: input.stageRequestId,
            phaseBoundary: "checkpoint_index",
          });
          const settlementHash = hashV1({
            r: "settlement/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            orderedTerminalResults: [
              { status: "skipped", reasonCode: "NO_CURRENT_TARGETS" },
            ],
            consumptionResults: [],
            projectionHash: null,
            effectSetHash: hashes.effectSetHash,
          });
          insertIdentity(
            this.database,
            input.workspaceId,
            "settlement/v1",
            {
              r: "settlement/v1",
              workspaceId: input.workspaceId,
              stageRequestId: input.stageRequestId,
              orderedTerminalResults: [
                { status: "skipped", reasonCode: "NO_CURRENT_TARGETS" },
              ],
              consumptionResults: [],
              projectionHash: null,
              effectSetHash: hashes.effectSetHash,
            },
            settlementHash,
            pair.utc,
          );
          const event = appendEvent(this.database, nextActor, {
            eventType: "stage_d.no_current_targets",
            causationId: hashV1({
              r: "stage-d-event/v1",
              workspaceId: input.workspaceId,
              stageRequestId: input.stageRequestId,
              effectSetHash: hashes.effectSetHash,
            }),
            payload: {
              stageD,
              reasonCode: "NO_CURRENT_TARGETS",
              rootStatus,
              settlementHash,
            },
            occurredAtUtc: pair.utc,
            businessDate: String(root.business_date),
            source: String(root.source),
            intentId: root.intent_id === null ? null : String(root.intent_id),
            rootRequestId: input.rootRequestId,
            rootGeneration: input.rootGeneration,
            orchestrationId: String(root.orchestration_id),
            managerTaskId: String(root.manager_task_id),
            stageRequestId: input.stageRequestId,
            aggregateId: input.rootRequestId,
          });
          this.invokeCrashBarrier("T6", "event_outbox", {
            workspaceId: input.workspaceId,
            rootRequestId: input.rootRequestId,
            stageRequestId: input.stageRequestId,
            phaseBoundary: "event_outbox",
          });
          const readback = stageDReadback(terminalStage);
          return {
            ok: true,
            value: readback,
            replayed: false,
            readback: {
              stage: readback,
              root: settlement.root,
              intent: settlement.intent,
              index,
              event,
              settlementHash,
            },
          };
        }
        const stageSnapshot = { ...jsonObject(stage.snapshot_json), stageD };
        const frozenStage = updateStage(
          this.database,
          nextActor,
          stage,
          "snapshot_frozen",
          canonicalJsonV1(stageSnapshot),
          null,
          pair.utc,
          false,
        );
        const nextRootRevision = numberOr(root.checkpoint_revision, 0) + 1;
        const rootUpdate = this.database
          .prepare(
            `UPDATE daily_orchestration_roots SET checkpoint_revision=?,last_business_progress_at=?,updated_at=?
          WHERE workspace_id=? AND root_request_id=? AND checkpoint_revision=? AND owner_epoch=? AND lease_token=? AND status IN ('created','running')`,
          )
          .run(
            nextRootRevision,
            pair.utc,
            pair.utc,
            input.workspaceId,
            input.rootRequestId,
            numberOr(root.checkpoint_revision, 0),
            nextActor.ownerEpoch,
            nextActor.leaseToken,
          );
        if (affectedRows(rootUpdate) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "Stage-D target freeze root CAS 失败。",
          );
        this.invokeCrashBarrier("T6", "business_rows", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "business_rows",
        });
        const refreshedRoot = this.database
          .prepare(
            "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
          )
          .get(input.workspaceId, input.rootRequestId) as Row;
        const intent = readIntent(this.database, root);
        const index = updateIndex(this.database, refreshedRoot, intent, {
          status: String(refreshedRoot.status),
          isActive: 1,
          stageRequestId: input.stageRequestId,
          projectionState: "absent",
          checkpointRevision: numberOr(refreshedRoot.checkpoint_revision, 0),
          expectedIndexRevision: input.expectedIndexRevision,
          nowUtc: pair.utc,
        });
        this.invokeCrashBarrier("T6", "checkpoint_index", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "checkpoint_index",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType: "stage_d.target_effect_frozen",
          causationId: hashV1({
            r: "stage-d-event/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            targetSetHash: hashes.targetSetHash,
            effectSetHash: hashes.effectSetHash,
          }),
          payload: {
            stageD,
            targetSetHash: hashes.targetSetHash,
            effectSetHash: hashes.effectSetHash,
            effectRequestIds: orderedSpecs.map(
              (effect) => effect.effectRequestId,
            ),
          },
          occurredAtUtc: pair.utc,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId: root.intent_id === null ? null : String(root.intent_id),
          rootRequestId: input.rootRequestId,
          rootGeneration: input.rootGeneration,
          orchestrationId: String(root.orchestration_id),
          managerTaskId: String(root.manager_task_id),
          stageRequestId: input.stageRequestId,
          aggregateId: input.rootRequestId,
        });
        this.invokeCrashBarrier("T6", "event_outbox", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          phaseBoundary: "event_outbox",
        });
        const readback = stageDReadback(frozenStage);
        return {
          ok: true,
          value: readback,
          replayed: false,
          readback: { stage: readback, root: refreshedRoot, index, event },
        };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  reserveEffectConsumption(
    input: ReserveEffectConsumptionInput,
  ): AnyResult<EffectConsumptionReadback> {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return transaction(this.database, () => {
        const actor = requireActor(
          this.database,
          input as unknown as JsonRecord,
          input.workspaceId,
          pair.mono,
        );
        const { root, stage } = requireRootStage(
          this.database,
          input as unknown as JsonRecord,
          actor,
          input.stageRequestId,
          input.rootRequestId,
        );
        const stageD = stageDFromClaim(stage);
        if (!stageD || String(stageD.effectSetHash) !== input.effectSetHash)
          throw new WorkspaceOrchestratorActorError(
            "TARGET_SNAPSHOT_STALE",
            "effect reservation 缺少当前 frozen effect set。",
          );
        const dispatch = this.database
          .prepare(
            "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND job_id=?",
          )
          .get(input.workspaceId, input.sourceDispatchJobId) as Row | undefined;
        if (
          !dispatch ||
          String(dispatch.stage_request_id) !== input.stageRequestId ||
          String(dispatch.root_request_id) !== input.rootRequestId
        )
          throw new WorkspaceOrchestratorActorError(
            "WORKSPACE_STALE",
            "source dispatch job predecessor 不存在或 identity 不匹配。",
          );
        if (
          String(dispatch.state) !== "terminal" ||
          String(dispatch.result_hash ?? "") !== input.sourceResultHash
        )
          throw new WorkspaceOrchestratorActorError(
            "SOURCE_RESULT_STALE",
            "source dispatch result 未以 terminal/resultHash 冻结。",
          );
        const acceptance = resolveAcceptance(input as unknown as JsonRecord, [
          { row: root, label: "root" },
          { row: stage, label: "stage" },
          { row: dispatch, label: "source dispatch" },
        ]);
        const spec = jsonArray(stageD.effects)
          .map((entry) => entry as JsonRecord)
          .find(
            (entry) =>
              (input.effectRequestId &&
                String(entry.effectRequestId) === input.effectRequestId) ||
              (input.effectLogicalKey &&
                String(entry.effectLogicalKey) === input.effectLogicalKey),
          );
        if (!spec)
          throw new WorkspaceOrchestratorActorError(
            "EFFECT_REUSE_MISMATCH",
            "effectRequestId/effectLogicalKey 不属于当前 frozen effect set。",
          );
        const effectRequestId = String(spec.effectRequestId);
        const fields = {
          roleId: input.roleId,
          sinkName: input.sinkName,
          sinkRoleId: input.sinkRoleId,
          sinkContractVersion: input.sinkContractVersion,
          deliveryMode: input.deliveryMode,
          payloadHash: input.payloadHash,
        };
        for (const [key, value] of Object.entries({
          roleId: spec.roleId,
          sinkName: spec.sinkName,
          sinkRoleId: spec.sinkRoleId,
          sinkContractVersion: spec.sinkContractVersion,
          deliveryMode: spec.deliveryMode,
        }))
          if (String(value) !== String(fields[key as keyof typeof fields]))
            throw new WorkspaceOrchestratorActorError(
              "EFFECT_REUSE_MISMATCH",
              `effect ${key} 与 frozen spec 不一致。`,
            );
        const token = effectToken({
          workspaceId: input.workspaceId,
          effectRequestId,
          roleId: input.roleId,
          sinkName: input.sinkName,
          sinkContractVersion: input.sinkContractVersion,
          deliveryMode: input.deliveryMode,
          payloadHash: input.payloadHash,
        });
        if (input.effectToken !== undefined && input.effectToken !== token)
          throw new WorkspaceOrchestratorActorError(
            "EFFECT_REUSE_MISMATCH",
            "effectToken payload/sink/delivery mode drift。",
          );
        const existingByOperation = input.operationRequestId
          ? (this.database
              .prepare(
                "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND operation_request_id=? AND effect_request_id=?",
              )
              .get(
                input.workspaceId,
                input.operationRequestId,
                effectRequestId,
              ) as Row | undefined)
          : undefined;
        if (existingByOperation) {
          if (
            String(existingByOperation.effect_token) !== token ||
            String(existingByOperation.payload_hash) !== input.payloadHash ||
            String(existingByOperation.sink_name) !== input.sinkName ||
            String(existingByOperation.delivery_mode) !== input.deliveryMode
          )
            return failure(
              "EFFECT_REUSE_MISMATCH",
              "同一 operation/effect identity 已绑定不同 sink/payload/delivery mode。",
              effectReadback(existingByOperation),
            );
          if (
            !sameAcceptance(
              acceptanceFromRow(existingByOperation, "effect consumption"),
              acceptance,
            )
          )
            throw new WorkspaceOrchestratorActorError(
              "ACCEPTANCE_PROVENANCE_CONFLICT",
              "effect reservation replay provenance 不一致。",
            );
          return {
            ok: true,
            value: effectReadback(existingByOperation),
            replayed: true,
            readback: effectReadback(existingByOperation),
          };
        }
        const existingByToken = this.database
          .prepare(
            "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND effect_token=?",
          )
          .get(input.workspaceId, token) as Row | undefined;
        if (existingByToken) {
          if (
            !sameAcceptance(
              acceptanceFromRow(existingByToken, "effect consumption"),
              acceptance,
            )
          )
            throw new WorkspaceOrchestratorActorError(
              "ACCEPTANCE_PROVENANCE_CONFLICT",
              "effect token replay provenance 不一致。",
            );
          return {
            ok: true,
            value: effectReadback(existingByToken),
            replayed: true,
            readback: effectReadback(existingByToken),
          };
        }
        const operationInputHash =
          input.operationInputHash ??
          hashV1({
            effectRequestId,
            effectLogicalKey: input.effectLogicalKey ?? spec.effectLogicalKey,
            effectSetHash: input.effectSetHash,
            roleId: input.roleId,
            sinkName: input.sinkName,
            deliveryMode: input.deliveryMode,
            payloadHash: input.payloadHash,
          });
        const operationRequestId =
          input.operationRequestId ??
          hashV1({
            r: "operation/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            operationKind: input.operationKind ?? "effect.consume",
            operationOrdinal: numberOr(input.operationOrdinal, 1),
            operationInputHash,
          });
        const sinkCapabilityProofHash =
          input.sinkCapabilityProofHash ??
          hashV1(input.sinkCapabilityProof ?? null);
        const consumptionId = hashV1({
          r: "effect-consumption/v1",
          workspaceId: input.workspaceId,
          operationRequestId,
          effectRequestId,
          effectToken: token,
        });
        insertIdentity(
          this.database,
          input.workspaceId,
          "operation/v1",
          {
            r: "operation/v1",
            workspaceId: input.workspaceId,
            stageRequestId: input.stageRequestId,
            operationKind: input.operationKind ?? "effect.consume",
            operationOrdinal: numberOr(input.operationOrdinal, 1),
            operationInputHash,
          },
          operationRequestId,
          pair.utc,
        );
        insertIdentity(
          this.database,
          input.workspaceId,
          "effect-token/v2",
          {
            r: "sink-token/v2",
            workspaceId: input.workspaceId,
            effectRequestId,
            roleId: input.roleId,
            sinkName: input.sinkName,
            sinkContractVersion: input.sinkContractVersion,
            deliveryMode: input.deliveryMode,
            payloadHash: input.payloadHash,
          },
          token,
          pair.utc,
        );
        this.invokeCrashBarrier("T7", "identity_registry", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          operationRequestId,
          effectRequestId,
          phaseBoundary: "identity_registry",
        });
        const leaseExpiresAtMono =
          input.leaseExpiresAtMono === undefined
            ? (actor.leaseExpiresAtMono ?? pair.mono + 30_000)
            : finiteNumber(
                input.leaseExpiresAtMono,
                "leaseExpiresAtMono",
                pair.mono,
              );
        const leaseExpiresAtUtc = normalizeUtc(
          input.leaseExpiresAtUtc,
          new Date(
            Date.parse(pair.utc) + Math.max(0, leaseExpiresAtMono - pair.mono),
          ).toISOString(),
        );
        this.database
          .prepare(
            `INSERT INTO managed_effect_consumptions (
          consumption_id,workspace_id,operation_request_id,effect_request_id,effect_logical_key,effect_set_hash,effect_token,payload_hash,
          manager_task_id,orchestration_id,root_request_id,root_generation,stage_request_id,source_dispatch_job_id,source_result_hash,
          role_id,sink_name,sink_role_id,sink_contract_version,delivery_mode,sink_capability_proof_hash,state,consumption_revision,
          expected_stage_claim_revision,owner_epoch,lease_token,lease_expires_at_utc,lease_expires_at_mono,acceptance_run_id,
          baseline_event_sequence,baseline_checkpoint_revision,created_after_event_sequence,created_after_checkpoint_revision,created_after_mono,
          created_at,updated_at,finished_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, 'reserved', 0, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, NULL
        )`,
          )
          .run(
            consumptionId,
            input.workspaceId,
            operationRequestId,
            effectRequestId,
            String(spec.effectLogicalKey),
            input.effectSetHash,
            token,
            input.payloadHash,
            input.managerTaskId ?? String(root.manager_task_id),
            input.orchestrationId ?? String(root.orchestration_id),
            input.rootRequestId,
            input.rootGeneration,
            input.stageRequestId,
            input.sourceDispatchJobId,
            input.sourceResultHash,
            input.roleId,
            input.sinkName,
            input.sinkRoleId,
            input.sinkContractVersion,
            input.deliveryMode,
            sinkCapabilityProofHash,
            numberOr(stage.claim_revision, 0),
            actor.ownerEpoch,
            actor.leaseToken,
            leaseExpiresAtUtc,
            leaseExpiresAtMono,
            acceptance[0],
            acceptance[1],
            acceptance[2],
            acceptance[3],
            acceptance[4],
            acceptance[5],
            pair.utc,
            pair.utc,
          );
        this.invokeCrashBarrier("T7", "business_rows", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          operationRequestId,
          effectRequestId,
          phaseBoundary: "business_rows",
        });
        const row = this.database
          .prepare(
            "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND consumption_id=?",
          )
          .get(input.workspaceId, consumptionId) as Row;
        const nextActor = touchActor(this.database, actor, pair);
        const event = appendEvent(this.database, nextActor, {
          eventType: "effect.consumption_reserved",
          causationId: hashV1({
            r: "effect-reserve-event/v1",
            workspaceId: input.workspaceId,
            operationRequestId,
            effectRequestId,
            effectToken: token,
          }),
          payload: {
            consumptionId,
            operationRequestId,
            effectRequestId,
            effectToken: token,
            deliveryMode: input.deliveryMode,
            payloadHash: input.payloadHash,
          },
          occurredAtUtc: pair.utc,
          businessDate: String(root.business_date),
          source: String(root.source),
          rootRequestId: input.rootRequestId,
          rootGeneration: input.rootGeneration,
          orchestrationId:
            input.orchestrationId ?? String(root.orchestration_id),
          managerTaskId: input.managerTaskId ?? String(root.manager_task_id),
          stageRequestId: input.stageRequestId,
          operationRequestId,
          aggregateId: input.rootRequestId,
        });
        this.invokeCrashBarrier("T7", "event_outbox", {
          workspaceId: input.workspaceId,
          rootRequestId: input.rootRequestId,
          stageRequestId: input.stageRequestId,
          operationRequestId,
          effectRequestId,
          phaseBoundary: "event_outbox",
        });
        const readback = effectReadback(row);
        return {
          ok: true,
          value: readback,
          replayed: false,
          readback: { consumption: readback, event },
        };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  settleEffectConsumption(
    input: SettleEffectConsumptionInput,
  ): AnyResult<EffectConsumptionReadback> {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return transaction(this.database, () => {
        const actor = requireActor(
          this.database,
          input as unknown as JsonRecord,
          input.workspaceId,
          pair.mono,
        );
        let row: Row | undefined;
        if (input.consumptionId)
          row = this.database
            .prepare(
              "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND consumption_id=?",
            )
            .get(input.workspaceId, input.consumptionId) as Row | undefined;
        else if (input.operationRequestId && input.effectRequestId)
          row = this.database
            .prepare(
              "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND operation_request_id=? AND effect_request_id=?",
            )
            .get(
              input.workspaceId,
              input.operationRequestId,
              input.effectRequestId,
            ) as Row | undefined;
        if (!row)
          throw new WorkspaceOrchestratorActorError(
            "WORKSPACE_STALE",
            "effect consumption predecessor 不存在。",
          );
        for (const [key, value] of Object.entries({
          payload_hash: input.payloadHash,
          sink_name: input.sinkName,
          sink_role_id: input.sinkRoleId,
          sink_contract_version: input.sinkContractVersion,
          delivery_mode: input.deliveryMode,
          effect_token: input.effectToken,
        }))
          if (value !== undefined && String(row[key]) !== String(value))
            throw new WorkspaceOrchestratorActorError(
              "EFFECT_REUSE_MISMATCH",
              `effect consumption ${key} drift。`,
            );
        const stage = rowStage(
          this.database,
          input.workspaceId,
          String(row.stage_request_id),
        );
        const root = rowRoot(
          this.database,
          input.workspaceId,
          String(row.root_request_id),
        );
        const acceptance = resolveAcceptance(input as unknown as JsonRecord, [
          { row, label: "effect consumption" },
          { row: stage, label: "stage" },
          { row: root, label: "root" },
        ]);
        const outcome = settleOutcome(input as unknown as JsonRecord);
        const currentState = String(row.state);
        if (
          ["consumed", "failed", "cancelled", "orphaned"].includes(currentState)
        ) {
          if (
            !sameAcceptance(
              acceptanceFromRow(row, "effect consumption"),
              acceptance,
            )
          )
            throw new WorkspaceOrchestratorActorError(
              "ACCEPTANCE_PROVENANCE_CONFLICT",
              "effect settlement replay provenance 不一致。",
            );
          const same =
            currentState === outcome.state &&
            String(row.outcome_hash ?? "") ===
              String(outcome.outcomeHash ?? "") &&
            (outcome.outcomeQueryKey === null ||
              String(row.outcome_query_key ?? "") === outcome.outcomeQueryKey);
          if (same)
            return {
              ok: true,
              value: effectReadback(row),
              replayed: true,
              readback: effectReadback(row),
            };
          return failure(
            "EFFECT_REUSE_MISMATCH",
            "terminal effect token 不可改写或把 failed/partial/cancelled 改为 success。",
            effectReadback(row),
          );
        }
        if (
          numberOr(stage.owner_epoch, -1) !== actor.ownerEpoch ||
          String(stage.lease_token) !== String(actor.leaseToken)
        )
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "settlement stage fence 与 Actor 不一致。",
          );
        const expectedStageRevision =
          input.expectedStageClaimRevision ??
          input.stageClaimRevision ??
          numberOr(row.expected_stage_claim_revision, 0);
        if (numberOr(stage.claim_revision, -1) !== expectedStageRevision)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "settlement parent stage claim revision 已变化。",
          );
        if (outcome.state === "consumed" && currentState === "failed")
          return failure(
            "EFFECT_REUSE_MISMATCH",
            "failed effect token 不可变为 consumed。",
            effectReadback(row),
          );
        const settlementHash = hashV1({
          r: "settlement/v1",
          workspaceId: input.workspaceId,
          stageRequestId: String(row.stage_request_id),
          orderedTerminalResults: [
            {
              effectRequestId: String(row.effect_request_id),
              state: outcome.state,
              outcomeHash: outcome.outcomeHash,
              requestedStatus: outcome.requestedStatus,
            },
          ],
          consumptionResults: [
            {
              consumptionId: String(row.consumption_id),
              effectToken: String(row.effect_token),
            },
          ],
          projectionHash: null,
          effectSetHash: String(row.effect_set_hash),
        });
        insertIdentity(
          this.database,
          input.workspaceId,
          "settlement/v1",
          {
            r: "settlement/v1",
            workspaceId: input.workspaceId,
            stageRequestId: String(row.stage_request_id),
            orderedTerminalResults: [
              {
                effectRequestId: String(row.effect_request_id),
                state: outcome.state,
                outcomeHash: outcome.outcomeHash,
                requestedStatus: outcome.requestedStatus,
              },
            ],
            consumptionResults: [
              {
                consumptionId: String(row.consumption_id),
                effectToken: String(row.effect_token),
              },
            ],
            projectionHash: null,
            effectSetHash: String(row.effect_set_hash),
          },
          settlementHash,
          pair.utc,
        );
        this.invokeCrashBarrier("T7", "identity_registry", {
          workspaceId: String(row.workspace_id),
          rootRequestId: String(row.root_request_id),
          stageRequestId: String(row.stage_request_id),
          operationRequestId: String(row.operation_request_id),
          effectRequestId: String(row.effect_request_id),
          phaseBoundary: "identity_registry",
        });
        const nextActor = touchActor(this.database, actor, pair);
        const terminal = outcome.state !== "unknown";
        const update = this.database
          .prepare(
            `UPDATE managed_effect_consumptions SET state=?,consumption_revision=consumption_revision+1,outcome_query_key=?,outcome_hash=?,error_json=?,unknown_since=?,updated_at=?,finished_at=?,
          acceptance_run_id=COALESCE(?,acceptance_run_id),baseline_event_sequence=COALESCE(?,baseline_event_sequence),baseline_checkpoint_revision=COALESCE(?,baseline_checkpoint_revision),
          created_after_event_sequence=COALESCE(?,created_after_event_sequence),created_after_checkpoint_revision=COALESCE(?,created_after_checkpoint_revision),created_after_mono=COALESCE(?,created_after_mono)
          WHERE workspace_id=? AND consumption_id=? AND consumption_revision=? AND state IN ('reserved','consuming','unknown') AND owner_epoch=? AND lease_token=?`,
          )
          .run(
            outcome.state,
            outcome.outcomeQueryKey,
            outcome.outcomeHash,
            outcome.errorJson,
            outcome.state === "unknown" ? pair.utc : null,
            pair.utc,
            terminal ? pair.utc : null,
            acceptance[0],
            acceptance[1],
            acceptance[2],
            acceptance[3],
            acceptance[4],
            acceptance[5],
            input.workspaceId,
            String(row.consumption_id),
            numberOr(row.consumption_revision, 0),
            nextActor.ownerEpoch,
            nextActor.leaseToken,
          );
        if (affectedRows(update) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "effect consumption settlement CAS 失败。",
          );
        this.invokeCrashBarrier("T7", "business_rows", {
          workspaceId: input.workspaceId,
          rootRequestId: String(row.root_request_id),
          stageRequestId: String(row.stage_request_id),
          operationRequestId: String(row.operation_request_id),
          effectRequestId: String(row.effect_request_id),
          phaseBoundary: "business_rows",
        });
        const settled = this.database
          .prepare(
            "SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND consumption_id=?",
          )
          .get(input.workspaceId, String(row.consumption_id)) as Row;
        const event = appendEvent(this.database, nextActor, {
          eventType: terminal
            ? "effect.consumption_settled"
            : "effect.consumption_unknown",
          causationId: hashV1({
            r: "effect-settle-event/v1",
            workspaceId: input.workspaceId,
            consumptionId: String(row.consumption_id),
            settlementHash,
          }),
          payload: {
            consumptionId: String(row.consumption_id),
            effectRequestId: String(row.effect_request_id),
            effectToken: String(row.effect_token),
            state: outcome.state,
            outcomeHash: outcome.outcomeHash,
            outcomeQueryKey: outcome.outcomeQueryKey,
            settlementHash,
          },
          occurredAtUtc: pair.utc,
          businessDate: String(root.business_date),
          source: String(root.source),
          rootRequestId: String(root.root_request_id),
          rootGeneration: numberOr(root.root_generation, 0),
          orchestrationId: String(root.orchestration_id),
          managerTaskId: String(root.manager_task_id),
          stageRequestId: String(row.stage_request_id),
          operationRequestId: String(row.operation_request_id),
          aggregateId: String(root.root_request_id),
        });
        this.invokeCrashBarrier("T7", "event_outbox", {
          workspaceId: input.workspaceId,
          rootRequestId: String(row.root_request_id),
          stageRequestId: String(row.stage_request_id),
          operationRequestId: String(row.operation_request_id),
          effectRequestId: String(row.effect_request_id),
          phaseBoundary: "event_outbox",
        });
        const readback = effectReadback(settled);
        return {
          ok: true,
          value: readback,
          replayed: false,
          readback: { consumption: readback, settlementHash, event },
        };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }
}

export function createWorkspaceOrchestratorSnapshotStore(
  database: DatabaseSync,
  options: {
    nowUtc?: () => string;
    nowMono?: () => number;
    crashBarrier?: WorkspaceOrchestratorCrashBarrier;
  } = {},
): WorkspaceOrchestratorSnapshotStore {
  return new WorkspaceOrchestratorSnapshotStore(database, options);
}
