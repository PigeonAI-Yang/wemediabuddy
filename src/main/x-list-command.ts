import { CommandDispatchError, createCommandEnvelope, type CommandEnvelopeV1, type CommandReceiptV1 } from './command-dispatcher.ts';
import { dispatchIssueExecutionGrant } from './execution-grants.ts';
import type { CurrentXListContext } from './x-list-context.ts';
import {
  getXListOperation, grantXListOperation, xListPayloadFingerprint, xListSnapshotFingerprint, type XListOperation
} from './x-lists.ts';
import { readWorkspaceBrowserBinding } from './workspace-browser-binding.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const X_LIST_EXECUTION_COMMAND = 'x_lists.operation_execute';

type ConfirmXListOperationInput = Readonly<{
  operationId: string;
  expectedRevision: number;
  typedListName?: string;
}>;

export async function dispatchAcceptXListOperation(
  runtime: ActiveWorkspaceRuntime,
  context: CurrentXListContext,
  input: ConfirmXListOperationInput
): Promise<CommandReceiptV1<XListOperation>> {
  const operation = getXListOperation(runtime.database, input.operationId);
  if (!operation) throw new CommandDispatchError('NOT_FOUND', 'List 操作不存在。');
  if (operation.kind === 'delete' && input.typedListName?.trim() !== operation.snapshot.list?.name) {
    throw new CommandDispatchError('VALIDATION_ERROR', '删除 List 前必须输入当前 List 名称。');
  }
  const replay = readXListExecutionReplay(runtime, operation, input);
  if (replay) return replay;
  const requestId = xListExecutionRequestId(operation.requestId, input.expectedRevision);
  if (operation.revision !== input.expectedRevision) throw new CommandDispatchError('REVISION_CONFLICT', 'List 操作已变化，请重新加载。');
  if (operation.state !== 'prepared' || operation.phase !== 'awaiting_confirmation') {
    throw new CommandDispatchError('CONFIRMATION_REQUIRED', 'List 操作尚未等待 UI 最终确认。');
  }

  const binding = requireCurrentBinding(runtime, context);
  const actor = Object.freeze({ type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' });
  const snapshotFingerprint = xListSnapshotFingerprint(operation.snapshot);
  const payloadFingerprint = xListPayloadFingerprint(operation.payload);
  const commandInput = Object.freeze({
    operationId: operation.id,
    expectedRevision: input.expectedRevision,
    typedListName: input.typedListName ?? null,
    operationInputHash: operation.inputHash,
    kind: operation.kind,
    accountKey: operation.accountKey,
    listId: operation.listId,
    snapshot: operation.snapshot,
    payload: operation.payload,
    confirmationFingerprint: operation.confirmationFingerprint,
    snapshotFingerprint,
    payloadFingerprint
  });
  const allowedTransition = 'prepared->execution_granted';
  const requiredReadback = Object.freeze({ operationId: operation.id, state: 'execution_granted', revision: operation.revision + 1 });
  const boundIdentity = Object.freeze({
    operationId: operation.id,
    operationInputHash: operation.inputHash,
    kind: operation.kind,
    accountKey: operation.accountKey,
    listId: operation.listId,
    snapshotFingerprint,
    payloadFingerprint,
    browserProfileId: binding.profileId,
    browserBindingRevision: binding.bindingRevision,
    expectedAccount: context.accountKey,
    preparedActor: operation.preparedActor,
    preparedTaskId: operation.taskId,
    preparedTaskGrantId: operation.taskGrantId,
    allowedTransition,
    requiredReadback
  });
  const draft = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: X_LIST_EXECUTION_COMMAND,
    requestId,
    input: commandInput,
    boundIdentity,
    actor,
    taskId: operation.taskId ?? undefined,
    grantId: operation.taskGrantId ?? undefined
  });
  const issued = await dispatchIssueExecutionGrant(runtime, {
    requestId: `${operation.requestId}:grant:r${operation.revision}`,
    taskId: operation.taskId ?? undefined,
    taskGrantId: operation.taskGrantId ?? undefined,
    command: X_LIST_EXECUTION_COMMAND,
    inputHash: draft.inputHash,
    boundIdentity,
    targetActor: actor,
    browserProfileId: binding.profileId!,
    bindingRevision: binding.bindingRevision,
    expectedAccount: context.accountKey,
    allowedTransition,
    requiredReadback,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
  });
  if (!issued.ok || !issued.data) throw new CommandDispatchError(issued.error?.code ?? 'EXECUTION_GRANT_INVALID', issued.error?.message ?? '无法签发精确执行授权。');

  const envelope = createCommandEnvelope({
    workspaceId: draft.workspaceId,
    runtimeEpoch: draft.runtimeEpoch,
    command: draft.command,
    requestId: draft.requestId,
    input: commandInput,
    boundIdentity,
    actor,
    taskId: operation.taskId ?? undefined,
    grantId: operation.taskGrantId ?? undefined,
    executionGrantId: issued.data.id
  });
  return runtime.dispatchCommand(envelope, () => {
    const latest = getXListOperation(runtime.database, operation.id);
    const currentBinding = requireCurrentBinding(runtime, context);
    if (!latest || latest.revision !== operation.revision || latest.inputHash !== operation.inputHash
      || latest.confirmationFingerprint !== operation.confirmationFingerprint
      || xListSnapshotFingerprint(latest.snapshot) !== snapshotFingerprint
      || xListPayloadFingerprint(latest.payload) !== payloadFingerprint) {
      throw new CommandDispatchError('CONFIRMATION_STALE', 'List 操作或冻结确认已变化。');
    }
    if (currentBinding.profileId !== binding.profileId || currentBinding.bindingRevision !== binding.bindingRevision) {
      throw new CommandDispatchError('BROWSER_PROFILE_MISMATCH', '浏览器档案绑定已变化。');
    }
    const accepted = grantXListOperation(runtime.database, {
      operationId: operation.id,
      expectedRevision: operation.revision,
      authority: {
        executionGrantId: issued.data!.id,
        browserProfileId: binding.profileId!,
        browserBindingRevision: binding.bindingRevision,
        expectedAccount: context.accountKey,
        operationInputHash: operation.inputHash,
        confirmationFingerprint: operation.confirmationFingerprint!,
        snapshotFingerprint,
        payloadFingerprint
      }
    });
    if (!accepted.ok) throw new CommandDispatchError(accepted.error.code, accepted.error.message, accepted.error.details);
    return {
      data: accepted.data,
      entityType: 'x_list_operation',
      entityId: accepted.data.id,
      beforeRevision: operation.revision,
      afterRevision: accepted.data.revision,
      readback: accepted.data,
      sideEffectState: 'authorized'
    };
  });
}

export function xListExecutionRequestId(operationRequestId: string, expectedRevision: number): string {
  return `${operationRequestId}:execute:r${expectedRevision}`;
}

export function readXListExecutionReplay(
  runtime: ActiveWorkspaceRuntime,
  operation: XListOperation,
  input: ConfirmXListOperationInput
): CommandReceiptV1<XListOperation> | null {
  const requestId = xListExecutionRequestId(operation.requestId, input.expectedRevision);
  const prior = runtime.database.prepare(`SELECT envelope_json AS envelopeJson, receipt_json AS receiptJson,
    execution_grant_id AS executionGrantId FROM command_receipts WHERE workspace_id=? AND request_id=?`)
    .get(runtime.identity.workspaceId, requestId) as { envelopeJson: string; receiptJson: string; executionGrantId: string | null } | undefined;
  return prior ? exactReplayReceipt(runtime, operation, input, prior) : null;
}

function exactReplayReceipt(
  runtime: ActiveWorkspaceRuntime,
  operation: XListOperation,
  input: ConfirmXListOperationInput,
  prior: { envelopeJson: string; receiptJson: string; executionGrantId: string | null }
): CommandReceiptV1<XListOperation> {
  const priorEnvelope = JSON.parse(prior.envelopeJson) as CommandEnvelopeV1;
  const candidate = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: X_LIST_EXECUTION_COMMAND,
    requestId: xListExecutionRequestId(operation.requestId, input.expectedRevision),
    input: {
      operationId: operation.id, expectedRevision: input.expectedRevision, typedListName: input.typedListName ?? null,
      operationInputHash: operation.inputHash, kind: operation.kind, accountKey: operation.accountKey, listId: operation.listId,
      snapshot: operation.snapshot, payload: operation.payload, confirmationFingerprint: operation.confirmationFingerprint,
      snapshotFingerprint: xListSnapshotFingerprint(operation.snapshot), payloadFingerprint: xListPayloadFingerprint(operation.payload)
    },
    boundIdentity: priorEnvelope.boundIdentity,
    actor: priorEnvelope.actor,
    taskId: operation.taskId ?? undefined,
    grantId: operation.taskGrantId ?? undefined,
    executionGrantId: prior.executionGrantId ?? undefined
  });
  const receipt = JSON.parse(prior.receiptJson) as CommandReceiptV1<XListOperation>;
  if (receipt.command !== candidate.command || receipt.inputHash !== candidate.inputHash) {
    throw new CommandDispatchError('REQUEST_REPLAY_CONFLICT', '同一 requestId 已绑定不同命令或输入。');
  }
  return Object.freeze({ ...receipt, executionGrantId: prior.executionGrantId ?? receipt.executionGrantId ?? null });
}

function requireCurrentBinding(runtime: ActiveWorkspaceRuntime, context: CurrentXListContext) {
  if (context.workspaceId !== runtime.identity.workspaceId) throw new CommandDispatchError('WORKSPACE_STALE', 'X List 上下文不属于当前工作空间。');
  const binding = readWorkspaceBrowserBinding(runtime.database);
  if (!binding?.profileId || binding.state !== 'verified' || binding.profileId !== context.browserId) {
    throw new CommandDispatchError('BROWSER_PROFILE_MISMATCH', '当前浏览器档案未与工作空间有效绑定。');
  }
  const expected = binding.expectedAccountSnapshot.x;
  if (!expected || expected.accountKey.trim().toLowerCase() !== context.accountKey.trim().toLowerCase()
    || expected.browserProfileId !== binding.profileId || expected.browserBindingRevision !== binding.bindingRevision) {
    throw new CommandDispatchError('ACCOUNT_MISMATCH', '当前 X 账号与工作空间冻结账号不一致。');
  }
  return binding;
}
