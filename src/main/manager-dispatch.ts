import { randomUUID } from "node:crypto";
import type { ActiveWorkspaceRuntime } from "./workspace-runtime.ts";
import { hashV1 } from "./workspace-orchestrator-actor.ts";
import {
  readManagerAdapterProjection,
  type ManagerAdapterIdentity,
  type ManagerAdapterReadModel,
} from "./workspace-orchestrator-manager-adapter.ts";
import {
  submitWorkspaceOrchestratorIntent,
  type SubmitWorkspaceOrchestratorIntentInput,
  type WorkspaceOrchestratorReceipt,
} from "./workspace-orchestrator-runtime.ts";

export type DailyIntelligenceModule = "official_web" | "x_lists";

export type DispatchManagerDailyInput = {
  businessDate: string;
  modules?: DailyIntelligenceModule[];
  requestId?: string;
  logicalInput?: unknown;
  payload?: unknown;
  channelPolicy?: unknown;
  profileRevision?: number;
};

export type DispatchManagerDailyResult = WorkspaceOrchestratorReceipt;

type ManagerReceiptCode =
  | "MANAGER_ENTRY_FAILED"
  | "MANAGER_CONTRACT_ERROR"
  | "MANAGER_ORCHESTRATION_MISMATCH";
type ManagerCommandContext = {
  requestId: string;
  actor?: unknown;
  taskId?: string;
  reasonCode?: string;
};
type ManagerProjectionSelector = Readonly<{
  businessDate?: string;
  includeInactive?: boolean;
  rootRequestId?: string;
  orchestrationId?: string;
  managerTaskId?: string;
}>;

type ManagerIntentRequest = Pick<
  SubmitWorkspaceOrchestratorIntentInput,
  | "producerId"
  | "businessDate"
  | "requestId"
  | "action"
  | "logicalInput"
  | "payload"
  | "channelPolicy"
  | "profileRevision"
  | "rootMode"
  | "predecessorIntentId"
>;

function actorProjection(
  runtime: ActiveWorkspaceRuntime,
): ManagerAdapterReadModel {
  return readManagerAdapterProjection(runtime.database, {
    workspaceId: runtime.identity.workspaceId,
    includeInactive: true,
  });
}

function managerFailureReceipt(
  runtime: ActiveWorkspaceRuntime,
  input: ManagerIntentRequest,
  code: ManagerReceiptCode,
  message: string,
  identity?: Partial<ManagerAdapterIdentity>,
): WorkspaceOrchestratorReceipt {
  const workspaceId = runtime.identity.workspaceId;
  const projection = actorProjection(runtime);
  const actor = projection.actor;
  const action = input.action ?? "start_new_intent";
  const rootMode = input.rootMode ?? "owner";
  const logicalInput =
    input.logicalInput !== undefined
      ? input.logicalInput
      : (input.payload ?? null);
  const payload =
    input.payload !== undefined ? input.payload : (input.logicalInput ?? null);
  const profileRevision = input.profileRevision ?? 1;
  const normalizedPolicyHash = hashV1({
    r: "normalized-policy/v1",
    workspaceId,
    profileRevision,
    policy: input.channelPolicy ?? [],
  });
  const logicalInputHash = hashV1({
    r: "logical-input/v1",
    workspaceId,
    businessDate: input.businessDate,
    source: "today_ui",
    rootMode,
    requestedAction: action,
    normalizedPolicyHash,
    logicalInput,
    acceptance: null,
    predecessorIntentId: input.predecessorIntentId ?? null,
    predecessorRootId: identity?.rootRequestId ?? null,
  });
  const payloadHash = hashV1(payload);
  const commandReplayKey = hashV1({
    r: "command-replay/v1",
    workspaceId,
    producer: input.producerId,
    requestId: input.requestId,
  });
  const receiptId = hashV1({
    r: "command-receipt/v1",
    workspaceId,
    requestId: input.requestId,
    commandReplayKey,
  });
  const runtimeEpoch = actor?.runtimeEpoch ?? 0;
  const ownerEpoch = actor?.ownerEpoch ?? 0;
  const authorityRevision = actor?.authorityRevision ?? 0;
  const checkpointRevision = actor?.checkpointRevision ?? 0;
  const readback = Object.freeze({
    workspaceId,
    runtimeEpoch,
    ownerEpoch,
    authorityRevision,
    checkpointRevision,
    root: null,
    rootCreated: false,
    managerIdentity: identity ?? null,
    error: { code, message },
  });
  return Object.freeze({
    version: "WorkspaceOrchestratorReceiptV1",
    receiptId,
    ok: false,
    status: "rejected",
    code,
    reasonCode: code,
    message,
    workspaceId,
    runtimeEpoch,
    ownerEpoch,
    authorityRevision,
    requestId: input.requestId,
    command: "workspace_orchestrator.intent.accept",
    commandReplayKey,
    logicalInputHash,
    payloadHash,
    producerAttestationHash: null,
    intentId: null,
    invocationId: null,
    mailboxSequence: null,
    checkpointRevision,
    readback,
    createdAt: new Date().toISOString(),
  });
}

function isWorkspaceOrchestratorReceipt(
  value: unknown,
): value is WorkspaceOrchestratorReceipt {
  const receipt =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return (
    receipt.version === "WorkspaceOrchestratorReceiptV1" &&
    typeof receipt.receiptId === "string" &&
    typeof receipt.ok === "boolean" &&
    (receipt.status === "accepted" || receipt.status === "rejected")
  );
}

function managerFailureFromError(
  runtime: ActiveWorkspaceRuntime,
  input: ManagerIntentRequest,
  error: unknown,
  defaultCode: ManagerReceiptCode,
  identity?: Partial<ManagerAdapterIdentity>,
): WorkspaceOrchestratorReceipt {
  const errorRecord =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {};
  const code =
    typeof errorRecord.code === "string" && errorRecord.code.trim()
      ? errorRecord.code.trim()
      : null;
  const stableCode: ManagerReceiptCode =
    code === "MANAGER_ENTRY_FAILED" ||
    code === "MANAGER_CONTRACT_ERROR" ||
    code === "MANAGER_ORCHESTRATION_MISMATCH"
      ? code
      : defaultCode;
  const message = error instanceof Error ? error.message : String(error);
  return managerFailureReceipt(runtime, input, stableCode, message, identity);
}

/** Submit the Owner Today action through the durable Actor mailbox. */
export async function dispatchManagerDailyIntelligence(
  runtime: ActiveWorkspaceRuntime,
  input: DispatchManagerDailyInput,
): Promise<DispatchManagerDailyResult> {
  const businessDate = String(input.businessDate ?? "").trim();
  const requestId = input.requestId?.trim() || randomUUID();
  const intentPayload =
    input.payload !== undefined
      ? input.payload
      : Object.freeze({
          businessDate,
          modules: input.modules ? [...input.modules] : null,
        });
  const logicalInput =
    input.logicalInput !== undefined ? input.logicalInput : intentPayload;
  const request: ManagerIntentRequest = {
    producerId: "today.agent-start-daily-intelligence",
    businessDate,
    requestId,
    action: "full",
    logicalInput,
    payload: intentPayload,
    channelPolicy: input.channelPolicy,
    profileRevision: input.profileRevision,
    rootMode: "owner",
  };
  if (!businessDate) {
    return managerFailureReceipt(
      runtime,
      request,
      "MANAGER_ENTRY_FAILED",
      "请选择今日情报日期。",
    );
  }
  try {
    const receipt = await submitWorkspaceOrchestratorIntent(runtime, request);
    return isWorkspaceOrchestratorReceipt(receipt)
      ? receipt
      : managerFailureReceipt(
          runtime,
          request,
          "MANAGER_CONTRACT_ERROR",
          "Actor typed intent 未返回 canonical receipt。",
        );
  } catch (error) {
    return managerFailureFromError(
      runtime,
      request,
      error,
      "MANAGER_ENTRY_FAILED",
    );
  }
}

/** Cancel one exact indexed root; no date or task-history inference is allowed. */
export async function cancelManagerDailyIntelligence(
  runtime: ActiveWorkspaceRuntime,
  managerTaskId: string,
  context: ManagerCommandContext,
): Promise<WorkspaceOrchestratorReceipt> {
  const normalizedManagerTaskId = managerTaskId.trim();
  const requestId = context.requestId?.trim() || randomUUID();
  const readRequest: ManagerIntentRequest = {
    producerId: "today.agent-start-daily-intelligence",
    businessDate: "",
    requestId,
    action: "cancel_root",
    logicalInput: null,
    payload: null,
    rootMode: "owner",
  };
  if (!normalizedManagerTaskId) {
    return managerFailureReceipt(
      runtime,
      readRequest,
      "MANAGER_ENTRY_FAILED",
      "缺少 managerTaskId。",
    );
  }

  const projection = actorProjection(runtime);
  const matches = projection.roots.filter(
    (root) =>
      root.identity.workspaceId === runtime.identity.workspaceId &&
      root.identity.managerTaskId === normalizedManagerTaskId,
  );
  if (matches.length !== 1) {
    return managerFailureReceipt(
      runtime,
      readRequest,
      "MANAGER_ORCHESTRATION_MISMATCH",
      matches.length === 0
        ? "未找到与 managerTaskId 精确绑定的 orchestrator root。"
        : "managerTaskId 绑定了多个 orchestrator root，拒绝猜测。",
      {
        managerTaskId: normalizedManagerTaskId,
        workspaceId: runtime.identity.workspaceId,
      },
    );
  }

  const root = matches[0];
  const identity = root.identity;
  const businessDate = root.origin.businessDate.trim();
  const rootMode = root.origin.rootMode === "scheduler" ? "scheduler" : "owner";
  if (
    !identity.rootRequestId ||
    !identity.orchestrationId ||
    !identity.managerTaskId ||
    !businessDate
  ) {
    return managerFailureReceipt(
      runtime,
      { ...readRequest, businessDate, rootMode },
      "MANAGER_ORCHESTRATION_MISMATCH",
      "root/orchestration/manager identity 不完整。",
      identity,
    );
  }

  const identityPayload = Object.freeze({
    workspaceId: identity.workspaceId,
    rootRequestId: identity.rootRequestId,
    rootGeneration: identity.rootGeneration,
    orchestrationId: identity.orchestrationId,
    managerTaskId: identity.managerTaskId,
    stageRequestId: identity.stageRequestId,
    scopeHash: identity.scopeHash,
    projectionHash: identity.projectionHash,
    eligibleIdsHash: identity.eligibleIdsHash,
    expectedRootCheckpointRevision: identity.checkpointRevision,
    expectedIndexRevision: identity.indexRevision,
    reasonCode: context.reasonCode?.trim() || "CANCELLED_BY_AUTHORIZED_SYSTEM",
  });
  const request: ManagerIntentRequest = {
    ...readRequest,
    businessDate,
    rootMode,
    logicalInput: identityPayload,
    payload: identityPayload,
  };
  try {
    const receipt = await submitWorkspaceOrchestratorIntent(runtime, request);
    return isWorkspaceOrchestratorReceipt(receipt)
      ? receipt
      : managerFailureReceipt(
          runtime,
          request,
          "MANAGER_CONTRACT_ERROR",
          "Actor cancel_root 未返回 canonical receipt。",
          identity,
        );
  } catch (error) {
    return managerFailureFromError(
      runtime,
      request,
      error,
      "MANAGER_CONTRACT_ERROR",
      identity,
    );
  }
}

/** Read only the canonical Actor/ManagerAdapter projection, optionally narrowed by exact identity. */
export function readManagerProjection(
  runtime: ActiveWorkspaceRuntime,
  selector: ManagerProjectionSelector = {},
): ManagerAdapterReadModel {
  const projection = readManagerAdapterProjection(runtime.database, {
    workspaceId: runtime.identity.workspaceId,
    businessDate: selector.businessDate?.trim() || undefined,
    includeInactive: selector.includeInactive,
  });
  const hasIdentitySelector = Boolean(
    selector.rootRequestId?.trim() ||
    selector.orchestrationId?.trim() ||
    selector.managerTaskId?.trim(),
  );
  if (!hasIdentitySelector) return projection;
  const rootRequestId = selector.rootRequestId?.trim();
  const orchestrationId = selector.orchestrationId?.trim();
  const managerTaskId = selector.managerTaskId?.trim();
  const roots = projection.roots.filter(
    (root) =>
      (!rootRequestId || root.identity.rootRequestId === rootRequestId) &&
      (!orchestrationId || root.identity.orchestrationId === orchestrationId) &&
      (!managerTaskId || root.identity.managerTaskId === managerTaskId),
  );
  return Object.freeze({ ...projection, roots: Object.freeze(roots) });
}
