// WMB-5349 foundation gates: 9-field fallback exact, validate, minimal draft, submit/transition, revision guard, plans.save ready_for_review
// Verify via: node --test tests/planning-stage-foundation.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const planningStage = await import('../src/main/planning-stage.ts');
const planning = await import('../src/main/planning.ts');
const { upsertSource } = await import('../src/main/sources.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5349-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {} }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  return db;
}
function makeSource(db, url = 'https://example.com/source') {
  return upsertSource(db, { originalUrl: url, title: 'Src ' + Math.random().toString(36).slice(2, 6) });
}
function scoredReasons() {
  return {
    status: 'scored', version: 'propagation_v2',
    score: 82,
    truthGate: { status: 'passed', reason: '测试资料支持事实、推断与观点边界', claims: [
      { text: '测试中心主张', type: 'opinion', status: 'supported', sourceIds: [] },
    ] },
    reasons: [
      { criterion: 'reality_change_significance', weight: 25, score: 22, reason: 'changes current reality' },
      { criterion: 'tension_curiosity_gap', weight: 20, score: 17, reason: 'clear knowledge gap' },
      { criterion: 'audience_stakes', weight: 20, score: 17, reason: 'specific audience stakes' },
      { criterion: 'why_now_window', weight: 15, score: 12, reason: 'current window' },
      { criterion: 'one_sentence_relayability', weight: 15, score: 10, reason: 'relayable claim' },
      { criterion: 'account_fit', weight: 5, score: 4, reason: 'account fit' },
    ],
  };
}
function editorialDecision(pointOfView) {
  return {
    version: 'editorial_thesis_v1',
    candidates: [
      { level: 'event', thesis: '事件本身产生了新的可核验信息', claimType: 'fact', evidenceStatus: 'supported', evidenceBoundary: '测试事件边界', score: 45, reason: '事件层意义有限' },
      { level: 'user', thesis: '该变化会影响目标读者当前判断', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '测试用户边界', score: 65, reason: '用户层有现实利害' },
      { level: 'industry_or_society', thesis: pointOfView, claimType: 'opinion', evidenceStatus: 'supported', evidenceBoundary: '测试赢家边界', score: 82, reason: '产业社会层最值得传播' },
    ],
    winnerLevel: 'industry_or_society', winnerThesis: pointOfView, winnerReason: '传播价值最高且证据已支持',
    knowledgeContext: { status: 'no_relevant_context', contextRefs: [], queryDimensions: ['测试实体', '测试产业关联'], reason: '测试明确记录没有相关历史上下文' },
  };
}
function completeItem(sourceId, overrides = {}) {
  return {
    title: '完整策划标题用于评审通过的选题示例标题',
    priority: 2,
    whyNow: '2026-08-23 某厂商发布新模型，引发技术社区对齐争议，需在窗口期内解读',
    timeliness: 'today',
    targetAudience: 'AI 从业者与技术管理者',
    angle: '世界模型路线是否具备规模化证据的争议切口',
    pointOfView: '当前证据不支持世界模型已解决长程一致性，主张分层验证',
    platforms: ['x'],
    formats: ['article'],
    titleGuidance: '以争议为引的标题',
    openingGuidance: '用发布事件开场，给出核心分歧',
    structureGuidance: '第一段交代事件；第二段展示争议与证据；第三段给出判断与行动。',
    effortEstimate: 'M',
    sourceIds: [sourceId],
    availableMaterials: ['官方发布原文与时间线'],
    missingMaterials: [],
    scoreReasons: scoredReasons(),
    ...overrides,
    editorialDecision: overrides.editorialDecision ?? editorialDecision(overrides.pointOfView ?? '当前证据不支持世界模型已解决长程一致性，主张分层验证'),
  };
}
function fallbackItem(sourceId) {
  return {
    title: '知乎热题占位标题',
    priority: 2,
    whyNow: '基于知乎热题的每日内容目标',
    timeliness: 'today',
    targetAudience: '泛科技受众',
    angle: '深度解读该问题的核心争议与证据',
    pointOfView: '提供独立判断与可操作建议',
    platforms: ['x', 'xiaohongshu', 'wechat'],
    formats: ['article'],
    titleGuidance: '知乎热题占位标题',
    openingGuidance: '以问题为引，快速建立共识再展开分析',
    structureGuidance: '背景→拆解→证据→观点→行动',
    effortEstimate: 'M',
    sourceIds: [sourceId],
    availableMaterials: [],
    missingMaterials: [],
    scoreReasons: scoredReasons(),
  };
}

test('isExactZhihuFallback exact nine fields deep equal', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSource(db, 'https://example.com/a1');
    const item = fallbackItem(src.id);
    assert.equal(planningStage.isExactZhihuFallback(item), true);
    // one field diff -> false
    const diff = { ...item, targetAudience: 'AI 从业者' };
    assert.equal(planningStage.isExactZhihuFallback(diff), false);
    // platforms order diff -> false
    const orderDiff = { ...item, platforms: ['xiaohongshu', 'x', 'wechat'] };
    assert.equal(planningStage.isExactZhihuFallback(orderDiff), false);
    // platforms stringified via DB row shape (snake_json) still detected
    const snake = {
      why_now: '基于知乎热题的每日内容目标',
      timeliness: 'today',
      target_audience: '泛科技受众',
      angle: '深度解读该问题的核心争议与证据',
      point_of_view: '提供独立判断与可操作建议',
      platforms_json: JSON.stringify(['x', 'xiaohongshu', 'wechat']),
      formats_json: JSON.stringify(['article']),
      opening_guidance: '以问题为引，快速建立共识再展开分析',
      structure_guidance: '背景→拆解→证据→观点→行动',
    };
    assert.equal(planningStage.isExactZhihuFallback(snake), true);
    db.close();
  });
});

test('validatePlanItemForReview rejects fallback and pending, accepts complete', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSource(db);
    const bad = fallbackItem(src.id);
    const vBad = planningStage.validatePlanItemForReview(bad);
    assert.equal(vBad.valid, false);
    assert.ok(vBad.errors.includes('exact_zhihu_fallback_template'));
    assert.equal(vBad.isFallback, true);

    const pending = completeItem(src.id, { scoreReasons: { status: 'pending', score: 0, reasons: [], pending_reason: 'insufficient_evidence' } });
    const vPending = planningStage.validatePlanItemForReview(pending);
    assert.equal(vPending.valid, false);
    assert.ok(vPending.errors.includes('score_pending_not_allowed'));

    const good = completeItem(src.id);
    const vGood = planningStage.validatePlanItemForReview(good);
    assert.equal(vGood.valid, true);
    assert.equal(vGood.isFallback, false);
    const missingScore = completeItem(src.id, { scoreReasons: undefined });
    const vMissingScore = planningStage.validatePlanItemForReview(missingScore);
    assert.equal(vMissingScore.valid, false);
    assert.ok(vMissingScore.errors.includes('scoreReasons_required'));

    const mismatchedScore = completeItem(src.id, { scoreReasons: { ...scoredReasons(), score: 100 } });
    assert.ok(planningStage.validatePlanItemForReview(mismatchedScore).errors.includes('score_total_mismatch'));

    const missingTitle = completeItem(src.id, { title: '' });
    assert.equal(planningStage.validatePlanItemForReview(missingTitle).valid, false);
    db.close();
  });
});

test('createPlanningDraftFromTarget minimal draft only title/sourceIds pending provenance no pseudo template', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSource(db, 'https://example.com/draft-src');
    const planDate = '2026-08-23';
    // ensure plan not exists
    const { planItemId, revision, planningStatus } = planningStage.createPlanningDraftFromTarget(db, { title: '最小草稿标题', sourceIds: [src.id], planDate, origin: 'zhihu_hot' });
    assert.equal(planningStatus, 'draft');
    assert.equal(revision, 1);
    const row = db.prepare('SELECT title, source_ids_json, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, planning_status, planning_provenance_json, score_reasons_json, available_materials_json, missing_materials_json FROM plan_items WHERE id = ?').get(planItemId);
    assert.equal(row.title, '最小草稿标题');
    assert.deepEqual(JSON.parse(row.source_ids_json), [src.id]);
    // empty planning fields not fallback template
    assert.equal(row.why_now, '');
    assert.equal(row.timeliness, '');
    assert.equal(row.target_audience, '');
    assert.equal(row.angle, '');
    assert.deepEqual(JSON.parse(row.platforms_json), []);
    assert.equal(row.planning_status, 'draft');
    const prov = JSON.parse(row.planning_provenance_json);
    assert.equal(prov.origin, 'zhihu_hot');
    assert.equal(prov.transitions[0].to, 'draft');
    assert.deepEqual(prov.fingerprints.zhihu_hot_ids, [src.id]);
    const score = JSON.parse(row.score_reasons_json);
    assert.equal(score.status, 'pending');
    assert.equal(score.score, 0);
    assert.equal(score.pending_reason, 'insufficient_evidence');
    // ensure not fallback
    assert.equal(planningStage.isExactZhihuFallback({ whyNow: row.why_now, timeliness: row.timeliness, targetAudience: row.target_audience, angle: row.angle, pointOfView: row.point_of_view, platforms: JSON.parse(row.platforms_json), formats: JSON.parse(row.formats_json), openingGuidance: row.opening_guidance, structureGuidance: row.structure_guidance }), false);
    db.close();
  });
});

test('submitPlanItemForReview draft->ready_for_review success, validation failure no mutate, stale revision conflict', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSource(db, 'https://example.com/submit-src');
    const planDate = '2026-08-24';
    const { planItemId } = planningStage.createPlanningDraftFromTarget(db, { title: '待提交草稿', sourceIds: [src.id], planDate });
    const before = db.prepare('SELECT revision, planning_status FROM plan_items WHERE id = ?').get(planItemId);
    assert.equal(before.revision, 1);
    assert.equal(before.planning_status, 'draft');
    // success with complete item
    const good = completeItem(src.id);
    const res = planningStage.submitPlanItemForReview(db, { planItemId, expectedRevision: 1, item: good, by: 'planner' });
    assert.equal(res.planningStatus, 'ready_for_review');
    assert.equal(res.revision, 2);
    const after = db.prepare('SELECT revision, planning_status, planning_provenance_json, score_reasons_json, why_now FROM plan_items WHERE id = ?').get(planItemId);
    assert.equal(after.planning_status, 'ready_for_review');
    assert.equal(after.revision, 2);
    assert.equal(after.why_now, good.whyNow);
    assert.deepEqual(JSON.parse(after.score_reasons_json), scoredReasons());
    const prov = JSON.parse(after.planning_provenance_json);
    assert.equal(prov.transitions.length, 2);
    assert.equal(prov.transitions[1].from, 'draft');
    assert.equal(prov.transitions[1].to, 'ready_for_review');
    // validation failure: fallback item should not mutate
    const { planItemId: id2 } = planningStage.createPlanningDraftFromTarget(db, { title: '另一草稿', sourceIds: [src.id], planDate: '2026-08-25' });
    const fb = fallbackItem(src.id);
    assert.throws(() => planningStage.submitPlanItemForReview(db, { planItemId: id2, expectedRevision: 1, item: fb }), (e) => { assert.equal(e.code, 'validation_failed'); return true; });
    const still = db.prepare('SELECT revision, planning_status, why_now FROM plan_items WHERE id = ?').get(id2);
    assert.equal(still.revision, 1);
    assert.equal(still.planning_status, 'draft');
    assert.equal(still.why_now, ''); // not overwritten
    // pending score should also validation fail
    const pending = completeItem(src.id, { scoreReasons: { status: 'pending', score: 0, reasons: [] } });
    assert.throws(() => planningStage.submitPlanItemForReview(db, { planItemId: id2, expectedRevision: 1, item: pending }), (e) => e.code === 'validation_failed');
    // stale revision conflict
    const good2 = completeItem(src.id, { title: '完整策划标题用于评审通过的选题示例标题2' });
    // first submit succeeds
    planningStage.submitPlanItemForReview(db, { planItemId: id2, expectedRevision: 1, item: good2 });
    // second submit with old revision should conflict
    assert.throws(() => planningStage.submitPlanItemForReview(db, { planItemId: id2, expectedRevision: 1, item: good2 }), (e) => e.code === 'conflict');
    db.close();
  });
});

test('transitionPlanItem legal and illegal paths and stale revision', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSource(db, 'https://example.com/trans-src');
    const planDate = '2026-08-26';
    const { planItemId } = planningStage.createPlanningDraftFromTarget(db, { title: '转移测试草稿', sourceIds: [src.id], planDate });
    const good = completeItem(src.id);
    // draft -> ready_for_review via submit
    const r1 = planningStage.submitPlanItemForReview(db, { planItemId, expectedRevision: 1, item: good });
    assert.equal(r1.planningStatus, 'ready_for_review');
    // ready_for_review -> approved (legal)
    const r2 = planningStage.transitionPlanItem(db, { planItemId, expectedRevision: 2, expectedStatus: 'ready_for_review', toStatus: 'approved', by: 'desk', reason: 'approve' });
    assert.equal(r2.planningStatus, 'approved');
    assert.equal(r2.revision, 3);
    const prov = JSON.parse(db.prepare('SELECT planning_provenance_json FROM plan_items WHERE id = ?').get(planItemId).planning_provenance_json);
    assert.equal(prov.transitions[2].from, 'ready_for_review');
    assert.equal(prov.transitions[2].to, 'approved');
    assert.equal(prov.transitions[2].by, 'desk');
    // approved -> rejected illegal should conflict
    assert.throws(() => planningStage.transitionPlanItem(db, { planItemId, expectedRevision: 3, expectedStatus: 'approved', toStatus: 'rejected', by: 'desk' }), (e) => e.code === 'conflict');
    // stale revision on approved path
    assert.throws(() => planningStage.transitionPlanItem(db, { planItemId, expectedRevision: 2, expectedStatus: 'approved', toStatus: 'rejected', by: 'desk' }), (e) => e.code === 'conflict');
    // also test rejected path
    const { planItemId: id2 } = planningStage.createPlanningDraftFromTarget(db, { title: '驳回测试草稿', sourceIds: [src.id], planDate: '2026-08-27' });
    planningStage.submitPlanItemForReview(db, { planItemId: id2, expectedRevision: 1, item: good });
    const rej = planningStage.transitionPlanItem(db, { planItemId: id2, expectedRevision: 2, expectedStatus: 'ready_for_review', toStatus: 'rejected', by: 'desk', reason: 'needs more evidence' });
    assert.equal(rej.planningStatus, 'rejected');
    // rejected -> draft (rework) legal
    const rework = planningStage.transitionPlanItem(db, { planItemId: id2, expectedRevision: 3, expectedStatus: 'rejected', toStatus: 'draft', by: 'owner_ui' });
    assert.equal(rework.planningStatus, 'draft');
    // draft -> approved illegal (skip review)
    const { planItemId: id3 } = planningStage.createPlanningDraftFromTarget(db, { title: '非法直批草稿', sourceIds: [src.id], planDate: '2026-08-28' });
    assert.throws(() => planningStage.transitionPlanItem(db, { planItemId: id3, expectedRevision: 1, expectedStatus: 'draft', toStatus: 'approved', by: 'desk' }), (e) => e.code === 'conflict');
    // draft -> draft allowed (incremental)
    const draftSelf = planningStage.transitionPlanItem(db, { planItemId: id3, expectedRevision: 1, expectedStatus: 'draft', toStatus: 'draft', by: 'planner' });
    assert.equal(draftSelf.planningStatus, 'draft');
    assert.equal(draftSelf.revision, 2);
    db.close();
  });
});

test('saveCurrentPlan creates ready_for_review only, fallback batch rollback, no direct approved', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSource(db, 'https://example.com/save-src');
    const planDate = '2026-08-29';
    const good1 = completeItem(src.id, { title: '策划标题A完整示例用于批量保存' });
    const good2 = completeItem(src.id, { title: '策划标题B完整示例用于批量保存', priority: 3, targetAudience: '正在核算 AI 工具成本并负责真实交付的独立开发者', angle: '从真实成本结构与失败回执切入验证投入价值', pointOfView: '先验证完整成本和稳定性，再决定是否持续投入' });
    // success batch -> ready_for_review
    const res = planning.saveCurrentPlan(db, { planDate, timezone: 'Asia/Shanghai', summary: 'batch save', items: [good1, good2] });
    assert.ok(res.id);
    const rows = db.prepare('SELECT planning_status, planning_provenance_json, score_reasons_json FROM plan_items WHERE plan_id = ? ORDER BY sort_order').all(res.id);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.planning_status, 'ready_for_review');
      assert.notEqual(r.planning_status, 'approved');
      const prov = JSON.parse(r.planning_provenance_json);
      assert.ok(prov.transitions.some(t => t.to === 'ready_for_review'));
      const score = JSON.parse(r.score_reasons_json);
      assert.equal(score.status, 'scored');
    }
    // fallback batch should rollback entirely
    const fb = fallbackItem(src.id);
    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM plans').get().c;
    assert.throws(() => planning.saveCurrentPlan(db, { planDate: '2026-08-30', timezone: 'Asia/Shanghai', summary: 'fallback batch', items: [good1, fb] }), (e) => e.code === 'validation_failed');
    const afterCount = db.prepare('SELECT COUNT(*) as c FROM plans').get().c;
    assert.equal(beforeCount, afterCount);
    const noPlan = db.prepare('SELECT COUNT(*) as c FROM plans WHERE plan_date = ?').get('2026-08-30').c;
    assert.equal(noPlan, 0);
    // pending score should also rollback
    const pending = completeItem(src.id, { scoreReasons: { status: 'pending', score: 0, reasons: [] } });
    assert.throws(() => planning.saveCurrentPlan(db, { planDate: '2026-08-31', timezone: 'Asia/Shanghai', summary: 'pending batch', items: [pending] }), (e) => e.code === 'validation_failed');
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM plans WHERE plan_date = ?').get('2026-08-31').c, 0);
    db.close();
  });
});
