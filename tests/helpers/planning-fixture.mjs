import { transitionPlanItem } from '../../src/main/planning-stage.ts';
import { mergeSimilarCarryItems, upsertCarryFromPlanItem } from '../../src/main/ferment.ts';

export function scoredReasons(score = 80) {
  const criteria = [
    ['reader_immediacy_benefit', 20],
    ['tension_curiosity_gap', 20],
    ['why_now_window', 20],
    ['save_share_comment_motive', 20],
    ['evidence_credibility', 15],
    ['account_fit', 5],
  ];
  let remaining = score;
  return {
    status: 'scored',
    score,
    reasons: criteria.map(([criterion, weight]) => {
      const criterionScore = Math.min(weight, Math.max(0, remaining));
      remaining -= criterionScore;
      return { criterion, weight, score: criterionScore, reason: `${criterion} fixture evidence` };
    }),
  };
}

export function approvePlanItems(database, planItemIds) {
  for (const planItemId of planItemIds) {
    const row = database.prepare('SELECT revision, planning_status AS planningStatus FROM plan_items WHERE id=?').get(planItemId);
    if (!row) throw new Error(`fixture plan item missing: ${planItemId}`);
    if (row.planningStatus !== 'ready_for_review') throw new Error(`fixture plan item not reviewable: ${planItemId}:${row.planningStatus}`);
    transitionPlanItem(database, {
      planItemId,
      expectedRevision: row.revision,
      expectedStatus: 'ready_for_review',
      toStatus: 'approved',
      by: 'desk',
    });
    const item = database.prepare(`SELECT pi.title, pi.priority, pi.timeliness, pi.topic_id AS topicId,
      pi.source_ids_json AS sourceIds, p.plan_date AS planDate
      FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE pi.id=?`).get(planItemId);
    upsertCarryFromPlanItem(database, {
      planItemId,
      title: item.title,
      priority: item.priority,
      timeliness: item.timeliness,
      topicId: item.topicId,
      sourceIds: JSON.parse(item.sourceIds),
      originPlanDate: item.planDate,
      reason: `已批准: ${item.title}`,
    });
  }
  mergeSimilarCarryItems(database);
}
