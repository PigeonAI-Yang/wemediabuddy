import type { CommandActorV1, CommandReceiptV1 } from './command-dispatcher.ts';
import { dispatchBusinessCommand } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  repairApprovedPlanItemChain,
  type ApprovedPlanItemChainRepairResult,
  type ApprovedPlanItemRepairBinding,
  type ApprovedPlanItemThesisRepairInput
} from './approved-plan-chain-repair.ts';

export function dispatchApprovedPlanItemChainRepair(
  runtime: ActiveWorkspaceRuntime,
  input: {
    planItemId: string;
    expectedRevision: number;
    requestId: string;
    rollbackBinding?: ApprovedPlanItemRepairBinding;
    thesisRepair?: ApprovedPlanItemThesisRepairInput;
  },
  actor: CommandActorV1 = { type: 'owner_ui', id: 'approved-chain-repair', label: 'Approved Chain Repair' }
): Promise<CommandReceiptV1<ApprovedPlanItemChainRepairResult>> {
  return dispatchBusinessCommand(runtime, {
    command: 'plan_item.repair_approved_chain',
    requestId: input.requestId,
    actor,
    input: {
      planItemId: input.planItemId,
      expectedRevision: input.expectedRevision,
      ...(input.rollbackBinding ? { rollbackBinding: input.rollbackBinding } : {}),
      ...(input.thesisRepair ? { thesisRepair: input.thesisRepair } : {})
    },
    boundIdentity: { planItemId: input.planItemId },
    entityType: 'plan_item',
    execute: (database, normalized) => {
      const data = repairApprovedPlanItemChain(database, normalized);
      return {
        data,
        entityId: normalized.planItemId,
        beforeRevision: normalized.expectedRevision,
        afterRevision: data.planItemRevision,
        readback: data
      };
    }
  });
}
