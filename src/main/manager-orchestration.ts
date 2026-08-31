import { randomUUID } from 'node:crypto';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { shanghaiDate } from './ferment.ts';
import { readManagerAdapterProjection, type ManagerAdapterReadModel } from './workspace-orchestrator-manager-adapter.ts';
import { submitWorkspaceOrchestratorIntent, type WorkspaceOrchestratorReceipt } from './workspace-orchestrator-runtime.ts';

export type DailyStage = 'scan' | 'judge' | 'full';

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

type PredecessorIdentity = {
  predecessorIntentId: string | null;
  rootRequestId: string | null;
  orchestrationId?: string | null;
  stageRequestId?: string | null;
  scopeHash?: string | null;
  projectionHash?: string | null;
  eligibleIdsHash?: string | null;
};

function normalizedDate(value: string | undefined): string {
  return value?.trim() || shanghaiDate();
}

function normalizedRequestId(value: string | undefined): string {
  return value?.trim() || randomUUID();
}

function withPredecessorIdentity(value: unknown, identity: PredecessorIdentity, includeRootAlias: boolean): Readonly<Record<string, unknown>> {
  const base = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : { value };
  return Object.freeze({
    ...base,
    ...identity,
    ...(includeRootAlias ? { predecessorRootId: identity.rootRequestId } : {})
  });
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

export type ContinueAfterScanInput = {
  runtime: ActiveWorkspaceRuntime;
  requestId?: string;
  businessDate?: string;
  predecessorIntentId: string;
  rootRequestId: string;
  orchestrationId?: string | null;
  stageRequestId?: string | null;
  scopeHash?: string | null;
  projectionHash?: string | null;
  eligibleIdsHash?: string | null;
  logicalInput?: unknown;
  payload?: unknown;
  channelPolicy?: unknown;
  profileRevision?: number;
};

/** Submit a judge intent tied to an explicitly supplied predecessor identity. */
export function continueAfterScan(input: ContinueAfterScanInput): Promise<DailyIntentReceipt> {
  const identity: PredecessorIdentity = Object.freeze({
    predecessorIntentId: input.predecessorIntentId?.trim() || null,
    rootRequestId: input.rootRequestId?.trim() || null,
    orchestrationId: input.orchestrationId?.trim() || null,
    stageRequestId: input.stageRequestId?.trim() || null,
    scopeHash: input.scopeHash?.trim() || null,
    projectionHash: input.projectionHash?.trim() || null,
    eligibleIdsHash: input.eligibleIdsHash?.trim() || null
  });
  const logicalInput = withPredecessorIdentity(input.logicalInput, identity, false);
  const payload = withPredecessorIdentity(input.payload, identity, true);
  return submitWorkspaceOrchestratorIntent(input.runtime, {
    producerId: 'mcp.daily-continue-after-scan',
    businessDate: normalizedDate(input.businessDate),
    requestId: normalizedRequestId(input.requestId),
    action: 'judge',
    logicalInput,
    payload,
    channelPolicy: input.channelPolicy,
    profileRevision: input.profileRevision,
    rootMode: 'owner',
    predecessorIntentId: identity.predecessorIntentId
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
