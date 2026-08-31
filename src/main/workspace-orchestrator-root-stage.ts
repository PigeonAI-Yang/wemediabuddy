import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonV1,
  hashV1,
  readStartupReconcileGate,
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

import { reserveManagedDispatchInTransaction } from "./workspace-orchestrator-resource-admission.ts";
import { validateCurrentChannelFences } from "./workspace-orchestrator-snapshots.ts";

type AnyRecord = Record<string, unknown>;
type ReserveInput = Parameters<typeof reserveManagedDispatchInTransaction>[1];
export type AcceptanceProvenanceInput = Readonly<{
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
}>;

type AcceptanceValues = Readonly<{
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

const MAX_ROOT_WALL_CLOCK_MS = 20 * 60 * 1000;
const MAX_RESOURCE_WAIT_MS = 90 * 1000;
const TERMINAL_ROOT_STATUSES = new Set([
  "succeeded",
  "partial",
  "failed",
  "needs_user",
  "cancelled",
]);
const TERMINAL_STAGE_STATUSES = new Set([
  "succeeded",
  "skipped",
  "partial",
  "failed",
  "needs_user",
  "cancelled",
  "orphaned",
]);
const ACTIVE_ROOT_STATUSES = new Set(["created", "running", "waiting_owner"]);
const ACTIVE_STAGE_STATUSES = new Set([
  "claimed_unbound",
  "claimed",
  "dispatching_scan",
  "snapshot_frozen",
  "awaiting_judge",
  "dispatching_judge",
  "manifest_frozen",
  "dispatching",
  "settling",
  "running",
]);

export type RootStageStatus =
  | "created"
  | "running"
  | "waiting_owner"
  | "succeeded"
  | "partial"
  | "failed"
  | "needs_user"
  | "cancelled";
export type StageTerminalStatus =
  "succeeded" | "skipped" | "partial" | "failed" | "needs_user" | "cancelled";

export type RootStageStoreOptions = Readonly<{
  nowUtc?: () => string;
  nowMono?: () => number;
  crashBarrier?: WorkspaceOrchestratorCrashBarrier;
}>;

export type RootAdmissionInput = Readonly<{
  workspaceId: string;
  intentId?: string;
  requestId?: string;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  acceptance?: AcceptanceProvenanceInput;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  actorFence?: ActorFence;
  managerTaskId?: string;
  rootGeneration?: number;
  retryInvocationOrdinal?: number;
  predecessorRootId?: string | null;
  rootRequestId?: string;
  orchestrationId?: string;
  stageRequestId?: string;
  operationRequestId?: string;
  childIdentityKey?: string;
  rootDeadlineUtc?: string;
  rootDeadlineMono?: number;
  stageDeadlineUtc?: string;
  stageDeadlineMono?: number;
  spawnDeadlineUtc?: string;
  spawnDeadlineMono?: number;
  argvHash?: string;
  cwdFingerprint?: string;
  sessionKey?: string;
  envelope?: unknown;
  executionEnvelope?: unknown;
  nowUtc?: string;
  nowMono?: number;
  [key: string]: unknown;
}>;

export type JudgeHandoffInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  stageRequestId?: string;
  judgeStageRequestId?: string;
  expectedRootCheckpointRevision?: number;
  expectedClaimRevision?: number;
  sourceSnapshotHash?: string;
  snapshotHash?: string;
  stageDeadlineUtc?: string;
  stageDeadlineMono?: number;
  spawnDeadlineUtc?: string;
  spawnDeadlineMono?: number;
  argvHash?: string;
  cwdFingerprint?: string;
  sessionKey?: string;
  envelope?: unknown;
  executionEnvelope?: unknown;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  actorFence?: ActorFence;
  currentChannelFences?:
    readonly AnyRecord[] | Readonly<Record<string, AnyRecord>>;
  acceptance?: AcceptanceProvenanceInput;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  nowUtc?: string;
  nowMono?: number;
  [key: string]: unknown;
}>;

export type RootCancelInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  expectedRootCheckpointRevision?: number;
  reasonCode?: string;
  reason?: string;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  actorFence?: ActorFence;
  acceptance?: AcceptanceProvenanceInput;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  nowUtc?: string;
  nowMono?: number;
  [key: string]: unknown;
}>;

export type StageSettlementInput = Readonly<{
  workspaceId: string;
  stageRequestId: string;
  expectedClaimRevision?: number;
  expectedRootCheckpointRevision?: number;
  status?: StageTerminalStatus;
  terminalStatus?: StageTerminalStatus;
  resultStatus?: StageTerminalStatus;
  reasonCode?: string;
  reason?: string;
  result?: unknown;
  resultJson?: unknown;
  rootStatus?: RootStageStatus;
  keepRootRunning?: boolean;
  nextAction?: unknown;
  projectionState?: "absent" | "not_applicable" | "frozen";
  projectionHash?: string | null;
  scopeHash?: string | null;
  eligibleIdsHash?: string | null;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  actorFence?: ActorFence;
  acceptance?: AcceptanceProvenanceInput;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  nowUtc?: string;
  nowMono?: number;
  [key: string]: unknown;
}>;

export type EvidenceSuccessorInput = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  predecessorStageRequestId?: string;
  stageRequestId?: string;
  predecessorScopeId: string;
  predecessorScopeHash: string;
  predecessorProjectionHash?: string;
  predecessorGapHash?: string;
  sourceSnapshotHash?: string;
  progressOrdinal?: number;
  evidenceSuccessorOrdinal?: number;
  successorOrdinal?: number;
  maxEvidenceSuccessors?: number;
  expectedRootCheckpointRevision?: number;
  expectedClaimRevision?: number;
  logicalInputHash?: string;
  rootGeneration?: number;
  rootInputHash?: string;
  managerTaskId?: string;
  orchestrationId?: string;
  stageDeadlineUtc?: string;
  stageDeadlineMono?: number;
  acceptance?: AcceptanceProvenanceInput;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  actorFence?: ActorFence;
  nowUtc?: string;
  nowMono?: number;
  [key: string]: unknown;
}>;

export type RootStageReadback = Readonly<{
  root?: AnyRecord;
  index?: AnyRecord;
  intent?: AnyRecord;
  claims: readonly AnyRecord[];
  dispatches: readonly AnyRecord[];
}>;
type RootStageSuccess = Readonly<{
  ok: true;
  status: string;
  root?: AnyRecord;
  claim?: AnyRecord;
  stage?: AnyRecord;
  judge?: AnyRecord;
  reporter?: AnyRecord;
  dispatch?: AnyRecord;
  index?: AnyRecord;
  intent?: AnyRecord;
  event?: AnyRecord;
  readback: RootStageReadback & AnyRecord;
}>;

type RootStageFailure = Readonly<{
  ok: false;
  status: "rejected";
  code: string;
  reasonCode: string;
  message: string;
  readback?: RootStageReadback & AnyRecord;
}>;

export type RootStageResult = RootStageSuccess | RootStageFailure;

function asNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asInteger(value: unknown, fallback = 0): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requireString(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${field} 不能为空。`,
    );
  return text.normalize("NFC");
}

function normalizeUtc(value: unknown, fallback: string): string {
  const candidate =
    value === undefined || value === null ? fallback : String(value);
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime()))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `无效 UTC instant: ${candidate}`,
    );
  return date.toISOString();
}

function utcAtMono(
  baseUtc: string,
  baseMono: number,
  targetMono: number,
): string {
  const base = Date.parse(baseUtc);
  if (!Number.isFinite(base))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `无效 UTC instant: ${baseUtc}`,
    );
  return new Date(base + targetMono - baseMono).toISOString();
}

function nowPair(
  input: AnyRecord,
  options: RootStageStoreOptions,
): { utc: string; mono: number } {
  const fallbackUtc = normalizeUtc(
    options.nowUtc?.() ?? new Date().toISOString(),
    new Date().toISOString(),
  );
  const utc = normalizeUtc(input.nowUtc, fallbackUtc);
  const mono =
    input.nowMono === undefined
      ? Number(options.nowMono?.() ?? Date.now())
      : Number(input.nowMono);
  if (!Number.isFinite(mono) || mono < 0)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "monotonic tick 必须是非负有限数。",
    );
  return { utc, mono };
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (typeof value !== "string") return value === undefined ? fallback : value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function record(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}
function optionalRecord(value: unknown): AnyRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as AnyRecord;
}
const ACCEPTANCE_ALIASES = Object.freeze([
  ["acceptanceRunId", "acceptance_run_id"],
  ["baselineEventSequence", "baseline_event_sequence"],
  ["baselineCheckpointRevision", "baseline_checkpoint_revision"],
  ["createdAfterEventSequence", "created_after_event_sequence"],
  ["createdAfterCheckpointRevision", "created_after_checkpoint_revision"],
  ["createdAfterMono", "created_after_mono"],
] as const);

function acceptanceField(
  source: AnyRecord,
  camel: string,
  snake: string,
  label: string,
): unknown {
  const camelValue = source[camel];
  const snakeValue = source[snake];
  if (camelValue !== undefined && snakeValue !== undefined) {
    const left = camelValue === null ? null : String(camelValue);
    const right = snakeValue === null ? null : String(snakeValue);
    if (left !== right)
      throw new WorkspaceOrchestratorActorError(
        "REQUEST_REPLAY_CONFLICT",
        `${label} 字段别名冲突。`,
        { camel, snake },
      );
  }
  return camelValue !== undefined ? camelValue : snakeValue;
}

function acceptanceFromSource(
  source: AnyRecord,
  label: string,
): AcceptanceValues | null | undefined {
  const values = ACCEPTANCE_ALIASES.map(([camel, snake]) =>
    acceptanceField(source, camel, snake, label),
  );
  if (values.every((value) => value === undefined)) return undefined;
  if (values.every((value) => value === null || value === undefined))
    return null;
  if (values.some((value) => value === null || value === undefined)) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${label} 字段必须完整成套。`,
    );
  }
  const acceptanceRunId = String(values[0]).trim().normalize("NFC");
  if (!acceptanceRunId)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${label}.acceptanceRunId 不能为空。`,
    );
  const numbers = values.slice(1).map((value) => {
    if (typeof value === "string" && !value.trim())
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        `${label} 数值字段不能为空。`,
      );
    const number = Math.trunc(Number(value));
    if (!Number.isSafeInteger(number) || number < 0)
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        `${label} 数值字段必须是非负整数。`,
      );
    return number;
  });
  return Object.freeze({
    acceptanceRunId,
    baselineEventSequence: numbers[0],
    baselineCheckpointRevision: numbers[1],
    createdAfterEventSequence: numbers[2],
    createdAfterCheckpointRevision: numbers[3],
    createdAfterMono: numbers[4],
  });
}

function sameAcceptance(
  left: AcceptanceValues | null,
  right: AcceptanceValues | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.acceptanceRunId === right.acceptanceRunId &&
    left.baselineEventSequence === right.baselineEventSequence &&
    left.baselineCheckpointRevision === right.baselineCheckpointRevision &&
    left.createdAfterEventSequence === right.createdAfterEventSequence &&
    left.createdAfterCheckpointRevision ===
      right.createdAfterCheckpointRevision &&
    left.createdAfterMono === right.createdAfterMono
  );
}

function acceptanceFromRow(
  row: AnyRecord | undefined,
  label: string,
): AcceptanceValues | null {
  if (!row)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `${label} durable row 不存在。`,
    );
  return acceptanceFromSource(row, label) ?? null;
}

function acceptanceFromInput(
  input: AnyRecord,
  label = "root admission provenance",
): AcceptanceValues | null {
  const topLevel = acceptanceFromSource(input, label);
  let nested: AcceptanceValues | null | undefined;
  if (input.acceptance !== undefined && input.acceptance !== null) {
    const candidate = optionalRecord(input.acceptance);
    if (!candidate)
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "acceptance 必须是对象。",
      );
    nested = acceptanceFromSource(candidate, `${label} nested`);
  }
  if (topLevel && nested && !sameAcceptance(topLevel, nested)) {
    throw new WorkspaceOrchestratorActorError(
      "REQUEST_REPLAY_CONFLICT",
      "顶层与 acceptance provenance 不一致。",
    );
  }
  return topLevel ?? nested ?? null;
}

function assertAcceptanceMatch(
  actual: AcceptanceValues | null,
  expected: AcceptanceValues | null,
  label: string,
): void {
  if (!sameAcceptance(actual, expected)) {
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      `${label} provenance 不一致。`,
      { actual, expected },
    );
  }
}

function acceptanceTuple(values: AcceptanceValues | null): AcceptanceTuple {
  return values
    ? [
        values.acceptanceRunId,
        values.baselineEventSequence,
        values.baselineCheckpointRevision,
        values.createdAfterEventSequence,
        values.createdAfterCheckpointRevision,
        values.createdAfterMono,
      ]
    : [null, null, null, null, null, null];
}

function acceptanceInput(values: AcceptanceValues | null): AnyRecord {
  if (!values) return {};
  return {
    acceptanceRunId: values.acceptanceRunId,
    baselineEventSequence: values.baselineEventSequence,
    baselineCheckpointRevision: values.baselineCheckpointRevision,
    createdAfterEventSequence: values.createdAfterEventSequence,
    createdAfterCheckpointRevision: values.createdAfterCheckpointRevision,
    createdAfterMono: values.createdAfterMono,
  };
}

function sortedStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(values.map((value) => String(value).normalize("NFC"))),
  ].sort((left, right) => {
    const a = Array.from(left);
    const b = Array.from(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const diff = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
      if (diff !== 0) return diff;
    }
    return a.length - b.length;
  });
}

function fenceFromInput(input: AnyRecord): Partial<ActorFence> | null {
  const candidate = input.fence ?? input.actorFence ?? input.actor;
  const source =
    candidate && typeof candidate === "object"
      ? (record(candidate).fence ?? candidate)
      : input;
  const value = record(source);
  const fields: {
    workspaceId?: string;
    runtimeEpoch?: number;
    ownerEpoch?: number;
    authorityRevision?: number;
    leaseToken?: string;
  } = {};
  if (value.workspaceId !== undefined || value.workspace_id !== undefined)
    fields.workspaceId = String(value.workspaceId ?? value.workspace_id);
  if (value.runtimeEpoch !== undefined || value.runtime_epoch !== undefined)
    fields.runtimeEpoch = asInteger(
      value.runtimeEpoch ?? value.runtime_epoch,
      -1,
    );
  if (value.ownerEpoch !== undefined || value.owner_epoch !== undefined)
    fields.ownerEpoch = asInteger(value.ownerEpoch ?? value.owner_epoch, -1);
  if (
    value.authorityRevision !== undefined ||
    value.authority_revision !== undefined
  )
    fields.authorityRevision = asInteger(
      value.authorityRevision ?? value.authority_revision,
      -1,
    );
  if (value.leaseToken !== undefined || value.lease_token !== undefined)
    fields.leaseToken = String(value.leaseToken ?? value.lease_token);
  return Object.keys(fields).length ? fields : null;
}

function actorFence(actor: WorkspaceOrchestratorActor): ActorFence {
  if (!actor.leaseToken)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "当前 Actor 没有可用 lease fence。",
    );
  return Object.freeze({
    workspaceId: actor.workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    checkpointRevision: actor.checkpointRevision,
  });
}

function readActor(
  database: DatabaseSync,
  workspaceId: string,
): WorkspaceOrchestratorActor {
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  if (!actor)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "workspace Actor 不存在。",
      { workspaceId },
    );
  return actor;
}

function requireCurrentActor(
  database: DatabaseSync,
  input: AnyRecord,
  pair: { mono: number },
): WorkspaceOrchestratorActor {
  const workspaceId = requireString(input.workspaceId, "workspaceId");
  const actor = readActor(database, workspaceId);
  const supplied = fenceFromInput(input);
  if (
    !supplied ||
    (supplied.workspaceId !== undefined &&
      supplied.workspaceId !== workspaceId) ||
    supplied.runtimeEpoch !== actor.runtimeEpoch ||
    supplied.ownerEpoch !== actor.ownerEpoch ||
    supplied.authorityRevision !== actor.authorityRevision ||
    supplied.leaseToken !== actor.leaseToken
  ) {
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor fence 已失效。",
      { workspaceId, actor },
    );
  }
  if (actor.actorStatus === "failed" || !actor.leaseToken)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor 不可写。",
      { workspaceId, actor },
    );
  if (
    (actor.leaseExpiresAtMono !== null &&
      pair.mono >= actor.leaseExpiresAtMono) ||
    (actor.controlStallDeadlineMono !== null &&
      pair.mono >= actor.controlStallDeadlineMono)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor lease/control stall 已到期。",
      { workspaceId, actor },
    );
  }
  return actor;
}

function requireCompleteGate(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
): void {
  const gate = readStartupReconcileGate(
    database,
    actor.workspaceId,
    actor.runtimeEpoch,
  );
  if (
    !gate ||
    gate.status !== "complete" ||
    gate.ownerEpoch !== actor.ownerEpoch ||
    gate.leaseToken !== actor.leaseToken ||
    gate.checkpointRevision !== actor.checkpointRevision
  ) {
    throw new WorkspaceOrchestratorActorError(
      "STARTUP_RECONCILE_REQUIRED",
      "当前 runtime startup reconcile gate 尚未 complete。",
      { gate },
    );
  }
}

function insertIdentity(
  database: DatabaseSync,
  input: {
    workspaceId: string;
    registryName: string;
    preimage: unknown;
    derivedValue: string;
    createdAt: string;
  },
): void {
  const bytes = Buffer.from(canonicalJsonV1(input.preimage), "utf8");
  const preimageHash = sha256Hex(bytes);
  const existing = database
    .prepare(
      `SELECT preimage_schema_version, canonical_bytes_hash, preimage_bytes, derived_value
    FROM identity_hash_registry
    WHERE workspace_id=? AND registry_name=? AND registry_version=1 AND preimage_hash=?`,
    )
    .get(input.workspaceId, input.registryName, preimageHash) as
    AnyRecord | undefined;
  if (existing) {
    const existingBytes = Buffer.from(existing.preimage_bytes as Uint8Array);
    if (
      Number(existing.preimage_schema_version) !== 1 ||
      String(existing.canonical_bytes_hash) !== sha256Hex(bytes) ||
      !existingBytes.equals(bytes) ||
      String(existing.derived_value) !== input.derivedValue
    ) {
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        `identity registry ${input.registryName} 已绑定不同派生值。`,
      );
    }
    return;
  }
  database
    .prepare(
      `INSERT INTO identity_hash_registry (
    workspace_id, registry_name, registry_version, preimage_schema_version, preimage_hash,
    canonical_bytes_hash, preimage_bytes, derived_value, created_at
  ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.workspaceId,
      input.registryName,
      preimageHash,
      sha256Hex(bytes),
      bytes,
      input.derivedValue,
      input.createdAt,
    );
}

function bumpActor(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  pair: { utc: string },
): WorkspaceOrchestratorActor {
  const nextCheckpoint = actor.checkpointRevision + 1;
  const update = database
    .prepare(
      `UPDATE workspace_orchestrator_actors
    SET checkpoint_revision=?, updated_at=?
    WHERE workspace_id=? AND actor_status IN ('active','stopping') AND runtime_epoch=?
      AND owner_epoch=? AND authority_revision=? AND lease_token=? AND checkpoint_revision=?`,
    )
    .run(
      nextCheckpoint,
      pair.utc,
      actor.workspaceId,
      actor.runtimeEpoch,
      actor.ownerEpoch,
      actor.authorityRevision,
      actor.leaseToken,
      actor.checkpointRevision,
    );
  if (Number(update.changes ?? 0) !== 1)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor checkpoint CAS 失败。",
    );
  const gate = readStartupReconcileGate(
    database,
    actor.workspaceId,
    actor.runtimeEpoch,
  );
  if (gate) {
    const synced = database
      .prepare(
        `UPDATE daily_reconcile_gates SET checkpoint_revision=?
      WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=? AND lease_token=? AND checkpoint_revision=?`,
      )
      .run(
        nextCheckpoint,
        actor.workspaceId,
        actor.runtimeEpoch,
        actor.ownerEpoch,
        actor.leaseToken,
        actor.checkpointRevision,
      );
    if (Number(synced.changes ?? 0) !== 1)
      throw new WorkspaceOrchestratorActorError(
        "EXECUTION_AUTHORIZATION_INVALID",
        "reconcile gate projection CAS 失败。",
      );
  }
  return readActor(database, actor.workspaceId);
}

function readRootRow(
  database: DatabaseSync,
  workspaceId: string,
  rootRequestId: string,
): AnyRecord | undefined {
  return database
    .prepare(
      "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND root_request_id=?",
    )
    .get(workspaceId, rootRequestId) as AnyRecord | undefined;
}

function readIntentRow(
  database: DatabaseSync,
  input: { workspaceId: string; intentId?: string; requestId?: string },
): AnyRecord | undefined {
  if (input.intentId)
    return database
      .prepare(
        "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
      )
      .get(input.workspaceId, input.intentId) as AnyRecord | undefined;
  if (input.requestId)
    return database
      .prepare(
        "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND request_id=?",
      )
      .get(input.workspaceId, input.requestId) as AnyRecord | undefined;
  return undefined;
}

function readClaimRow(
  database: DatabaseSync,
  workspaceId: string,
  stageRequestId: string,
): AnyRecord | undefined {
  return database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND stage_request_id=?",
    )
    .get(workspaceId, stageRequestId) as AnyRecord | undefined;
}

function rowObject(row: AnyRecord | undefined): AnyRecord | undefined {
  if (!row) return undefined;
  const output: AnyRecord = { ...row };
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (!(camel in output)) output[camel] = value;
  }
  return Object.freeze(output);
}

function readBundle(
  database: DatabaseSync,
  workspaceId: string,
  rootRequestId: string,
): RootStageReadback {
  const root = readRootRow(database, workspaceId, rootRequestId);
  if (!root)
    return Object.freeze({
      claims: Object.freeze([]),
      dispatches: Object.freeze([]),
    });
  const claims = database
    .prepare(
      "SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? ORDER BY rowid ASC",
    )
    .all(workspaceId, rootRequestId) as AnyRecord[];
  const dispatches = database
    .prepare(
      "SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND root_request_id=? ORDER BY child_ordinal ASC, rowid ASC",
    )
    .all(workspaceId, rootRequestId) as AnyRecord[];
  const index = database
    .prepare(
      "SELECT * FROM workspace_active_root_index WHERE workspace_id=? AND root_request_id=?",
    )
    .get(workspaceId, rootRequestId) as AnyRecord | undefined;
  const intent = root.intent_id
    ? (database
        .prepare(
          "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
        )
        .get(workspaceId, String(root.intent_id)) as AnyRecord | undefined)
    : undefined;
  return Object.freeze({
    root: rowObject(root),
    index: rowObject(index),
    intent: rowObject(intent),
    claims: Object.freeze(claims.map((claim) => rowObject(claim)!)),
    dispatches: Object.freeze(
      dispatches.map((dispatch) => rowObject(dispatch)!),
    ),
  });
}

function success(
  status: string,
  bundle: RootStageReadback,
  extra: AnyRecord = {},
): RootStageSuccess {
  const root = bundle.root;
  const claims = bundle.claims;
  const dispatches = bundle.dispatches;
  const claim =
    optionalRecord(extra.claim) ??
    optionalRecord(extra.stage) ??
    claims.find(
      (item) => item.status !== "succeeded" || item.attempt_stage === "judge",
    ) ??
    claims.at(-1);
  const stage = optionalRecord(extra.stage) ?? claim;
  const judge =
    optionalRecord(extra.judge) ??
    claims.find((item) => item.attempt_stage === "judge");
  const reporter =
    optionalRecord(extra.reporter) ??
    claims.find((item) => item.attempt_stage !== "judge");
  const dispatch =
    optionalRecord(extra.dispatch) ??
    (judge
      ? dispatches.find(
          (item) => item.stage_request_id === judge.stage_request_id,
        )
      : reporter
        ? dispatches.find(
            (item) => item.stage_request_id === reporter.stage_request_id,
          )
        : dispatches[0]);
  return Object.freeze({
    ok: true,
    status,
    root,
    claim,
    stage,
    judge,
    reporter,
    dispatch,
    index: bundle.index,
    intent: bundle.intent,
    event: optionalRecord(extra.event),
    readback: Object.freeze({
      ...bundle,
      ...extra,
      root,
      claim,
      stage,
      judge,
      reporter,
      dispatch,
    }),
  });
}

function failure(
  code: string,
  message: string,
  readback?: RootStageReadback & AnyRecord,
): RootStageFailure {
  return Object.freeze({
    ok: false,
    status: "rejected",
    code,
    reasonCode: code,
    message,
    readback,
  });
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
  details?: AnyRecord;
} {
  if (isWorkspaceOrchestratorCrashInjectedError(error))
    return {
      code: error.code,
      message: error.message,
      details: { ...error.context },
    };
  if (error instanceof WorkspaceOrchestratorActorError)
    return {
      code: error.code,
      message: error.message,
      details: { ...error.details },
    };
  if (error instanceof Error)
    return { code: "ORCHESTRATOR_CONTRACT_ERROR", message: error.message };
  return { code: "ORCHESTRATOR_CONTRACT_ERROR", message: String(error) };
}

function appendEvent(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  input: {
    eventType: string;
    causationId: string;
    payload: unknown;
    occurredAtUtc: string;
    aggregateId: string;
    aggregateRow: AnyRecord;
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
    claimRevision?: number | null;
    snapshotHash?: string | null;
    scopeHash?: string | null;
    projectionHash?: string | null;
  },
): AnyRecord {
  const existing = database
    .prepare(
      `SELECT event_sequence, event_id, event_type, event_ordinal, causation_id
    FROM orchestrator_events WHERE workspace_id=? AND event_type=? AND causation_id=?
    ORDER BY event_sequence LIMIT 1`,
    )
    .get(actor.workspaceId, input.eventType, input.causationId) as
    AnyRecord | undefined;
  if (existing) {
    const eventSequence = asNumber(existing.event_sequence);
    const outbox = database
      .prepare(
        "SELECT outbox_id FROM orchestrator_outbox WHERE workspace_id=? AND event_sequence=?",
      )
      .get(actor.workspaceId, eventSequence) as AnyRecord | undefined;
    if (!outbox)
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "canonical event 缺少对应 outbox。",
      );
    return Object.freeze({
      eventSequence,
      eventId: String(existing.event_id),
      outboxId: String(outbox.outbox_id),
      eventType: String(existing.event_type),
      causationId: String(existing.causation_id),
      replayed: true,
    });
  }
  const ordinalRow = database
    .prepare(
      `SELECT COALESCE(MAX(event_ordinal), 0) AS value
    FROM orchestrator_outbox WHERE workspace_id=? AND aggregate_id=? AND aggregate_revision=?`,
    )
    .get(actor.workspaceId, input.aggregateId, actor.checkpointRevision) as
    AnyRecord | undefined;
  const acceptance = acceptanceFromRow(input.aggregateRow, "event aggregate");
  const eventOrdinal = asInteger(ordinalRow?.value) + 1;
  const eventSequence =
    asNumber(
      (
        database
          .prepare(
            "SELECT COALESCE(MAX(event_sequence),0) AS value FROM orchestrator_events WHERE workspace_id=?",
          )
          .get(actor.workspaceId) as AnyRecord
      ).value,
    ) + 1;
  const payloadJson = canonicalJsonV1(input.payload);
  const eventId = hashV1({
    r: "event/v1",
    workspaceId: actor.workspaceId,
    eventSequence,
    eventType: input.eventType,
    eventOrdinal,
    causationId: input.causationId,
  });
  const leaseFingerprint = sha256Hex(actor.leaseToken ?? "");
  database
    .prepare(
      `INSERT INTO orchestrator_events (
    workspace_id, event_sequence, event_id, event_type, event_ordinal, business_date, source,
    intent_id, invocation_id, root_request_id, root_generation, orchestration_id, manager_task_id,
    stage_request_id, request_id, operation_request_id, parent_task_id, job_id, causation_id,
    actor_epoch, owner_epoch, lease_token_fingerprint, claim_revision, checkpoint_revision,
    snapshot_hash, scope_hash, projection_hash, payload_json,
    acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
    created_after_event_sequence, created_after_checkpoint_revision, created_after_mono, occurred_at_utc
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
      leaseFingerprint,
      input.claimRevision ?? null,
      actor.checkpointRevision,
      input.snapshotHash ?? null,
      input.scopeHash ?? null,
      input.projectionHash ?? null,
      payloadJson,
      ...acceptanceTuple(acceptance),
      input.occurredAtUtc,
    );
  const outboxId = hashV1({
    r: "outbox/v1",
    workspaceId: actor.workspaceId,
    eventSequence,
    aggregateId: input.aggregateId,
    aggregateRevision: actor.checkpointRevision,
    eventType: input.eventType,
    eventOrdinal,
    causationId: input.causationId,
  });
  const bytes = Buffer.from(payloadJson, "utf8");
  database
    .prepare(
      `INSERT INTO orchestrator_outbox (
    outbox_id, workspace_id, event_sequence, aggregate_id, aggregate_revision, event_type,
    event_ordinal, causation_id, payload_hash, payload_bytes,
    acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
    created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
    status, attempt, created_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, 'pending', 0, ?
  )`,
    )
    .run(
      outboxId,
      actor.workspaceId,
      eventSequence,
      input.aggregateId,
      actor.checkpointRevision,
      input.eventType,
      eventOrdinal,
      input.causationId,
      sha256Hex(bytes),
      bytes,
      ...acceptanceTuple(acceptance),
      input.occurredAtUtc,
    );
  return Object.freeze({
    eventSequence,
    eventId,
    outboxId,
    eventType: input.eventType,
    causationId: input.causationId,
  });
}

function deadlinePair(
  input: AnyRecord,
  actor: WorkspaceOrchestratorActor,
  pair: { utc: string; mono: number },
  kind: "root" | "stage" | "spawn",
): { utc: string; mono: number } {
  const actorLease =
    actor.leaseExpiresAtMono ?? pair.mono + MAX_ROOT_WALL_CLOCK_MS;
  const actorGate = actor.gateDeadlineMono ?? actorLease;
  const rootRequested =
    input.rootDeadlineMono === undefined
      ? pair.mono + MAX_ROOT_WALL_CLOCK_MS
      : Number(input.rootDeadlineMono);
  const rootMono = Math.min(rootRequested, actorLease, actorGate);
  const stageRequested =
    input.stageDeadlineMono === undefined
      ? rootMono
      : Number(input.stageDeadlineMono);
  const stageMono = Math.min(stageRequested, rootMono);
  const spawnRequested =
    input.spawnDeadlineMono === undefined
      ? pair.mono + MAX_RESOURCE_WAIT_MS
      : Number(input.spawnDeadlineMono);
  const spawnMono = Math.min(spawnRequested, stageMono);
  const mono =
    kind === "root" ? rootMono : kind === "stage" ? stageMono : spawnMono;
  if (!Number.isFinite(mono) || mono < pair.mono)
    throw new WorkspaceOrchestratorActorError(
      "MANAGER_WALL_CLOCK",
      `${kind} deadline 已过期。`,
    );
  const utcValue =
    kind === "root"
      ? input.rootDeadlineUtc
      : kind === "stage"
        ? input.stageDeadlineUtc
        : input.spawnDeadlineUtc;
  return {
    mono,
    utc: normalizeUtc(utcValue, utcAtMono(pair.utc, pair.mono, mono)),
  };
}

function claimId(workspaceId: string, stageRequestId: string): string {
  return hashV1({ r: "stage-claim/v1", workspaceId, stageRequestId });
}

function operationInputHash(input: AnyRecord): string {
  return hashV1(input);
}

function reserveDispatch(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  input: AnyRecord,
  values: {
    rootRequestId: string;
    rootGeneration: number;
    rootInputHash: string;
    managerTaskId: string;
    orchestrationId: string;
    parentTaskId: string;
    parentStageRequestId: string;
    stageRequestId: string;
    retryGeneration: number;
    roleId: "reporter" | "judge";
    childOrdinal: number;
    operationRequestId: string;
    claimRevision: number;
    preflightId: string;
    policyHash: string;
    rootDeadline: { utc: string; mono: number };
    stageDeadline: { utc: string; mono: number };
    spawnDeadline: { utc: string; mono: number };
    pair: { utc: string; mono: number };
    acceptance: AcceptanceValues | null;
    envelope: AnyRecord;
    argvHash?: string;
    cwdFingerprint?: string;
    sessionKey?: string;
  },
): AnyRecord {
  const argvHash = String(
    values.argvHash ??
      hashV1({
        r: "argv/v1",
        workspaceId: actor.workspaceId,
        roleId: values.roleId,
        stageRequestId: values.stageRequestId,
        operationRequestId: values.operationRequestId,
      }),
  );
  const cwdFingerprint = String(
    values.cwdFingerprint ??
      hashV1({
        r: "cwd/v1",
        workspaceId: actor.workspaceId,
        managerTaskId: values.managerTaskId,
        stageRequestId: values.stageRequestId,
      }),
  );
  const sessionKey = String(
    values.sessionKey ??
      hashV1({
        r: "session/v1",
        workspaceId: actor.workspaceId,
        stageRequestId: values.stageRequestId,
        roleId: values.roleId,
      }),
  );
  const envelope: AnyRecord = {
    ...record(values.envelope),
    version: "ExecutionEnvelopeV2",
    workspaceId: actor.workspaceId,
    actorEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    rootRequestId: values.rootRequestId,
    rootGeneration: values.rootGeneration,
    stageRequestId: values.stageRequestId,
    claimRevision: values.claimRevision,
    operationRequestId: values.operationRequestId,
    roleId: values.roleId,
    preflightId: values.preflightId,
    policyHash: values.policyHash,
    rootDeadlineUtc: values.rootDeadline.utc,
    rootDeadlineMono: values.rootDeadline.mono,
    stageDeadlineUtc: values.stageDeadline.utc,
    stageDeadlineMono: values.stageDeadline.mono,
    gateDeadlineUtc: actor.gateDeadlineUtc,
    gateDeadlineMono: actor.gateDeadlineMono,
    issuedAtUtc: values.pair.utc,
    expiresAtUtc: values.spawnDeadline.utc,
    expiresAtMono: values.spawnDeadline.mono,
    producerAttestationHash: null,
    buildId: actor.currentBuildId,
    schemaEpoch: 79,
    argvHash,
    cwdFingerprint,
    sessionKey,
    parentFence: {
      workspaceId: actor.workspaceId,
      claimRevision: values.claimRevision,
      ownerEpoch: actor.ownerEpoch,
      leaseToken: actor.leaseToken,
    },
  };
  const resourceInput: AnyRecord = {
    workspaceId: actor.workspaceId,
    fence: actorFence(actor),
    actorFence: actorFence(actor),
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    rootRequestId: values.rootRequestId,
    rootGeneration: values.rootGeneration,
    rootInputHash: values.rootInputHash,
    managerTaskId: values.managerTaskId,
    orchestrationId: values.orchestrationId,
    parentTaskId: values.parentTaskId,
    parentStageRequestId: values.parentStageRequestId,
    stageRequestId: values.stageRequestId,
    retryGeneration: values.retryGeneration,
    expectedParentClaimRevision: values.claimRevision,
    expectedParentOwnerEpoch: actor.ownerEpoch,
    expectedParentLeaseToken: actor.leaseToken,
    roleId: values.roleId,
    childOrdinal: values.childOrdinal,
    operationRequestId: values.operationRequestId,
    envelope,
    ...acceptanceInput(values.acceptance),
    argvHash,
    cwdFingerprint,
    sessionKey,
    nowUtc: values.pair.utc,
    nowMono: values.pair.mono,
    leaseExpiresAtUtc: actor.leaseExpiresAtUtc,
    leaseExpiresAtMono: actor.leaseExpiresAtMono,
    spawnDeadlineUtc: values.spawnDeadline.utc,
    spawnDeadlineMono: values.spawnDeadline.mono,
  };
  const result = reserveManagedDispatchInTransaction(
    database,
    resourceInput as unknown as ReserveInput,
  ) as AnyRecord;
  if (result.ok !== true)
    throw new WorkspaceOrchestratorActorError(
      String(result.code ?? "RESOURCE_WAIT_TIMEOUT"),
      String(result.message ?? "managed resource reservation rejected"),
      record(result.readback),
    );
  const dispatch = result.dispatch;
  if (!dispatch || typeof dispatch !== "object")
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "resource reservation 缺少 dispatch readback。",
    );
  return record(dispatch);
}

function rootCanonicalInputHash(
  intent: AnyRecord,
  rootGeneration: number,
  retryInvocationOrdinal: number,
  predecessorRootId: string | null,
): string {
  return hashV1({
    r: "root-input/v1",
    workspaceId: String(intent.workspace_id),
    intentId: String(intent.intent_id),
    businessDate: String(intent.business_date),
    source: String(intent.source),
    rootMode: String(intent.root_mode),
    requestedAction: String(intent.requested_action),
    logicalInputHash: String(intent.logical_input_hash),
    normalizedPolicyHash: String(intent.normalized_policy_hash),
    rootGeneration,
    retryInvocationOrdinal,
    predecessorRootId,
  });
}

function rootIdentity(
  intent: AnyRecord,
  rootGeneration: number,
  retryInvocationOrdinal: number,
  predecessorRootId: string | null,
): { rootRequestId: string; rootInputHash: string; preimage: AnyRecord } {
  const preimage = {
    r: "root-invocation/v1",
    workspaceId: String(intent.workspace_id),
    intentId: String(intent.intent_id),
    invocationId: String(intent.invocation_id),
    businessDate: String(intent.business_date),
    source: String(intent.source),
    rootMode: String(intent.root_mode),
    rootGeneration,
    retryInvocationOrdinal,
    predecessorRootId,
    logicalInputHash: String(intent.logical_input_hash),
  };
  return {
    rootRequestId: hashV1(preimage),
    rootInputHash: rootCanonicalInputHash(
      intent,
      rootGeneration,
      retryInvocationOrdinal,
      predecessorRootId,
    ),
    preimage,
  };
}

function orchestrationIdentity(
  intent: AnyRecord,
  rootRequestId: string,
  rootGeneration: number,
): { id: string; preimage: AnyRecord } {
  const preimage = {
    r: "orchestration/v1",
    workspaceId: String(intent.workspace_id),
    rootRequestId,
    rootGeneration,
    businessDate: String(intent.business_date),
    source: String(intent.source),
    rootMode: String(intent.root_mode),
  };
  return { id: hashV1(preimage), preimage };
}

function stageIdentity(values: {
  workspaceId: string;
  rootRequestId: string;
  orchestrationId: string;
  rootGeneration: number;
  stageFamily: string;
  stageAttemptOrdinal: number;
  retryGeneration: number;
  parentStageRequestId: string | null;
  predecessorHash: string | null;
  logicalInputHash: string;
}): { id: string; preimage: AnyRecord } {
  const preimage = { r: "stage/v1", ...values };
  return { id: hashV1(preimage), preimage };
}

function operationIdentity(values: {
  workspaceId: string;
  stageRequestId: string;
  operationKind: string;
  operationOrdinal: number;
  operationInputHash: string;
}): { id: string; preimage: AnyRecord } {
  const preimage = { r: "operation/v1", ...values };
  return { id: hashV1(preimage), preimage };
}

function childIdentity(values: {
  workspaceId: string;
  operationRequestId: string;
  effectRequestId: string | null;
  roleId: string;
  childOrdinal: number;
}): { id: string; preimage: AnyRecord } {
  const preimage = { r: "child/v1", ...values };
  return { id: hashV1(preimage), preimage };
}

function readClaimSnapshotHash(claim: AnyRecord): string | null {
  const snapshot = record(parseJson(claim.snapshot_json));
  for (const key of [
    "sourceSnapshotHash",
    "snapshotHash",
    "source_snapshot_hash",
    "snapshot_hash",
  ]) {
    const value = snapshot[key];
    if (value !== undefined && value !== null && String(value).trim())
      return String(value);
  }
  const result = record(parseJson(claim.result_json));
  for (const key of [
    "sourceSnapshotHash",
    "snapshotHash",
    "source_snapshot_hash",
    "snapshot_hash",
  ]) {
    const value = result[key];
    if (value !== undefined && value !== null && String(value).trim())
      return String(value);
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function persistedSuccessorScope(row: AnyRecord): {
  scope: AnyRecord;
  projection: AnyRecord;
  progress: AnyRecord;
  progressAfter: AnyRecord;
  pending: string[];
  invalid: string[];
  gapItemIds: string[];
  sourceSnapshotHash: string;
  scopeHash: string;
  projectionHash: string;
  gapHash: string;
} {
  const stored = record(parseJson(row.scope_json, {}));
  const scope = record(stored.scope);
  const projection = record(stored.projection ?? row.result_json);
  const progress = record(stored.progress ?? projection.progress);
  const progressAfter = record(
    progress.progressAfter ?? projection.progressAfter ?? stored.progressAfter,
  );
  const scopeHash = requireString(row.scope_hash, "predecessorScopeHash");
  const sourceSnapshotHash = requireString(
    row.source_snapshot_hash ?? scope.sourceSnapshotHash,
    "sourceSnapshotHash",
  );
  const withoutScopeHash = { ...scope };
  delete withoutScopeHash.scopeHash;
  const recomputedScopeHash = hashV1({
    r: "plan-scope/v1",
    workspaceId: String(row.workspace_id),
    stageRequestId: String(row.stage_request_id),
    rootRequestId: String(row.root_request_id),
    sourceSnapshotHash,
    bindingHash: withoutScopeHash.bindingHash ?? null,
    orderedAllowedPlanIds: stringArray(withoutScopeHash.allowedPlanIds),
    orderedAllowedItemIds: stringArray(withoutScopeHash.allowedPlanItemIds),
    orderedCarryItemIds: stringArray(withoutScopeHash.carryPlanItemIds),
    trustedReceiptIds: stringArray(withoutScopeHash.trustedReceiptIds),
    scopeJson: withoutScopeHash,
  });
  if (
    recomputedScopeHash !== scopeHash ||
    String(scope.scopeHash ?? "") !== scopeHash
  )
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "predecessor scope hash 无法由 frozen scope_json 重算。",
    );
  const withoutProjectionProgress = { ...projection };
  delete withoutProjectionProgress.projectionHash;
  delete withoutProjectionProgress.progressMeasureVersion;
  delete withoutProjectionProgress.progressOrdinal;
  delete withoutProjectionProgress.progressBefore;
  delete withoutProjectionProgress.progressAfter;
  delete withoutProjectionProgress.strictProgress;
  const projectionHash = requireString(
    projection.projectionHash,
    "predecessorProjectionHash",
  );
  const recomputedProjectionHash = hashV1({
    r: "projection/v2",
    workspaceId: String(withoutProjectionProgress.workspaceId),
    businessDate: String(withoutProjectionProgress.businessDate),
    managerTaskId: String(withoutProjectionProgress.managerTaskId),
    orchestrationId: String(withoutProjectionProgress.orchestrationId),
    stageRequestId: String(withoutProjectionProgress.stageRequestId),
    scopeHash,
    bindingHash: withoutProjectionProgress.bindingHash ?? null,
    repairSnapshotHash: withoutProjectionProgress.repairSnapshotHash ?? null,
    planIds: stringArray(withoutProjectionProgress.planIds),
    asOf: withoutProjectionProgress.asOf ?? null,
    orderedEntries: Array.isArray(withoutProjectionProgress.entries)
      ? withoutProjectionProgress.entries
      : [],
    candidatePlanItemIds: stringArray(
      withoutProjectionProgress.candidatePlanItemIds,
    ),
    eligiblePlanItemIds: stringArray(
      withoutProjectionProgress.eligiblePlanItemIds,
    ),
    pendingPlanItemIds: stringArray(
      withoutProjectionProgress.pendingPlanItemIds,
    ),
    invalidPlanItemIds: stringArray(
      withoutProjectionProgress.invalidPlanItemIds,
    ),
    trustedReceiptIds: stringArray(withoutProjectionProgress.trustedReceiptIds),
    emptyQualified: Boolean(withoutProjectionProgress.emptyQualified),
  });
  if (recomputedProjectionHash !== projectionHash)
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "predecessor projection hash 无法由 frozen scope_json 重算。",
    );
  const pending = stringArray(projection.pendingPlanItemIds);
  const invalid = stringArray(projection.invalidPlanItemIds);
  const gapItemIds = stringArray(
    progressAfter.orderedGapItemIds ?? progressAfter.gapItemIds,
  );
  const gapHash = requireString(progressAfter.gapHash, "predecessorGapHash");
  if (pending.length === 0 && invalid.length === 0)
    throw new WorkspaceOrchestratorActorError(
      "NO_CONTINUATION_MATERIAL",
      "predecessor projection 不含 pending/invalid gap。",
    );
  if (gapItemIds.length === 0 && pending.length + invalid.length > 0)
    throw new WorkspaceOrchestratorActorError(
      "CANDIDATE_REPAIR_REJECTED",
      "predecessor progress 缺少 gapItemIds。",
    );
  return {
    scope,
    projection,
    progress,
    progressAfter,
    pending,
    invalid,
    gapItemIds,
    sourceSnapshotHash,
    scopeHash,
    projectionHash,
    gapHash,
  };
}

function evidenceSuccessorIdentity(values: {
  workspaceId: string;
  rootRequestId: string;
  rootGeneration: number;
  rootInputHash: string;
  orchestrationId: string;
  retryGeneration: number;
  stageAttemptOrdinal: number;
  parentStageRequestId: string;
  predecessorScopeHash: string;
  predecessorProjectionHash: string;
  predecessorGapHash: string;
  logicalInputHash: string;
}): { id: string; preimage: AnyRecord } {
  const preimage = {
    r: "stage/v1",
    ...values,
    stageFamily: "evidence_successor",
    progressOrdinal: values.stageAttemptOrdinal,
  };
  return { id: hashV1(preimage), preimage };
}
function assertExpected(value: unknown, actual: number, field: string): void {
  if (value !== undefined && asInteger(value, -1) !== actual)
    throw new WorkspaceOrchestratorActorError(
      "STATE_CONFLICT",
      `${field} 与当前 durable revision 不一致。`,
      { expected: value, actual },
    );
}

function checkIdentitySupplied(
  input: AnyRecord,
  field: string,
  actual: string,
): void {
  if (input[field] !== undefined && String(input[field]) !== actual)
    throw new WorkspaceOrchestratorActorError(
      "REQUEST_REPLAY_CONFLICT",
      `${field} 与 canonical identity 不一致。`,
      { expected: actual, actual: input[field] },
    );
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
      /* preserve original */
    }
    throw error;
  }
}

export class WorkspaceOrchestratorRootStageStore {
  private readonly database: DatabaseSync;
  private readonly options: RootStageStoreOptions;
  private readonly crashBarrier?: WorkspaceOrchestratorCrashBarrier;

  constructor(database: DatabaseSync, options: RootStageStoreOptions = {}) {
    this.database = database;
    this.options = options;
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

  readRoot(workspaceId: string, rootRequestId: string): RootStageReadback {
    return readBundle(this.database, workspaceId, rootRequestId);
  }

  getRoot(workspaceId: string, rootRequestId: string): RootStageReadback {
    return this.readRoot(workspaceId, rootRequestId);
  }

  readStage(workspaceId: string, stageRequestId: string): AnyRecord | null {
    return (
      rowObject(readClaimRow(this.database, workspaceId, stageRequestId)) ??
      null
    );
  }

  admitRoot(input: RootAdmissionInput): RootStageResult {
    const raw = input as AnyRecord;
    const pair = nowPair(raw, this.options);
    try {
      return transaction(this.database, () => {
        const actor = requireCurrentActor(this.database, raw, pair);
        requireCompleteGate(this.database, actor);
        const workspaceId = requireString(raw.workspaceId, "workspaceId");
        const intent = readIntentRow(this.database, {
          workspaceId,
          intentId: raw.intentId ? String(raw.intentId) : undefined,
          requestId: raw.requestId ? String(raw.requestId) : undefined,
        });
        if (!intent)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "admitted intent 不存在。",
          );
        const suppliedAcceptance = acceptanceFromInput(raw);
        const intentAcceptance = acceptanceFromRow(intent, "intent");
        if (suppliedAcceptance)
          assertAcceptanceMatch(
            suppliedAcceptance,
            intentAcceptance,
            "调用方与 intent",
          );
        const intentId = String(intent.intent_id);
        const existingByIntent = this.database
          .prepare(
            "SELECT * FROM daily_orchestration_roots WHERE workspace_id=? AND intent_id=?",
          )
          .get(workspaceId, intentId) as AnyRecord | undefined;
        if (existingByIntent) {
          assertAcceptanceMatch(
            acceptanceFromRow(existingByIntent, "existing root"),
            intentAcceptance,
            "existing root 与 intent",
          );
          checkIdentitySupplied(
            raw,
            "rootRequestId",
            String(existingByIntent.root_request_id),
          );
          checkIdentitySupplied(
            raw,
            "orchestrationId",
            String(existingByIntent.orchestration_id),
          );
          const bundle = readBundle(
            this.database,
            workspaceId,
            String(existingByIntent.root_request_id),
          );
          return success("replayed", bundle, { replay: true });
        }
        if (String(intent.status) !== "admitted")
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            `intent status 必须为 admitted，当前为 ${String(intent.status)}。`,
          );
        if (!intent.preflight_id)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "admitted intent 缺少 frozen preflight。",
          );
        const preflight = this.database
          .prepare(
            "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
          )
          .get(workspaceId, String(intent.preflight_id)) as
          AnyRecord | undefined;
        if (!preflight || String(preflight.status) !== "frozen")
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root admission 需要 frozen preflight。",
          );
        if (
          String(preflight.policy_hash) !==
          String(intent.normalized_policy_hash)
        )
          throw new WorkspaceOrchestratorActorError(
            "CHANNEL_POLICY_INVALID",
            "preflight policy hash 与 intent 不一致。",
          );
        assertExpected(
          raw.expectedIntentCheckpointRevision,
          asInteger(intent.checkpoint_revision),
          "intent checkpoint",
        );
        const requestedRootMode = raw.rootMode ?? raw.root_mode;
        const requestedSource = raw.source;
        const requestedBusinessDate = raw.businessDate ?? raw.business_date;
        if (
          requestedRootMode !== undefined &&
          String(requestedRootMode) !== String(intent.root_mode)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "rootMode 与 intent 不一致。",
          );
        if (
          requestedSource !== undefined &&
          String(requestedSource) !== String(intent.source)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "source 与 intent 不一致。",
          );
        if (
          requestedBusinessDate !== undefined &&
          String(requestedBusinessDate) !== String(intent.business_date)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "businessDate 与 intent 不一致。",
          );

        const activeRoot = this.database
          .prepare(
            `SELECT * FROM daily_orchestration_roots
          WHERE workspace_id=? AND business_date=? AND root_mode=? AND source=? AND status IN ('created','running','waiting_owner')
          LIMIT 1`,
          )
          .get(
            workspaceId,
            String(intent.business_date),
            String(intent.root_mode),
            String(intent.source),
          ) as AnyRecord | undefined;
        if (activeRoot)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "同一 root domain 已有 active root。",
            { rootRequestId: activeRoot.root_request_id },
          );
        const generationRow = this.database
          .prepare(
            `SELECT COALESCE(MAX(root_generation), -1) AS generation,
            COALESCE(MAX(retry_invocation_ordinal), -1) AS retryOrdinal
          FROM daily_orchestration_roots WHERE workspace_id=? AND business_date=? AND root_mode=? AND source=?`,
          )
          .get(
            workspaceId,
            String(intent.business_date),
            String(intent.root_mode),
            String(intent.source),
          ) as AnyRecord;
        const rootGeneration = asInteger(
          raw.rootGeneration,
          asInteger(generationRow.generation, -1) + 1,
        );
        const retryInvocationOrdinal = asInteger(
          raw.retryInvocationOrdinal,
          asInteger(generationRow.retryOrdinal, -1) + 1,
        );
        if (rootGeneration < 0 || retryInvocationOrdinal < 0)
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "root generation/ordinal 非法。",
          );
        if (
          raw.rootGeneration !== undefined &&
          rootGeneration !== asInteger(generationRow.generation, -1) + 1
        )
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "rootGeneration 不是服务端下一序号。",
          );
        const predecessorRootId =
          raw.predecessorRootId === undefined || raw.predecessorRootId === null
            ? null
            : String(raw.predecessorRootId);
        if (predecessorRootId) {
          const predecessor = this.database
            .prepare(
              "SELECT status FROM daily_orchestration_roots WHERE workspace_id=? AND root_id=?",
            )
            .get(workspaceId, predecessorRootId) as AnyRecord | undefined;
          if (
            !predecessor ||
            !TERMINAL_ROOT_STATUSES.has(String(predecessor.status))
          )
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "predecessor root 必须已 terminal。",
            );
        }
        const root = rootIdentity(
          intent,
          rootGeneration,
          retryInvocationOrdinal,
          predecessorRootId,
        );
        const orchestration = orchestrationIdentity(
          intent,
          root.rootRequestId,
          rootGeneration,
        );
        const attemptStage =
          String(intent.requested_action) === "scan" ? "scan" : "full";
        const stage = stageIdentity({
          workspaceId,
          rootRequestId: root.rootRequestId,
          orchestrationId: orchestration.id,
          rootGeneration,
          stageFamily: attemptStage,
          stageAttemptOrdinal: 1,
          retryGeneration: 0,
          parentStageRequestId: null,
          predecessorHash: null,
          logicalInputHash: String(intent.logical_input_hash),
        });
        const opInputHash = operationInputHash({
          r: "reporter-operation-input/v1",
          workspaceId,
          rootRequestId: root.rootRequestId,
          rootGeneration,
          stageRequestId: stage.id,
          preflightId: String(preflight.preflight_id),
          policyHash: String(preflight.policy_hash),
          selectedChannels: parseJson(preflight.selected_channels_json, []),
        });
        const operation = operationIdentity({
          workspaceId,
          stageRequestId: stage.id,
          operationKind: "reporter",
          operationOrdinal: 1,
          operationInputHash: opInputHash,
        });
        const child = childIdentity({
          workspaceId,
          operationRequestId: operation.id,
          effectRequestId: null,
          roleId: "reporter",
          childOrdinal: 1,
        });
        checkIdentitySupplied(raw, "rootRequestId", root.rootRequestId);
        checkIdentitySupplied(raw, "orchestrationId", orchestration.id);
        checkIdentitySupplied(raw, "stageRequestId", stage.id);
        checkIdentitySupplied(raw, "operationRequestId", operation.id);
        checkIdentitySupplied(raw, "childIdentityKey", child.id);
        const managerTaskId = String(
          raw.managerTaskId ??
            hashV1({
              r: "manager/v1",
              workspaceId,
              rootRequestId: root.rootRequestId,
              orchestrationId: orchestration.id,
            }),
        );
        const rootDeadline = deadlinePair(raw, actor, pair, "root");
        const stageDeadline = deadlinePair(
          { ...raw, rootDeadlineMono: rootDeadline.mono },
          actor,
          pair,
          "stage",
        );
        const spawnDeadline = deadlinePair(
          {
            ...raw,
            rootDeadlineMono: rootDeadline.mono,
            stageDeadlineMono: stageDeadline.mono,
          },
          actor,
          pair,
          "spawn",
        );
        const nextActor = bumpActor(this.database, actor, pair);
        insertIdentity(this.database, {
          workspaceId,
          registryName: "root-invocation/v1",
          preimage: root.preimage,
          derivedValue: root.rootRequestId,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "orchestration/v1",
          preimage: orchestration.preimage,
          derivedValue: orchestration.id,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "stage/v1",
          preimage: stage.preimage,
          derivedValue: stage.id,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "operation/v1",
          preimage: operation.preimage,
          derivedValue: operation.id,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "child/v1",
          preimage: child.preimage,
          derivedValue: child.id,
          createdAt: pair.utc,
        });
        this.invokeCrashBarrier("T3", "identity_registry", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId,
          rootRequestId: root.rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "identity_registry",
        });
        this.database
          .prepare(
            `INSERT INTO daily_orchestration_roots (
          root_id, workspace_id, intent_id, preflight_id, business_date, root_mode, source,
          root_generation, root_request_id, root_input_hash, orchestration_id, manager_task_id,
          retry_invocation_ordinal, predecessor_root_id, status, checkpoint_revision, owner_epoch,
          lease_token, lease_expires_at_utc, lease_expires_at_mono, root_deadline_utc, root_deadline_mono,
          gate_deadline_utc, gate_deadline_mono, last_business_progress_at,
          acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
          created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running',
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?
        )`,
          )
          .run(
            root.rootRequestId,
            workspaceId,
            intentId,
            String(preflight.preflight_id),
            String(intent.business_date),
            String(intent.root_mode),
            String(intent.source),
            rootGeneration,
            root.rootRequestId,
            root.rootInputHash,
            orchestration.id,
            managerTaskId,
            retryInvocationOrdinal,
            predecessorRootId,
            nextActor.checkpointRevision,
            actor.ownerEpoch,
            actor.leaseToken,
            actor.leaseExpiresAtUtc,
            actor.leaseExpiresAtMono,
            rootDeadline.utc,
            rootDeadline.mono,
            actor.gateDeadlineUtc,
            actor.gateDeadlineMono,
            pair.utc,
            ...acceptanceTuple(intentAcceptance),
            pair.utc,
            pair.utc,
          );
        this.database
          .prepare(
            `INSERT INTO daily_stage_claims (
          claim_id, workspace_id, claim_kind, claim_scope_key, stage_request_id, request_id,
          root_request_id, root_generation, root_input_hash, manager_task_id, orchestration_id,
          parent_task_id, parent_stage_request_id, root_mode, attempt_stage, retry_generation,
          logical_input_hash, status, is_active, claim_revision, owner_epoch, lease_token,
          lease_expires_at_utc, lease_expires_at_mono, stage_deadline_utc, stage_deadline_mono,
          control_stall_deadline_utc, control_stall_deadline_mono, child_ids_json,
          acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
          created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
          created_at, updated_at
        ) VALUES (?, ?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'dispatching_scan', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, '[]',
          ?, ?, ?, ?, ?, ?, ?, ?
        )`,
          )
          .run(
            claimId(workspaceId, stage.id),
            workspaceId,
            `daily:${workspaceId}:${managerTaskId}:${orchestration.id}:${attemptStage}`,
            stage.id,
            operation.id,
            root.rootRequestId,
            rootGeneration,
            root.rootInputHash,
            managerTaskId,
            orchestration.id,
            managerTaskId,
            stage.id,
            String(intent.root_mode),
            attemptStage,
            String(intent.logical_input_hash),
            actor.ownerEpoch,
            actor.leaseToken,
            actor.leaseExpiresAtUtc,
            actor.leaseExpiresAtMono,
            stageDeadline.utc,
            stageDeadline.mono,
            actor.controlStallDeadlineUtc,
            actor.controlStallDeadlineMono,
            ...acceptanceTuple(intentAcceptance),
            pair.utc,
            pair.utc,
          );
        const persistedRoot = readRootRow(
          this.database,
          workspaceId,
          root.rootRequestId,
        );
        const rootAcceptance = acceptanceFromRow(persistedRoot, "root");
        assertAcceptanceMatch(
          rootAcceptance,
          intentAcceptance,
          "root 与 intent",
        );
        const envelope = record(raw.envelope ?? raw.executionEnvelope);
        const dispatch = reserveDispatch(this.database, nextActor, raw, {
          rootRequestId: root.rootRequestId,
          rootGeneration,
          rootInputHash: root.rootInputHash,
          managerTaskId,
          orchestrationId: orchestration.id,
          parentTaskId: managerTaskId,
          parentStageRequestId: stage.id,
          stageRequestId: stage.id,
          retryGeneration: 0,
          roleId: "reporter",
          childOrdinal: 1,
          operationRequestId: operation.id,
          claimRevision: 0,
          preflightId: String(preflight.preflight_id),
          policyHash: String(preflight.policy_hash),
          rootDeadline,
          stageDeadline,
          spawnDeadline,
          pair,
          envelope,
          acceptance: rootAcceptance,
          argvHash: raw.argvHash ? String(raw.argvHash) : undefined,
          cwdFingerprint: raw.cwdFingerprint
            ? String(raw.cwdFingerprint)
            : undefined,
          sessionKey: raw.sessionKey ? String(raw.sessionKey) : undefined,
        });
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET
          root_request_id=?, orchestration_id=?, status='running', checkpoint_revision=?, updated_at=?
          WHERE workspace_id=? AND intent_id=? AND status='admitted' AND checkpoint_revision=?`,
          )
          .run(
            root.rootRequestId,
            orchestration.id,
            nextActor.checkpointRevision,
            pair.utc,
            workspaceId,
            intentId,
            asInteger(intent.checkpoint_revision),
          );
        if (Number(intentUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "intent root admission CAS 失败。",
          );
        this.invokeCrashBarrier("T3", "business_rows", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId,
          rootRequestId: root.rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "business_rows",
        });
        this.database
          .prepare(
            `INSERT INTO workspace_active_root_index (
          workspace_id, root_request_id, orchestration_id, manager_task_id, root_generation, source, root_mode,
          status, terminal_reason, is_active, priority, mailbox_sequence, checkpoint_revision, index_revision,
          stage_request_id, projection_state, visible_since,
          acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
          created_after_event_sequence, created_after_checkpoint_revision, created_after_mono, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, 1, ?, ?, ?, 0, ?, 'absent',
          ?, ?, ?, ?, ?, ?, ?, ?
        )`,
          )
          .run(
            workspaceId,
            root.rootRequestId,
            orchestration.id,
            managerTaskId,
            rootGeneration,
            String(intent.source),
            String(intent.root_mode),
            asInteger(
              (
                this.database
                  .prepare(
                    "SELECT priority FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=?",
                  )
                  .get(workspaceId, intentId) as AnyRecord | undefined
              )?.priority,
              0,
            ),
            asInteger(
              (
                this.database
                  .prepare(
                    "SELECT mailbox_sequence FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=?",
                  )
                  .get(workspaceId, intentId) as AnyRecord | undefined
              )?.mailbox_sequence,
              0,
            ),
            nextActor.checkpointRevision,
            stage.id,
            pair.utc,
            ...acceptanceTuple(rootAcceptance),
            pair.utc,
          );
        this.invokeCrashBarrier("T3", "checkpoint_index", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId,
          rootRequestId: root.rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "checkpoint_index",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType: "root.created",
          causationId: hashV1({
            r: "root-created/v1",
            workspaceId,
            rootRequestId: root.rootRequestId,
          }),
          payload: {
            rootRequestId: root.rootRequestId,
            rootGeneration,
            orchestrationId: orchestration.id,
            managerTaskId,
            stageRequestId: stage.id,
            operationRequestId: operation.id,
            childIdentityKey: child.id,
            status: "running",
            projectionState: "absent",
            dispatchState: dispatch.state ?? "reserved",
          },
          occurredAtUtc: pair.utc,
          aggregateId: root.rootRequestId,
          aggregateRow: persistedRoot!,
          businessDate: String(intent.business_date),
          source: String(intent.source),
          intentId,
          invocationId: String(intent.invocation_id),
          requestId: String(intent.request_id),
          rootRequestId: root.rootRequestId,
          rootGeneration,
          orchestrationId: orchestration.id,
          managerTaskId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          parentTaskId: managerTaskId,
          jobId: dispatch.jobId
            ? String(dispatch.jobId)
            : dispatch.job_id
              ? String(dispatch.job_id)
              : null,
          claimRevision: 0,
        });
        this.invokeCrashBarrier("T3", "event_outbox", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId,
          rootRequestId: root.rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "event_outbox",
        });
        const bundle = readBundle(
          this.database,
          workspaceId,
          root.rootRequestId,
        );
        return success("admitted", bundle, {
          event,
          dispatch: bundle.dispatches[0],
          reporter: bundle.claims[0],
          claim: bundle.claims[0],
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message);
    }
  }

  handoffToJudge(input: JudgeHandoffInput): RootStageResult {
    const raw = input as AnyRecord;
    const pair = nowPair(raw, this.options);
    try {
      return transaction(this.database, () => {
        const actor = requireCurrentActor(this.database, raw, pair);
        const workspaceId = requireString(raw.workspaceId, "workspaceId");
        const rootRequestId = requireString(raw.rootRequestId, "rootRequestId");
        const root = readRootRow(this.database, workspaceId, rootRequestId);
        if (!root)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "root 不存在。",
          );
        const rootAcceptance = acceptanceFromRow(root, "root");
        const suppliedAcceptance = acceptanceFromInput(
          raw,
          "handoff provenance",
        );
        if (suppliedAcceptance)
          assertAcceptanceMatch(
            suppliedAcceptance,
            rootAcceptance,
            "调用方与 root",
          );
        const bundleBefore = readBundle(
          this.database,
          workspaceId,
          rootRequestId,
        );
        const existingJudge = bundleBefore.claims.find(
          (claim) => claim.attempt_stage === "judge",
        );
        if (existingJudge) {
          assertAcceptanceMatch(
            acceptanceFromRow(existingJudge, "existing judge claim"),
            rootAcceptance,
            "existing judge claim 与 root",
          );
          const bundle = readBundle(this.database, workspaceId, rootRequestId);
          return success("replayed", bundle, {
            judge: bundle.claims.find(
              (claim) => claim.attempt_stage === "judge",
            ),
            claim: bundle.claims.find(
              (claim) => claim.attempt_stage === "judge",
            ),
            dispatch: bundle.dispatches.find(
              (dispatch) =>
                dispatch.stage_request_id === existingJudge.stage_request_id,
            ),
          });
        }
        assertExpected(
          raw.expectedRootCheckpointRevision,
          asInteger(root.checkpoint_revision),
          "root checkpoint",
        );
        if (
          !ACTIVE_ROOT_STATUSES.has(String(root.status)) ||
          String(root.status) === "cancelled"
        )
          throw new WorkspaceOrchestratorActorError(
            "CANCELLED_BY_AUTHORIZED_SYSTEM",
            "root 已不可 handoff。",
          );
        if (
          asInteger(root.owner_epoch) !== actor.ownerEpoch ||
          String(root.lease_token) !== String(actor.leaseToken)
        )
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "root owner fence 已失效。",
          );
        const fStageRequestId = raw.stageRequestId
          ? String(raw.stageRequestId)
          : String(
              bundleBefore.claims.find(
                (claim) =>
                  claim.attempt_stage !== "judge" &&
                  Number(claim.is_active) === 1,
              )?.stage_request_id ?? "",
            );
        const fClaim = readClaimRow(
          this.database,
          workspaceId,
          fStageRequestId,
        );
        if (!fClaim)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "F claim 不存在。",
          );
        const fClaimAcceptance = acceptanceFromRow(fClaim, "F claim");
        assertAcceptanceMatch(
          fClaimAcceptance,
          rootAcceptance,
          "F claim 与 root",
        );
        assertExpected(
          raw.expectedClaimRevision,
          asInteger(fClaim.claim_revision),
          "F claim revision",
        );
        if (
          !ACTIVE_STAGE_STATUSES.has(String(fClaim.status)) ||
          !["snapshot_frozen", "awaiting_judge", "dispatching_judge"].includes(
            String(fClaim.status),
          )
        )
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "F claim 尚未达到可 handoff 状态。",
          );
        if (
          asInteger(fClaim.owner_epoch) !== actor.ownerEpoch ||
          String(fClaim.lease_token) !== String(actor.leaseToken)
        )
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "F claim owner fence 已失效。",
          );
        const sourceSnapshotHash = String(
          raw.sourceSnapshotHash ??
            raw.snapshotHash ??
            readClaimSnapshotHash(fClaim) ??
            "",
        ).trim();
        if (!sourceSnapshotHash)
          throw new WorkspaceOrchestratorActorError(
            "NO_CONTINUATION_MATERIAL",
            "F claim 缺少 frozen source snapshot。",
          );
        const sourceRow = this.database
          .prepare(
            `SELECT * FROM source_snapshots
          WHERE workspace_id=? AND stage_request_id=? AND snapshot_hash=?`,
          )
          .get(workspaceId, fStageRequestId, sourceSnapshotHash) as
          AnyRecord | undefined;
        if (
          !sourceRow ||
          String(sourceRow.status) !== "frozen" ||
          String(sourceRow.root_request_id) !== rootRequestId ||
          asInteger(sourceRow.root_generation, -1) !==
            asInteger(root.root_generation, -2)
        ) {
          throw new WorkspaceOrchestratorActorError(
            "SOURCE_SNAPSHOT_STALE",
            "handoff 需要当前 frozen source snapshot。",
          );
        }
        const frozenSelectedChannels = parseJson(
          sourceRow.selected_channel_ids_json,
          [],
        );
        const frozenSuccessfulChannels = parseJson(
          sourceRow.successful_channels_json,
          [],
        );
        validateCurrentChannelFences({
          profileRevision: asInteger(sourceRow.profile_revision, -1),
          policyHash: String(sourceRow.policy_hash ?? ""),
          selectedChannelIds: Array.isArray(frozenSelectedChannels)
            ? frozenSelectedChannels.map((entry) => String(entry))
            : [],
          frozenChannels: Array.isArray(frozenSuccessfulChannels)
            ? frozenSuccessfulChannels.map((entry) => record(entry))
            : [],
          currentChannelFences: raw.currentChannelFences as
            | readonly AnyRecord[]
            | Readonly<Record<string, AnyRecord>>
            | undefined,
          nowMono: pair.mono,
        });
        const intent = root.intent_id
          ? (this.database
              .prepare(
                "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
              )
              .get(workspaceId, String(root.intent_id)) as
              AnyRecord | undefined)
          : undefined;
        if (!intent)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root intent 不存在。",
          );
        const intentAcceptance = acceptanceFromRow(intent, "intent");
        assertAcceptanceMatch(
          rootAcceptance,
          intentAcceptance,
          "root 与 intent",
        );
        const preflightId = String(
          root.preflight_id ?? intent.preflight_id ?? "",
        );
        const preflight = this.database
          .prepare(
            "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
          )
          .get(workspaceId, preflightId) as AnyRecord | undefined;
        if (!preflight || String(preflight.status) !== "frozen")
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "handoff 需要 frozen preflight。",
          );
        const rootGeneration = asInteger(root.root_generation);
        const orchestrationId = String(root.orchestration_id);
        const stage = stageIdentity({
          workspaceId,
          rootRequestId,
          orchestrationId,
          rootGeneration,
          stageFamily: "judge",
          stageAttemptOrdinal: 2,
          retryGeneration: 0,
          parentStageRequestId: fStageRequestId,
          predecessorHash: sourceSnapshotHash,
          logicalInputHash: String(intent.logical_input_hash),
        });
        const opInputHash = operationInputHash({
          r: "judge-operation-input/v1",
          workspaceId,
          rootRequestId,
          rootGeneration,
          stageRequestId: stage.id,
          predecessorStageRequestId: fStageRequestId,
          sourceSnapshotHash,
          preflightId,
          policyHash: String(preflight.policy_hash),
        });
        const operation = operationIdentity({
          workspaceId,
          stageRequestId: stage.id,
          operationKind: "judge",
          operationOrdinal: 1,
          operationInputHash: opInputHash,
        });
        const child = childIdentity({
          workspaceId,
          operationRequestId: operation.id,
          effectRequestId: null,
          roleId: "judge",
          childOrdinal: 1,
        });
        checkIdentitySupplied(raw, "judgeStageRequestId", stage.id);
        checkIdentitySupplied(raw, "operationRequestId", operation.id);
        checkIdentitySupplied(raw, "childIdentityKey", child.id);
        const managerTaskId = String(root.manager_task_id);
        const rootDeadline = {
          utc: String(root.root_deadline_utc),
          mono: asNumber(root.root_deadline_mono),
        };
        const stageDeadline = deadlinePair(
          { ...raw, rootDeadlineMono: rootDeadline.mono },
          actor,
          pair,
          "stage",
        );
        const spawnDeadline = deadlinePair(
          {
            ...raw,
            rootDeadlineMono: rootDeadline.mono,
            stageDeadlineMono: stageDeadline.mono,
          },
          actor,
          pair,
          "spawn",
        );
        const oldClaimRevision = asInteger(fClaim.claim_revision);
        const nextClaimRevision = oldClaimRevision + 1;
        const nextActor = bumpActor(this.database, actor, pair);
        insertIdentity(this.database, {
          workspaceId,
          registryName: "stage/v1",
          preimage: stage.preimage,
          derivedValue: stage.id,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "operation/v1",
          preimage: operation.preimage,
          derivedValue: operation.id,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "child/v1",
          preimage: child.preimage,
          derivedValue: child.id,
          createdAt: pair.utc,
        });
        this.invokeCrashBarrier("T5", "identity_registry", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "identity_registry",
        });
        const fUpdate = this.database
          .prepare(
            `UPDATE daily_stage_claims SET
          status='succeeded', is_active=0, claim_revision=?, result_json=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND stage_request_id=? AND status IN ('snapshot_frozen','awaiting_judge','dispatching_judge')
            AND is_active=1 AND claim_revision=? AND owner_epoch=? AND lease_token=?`,
          )
          .run(
            nextClaimRevision,
            canonicalJsonV1({
              status: "succeeded",
              reasonCode: "HANDOFF_CONSUMED",
              sourceSnapshotHash,
              handoffStageRequestId: stage.id,
            }),
            pair.utc,
            pair.utc,
            workspaceId,
            fStageRequestId,
            oldClaimRevision,
            actor.ownerEpoch,
            actor.leaseToken,
          );
        if (Number(fUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "F handoff CAS 失败。",
          );
        this.database
          .prepare(
            `INSERT INTO daily_stage_claims (
          claim_id, workspace_id, claim_kind, claim_scope_key, stage_request_id, request_id,
          root_request_id, root_generation, root_input_hash, manager_task_id, orchestration_id,
          parent_task_id, parent_stage_request_id, root_mode, attempt_stage, retry_generation,
          logical_input_hash, status, is_active, claim_revision, owner_epoch, lease_token,
          lease_expires_at_utc, lease_expires_at_mono, stage_deadline_utc, stage_deadline_mono,
          control_stall_deadline_utc, control_stall_deadline_mono, snapshot_json, child_ids_json,
          acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
          created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
          created_at, updated_at
        ) VALUES (?, ?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'judge', 0, ?, 'dispatching_judge', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]',
          ?, ?, ?, ?, ?, ?, ?, ?
        )`,
          )
          .run(
            claimId(workspaceId, stage.id),
            workspaceId,
            `daily:${workspaceId}:${managerTaskId}:${orchestrationId}:judge`,
            stage.id,
            operation.id,
            rootRequestId,
            rootGeneration,
            String(root.root_input_hash),
            managerTaskId,
            orchestrationId,
            managerTaskId,
            fStageRequestId,
            String(root.root_mode),
            String(intent.logical_input_hash),
            actor.ownerEpoch,
            actor.leaseToken,
            actor.leaseExpiresAtUtc,
            actor.leaseExpiresAtMono,
            stageDeadline.utc,
            stageDeadline.mono,
            actor.controlStallDeadlineUtc,
            actor.controlStallDeadlineMono,
            canonicalJsonV1({
              sourceSnapshotHash,
              predecessorStageRequestId: fStageRequestId,
            }),
            ...acceptanceTuple(fClaimAcceptance),
            pair.utc,
            pair.utc,
          );
        const judgeClaim = readClaimRow(this.database, workspaceId, stage.id);
        const judgeAcceptance = acceptanceFromRow(judgeClaim, "judge claim");
        assertAcceptanceMatch(
          judgeAcceptance,
          fClaimAcceptance,
          "judge claim 与 F claim",
        );
        assertAcceptanceMatch(
          judgeAcceptance,
          rootAcceptance,
          "judge claim 与 root",
        );
        const dispatch = reserveDispatch(this.database, nextActor, raw, {
          rootRequestId,
          rootGeneration,
          rootInputHash: String(root.root_input_hash),
          managerTaskId,
          orchestrationId,
          parentTaskId: managerTaskId,
          parentStageRequestId: fStageRequestId,
          stageRequestId: stage.id,
          retryGeneration: 0,
          roleId: "judge",
          childOrdinal: 1,
          operationRequestId: operation.id,
          claimRevision: nextClaimRevision,
          preflightId,
          policyHash: String(preflight.policy_hash),
          rootDeadline,
          stageDeadline,
          spawnDeadline,
          pair,
          envelope: record(raw.envelope ?? raw.executionEnvelope),
          acceptance: judgeAcceptance,
          argvHash: raw.argvHash ? String(raw.argvHash) : undefined,
          cwdFingerprint: raw.cwdFingerprint
            ? String(raw.cwdFingerprint)
            : undefined,
          sessionKey: raw.sessionKey ? String(raw.sessionKey) : undefined,
        });
        this.invokeCrashBarrier("T5", "business_rows", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "business_rows",
        });
        const rootUpdate = this.database
          .prepare(
            `UPDATE daily_orchestration_roots SET
          checkpoint_revision=?, updated_at=?, last_business_progress_at=?
          WHERE workspace_id=? AND root_request_id=? AND status IN ('created','running','waiting_owner')
            AND checkpoint_revision=? AND owner_epoch=? AND lease_token=?`,
          )
          .run(
            nextActor.checkpointRevision,
            pair.utc,
            pair.utc,
            workspaceId,
            rootRequestId,
            asInteger(root.checkpoint_revision),
            actor.ownerEpoch,
            actor.leaseToken,
          );
        if (Number(rootUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root handoff CAS 失败。",
          );
        const persistedRoot = readRootRow(
          this.database,
          workspaceId,
          rootRequestId,
        );
        const persistedRootAcceptance = acceptanceFromRow(
          persistedRoot,
          "handoff event root",
        );
        assertAcceptanceMatch(
          persistedRootAcceptance,
          rootAcceptance,
          "handoff event root 与 root",
        );
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET status='running', checkpoint_revision=?, updated_at=?
          WHERE workspace_id=? AND intent_id=? AND status IN ('admitted','running','waiting_resource') AND checkpoint_revision=?`,
          )
          .run(
            nextActor.checkpointRevision,
            pair.utc,
            workspaceId,
            String(intent.intent_id),
            asInteger(intent.checkpoint_revision),
          );
        if (Number(intentUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "intent handoff CAS 失败。",
          );
        const index = this.database
          .prepare(
            `UPDATE workspace_active_root_index SET
          status='running', is_active=1, checkpoint_revision=?, index_revision=index_revision+1,
          stage_request_id=?, updated_at=?
          WHERE workspace_id=? AND root_request_id=? AND is_active=1 AND index_revision=?
            AND checkpoint_revision=?`,
          )
          .run(
            nextActor.checkpointRevision,
            stage.id,
            pair.utc,
            workspaceId,
            rootRequestId,
            asInteger(bundleBefore.index?.index_revision),
            asInteger(root.checkpoint_revision),
          );
        if (Number(index.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "active root index handoff CAS 失败。",
          );
        this.invokeCrashBarrier("T5", "checkpoint_index", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "checkpoint_index",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType: "scan.handoff_consumed",
          causationId: hashV1({
            r: "scan-handoff/v1",
            workspaceId,
            rootRequestId,
            predecessorStageRequestId: fStageRequestId,
          }),
          payload: {
            rootRequestId,
            predecessorStageRequestId: fStageRequestId,
            stageRequestId: stage.id,
            operationRequestId: operation.id,
            childIdentityKey: child.id,
            sourceSnapshotHash,
            status: "dispatching_judge",
          },
          occurredAtUtc: pair.utc,
          aggregateId: rootRequestId,
          aggregateRow: persistedRoot!,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId: String(root.intent_id),
          invocationId: intent.invocation_id
            ? String(intent.invocation_id)
            : null,
          requestId: String(intent.request_id),
          rootRequestId,
          rootGeneration,
          orchestrationId,
          managerTaskId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          parentTaskId: managerTaskId,
          jobId: dispatch.jobId
            ? String(dispatch.jobId)
            : dispatch.job_id
              ? String(dispatch.job_id)
              : null,
          claimRevision: 0,
          snapshotHash: sourceSnapshotHash,
        });
        this.invokeCrashBarrier("T5", "event_outbox", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          operationRequestId: operation.id,
          phaseBoundary: "event_outbox",
        });
        const bundle = readBundle(this.database, workspaceId, rootRequestId);
        return success("handoff", bundle, {
          event,
          judge: bundle.claims.find(
            (claim) => claim.stage_request_id === stage.id,
          ),
          claim: bundle.claims.find(
            (claim) => claim.stage_request_id === stage.id,
          ),
          dispatch: bundle.dispatches.find(
            (item) => item.stage_request_id === stage.id,
          ),
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message);
    }
  }

  createEvidenceSuccessor(input: EvidenceSuccessorInput): RootStageResult {
    const raw = input as AnyRecord;
    const pair = nowPair(raw, this.options);
    try {
      return transaction(this.database, () => {
        const actor = requireCurrentActor(this.database, raw, pair);
        const workspaceId = requireString(raw.workspaceId, "workspaceId");
        const rootRequestId = requireString(raw.rootRequestId, "rootRequestId");
        const root = readRootRow(this.database, workspaceId, rootRequestId);
        if (!root)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "root 不存在。",
          );
        const before = readBundle(this.database, workspaceId, rootRequestId);
        if (String(root.status) !== "running")
          return failure(
            "STATE_CONFLICT",
            "evidence successor 仅允许从 active running root 创建。",
            before,
          );
        assertExpected(
          raw.expectedRootCheckpointRevision,
          asInteger(root.checkpoint_revision),
          "root checkpoint",
        );
        if (
          asInteger(root.owner_epoch) !== actor.ownerEpoch ||
          String(root.lease_token) !== String(actor.leaseToken)
        )
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "root owner fence 已失效。",
          );
        if (
          (root.lease_expires_at_mono !== null &&
            pair.mono >= asNumber(root.lease_expires_at_mono)) ||
          (root.root_deadline_mono !== null &&
            pair.mono >= asNumber(root.root_deadline_mono))
        )
          throw new WorkspaceOrchestratorActorError(
            "MANAGER_WALL_CLOCK",
            "root successor deadline 已到期。",
          );
        const rootAcceptance = acceptanceFromRow(root, "root");
        const suppliedAcceptance = acceptanceFromInput(
          raw,
          "successor provenance",
        );
        if (suppliedAcceptance)
          assertAcceptanceMatch(
            suppliedAcceptance,
            rootAcceptance,
            "调用方与 root",
          );
        const intent = root.intent_id
          ? (this.database
              .prepare(
                "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
              )
              .get(workspaceId, String(root.intent_id)) as
              AnyRecord | undefined)
          : undefined;
        if (!intent)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root intent 不存在。",
          );
        assertAcceptanceMatch(
          acceptanceFromRow(intent, "intent"),
          rootAcceptance,
          "root 与 intent",
        );
        if (
          [
            "succeeded",
            "partial",
            "failed",
            "needs_user",
            "cancelled",
          ].includes(String(intent.status))
        )
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "terminal intent 不可创建 evidence successor。",
          );

        const predecessorScopeId = requireString(
          raw.predecessorScopeId,
          "predecessorScopeId",
        );
        const predecessorScopeHash = requireString(
          raw.predecessorScopeHash,
          "predecessorScopeHash",
        );
        const predecessorScope = this.database
          .prepare(
            `SELECT * FROM daily_plan_scopes
          WHERE workspace_id=? AND scope_id=? AND scope_hash=?`,
          )
          .get(workspaceId, predecessorScopeId, predecessorScopeHash) as
          AnyRecord | undefined;
        if (
          !predecessorScope ||
          String(predecessorScope.scope_status) !== "frozen"
        )
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor scope 必须 frozen。",
          );
        if (
          String(predecessorScope.root_request_id) !== rootRequestId ||
          asInteger(predecessorScope.root_generation, -1) !==
            asInteger(root.root_generation, -2) ||
          String(predecessorScope.root_input_hash) !==
            String(root.root_input_hash)
        )
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor scope 不属于当前 root lineage。",
          );
        assertAcceptanceMatch(
          acceptanceFromRow(predecessorScope, "predecessor scope"),
          rootAcceptance,
          "predecessor scope 与 root",
        );
        const predecessorStageRequestId = requireString(
          raw.predecessorStageRequestId ?? predecessorScope.stage_request_id,
          "predecessorStageRequestId",
        );
        if (
          predecessorStageRequestId !==
          String(predecessorScope.stage_request_id)
        )
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor stage 与 scope 不一致。",
          );
        const predecessorStage = readClaimRow(
          this.database,
          workspaceId,
          predecessorStageRequestId,
        );
        if (
          !predecessorStage ||
          String(predecessorStage.root_request_id) !== rootRequestId ||
          asInteger(predecessorStage.root_generation, -1) !==
            asInteger(root.root_generation, -2) ||
          String(predecessorStage.root_input_hash) !==
            String(root.root_input_hash)
        )
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor stage 不属于当前 root lineage。",
          );
        assertAcceptanceMatch(
          acceptanceFromRow(predecessorStage, "predecessor stage"),
          rootAcceptance,
          "predecessor stage 与 root",
        );
        if (
          !TERMINAL_STAGE_STATUSES.has(String(predecessorStage.status)) ||
          Number(predecessorStage.is_active) !== 0
        )
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "predecessor stage 必须 terminal 且未 active。",
          );
        assertExpected(
          raw.expectedClaimRevision,
          asInteger(predecessorStage.claim_revision),
          "predecessor claim revision",
        );
        const predecessorStageSnapshot = record(
          parseJson(predecessorStage.snapshot_json, {}),
        );
        const predecessorStageFamily = String(
          predecessorStageSnapshot.stageFamily ??
            predecessorStageSnapshot.stage_family ??
            "",
        );
        const persisted = persistedSuccessorScope(predecessorScope);
        if (
          raw.predecessorProjectionHash !== undefined &&
          String(raw.predecessorProjectionHash) !== persisted.projectionHash
        )
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor projection hash 不一致。",
          );
        if (
          raw.predecessorGapHash !== undefined &&
          String(raw.predecessorGapHash) !== persisted.gapHash
        )
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor gap hash 不一致。",
          );
        const sourceSnapshotHash = String(
          raw.sourceSnapshotHash ?? persisted.sourceSnapshotHash,
        );
        if (sourceSnapshotHash !== persisted.sourceSnapshotHash)
          throw new WorkspaceOrchestratorActorError(
            "SOURCE_SNAPSHOT_STALE",
            "successor source snapshot hash 不一致。",
          );
        const source = this.database
          .prepare(
            `SELECT * FROM source_snapshots WHERE workspace_id=? AND snapshot_hash=?`,
          )
          .get(workspaceId, sourceSnapshotHash) as AnyRecord | undefined;
        if (
          !source ||
          String(source.status) !== "frozen" ||
          String(source.root_request_id) !== rootRequestId ||
          asInteger(source.root_generation, -1) !==
            asInteger(root.root_generation, -2)
        )
          throw new WorkspaceOrchestratorActorError(
            "SOURCE_SNAPSHOT_STALE",
            "successor source snapshot lineage 无效。",
          );
        const predecessorProgress = record(persisted.progress);
        const priorOrdinalValue =
          predecessorProgress.progressOrdinal ??
          persisted.projection.progressOrdinal ??
          0;
        const priorOrdinal = asInteger(priorOrdinalValue, -1);
        if (priorOrdinal < 0)
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "predecessor progressOrdinal 非法。",
          );
        const requestedOrdinalValue =
          raw.progressOrdinal ??
          raw.evidenceSuccessorOrdinal ??
          raw.successorOrdinal;
        const nextOrdinal =
          requestedOrdinalValue === undefined
            ? priorOrdinal + 1
            : asInteger(requestedOrdinalValue, -1);
        const maxSuccessors = Math.min(
          2,
          raw.maxEvidenceSuccessors === undefined
            ? 2
            : asInteger(raw.maxEvidenceSuccessors, -1),
        );
        if (nextOrdinal < 1 || nextOrdinal > 2 || nextOrdinal > maxSuccessors)
          throw new WorkspaceOrchestratorActorError(
            "EVIDENCE_SUCCESSOR_LIMIT",
            "evidence successor 已达到硬上限 2。",
          );
        if (priorOrdinal !== nextOrdinal - 1)
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "successor progressOrdinal 必须连续。",
          );
        if (priorOrdinal > 0 && predecessorProgress.strictProgress !== true)
          throw new WorkspaceOrchestratorActorError(
            "CANDIDATE_REPAIR_REJECTED",
            "successor predecessor 必须已经 strict progress。",
          );
        if (priorOrdinal === 0) {
          if (String(source.stage_request_id) !== predecessorStageRequestId)
            throw new WorkspaceOrchestratorActorError(
              "SOURCE_SNAPSHOT_STALE",
              "ordinal1 source snapshot 必须绑定 predecessor stage。",
            );
        } else {
          const sourceHashFromStage = String(
            predecessorStageSnapshot.sourceSnapshotHash ??
              predecessorStageSnapshot.source_snapshot_hash ??
              "",
          );
          const sourceStageRequestId = String(
            predecessorStageSnapshot.sourceSnapshotStageRequestId ??
              predecessorStageSnapshot.source_snapshot_stage_request_id ??
              "",
          );
          const parentStageRequestId = String(
            predecessorStage.parent_stage_request_id ?? "",
          );
          const snapshotParentStageRequestId = String(
            predecessorStageSnapshot.predecessorStageRequestId ??
              predecessorStageSnapshot.predecessor_stage_request_id ??
              "",
          );
          const stageOrdinal = asInteger(
            predecessorStageSnapshot.progressOrdinal ??
              predecessorStageSnapshot.progress_ordinal,
            -1,
          );
          if (
            predecessorStageFamily !== "evidence_successor" ||
            sourceHashFromStage !== sourceSnapshotHash ||
            sourceStageRequestId !== String(source.stage_request_id) ||
            !parentStageRequestId ||
            parentStageRequestId === predecessorStageRequestId ||
            snapshotParentStageRequestId !== parentStageRequestId ||
            stageOrdinal !== priorOrdinal
          )
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor predecessor parent/source/ordinal chain 无效。",
            );
          const parentStage = readClaimRow(
            this.database,
            workspaceId,
            parentStageRequestId,
          );
          if (
            !parentStage ||
            String(parentStage.root_request_id) !== rootRequestId ||
            asInteger(parentStage.root_generation, -1) !==
              asInteger(root.root_generation, -2) ||
            String(parentStage.root_input_hash) !== String(root.root_input_hash)
          )
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor parent stage lineage 无效。",
            );
          const parentMetadata = record(
            parseJson(parentStage.snapshot_json, {}),
          );
          const parentOrdinal = asInteger(
            parentMetadata.progressOrdinal ??
              parentMetadata.progress_ordinal ??
              0,
            -1,
          );
          if (parentOrdinal !== priorOrdinal - 1)
            throw new WorkspaceOrchestratorActorError(
              "CANDIDATE_REPAIR_REJECTED",
              "successor parent ordinal 链无效。",
            );
        }

        const existingSuccessor = this.database
          .prepare(
            `SELECT * FROM daily_stage_claims
          WHERE workspace_id=? AND root_request_id=? AND parent_stage_request_id=?
            AND attempt_stage='research' ORDER BY rowid ASC LIMIT 1`,
          )
          .get(workspaceId, rootRequestId, predecessorStageRequestId) as
          AnyRecord | undefined;
        if (existingSuccessor) {
          const existingMeta = record(
            parseJson(existingSuccessor.snapshot_json, {}),
          );
          if (
            String(existingMeta.stageFamily ?? "") !== "evidence_successor" ||
            asInteger(existingMeta.progressOrdinal, -1) !== nextOrdinal ||
            String(existingMeta.predecessorScopeHash ?? "") !==
              persisted.scopeHash ||
            String(existingMeta.predecessorProjectionHash ?? "") !==
              persisted.projectionHash ||
            String(existingMeta.predecessorGapHash ?? "") !== persisted.gapHash
          )
            throw new WorkspaceOrchestratorActorError(
              "REQUEST_REPLAY_CONFLICT",
              "predecessor 已绑定不同 successor identity。",
            );
          return success("replayed", before, {
            replay: true,
            successor: existingSuccessor,
            claim: existingSuccessor,
            stage: existingSuccessor,
            progressOrdinal: nextOrdinal,
          });
        }

        const logicalInputHash = String(
          raw.logicalInputHash ?? intent.logical_input_hash ?? "",
        );
        if (!logicalInputHash)
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "successor logicalInputHash 不得为空。",
          );
        if (
          raw.rootGeneration !== undefined &&
          asInteger(raw.rootGeneration, -1) !==
            asInteger(root.root_generation, -2)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "rootGeneration 与 root 不一致。",
          );
        if (
          raw.rootInputHash !== undefined &&
          String(raw.rootInputHash) !== String(root.root_input_hash)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "rootInputHash 与 root 不一致。",
          );
        if (
          raw.managerTaskId !== undefined &&
          String(raw.managerTaskId) !== String(root.manager_task_id)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "managerTaskId 与 root 不一致。",
          );
        if (
          raw.orchestrationId !== undefined &&
          String(raw.orchestrationId) !== String(root.orchestration_id)
        )
          throw new WorkspaceOrchestratorActorError(
            "REQUEST_REPLAY_CONFLICT",
            "orchestrationId 与 root 不一致。",
          );
        const rootGeneration = asInteger(root.root_generation);
        const rootInputHash = String(root.root_input_hash);
        const orchestrationId = String(root.orchestration_id);
        const stage = evidenceSuccessorIdentity({
          workspaceId,
          rootRequestId,
          rootGeneration,
          rootInputHash,
          orchestrationId,
          retryGeneration: 0,
          stageAttemptOrdinal: nextOrdinal,
          parentStageRequestId: predecessorStageRequestId,
          predecessorScopeHash: persisted.scopeHash,
          predecessorProjectionHash: persisted.projectionHash,
          predecessorGapHash: persisted.gapHash,
          logicalInputHash,
        });
        checkIdentitySupplied(raw, "stageRequestId", stage.id);
        const existingByIdentity = readClaimRow(
          this.database,
          workspaceId,
          stage.id,
        );
        if (existingByIdentity) {
          if (
            String(existingByIdentity.root_request_id) !== rootRequestId ||
            String(existingByIdentity.attempt_stage) !== "research"
          )
            throw new WorkspaceOrchestratorActorError(
              "REQUEST_REPLAY_CONFLICT",
              "successor stage identity 已绑定其他 lineage。",
            );
          return success("replayed", before, {
            replay: true,
            successor: existingByIdentity,
            claim: existingByIdentity,
            stage: existingByIdentity,
            progressOrdinal: nextOrdinal,
          });
        }
        const rootDeadline = {
          utc: String(root.root_deadline_utc),
          mono: asNumber(root.root_deadline_mono),
        };
        const stageDeadline = deadlinePair(
          { ...raw, rootDeadlineMono: rootDeadline.mono },
          actor,
          pair,
          "stage",
        );
        const nextAction = {
          kind: "auto_bounded_successor_or_stop",
          reasonCode: String(
            persisted.projection.reasonCode ?? "SCORING_INCOMPLETE",
          ),
          rootRequestId,
          stageRequestId: stage.id,
          predecessorStageRequestId,
          predecessorScopeId,
          scopeHash: persisted.scopeHash,
          projectionHash: persisted.projectionHash,
          gapHash: persisted.gapHash,
          pendingPlanItemIds: persisted.pending,
          invalidPlanItemIds: persisted.invalid,
          gapItemIds: persisted.gapItemIds,
          progressMeasureVersion: 2,
          progressOrdinal: nextOrdinal,
          progressBefore: persisted.progressAfter,
          maxEvidenceSuccessors: maxSuccessors,
        };
        const claimSnapshot = {
          stageFamily: "evidence_successor",
          progressMeasureVersion: 2,
          progressOrdinal: nextOrdinal,
          predecessorStageRequestId,
          predecessorScopeId,
          predecessorScopeHash: persisted.scopeHash,
          predecessorProjectionHash: persisted.projectionHash,
          predecessorGapHash: persisted.gapHash,
          sourceSnapshotHash,
          sourceSnapshotStageRequestId: String(source.stage_request_id),
          gapItemIds: persisted.gapItemIds,
          pendingPlanItemIds: persisted.pending,
          invalidPlanItemIds: persisted.invalid,
          logicalInputHash,
        };
        const nextActor = bumpActor(this.database, actor, pair);
        insertIdentity(this.database, {
          workspaceId,
          registryName: "stage/v1",
          preimage: stage.preimage,
          derivedValue: stage.id,
          createdAt: pair.utc,
        });
        this.invokeCrashBarrier("T5", "identity_registry", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          phaseBoundary: "identity_registry",
        });
        const acceptance = rootAcceptance;
        this.database
          .prepare(
            `INSERT INTO daily_stage_claims (
          claim_id, workspace_id, claim_kind, claim_scope_key, stage_request_id, request_id,
          root_request_id, root_generation, root_input_hash, manager_task_id, orchestration_id,
          parent_task_id, parent_stage_request_id, root_mode, attempt_stage, retry_generation,
          logical_input_hash, status, is_active, claim_revision, owner_epoch, lease_token,
          lease_expires_at_utc, lease_expires_at_mono, stage_deadline_utc, stage_deadline_mono,
          control_stall_deadline_utc, control_stall_deadline_mono, snapshot_json, child_ids_json,
          acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
          created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
          created_at, updated_at
        ) VALUES (?, ?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'research', 0, ?, 'claimed', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            claimId(workspaceId, stage.id),
            workspaceId,
            `daily:${workspaceId}:${String(root.manager_task_id)}:${orchestrationId}:evidence_successor:${nextOrdinal}`,
            stage.id,
            stage.id,
            rootRequestId,
            rootGeneration,
            rootInputHash,
            String(root.manager_task_id),
            orchestrationId,
            String(root.manager_task_id),
            predecessorStageRequestId,
            String(root.root_mode),
            logicalInputHash,
            nextActor.ownerEpoch,
            nextActor.leaseToken,
            nextActor.leaseExpiresAtUtc,
            nextActor.leaseExpiresAtMono,
            stageDeadline.utc,
            stageDeadline.mono,
            nextActor.controlStallDeadlineUtc,
            nextActor.controlStallDeadlineMono,
            canonicalJsonV1(claimSnapshot),
            ...acceptanceTuple(acceptance),
            pair.utc,
            pair.utc,
          );
        const successorClaim = readClaimRow(
          this.database,
          workspaceId,
          stage.id,
        );
        if (!successorClaim)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "successor claim 插入后无法读回。",
          );
        assertAcceptanceMatch(
          acceptanceFromRow(successorClaim, "successor claim"),
          rootAcceptance,
          "successor claim 与 root",
        );
        this.invokeCrashBarrier("T5", "business_rows", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          phaseBoundary: "business_rows",
        });
        const rootUpdate = this.database
          .prepare(
            `UPDATE daily_orchestration_roots SET status='running', checkpoint_revision=?, last_business_progress_at=?, updated_at=?, finished_at=NULL
          WHERE workspace_id=? AND root_request_id=? AND checkpoint_revision=? AND owner_epoch=? AND lease_token=? AND status IN ('created','running','waiting_owner')`,
          )
          .run(
            nextActor.checkpointRevision,
            pair.utc,
            pair.utc,
            workspaceId,
            rootRequestId,
            asInteger(root.checkpoint_revision),
            actor.ownerEpoch,
            actor.leaseToken,
          );
        if (Number(rootUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "successor root CAS 失败。",
          );
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET status='running', checkpoint_revision=?, next_action_json=?, stop_reason_json=NULL, updated_at=?, finished_at=NULL
          WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=? AND status IN ('admitted','running','waiting_resource','waiting_owner')`,
          )
          .run(
            nextActor.checkpointRevision,
            canonicalJsonV1(nextAction),
            pair.utc,
            workspaceId,
            String(intent.intent_id),
            asInteger(intent.checkpoint_revision),
          );
        if (Number(intentUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "successor intent CAS 失败。",
          );
        const index = this.database
          .prepare(
            `UPDATE workspace_active_root_index SET status='running', terminal_reason=NULL, is_active=1,
          checkpoint_revision=?, index_revision=index_revision+1, stage_request_id=?, projection_state='absent',
          scope_hash=NULL, projection_hash=NULL, eligible_ids_hash=NULL, next_action=?, updated_at=?
          WHERE workspace_id=? AND root_request_id=? AND index_revision=? AND checkpoint_revision=?`,
          )
          .run(
            nextActor.checkpointRevision,
            stage.id,
            canonicalJsonV1(nextAction),
            pair.utc,
            workspaceId,
            rootRequestId,
            asInteger(before.index?.index_revision, -1),
            asInteger(root.checkpoint_revision),
          );
        if (Number(index.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "successor active-root index CAS 失败。",
          );
        this.invokeCrashBarrier("T5", "checkpoint_index", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          phaseBoundary: "checkpoint_index",
        });
        const persistedRoot = readRootRow(
          this.database,
          workspaceId,
          rootRequestId,
        );
        const event = appendEvent(this.database, nextActor, {
          eventType: "evidence.successor.created",
          causationId: hashV1({
            r: "evidence-successor-created/v1",
            workspaceId,
            rootRequestId,
            stageRequestId: stage.id,
            predecessorStageRequestId,
            progressOrdinal: nextOrdinal,
          }),
          payload: {
            ...claimSnapshot,
            rootRequestId,
            rootGeneration,
            rootInputHash,
            orchestrationId,
            managerTaskId: String(root.manager_task_id),
            stageRequestId: stage.id,
            attemptStage: "research",
            nextAction,
          },
          occurredAtUtc: pair.utc,
          aggregateId: rootRequestId,
          aggregateRow: persistedRoot!,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId: String(root.intent_id),
          invocationId: intent.invocation_id
            ? String(intent.invocation_id)
            : null,
          requestId: intent.request_id ? String(intent.request_id) : null,
          rootRequestId,
          rootGeneration,
          orchestrationId,
          managerTaskId: String(root.manager_task_id),
          stageRequestId: stage.id,
          parentTaskId: predecessorStageRequestId,
          claimRevision: 0,
          snapshotHash: sourceSnapshotHash,
          scopeHash: persisted.scopeHash,
          projectionHash: persisted.projectionHash,
        });
        this.invokeCrashBarrier("T5", "event_outbox", {
          workspaceId,
          requestId: String(intent.request_id),
          intentId: String(intent.intent_id),
          rootRequestId,
          stageRequestId: stage.id,
          phaseBoundary: "event_outbox",
        });
        const bundle = readBundle(this.database, workspaceId, rootRequestId);
        const row = bundle.claims.find(
          (claim) => String(claim.stage_request_id) === stage.id,
        );
        return success("successor_created", bundle, {
          event,
          successor: row,
          claim: row,
          stage: row,
          progressOrdinal: nextOrdinal,
          stageIdentity: stage.preimage,
          sourceSnapshotHash,
          predecessorScopeId,
          predecessorScopeHash,
          predecessorProjectionHash: persisted.projectionHash,
          predecessorGapHash: persisted.gapHash,
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message);
    }
  }

  cancelRoot(input: RootCancelInput): RootStageResult {
    const raw = input as AnyRecord;
    const pair = nowPair(raw, this.options);
    try {
      return transaction(this.database, () => {
        const actor = requireCurrentActor(this.database, raw, pair);
        const workspaceId = requireString(raw.workspaceId, "workspaceId");
        const rootRequestId = requireString(raw.rootRequestId, "rootRequestId");
        const root = readRootRow(this.database, workspaceId, rootRequestId);
        if (!root)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "root 不存在。",
          );
        const rootAcceptance = acceptanceFromRow(root, "root");
        const suppliedAcceptance = acceptanceFromInput(
          raw,
          "cancel provenance",
        );
        if (suppliedAcceptance)
          assertAcceptanceMatch(
            suppliedAcceptance,
            rootAcceptance,
            "调用方与 root",
          );
        const before = readBundle(this.database, workspaceId, rootRequestId);
        const reasonCode =
          String(
            raw.reasonCode ?? raw.reason ?? "CANCELLED_BY_AUTHORIZED_SYSTEM",
          ).trim() || "CANCELLED_BY_AUTHORIZED_SYSTEM";
        const cancellationPreimage = {
          r: "cancellation-settlement/v1",
          workspaceId,
          rootRequestId,
          rootGeneration: asInteger(root.root_generation),
          rootInputHash: String(root.root_input_hash),
          reasonCode,
        };
        const cancellationHash = hashV1(cancellationPreimage);
        if (String(root.status) === "cancelled") {
          const priorReason =
            before.index?.terminal_reason === undefined ||
            before.index?.terminal_reason === null
              ? null
              : String(before.index.terminal_reason).trim() || null;
          if (priorReason && priorReason !== reasonCode) {
            return failure(
              "TERMINAL_IMMUTABILITY_CONFLICT",
              "cancelled root 的 terminal reason 不可改写。",
              before,
            );
          }
          return success("replayed", before, {
            replay: true,
            reasonCode: priorReason ?? reasonCode,
            cancellationHash,
          });
        }
        if (!ACTIVE_ROOT_STATUSES.has(String(root.status)))
          return failure("STATE_CONFLICT", "terminal root 不可取消。", before);
        assertExpected(
          raw.expectedRootCheckpointRevision,
          asInteger(root.checkpoint_revision),
          "root checkpoint",
        );
        if (
          asInteger(root.owner_epoch) !== actor.ownerEpoch ||
          String(root.lease_token) !== String(actor.leaseToken)
        )
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "root owner fence 已失效。",
          );
        const intent = root.intent_id
          ? (this.database
              .prepare(
                "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
              )
              .get(workspaceId, String(root.intent_id)) as
              AnyRecord | undefined)
          : undefined;
        if (!intent)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root intent 不存在。",
          );
        const intentAcceptance = acceptanceFromRow(intent, "intent");
        assertAcceptanceMatch(
          rootAcceptance,
          intentAcceptance,
          "root 与 intent",
        );
        const claims = this.database
          .prepare(
            `SELECT * FROM daily_stage_claims WHERE workspace_id=? AND root_request_id=? AND is_active=1`,
          )
          .all(workspaceId, rootRequestId) as AnyRecord[];
        const dispatches = this.database
          .prepare(
            `SELECT * FROM managed_job_dispatches WHERE workspace_id=? AND root_request_id=?
          AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')`,
          )
          .all(workspaceId, rootRequestId) as AnyRecord[];
        const consumptions = this.database
          .prepare(
            `SELECT * FROM managed_effect_consumptions WHERE workspace_id=? AND root_request_id=?
          AND state IN ('reserved','consuming','unknown')`,
          )
          .all(workspaceId, rootRequestId) as AnyRecord[];
        const buildingScopes = this.database
          .prepare(
            `SELECT * FROM daily_plan_scopes WHERE workspace_id=? AND root_request_id=? AND scope_status='building'`,
          )
          .all(workspaceId, rootRequestId) as AnyRecord[];
        const mailboxRows = intent
          ? (this.database
              .prepare(
                `SELECT * FROM orchestrator_mailbox WHERE workspace_id=? AND intent_id=? AND state IN ('enqueued','claimed')`,
              )
              .all(workspaceId, String(intent.intent_id)) as AnyRecord[])
          : [];
        const nextActor = bumpActor(this.database, actor, pair);
        this.invokeCrashBarrier("T8", "identity_registry", {
          workspaceId,
          rootRequestId,
          intentId: String(intent.intent_id),
          requestId: intent.request_id ? String(intent.request_id) : undefined,
          phaseBoundary: "identity_registry",
        });
        insertIdentity(this.database, {
          workspaceId,
          registryName: "cancellation-settlement/v1",
          preimage: cancellationPreimage,
          derivedValue: cancellationHash,
          createdAt: pair.utc,
        });
        const rootUpdate = this.database
          .prepare(
            `UPDATE daily_orchestration_roots SET status='cancelled', checkpoint_revision=?, last_business_progress_at=?,
            lease_expires_at_utc=?, lease_expires_at_mono=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND root_request_id=? AND status IN ('created','running','waiting_owner')
            AND checkpoint_revision=? AND owner_epoch=? AND lease_token=?`,
          )
          .run(
            nextActor.checkpointRevision,
            pair.utc,
            pair.utc,
            pair.mono,
            pair.utc,
            pair.utc,
            workspaceId,
            rootRequestId,
            asInteger(root.checkpoint_revision),
            actor.ownerEpoch,
            actor.leaseToken,
          );
        if (Number(rootUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root cancel CAS 失败。",
          );
        const persistedRoot = readRootRow(
          this.database,
          workspaceId,
          rootRequestId,
        );
        const persistedRootAcceptance = acceptanceFromRow(
          persistedRoot,
          "cancel event root",
        );
        assertAcceptanceMatch(
          persistedRootAcceptance,
          rootAcceptance,
          "cancel event root 与 root",
        );
        for (const claim of claims) {
          assertAcceptanceMatch(
            acceptanceFromRow(claim, "cancel claim"),
            rootAcceptance,
            "cancel claim 与 root",
          );
          const claimStatus =
            asInteger(claim.owner_epoch) === actor.ownerEpoch &&
            String(claim.lease_token) === String(actor.leaseToken)
              ? "cancelled"
              : "orphaned";
          const terminalHash = hashV1({
            r: "claim-cancellation/v1",
            workspaceId,
            rootRequestId,
            stageRequestId: String(claim.stage_request_id),
            status: claimStatus,
            reasonCode,
          });
          const resultJson = canonicalJsonV1({
            status: claimStatus,
            reasonCode,
            terminalReason: reasonCode,
            terminalHash,
          });
          const claimUpdate = this.database
            .prepare(
              `UPDATE daily_stage_claims SET status=?, is_active=0, claim_revision=claim_revision+1,
            lease_expires_at=?, lease_expires_at_utc=?, lease_expires_at_mono=?, result_json=?, updated_at=?, finished_at=?
            WHERE workspace_id=? AND stage_request_id=? AND is_active=1 AND claim_revision=?
              AND status NOT IN ('succeeded','skipped','partial','failed','needs_user','cancelled','orphaned')`,
            )
            .run(
              claimStatus,
              pair.utc,
              pair.utc,
              pair.mono,
              resultJson,
              pair.utc,
              pair.utc,
              workspaceId,
              String(claim.stage_request_id),
              asInteger(claim.claim_revision),
            );
          if (Number(claimUpdate.changes ?? 0) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "stage cancel CAS 失败。",
            );
        }
        for (const dispatch of dispatches) {
          assertAcceptanceMatch(
            acceptanceFromRow(dispatch, "cancel dispatch"),
            rootAcceptance,
            "cancel dispatch 与 root",
          );
          const dispatchState =
            asInteger(dispatch.owner_epoch) === actor.ownerEpoch &&
            String(dispatch.lease_token) === String(actor.leaseToken)
              ? "cancelled"
              : "orphaned";
          const terminalValue = {
            status: dispatchState,
            reasonCode,
            terminalReason: reasonCode,
          };
          const resultHash = hashV1({
            status: dispatchState,
            result: terminalValue,
          });
          const dispatchUpdate = this.database
            .prepare(
              `UPDATE managed_job_dispatches SET state=?, result_status=?, result_hash=?, result_json=?,
              lease_expires_at_utc=?, lease_expires_at_mono=?, updated_at=?, finished_at=?
            WHERE workspace_id=? AND job_id=? AND state IN ('reserved','task_bound','spawn_uncertain','spawn_started','running')`,
            )
            .run(
              dispatchState,
              dispatchState,
              resultHash,
              canonicalJsonV1({ ...terminalValue, resultHash }),
              pair.utc,
              pair.mono,
              pair.utc,
              pair.utc,
              workspaceId,
              String(dispatch.job_id),
            );
          if (Number(dispatchUpdate.changes ?? 0) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "dispatch cancel CAS 失败。",
            );
        }
        for (const consumption of consumptions) {
          assertAcceptanceMatch(
            acceptanceFromRow(consumption, "cancel consumption"),
            rootAcceptance,
            "cancel consumption 与 root",
          );
          const consumptionState =
            asInteger(consumption.owner_epoch) === actor.ownerEpoch &&
            String(consumption.lease_token) === String(actor.leaseToken)
              ? "cancelled"
              : "orphaned";
          const terminalHash = hashV1({
            r: "consumption-cancellation/v1",
            workspaceId,
            rootRequestId,
            consumptionId: String(consumption.consumption_id),
            state: consumptionState,
            reasonCode,
          });
          const errorJson = canonicalJsonV1({
            status: consumptionState,
            reasonCode,
            terminalReason: reasonCode,
            terminalHash,
          });
          const consumptionUpdate = this.database
            .prepare(
              `UPDATE managed_effect_consumptions SET state=?, consumption_revision=consumption_revision+1,
              outcome_query_key=NULL, outcome_hash=NULL, error_json=?, unknown_since=NULL, lease_expires_at_utc=?, lease_expires_at_mono=?,
              updated_at=?, finished_at=?
            WHERE workspace_id=? AND consumption_id=? AND consumption_revision=? AND state IN ('reserved','consuming','unknown')`,
            )
            .run(
              consumptionState,
              errorJson,
              pair.utc,
              pair.mono,
              pair.utc,
              pair.utc,
              workspaceId,
              String(consumption.consumption_id),
              asInteger(consumption.consumption_revision),
            );
          if (Number(consumptionUpdate.changes ?? 0) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "effect consumption cancel CAS 失败。",
            );
        }
        for (const scope of buildingScopes) {
          const terminalHash = hashV1({
            r: "scope-cancellation/v1",
            workspaceId,
            rootRequestId,
            stageRequestId: String(scope.stage_request_id),
            scopeHash: String(scope.scope_hash),
            reasonCode,
          });
          const scopeJson = canonicalJsonV1({
            ...record(parseJson(scope.scope_json, {})),
            cancellation: { status: "cancelled", reasonCode, terminalHash },
          });
          const scopeUpdate = this.database
            .prepare(
              `UPDATE daily_plan_scopes SET scope_status='cancelled', scope_json=?, lease_expires_at_utc=?, lease_expires_at_mono=?,
              updated_at=?, finished_at=?
            WHERE workspace_id=? AND stage_request_id=? AND scope_status='building' AND scope_hash=?`,
            )
            .run(
              scopeJson,
              pair.utc,
              pair.mono,
              pair.utc,
              pair.utc,
              workspaceId,
              String(scope.stage_request_id),
              String(scope.scope_hash),
            );
          if (Number(scopeUpdate.changes ?? 0) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "building PlanScope cancel CAS 失败。",
            );
        }
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET status='cancelled', checkpoint_revision=?, stop_reason_json=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND intent_id=? AND status IN ('received','preflight_pending','preflight_running','waiting_resource','admitted','running','waiting_owner')
            AND checkpoint_revision=?`,
          )
          .run(
            nextActor.checkpointRevision,
            canonicalJsonV1({
              reasonCode,
              terminalReason: reasonCode,
              cancellationHash,
            }),
            pair.utc,
            pair.utc,
            workspaceId,
            String(intent.intent_id),
            asInteger(intent.checkpoint_revision),
          );
        if (Number(intentUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "intent cancel CAS 失败。",
          );
        const mailboxUpdate = this.database
          .prepare(
            `UPDATE orchestrator_mailbox SET state='cancelled', finished_at_utc=?, finished_at_mono=?
          WHERE workspace_id=? AND intent_id=? AND state IN ('enqueued','claimed')`,
          )
          .run(pair.utc, pair.mono, workspaceId, String(intent.intent_id));
        if (Number(mailboxUpdate.changes ?? 0) !== mailboxRows.length)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "mailbox cancel CAS 失败。",
          );
        this.invokeCrashBarrier("T8", "business_rows", {
          workspaceId,
          rootRequestId,
          intentId: String(intent.intent_id),
          requestId: intent.request_id ? String(intent.request_id) : undefined,
          phaseBoundary: "business_rows",
        });
        const indexBefore = before.index;
        if (indexBefore) {
          const indexUpdate = this.database
            .prepare(
              `UPDATE workspace_active_root_index SET status='cancelled', terminal_reason=?, is_active=0,
              checkpoint_revision=?, index_revision=index_revision+1, updated_at=?
            WHERE workspace_id=? AND root_request_id=? AND is_active=1 AND index_revision=? AND checkpoint_revision=?`,
            )
            .run(
              reasonCode,
              nextActor.checkpointRevision,
              pair.utc,
              workspaceId,
              rootRequestId,
              asInteger(indexBefore.index_revision),
              asInteger(root.checkpoint_revision),
            );
          if (Number(indexUpdate.changes ?? 0) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "active root index cancel CAS 失败。",
            );
        }
        this.invokeCrashBarrier("T8", "checkpoint_index", {
          workspaceId,
          rootRequestId,
          intentId: String(intent.intent_id),
          requestId: intent.request_id ? String(intent.request_id) : undefined,
          phaseBoundary: "checkpoint_index",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType: "root.cancelled",
          causationId: hashV1({
            r: "root-cancelled/v2",
            workspaceId,
            rootRequestId,
            cancellationHash,
          }),
          payload: {
            rootRequestId,
            reasonCode,
            cancellationHash,
            status: "cancelled",
            claimsCancelled: claims.length,
            dispatchesCancelled: dispatches.length,
            consumptionsCancelled: consumptions.length,
            buildingScopesCancelled: buildingScopes.length,
            mailboxRowsCancelled: mailboxRows.length,
          },
          occurredAtUtc: pair.utc,
          aggregateId: rootRequestId,
          aggregateRow: persistedRoot!,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId: String(root.intent_id),
          invocationId: intent?.invocation_id
            ? String(intent.invocation_id)
            : null,
          requestId: intent?.request_id ? String(intent.request_id) : null,
          rootRequestId,
          rootGeneration: asInteger(root.root_generation),
          orchestrationId: String(root.orchestration_id),
          managerTaskId: String(root.manager_task_id),
          stageRequestId: indexBefore?.stage_request_id
            ? String(indexBefore.stage_request_id)
            : null,
        });
        this.invokeCrashBarrier("T8", "event_outbox", {
          workspaceId,
          rootRequestId,
          intentId: String(intent.intent_id),
          requestId: intent.request_id ? String(intent.request_id) : undefined,
          phaseBoundary: "event_outbox",
        });
        const bundle = readBundle(this.database, workspaceId, rootRequestId);
        return success("cancelled", bundle, {
          event,
          reasonCode,
          cancellationHash,
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message);
    }
  }

  settleStage(input: StageSettlementInput): RootStageResult {
    const raw = input as AnyRecord;
    const pair = nowPair(raw, this.options);
    try {
      return transaction(this.database, () => {
        const actor = requireCurrentActor(this.database, raw, pair);
        const workspaceId = requireString(raw.workspaceId, "workspaceId");
        const stageRequestId = requireString(
          raw.stageRequestId,
          "stageRequestId",
        );
        const claim = readClaimRow(this.database, workspaceId, stageRequestId);
        if (!claim)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "stage claim 不存在。",
          );
        const rootRequestId = String(claim.root_request_id ?? "");
        const root = readRootRow(this.database, workspaceId, rootRequestId);
        if (!root)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "stage parent root 不存在。",
          );
        const rootAcceptance = acceptanceFromRow(root, "root");
        const claimAcceptance = acceptanceFromRow(claim, "claim");
        assertAcceptanceMatch(claimAcceptance, rootAcceptance, "claim 与 root");
        const suppliedAcceptance = acceptanceFromInput(
          raw,
          "settlement provenance",
        );
        if (suppliedAcceptance)
          assertAcceptanceMatch(
            suppliedAcceptance,
            claimAcceptance,
            "调用方与 claim",
          );
        const before = readBundle(this.database, workspaceId, rootRequestId);
        if (TERMINAL_STAGE_STATUSES.has(String(claim.status))) {
          return success("replayed", before, {
            claim: rowObject(claim),
            stage: rowObject(claim),
            replay: true,
          });
        }
        assertExpected(
          raw.expectedClaimRevision,
          asInteger(claim.claim_revision),
          "stage claim revision",
        );
        if (!ACTIVE_STAGE_STATUSES.has(String(claim.status)))
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            `stage claim 不可 settle: ${String(claim.status)}`,
          );
        if (
          asInteger(claim.owner_epoch) !== actor.ownerEpoch ||
          String(claim.lease_token) !== String(actor.leaseToken)
        )
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "stage claim owner fence 已失效。",
          );
        const status = String(
          raw.status ?? raw.terminalStatus ?? raw.resultStatus ?? "",
        ).trim() as StageTerminalStatus;
        if (
          ![
            "succeeded",
            "skipped",
            "partial",
            "failed",
            "needs_user",
            "cancelled",
          ].includes(status)
        )
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            `非法 stage terminal status: ${status}`,
          );
        const reasonCode = String(
          raw.reasonCode ??
            raw.reason ??
            (status === "succeeded"
              ? "STAGE_SUCCEEDED"
              : status === "skipped"
                ? "NO_CURRENT_TARGETS"
                : status === "cancelled"
                  ? "CANCELLED_BY_AUTHORIZED_SYSTEM"
                  : "STAGE_TERMINAL"),
        ).trim();
        const resultValue =
          raw.resultJson !== undefined ? raw.resultJson : raw.result;
        const resultHash = hashV1({
          r: "stage-result/v1",
          workspaceId,
          stageRequestId,
          status,
          reasonCode,
          result: resultValue ?? null,
        });
        const settlementPreimage = {
          r: "settlement/v1",
          workspaceId,
          stageRequestId,
          orderedTerminalResults: [
            { stageRequestId, status, reasonCode, resultHash },
          ],
          consumptionResults: [],
          projectionHash: raw.projectionHash ?? null,
          effectSetHash: null,
        };
        const settlementHash = hashV1(settlementPreimage);
        const requestedRootStatus =
          raw.rootStatus === undefined || raw.rootStatus === null
            ? undefined
            : (String(raw.rootStatus) as RootStageStatus);
        const keepRootRunning =
          raw.keepRootRunning === true ||
          requestedRootStatus === "running" ||
          (String(claim.attempt_stage) !== "judge" &&
            reasonCode === "HANDOFF_CONSUMED");
        let nextRootStatus: RootStageStatus;
        if (keepRootRunning) nextRootStatus = "running";
        else if (requestedRootStatus) nextRootStatus = requestedRootStatus;
        else if (status === "cancelled") nextRootStatus = "cancelled";
        else if (status === "succeeded" || status === "skipped")
          nextRootStatus = "succeeded";
        else nextRootStatus = status as RootStageStatus;
        if (
          ![
            "created",
            "running",
            "waiting_owner",
            "succeeded",
            "partial",
            "failed",
            "needs_user",
            "cancelled",
          ].includes(nextRootStatus)
        )
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "非法 root terminal status。",
          );
        if (
          nextRootStatus === "waiting_owner" &&
          (!raw.nextAction || typeof raw.nextAction !== "object")
        )
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "waiting_owner 必须带 nextAction。",
          );
        const nextActor = bumpActor(this.database, actor, pair);
        insertIdentity(this.database, {
          workspaceId,
          registryName: "settlement/v1",
          preimage: settlementPreimage,
          derivedValue: settlementHash,
          createdAt: pair.utc,
        });
        const nextClaimRevision = asInteger(claim.claim_revision) + 1;
        const claimUpdate = this.database
          .prepare(
            `UPDATE daily_stage_claims SET status=?, is_active=0, claim_revision=?, result_json=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND stage_request_id=? AND status IN ('claimed_unbound','claimed','dispatching_scan','snapshot_frozen','awaiting_judge','dispatching_judge','manifest_frozen','dispatching','settling','running')
            AND is_active=1 AND claim_revision=? AND owner_epoch=? AND lease_token=?`,
          )
          .run(
            status,
            nextClaimRevision,
            canonicalJsonV1({
              status,
              reasonCode,
              result: resultValue ?? null,
              resultHash,
              settlementHash,
            }),
            pair.utc,
            pair.utc,
            workspaceId,
            stageRequestId,
            asInteger(claim.claim_revision),
            actor.ownerEpoch,
            actor.leaseToken,
          );
        if (Number(claimUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "stage settlement CAS 失败。",
          );
        const rootTerminal = TERMINAL_ROOT_STATUSES.has(nextRootStatus);
        const rootUpdate = this.database
          .prepare(
            `UPDATE daily_orchestration_roots SET status=?, checkpoint_revision=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND root_request_id=? AND status IN ('created','running','waiting_owner')
            AND checkpoint_revision=? AND owner_epoch=? AND lease_token=?`,
          )
          .run(
            nextRootStatus,
            nextActor.checkpointRevision,
            pair.utc,
            rootTerminal ? pair.utc : null,
            workspaceId,
            rootRequestId,
            asInteger(root.checkpoint_revision),
            actor.ownerEpoch,
            actor.leaseToken,
          );
        if (Number(rootUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root settlement CAS 失败。",
          );
        const persistedRoot = readRootRow(
          this.database,
          workspaceId,
          rootRequestId,
        );
        const persistedRootAcceptance = acceptanceFromRow(
          persistedRoot,
          "settlement event root",
        );
        assertAcceptanceMatch(
          persistedRootAcceptance,
          rootAcceptance,
          "settlement event root 与 root",
        );
        const intent = root.intent_id
          ? (this.database
              .prepare(
                "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
              )
              .get(workspaceId, String(root.intent_id)) as
              AnyRecord | undefined)
          : undefined;
        if (!intent)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "root intent 不存在。",
          );
        const intentAcceptance = acceptanceFromRow(intent, "intent");
        assertAcceptanceMatch(
          rootAcceptance,
          intentAcceptance,
          "root 与 intent",
        );
        const nextAction =
          raw.nextAction === undefined ? null : canonicalJsonV1(raw.nextAction);
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET status=?, checkpoint_revision=?, next_action_json=?, stop_reason_json=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND intent_id=? AND status IN ('admitted','running','waiting_owner','waiting_resource') AND checkpoint_revision=?`,
          )
          .run(
            nextRootStatus,
            nextActor.checkpointRevision,
            nextAction,
            canonicalJsonV1({ reasonCode, settlementHash }),
            pair.utc,
            rootTerminal ? pair.utc : null,
            workspaceId,
            String(intent.intent_id),
            asInteger(intent.checkpoint_revision),
          );
        if (Number(intentUpdate.changes ?? 0) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "intent settlement CAS 失败。",
          );
        const indexBefore = before.index;
        if (indexBefore) {
          const projectionState = raw.projectionState
            ? String(raw.projectionState)
            : String(indexBefore.projection_state ?? "absent");
          const projectionHash =
            raw.projectionHash === undefined
              ? null
              : raw.projectionHash === null
                ? null
                : String(raw.projectionHash);
          const scopeHash =
            raw.scopeHash === undefined
              ? null
              : raw.scopeHash === null
                ? null
                : String(raw.scopeHash);
          const eligibleIdsHash =
            raw.eligibleIdsHash === undefined
              ? null
              : raw.eligibleIdsHash === null
                ? null
                : String(raw.eligibleIdsHash);
          if (
            projectionState === "frozen" &&
            (!scopeHash || !projectionHash || !eligibleIdsHash)
          )
            throw new WorkspaceOrchestratorActorError(
              "PLAN_SCOPE_MISMATCH",
              "frozen projection 缺少 scope/projection/eligible hash。",
            );
          if (
            projectionState !== "frozen" &&
            (scopeHash || projectionHash || eligibleIdsHash)
          )
            throw new WorkspaceOrchestratorActorError(
              "PLAN_SCOPE_MISMATCH",
              "非 frozen projection 不得携带 projection hashes。",
            );
          const indexUpdate = this.database
            .prepare(
              `UPDATE workspace_active_root_index SET status=?, terminal_reason=?, is_active=?,
            checkpoint_revision=?, index_revision=index_revision+1, stage_request_id=?, projection_state=?, scope_hash=?, projection_hash=?, eligible_ids_hash=?, next_action=?, updated_at=?
            WHERE workspace_id=? AND root_request_id=? AND index_revision=? AND checkpoint_revision=?`,
            )
            .run(
              nextRootStatus,
              rootTerminal ? reasonCode : null,
              rootTerminal ? 0 : 1,
              nextActor.checkpointRevision,
              stageRequestId,
              projectionState,
              scopeHash,
              projectionHash,
              eligibleIdsHash,
              nextAction,
              pair.utc,
              workspaceId,
              rootRequestId,
              asInteger(indexBefore.index_revision),
              asInteger(root.checkpoint_revision),
            );
          if (Number(indexUpdate.changes ?? 0) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "active root index settlement CAS 失败。",
            );
        }
        const event = appendEvent(this.database, nextActor, {
          eventType: "settlement.committed",
          causationId: hashV1({
            r: "settlement-event/v1",
            workspaceId,
            stageRequestId,
            settlementHash,
          }),
          payload: {
            rootRequestId,
            stageRequestId,
            status,
            reasonCode,
            resultHash,
            settlementHash,
            rootStatus: nextRootStatus,
            nextAction: raw.nextAction ?? null,
          },
          occurredAtUtc: pair.utc,
          aggregateId: rootRequestId,
          aggregateRow: persistedRoot!,
          businessDate: String(root.business_date),
          source: String(root.source),
          intentId: String(root.intent_id),
          invocationId: intent.invocation_id
            ? String(intent.invocation_id)
            : null,
          requestId: intent.request_id ? String(intent.request_id) : null,
          rootRequestId,
          rootGeneration: asInteger(root.root_generation),
          orchestrationId: String(root.orchestration_id),
          managerTaskId: String(root.manager_task_id),
          stageRequestId,
          operationRequestId: String(claim.request_id),
          parentTaskId: claim.parent_task_id
            ? String(claim.parent_task_id)
            : null,
          claimRevision: nextClaimRevision,
          scopeHash: raw.scopeHash ? String(raw.scopeHash) : null,
          projectionHash: raw.projectionHash
            ? String(raw.projectionHash)
            : null,
        });
        const bundle = readBundle(this.database, workspaceId, rootRequestId);
        return success(nextRootStatus, bundle, {
          event,
          claim: bundle.claims.find(
            (item) => item.stage_request_id === stageRequestId,
          ),
          stage: bundle.claims.find(
            (item) => item.stage_request_id === stageRequestId,
          ),
          settlementHash,
          resultHash,
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message);
    }
  }
}

export function createWorkspaceOrchestratorRootStageStore(
  database: DatabaseSync,
  options: RootStageStoreOptions = {},
): WorkspaceOrchestratorRootStageStore {
  return new WorkspaceOrchestratorRootStageStore(database, options);
}
