import { DatabaseSync } from 'node:sqlite';
import { classifyRecommendationItem } from '../shared/propagation.ts';
import { createProjectFromPlanItem } from './content.ts';
import { markCarryDoneForPlanItem, shanghaiDate, upsertCarryFromPlanItem } from './ferment.ts';
import { linkTopicSources } from './knowledge.ts';
import { transitionPlanItem, validateTruthGateSourceReferences } from './planning-stage.ts';

export type ApprovePlanItemResult = {
  id: string;
  revision: number;
  planningStatus: 'approved';
  projectId: string;
  projectRevision: number;
  contentVersionId: string;
  carryState: 'done' | null;
};

/** Caller must execute this inside CommandDispatcher's database transaction. */
export function approvePlanItemAndCreateProject(
  database: DatabaseSync,
  input: { planItemId: string; expectedRevision: number; by: string; reason?: string; now?: Date }
): ApprovePlanItemResult {
  const row = database.prepare(`
    SELECT pi.*, p.plan_date AS planDate
    FROM plan_items pi JOIN plans p ON p.id = pi.plan_id
    WHERE pi.id = ?
  `).get(input.planItemId) as Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  if (Number(row.revision) !== input.expectedRevision) {
    throw Object.assign(new Error('revision_conflict'), { code: 'REVISION_CONFLICT' });
  }
  const now = input.now ?? new Date();
  const qualification = classifyRecommendationItem(row, { businessDate: shanghaiDate(now), asOf: now });
  if (qualification.kind !== 'eligible') {
    throw Object.assign(new Error(`validation_failed: ${qualification.reason}`), {
      code: 'validation_failed', reasonCode: qualification.reasonCode
    });
  }
  if (database.prepare('SELECT id FROM content_projects WHERE plan_item_id = ? LIMIT 1').get(input.planItemId)) {
    throw Object.assign(new Error('conflict: project already exists for plan item'), { code: 'conflict' });
  }
  const sourceIds = JSON.parse(String(row.source_ids_json ?? '[]')) as string[];
  validateTruthGateSourceReferences(database, row.score_reasons_json, sourceIds);
  const transitioned = transitionPlanItem(database, {
    planItemId: input.planItemId,
    expectedRevision: input.expectedRevision,
    expectedStatus: 'ready_for_review',
    toStatus: 'approved',
    by: input.by,
    reason: input.reason ?? 'approve'
  });
  const lockedRow = database.prepare('SELECT planning_provenance_json, score_reasons_json, point_of_view, title, opening_guidance FROM plan_items WHERE id=?').get(input.planItemId) as {
    planning_provenance_json: string; score_reasons_json: string; point_of_view: string; title: string; opening_guidance: string;
  };
  const lockedProvenance = JSON.parse(lockedRow.planning_provenance_json || '{}') as Record<string, unknown>;
  const scoreReasons = JSON.parse(lockedRow.score_reasons_json || '{}') as Record<string, unknown>;
  const editorialDecision = lockedProvenance.editorial_decision as Record<string, unknown>;
  lockedProvenance.thesis_lock = {
    version: 'thesis_lock_v1',
    winnerThesis: editorialDecision.winnerThesis,
    winnerLevel: editorialDecision.winnerLevel,
    propagationPromise: { title: lockedRow.title, openingGuidance: lockedRow.opening_guidance },
    claimBoundaries: (scoreReasons.truthGate as Record<string, unknown>).claims,
    approvedAt: now.toISOString(),
    approvedBy: input.by,
  };
  database.prepare('UPDATE plan_items SET planning_provenance_json=? WHERE id=? AND revision=? AND planning_status=\'approved\'')
    .run(JSON.stringify(lockedProvenance), input.planItemId, transitioned.revision);
  if (row.topic_id) linkTopicSources(database, String(row.topic_id), sourceIds, now.toISOString());
  upsertCarryFromPlanItem(database, {
    planItemId: input.planItemId,
    title: String(row.title),
    priority: Number(row.priority),
    timeliness: String(row.timeliness ?? ''),
    topicId: row.topic_id ? String(row.topic_id) : null,
    sourceIds,
    originPlanDate: String(row.planDate),
    forceState: 'active',
    reason: `已批准: ${String(row.title)}`
  });
  const project = createProjectFromPlanItem(database, input.planItemId, false);
  if (!project.created) throw Object.assign(new Error('conflict: project creation was not unique'), { code: 'conflict' });
  markCarryDoneForPlanItem(database, input.planItemId);
  const version = database.prepare(`
    SELECT id, body FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1
  `).get(project.id) as { id: string; body: string } | undefined;
  if (!version?.body.trim()) throw Object.assign(new Error('project_initial_version_missing'), { code: 'readback_failed' });
  const carry = database.prepare(`
    SELECT state FROM work_carry_items
    WHERE object_type='plan_item' AND object_id=? ORDER BY updated_at DESC LIMIT 1
  `).get(input.planItemId) as { state: string } | undefined;
  if (carry && carry.state !== 'done') throw Object.assign(new Error('carry_not_completed'), { code: 'readback_failed' });
  return {
    id: transitioned.id,
    revision: transitioned.revision,
    planningStatus: 'approved',
    projectId: project.id,
    projectRevision: project.revision,
    contentVersionId: version.id,
    carryState: carry ? 'done' : null
  };
}
