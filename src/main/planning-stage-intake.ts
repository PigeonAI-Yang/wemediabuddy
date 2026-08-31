import type { DatabaseSync } from 'node:sqlite';

export type EnsurePlannerTaskInput = {
  planItemId: string;
  sourceIds: string[];
  requestId: string;
  businessDate?: string;
};

export type EnsurePlannerTaskResult = {
  taskId: string;
  jobId: string;
  created: boolean;
};

/**
 * Typed replacement for the retired planner-task producer.
 * The descriptor is data only; submission belongs to the workspace Actor gateway.
 */
export type PlannerTaskActorIntent = Readonly<{
  kind: 'submitWorkspaceOrchestratorIntent';
  producerId: 'proposal.plan-item-request-planning';
  action: 'judge';
  businessDate: string | null;
  requestId: string;
  rootMode: 'owner';
  logicalInput: Readonly<Record<string, unknown>>;
  payload: Readonly<Record<string, unknown>>;
}>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
  return [...new Set(normalized)];
}

/** Read-only date projection used to make the replacement intent complete when possible. */
function resolveBusinessDate(database: DatabaseSync, planItemId: string, fallback?: string): string | null {
  const requested = text(fallback);
  if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;
  if (!planItemId) return null;
  try {
    const row = database
      .prepare('SELECT plan_date FROM plans WHERE id = (SELECT plan_id FROM plan_items WHERE id = ?)')
      .get(planItemId) as { plan_date?: unknown } | undefined;
    const projected = text(row?.plan_date);
    return /^\d{4}-\d{2}-\d{2}$/.test(projected) ? projected : null;
  } catch {
    return null;
  }
}

export function buildPlannerTaskActorIntent(database: DatabaseSync, input: EnsurePlannerTaskInput): PlannerTaskActorIntent {
  const planItemId = text(input?.planItemId);
  const requestId = text(input?.requestId) || `legacy:proposal.plan-item-request-planning:${planItemId || 'missing-plan-item'}`;
  const businessDate = resolveBusinessDate(database, planItemId, input?.businessDate);
  const logicalInput = Object.freeze({
    planItemId,
    sourceIds: Object.freeze(sourceIds(input?.sourceIds)),
    businessDate,
  });
  return Object.freeze({
    kind: 'submitWorkspaceOrchestratorIntent',
    producerId: 'proposal.plan-item-request-planning',
    action: 'judge',
    businessDate,
    requestId,
    rootMode: 'owner',
    logicalInput,
    payload: logicalInput,
  });
}

/**
 * Retained only for compile/readback compatibility. It must never create a task,
 * job, or any business row; callers must submit the typed descriptor through the
 * workspace Actor gateway instead.
 */
export function ensurePlannerTask(database: DatabaseSync, input: EnsurePlannerTaskInput): EnsurePlannerTaskResult {
  const nextAction = buildPlannerTaskActorIntent(database, input);
  throw Object.assign(
    new Error('CUTOVER_REQUIRED: ensurePlannerTask retired; submit the typed intent through the workspace Actor gateway.'),
    {
      code: 'CUTOVER_REQUIRED' as const,
      nextAction,
      details: Object.freeze({ replacement: 'submitWorkspaceOrchestratorIntent', nextAction }),
    },
  );
}
