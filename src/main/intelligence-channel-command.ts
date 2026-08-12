import { CommandDispatchError, createCommandEnvelope, type CommandReceiptV1 } from './command-dispatcher.ts';
import { dispatchBusinessCommand } from './business-command.ts';
import { dispatchIssueExecutionGrant } from './execution-grants.ts';
import { applyVerifiedIntelligenceChannelProposal, verifyIntelligenceChannelProposal } from './intelligence-channel-confirmation.ts';
import type { IntelligenceChannelProposalBinding, IntelligenceChannelProposalStore } from './intelligence-channel-proposals.ts';
import type { CurrentXListContext } from './x-list-context.ts';
import { trialReadWebsite } from './website-channel.ts';
import { readWorkspaceBrowserBinding } from './workspace-browser-binding.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const INTELLIGENCE_CHANNEL_PROPOSAL_APPLY_COMMAND = 'intelligence_channels.proposal_apply';
/** WMB-5183 §4.4 表 ②：无 remove 安全应用路径（本地 add/enable/disable，非破坏性）——内部命令，绑定主管。 */
export const INTELLIGENCE_CHANNEL_PROPOSAL_APPLY_SAFE_COMMAND = 'intelligence_channels.proposal_apply_safe';

type ConfirmDependencies = Readonly<{
  store: IntelligenceChannelProposalStore;
  binding: IntelligenceChannelProposalBinding;
  xContext?: CurrentXListContext;
  trialWebsite?: typeof trialReadWebsite;
}>;

export async function dispatchConfirmIntelligenceChannelProposal(
  runtime: ActiveWorkspaceRuntime,
  input: ConfirmDependencies
): Promise<CommandReceiptV1<{ applied: number }>> {
  const proposal = input.store.get(input.binding.proposalId);
  if (!proposal) throw new CommandDispatchError('CONFIRMATION_STALE', '来源变更确认已失效，请重新准备。');
  const browserBinding = input.xContext ? readWorkspaceBrowserBinding(runtime.database) : null;
  if (input.xContext && (!browserBinding || browserBinding.state !== 'verified' || browserBinding.profileId !== input.xContext.browserId)) {
    throw new CommandDispatchError('PROFILE_STALE', '当前浏览器绑定已变化，请重新准备。');
  }
  const verifiedX = await verifyIntelligenceChannelProposal(runtime.database, input);

  const actor = Object.freeze({ type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' });
  const commandInput = Object.freeze({
    proposalId: input.binding.proposalId,
    proposalRevision: input.binding.proposalRevision,
    normalizedHash: input.binding.normalizedHash,
    profileRevision: input.binding.profileRevision,
    displayedDiff: input.binding.displayedDiff
  });
  const allowedTransition = 'prepared_to_applied';
  const requiredReadback = Object.freeze({ proposalId: proposal.id, normalizedHash: proposal.normalizedHash, state: 'applied' });
  const boundIdentity = Object.freeze({
    proposalId: proposal.id,
    proposalRevision: proposal.revision,
    normalizedHash: proposal.normalizedHash,
    workspaceId: proposal.workspaceId,
    profileRevision: proposal.profileRevision,
    browserProfileId: input.xContext?.browserId ?? null,
    browserBindingRevision: browserBinding?.bindingRevision ?? null,
    expectedAccount: input.xContext?.accountKey ?? null,
    allowedTransition,
    requiredReadback
  });
  const draft = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: INTELLIGENCE_CHANNEL_PROPOSAL_APPLY_COMMAND,
    requestId: `${proposal.id}:apply:r${proposal.revision}`,
    input: commandInput,
    boundIdentity,
    actor
  });
  const grantReceipt = await dispatchIssueExecutionGrant(runtime, {
    requestId: `${draft.requestId}:grant`,
    command: draft.command,
    inputHash: draft.inputHash,
    boundIdentity,
    targetActor: actor,
    browserProfileId: input.xContext?.browserId,
    bindingRevision: browserBinding?.bindingRevision,
    expectedAccount: input.xContext?.accountKey,
    allowedTransition,
    requiredReadback,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
  });
  if (!grantReceipt.ok || !grantReceipt.data) {
    throw new CommandDispatchError(grantReceipt.error?.code ?? 'EXECUTION_GRANT_ISSUE_FAILED', grantReceipt.error?.message ?? '无法签发执行授权。');
  }

  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: draft.command,
    requestId: draft.requestId,
    input: commandInput,
    boundIdentity,
    actor,
    executionGrantId: grantReceipt.data.id
  });
  return runtime.dispatchCommand(envelope, () => {
    const result = applyVerifiedIntelligenceChannelProposal(runtime.database, {
      ...input,
      verifiedX,
      transaction: false
    });
    return {
      data: result,
      entityType: 'intelligence_channel_proposal',
      entityId: proposal.id,
      beforeRevision: proposal.revision,
      afterRevision: proposal.revision + 1,
      readback: { proposalId: proposal.id, normalizedHash: proposal.normalizedHash, state: 'applied', applied: result.applied }
    };
  });
}

/**
 * WMB-5183 §4.4 表 ②（A3a 前半）：无 remove 安全应用路径——本地 add/enable/disable（非破坏性）。
 * 复用同一事务核心 `verifyIntelligenceChannelProposal` + `applyVerifiedIntelligenceChannelProposal`（不复制业务逻辑）；
 * 经 task grant 派发（主管 standing 内 `intelligence_channels.proposal_apply_safe`），不签发 precise execution grant。
 * 含 remove 的提案在 handler 内于任何业务写之前拒绝（REDLINE_REQUIRED，错误收据落库，零业务写）；
 * 含 remove 的路径保留给 Owner UI 精确确认（`intelligence_channels.proposal_apply`，agentGrantable:false）。
 */
export async function dispatchConfirmIntelligenceChannelProposalSafe(
  runtime: ActiveWorkspaceRuntime,
  input: ConfirmDependencies & { taskId: string; taskGrantId: string; workerLeaseId?: string }
): Promise<CommandReceiptV1<{ applied: number }>> {
  const proposal = input.store.get(input.binding.proposalId);
  if (!proposal) throw new CommandDispatchError('CONFIRMATION_STALE', '来源变更确认已失效，请重新准备。');
  const browserBinding = input.xContext ? readWorkspaceBrowserBinding(runtime.database) : null;
  if (input.xContext && (!browserBinding || browserBinding.state !== 'verified' || browserBinding.profileId !== input.xContext.browserId)) {
    throw new CommandDispatchError('PROFILE_STALE', '当前浏览器绑定已变化，请重新准备。');
  }
  const verifiedX = await verifyIntelligenceChannelProposal(runtime.database, input);
  const actor = input.workerLeaseId
    ? Object.freeze({ type: 'pi' as const, id: 'pi', label: 'Pi worker' })
    : Object.freeze({ type: 'external_agent' as const, id: 'mcp', label: 'External Agent' });
  const commandInput = Object.freeze({
    proposalId: input.binding.proposalId,
    proposalRevision: input.binding.proposalRevision,
    normalizedHash: input.binding.normalizedHash,
    profileRevision: input.binding.profileRevision,
    displayedDiff: input.binding.displayedDiff
  });
  const boundIdentity = Object.freeze({
    proposalId: proposal.id,
    proposalRevision: proposal.revision,
    normalizedHash: proposal.normalizedHash,
    workspaceId: proposal.workspaceId,
    profileRevision: proposal.profileRevision,
    browserProfileId: input.xContext?.browserId ?? null
  });
  return dispatchBusinessCommand(runtime, {
    command: INTELLIGENCE_CHANNEL_PROPOSAL_APPLY_SAFE_COMMAND,
    requestId: `${proposal.id}:apply-safe:r${proposal.revision}`,
    actor,
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    grantId: input.taskGrantId,
    input: commandInput,
    boundIdentity,
    entityType: 'intelligence_channel_proposal',
    execute: (database) => {
      const current = input.store.get(input.binding.proposalId);
      if (!current || current.changes.some((change) => change.action === 'remove')) {
        throw new CommandDispatchError('REDLINE_REQUIRED', '提案包含移出操作，必须由 Owner 在 UI 精确确认。');
      }
      const result = applyVerifiedIntelligenceChannelProposal(database, { ...input, verifiedX, transaction: false });
      return {
        data: result,
        entityId: proposal.id,
        beforeRevision: proposal.revision,
        afterRevision: proposal.revision + 1,
        readback: { proposalId: proposal.id, normalizedHash: proposal.normalizedHash, state: 'applied', applied: result.applied }
      };
    }
  });
}
