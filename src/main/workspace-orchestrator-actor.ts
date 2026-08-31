import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  isWorkspaceOrchestratorCrashInjectedError,
  invokeWorkspaceOrchestratorCrashBarrier,
  type CrashBarrierBundle,
  type CrashBarrierContext,
  type CrashBarrierPhase,
  type WorkspaceOrchestratorCrashBarrier,
} from "./workspace-orchestrator-crash-barrier.ts";

/**
 * Durable control-plane primitives for the WMB-5367 foundation.
 *
 * This module deliberately owns only the pre-root boundary.  It does not
 * create roots, stage claims, managed jobs, or projections.  Every write is
 * made inside an explicit BEGIN IMMEDIATE transaction and every business
 * mutation first verifies the current actor fence.
 */

export type Requiredness = "required" | "optional";
export type ActorStatus = "active" | "stopping" | "failed";
export type StartupGateStatus =
  "pending" | "running" | "complete" | "maintenance" | "failed";
export type IntentTerminalStatus =
  "succeeded" | "partial" | "failed" | "needs_user" | "cancelled";

export type ActorFence = Readonly<{
  workspaceId: string;
  runtimeEpoch: number;
  ownerEpoch: number;
  authorityRevision: number;
  leaseToken: string;
  checkpointRevision?: number;
}>;
export type AcceptanceProvenance = Readonly<{
  acceptanceRunId: string;
  baselineEventSequence: number;
  baselineCheckpointRevision: number;
  createdAfterEventSequence: number;
  createdAfterCheckpointRevision: number;
  createdAfterMono: number;
}>;

type NormalizedAcceptance = Readonly<{
  value: AcceptanceProvenance | null;
  supplied: boolean;
}>;

const ACCEPTANCE_FIELDS = Object.freeze([
  "acceptanceRunId",
  "baselineEventSequence",
  "baselineCheckpointRevision",
  "createdAfterEventSequence",
  "createdAfterCheckpointRevision",
  "createdAfterMono",
] as const);

const ACCEPTANCE_DB_FIELDS = Object.freeze([
  "acceptance_run_id",
  "baseline_event_sequence",
  "baseline_checkpoint_revision",
  "created_after_event_sequence",
  "created_after_checkpoint_revision",
  "created_after_mono",
] as const);

type AcceptanceSqlValues = [
  string | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export type WorkspaceOrchestratorActor = Readonly<{
  workspaceId: string;
  actorStatus: ActorStatus;
  runtimeEpoch: number;
  ownerEpoch: number;
  authorityRevision: number;
  leaseToken: string | null;
  leaseExpiresAtUtc: string | null;
  leaseExpiresAtMono: number | null;
  controlStallDeadlineUtc: string | null;
  controlStallDeadlineMono: number | null;
  gateDeadlineUtc: string | null;
  gateDeadlineMono: number | null;
  invocationOrdinal: number;
  mailboxSequence: number;
  checkpointRevision: number;
  migrationEpoch: number;
  writeFence: "allow" | "deny" | "maintenance";
  currentBuildId: string;
  lastBusinessProgressAt: string | null;
  acceptance?: AcceptanceProvenance | null;
  createdAt: string;
  updatedAt: string;
}>;

export type StartupReconcileGate = Readonly<{
  workspaceId: string;
  runtimeEpoch: number;
  ownerEpoch: number;
  leaseToken: string;
  leaseExpiresAtUtc: string;
  leaseExpiresAtMono: number;
  gateDeadlineUtc: string;
  gateDeadlineMono: number;
  checkpointRevision: number;
  status: StartupGateStatus;
  reason: string | null;
  finishedAtUtc: string | null;
  finishedAtMono: number | null;
}>;

export type NormalizedChannelPolicy = Readonly<{
  channelId: string;
  requiredness: Requiredness;
  module: string | null;
}>;

export type ProducerAttestationInput = Readonly<{
  producerId: string;
  registryEntryHash: string;
  censusHash: string;
  triggerId: string;
  processId: string;
  processStartTimeUtc: string;
  processStartTimeMono: number;
  processImagePath: string;
  resourcesPath: string;
  buildId: string;
  sourceCommit: string;
  packageHash: string;
  appAsarHash: string;
  schemaEpoch: number;
  cutoverEpoch: number;
  runtimeEpoch: number;
  writePrincipal: string;
  authorizerRevision: string;
  producerAttestationHash?: string;
}>;

export type AcquireActorInput = Readonly<{
  workspaceId: string;
  currentBuildId?: string;
  buildId?: string;
  leaseToken?: string;
  ownerId?: string;
  runtimeId?: string;
  nowUtc?: string;
  nowMono?: number;
  leaseExpiresAtUtc?: string;
  leaseExpiresAtMono?: number;
  gateDeadlineUtc?: string;
  gateDeadlineMono?: number;
  controlStallDeadlineUtc?: string;
  controlStallDeadlineMono?: number;
  rootDeadlineMono?: number | null;
  stageDeadlineMono?: number | null;
  migrationEpoch?: number;
  writeFence?: "allow" | "deny" | "maintenance";
  causationId?: string;
  acceptance?: unknown;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
}>;

export type AcquireActorSuccess = Readonly<{
  ok: true;
  status: "acquired" | "taken_over";
  actor: WorkspaceOrchestratorActor;
  fence: ActorFence;
  gate: StartupReconcileGate | null;
  eventSequence: number;
  eventId: string;
  outboxId: string;
}>;

export type AcquireActorFailure = Readonly<{
  ok: false;
  code: string;
  reasonCode: string;
  message: string;
  actor?: WorkspaceOrchestratorActor | null;
  readback?: unknown;
}>;

export type AcquireActorResult = AcquireActorSuccess | AcquireActorFailure;

export type StartupGateInput = Readonly<{
  workspaceId: string;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  status?: StartupGateStatus;
  reason?: string | null;
  nowUtc?: string;
  nowMono?: number;
}>;

export type StartupGateResult = Readonly<{
  ok: boolean;
  code?: string;
  reasonCode?: string;
  message?: string;
  gate?: StartupReconcileGate | null;
  eventSequence?: number;
  eventId?: string;
  outboxId?: string;
}>;

export type WorkspaceIntentInput = Readonly<{
  workspaceId: string;
  businessDate: string;
  source:
    | "today_ui"
    | "proposal_ui"
    | "mcp"
    | "scheduler_0900"
    | "rolling_scan"
    | "content_cycle"
    | "orphan_reconcile";
  rootMode: "owner" | "scheduler";
  requestedAction:
    | "full"
    | "scan"
    | "judge"
    | "stage_d"
    | "approve_candidates"
    | "repair_required_channel"
    | "configure_optional_channels"
    | "select_channel"
    | "repair_invalid_candidate"
    | "cancel_root"
    | "start_new_intent";
  requestId: string;
  producer?: string;
  producerId?: string;
  producerAttestation?: ProducerAttestationInput;
  attestation?: ProducerAttestationInput;
  logicalInput?: unknown;
  payload?: unknown;
  input?: unknown;
  channelPolicy?: unknown;
  authorizedChannelPolicy?: unknown;
  profileRevision?: number;
  priority?: number;
  expiresAtUtc?: string;
  expiresAtMono?: number;
  coalescingKey?: string | null;
  coalescingMode?: "none" | "equivalent_scheduler_work";
  causationId?: string;
  command?: string;
  budget?: unknown;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
  acceptance?: unknown;
  predecessorIntentId?: string | null;
  predecessorRootId?: string | null;
  nowUtc?: string;
  nowMono?: number;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
}>;

export type WorkspaceOrchestratorReceipt = Readonly<{
  version: "WorkspaceOrchestratorReceiptV1";
  receiptId: string;
  ok: boolean;
  status: "accepted" | "rejected";
  code: string | null;
  reasonCode: string | null;
  message: string | null;
  workspaceId: string;
  runtimeEpoch: number;
  ownerEpoch: number;
  authorityRevision: number;
  requestId: string;
  command: string;
  commandReplayKey: string;
  logicalInputHash: string;
  payloadHash: string;
  producerAttestationHash: string | null;
  intentId: string | null;
  invocationId: string | null;
  mailboxSequence: number | null;
  checkpointRevision: number;
  acceptance?: AcceptanceProvenance | null;
  readback: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type IntentAcceptResult = WorkspaceOrchestratorReceipt &
  Readonly<{ receipt: WorkspaceOrchestratorReceipt }>;

export type ChannelPreflightResultInput = Readonly<{
  channelId?: string;
  status?: string | boolean;
  reasonCode?: string | null;
  reason?: string | null;
  requiredness?: Requiredness;
  capability?: unknown;
  configRevision?: number | null;
  authRevision?: number | null;
  capabilityRevision?: number | null;
  capabilityLeaseId?: string | null;
  checkedAtUtc?: string | null;
  expiresAtUtc?: string | null;
  expiresAtMono?: number | null;
  probeRequestId?: string | null;
  probeReceiptHash?: string | null;
  [key: string]: unknown;
}>;

export type ClosePreflightInput = Readonly<{
  workspaceId: string;
  intentId?: string;
  requestId?: string;
  profileRevision?: number;
  policyHash?: string;
  preflightVersion?: number;
  channelResults:
    | readonly ChannelPreflightResultInput[]
    | Readonly<Record<string, Omit<ChannelPreflightResultInput, "channelId">>>;
  aggregateDeadlineUtc?: string | null;
  aggregateDeadlineMono?: number | null;
  nowUtc?: string;
  nowMono?: number;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  acceptance?: unknown;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
}>;

export type PreflightSnapshotReadback = Readonly<{
  preflightId: string;
  preflightHash: string;
  workspaceId: string;
  intentId: string;
  businessDate: string;
  source: string;
  profileRevision: number;
  policyHash: string;
  preflightVersion: number;
  selectedChannels: readonly NormalizedChannelPolicy[];
  results: readonly Record<string, unknown>[];
  readyChannelIds: readonly string[];
  excludedOptionalChannelIds: readonly string[];
  requiredFailures: readonly Record<string, unknown>[];
  coverageGap: readonly Record<string, unknown>[];
  status: "running" | "frozen" | "failed" | "needs_user";
  createdAt: string;
  finishedAt: string | null;
  acceptance?: AcceptanceProvenance | null;
}>;

export type ClosePreflightSuccess = Readonly<{
  ok: true;
  status: "admitted" | "running" | "needs_user" | "failed" | "partial";
  code: string | null;
  reasonCode: string | null;
  intentId: string;
  preflightId: string;
  preflightHash: string;
  snapshot: PreflightSnapshotReadback;
  nextAction: Readonly<Record<string, unknown>> | null;
  coverageGap: readonly Record<string, unknown>[];
  readback: Readonly<Record<string, unknown>>;
}>;

export type ClosePreflightFailure = Readonly<{
  ok: false;
  code: string;
  reasonCode: string;
  message: string;
  intentId?: string;
  readback?: unknown;
}>;

export type ClosePreflightResult =
  ClosePreflightSuccess | ClosePreflightFailure;

export type PreflightRecoveryInput = Readonly<{
  workspaceId: string;
  preflightId?: string;
  intentId?: string;
  requestId?: string;
  nowUtc?: string;
  nowMono?: number;
  interrupted?: boolean;
  startup?: boolean;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
}>;

export type PreflightRecoveryResult = Readonly<{
  ok: boolean;
  status?: "waiting" | "resumed" | "terminal" | "replayed" | "failed";
  code?: string | null;
  reasonCode?: string | null;
  message?: string | null;
  workspaceId: string;
  intentId?: string | null;
  preflightId?: string | null;
  preflightHash?: string | null;
  probe?: Readonly<Record<string, unknown>> | null;
  nextAction?: Readonly<Record<string, unknown>> | null;
  snapshot?: PreflightSnapshotReadback | null;
  event?: Readonly<Record<string, unknown>> | null;
  fence?: ActorFence | null;
  replayed?: boolean;
  actions?: readonly (string | Readonly<Record<string, unknown>>)[];
  readback?: Readonly<Record<string, unknown>>;
}>;

export type ExpireMailboxInput = Readonly<{
  workspaceId: string;
  nowUtc?: string;
  nowMono?: number;
  limit?: number;
  fence?: ActorFence | Readonly<{ fence: ActorFence }>;
  runtimeEpoch?: number;
  ownerEpoch?: number;
  authorityRevision?: number;
  leaseToken?: string;
  acceptance?: unknown;
  acceptanceRunId?: string | null;
  baselineEventSequence?: number | null;
  baselineCheckpointRevision?: number | null;
  createdAfterEventSequence?: number | null;
  createdAfterCheckpointRevision?: number | null;
  createdAfterMono?: number | null;
}>;

export type ExpiredMailboxReadback = Readonly<{
  mailboxSequence: number;
  requestId: string;
  intentId: string;
  eventSequence: number;
  eventId: string;
  outboxId: string;
}>;

export type ExpireMailboxResult = Readonly<{
  ok: boolean;
  code?: string;
  reasonCode?: string;
  message?: string;
  expired?: readonly ExpiredMailboxReadback[];
}>;

export class WorkspaceOrchestratorActorError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceOrchestratorActorError";
    this.code = code;
    this.details = details;
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function canonicalize(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "canonical JSON 不接受 NaN 或 Infinity。",
      );
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object")
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "canonical JSON 不接受 undefined 或函数。",
    );
  if (seen.has(value))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "canonical JSON 不接受循环引用。",
    );
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => canonicalize(item, seen));
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareCodePoints)) {
      const item = record[key];
      if (item === undefined)
        throw new WorkspaceOrchestratorActorError(
          "ORCHESTRATOR_CONTRACT_ERROR",
          `canonical JSON 字段 ${key} 不得为 undefined。`,
        );
      output[key.normalize("NFC")] = canonicalize(item, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableCanonicalJson(value: unknown): string {
  return canonicalJsonV1(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashV1(value: unknown): string {
  return sha256Hex(canonicalJsonV1(value));
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") return Number(value);
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function acceptanceEqual(
  left: AcceptanceProvenance | null,
  right: AcceptanceProvenance | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return ACCEPTANCE_FIELDS.every((field) => left[field] === right[field]);
}

function normalizeAcceptanceRecord(
  record: Record<string, unknown>,
): NormalizedAcceptance {
  const values = ACCEPTANCE_FIELDS.map((field) => record[field] ?? null);
  const supplied = values.some(
    (value) => value !== null && value !== undefined,
  );
  if (!supplied) return Object.freeze({ value: null, supplied: false });
  if (values.some((value) => value === null || value === undefined)) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "acceptance 字段必须完整成套。",
    );
  }
  const acceptanceRunId = String(values[0]).normalize("NFC").trim();
  if (!acceptanceRunId)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "acceptanceRunId 不能为空。",
    );
  const numbers = values.slice(1).map((value) => Number(value));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "acceptance 数值字段必须是非负安全整数。",
    );
  }
  return Object.freeze({
    supplied: true,
    value: Object.freeze({
      acceptanceRunId,
      baselineEventSequence: numbers[0],
      baselineCheckpointRevision: numbers[1],
      createdAfterEventSequence: numbers[2],
      createdAfterCheckpointRevision: numbers[3],
      createdAfterMono: numbers[4],
    }),
  });
}

function normalizeAcceptance(input: unknown): NormalizedAcceptance {
  if (input === null || input === undefined)
    return Object.freeze({ value: null, supplied: false });
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "acceptance 必须是对象。",
    );
  }
  const record = input as Record<string, unknown>;
  const direct = normalizeAcceptanceRecord(record);
  const nestedRaw = record.acceptance;
  const nested =
    nestedRaw === undefined || nestedRaw === null
      ? Object.freeze({ value: null, supplied: false })
      : typeof nestedRaw === "object" && !Array.isArray(nestedRaw)
        ? normalizeAcceptanceRecord(nestedRaw as Record<string, unknown>)
        : (() => {
            throw new WorkspaceOrchestratorActorError(
              "ORCHESTRATOR_CONTRACT_ERROR",
              "acceptance 必须是对象。",
            );
          })();
  if (
    direct.supplied &&
    nested.supplied &&
    !acceptanceEqual(direct.value, nested.value)
  ) {
    throw new WorkspaceOrchestratorActorError(
      "ACCEPTANCE_PROVENANCE_CONFLICT",
      "顶层 acceptance 与 nested acceptance 不一致。",
      { direct: direct.value, nested: nested.value },
    );
  }
  return direct.supplied ? direct : nested;
}

function acceptanceFromRow(
  row: Record<string, unknown> | null | undefined,
): AcceptanceProvenance | null {
  if (!row) return null;
  const hasDbFields = ACCEPTANCE_DB_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(row, field),
  );
  if (hasDbFields) {
    return normalizeAcceptance({
      acceptanceRunId: row.acceptance_run_id,
      baselineEventSequence: row.baseline_event_sequence,
      baselineCheckpointRevision: row.baseline_checkpoint_revision,
      createdAfterEventSequence: row.created_after_event_sequence,
      createdAfterCheckpointRevision: row.created_after_checkpoint_revision,
      createdAfterMono: row.created_after_mono,
    }).value;
  }
  return normalizeAcceptance(row).value;
}
function activeAcceptance(
  database: DatabaseSync,
  workspaceId: string,
): AcceptanceProvenance | null {
  const table = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='acceptance_runs'",
    )
    .get();
  if (!table) return null;
  const row = database
    .prepare(
      `SELECT acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision, fresh_after_mono
    FROM acceptance_runs WHERE workspace_id=? AND status='running'
    ORDER BY started_at_mono DESC, created_at DESC LIMIT 1`,
    )
    .get(workspaceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return normalizeAcceptance({
    acceptanceRunId: row.acceptance_run_id,
    baselineEventSequence: row.baseline_event_sequence,
    baselineCheckpointRevision: row.baseline_checkpoint_revision,
    createdAfterEventSequence: asNumber(row.baseline_event_sequence) + 1,
    createdAfterCheckpointRevision:
      asNumber(row.baseline_checkpoint_revision) + 1,
    createdAfterMono: row.fresh_after_mono,
  }).value;
}

function inheritAcceptance(
  parent: Record<string, unknown> | undefined,
  supplied: NormalizedAcceptance,
): AcceptanceProvenance | null {
  if (parent === undefined) return supplied.value;
  const durable = acceptanceFromRow(parent);
  if (supplied.supplied && !acceptanceEqual(durable, supplied.value)) {
    throw new WorkspaceOrchestratorActorError(
      "ACCEPTANCE_PROVENANCE_CONFLICT",
      "调用方 acceptance 与 durable parent 不一致。",
      { parent: durable, supplied: supplied.value },
    );
  }
  return durable;
}
function assertAcceptanceMatches(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): void {
  const durableParent = acceptanceFromRow(parent);
  const durableChild = acceptanceFromRow(child);
  if (!acceptanceEqual(durableParent, durableChild)) {
    throw new WorkspaceOrchestratorActorError(
      "ACCEPTANCE_PROVENANCE_CONFLICT",
      "durable child acceptance 与 parent 不一致。",
      { parent: durableParent, child: durableChild },
    );
  }
}

function acceptanceSqlValues(
  value: AcceptanceProvenance | null | undefined,
): AcceptanceSqlValues {
  return value
    ? [
        value.acceptanceRunId,
        value.baselineEventSequence,
        value.baselineCheckpointRevision,
        value.createdAfterEventSequence,
        value.createdAfterCheckpointRevision,
        value.createdAfterMono,
      ]
    : [null, null, null, null, null, null];
}

function affectedRows(result: unknown): number {
  const changes = (result as { changes?: number | bigint } | undefined)
    ?.changes;
  return changes === undefined ? 0 : Number(changes);
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function normalizedUtc(
  value: string | null | undefined,
  fallback: string,
): string {
  const candidate = value ?? fallback;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime()))
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      `无效 UTC instant: ${candidate}`,
    );
  return parsed.toISOString();
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
  return new Date(base + (targetMono - baseMono)).toISOString();
}

function nowPair(
  inputUtc: string | undefined,
  inputMono: number | undefined,
  defaults: { nowUtc: () => string; nowMono: () => number },
): { utc: string; mono: number } {
  const fallbackUtc = normalizedUtc(
    defaults.nowUtc(),
    new Date().toISOString(),
  );
  const utc = normalizedUtc(inputUtc, fallbackUtc);
  const mono = Number.isFinite(Number(inputMono))
    ? Number(inputMono)
    : Number(defaults.nowMono());
  if (!Number.isFinite(mono) || mono < 0)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "monotonic tick 必须是非负有限数。",
    );
  return { utc, mono };
}

function rowToActor(row: Record<string, unknown>): WorkspaceOrchestratorActor {
  return Object.freeze({
    workspaceId: String(row.workspace_id),
    actorStatus: String(row.actor_status) as ActorStatus,
    runtimeEpoch: asNumber(row.runtime_epoch),
    ownerEpoch: asNumber(row.owner_epoch),
    authorityRevision: asNumber(row.authority_revision),
    leaseToken: asNullableString(row.lease_token),
    leaseExpiresAtUtc: asNullableString(row.lease_expires_at_utc),
    leaseExpiresAtMono: asNullableNumber(row.lease_expires_at_mono),
    controlStallDeadlineUtc: asNullableString(row.control_stall_deadline_utc),
    controlStallDeadlineMono: asNullableNumber(row.control_stall_deadline_mono),
    gateDeadlineUtc: asNullableString(row.gate_deadline_utc),
    gateDeadlineMono: asNullableNumber(row.gate_deadline_mono),
    invocationOrdinal: asNumber(row.invocation_ordinal),
    mailboxSequence: asNumber(row.mailbox_sequence),
    checkpointRevision: asNumber(row.checkpoint_revision),
    migrationEpoch: asNumber(row.migration_epoch),
    writeFence: String(
      row.write_fence,
    ) as WorkspaceOrchestratorActor["writeFence"],
    currentBuildId: String(row.current_build_id),
    lastBusinessProgressAt: asNullableString(row.last_business_progress_at),
    createdAt: String(row.created_at),
    acceptance: acceptanceFromRow(row),
    updatedAt: String(row.updated_at),
  });
}

function rowToGate(
  row: Record<string, unknown> | undefined,
): StartupReconcileGate | null {
  if (!row) return null;
  return Object.freeze({
    workspaceId: String(row.workspace_id),
    runtimeEpoch: asNumber(row.runtime_epoch),
    ownerEpoch: asNumber(row.owner_epoch),
    leaseToken: String(row.lease_token),
    leaseExpiresAtUtc: String(row.lease_expires_at_utc),
    leaseExpiresAtMono: asNumber(row.lease_expires_at_mono),
    gateDeadlineUtc: String(row.gate_deadline_utc),
    gateDeadlineMono: asNumber(row.gate_deadline_mono),
    checkpointRevision: asNumber(row.checkpoint_revision),
    status: String(row.status) as StartupGateStatus,
    reason: asNullableString(row.reason),
    finishedAtUtc: asNullableString(row.finished_at_utc),
    finishedAtMono: asNullableNumber(row.finished_at_mono),
  });
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

function unwrapFence(input: unknown): Partial<ActorFence> | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (record.fence && typeof record.fence === "object")
    return unwrapFence(record.fence);
  const workspaceId =
    record.workspaceId === undefined ? undefined : String(record.workspaceId);
  const runtimeEpoch =
    record.runtimeEpoch === undefined
      ? undefined
      : finiteInteger(record.runtimeEpoch, -1);
  const ownerEpoch =
    record.ownerEpoch === undefined
      ? undefined
      : finiteInteger(record.ownerEpoch, -1);
  const authorityRevision =
    record.authorityRevision === undefined
      ? undefined
      : finiteInteger(record.authorityRevision, -1);
  const leaseToken =
    record.leaseToken === undefined ? undefined : String(record.leaseToken);
  if (
    workspaceId === undefined &&
    runtimeEpoch === undefined &&
    ownerEpoch === undefined &&
    authorityRevision === undefined &&
    leaseToken === undefined
  )
    return null;
  return {
    workspaceId,
    runtimeEpoch,
    ownerEpoch,
    authorityRevision,
    leaseToken,
  };
}

function readActor(
  database: DatabaseSync,
  workspaceId: string,
): WorkspaceOrchestratorActor | null {
  const row = database
    .prepare("SELECT * FROM workspace_orchestrator_actors WHERE workspace_id=?")
    .get(workspaceId) as Record<string, unknown> | undefined;
  return row ? rowToActor(row) : null;
}

function readGate(
  database: DatabaseSync,
  workspaceId: string,
  runtimeEpoch: number,
): StartupReconcileGate | null {
  const row = database
    .prepare(
      "SELECT * FROM daily_reconcile_gates WHERE workspace_id=? AND runtime_epoch=?",
    )
    .get(workspaceId, runtimeEpoch) as Record<string, unknown> | undefined;
  return rowToGate(row);
}

export function readWorkspaceOrchestratorActor(
  database: DatabaseSync,
  workspaceId: string,
): WorkspaceOrchestratorActor | null {
  return readActor(database, workspaceId);
}

export function readStartupReconcileGate(
  database: DatabaseSync,
  workspaceId: string,
  runtimeEpoch: number,
): StartupReconcileGate | null {
  return readGate(database, workspaceId, runtimeEpoch);
}

function normalizeRequiredness(value: unknown): Requiredness {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "required" ||
    normalized === "must" ||
    normalized === "mandatory"
  )
    return "required";
  if (normalized === "optional" || normalized === "may") return "optional";
  throw new WorkspaceOrchestratorActorError(
    "CHANNEL_POLICY_INVALID",
    `未知 channel requiredness: ${String(value)}`,
  );
}

function policyEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.channels)) return record.channels;
  if (Array.isArray(record.selectedChannels)) return record.selectedChannels;
  if (Array.isArray(record.selected_channels)) return record.selected_channels;
  const required = Array.isArray(record.requiredChannels)
    ? record.requiredChannels
    : [];
  const optional = Array.isArray(record.optionalChannels)
    ? record.optionalChannels
    : [];
  if (required.length || optional.length) {
    return [
      ...required.map((entry) =>
        typeof entry === "string"
          ? { channelId: entry, requiredness: "required" }
          : { ...(entry as Record<string, unknown>), requiredness: "required" },
      ),
      ...optional.map((entry) =>
        typeof entry === "string"
          ? { channelId: entry, requiredness: "optional" }
          : { ...(entry as Record<string, unknown>), requiredness: "optional" },
      ),
    ];
  }
  return Object.entries(record).map(([channelId, requiredness]) => ({
    channelId,
    requiredness,
  }));
}

export function normalizeChannelPolicy(
  value: unknown,
): readonly NormalizedChannelPolicy[] {
  const entries = policyEntries(value);
  const seen = new Map<string, NormalizedChannelPolicy>();
  for (const raw of entries) {
    const record =
      typeof raw === "string"
        ? { channelId: raw, requiredness: "required" }
        : (raw as Record<string, unknown>);
    const channelId = String(
      record.channelId ?? record.channel_id ?? record.id ?? "",
    ).trim();
    if (!channelId)
      throw new WorkspaceOrchestratorActorError(
        "CHANNEL_POLICY_INVALID",
        "channel policy 缺少 channelId。",
      );
    const normalized: NormalizedChannelPolicy = Object.freeze({
      channelId: channelId.normalize("NFC"),
      requiredness: normalizeRequiredness(
        record.requiredness ?? record.required ?? record.policy ?? "required",
      ),
      module:
        record.module === undefined || record.module === null
          ? null
          : String(record.module).normalize("NFC"),
    });
    const prior = seen.get(normalized.channelId);
    if (prior)
      throw new WorkspaceOrchestratorActorError(
        "CHANNEL_POLICY_INVALID",
        `channel ${channelId} 重复。`,
      );
    seen.set(normalized.channelId, normalized);
  }
  return Object.freeze(
    [...seen.values()].sort((left, right) =>
      compareCodePoints(left.channelId, right.channelId),
    ),
  );
}

function normalizeIntentChannelPolicy(input: WorkspaceIntentInput): {
  profileRevision: number;
  policy: readonly NormalizedChannelPolicy[];
} {
  const profileRevision = finiteInteger(input.profileRevision, 0);
  if (profileRevision < 1 || input.authorizedChannelPolicy === undefined) {
    throw new WorkspaceOrchestratorActorError(
      "CHANNEL_POLICY_INVALID",
      "缺少 workspace profile revision 或 authorized channel policy。",
    );
  }
  const authorized = normalizeChannelPolicy(input.authorizedChannelPolicy);
  const requested = normalizeChannelPolicy(input.channelPolicy ?? []);
  const authorizedById = new Map(
    authorized.map((entry) => [entry.channelId, entry]),
  );
  const requestedById = new Map(
    requested.map((entry) => [entry.channelId, entry]),
  );
  for (const required of authorized.filter(
    (entry) => entry.requiredness === "required",
  )) {
    const selected = requestedById.get(required.channelId);
    if (!selected)
      throw new WorkspaceOrchestratorActorError(
        "CHANNEL_POLICY_INVALID",
        `required channel 不得遗漏: ${required.channelId}`,
      );
  }
  for (const selected of requested) {
    const allowed = authorizedById.get(selected.channelId);
    if (!allowed)
      throw new WorkspaceOrchestratorActorError(
        "CHANNEL_POLICY_INVALID",
        `未知或未授权 channel: ${selected.channelId}`,
      );
    if (allowed.requiredness !== selected.requiredness)
      throw new WorkspaceOrchestratorActorError(
        "CHANNEL_POLICY_INVALID",
        `channel requiredness 不得改变: ${selected.channelId}`,
      );
    if (allowed.module !== selected.module)
      throw new WorkspaceOrchestratorActorError(
        "CHANNEL_POLICY_INVALID",
        `channel module 与 workspace profile 不一致: ${selected.channelId}`,
      );
  }
  return { profileRevision, policy: requested };
}

function normalizeResults(
  value: ClosePreflightInput["channelResults"],
): ChannelPreflightResultInput[] {
  if (Array.isArray(value)) return value.map((entry) => ({ ...entry }));
  return Object.entries(value ?? {}).map(([channelId, entry]) => ({
    ...(entry as ChannelPreflightResultInput),
    channelId,
  }));
}
const MAX_PREFLIGHT_RESUMES = 1;
const PREFLIGHT_PROBE_LEASE_TTL = 30_000;
const PROBE_RECOVERY_FIELDS: Record<string, true> = Object.freeze({
  probeLease: true,
  probeLeaseId: true,
  probeLeaseToken: true,
  probeLeaseAttempt: true,
  probeResumeCount: true,
  probeLeaseStatus: true,
  probeLeaseHistory: true,
  probeNextLeaseExpiresAtUtc: true,
  probeNextLeaseExpiresAtMono: true,
  expiresAtUtc: true,
  expiresAtMono: true,
  probeRecoveryReasonCode: true,
  probeTerminalReasonCode: true,
});

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hashablePreflightResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => !PROBE_RECOVERY_FIELDS[key]),
  );
}

function probeLeaseIdentity(input: {
  workspaceId: string;
  preflightId: string;
  channelId: string;
  probeRequestId: string;
  capabilityLeaseId: string | null;
  attempt: number;
  expiresAtUtc: string;
  expiresAtMono: number;
}): Record<string, unknown> {
  const identity = {
    r: "preflight-probe-lease/v1",
    workspaceId: input.workspaceId,
    preflightId: input.preflightId,
    channelId: input.channelId,
    probeRequestId: input.probeRequestId,
    capabilityLeaseId: input.capabilityLeaseId,
    attempt: input.attempt,
  };
  const leaseId = hashV1(identity);
  const leaseToken = hashV1({ ...identity, purpose: "lease-token" });
  return Object.freeze({
    leaseId,
    leaseToken,
    channelId: input.channelId,
    probeRequestId: input.probeRequestId,
    capabilityLeaseId: input.capabilityLeaseId,
    attempt: input.attempt,
    expiresAtUtc: input.expiresAtUtc,
    expiresAtMono: input.expiresAtMono,
  });
}

function isProbeRunningResult(result: ChannelPreflightResultInput): boolean {
  const status = resultStatus(result);
  const reason = reasonCode(result, "");
  return status === "running" || /PROBE_HUNG|HUNG|IN_PROGRESS/.test(reason);
}

function normalizedProbeExpiry(
  result: ChannelPreflightResultInput,
  pair: { utc: string; mono: number },
): { utc: string; mono: number } {
  const rawMono = result.expiresAtMono;
  const mono =
    rawMono === null || rawMono === undefined
      ? pair.mono + PREFLIGHT_PROBE_LEASE_TTL
      : Number(rawMono);
  if (!Number.isFinite(mono) || mono < 0)
    throw new WorkspaceOrchestratorActorError(
      "ORCHESTRATOR_CONTRACT_ERROR",
      "probe expiresAtMono 必须是非负有限数。",
    );
  return {
    mono: Math.trunc(mono),
    utc: normalizedUtc(
      result.expiresAtUtc,
      utcAtMono(pair.utc, pair.mono, Math.trunc(mono)),
    ),
  };
}

function probeStateFromResult(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const lease = parseJsonObject(result.probeLease);
  if (
    !lease &&
    !result.probeLeaseId &&
    !isProbeRunningResult(result as ChannelPreflightResultInput)
  )
    return null;
  const channelId = String(result.channelId ?? "").trim();
  const probeRequestId = String(result.probeRequestId ?? "").trim();
  if (!channelId || !probeRequestId) return null;
  const state = lease ?? {};
  return Object.freeze({
    leaseId: String(state.leaseId ?? result.probeLeaseId ?? ""),
    leaseToken: String(state.leaseToken ?? result.probeLeaseToken ?? ""),
    channelId,
    probeRequestId,
    capabilityLeaseId:
      state.capabilityLeaseId ?? result.capabilityLeaseId ?? null,
    attempt: finiteInteger(state.attempt ?? result.probeLeaseAttempt, 0),
    resumeCount: finiteInteger(result.probeResumeCount, 0),
    status: String(result.probeLeaseStatus ?? "running"),
    expiresAtUtc: state.expiresAtUtc ?? result.expiresAtUtc ?? null,
    expiresAtMono: state.expiresAtMono ?? result.expiresAtMono ?? null,
    history: parseJsonArray(result.probeLeaseHistory),
  });
}

function resultStatus(result: ChannelPreflightResultInput): string {
  if (result.status === true) return "ready";
  return String(result.status ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function reasonCode(
  result: ChannelPreflightResultInput,
  fallback: string,
): string {
  const raw = result.reasonCode ?? result.reason ?? fallback;
  return String(raw)
    .trim()
    .toUpperCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function isReadyResult(result: ChannelPreflightResultInput): boolean {
  const status = resultStatus(result);
  return (
    status === "ready" ||
    status === "ok" ||
    status === "success" ||
    status === "succeeded" ||
    status === "valid" ||
    status === "valid_zero" ||
    status === "healthy" ||
    status === "passed"
  );
}

function isRepairableRequiredFailure(
  result: ChannelPreflightResultInput,
): boolean {
  const combined =
    `${resultStatus(result)} ${reasonCode(result, "")}`.toUpperCase();
  return /CONFIG|LOGIN|AUTH|CAPABILITY|CREDENTIAL|REPAIR_REQUIRED/.test(
    combined,
  );
}

function isUnrecoverableRequiredFailure(
  result: ChannelPreflightResultInput,
): boolean {
  const combined =
    `${resultStatus(result)} ${reasonCode(result, "")}`.toUpperCase();
  return /UNRECOVERABLE|CONTRACT|MALFORMED|SCHEMA|PREFLIGHT_FAILED|DRIFT|HASH_MISMATCH/.test(
    combined,
  );
}

function canonicalPolicyHash(
  workspaceId: string,
  profileRevision: number,
  policy: readonly NormalizedChannelPolicy[],
): string {
  return hashV1({
    r: "normalized-policy/v1",
    workspaceId,
    profileRevision,
    policy,
  });
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
  const canonicalBytesHash = sha256Hex(bytes);
  const existing = database
    .prepare(
      `SELECT preimage_schema_version, canonical_bytes_hash, preimage_bytes, derived_value
    FROM identity_hash_registry
    WHERE workspace_id=? AND registry_name=? AND registry_version=1 AND preimage_hash=?`,
    )
    .get(input.workspaceId, input.registryName, preimageHash) as
    | {
        preimage_schema_version: number;
        canonical_bytes_hash: string;
        preimage_bytes: Uint8Array;
        derived_value: string;
      }
    | undefined;
  if (existing) {
    const existingBytes = Buffer.from(existing.preimage_bytes as Uint8Array);
    if (
      Number(existing.preimage_schema_version) !== 1 ||
      existing.canonical_bytes_hash !== canonicalBytesHash ||
      !existingBytes.equals(bytes) ||
      existing.derived_value !== input.derivedValue
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
      canonicalBytesHash,
      bytes,
      input.derivedValue,
      input.createdAt,
    );
}

function leaseFingerprint(leaseToken: string | null): string {
  return sha256Hex(leaseToken ?? "");
}

function appendEvent(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  input: {
    eventType: string;
    eventOrdinal?: number;
    causationId: string;
    payload: unknown;
    businessDate?: string | null;
    source?: string | null;
    intentId?: string | null;
    invocationId?: string | null;
    requestId?: string | null;
    producerId?: string | null;
    registryEntryHash?: string | null;
    censusHash?: string | null;
    triggerId?: string | null;
    occurredAtUtc: string;
    aggregateId?: string;
    acceptance?: unknown;
    parent?: Record<string, unknown>;
  },
): { eventSequence: number; eventId: string; outboxId: string } {
  const acceptance = inheritAcceptance(
    input.parent,
    normalizeAcceptance(input.acceptance),
  );
  const aggregateId = input.aggregateId ?? input.intentId ?? actor.workspaceId;
  const aggregateRevision = actor.checkpointRevision;
  const existing = database
    .prepare(
      `SELECT event_sequence, event_id
    FROM orchestrator_events
    WHERE workspace_id=? AND causation_id=? AND event_type=?
    ORDER BY event_ordinal ASC LIMIT 1`,
    )
    .get(actor.workspaceId, input.causationId, input.eventType) as
    Record<string, unknown> | undefined;
  if (existing) {
    const eventSequence = asNumber(existing.event_sequence);
    const outbox = database
      .prepare(
        "SELECT outbox_id FROM orchestrator_outbox WHERE workspace_id=? AND event_sequence=?",
      )
      .get(actor.workspaceId, eventSequence) as
      Record<string, unknown> | undefined;
    if (!outbox)
      throw new WorkspaceOrchestratorActorError(
        "ORCHESTRATOR_CONTRACT_ERROR",
        "causation replay 缺少对应 outbox。",
        {
          workspaceId: actor.workspaceId,
          eventSequence,
          eventType: input.eventType,
          causationId: input.causationId,
        },
      );
    return {
      eventSequence,
      eventId: String(existing.event_id),
      outboxId: String(outbox.outbox_id),
    };
  }
  const ordinalRow = database
    .prepare(
      `SELECT COALESCE(MAX(event_ordinal), 0) AS value
    FROM orchestrator_outbox
    WHERE workspace_id=? AND aggregate_id=? AND aggregate_revision=?`,
    )
    .get(actor.workspaceId, aggregateId, aggregateRevision) as
    Record<string, unknown> | undefined;
  const eventOrdinal = asNumber(ordinalRow?.value) + 1;
  const eventRow = database
    .prepare(
      "SELECT COALESCE(MAX(event_sequence), 0) AS value FROM orchestrator_events WHERE workspace_id=?",
    )
    .get(actor.workspaceId) as Record<string, unknown> | undefined;
  const eventSequence = asNumber(eventRow?.value) + 1;
  const payloadJson = canonicalJsonV1(input.payload);
  const eventId = hashV1({
    r: "event/v1",
    workspaceId: actor.workspaceId,
    eventSequence,
    eventType: input.eventType,
    eventOrdinal,
    causationId: input.causationId,
  });
  database
    .prepare(
      `INSERT INTO orchestrator_events (
    workspace_id, event_sequence, event_id, event_type, event_ordinal, business_date, source,
    intent_id, invocation_id, request_id, causation_id, actor_epoch, owner_epoch,
    lease_token_fingerprint, checkpoint_revision, producer_id, registry_entry_hash,
    census_hash, trigger_id, payload_json, acceptance_run_id, baseline_event_sequence,
    baseline_checkpoint_revision, created_after_event_sequence, created_after_checkpoint_revision,
    created_after_mono, occurred_at_utc
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.requestId ?? null,
      input.causationId,
      actor.runtimeEpoch,
      actor.ownerEpoch,
      leaseFingerprint(actor.leaseToken),
      actor.checkpointRevision,
      input.producerId ?? null,
      input.registryEntryHash ?? null,
      input.censusHash ?? null,
      input.triggerId ?? null,
      payloadJson,
      ...acceptanceSqlValues(acceptance),
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
    outbox_id, workspace_id, event_sequence, aggregate_id, aggregate_revision,
    event_type, event_ordinal, causation_id, payload_hash, payload_bytes,
    acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
    created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
    status, attempt, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
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
      ...acceptanceSqlValues(acceptance),
      input.occurredAtUtc,
    );
  return { eventSequence, eventId, outboxId };
}

function failure(
  code: string,
  message: string,
  readback?: unknown,
): AcquireActorFailure {
  return Object.freeze({
    ok: false,
    code,
    reasonCode: code,
    message,
    readback,
  });
}

function commandActorType(
  source: WorkspaceIntentInput["source"],
): "owner_ui" | "external_agent" | "scheduler" {
  if (source === "mcp") return "external_agent";
  if (
    source === "scheduler_0900" ||
    source === "rolling_scan" ||
    source === "orphan_reconcile" ||
    source === "content_cycle"
  )
    return "scheduler";
  return "owner_ui";
}

function normalizeAttestation(
  raw: ProducerAttestationInput | undefined,
): ProducerAttestationInput | null {
  if (!raw) return null;
  const input = raw as Record<string, unknown>;
  const required = [
    "producerId",
    "registryEntryHash",
    "censusHash",
    "triggerId",
    "processId",
    "processStartTimeUtc",
    "processStartTimeMono",
    "processImagePath",
    "resourcesPath",
    "buildId",
    "sourceCommit",
    "packageHash",
    "appAsarHash",
    "schemaEpoch",
    "cutoverEpoch",
    "runtimeEpoch",
    "writePrincipal",
    "authorizerRevision",
  ] as const;
  for (const key of required) {
    if (
      input[key] === undefined ||
      input[key] === null ||
      (typeof input[key] === "string" && !String(input[key]).trim())
    )
      return null;
  }
  return Object.freeze({
    producerId: String(input.producerId),
    registryEntryHash: String(input.registryEntryHash),
    censusHash: String(input.censusHash),
    triggerId: String(input.triggerId),
    processId: String(input.processId),
    processStartTimeUtc: normalizedUtc(
      String(input.processStartTimeUtc),
      String(input.processStartTimeUtc),
    ),
    processStartTimeMono: Number(input.processStartTimeMono),
    processImagePath: String(input.processImagePath),
    resourcesPath: String(input.resourcesPath),
    buildId: String(input.buildId),
    sourceCommit: String(input.sourceCommit),
    packageHash: String(input.packageHash),
    appAsarHash: String(input.appAsarHash),
    schemaEpoch: finiteInteger(input.schemaEpoch, -1),
    cutoverEpoch: finiteInteger(input.cutoverEpoch, -1),
    runtimeEpoch: finiteInteger(input.runtimeEpoch, -1),
    writePrincipal: String(input.writePrincipal),
    authorizerRevision: String(input.authorizerRevision),
    ...(input.producerAttestationHash === undefined
      ? {}
      : { producerAttestationHash: String(input.producerAttestationHash) }),
  });
}

function attestationHash(attestation: ProducerAttestationInput): string {
  const { producerAttestationHash: _claimed, ...fields } = attestation;
  return hashV1({ r: "producer-attestation/v1", ...fields });
}

function readEnvelopeField(row: Record<string, unknown>, key: string): unknown {
  const raw = row.execution_envelope_json ?? row.envelope_json;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed[key];
  } catch {
    return undefined;
  }
}

function readPriorReceipt(
  row: Record<string, unknown>,
): WorkspaceOrchestratorReceipt | null {
  const raw = row.response_json ?? row.receipt_json;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as WorkspaceOrchestratorReceipt;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.receiptId === "string"
    )
      return parsed;
  } catch {
    // A pre-v79 command receipt is not a canonical actor receipt; callers get a conflict.
  }
  return null;
}

function receiptEnvelopeMatches(
  row: Record<string, unknown>,
  input: {
    command: string;
    commandReplayKey: string;
    logicalInputHash: string;
    payloadHash: string;
    producerAttestationHash: string | null;
  },
): boolean {
  const priorAttestation = readEnvelopeField(row, "producerAttestationHash");
  const priorPayload = readEnvelopeField(row, "payloadHash");
  const priorReplay =
    row.command_replay_key === null || row.command_replay_key === undefined
      ? null
      : String(row.command_replay_key);
  const priorLogical =
    row.logical_input_hash === null || row.logical_input_hash === undefined
      ? null
      : String(row.logical_input_hash);
  return (
    String(row.command ?? "") === input.command &&
    (priorReplay === null ? true : priorReplay === input.commandReplayKey) &&
    (priorLogical === null
      ? String(row.input_hash ?? "") === input.logicalInputHash
      : priorLogical === input.logicalInputHash) &&
    (priorPayload === undefined
      ? true
      : String(priorPayload) === input.payloadHash) &&
    (priorAttestation === undefined
      ? input.producerAttestationHash === null
      : String(priorAttestation) === input.producerAttestationHash)
  );
}

function insertCommandReceipt(
  database: DatabaseSync,
  row: Record<string, SQLInputValue>,
): void {
  const available = new Set(
    (
      database.prepare("PRAGMA table_info(command_receipts)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  const entries = Object.entries(row).filter(([name]) => available.has(name));
  database
    .prepare(
      `INSERT INTO command_receipts (${entries.map(([name]) => `"${name.replaceAll('"', '""')}"`).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
    )
    .run(...entries.map(([, value]) => value));
}

function receiptReadback(
  actor: WorkspaceOrchestratorActor,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspaceId: actor.workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    checkpointRevision: actor.checkpointRevision,
    acceptance: actor.acceptance ?? null,
    root: null,
    rootCreated: false,
    index: { state: "N/A", reason: "PRE_ROOT" },
    ...extra,
  };
}

function makeReceipt(input: {
  receiptId: string;
  ok: boolean;
  status: "accepted" | "rejected";
  code?: string | null;
  reasonCode?: string | null;
  message?: string | null;
  workspaceId: string;
  runtimeEpoch: number;
  ownerEpoch: number;
  authorityRevision: number;
  acceptance?: AcceptanceProvenance | null;
  requestId: string;
  command: string;
  commandReplayKey: string;
  logicalInputHash: string;
  payloadHash: string;
  producerAttestationHash: string | null;
  intentId?: string | null;
  invocationId?: string | null;
  mailboxSequence?: number | null;
  checkpointRevision: number;
  readback: Record<string, unknown>;
  createdAt: string;
}): WorkspaceOrchestratorReceipt {
  return Object.freeze({
    version: "WorkspaceOrchestratorReceiptV1",
    receiptId: input.receiptId,
    ok: input.ok,
    status: input.status,
    code: input.code ?? null,
    reasonCode: input.reasonCode ?? input.code ?? null,
    message: input.message ?? null,
    workspaceId: input.workspaceId,
    runtimeEpoch: input.runtimeEpoch,
    ownerEpoch: input.ownerEpoch,
    authorityRevision: input.authorityRevision,
    acceptance: input.acceptance ?? null,
    requestId: input.requestId,
    command: input.command,
    commandReplayKey: input.commandReplayKey,
    logicalInputHash: input.logicalInputHash,
    payloadHash: input.payloadHash,
    producerAttestationHash: input.producerAttestationHash,
    intentId: input.intentId ?? null,
    invocationId: input.invocationId ?? null,
    mailboxSequence: input.mailboxSequence ?? null,
    checkpointRevision: input.checkpointRevision,
    readback: Object.freeze(input.readback),
    createdAt: input.createdAt,
  });
}

function insertReceiptRow(
  database: DatabaseSync,
  receipt: WorkspaceOrchestratorReceipt,
  envelope: unknown,
  sideEffectState: string,
  actorType: string,
  actorId: string,
  beforeRevision: number | null,
  afterRevision: number | null,
): void {
  const responseJson = canonicalJsonV1(receipt);
  const envelopeJson = canonicalJsonV1(envelope);
  const receiptJson = JSON.stringify(receipt);
  insertCommandReceipt(database, {
    id: receipt.receiptId,
    workspace_id: receipt.workspaceId,
    runtime_epoch: String(receipt.runtimeEpoch),
    request_id: receipt.requestId,
    command: receipt.command,
    input_hash: receipt.logicalInputHash,
    actor_type: actorType,
    actor_id: actorId,
    task_id: null,
    worker_lease_id: null,
    grant_id: null,
    execution_grant_id: null,
    envelope_json: envelopeJson,
    receipt_json: receiptJson,
    status: receipt.ok ? "ok" : "error",
    result_json: receipt.ok ? responseJson : null,
    error_json: receipt.ok
      ? null
      : canonicalJsonV1({
          code: receipt.code,
          message: receipt.message,
          details: receipt.readback,
        }),
    readback_json: canonicalJsonV1(receipt.readback),
    before_revision: beforeRevision,
    acceptance_run_id: receipt.acceptance?.acceptanceRunId ?? null,
    baseline_event_sequence: receipt.acceptance?.baselineEventSequence ?? null,
    baseline_checkpoint_revision:
      receipt.acceptance?.baselineCheckpointRevision ?? null,
    created_after_event_sequence:
      receipt.acceptance?.createdAfterEventSequence ?? null,
    created_after_checkpoint_revision:
      receipt.acceptance?.createdAfterCheckpointRevision ?? null,
    created_after_mono: receipt.acceptance?.createdAfterMono ?? null,
    after_revision: afterRevision,
    side_effect_state: sideEffectState,
    created_at: receipt.createdAt,
    command_replay_key: receipt.commandReplayKey,
    logical_input_hash: receipt.logicalInputHash,
    execution_envelope_json: envelopeJson,
    conflict_json:
      receipt.code === "REQUEST_REPLAY_CONFLICT" ||
      receipt.code === "ACCEPTANCE_PROVENANCE_CONFLICT"
        ? canonicalJsonV1(receipt.readback)
        : null,
    response_hash: sha256Hex(responseJson),
    terminal_status: receipt.ok ? "accepted" : "rejected",
    intent_id: receipt.intentId,
  });
}

function currentFenceFromInput(
  input: Record<string, unknown>,
  fallback: ActorFence | null,
): Partial<ActorFence> | null {
  const direct = unwrapFence(input.fence);
  if (direct) return direct;
  const fields = unwrapFence(input);
  if (
    fields &&
    (fields.runtimeEpoch !== undefined ||
      fields.ownerEpoch !== undefined ||
      fields.authorityRevision !== undefined ||
      fields.leaseToken !== undefined)
  )
    return fields;
  return fallback;
}

function requireCurrentFence(
  database: DatabaseSync,
  workspaceId: string,
  supplied: Partial<ActorFence> | null,
  nowMono: number,
  requireLive = true,
): WorkspaceOrchestratorActor {
  const actor = readActor(database, workspaceId);
  if (!actor)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "workspace Actor 不存在。",
      { workspaceId },
    );
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
    requireLive &&
    ((actor.leaseExpiresAtMono !== null &&
      nowMono >= actor.leaseExpiresAtMono) ||
      (actor.controlStallDeadlineMono !== null &&
        nowMono >= actor.controlStallDeadlineMono))
  ) {
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor lease/control stall 已到期。",
      { workspaceId, actor },
    );
  }
  return actor;
}

function bumpActor(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
  pair: { utc: string; mono: number },
  input: {
    invocationDelta?: number;
    mailboxDelta?: number;
    checkpointDelta?: number;
  },
): WorkspaceOrchestratorActor {
  const nextInvocation = actor.invocationOrdinal + (input.invocationDelta ?? 0);
  const nextMailbox = actor.mailboxSequence + (input.mailboxDelta ?? 0);
  const nextCheckpoint =
    actor.checkpointRevision + (input.checkpointDelta ?? 1);
  const result = database
    .prepare(
      `UPDATE workspace_orchestrator_actors
    SET invocation_ordinal=?, mailbox_sequence=?, checkpoint_revision=?, updated_at=?
    WHERE workspace_id=? AND actor_status IN ('active','stopping') AND runtime_epoch=?
      AND owner_epoch=? AND authority_revision=? AND lease_token=?
      AND invocation_ordinal=? AND mailbox_sequence=? AND checkpoint_revision=?`,
    )
    .run(
      nextInvocation,
      nextMailbox,
      nextCheckpoint,
      pair.utc,
      actor.workspaceId,
      actor.runtimeEpoch,
      actor.ownerEpoch,
      actor.authorityRevision,
      actor.leaseToken,
      actor.invocationOrdinal,
      actor.mailboxSequence,
      actor.checkpointRevision,
    );
  if (affectedRows(result) !== 1)
    throw new WorkspaceOrchestratorActorError(
      "EXECUTION_AUTHORIZATION_INVALID",
      "Actor counter CAS 失败。",
      { workspaceId: actor.workspaceId },
    );
  const next = readActor(database, actor.workspaceId);
  if (!next)
    throw new WorkspaceOrchestratorActorError(
      "WORKSPACE_STALE",
      "Actor CAS 后读回失败。",
      { workspaceId: actor.workspaceId },
    );
  const gate = readGate(database, actor.workspaceId, next.runtimeEpoch);
  if (gate) {
    const synced = database
      .prepare(
        `UPDATE daily_reconcile_gates
      SET checkpoint_revision=?
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
        { workspaceId: actor.workspaceId },
      );
  }
  return readActor(database, actor.workspaceId)!;
}

function gateIsComplete(
  database: DatabaseSync,
  actor: WorkspaceOrchestratorActor,
): boolean {
  const gate = readGate(database, actor.workspaceId, actor.runtimeEpoch);
  return Boolean(
    gate &&
    gate.status === "complete" &&
    gate.ownerEpoch === actor.ownerEpoch &&
    gate.leaseToken === actor.leaseToken &&
    gate.checkpointRevision === actor.checkpointRevision,
  );
}

function actorDeadline(
  input: AcquireActorInput,
  pair: { utc: string; mono: number },
): {
  leaseUtc: string;
  leaseMono: number;
  gateUtc: string;
  gateMono: number;
  stallUtc: string;
  stallMono: number;
} {
  const leaseMono = Number.isFinite(Number(input.leaseExpiresAtMono))
    ? Number(input.leaseExpiresAtMono)
    : pair.mono + 30_000;
  const gateMono = Number.isFinite(Number(input.gateDeadlineMono))
    ? Number(input.gateDeadlineMono)
    : leaseMono;
  const candidates = [
    leaseMono,
    gateMono,
    input.rootDeadlineMono,
    input.stageDeadlineMono,
    input.controlStallDeadlineMono,
  ]
    .filter(
      (value): value is number =>
        value !== null && value !== undefined && Number.isFinite(Number(value)),
    )
    .map(Number);
  const stallMono = Math.min(...candidates);
  return {
    leaseMono,
    leaseUtc: normalizedUtc(
      input.leaseExpiresAtUtc,
      utcAtMono(pair.utc, pair.mono, leaseMono),
    ),
    gateMono,
    gateUtc: normalizedUtc(
      input.gateDeadlineUtc,
      utcAtMono(pair.utc, pair.mono, gateMono),
    ),
    stallMono,
    stallUtc: normalizedUtc(
      input.controlStallDeadlineUtc,
      utcAtMono(pair.utc, pair.mono, stallMono),
    ),
  };
}

function canonicalFailureReceipt(input: {
  actor: WorkspaceOrchestratorActor;
  request: WorkspaceIntentInput;
  command: string;
  commandReplayKey: string;
  logicalInputHash: string;
  payloadHash: string;
  producerAttestationHash: string | null;
  code: string;
  message: string;
  nowUtc: string;
  acceptance?: AcceptanceProvenance | null;
  actorId: string;
  details?: Record<string, unknown>;
}): WorkspaceOrchestratorReceipt {
  const receiptId = hashV1({
    r: "command-receipt/v1",
    workspaceId: input.request.workspaceId,
    requestId: input.request.requestId,
    commandReplayKey: input.commandReplayKey,
  });
  return makeReceipt({
    receiptId,
    ok: false,
    status: "rejected",
    code: input.code,
    reasonCode: input.code,
    message: input.message,
    workspaceId: input.request.workspaceId,
    runtimeEpoch: input.actor.runtimeEpoch,
    ownerEpoch: input.actor.ownerEpoch,
    authorityRevision: input.actor.authorityRevision,
    requestId: input.request.requestId,
    command: input.command,
    commandReplayKey: input.commandReplayKey,
    logicalInputHash: input.logicalInputHash,
    payloadHash: input.payloadHash,
    producerAttestationHash: input.producerAttestationHash,
    acceptance: input.acceptance ?? null,
    checkpointRevision: input.actor.checkpointRevision,
    readback: receiptReadback(input.actor, {
      error: {
        code: input.code,
        message: input.message,
        ...(input.details ?? {}),
      },
    }),
    createdAt: input.nowUtc,
  });
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
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

export class WorkspaceOrchestratorActorStore {
  private readonly database: DatabaseSync;
  private readonly nowUtc: () => string;
  private readonly nowMono: () => number;
  private readonly crashBarrier?: WorkspaceOrchestratorCrashBarrier;
  private lastFence: ActorFence | null = null;

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

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* preserve original failure */
      }
      throw error;
    }
  }

  readActor(workspaceId: string): WorkspaceOrchestratorActor | null {
    return readActor(this.database, workspaceId);
  }

  getActor(workspaceId: string): WorkspaceOrchestratorActor | null {
    return this.readActor(workspaceId);
  }

  acquireActor(input: AcquireActorInput): AcquireActorResult {
    try {
      const pair = nowPair(input.nowUtc, input.nowMono, {
        nowUtc: this.nowUtc,
        nowMono: this.nowMono,
      });
      return this.transaction(() => {
        const current = readActor(this.database, input.workspaceId);
        const suppliedAcceptance = normalizeAcceptance(input);
        const active = activeAcceptance(this.database, input.workspaceId);
        const currentAcceptance = acceptanceFromRow(
          current as unknown as Record<string, unknown> | null,
        );
        if (
          active &&
          suppliedAcceptance.supplied &&
          !acceptanceEqual(active, suppliedAcceptance.value)
        ) {
          throw new WorkspaceOrchestratorActorError(
            "ACCEPTANCE_PROVENANCE_CONFLICT",
            "调用方 acceptance 与 active acceptance run 不一致。",
            { active, supplied: suppliedAcceptance.value },
          );
        }
        const requestedAcceptance = suppliedAcceptance.supplied
          ? suppliedAcceptance.value
          : active;
        if (
          currentAcceptance &&
          requestedAcceptance &&
          !acceptanceEqual(currentAcceptance, requestedAcceptance)
        ) {
          throw new WorkspaceOrchestratorActorError(
            "ACCEPTANCE_PROVENANCE_CONFLICT",
            "调用方 acceptance 与 durable Actor parent 不一致。",
            { parent: currentAcceptance, supplied: requestedAcceptance },
          );
        }
        const acceptance = currentAcceptance ?? requestedAcceptance;
        const buildId = String(
          input.currentBuildId ??
            input.buildId ??
            current?.currentBuildId ??
            "",
        ).trim();
        if (!buildId)
          return failure(
            "CUTOVER_REQUIRED",
            "Actor acquisition 需要 build manifest。",
          );
        if (
          !this.database
            .prepare("SELECT 1 FROM build_manifests WHERE build_id=?")
            .get(buildId)
        )
          return failure(
            "CUTOVER_REQUIRED",
            `build manifest 不存在: ${buildId}`,
          );
        const deadlines = actorDeadline(input, pair);
        if (
          current &&
          current.actorStatus !== "failed" &&
          current.leaseExpiresAtMono !== null &&
          current.controlStallDeadlineMono !== null &&
          pair.mono < current.leaseExpiresAtMono &&
          pair.mono < current.controlStallDeadlineMono
        ) {
          return Object.freeze({
            ok: false,
            code: "AUTHORITY_BUSY",
            reasonCode: "AUTHORITY_BUSY",
            message: "workspace Actor lease/control-stall 仍然有效。",
            actor: current,
            readback: current,
          });
        }
        const takeover = Boolean(current);
        const runtimeEpoch = current ? current.runtimeEpoch + 1 : 1;
        const ownerEpoch = current ? current.ownerEpoch + 1 : 1;
        const authorityRevision = current ? current.authorityRevision + 1 : 1;
        const leaseToken = String(
          input.leaseToken ??
            hashV1({
              r: "lease/v1",
              workspaceId: input.workspaceId,
              runtimeEpoch,
              ownerEpoch,
              authorityRevision,
              runtimeId: input.runtimeId ?? input.ownerId ?? null,
            }),
        );
        if (!leaseToken)
          return failure(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "lease token 不能为空。",
          );
        if (!current) {
          this.database
            .prepare(
              `INSERT INTO workspace_orchestrator_actors (
            workspace_id, actor_status, runtime_epoch, owner_epoch, authority_revision,
            lease_token, lease_expires_at_utc, lease_expires_at_mono,
            control_stall_deadline_utc, control_stall_deadline_mono,
            gate_deadline_utc, gate_deadline_mono, invocation_ordinal, mailbox_sequence,
            checkpoint_revision, migration_epoch, write_fence, current_build_id,
            acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
            created_after_event_sequence, created_after_checkpoint_revision, created_after_mono,
            created_at, updated_at
          ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.workspaceId,
              runtimeEpoch,
              ownerEpoch,
              authorityRevision,
              leaseToken,
              deadlines.leaseUtc,
              deadlines.leaseMono,
              deadlines.stallUtc,
              deadlines.stallMono,
              deadlines.gateUtc,
              deadlines.gateMono,
              input.migrationEpoch ?? 1,
              input.writeFence ?? "allow",
              buildId,
              ...acceptanceSqlValues(acceptance),
              pair.utc,
              pair.utc,
            );
        } else {
          const leasePredicate =
            current.leaseToken === null
              ? "lease_token IS NULL"
              : "lease_token=?";
          const params: SQLInputValue[] = [
            "active",
            runtimeEpoch,
            ownerEpoch,
            authorityRevision,
            leaseToken,
            deadlines.leaseUtc,
            deadlines.leaseMono,
            deadlines.stallUtc,
            deadlines.stallMono,
            deadlines.gateUtc,
            deadlines.gateMono,
            input.writeFence ?? current.writeFence,
            buildId,
            ...acceptanceSqlValues(acceptance),
            pair.utc,
            input.workspaceId,
            current.runtimeEpoch,
            current.ownerEpoch,
            current.authorityRevision,
          ];
          if (current.leaseToken !== null) params.push(current.leaseToken);
          const update = this.database
            .prepare(
              `UPDATE workspace_orchestrator_actors SET
            actor_status=?, runtime_epoch=?, owner_epoch=?, authority_revision=?, lease_token=?,
            lease_expires_at_utc=?, lease_expires_at_mono=?, control_stall_deadline_utc=?,
            control_stall_deadline_mono=?, gate_deadline_utc=?, gate_deadline_mono=?,
            write_fence=?, current_build_id=?, acceptance_run_id=?, baseline_event_sequence=?,
            baseline_checkpoint_revision=?, created_after_event_sequence=?,
            created_after_checkpoint_revision=?, created_after_mono=?, updated_at=?
            WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=? AND authority_revision=?
              AND ${leasePredicate}`,
            )
            .run(...params);
          if (affectedRows(update) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "WORKSPACE_STALE",
              "Actor takeover CAS 失败。",
            );
          this.database
            .prepare(
              `INSERT INTO daily_reconcile_gates (
            workspace_id, runtime_epoch, owner_epoch, lease_token, lease_expires_at_utc,
            lease_expires_at_mono, gate_deadline_utc, gate_deadline_mono, checkpoint_revision,
            status, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`,
            )
            .run(
              input.workspaceId,
              runtimeEpoch,
              ownerEpoch,
              leaseToken,
              deadlines.leaseUtc,
              deadlines.leaseMono,
              deadlines.gateUtc,
              deadlines.gateMono,
              current.checkpointRevision,
            );
        }
        const actor = readActor(this.database, input.workspaceId)!;
        const causationId =
          input.causationId ??
          hashV1({
            r: "authority-acquire/v1",
            workspaceId: input.workspaceId,
            runtimeEpoch,
            ownerEpoch,
            authorityRevision,
          });
        const event = appendEvent(this.database, actor, {
          eventType: takeover ? "authority.taken_over" : "authority.acquired",
          causationId,
          payload: {
            workspaceId: input.workspaceId,
            runtimeEpoch,
            ownerEpoch,
            authorityRevision,
            takeover,
            gateStatus: takeover ? "pending" : "absent",
          },
          occurredAtUtc: pair.utc,
          aggregateId: input.workspaceId,
          acceptance,
        });
        this.lastFence = actorFence(actor);
        return Object.freeze({
          ok: true,
          status: takeover ? "taken_over" : "acquired",
          actor,
          fence: this.lastFence,
          gate: readGate(this.database, input.workspaceId, runtimeEpoch),
          ...event,
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  acquire(input: AcquireActorInput): AcquireActorResult {
    return this.acquireActor(input);
  }

  takeoverActor(input: AcquireActorInput): AcquireActorResult {
    return this.acquireActor(input);
  }

  createStartupReconcileGate(input: StartupGateInput): StartupGateResult {
    try {
      const pair = nowPair(input.nowUtc, input.nowMono, {
        nowUtc: this.nowUtc,
        nowMono: this.nowMono,
      });
      return this.transaction(() => {
        const supplied = currentFenceFromInput(
          input as Record<string, unknown>,
          this.lastFence,
        );
        const actor = requireCurrentFence(
          this.database,
          input.workspaceId,
          supplied,
          pair.mono,
        );
        const existing = readGate(
          this.database,
          input.workspaceId,
          actor.runtimeEpoch,
        );
        if (existing) return Object.freeze({ ok: true, gate: existing });
        if (
          actor.leaseToken === null ||
          actor.leaseExpiresAtUtc === null ||
          actor.leaseExpiresAtMono === null ||
          actor.gateDeadlineUtc === null ||
          actor.gateDeadlineMono === null
        ) {
          throw new WorkspaceOrchestratorActorError(
            "EXECUTION_AUTHORIZATION_INVALID",
            "当前 Actor 缺少 gate deadline。",
          );
        }
        const insert = this.database
          .prepare(
            `INSERT INTO daily_reconcile_gates (
          workspace_id, runtime_epoch, owner_epoch, lease_token, lease_expires_at_utc,
          lease_expires_at_mono, gate_deadline_utc, gate_deadline_mono, checkpoint_revision,
          status, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`,
          )
          .run(
            actor.workspaceId,
            actor.runtimeEpoch,
            actor.ownerEpoch,
            actor.leaseToken,
            actor.leaseExpiresAtUtc,
            actor.leaseExpiresAtMono,
            actor.gateDeadlineUtc,
            actor.gateDeadlineMono,
            actor.checkpointRevision,
          );
        if (affectedRows(insert) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "startup gate insert CAS 失败。",
          );
        const event = appendEvent(this.database, actor, {
          eventType: "reconcile_gate.created",
          causationId: hashV1({
            r: "reconcile-gate/v1",
            workspaceId: actor.workspaceId,
            runtimeEpoch: actor.runtimeEpoch,
          }),
          payload: {
            runtimeEpoch: actor.runtimeEpoch,
            ownerEpoch: actor.ownerEpoch,
            checkpointRevision: actor.checkpointRevision,
            status: "pending",
          },
          occurredAtUtc: pair.utc,
          aggregateId: actor.workspaceId,
          parent: actor as unknown as Record<string, unknown>,
        });
        return Object.freeze({
          ok: true,
          gate: readGate(this.database, actor.workspaceId, actor.runtimeEpoch),
          ...event,
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return Object.freeze({
        ok: false,
        code: normalized.code,
        reasonCode: normalized.code,
        message: normalized.message,
      });
    }
  }

  startStartupReconcile(input: StartupGateInput): StartupGateResult {
    return this.createStartupReconcileGate(input);
  }

  beginStartupReconcile(input: StartupGateInput): StartupGateResult {
    return this.createStartupReconcileGate(input);
  }

  advanceStartupReconcileGate(input: StartupGateInput): StartupGateResult {
    try {
      const pair = nowPair(input.nowUtc, input.nowMono, {
        nowUtc: this.nowUtc,
        nowMono: this.nowMono,
      });
      return this.transaction(() => {
        const supplied = currentFenceFromInput(
          input as Record<string, unknown>,
          this.lastFence,
        );
        const actor = requireCurrentFence(
          this.database,
          input.workspaceId,
          supplied,
          pair.mono,
        );
        const current = readGate(
          this.database,
          actor.workspaceId,
          actor.runtimeEpoch,
        );
        if (!current)
          throw new WorkspaceOrchestratorActorError(
            "WORKSPACE_STALE",
            "当前 runtime 没有 startup gate。",
          );
        const target = input.status ?? "running";
        if (
          current.status === "complete" ||
          current.status === "maintenance" ||
          current.status === "failed"
        ) {
          if (current.status === target)
            return Object.freeze({ ok: true, gate: current });
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "terminal startup gate 不可回退。",
            { gate: current },
          );
        }
        if (
          !(
            ["running", "complete", "maintenance", "failed"] as string[]
          ).includes(target)
        )
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            `非法 startup gate 状态: ${target}`,
          );
        const terminal =
          target === "complete" ||
          target === "maintenance" ||
          target === "failed";
        const update = this.database
          .prepare(
            `UPDATE daily_reconcile_gates SET status=?, reason=?, finished_at_utc=?, finished_at_mono=?
          WHERE workspace_id=? AND runtime_epoch=? AND owner_epoch=? AND lease_token=?
            AND checkpoint_revision=? AND status IN ('pending','running')`,
          )
          .run(
            target,
            input.reason ?? null,
            terminal ? pair.utc : null,
            terminal ? pair.mono : null,
            actor.workspaceId,
            actor.runtimeEpoch,
            actor.ownerEpoch,
            actor.leaseToken,
            actor.checkpointRevision,
          );
        if (affectedRows(update) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "startup gate 状态 CAS 失败。",
          );
        const next = readGate(
          this.database,
          actor.workspaceId,
          actor.runtimeEpoch,
        )!;
        const event = appendEvent(this.database, actor, {
          eventType: `reconcile_gate.${target}`,
          causationId: hashV1({
            r: "reconcile-gate-transition/v1",
            workspaceId: actor.workspaceId,
            runtimeEpoch: actor.runtimeEpoch,
            status: target,
          }),
          payload: {
            runtimeEpoch: actor.runtimeEpoch,
            ownerEpoch: actor.ownerEpoch,
            checkpointRevision: actor.checkpointRevision,
            status: target,
            reason: input.reason ?? null,
          },
          occurredAtUtc: pair.utc,
          aggregateId: actor.workspaceId,
          parent: actor as unknown as Record<string, unknown>,
        });
        return Object.freeze({ ok: true, gate: next, ...event });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return Object.freeze({
        ok: false,
        code: normalized.code,
        reasonCode: normalized.code,
        message: normalized.message,
      });
    }
  }

  advanceStartupGate(input: StartupGateInput): StartupGateResult {
    return this.advanceStartupReconcileGate(input);
  }

  completeStartupReconcile(
    input: Omit<StartupGateInput, "status"> & {
      status?: "complete";
      reason?: string | null;
    },
  ): StartupGateResult {
    return this.advanceStartupReconcileGate({ ...input, status: "complete" });
  }

  acceptIntent(
    input: WorkspaceIntentInput,
  ): IntentAcceptResult | AcquireActorFailure {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    const command = input.command ?? "workspace_orchestrator.intent.accept";
    const producerId = String(
      input.producerId ??
        input.producer ??
        input.producerAttestation?.producerId ??
        input.attestation?.producerId ??
        "",
    ).trim();
    const payload =
      input.payload !== undefined
        ? input.payload
        : input.input !== undefined
          ? input.input
          : (input.logicalInput ?? null);
    const logicalInput =
      input.logicalInput !== undefined ? input.logicalInput : payload;
    let normalizedAcceptance: NormalizedAcceptance;
    let active: AcceptanceProvenance | null = null;
    try {
      normalizedAcceptance = normalizeAcceptance(input);
      active = activeAcceptance(this.database, input.workspaceId);
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
    const acceptance = normalizedAcceptance.value ?? active;
    let normalizedPolicy: readonly NormalizedChannelPolicy[] = Object.freeze(
      [],
    );
    let profileRevision = Math.max(1, finiteInteger(input.profileRevision, 1));
    let policyFailure: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    } | null = null;
    try {
      const normalized = normalizeIntentChannelPolicy(input);
      normalizedPolicy = normalized.policy;
      profileRevision = normalized.profileRevision;
    } catch (error) {
      policyFailure = normalizeError(error);
    }
    const normalizedPolicyHash = canonicalPolicyHash(
      input.workspaceId,
      profileRevision,
      normalizedPolicy,
    );
    const logicalInputHashFor = (
      candidate: AcceptanceProvenance | null,
    ): string =>
      hashV1({
        r: "logical-input/v1",
        workspaceId: input.workspaceId,
        businessDate: input.businessDate,
        source: input.source,
        rootMode: input.rootMode,
        requestedAction: input.requestedAction,
        normalizedPolicyHash,
        logicalInput,
        acceptance: candidate,
        predecessorIntentId: input.predecessorIntentId ?? null,
        predecessorRootId: input.predecessorRootId ?? null,
      });
    let logicalInputHash: string;
    let payloadHash: string;
    try {
      payloadHash = hashV1(payload);
      logicalInputHash = logicalInputHashFor(acceptance);
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message);
    }
    const attestation = normalizeAttestation(
      input.producerAttestation ?? input.attestation,
    );
    const producerAttestationHash = attestation
      ? attestationHash(attestation)
      : null;
    const commandReplayKey = hashV1({
      r: "command-replay/v1",
      workspaceId: input.workspaceId,
      producer: producerId,
      requestId: input.requestId,
    });
    const suppliedFence = currentFenceFromInput(
      input as Record<string, unknown>,
      this.lastFence,
    );
    try {
      return this.transaction(() => {
        const prior = this.database
          .prepare(
            "SELECT * FROM command_receipts WHERE workspace_id=? AND request_id=?",
          )
          .get(input.workspaceId, input.requestId) as
          Record<string, unknown> | undefined;
        if (prior) {
          const durableAcceptance = acceptanceFromRow(prior);
          const acceptanceConflict =
            normalizedAcceptance.supplied &&
            !acceptanceEqual(durableAcceptance, normalizedAcceptance.value);
          const replayAcceptance = acceptanceConflict
            ? durableAcceptance
            : normalizedAcceptance.supplied
              ? normalizedAcceptance.value
              : durableAcceptance;
          const replayLogicalInputHash = logicalInputHashFor(replayAcceptance);
          const same =
            !acceptanceConflict &&
            receiptEnvelopeMatches(prior, {
              command,
              commandReplayKey,
              logicalInputHash: replayLogicalInputHash,
              payloadHash,
              producerAttestationHash,
            });
          if (same) {
            const canonical = readPriorReceipt(prior);
            if (canonical)
              return Object.freeze({
                ...canonical,
                receipt: canonical,
              }) as IntentAcceptResult;
          }
          const actor = readActor(this.database, input.workspaceId);
          const canonical = readPriorReceipt(prior);
          const conflictCode = acceptanceConflict
            ? "ACCEPTANCE_PROVENANCE_CONFLICT"
            : "REQUEST_REPLAY_CONFLICT";
          const conflictMessage = acceptanceConflict
            ? "同一 durable parent 已绑定不同 acceptance provenance。"
            : "同一 workspace/requestId 已绑定不同 payload、logical input 或 producer attestation。";
          const conflict = makeReceipt({
            receiptId:
              canonical?.receiptId ??
              String(
                prior.id ??
                  hashV1({
                    r: "command-receipt/v1",
                    workspaceId: input.workspaceId,
                    requestId: input.requestId,
                  }),
              ),
            ok: false,
            status: "rejected",
            code: conflictCode,
            reasonCode: conflictCode,
            message: conflictMessage,
            workspaceId: input.workspaceId,
            runtimeEpoch: actor?.runtimeEpoch ?? asNumber(prior.runtime_epoch),
            ownerEpoch: actor?.ownerEpoch ?? 0,
            authorityRevision: actor?.authorityRevision ?? 0,
            requestId: input.requestId,
            command,
            commandReplayKey,
            logicalInputHash,
            payloadHash,
            producerAttestationHash,
            acceptance: replayAcceptance,
            checkpointRevision: actor?.checkpointRevision ?? 0,
            readback: {
              canonicalReceipt: canonical,
              businessWrites: 0,
              durableAcceptance,
              suppliedAcceptance: normalizedAcceptance.value,
            },
            createdAt: pair.utc,
          });
          return Object.freeze({
            ...conflict,
            receipt: conflict,
          }) as IntentAcceptResult;
        }
        if (
          !prior &&
          active &&
          normalizedAcceptance.supplied &&
          !acceptanceEqual(active, normalizedAcceptance.value)
        ) {
          throw new WorkspaceOrchestratorActorError(
            "ACCEPTANCE_PROVENANCE_CONFLICT",
            "调用方 acceptance 与 active acceptance run 不一致。",
            { active, supplied: normalizedAcceptance.value },
          );
        }
        let actor: WorkspaceOrchestratorActor;
        try {
          actor = requireCurrentFence(
            this.database,
            input.workspaceId,
            suppliedFence,
            pair.mono,
          );
        } catch (error) {
          const normalized = normalizeError(error);
          return failure(
            normalized.code,
            normalized.message,
            error instanceof WorkspaceOrchestratorActorError
              ? error.details
              : undefined,
          );
        }
        const baseReceiptInput = {
          actor,
          request: input,
          command,
          commandReplayKey,
          logicalInputHash,
          payloadHash,
          producerAttestationHash,
          acceptance,
          nowUtc: pair.utc,
          actorId: producerId,
        };
        const migration = this.database
          .prepare(
            `SELECT migration_epoch, status, write_fence
          FROM workspace_migration_state WHERE workspace_id=? AND migration_epoch=?`,
          )
          .get(input.workspaceId, actor.migrationEpoch) as
          Record<string, unknown> | undefined;
        const migrationStatus = migration
          ? String(migration.status)
          : "missing";
        const migrationWriteFence = migration
          ? String(migration.write_fence)
          : "missing";
        if (
          actor.writeFence !== "allow" ||
          migrationStatus !== "complete" ||
          migrationWriteFence !== "allow"
        ) {
          const details = {
            actorWriteFence: actor.writeFence,
            migrationEpoch: actor.migrationEpoch,
            migrationStatus,
            migrationWriteFence,
          };
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            code: "WRITE_FENCE_DENIED",
            message: "workspace Actor 或 exact migration write fence 未授权。",
            details,
          });
          insertReceiptRow(
            this.database,
            receipt,
            {
              producerId,
              payloadHash,
              producerAttestationHash,
              attestation,
              writeFence: details,
            },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        if (!attestation) {
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            code: "CUTOVER_REQUIRED",
            message: "producer attestation 缺失或字段不完整。",
          });
          insertReceiptRow(
            this.database,
            receipt,
            { producerId, payloadHash, producerAttestationHash: null },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        const attestationCheck = this.verifyProducerAttestation(
          actor,
          attestation,
        );
        if (!attestationCheck.ok) {
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            producerAttestationHash,
            code: attestationCheck.code,
            message: attestationCheck.message,
            details: attestationCheck.details,
          });
          insertReceiptRow(
            this.database,
            receipt,
            { producerId, payloadHash, producerAttestationHash, attestation },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        if (policyFailure) {
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            producerAttestationHash,
            code: policyFailure.code,
            message: policyFailure.message,
            details: policyFailure.details,
          });
          insertReceiptRow(
            this.database,
            receipt,
            {
              producerId,
              payloadHash,
              producerAttestationHash,
              attestation,
              normalizedPolicyHash,
            },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        if (!gateIsComplete(this.database, actor)) {
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            producerAttestationHash,
            code: "STARTUP_RECONCILE_REQUIRED",
            message: "当前 runtime startup reconcile gate 尚未 complete。",
          });
          insertReceiptRow(
            this.database,
            receipt,
            { producerId, payloadHash, producerAttestationHash, attestation },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        const depthRow = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM orchestrator_mailbox WHERE workspace_id=? AND state IN ('enqueued','claimed')`,
          )
          .get(input.workspaceId) as Record<string, unknown> | undefined;
        const depth = asNumber(depthRow?.count);
        if (depth >= 256) {
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            producerAttestationHash,
            code: "MAILBOX_BACKPRESSURE",
            message: "orchestrator mailbox 已达到 maxMailboxDepth=256。",
            details: {
              maxMailboxDepth: 256,
              depth,
              retryAfterMono: pair.mono + 1,
              nextAction: "retry_after_drain",
            },
          });
          insertReceiptRow(
            this.database,
            receipt,
            { producerId, payloadHash, producerAttestationHash, attestation },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        if (
          input.priority !== undefined &&
          (!Number.isInteger(input.priority) || input.priority < 0)
        ) {
          const receipt = canonicalFailureReceipt({
            ...baseReceiptInput,
            producerAttestationHash,
            code: "ORCHESTRATOR_CONTRACT_ERROR",
            message: "priority 必须是非负整数。",
          });
          insertReceiptRow(
            this.database,
            receipt,
            { producerId, payloadHash, producerAttestationHash, attestation },
            "not_started",
            commandActorType(input.source),
            producerId,
            actor.checkpointRevision,
            actor.checkpointRevision,
          );
          return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
        }
        const nextActor = bumpActor(this.database, actor, pair, {
          invocationDelta: 1,
          mailboxDelta: 1,
          checkpointDelta: 1,
        });
        const intentId = hashV1({
          r: "intent/v1",
          workspaceId: input.workspaceId,
          producer: producerId,
          requestId: input.requestId,
          invocationOrdinal: nextActor.invocationOrdinal,
        });
        const invocationId = hashV1({
          r: "invocation/v1",
          workspaceId: input.workspaceId,
          intentId,
          producer: producerId,
          requestId: input.requestId,
          invocationOrdinal: nextActor.invocationOrdinal,
        });
        const causationId =
          input.causationId ??
          hashV1({
            r: "intent-causation/v1",
            workspaceId: input.workspaceId,
            requestId: input.requestId,
          });
        const coalescingMode = input.coalescingMode ?? "none";
        const priority = input.priority ?? 0;
        const expiresAtMono =
          input.expiresAtMono === undefined
            ? pair.mono + 1_200_000
            : Number(input.expiresAtMono);
        if (!Number.isFinite(expiresAtMono) || expiresAtMono < pair.mono)
          throw new WorkspaceOrchestratorActorError(
            "ORCHESTRATOR_CONTRACT_ERROR",
            "mailbox expiresAtMono 必须不早于 enqueuedAtMono。",
          );
        const expiresAtUtc = normalizedUtc(
          input.expiresAtUtc,
          utcAtMono(pair.utc, pair.mono, expiresAtMono),
        );
        const mailboxEnvelopeHash = hashV1({
          r: "mailbox-envelope/v1",
          workspaceId: input.workspaceId,
          mailboxSequence: nextActor.mailboxSequence,
          commandReplayKey,
          requestId: input.requestId,
          intentId,
          producer: producerId,
          priority,
          coalescingKey: input.coalescingKey ?? null,
          coalescingMode,
          causationId,
          logicalInputHash,
          normalizedPolicyHash,
          payloadHash,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "command-replay/v1",
          preimage: {
            r: "command-replay/v1",
            workspaceId: input.workspaceId,
            producer: producerId,
            requestId: input.requestId,
          },
          derivedValue: commandReplayKey,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "invocation/v1",
          preimage: {
            r: "invocation/v1",
            workspaceId: input.workspaceId,
            intentId,
            producer: producerId,
            requestId: input.requestId,
            invocationOrdinal: nextActor.invocationOrdinal,
          },
          derivedValue: invocationId,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "logical-input/v1",
          preimage: {
            r: "logical-input/v1",
            workspaceId: input.workspaceId,
            businessDate: input.businessDate,
            source: input.source,
            rootMode: input.rootMode,
            requestedAction: input.requestedAction,
            normalizedPolicyHash,
            logicalInput,
            acceptance,
            predecessorIntentId: input.predecessorIntentId ?? null,
            predecessorRootId: input.predecessorRootId ?? null,
          },
          derivedValue: logicalInputHash,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "producer-attestation/v1",
          preimage: {
            r: "producer-attestation/v1",
            ...Object.fromEntries(
              Object.entries(attestation).filter(
                ([key]) => key !== "producerAttestationHash",
              ),
            ),
          },
          derivedValue: attestationHash(attestation),
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "mailbox-envelope/v1",
          preimage: {
            r: "mailbox-envelope/v1",
            workspaceId: input.workspaceId,
            mailboxSequence: nextActor.mailboxSequence,
            commandReplayKey,
            requestId: input.requestId,
            intentId,
            producer: producerId,
            priority,
            coalescingKey: input.coalescingKey ?? null,
            coalescingMode,
            causationId,
            logicalInputHash,
            normalizedPolicyHash,
            payloadHash,
          },
          derivedValue: mailboxEnvelopeHash,
          createdAt: pair.utc,
        });
        this.invokeCrashBarrier("T1", "identity_registry", {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          intentId,
          phaseBoundary: "identity_registry",
        });
        this.database
          .prepare(
            `INSERT INTO orchestrator_intents (
          intent_id, workspace_id, business_date, source, root_mode, requested_action,
          request_id, command_replay_key, invocation_id, invocation_ordinal, causation_id,
          producer_id, producer_registry_entry_hash, producer_census_hash, trigger_id,
          producer_attestation_hash, logical_input_hash, normalized_policy_hash,
          predecessor_intent_id, channel_policy_json, next_action_json, checkpoint_revision,
          status, budget_json, acceptance_run_id, baseline_event_sequence,
          baseline_checkpoint_revision, created_after_event_sequence, created_after_checkpoint_revision,
          created_after_mono, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preflight_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            intentId,
            input.workspaceId,
            input.businessDate,
            input.source,
            input.rootMode,
            input.requestedAction,
            input.requestId,
            commandReplayKey,
            invocationId,
            nextActor.invocationOrdinal,
            causationId,
            producerId,
            attestation.registryEntryHash,
            attestation.censusHash,
            attestation.triggerId,
            producerAttestationHash,
            logicalInputHash,
            normalizedPolicyHash,
            input.predecessorIntentId ?? null,
            canonicalJsonV1(normalizedPolicy),
            null,
            nextActor.checkpointRevision,
            input.budget === undefined ? null : canonicalJsonV1(input.budget),
            ...acceptanceSqlValues(acceptance),
            pair.utc,
            pair.utc,
          );
        this.database
          .prepare(
            `INSERT INTO orchestrator_mailbox (
          workspace_id, mailbox_sequence, command_replay_key, request_id, intent_id, producer,
          priority, enqueued_at_utc, enqueued_at_mono, expires_at_utc, expires_at_mono,
          coalescing_key, coalescing_mode, causation_id, logical_input_hash,
          normalized_policy_hash, payload_hash, acceptance_run_id, baseline_event_sequence,
          baseline_checkpoint_revision, created_after_event_sequence, created_after_checkpoint_revision,
          created_after_mono, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enqueued')`,
          )
          .run(
            input.workspaceId,
            nextActor.mailboxSequence,
            commandReplayKey,
            input.requestId,
            intentId,
            producerId,
            priority,
            pair.utc,
            pair.mono,
            expiresAtUtc,
            expiresAtMono,
            input.coalescingKey ?? null,
            coalescingMode,
            causationId,
            logicalInputHash,
            normalizedPolicyHash,
            payloadHash,
            ...acceptanceSqlValues(acceptance),
          );
        this.invokeCrashBarrier("T1", "business_rows", {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          intentId,
          phaseBoundary: "business_rows",
        });
        this.invokeCrashBarrier("T1", "checkpoint_index", {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          intentId,
          phaseBoundary: "checkpoint_index",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType: "intent.received",
          causationId,
          businessDate: input.businessDate,
          source: input.source,
          intentId,
          invocationId,
          requestId: input.requestId,
          producerId,
          registryEntryHash: attestation.registryEntryHash,
          censusHash: attestation.censusHash,
          triggerId: attestation.triggerId,
          payload: {
            intentId,
            invocationId,
            requestId: input.requestId,
            producer: producerId,
            mailboxSequence: nextActor.mailboxSequence,
            commandReplayKey,
            logicalInputHash,
            normalizedPolicyHash,
            payloadHash,
            status: "preflight_pending",
            index: "N/A (pre-root)",
          },
          occurredAtUtc: pair.utc,
          aggregateId: intentId,
          acceptance,
        });
        this.invokeCrashBarrier("T1", "event_outbox", {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          intentId,
          phaseBoundary: "event_outbox",
        });
        const receiptId = hashV1({
          r: "command-receipt/v1",
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          commandReplayKey,
        });
        const readback = receiptReadback(nextActor, {
          acceptance,
          intent: {
            intentId,
            invocationId,
            status: "preflight_pending",
            checkpointRevision: nextActor.checkpointRevision,
          },
          mailbox: {
            mailboxSequence: nextActor.mailboxSequence,
            state: "enqueued",
            expiresAtMono,
          },
          event,
          outbox: { outboxId: event.outboxId },
          maxMailboxDepth: 256,
        });
        const receipt = makeReceipt({
          receiptId,
          ok: true,
          status: "accepted",
          code: null,
          reasonCode: null,
          message: null,
          workspaceId: input.workspaceId,
          runtimeEpoch: nextActor.runtimeEpoch,
          ownerEpoch: nextActor.ownerEpoch,
          authorityRevision: nextActor.authorityRevision,
          requestId: input.requestId,
          command,
          commandReplayKey,
          logicalInputHash,
          payloadHash,
          producerAttestationHash,
          acceptance,
          intentId,
          invocationId,
          mailboxSequence: nextActor.mailboxSequence,
          checkpointRevision: nextActor.checkpointRevision,
          readback,
          createdAt: pair.utc,
        });
        insertReceiptRow(
          this.database,
          receipt,
          {
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            command,
            producer: producerId,
            payloadHash,
            producerAttestationHash,
            attestation,
            logicalInputHash,
            normalizedPolicyHash,
            mailboxSequence: nextActor.mailboxSequence,
          },
          "committed",
          commandActorType(input.source),
          producerId,
          actor.checkpointRevision,
          nextActor.checkpointRevision,
        );
        this.lastFence = actorFence(nextActor);
        return Object.freeze({ ...receipt, receipt }) as IntentAcceptResult;
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return failure(normalized.code, normalized.message, normalized.details);
    }
  }

  createIntent(
    input: WorkspaceIntentInput,
  ): IntentAcceptResult | AcquireActorFailure {
    return this.acceptIntent(input);
  }

  submitIntent(
    input: WorkspaceIntentInput,
  ): IntentAcceptResult | AcquireActorFailure {
    return this.acceptIntent(input);
  }

  private verifyProducerAttestation(
    actor: WorkspaceOrchestratorActor,
    attestation: ProducerAttestationInput,
  ):
    | { ok: true; hash: string }
    | {
        ok: false;
        code: string;
        message: string;
        details: Record<string, unknown>;
      } {
    const hash = attestationHash(attestation);
    if (
      attestation.producerAttestationHash !== undefined &&
      attestation.producerAttestationHash !== hash
    )
      return {
        ok: false,
        code: "CUTOVER_REQUIRED",
        message: "producer attestation hash drift。",
        details: {
          expected: hash,
          actual: attestation.producerAttestationHash,
        },
      };
    if (attestation.runtimeEpoch !== actor.runtimeEpoch)
      return {
        ok: false,
        code: "CUTOVER_REQUIRED",
        message: "producer runtimeEpoch 与 Actor 不一致。",
        details: {
          expected: actor.runtimeEpoch,
          actual: attestation.runtimeEpoch,
        },
      };
    const row = this.database
      .prepare(
        `SELECT pr.*, bm.source_commit, bm.package_hash, bm.app_asar_hash, bm.schema_epoch, bm.cutover_epoch,
      bm.build_id AS manifest_build_id
      FROM producer_registry pr JOIN build_manifests bm ON bm.build_id=pr.build_id
      WHERE pr.workspace_id=? AND pr.producer_id=? AND pr.build_id=? AND pr.enabled=1`,
      )
      .get(actor.workspaceId, attestation.producerId, actor.currentBuildId) as
      Record<string, unknown> | undefined;
    if (!row)
      return {
        ok: false,
        code: "CUTOVER_REQUIRED",
        message: "unknown or disabled producer registry entry。",
        details: {
          producerId: attestation.producerId,
          buildId: actor.currentBuildId,
        },
      };
    const comparisons: Array<[string, unknown, unknown]> = [
      [
        "registryEntryHash",
        attestation.registryEntryHash,
        row.registry_entry_hash,
      ],
      ["censusHash", attestation.censusHash, row.census_hash],
      ["triggerId", attestation.triggerId, row.trigger_id],
      [
        "processImagePath",
        attestation.processImagePath,
        row.process_image_path,
      ],
      ["resourcesPath", attestation.resourcesPath, row.resources_path],
      ["buildId", attestation.buildId, row.build_id],
      ["sourceCommit", attestation.sourceCommit, row.source_commit],
      ["packageHash", attestation.packageHash, row.package_hash],
      ["appAsarHash", attestation.appAsarHash, row.app_asar_hash],
      ["schemaEpoch", attestation.schemaEpoch, row.schema_epoch],
      ["cutoverEpoch", attestation.cutoverEpoch, row.cutover_epoch],
      ["writePrincipal", attestation.writePrincipal, row.write_principal],
      [
        "authorizerRevision",
        attestation.authorizerRevision,
        row.authorizer_revision,
      ],
    ];
    for (const [field, actual, expected] of comparisons) {
      if (String(actual) !== String(expected))
        return {
          ok: false,
          code: "CUTOVER_REQUIRED",
          message: `producer attestation ${field} drift。`,
          details: { field, expected, actual },
        };
    }
    return { ok: true, hash };
  }

  closePreflight(input: ClosePreflightInput): ClosePreflightResult {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return this.transaction(() => {
        const supplied = currentFenceFromInput(
          input as Record<string, unknown>,
          this.lastFence,
        );
        const normalizedAcceptance = normalizeAcceptance(input);
        let actor: WorkspaceOrchestratorActor;
        try {
          actor = requireCurrentFence(
            this.database,
            input.workspaceId,
            supplied,
            pair.mono,
          );
        } catch (error) {
          const normalized = normalizeError(error);
          return {
            ok: false,
            code: normalized.code,
            reasonCode: normalized.code,
            message: normalized.message,
          } as ClosePreflightFailure;
        }
        const intent = input.intentId
          ? (this.database
              .prepare(
                "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
              )
              .get(input.workspaceId, input.intentId) as
              Record<string, unknown> | undefined)
          : input.requestId
            ? (this.database
                .prepare(
                  "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND request_id=?",
                )
                .get(input.workspaceId, input.requestId) as
                Record<string, unknown> | undefined)
            : undefined;
        if (!intent)
          return {
            ok: false,
            code: "NOT_FOUND",
            reasonCode: "NOT_FOUND",
            message: "intent 不存在。",
          } as ClosePreflightFailure;
        const intentId = String(intent.intent_id);
        const businessDate = String(intent.business_date);
        const source = String(intent.source);
        const acceptance = inheritAcceptance(intent, normalizedAcceptance);
        if (intent.preflight_id) {
          const existing = this.database
            .prepare(
              "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
            )
            .get(input.workspaceId, String(intent.preflight_id)) as
            Record<string, unknown> | undefined;
          if (existing) {
            assertAcceptanceMatches(intent, existing);
            return this.readClosedPreflight(existing, intent);
          }
        }
        let selected: readonly NormalizedChannelPolicy[];
        try {
          selected = normalizeChannelPolicy(
            JSON.parse(String(intent.channel_policy_json)),
          );
        } catch (error) {
          const normalized = normalizeError(error);
          return {
            ok: false,
            code: normalized.code,
            reasonCode: normalized.code,
            message: normalized.message,
            intentId,
          } as ClosePreflightFailure;
        }
        const profileRevision = Math.max(
          1,
          finiteInteger(input.profileRevision, 1),
        );
        const normalizedPolicyHash = canonicalPolicyHash(
          input.workspaceId,
          profileRevision,
          selected,
        );
        if (
          input.policyHash &&
          input.policyHash !== normalizedPolicyHash &&
          input.policyHash !== String(intent.normalized_policy_hash)
        ) {
          return {
            ok: false,
            code: "CHANNEL_POLICY_INVALID",
            reasonCode: "CHANNEL_POLICY_INVALID",
            message: "preflight policy hash 与 T1 normalized policy 不一致。",
            intentId,
          } as ClosePreflightFailure;
        }
        const preflightVersion = Math.max(
          1,
          finiteInteger(input.preflightVersion, 1),
        );
        const preflightId = hashV1({
          r: "preflight/v1",
          workspaceId: input.workspaceId,
          intentId,
          profileRevision,
          policyHash: normalizedPolicyHash,
          preflightVersion,
        });
        const resultsById = new Map<string, ChannelPreflightResultInput>();
        for (const raw of normalizeResults(input.channelResults)) {
          const channelId = String(raw.channelId ?? "").trim();
          if (!channelId)
            return {
              ok: false,
              code: "ORCHESTRATOR_CONTRACT_ERROR",
              reasonCode: "ORCHESTRATOR_CONTRACT_ERROR",
              message: "preflight result 缺少 channelId。",
              intentId,
            } as ClosePreflightFailure;
          if (resultsById.has(channelId))
            return {
              ok: false,
              code: "ORCHESTRATOR_CONTRACT_ERROR",
              reasonCode: "ORCHESTRATOR_CONTRACT_ERROR",
              message: `preflight result 重复: ${channelId}`,
              intentId,
            } as ClosePreflightFailure;
          resultsById.set(channelId, raw);
        }
        const selectedIds = new Set(selected.map(({ channelId }) => channelId));
        for (const channelId of resultsById.keys())
          if (!selectedIds.has(channelId))
            return {
              ok: false,
              code: "CHANNEL_POLICY_INVALID",
              reasonCode: "CHANNEL_POLICY_INVALID",
              message: `preflight result 包含未选择渠道: ${channelId}`,
              intentId,
            } as ClosePreflightFailure;
        const readyChannelIds: string[] = [];
        const excludedOptionalChannelIds: string[] = [];
        const requiredFailures: Record<string, unknown>[] = [];
        const coverageGap: Record<string, unknown>[] = [];
        const normalizedResults: Record<string, unknown>[] = [];
        let hasRepairableRequiredFailure = false;
        let hasUnrecoverableRequiredFailure = false;
        for (const policy of selected) {
          const raw = resultsById.get(policy.channelId) ?? {
            channelId: policy.channelId,
            status: "not_run",
            reasonCode: "NOT_RUN",
          };
          const ready = isReadyResult(raw);
          const probeRunning = isProbeRunningResult(raw);
          const probeExpiry = probeRunning
            ? normalizedProbeExpiry(raw, pair)
            : null;
          const normalized: Record<string, unknown> = {
            channelId: policy.channelId,
            requiredness: policy.requiredness,
            module: policy.module,
            status: ready ? "ready" : resultStatus(raw) || "failed",
            reasonCode: ready ? null : reasonCode(raw, "UNKNOWN"),
            capability: raw.capability ?? null,
            configRevision: raw.configRevision ?? null,
            authRevision: raw.authRevision ?? null,
            capabilityRevision: raw.capabilityRevision ?? null,
            capabilityLeaseId: raw.capabilityLeaseId ?? null,
            checkedAtUtc: raw.checkedAtUtc ?? null,
            expiresAtUtc: probeExpiry?.utc ?? raw.expiresAtUtc ?? null,
            expiresAtMono: probeExpiry?.mono ?? raw.expiresAtMono ?? null,
            probeRequestId: raw.probeRequestId ?? null,
            probeReceiptHash: raw.probeReceiptHash ?? null,
          };
          if (probeRunning) {
            const probeRequestId = String(
              raw.probeRequestId ??
                hashV1({
                  r: "preflight-probe-request/v1",
                  workspaceId: input.workspaceId,
                  preflightId,
                  channelId: policy.channelId,
                }),
            );
            const lease = probeLeaseIdentity({
              workspaceId: input.workspaceId,
              preflightId,
              channelId: policy.channelId,
              probeRequestId,
              capabilityLeaseId:
                raw.capabilityLeaseId === undefined ||
                raw.capabilityLeaseId === null
                  ? null
                  : String(raw.capabilityLeaseId),
              attempt: 0,
              expiresAtUtc: probeExpiry!.utc,
              expiresAtMono: probeExpiry!.mono,
            });
            normalized.probeRequestId = probeRequestId;
            normalized.probeLease = lease;
            normalized.probeLeaseId = lease.leaseId;
            normalized.probeLeaseToken = lease.leaseToken;
            normalized.probeLeaseAttempt = 0;
            normalized.probeResumeCount = 0;
            normalized.probeLeaseStatus = "running";
            normalized.probeLeaseHistory = [];
            normalized.probeNextLeaseExpiresAtUtc = lease.expiresAtUtc;
            normalized.probeNextLeaseExpiresAtMono = lease.expiresAtMono;
          }
          normalizedResults.push(normalized);
          if (ready) {
            readyChannelIds.push(policy.channelId);
          } else if (policy.requiredness === "required") {
            const failureRow = {
              channelId: policy.channelId,
              requiredness: policy.requiredness,
              reasonCode: normalized.reasonCode,
              status: normalized.status,
            };
            requiredFailures.push(failureRow);
            hasRepairableRequiredFailure ||= isRepairableRequiredFailure(raw);
            hasUnrecoverableRequiredFailure ||=
              isUnrecoverableRequiredFailure(raw);
          } else {
            excludedOptionalChannelIds.push(policy.channelId);
            const gap = {
              channelId: policy.channelId,
              requiredness: policy.requiredness,
              reasonCode: normalized.reasonCode,
              status: normalized.status,
            };
            coverageGap.push(gap);
          }
        }
        const pendingProbeStates = normalizedResults
          .map(probeStateFromResult)
          .filter((value): value is Record<string, unknown> =>
            Boolean(value && String(value.status ?? "running") === "running"),
          );
        const hasPendingProbes = pendingProbeStates.length > 0;
        let aggregateDeadlineMono =
          input.aggregateDeadlineMono === undefined ||
          input.aggregateDeadlineMono === null
            ? hasPendingProbes
              ? pair.mono + PREFLIGHT_PROBE_LEASE_TTL * 3
              : null
            : Number(input.aggregateDeadlineMono);
        if (aggregateDeadlineMono !== null) {
          if (
            !Number.isFinite(aggregateDeadlineMono) ||
            aggregateDeadlineMono < 0
          )
            throw new WorkspaceOrchestratorActorError(
              "ORCHESTRATOR_CONTRACT_ERROR",
              "aggregateDeadlineMono 必须是非负有限数。",
            );
          aggregateDeadlineMono = Math.trunc(aggregateDeadlineMono);
        }
        const aggregateDeadlineUtc =
          aggregateDeadlineMono === null
            ? null
            : normalizedUtc(
                input.aggregateDeadlineUtc,
                utcAtMono(pair.utc, pair.mono, aggregateDeadlineMono),
              );
        const allRequiredReady = selected
          .filter(({ requiredness }) => requiredness === "required")
          .every(({ channelId }) => readyChannelIds.includes(channelId));
        const anyReady = readyChannelIds.length > 0;
        let status: ClosePreflightSuccess["status"];
        let snapshotStatus: PreflightSnapshotReadback["status"];
        let code: string | null = null;
        let nextAction: Readonly<Record<string, unknown>> | null = null;
        if (
          hasPendingProbes &&
          aggregateDeadlineMono !== null &&
          pair.mono >= aggregateDeadlineMono
        ) {
          status = "failed";
          snapshotStatus = "failed";
          code = "PRECHECK_DEADLINE";
          nextAction = {
            kind: "preflight_recovery_terminal",
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            reasonCode: code,
            ownerAction: false,
            resumeCount: 0,
            maxResumes: MAX_PREFLIGHT_RESUMES,
          };
        } else if (hasPendingProbes) {
          status = "running";
          snapshotStatus = "frozen";
          const probe = pendingProbeStates[0];
          nextAction = {
            kind: "preflight_recovery_wait",
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            reasonCode: "PROBE_HUNG",
            ownerAction: false,
            resumeCount: 0,
            maxResumes: MAX_PREFLIGHT_RESUMES,
            probe,
            aggregateDeadlineUtc,
            aggregateDeadlineMono,
          };
        } else if (hasUnrecoverableRequiredFailure) {
          status = "failed";
          snapshotStatus = "failed";
          code = "CHANNEL_PREFLIGHT_FAILED";
        } else if (hasRepairableRequiredFailure) {
          status = "needs_user";
          snapshotStatus = "needs_user";
          code = "CHANNEL_CONFIGURATION_REQUIRED";
          nextAction = {
            kind: "repair_required_channel",
            workspaceId: input.workspaceId,
            profileRevision,
            channelIds: requiredFailures.map((row) => row.channelId),
            reasonCode: requiredFailures.map((row) => row.reasonCode),
          };
        } else if (!anyReady) {
          status = "partial";
          snapshotStatus = "frozen";
          code =
            selected.length === 0
              ? "NO_CHANNEL_SELECTED"
              : "CHANNELS_ALL_FAILED";
          nextAction = {
            kind: "start_new_intent",
            workspaceId: input.workspaceId,
            reasonCode: code,
          };
        } else if (!allRequiredReady) {
          status = "partial";
          snapshotStatus = "frozen";
          code = "CHANNELS_ALL_FAILED";
          nextAction = {
            kind: "repair_required_channel",
            workspaceId: input.workspaceId,
            channelIds: requiredFailures.map((row) => row.channelId),
          };
        } else {
          status = "admitted";
          snapshotStatus = "frozen";
        }
        const hashableResults = normalizedResults.map(hashablePreflightResult);
        const preflightHash = hashV1({
          r: "preflight-snapshot/v1",
          workspaceId: input.workspaceId,
          intentId,
          preflightId,
          profileRevision,
          policyHash: normalizedPolicyHash,
          preflightVersion,
          orderedSelectedChannels: selected,
          orderedChannelResults: hashableResults,
          readyChannelIds: readyChannelIds.slice().sort(compareCodePoints),
          excludedOptionalChannelIds: excludedOptionalChannelIds
            .slice()
            .sort(compareCodePoints),
          requiredFailures,
          coverageGap,
          aggregateDeadline: {
            utc: aggregateDeadlineUtc,
            mono: aggregateDeadlineMono,
          },
          status: snapshotStatus,
        });
        const existingById = this.database
          .prepare(
            "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
          )
          .get(input.workspaceId, preflightId) as
          Record<string, unknown> | undefined;
        if (existingById) {
          assertAcceptanceMatches(intent, existingById);
          return this.readClosedPreflight(existingById, intent);
        }
        const nextActor = bumpActor(this.database, actor, pair, {
          checkpointDelta: 1,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "normalized-policy/v1",
          preimage: {
            r: "normalized-policy/v1",
            workspaceId: input.workspaceId,
            profileRevision,
            policy: selected,
          },
          derivedValue: normalizedPolicyHash,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "preflight/v1",
          preimage: {
            r: "preflight/v1",
            workspaceId: input.workspaceId,
            intentId,
            profileRevision,
            policyHash: normalizedPolicyHash,
            preflightVersion,
          },
          derivedValue: preflightId,
          createdAt: pair.utc,
        });
        insertIdentity(this.database, {
          workspaceId: input.workspaceId,
          registryName: "preflight-snapshot/v1",
          preimage: {
            r: "preflight-snapshot/v1",
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            profileRevision,
            policyHash: normalizedPolicyHash,
            preflightVersion,
            orderedSelectedChannels: selected,
            orderedChannelResults: hashableResults,
            readyChannelIds: readyChannelIds.slice().sort(compareCodePoints),
            excludedOptionalChannelIds: excludedOptionalChannelIds
              .slice()
              .sort(compareCodePoints),
            requiredFailures,
            coverageGap,
            aggregateDeadline: {
              utc: aggregateDeadlineUtc,
              mono: aggregateDeadlineMono,
            },
            status: snapshotStatus,
          },
          derivedValue: preflightHash,
          createdAt: pair.utc,
        });
        this.invokeCrashBarrier("T2", "identity_registry", {
          workspaceId: input.workspaceId,
          intentId,
          requestId: String(intent.request_id),
          phaseBoundary: "identity_registry",
        });
        const finishedAt = pair.utc;
        this.database
          .prepare(
            `INSERT INTO channel_preflight_snapshots (
          preflight_id, workspace_id, intent_id, business_date, source, profile_revision,
          policy_hash, preflight_version, selected_channels_json, results_json,
          ready_channel_ids_json, excluded_optional_channel_ids_json, required_failures_json,
          coverage_gap_json, aggregate_deadline_utc, aggregate_deadline_mono,
          preflight_hash, status, acceptance_run_id, baseline_event_sequence,
          baseline_checkpoint_revision, created_after_event_sequence, created_after_checkpoint_revision,
          created_after_mono, created_at, finished_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
          )
          .run(
            preflightId,
            input.workspaceId,
            intentId,
            businessDate,
            source,
            profileRevision,
            normalizedPolicyHash,
            preflightVersion,
            canonicalJsonV1(selected),
            canonicalJsonV1(normalizedResults),
            canonicalJsonV1(readyChannelIds.slice().sort(compareCodePoints)),
            canonicalJsonV1(
              excludedOptionalChannelIds.slice().sort(compareCodePoints),
            ),
            canonicalJsonV1(requiredFailures),
            canonicalJsonV1(coverageGap),
            aggregateDeadlineUtc,
            aggregateDeadlineMono,
            preflightHash,
            snapshotStatus,
            ...acceptanceSqlValues(acceptance),
            pair.utc,
            finishedAt,
          );
        const terminal =
          status === "needs_user" ||
          status === "failed" ||
          status === "partial";
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET
          preflight_id=?, normalized_policy_hash=?, next_action_json=?, checkpoint_revision=?, status=?,
          coverage_gap_json=?, stop_reason_json=?, preflight_deadline_utc=?, preflight_deadline_mono=?, updated_at=?, finished_at=?
          WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=?
            AND status IN ('received','preflight_pending','preflight_running','waiting_resource')`,
          )
          .run(
            preflightId,
            normalizedPolicyHash,
            nextAction ? canonicalJsonV1(nextAction) : null,
            nextActor.checkpointRevision,
            status,
            canonicalJsonV1(coverageGap),
            code ? canonicalJsonV1({ reasonCode: code }) : null,
            aggregateDeadlineUtc,
            aggregateDeadlineMono,
            pair.utc,
            terminal ? pair.utc : null,
            input.workspaceId,
            intentId,
            asNumber(intent.checkpoint_revision),
          );
        if (affectedRows(intentUpdate) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "intent preflight CAS 失败。",
          );
        this.invokeCrashBarrier("T2", "business_rows", {
          workspaceId: input.workspaceId,
          intentId,
          requestId: String(intent.request_id),
          phaseBoundary: "business_rows",
        });
        const event = appendEvent(this.database, nextActor, {
          eventType:
            status === "running"
              ? "preflight.recovery_wait"
              : "preflight.completed",
          causationId: String(intent.causation_id),
          businessDate,
          source,
          intentId,
          requestId: String(intent.request_id),
          producerId: asNullableString(intent.producer_id),
          registryEntryHash: asNullableString(
            intent.producer_registry_entry_hash,
          ),
          censusHash: asNullableString(intent.producer_census_hash),
          triggerId: asNullableString(intent.trigger_id),
          payload: {
            intentId,
            preflightId,
            preflightHash,
            status,
            snapshotStatus,
            readyChannelIds,
            excludedOptionalChannelIds,
            requiredFailures,
            coverageGap,
            nextAction,
            rootCreated: false,
            workerCreated: false,
            ...(code && !["admitted"].includes(status)
              ? { creation_forbidden_reason: code }
              : {}),
          },
          occurredAtUtc: pair.utc,
          aggregateId: intentId,
          parent: intent,
        });
        this.invokeCrashBarrier("T2", "event_outbox", {
          workspaceId: input.workspaceId,
          intentId,
          requestId: String(intent.request_id),
          phaseBoundary: "event_outbox",
        });
        this.lastFence = actorFence(nextActor);
        const snapshot = this.readSnapshotRow(
          this.database
            .prepare(
              "SELECT * FROM channel_preflight_snapshots WHERE preflight_id=?",
            )
            .get(preflightId) as Record<string, unknown>,
        );
        return Object.freeze({
          ok: true,
          status,
          code,
          reasonCode: code,
          intentId,
          preflightId,
          preflightHash,
          snapshot,
          nextAction,
          coverageGap: Object.freeze(coverageGap),
          readback: {
            actor: nextActor,
            acceptance,
            event,
            rootCount: 0,
            stageClaimCount: 0,
            managedJobCount: 0,
            rootCreated: false,
            workerCreated: false,
          },
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return {
        ok: false,
        code: normalized.code,
        reasonCode: normalized.code,
        message: normalized.message,
      };
    }
  }

  recoverPreflight(input: PreflightRecoveryInput): PreflightRecoveryResult {
    try {
      const pair = nowPair(input.nowUtc, input.nowMono, {
        nowUtc: this.nowUtc,
        nowMono: this.nowMono,
      });
      return this.transaction(() => {
        const supplied = currentFenceFromInput(
          input as Record<string, unknown>,
          this.lastFence,
        );
        const actor = requireCurrentFence(
          this.database,
          input.workspaceId,
          supplied,
          pair.mono,
        );
        let snapshotRow = input.preflightId
          ? (this.database
              .prepare(
                "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
              )
              .get(input.workspaceId, input.preflightId) as
              Record<string, unknown> | undefined)
          : undefined;
        if (!snapshotRow && input.intentId) {
          snapshotRow = this.database
            .prepare(
              "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND intent_id=? ORDER BY created_at DESC LIMIT 1",
            )
            .get(input.workspaceId, input.intentId) as
            Record<string, unknown> | undefined;
        }
        if (!snapshotRow)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "preflight snapshot 不存在。",
            {
              workspaceId: input.workspaceId,
              preflightId: input.preflightId ?? null,
              intentId: input.intentId ?? null,
            },
          );
        const intentId = String(snapshotRow.intent_id);
        const preflightId = String(snapshotRow.preflight_id);
        const intent = this.database
          .prepare(
            "SELECT * FROM orchestrator_intents WHERE workspace_id=? AND intent_id=?",
          )
          .get(input.workspaceId, intentId) as
          Record<string, unknown> | undefined;
        if (!intent)
          throw new WorkspaceOrchestratorActorError(
            "NOT_FOUND",
            "preflight intent 不存在。",
            { workspaceId: input.workspaceId, intentId },
          );
        const parseNextAction = (): Readonly<
          Record<string, unknown>
        > | null => {
          const parsed = parseJsonObject(intent.next_action_json);
          return parsed ? Object.freeze(parsed) : null;
        };
        const parseStopReason = (): Readonly<
          Record<string, unknown>
        > | null => {
          const parsed = parseJsonObject(intent.stop_reason_json);
          return parsed ? Object.freeze(parsed) : null;
        };
        const intentStatus = String(intent.status);
        const snapshot = this.readSnapshotRow(snapshotRow);
        const storedResults = parseJsonArray(snapshotRow.results_json).map(
          (value) => parseJsonObject(value) ?? {},
        ) as Record<string, unknown>[];
        const probeStates = storedResults
          .map(probeStateFromResult)
          .filter((value): value is Record<string, unknown> => Boolean(value));
        const firstProbe = probeStates[0] ?? null;
        const terminalIntent = [
          "succeeded",
          "partial",
          "failed",
          "needs_user",
          "cancelled",
        ].includes(intentStatus);
        if (terminalIntent || snapshot.status === "failed") {
          const stopReason = parseStopReason();
          const code =
            stopReason && typeof stopReason.reasonCode === "string"
              ? stopReason.reasonCode
              : null;
          return Object.freeze({
            ok: true,
            status: "replayed",
            replayed: true,
            code,
            reasonCode: code,
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            preflightHash: snapshot.preflightHash,
            probe: firstProbe,
            nextAction: parseNextAction(),
            snapshot,
            fence: actorFence(actor),
            actions: Object.freeze([]),
            readback: {
              rootCount: 0,
              stageClaimCount: 0,
              managedJobCount: 0,
              rootCreated: false,
              workerCreated: false,
            },
          });
        }
        const deadlineRaw =
          snapshotRow.aggregate_deadline_mono ?? intent.preflight_deadline_mono;
        const deadlineMono =
          deadlineRaw === null ||
          deadlineRaw === undefined ||
          !Number.isFinite(Number(deadlineRaw))
            ? null
            : Math.trunc(Number(deadlineRaw));
        const deadlineUtc =
          snapshotRow.aggregate_deadline_utc ??
          intent.preflight_deadline_utc ??
          null;
        const nowAtOrAfterDeadline =
          deadlineMono !== null && pair.mono >= deadlineMono;
        const expiredProbe =
          probeStates.find(
            (probe) =>
              probe.expiresAtMono !== null &&
              probe.expiresAtMono !== undefined &&
              pair.mono >= Number(probe.expiresAtMono),
          ) ?? null;
        const alreadyResumed = storedResults.some(
          (result) =>
            finiteInteger(result.probeResumeCount, 0) >= MAX_PREFLIGHT_RESUMES,
        );
        const shouldTerminalize =
          input.interrupted === true ||
          nowAtOrAfterDeadline ||
          Boolean(expiredProbe && alreadyResumed);
        if (shouldTerminalize) {
          const reasonCodeValue =
            input.interrupted === true
              ? "PRECHECK_INTERRUPTED"
              : "PRECHECK_DEADLINE";
          const terminalAction = Object.freeze({
            kind: "preflight_recovery_terminal",
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            reasonCode: reasonCodeValue,
            ownerAction: false,
            resumeCount: alreadyResumed ? MAX_PREFLIGHT_RESUMES : 0,
            maxResumes: MAX_PREFLIGHT_RESUMES,
            aggregateDeadlineUtc: deadlineUtc,
            aggregateDeadlineMono: deadlineMono,
          });
          const terminalResults = storedResults.map((result) => {
            const state = probeStateFromResult(result);
            if (!state) return result;
            return {
              ...result,
              reasonCode: reasonCodeValue,
              probeLeaseStatus: "terminal",
              probeLeaseHistory: [
                ...parseJsonArray(state.history),
                {
                  ...state,
                  status: "terminal",
                  terminalAtUtc: pair.utc,
                  terminalAtMono: pair.mono,
                },
              ],
            };
          });
          const nextActor = bumpActor(this.database, actor, pair, {
            checkpointDelta: 1,
          });
          const snapshotUpdate = this.database
            .prepare(
              `UPDATE channel_preflight_snapshots SET results_json=?, status='failed', finished_at=?
            WHERE workspace_id=? AND preflight_id=? AND status='frozen'`,
            )
            .run(
              canonicalJsonV1(terminalResults),
              pair.utc,
              input.workspaceId,
              preflightId,
            );
          if (affectedRows(snapshotUpdate) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "preflight terminal snapshot CAS 失败。",
            );
          const intentUpdate = this.database
            .prepare(
              `UPDATE orchestrator_intents SET status='failed', next_action_json=?, stop_reason_json=?, checkpoint_revision=?, updated_at=?, finished_at=?
            WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=? AND status IN ('received','preflight_pending','preflight_running','waiting_resource','running')`,
            )
            .run(
              canonicalJsonV1(terminalAction),
              canonicalJsonV1({ reasonCode: reasonCodeValue }),
              nextActor.checkpointRevision,
              pair.utc,
              pair.utc,
              input.workspaceId,
              intentId,
              asNumber(intent.checkpoint_revision),
            );
          if (affectedRows(intentUpdate) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "preflight terminal intent CAS 失败。",
            );
          this.database
            .prepare(
              `UPDATE orchestrator_mailbox SET state='failed', finished_at_utc=?, finished_at_mono=?
            WHERE workspace_id=? AND intent_id=? AND state IN ('enqueued','claimed')`,
            )
            .run(pair.utc, pair.mono, input.workspaceId, intentId);
          this.invokeCrashBarrier("T2", "business_rows", {
            workspaceId: input.workspaceId,
            intentId,
            requestId: String(intent.request_id),
            phaseBoundary: "business_rows",
          });
          const event = appendEvent(this.database, nextActor, {
            eventType: "preflight.recovery_terminal",
            causationId: hashV1({
              r: "preflight-recovery-terminal/v1",
              workspaceId: input.workspaceId,
              preflightId,
              reasonCode: reasonCodeValue,
            }),
            businessDate: String(intent.business_date),
            source: String(intent.source),
            intentId,
            requestId: String(intent.request_id),
            producerId: asNullableString(intent.producer_id),
            registryEntryHash: asNullableString(
              intent.producer_registry_entry_hash,
            ),
            censusHash: asNullableString(intent.producer_census_hash),
            triggerId: asNullableString(intent.trigger_id),
            acceptance: acceptanceFromRow(intent),
            parent: intent,
            payload: {
              intentId,
              preflightId,
              reasonCode: reasonCodeValue,
              nextAction: terminalAction,
              rootCreated: false,
              workerCreated: false,
            },
            occurredAtUtc: pair.utc,
            aggregateId: intentId,
          });
          this.invokeCrashBarrier("T2", "event_outbox", {
            workspaceId: input.workspaceId,
            intentId,
            requestId: String(intent.request_id),
            phaseBoundary: "event_outbox",
          });
          this.lastFence = actorFence(nextActor);
          const nextSnapshotRow = this.database
            .prepare(
              "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
            )
            .get(input.workspaceId, preflightId) as Record<string, unknown>;
          return Object.freeze({
            ok: true,
            status: "terminal",
            replayed: false,
            code: reasonCodeValue,
            reasonCode: reasonCodeValue,
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            preflightHash: String(snapshotRow.preflight_hash),
            probe: firstProbe,
            nextAction: terminalAction,
            snapshot: this.readSnapshotRow(nextSnapshotRow),
            event,
            fence: actorFence(nextActor),
            actions: Object.freeze([
              "terminalize_preflight",
              "terminalize_intent",
              "terminalize_mailbox",
            ]),
            readback: {
              actor: nextActor,
              rootCount: 0,
              stageClaimCount: 0,
              managedJobCount: 0,
              rootCreated: false,
              workerCreated: false,
            },
          });
        }
        if (!expiredProbe) {
          const waitingAction =
            parseNextAction() ??
            Object.freeze({
              kind: "preflight_recovery_wait",
              workspaceId: input.workspaceId,
              intentId,
              preflightId,
              reasonCode: "PROBE_HUNG",
              ownerAction: false,
              resumeCount: alreadyResumed ? MAX_PREFLIGHT_RESUMES : 0,
              maxResumes: MAX_PREFLIGHT_RESUMES,
              aggregateDeadlineUtc: deadlineUtc,
              aggregateDeadlineMono: deadlineMono,
              probe: firstProbe,
            });
          return Object.freeze({
            ok: true,
            status: alreadyResumed ? "replayed" : "waiting",
            replayed: alreadyResumed,
            code: "PROBE_HUNG",
            reasonCode: "PROBE_HUNG",
            workspaceId: input.workspaceId,
            intentId,
            preflightId,
            preflightHash: snapshot.preflightHash,
            probe: firstProbe,
            nextAction: waitingAction,
            snapshot,
            fence: actorFence(actor),
            actions: Object.freeze([]),
            readback: {
              rootCount: 0,
              stageClaimCount: 0,
              managedJobCount: 0,
              rootCreated: false,
              workerCreated: false,
            },
          });
        }
        const targetState = expiredProbe;
        const nextAttempt = finiteInteger(targetState.attempt, 0) + 1;
        const nextResumeCount = finiteInteger(targetState.resumeCount, 0) + 1;
        const nextExpiryMono = Math.min(
          pair.mono + PREFLIGHT_PROBE_LEASE_TTL,
          deadlineMono ?? pair.mono + PREFLIGHT_PROBE_LEASE_TTL,
        );
        if (nextExpiryMono <= pair.mono)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "probe lease 已无可用 resume 预算。",
          );
        const nextLease = probeLeaseIdentity({
          workspaceId: input.workspaceId,
          preflightId,
          channelId: String(targetState.channelId),
          probeRequestId: String(targetState.probeRequestId),
          capabilityLeaseId:
            targetState.capabilityLeaseId === null ||
            targetState.capabilityLeaseId === undefined
              ? null
              : String(targetState.capabilityLeaseId),
          attempt: nextAttempt,
          expiresAtUtc: utcAtMono(pair.utc, pair.mono, nextExpiryMono),
          expiresAtMono: nextExpiryMono,
        });
        const nextResults = storedResults.map((result) => {
          if (String(result.channelId) !== String(targetState.channelId))
            return result;
          const priorLease = parseJsonObject(result.probeLease) ?? targetState;
          const history = [
            ...parseJsonArray(result.probeLeaseHistory),
            {
              ...priorLease,
              status: "expired",
              expiredAtUtc: pair.utc,
              expiredAtMono: pair.mono,
            },
          ];
          return {
            ...result,
            status: "running",
            reasonCode: "PROBE_RESUMED",
            expiresAtUtc: nextLease.expiresAtUtc,
            expiresAtMono: nextLease.expiresAtMono,
            probeLease: nextLease,
            probeLeaseId: nextLease.leaseId,
            probeLeaseToken: nextLease.leaseToken,
            probeLeaseAttempt: nextAttempt,
            probeResumeCount: nextResumeCount,
            probeLeaseStatus: "running",
            probeLeaseHistory: history,
            probeNextLeaseExpiresAtUtc: nextLease.expiresAtUtc,
            probeNextLeaseExpiresAtMono: nextLease.expiresAtMono,
          };
        });
        const probe = probeStateFromResult(
          nextResults.find(
            (result) =>
              String(result.channelId) === String(targetState.channelId),
          )!,
        );
        const resumeAction = Object.freeze({
          kind: "preflight_recovery_resume",
          workspaceId: input.workspaceId,
          intentId,
          preflightId,
          reasonCode: "PROBE_RESUMED",
          ownerAction: false,
          resumeCount: nextResumeCount,
          maxResumes: MAX_PREFLIGHT_RESUMES,
          probe,
          aggregateDeadlineUtc: deadlineUtc,
          aggregateDeadlineMono: deadlineMono,
        });
        const nextActor = bumpActor(this.database, actor, pair, {
          checkpointDelta: 1,
        });
        const snapshotUpdate = this.database
          .prepare(
            `UPDATE channel_preflight_snapshots SET results_json=?
          WHERE workspace_id=? AND preflight_id=? AND status='frozen'`,
          )
          .run(canonicalJsonV1(nextResults), input.workspaceId, preflightId);
        if (affectedRows(snapshotUpdate) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "preflight resume snapshot CAS 失败。",
          );
        const intentUpdate = this.database
          .prepare(
            `UPDATE orchestrator_intents SET status='running', next_action_json=?, checkpoint_revision=?, updated_at=?
          WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=? AND status IN ('received','preflight_pending','preflight_running','waiting_resource','running')`,
          )
          .run(
            canonicalJsonV1(resumeAction),
            nextActor.checkpointRevision,
            pair.utc,
            input.workspaceId,
            intentId,
            asNumber(intent.checkpoint_revision),
          );
        if (affectedRows(intentUpdate) !== 1)
          throw new WorkspaceOrchestratorActorError(
            "STATE_CONFLICT",
            "preflight resume intent CAS 失败。",
          );
        const event = appendEvent(this.database, nextActor, {
          eventType: "preflight.probe_resumed",
          causationId: hashV1({
            r: "preflight-probe-resume/v1",
            workspaceId: input.workspaceId,
            preflightId,
            channelId: targetState.channelId,
            attempt: nextAttempt,
          }),
          businessDate: String(intent.business_date),
          source: String(intent.source),
          intentId,
          requestId: String(intent.request_id),
          producerId: asNullableString(intent.producer_id),
          registryEntryHash: asNullableString(
            intent.producer_registry_entry_hash,
          ),
          censusHash: asNullableString(intent.producer_census_hash),
          triggerId: asNullableString(intent.trigger_id),
          acceptance: acceptanceFromRow(intent),
          parent: intent,
          payload: {
            intentId,
            preflightId,
            probe,
            nextAction: resumeAction,
            rootCreated: false,
            workerCreated: false,
          },
          occurredAtUtc: pair.utc,
          aggregateId: intentId,
        });
        this.lastFence = actorFence(nextActor);
        const nextSnapshotRow = this.database
          .prepare(
            "SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?",
          )
          .get(input.workspaceId, preflightId) as Record<string, unknown>;
        return Object.freeze({
          ok: true,
          status: "resumed",
          replayed: false,
          code: "PROBE_RESUMED",
          reasonCode: "PROBE_RESUMED",
          workspaceId: input.workspaceId,
          intentId,
          preflightId,
          preflightHash: String(snapshotRow.preflight_hash),
          probe,
          nextAction: resumeAction,
          snapshot: this.readSnapshotRow(nextSnapshotRow),
          event,
          fence: actorFence(nextActor),
          actions: Object.freeze(["resume_probe"]),
          readback: {
            actor: nextActor,
            rootCount: 0,
            stageClaimCount: 0,
            managedJobCount: 0,
            rootCreated: false,
            workerCreated: false,
          },
        });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return Object.freeze({
        ok: false,
        status: "failed",
        code: normalized.code,
        reasonCode: normalized.code,
        message: normalized.message,
        workspaceId: input.workspaceId,
        actions: Object.freeze([]),
        readback: normalized.details ?? {},
      });
    }
  }

  watchdogPreflight(input: PreflightRecoveryInput): PreflightRecoveryResult {
    return this.recoverPreflight(input);
  }

  recoverPreflightWatchdog(
    input: PreflightRecoveryInput,
  ): PreflightRecoveryResult {
    return this.recoverPreflight(input);
  }

  reconcilePreflightRecovery(
    input: PreflightRecoveryInput,
  ): PreflightRecoveryResult {
    return this.recoverPreflight({ ...input, startup: true });
  }

  completePreflight(input: ClosePreflightInput): ClosePreflightResult {
    return this.closePreflight(input);
  }

  freezePreflight(input: ClosePreflightInput): ClosePreflightResult {
    return this.closePreflight(input);
  }

  private readSnapshotRow(
    row: Record<string, unknown>,
  ): PreflightSnapshotReadback {
    const parseArray = (value: unknown): unknown[] => {
      if (typeof value !== "string") return [];
      try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return Object.freeze({
      preflightId: String(row.preflight_id),
      preflightHash: String(row.preflight_hash),
      workspaceId: String(row.workspace_id),
      intentId: String(row.intent_id),
      businessDate: String(row.business_date),
      source: String(row.source),
      profileRevision: asNumber(row.profile_revision),
      policyHash: String(row.policy_hash),
      preflightVersion: asNumber(row.preflight_version),
      selectedChannels: Object.freeze(
        parseArray(row.selected_channels_json) as NormalizedChannelPolicy[],
      ),
      results: Object.freeze(
        parseArray(row.results_json) as Record<string, unknown>[],
      ),
      acceptance: acceptanceFromRow(row),
      readyChannelIds: Object.freeze(
        parseArray(row.ready_channel_ids_json) as string[],
      ),
      excludedOptionalChannelIds: Object.freeze(
        parseArray(row.excluded_optional_channel_ids_json) as string[],
      ),
      requiredFailures: Object.freeze(
        parseArray(row.required_failures_json) as Record<string, unknown>[],
      ),
      coverageGap: Object.freeze(
        parseArray(row.coverage_gap_json) as Record<string, unknown>[],
      ),
      status: String(row.status) as PreflightSnapshotReadback["status"],
      createdAt: String(row.created_at),
      finishedAt: asNullableString(row.finished_at),
    });
  }

  private readClosedPreflight(
    row: Record<string, unknown>,
    intent: Record<string, unknown>,
  ): ClosePreflightSuccess {
    const snapshot = this.readSnapshotRow(row);
    const status = String(intent.status) as ClosePreflightSuccess["status"];
    let nextAction: Readonly<Record<string, unknown>> | null = null;
    if (typeof intent.next_action_json === "string") {
      try {
        nextAction = JSON.parse(intent.next_action_json) as Readonly<
          Record<string, unknown>
        >;
      } catch {
        nextAction = null;
      }
    }
    return Object.freeze({
      ok: true,
      status,
      code: null,
      reasonCode: null,
      intentId: String(intent.intent_id),
      preflightId: snapshot.preflightId,
      preflightHash: snapshot.preflightHash,
      snapshot,
      nextAction,
      coverageGap: snapshot.coverageGap,
      readback: {
        rootCount: 0,
        stageClaimCount: 0,
        managedJobCount: 0,
        rootCreated: false,
      },
    });
  }

  expireUnclaimedMailbox(input: ExpireMailboxInput): ExpireMailboxResult {
    const pair = nowPair(input.nowUtc, input.nowMono, {
      nowUtc: this.nowUtc,
      nowMono: this.nowMono,
    });
    try {
      return this.transaction(() => {
        const supplied = currentFenceFromInput(
          input as Record<string, unknown>,
          this.lastFence,
        );
        const normalizedAcceptance = normalizeAcceptance(input);
        let actor: WorkspaceOrchestratorActor;
        try {
          actor = requireCurrentFence(
            this.database,
            input.workspaceId,
            supplied,
            pair.mono,
            false,
          );
        } catch (error) {
          const normalized = normalizeError(error);
          return {
            ok: false,
            code: normalized.code,
            reasonCode: normalized.code,
            message: normalized.message,
          };
        }
        const limit = Math.max(
          1,
          Math.min(256, finiteInteger(input.limit, 256)),
        );
        const rows = this.database
          .prepare(
            `SELECT workspace_id, mailbox_sequence, request_id, intent_id, causation_id,
            acceptance_run_id, baseline_event_sequence, baseline_checkpoint_revision,
            created_after_event_sequence, created_after_checkpoint_revision, created_after_mono
          FROM orchestrator_mailbox WHERE workspace_id=? AND state='enqueued' AND expires_at_mono<=?
          ORDER BY mailbox_sequence ASC LIMIT ?`,
          )
          .all(input.workspaceId, pair.mono, limit) as Array<
          Record<string, unknown>
        >;
        const expired: ExpiredMailboxReadback[] = [];
        for (const row of rows) {
          const acceptance = inheritAcceptance(row, normalizedAcceptance);
          const currentActor = readActor(this.database, input.workspaceId)!;
          const nextActor = bumpActor(this.database, currentActor, pair, {
            checkpointDelta: 1,
          });
          const update = this.database
            .prepare(
              `UPDATE orchestrator_mailbox SET state='expired', finished_at_utc=?, finished_at_mono=?
            WHERE workspace_id=? AND mailbox_sequence=? AND state='enqueued' AND expires_at_mono<=?`,
            )
            .run(
              pair.utc,
              pair.mono,
              input.workspaceId,
              asNumber(row.mailbox_sequence),
              pair.mono,
            );
          if (affectedRows(update) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "mailbox expiry CAS 失败。",
            );
          const intentUpdate = this.database
            .prepare(
              `UPDATE orchestrator_intents SET status='partial', next_action_json=?, stop_reason_json=?, checkpoint_revision=?, updated_at=?, finished_at=?
            WHERE workspace_id=? AND intent_id=? AND checkpoint_revision=? AND status IN ('received','preflight_pending','preflight_running','waiting_resource')`,
            )
            .run(
              canonicalJsonV1({
                kind: "start_new_intent",
                reasonCode: "MAILBOX_EXPIRED",
                requestId: String(row.request_id),
              }),
              canonicalJsonV1({ reasonCode: "MAILBOX_EXPIRED" }),
              nextActor.checkpointRevision,
              pair.utc,
              pair.utc,
              input.workspaceId,
              String(row.intent_id),
              nextActor.checkpointRevision - 1,
            );
          if (affectedRows(intentUpdate) !== 1)
            throw new WorkspaceOrchestratorActorError(
              "STATE_CONFLICT",
              "expired intent CAS 失败。",
            );
          const event = appendEvent(this.database, nextActor, {
            eventType: "mailbox.expired",
            causationId: String(row.causation_id),
            intentId: String(row.intent_id),
            requestId: String(row.request_id),
            payload: {
              mailboxSequence: asNumber(row.mailbox_sequence),
              requestId: String(row.request_id),
              intentId: String(row.intent_id),
              reasonCode: "MAILBOX_EXPIRED",
              creation_forbidden_reason: "MAILBOX_EXPIRED",
              rootCreated: false,
              workerCreated: false,
            },
            occurredAtUtc: pair.utc,
            aggregateId: String(row.intent_id),
            parent: row,
            acceptance: normalizedAcceptance.supplied ? acceptance : undefined,
          });
          expired.push(
            Object.freeze({
              mailboxSequence: asNumber(row.mailbox_sequence),
              requestId: String(row.request_id),
              intentId: String(row.intent_id),
              ...event,
            }),
          );
          actor = nextActor;
        }
        this.lastFence = actorFence(actor);
        return Object.freeze({ ok: true, expired: Object.freeze(expired) });
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return {
        ok: false,
        code: normalized.code,
        reasonCode: normalized.code,
        message: normalized.message,
      };
    }
  }

  expireMailbox(input: ExpireMailboxInput): ExpireMailboxResult {
    return this.expireUnclaimedMailbox(input);
  }

  expireUnclaimedMailboxRows(input: ExpireMailboxInput): ExpireMailboxResult {
    return this.expireUnclaimedMailbox(input);
  }
}

export function createWorkspaceOrchestratorActorStore(
  database: DatabaseSync,
  options: {
    nowUtc?: () => string;
    nowMono?: () => number;
    crashBarrier?: WorkspaceOrchestratorCrashBarrier;
  } = {},
): WorkspaceOrchestratorActorStore {
  return new WorkspaceOrchestratorActorStore(database, options);
}
