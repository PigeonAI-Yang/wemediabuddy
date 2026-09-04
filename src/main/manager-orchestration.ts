import { randomUUID } from 'node:crypto';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { shanghaiDate } from './ferment.ts';
import { readManagerAdapterProjection, type ManagerAdapterReadModel } from './workspace-orchestrator-manager-adapter.ts';
import { submitWorkspaceOrchestratorIntent, type WorkspaceOrchestratorReceipt } from './workspace-orchestrator-runtime.ts';

export type DailyStage = 'scan' | 'full';

type DailyIntentReceipt = WorkspaceOrchestratorReceipt;

type DailyIntentInput = {
  runtime: ActiveWorkspaceRuntime;
  stage: DailyStage;
  requestId?: string;
  businessDate?: string;
  modules?: Array<'official_web' | 'x_lists'>;
  logicalInput?: unknown;
  payload?: unknown;
  channelPolicy?: unknown;
  profileRevision?: number;
  predecessorIntentId?: string | null;
};


function normalizedDate(value: string | undefined): string {
  return value?.trim() || shanghaiDate();
}

function normalizedRequestId(value: string | undefined): string {
  return value?.trim() || randomUUID();
}


/** Submit a typed daily action. The Actor receipt is the only production result. */
export function runManagerDailyStage(input: DailyIntentInput): Promise<DailyIntentReceipt> {
  const stagePayload = Object.freeze({ stage: input.stage, modules: input.modules ? [...input.modules] : null });
  const logicalInput = input.logicalInput ?? stagePayload;
  const payload = input.payload ?? stagePayload;
  return submitWorkspaceOrchestratorIntent(input.runtime, {
    producerId: 'mcp.daily-run-stage',
    businessDate: normalizedDate(input.businessDate),
    requestId: normalizedRequestId(input.requestId),
    action: input.stage,
    logicalInput,
    payload,
    channelPolicy: input.channelPolicy,
    profileRevision: input.profileRevision,
    rootMode: 'owner',
    predecessorIntentId: input.predecessorIntentId ?? null
  });
}


/** Read only the durable Actor/ManagerAdapter authority projection. */
export type DailyReadiness = Readonly<{
  businessDate: string;
  actor: ManagerAdapterReadModel['actor'];
  startupGate: ManagerAdapterReadModel['startupGate'];
  roots: ManagerAdapterReadModel['roots'];
  asOf: string;
}>;

export function describeDailyReadiness(runtime: ActiveWorkspaceRuntime, businessDate = shanghaiDate()): DailyReadiness {
  const normalizedBusinessDate = normalizedDate(businessDate);
  const projection = readManagerAdapterProjection(runtime.database, {
    workspaceId: runtime.identity.workspaceId,
    businessDate: normalizedBusinessDate
  });
  return {
    businessDate: normalizedBusinessDate,
    actor: projection.actor,
    startupGate: projection.startupGate,
    roots: projection.roots,
    asOf: projection.asOf
  };
}

export function isManagerOrchestrating(runtime: ActiveWorkspaceRuntime, businessDate = shanghaiDate()): boolean {
  const projection = readManagerAdapterProjection(runtime.database, {
    workspaceId: runtime.identity.workspaceId,
    businessDate: normalizedDate(businessDate)
  });
  return projection.roots.some((root) => root.status === 'running' || root.status === 'waiting_owner');
}
