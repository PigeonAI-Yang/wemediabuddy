import { transitionPlanItem } from '../../src/main/planning-stage.ts';
import { mergeSimilarCarryItems, upsertCarryFromPlanItem } from '../../src/main/ferment.ts';

export function scoredReasons(score = 80, scoredAt = new Date().toISOString()) {
  const criteria = [
    ['reality_change_significance', 25],
    ['tension_curiosity_gap', 20],
    ['audience_stakes', 20],
    ['why_now_window', 15],
    ['one_sentence_relayability', 15],
    ['account_fit', 5],
  ];
  let remaining = score;
  return {
    status: 'scored', version: 'propagation_v2',
    score,
    scoredAt,
    truthGate: { status: 'passed', reason: 'fixture fact, inference and opinion boundaries are explicit', claims: [
      { text: 'fixture editorial claim', type: 'opinion', status: 'supported', sourceIds: [] },
    ] },
    reasons: criteria.map(([criterion, weight]) => {
      const criterionScore = Math.min(weight, Math.max(0, remaining));
      remaining -= criterionScore;
      return { criterion, weight, score: criterionScore, reason: `${criterion} fixture evidence` };
    }),
  };
}

export function editorialDecision(pointOfView = '只有经过比较且证据边界清楚的主张才可进入审批') {
  return {
    version: 'editorial_thesis_v1',
    candidates: [
      { level: 'event', thesis: '事件本身刚刚发生并形成新的可核验信息', claimType: 'fact', evidenceStatus: 'supported', evidenceBoundary: 'fixture event boundary', score: 45, reason: '事件层信息明确但意义有限' },
      { level: 'user', thesis: '该变化会直接影响具体读者当前的判断与行动', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: 'fixture user boundary', score: 65, reason: '用户层具有现实利害' },
      { level: 'industry_or_society', thesis: pointOfView, claimType: 'opinion', evidenceStatus: 'supported', evidenceBoundary: 'fixture winning boundary', score: 80, reason: '产业或社会层改变旧认知且最值得传播' },
    ],
    winnerLevel: 'industry_or_society',
    winnerThesis: pointOfView,
    winnerReason: '传播价值高于事件复述和单一使用建议',
    knowledgeContext: { status: 'no_relevant_context', contextRefs: [], queryDimensions: ['fixture entity', 'fixture industry'], reason: 'fixture explicitly records that no relevant historical context exists' },
  };
}

export function approvePlanItems(database, planItemIds) {
  for (const planItemId of planItemIds) {
    let row = database.prepare(`SELECT revision, planning_status AS planningStatus, created_at AS createdAt
      FROM plan_items WHERE id=?`).get(planItemId);
    if (!row) throw new Error(`fixture plan item missing: ${planItemId}`);
    if (row.planningStatus === 'draft') {
      database.prepare(`UPDATE plan_items SET
        why_now='官方刚公布关键变化，当前两天是解释窗口，错过后读者关注会明显下降。',
        timeliness=CASE WHEN trim(coalesce(timeliness,''))='' THEN '热点 2-3 天' ELSE timeliness END,
        target_audience='需要核对真实证据并据此作出内容决策的具体目标读者',
        angle='从可核验的真实任务回执切入，解释事件对读者决策的直接影响。',
        point_of_view='只有证据链完整且能支持真实决策的选题才值得投入制作。',
        platforms_json=CASE WHEN platforms_json='[]' THEN '["xiaohongshu"]' ELSE platforms_json END,
        formats_json=CASE WHEN formats_json='[]' THEN '["carousel"]' ELSE formats_json END,
        title_guidance='标题突出事件变化与读者实际成本之间的反差。',
        opening_guidance='先给出一条可核验事实，再说明它为什么影响当前选择。',
        structure_guidance='第一段交代事件；第二段展示证据；第三段给出行动判断。',
        effort_estimate=CASE WHEN trim(coalesce(effort_estimate,''))='' THEN '90 分钟' ELSE effort_estimate END,
        score_reasons_json=?, planning_provenance_json=json_set(coalesce(planning_provenance_json,'{}'),'$.editorial_decision',json(?)), planning_status='ready_for_review', revision=revision+1, updated_at=?
        WHERE id=?`).run(JSON.stringify(scoredReasons(80, row.createdAt)), JSON.stringify(editorialDecision('只有证据链完整且能支持真实决策的选题才值得投入制作。')), row.createdAt, planItemId);
      row = database.prepare('SELECT revision, planning_status AS planningStatus, created_at AS createdAt FROM plan_items WHERE id=?').get(planItemId);
    }
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
