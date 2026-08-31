import type { DatabaseSync } from 'node:sqlite';
import { approvePlanItemAndCreateProject } from './plan-item-approval.ts';
import { transitionPlanItem } from './planning-stage.ts';

export type OwnerProjectionDecisionBinding = Readonly<{
  workspaceId: string;
  rootRequestId: string;
  stageRequestId: string;
  scopeId: string;
  scopeHash: string;
  projectionHash: string;
  planItemId: string;
  classification: 'eligible' | 'invalid';
}>;

export type ExecuteOwnerProjectionDecisionInput = OwnerProjectionDecisionBinding & Readonly<{
  decision: 'approve' | 'repair';
  expectedRevision: number;
  requestId: string;
  reason?: string;
  actorId?: string;
}>;

type Row = Record<string, unknown>;

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function scopeProjection(row: Row): Record<string, unknown> {
  const stored = jsonObject(row.scope_json);
  return jsonObject(stored.projection ?? row.result_json);
}

export function readOwnerProjectionDecisionBinding(
  database: DatabaseSync,
  workspaceId: string,
  planItemId: string,
): OwnerProjectionDecisionBinding {
  const rows = database.prepare(`
    SELECT s.*, r.status AS root_status
      FROM daily_plan_scopes s
      JOIN daily_orchestration_roots r
        ON r.workspace_id=s.workspace_id AND r.root_request_id=s.root_request_id
     WHERE s.workspace_id=? AND s.scope_status='frozen'
     ORDER BY s.frozen_at DESC, s.scope_id DESC
  `).all(workspaceId) as Row[];
  for (const row of rows) {
    const projection = scopeProjection(row);
    const eligible = stringArray(projection.eligiblePlanItemIds);
    const invalid = stringArray(projection.invalidPlanItemIds);
    const classification = eligible.includes(planItemId) ? 'eligible' : invalid.includes(planItemId) ? 'invalid' : null;
    if (!classification) continue;
    return Object.freeze({
      workspaceId,
      rootRequestId: String(row.root_request_id),
      stageRequestId: String(row.stage_request_id),
      scopeId: String(row.scope_id),
      scopeHash: String(row.scope_hash),
      projectionHash: String(projection.projectionHash ?? ''),
      planItemId,
      classification,
    });
  }
  fail('PROJECTION_ITEM_STALE', '当前 frozen Projection 不包含该候选。');
}

export function executeOwnerProjectionDecision(
  database: DatabaseSync,
  input: ExecuteOwnerProjectionDecisionInput,
): Readonly<Record<string, unknown>> {
  const row = database.prepare(`
    SELECT s.*, r.status AS root_status
      FROM daily_plan_scopes s
      JOIN daily_orchestration_roots r
        ON r.workspace_id=s.workspace_id AND r.root_request_id=s.root_request_id
     WHERE s.workspace_id=? AND s.root_request_id=? AND s.stage_request_id=?
       AND s.scope_id=? AND s.scope_hash=?
  `).get(input.workspaceId, input.rootRequestId, input.stageRequestId, input.scopeId, input.scopeHash) as Row | undefined;
  if (!row || String(row.scope_status) !== 'frozen') fail('PROJECTION_ITEM_STALE', 'Projection 已失效或归档。');
  const projection = scopeProjection(row);
  if (String(projection.projectionHash ?? '') !== input.projectionHash) fail('PROJECTION_ITEM_STALE', 'Projection hash 已变化。');
  const eligible = stringArray(projection.eligiblePlanItemIds);
  const pending = stringArray(projection.pendingPlanItemIds);
  const invalid = stringArray(projection.invalidPlanItemIds);
  const item = database.prepare('SELECT id,revision,planning_status,source_ids_json FROM plan_items WHERE id=?').get(input.planItemId) as Row | undefined;
  if (!item) fail('PROJECTION_ITEM_STALE', '候选不存在。');
  if (Number(item.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '候选 revision 已变化。');

  if (input.decision === 'approve') {
    if (!eligible.includes(input.planItemId)) fail('APPROVAL_SCOPE_MISMATCH', '只允许批准当前 Projection 的 eligible ID。');
    if (pending.length > 0 || invalid.length > 0 || String(row.root_status) !== 'waiting_owner') {
      fail('APPROVAL_BLOCKED', 'Projection 仍有 pending/invalid，禁止批准。');
    }
    const result = approvePlanItemAndCreateProject(database, {
      planItemId: input.planItemId,
      expectedRevision: input.expectedRevision,
      by: input.actorId ?? 'owner_projection_executor',
      reason: input.reason,
    });
    return Object.freeze({ decision: 'approve', binding: input, result });
  }

  if (!invalid.includes(input.planItemId)) fail('REPAIR_SCOPE_MISMATCH', '只允许修复当前 Projection 的 invalid ID。');
  if (String(row.root_status) === 'waiting_owner') fail('REPAIR_SCOPE_MISMATCH', 'waiting_owner Projection 不得执行 invalid repair。');
  const status = String(item.planning_status);
  let revision = input.expectedRevision;
  if (status === 'ready_for_review') {
    const rejected = transitionPlanItem(database, {
      planItemId: input.planItemId,
      expectedRevision: revision,
      expectedStatus: 'ready_for_review',
      toStatus: 'rejected',
      by: input.actorId ?? 'owner_projection_executor',
      reason: input.reason ?? 'projection_invalid_repair',
    });
    revision = rejected.revision;
  } else if (status !== 'rejected' && status !== 'draft') {
    fail('REPAIR_SCOPE_MISMATCH', `候选状态 ${status} 不可修复。`);
  }
  const sourceIds = stringArray(JSON.parse(String(item.source_ids_json ?? '[]')));
  return Object.freeze({
    decision: 'repair',
    binding: input,
    result: {
      planItemId: input.planItemId,
      revision,
      planningStatus: status === 'ready_for_review' ? 'rejected' : status,
      nextAction: Object.freeze({
        kind: 'submitWorkspaceOrchestratorIntent',
        producerId: 'proposal.plan-item-request-planning',
        action: 'judge',
        requestId: input.requestId,
        logicalInput: Object.freeze({ planItemId: input.planItemId, sourceIds })
      })
    }
  });
}
