import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isEligibleForApproval, isScoringPending } from '../src/shared/propagation.ts';
import { deriveTodayRunView } from '../src/renderer/today-run-view.ts';
import { isScoringPendingItem } from '../src/renderer/proposal-ledger.ts';
import { getCurrentScoringRecovery } from '../src/main/agent-runner.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const reasons = scoredReasons(76);

test('pending/invalid are blocked and scored ready is eligible', () => {
  assert.equal(isEligibleForApproval({ planning_status: 'draft', score_reasons_json: JSON.stringify({ status: 'pending', score: 0, reasons: [] }) }), false);
  assert.equal(isScoringPending({ planning_status: 'draft', score_reasons_json: JSON.stringify({ ...reasons, score: 99 }) }), true);
  assert.equal(isEligibleForApproval({ planning_status: 'ready_for_review', score_reasons_json: JSON.stringify(reasons), point_of_view: '合格主张', planning_provenance_json: JSON.stringify({ editorial_decision: editorialDecision('合格主张') }) }), true);
  const legacy = { ...reasons, reasons: reasons.reasons.map((row, index) => ({ ...row, criterion: ['evidence_coverage','timeliness','audience_fit','angle_novelty','effort_feasibility','compliance'][index] })) };
  assert.equal(isEligibleForApproval({ planning_status: 'ready_for_review', score_reasons_json: JSON.stringify(legacy) }), false);
});

test('Today projects scoring_incomplete and retryable exact error', () => {
  const base = { task: null, hasTodayPlan: false, hasRecentPlan: false, opportunityCount: 0, sssCount: 0, sourcesTotal: 2, studioActive: 0, piConfigured: true, channelsSummary: null };
  const pending = deriveTodayRunView({ ...base, scoringPendingCount: 4 });
  assert.equal(pending.step, 'scoring_incomplete');
  assert.equal(pending.primaryCta.label, '继续评分');
  const failed = deriveTodayRunView({ ...base, scoringPendingCount: 4, scoringError: 'items.3.scoreReasons: score_total_mismatch' });
  assert.match(failed.detail, /score_total_mismatch/);
});



test('A: Today scoring pending derives from plan items not OpportunityPoolItem', () => {
  const planItem = { planning_status: 'draft', score_reasons_json: JSON.stringify({ status: 'pending', score: 0, reasons: [], pending_reason: 'insufficient_evidence' }) };
  const poolItem = { planItemId: 'x', planDate: '2026-08-25', title: 't', priority: 0 };
  assert.equal(isScoringPendingItem(planItem), true);
  assert.equal(isScoringPendingItem(poolItem), false);
  const todayPlanItems = [planItem, planItem, planItem, planItem];
  const pool = [poolItem, poolItem, poolItem, poolItem];
  const pendingFromPlan = todayPlanItems.filter((it) => isScoringPendingItem(it)).length;
  const pendingFromPool = pool.filter((it) => it.planDate === '2026-08-25' && isScoringPendingItem(it)).length;
  assert.equal(pendingFromPlan, 4);
  assert.equal(pendingFromPool, 0);
  const viewFromPlan = deriveTodayRunView({ task: null, hasTodayPlan: true, hasRecentPlan: false, opportunityCount: 4, scoringPendingCount: pendingFromPlan, sssCount: 0, sourcesTotal: 4, studioActive: 0, piConfigured: true, channelsSummary: null });
  assert.equal(viewFromPlan.step, 'scoring_incomplete');
  assert.equal(viewFromPlan.primaryCta.label, '继续评分');
  assert.equal(viewFromPlan.primaryCta.kind, 'continue');
  const viewFromPool = deriveTodayRunView({ task: null, hasTodayPlan: true, hasRecentPlan: false, opportunityCount: 4, scoringPendingCount: pendingFromPool, sssCount: 0, sourcesTotal: 4, studioActive: 0, piConfigured: true, channelsSummary: null });
  assert.notEqual(viewFromPool.step, 'scoring_incomplete');
});

test('B: headless pi-config resolves without electron app.getPath', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-pi-test-'));
  const originalAcceptance = process.env.WMB_ACCEPTANCE_USER_DATA;
  const originalPiPath = process.env.WMB_PI_CONFIG_PATH;
  process.env.WMB_ACCEPTANCE_USER_DATA = tmp;
  delete process.env.WMB_PI_CONFIG_PATH;
  try {
    const { resolveRoleModelPolicySnapshot } = await import('../src/main/pi-config.ts');
    let threw = null;
    try { resolveRoleModelPolicySnapshot('planner'); } catch (e) { threw = e; }
    assert.ok(threw, 'should throw');
    const code = threw.code || threw.message;
    assert.match(String(code), /ROLE_MODEL_POLICY_REQUIRED|ROLE_MODEL_/);
    assert.doesNotMatch(String(threw.message), /getPath/);
    assert.doesNotMatch(String(threw.stack || ''), /getPath/);
  } finally {
    if (originalAcceptance === undefined) delete process.env.WMB_ACCEPTANCE_USER_DATA; else process.env.WMB_ACCEPTANCE_USER_DATA = originalAcceptance;
    if (originalPiPath === undefined) delete process.env.WMB_PI_CONFIG_PATH; else process.env.WMB_PI_CONFIG_PATH = originalPiPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});
