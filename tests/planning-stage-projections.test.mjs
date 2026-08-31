// WMB-5352 projection gates — draft/pending excluded from Today, approved included,
// all four planning statuses visible in Proposals, pending never renders 100,
// and approve/reject calls fixed bridge with revision/reason.
// Verify via: node --test tests/planning-stage-projections.test.mjs (do NOT run in Wave B; main validates)
import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';

const ledger = await import('../src/renderer/proposal-ledger.ts');

function scoredReasons(score = 82) {
  return {
    status: 'scored',
    score,
    reasons: [
      { criterion: 'evidence_coverage', weight: 25, score: score - 60, reason: 'has body' },
      { criterion: 'timeliness', weight: 20, score: 17, reason: 'today' },
      { criterion: 'audience_fit', weight: 20, score: 17, reason: 'specific' },
      { criterion: 'angle_novelty', weight: 15, score: 12, reason: 'dispute' },
      { criterion: 'effort_feasibility', weight: 15, score: 10, reason: 'bounded' },
      { criterion: 'compliance', weight: 5, score: 4, reason: 'citable' },
    ],
  };
}

function pendingReasons() {
  return {
    status: 'pending',
    score: 0,
    reasons: [
      { criterion: 'evidence_coverage', weight: 25, score: 0, reason: 'no_source_body_or_claims' },
      { criterion: 'timeliness', weight: 20, score: 0, reason: 'today_but_no_source_evidence' },
      { criterion: 'audience_fit', weight: 20, score: 0 },
      { criterion: 'angle_novelty', weight: 15, score: 0 },
      { criterion: 'effort_feasibility', weight: 15, score: 0 },
      { criterion: 'compliance', weight: 5, score: 5 },
    ],
    pending_reason: 'insufficient_evidence',
  };
}

function makeItem(overrides = {}) {
  const base = {
    id: `item-${Math.random().toString(36).slice(2, 6)}`,
    planItemId: `item-${Math.random().toString(36).slice(2, 6)}`,
    title: '测试标题用于评审通过的选题示例标题足够长',
    planning_status: 'approved',
    planningStatus: 'approved',
    revision: 2,
    score_reasons_json: JSON.stringify(scoredReasons(82)),
    scoreReasons: scoredReasons(82),
    planning_provenance_json: JSON.stringify({ origin: 'manual', transitions: [{ from: 'draft', to: 'approved', by: 'desk', at: new Date().toISOString() }] }),
  };
  return { ...base, ...overrides };
}

describe('WMB-5352 Today filters to approved only', () => {
  test('draft/pending excluded, approved included', () => {
    const draft = makeItem({ planning_status: 'draft', planningStatus: 'draft', score_reasons_json: JSON.stringify(pendingReasons()) });
    const pendingDraft = makeItem({ planning_status: 'draft', score_reasons_json: JSON.stringify(pendingReasons()) });
    const ready = makeItem({ planning_status: 'ready_for_review', planningStatus: 'ready_for_review', score_reasons_json: JSON.stringify(scoredReasons(76)) });
    const rejected = makeItem({ planning_status: 'rejected', planningStatus: 'rejected', score_reasons_json: JSON.stringify(scoredReasons(70)) });
    const approved = makeItem({ planning_status: 'approved', planningStatus: 'approved', score_reasons_json: JSON.stringify(scoredReasons(85)), revision: 5 });
    const mixed = [draft, pendingDraft, ready, rejected, approved];
    const filtered = ledger.filterApprovedItems(mixed);
    assert.equal(filtered.length, 1, 'only approved should pass Today filter');
    assert.equal(filtered[0].planning_status, 'approved');
    // also via helper
    assert.equal(ledger.isApproved(approved), true);
    assert.equal(ledger.isApproved(draft), false);
    assert.equal(ledger.isApproved(ready), false);
    assert.equal(ledger.isApproved(rejected), false);
  });

  test('Today operational count equals approved count, not raw', () => {
    const rawTodayItems = [
      makeItem({ planning_status: 'draft', score_reasons_json: JSON.stringify(pendingReasons()) }),
      makeItem({ planning_status: 'ready_for_review', score_reasons_json: JSON.stringify(scoredReasons(70)) }),
      makeItem({ planning_status: 'approved', score_reasons_json: JSON.stringify(scoredReasons(90)) }),
      makeItem({ planning_status: 'approved', score_reasons_json: JSON.stringify(scoredReasons(88)) }),
    ];
    const approved = ledger.filterApprovedItems(rawTodayItems);
    assert.equal(approved.length, 2);
    assert.equal(ledger.countByPlanningStatus(rawTodayItems).approved, 2);
    assert.equal(ledger.countByPlanningStatus(rawTodayItems).draft, 1);
    assert.equal(ledger.countByPlanningStatus(rawTodayItems).ready_for_review, 1);
  });
});

describe('Proposals honest four states', () => {
  test('all four planning statuses visible via grouping', () => {
    const items = [
      makeItem({ planning_status: 'draft', planningStatus: 'draft', score_reasons_json: JSON.stringify(pendingReasons()) }),
      makeItem({ planning_status: 'ready_for_review', planningStatus: 'ready_for_review', score_reasons_json: JSON.stringify(scoredReasons(75)) }),
      makeItem({ planning_status: 'approved', planningStatus: 'approved', score_reasons_json: JSON.stringify(scoredReasons(85)) }),
      makeItem({ planning_status: 'rejected', planningStatus: 'rejected', score_reasons_json: JSON.stringify(scoredReasons(60)) }),
    ];
    const groups = ledger.groupProposalsByPlanningStatus(items);
    assert.equal(groups.draft.length, 1);
    assert.equal(groups.ready_for_review.length, 1);
    assert.equal(groups.approved.length, 1);
    assert.equal(groups.rejected.length, 1);
    // Ensure availablePlanningStatuses exhaustive
    assert.deepEqual(ledger.availablePlanningStatuses().sort(), ['approved', 'draft', 'ready_for_review', 'rejected'].sort());
    const counts = ledger.countByPlanningStatus(items);
    assert.equal(counts.draft, 1);
    assert.equal(counts.ready_for_review, 1);
    assert.equal(counts.approved, 1);
    assert.equal(counts.rejected, 1);
  });
});

describe('Pending never renders 100, draft shows —', () => {
  test('pending score displays — / 待补证据, not 100', () => {
    const pending = pendingReasons();
    const draftPending = ledger.formatScoreDisplay(pending, 'draft');
    const scorePending = ledger.formatScoreDisplay(pending, 'ready_for_review');
    assert.equal(draftPending, '— / 待补证据');
    assert.equal(scorePending, '— / 待补证据');
    // with pending, formatScoreWithPending shows honest copy
    assert.equal(ledger.formatScoreWithPending(pending, 'draft'), '评分：待补证据（—）');
    assert.equal(ledger.formatScoreWithPending(pending), '评分：待补证据（—）');
    // Even if someone passes score 100 with pending status, still — (honest)
    const fake100Pending = { ...pending, score: 100 };
    assert.equal(ledger.formatScoreDisplay(fake100Pending, 'draft'), '— / 待补证据');
    assert.equal(ledger.formatScoreDisplay(fake100Pending), '— / 待补证据');
  });

  test('scored approved shows numeric, not —', () => {
    const scored = scoredReasons(82);
    assert.equal(ledger.formatScoreDisplay(scored, 'approved'), '82');
    assert.equal(ledger.formatScoreWithPending(scored, 'approved'), '评分：82');
    // Pending field missing -> treated as pending
    assert.equal(ledger.formatScoreDisplay(null, 'draft'), '— / 待补证据');
    assert.equal(ledger.formatScoreDisplay(null, 'approved'), '— / 待补证据');
  });

  test('getScoreReasons parses honest provenance/revision', () => {
    const item = makeItem({
      planning_status: 'ready_for_review',
      revision: 3,
      planning_provenance_json: JSON.stringify({ origin: 'planner', transitions: [{ from: 'draft', to: 'ready_for_review', by: 'planner', at: new Date().toISOString(), reason: 'submit_for_review' }], fingerprints: { template_exact_9fields: false } }),
      score_reasons_json: JSON.stringify(scoredReasons(77)),
    });
    assert.equal(ledger.getPlanningStatus(item), 'ready_for_review');
    assert.equal(ledger.getRevision(item), 3);
    const prov = ledger.getPlanningProvenance(item);
    assert.equal(prov?.origin, 'planner');
    const score = ledger.getScoreReasons(item);
    assert.equal(score?.status, 'scored');
    assert.equal(score?.score, 77);
  });
});

describe('Approve/reject calls fixed bridge with revision/reason and readback', () => {
  let originalWindow;
  beforeEach(() => {
    originalWindow = globalThis.window;
  });
  afterEach(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  test('approve calls plan_item.approve bridge with expectedRevision and optional reason, refreshes readback', async () => {
    const calls = [];
    const mockWmb = {
      planItemApprove: async (payload) => {
        calls.push(payload);
        return { ok: true, data: { id: payload.planItemId, revision: payload.expectedRevision + 1, planningStatus: 'approved' }, readback: { planItemId: payload.planItemId } };
      },
      getProposalLedger: async () => ({ tab: 'today', items: [], counts: {} }),
      getToday: async () => ({ plan: null, pool: [] }),
    };
    globalThis.window = { wmb: mockWmb };
    const result = await ledger.approvePlanItem({ planItemId: 'plan-123', expectedRevision: 4, reason: '符合选题标准' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].planItemId, 'plan-123');
    assert.equal(calls[0].expectedRevision, 4);
    assert.equal(calls[0].reason, '符合选题标准');
    assert.equal(result.ok, true);
    // Without reason also valid (approve reason optional)
    calls.length = 0;
    await ledger.approvePlanItem({ planItemId: 'plan-124', expectedRevision: 2 });
    assert.equal(calls[0].planItemId, 'plan-124');
    assert.equal(calls[0].expectedRevision, 2);
    assert.equal(calls[0].reason, undefined);
  });

  test('reject calls plan_item.reject with required reason and revision, fails without reason', async () => {
    const calls = [];
    const mockWmb = {
      planItemReject: async (payload) => {
        calls.push(payload);
        return { ok: true, data: { id: payload.planItemId, revision: payload.expectedRevision + 1, planningStatus: 'rejected' } };
      },
      getProposalLedger: async () => ({}),
      getToday: async () => ({}),
    };
    globalThis.window = { wmb: mockWmb };
    await ledger.rejectPlanItem({ planItemId: 'plan-999', expectedRevision: 3, reason: '证据不足，需补充来源' });
    assert.equal(calls[0].planItemId, 'plan-999');
    assert.equal(calls[0].expectedRevision, 3);
    assert.equal(calls[0].reason, '证据不足，需补充来源');
    await assert.rejects(() => ledger.rejectPlanItem({ planItemId: 'plan-999', expectedRevision: 3, reason: '' }), /reason required/);
    await assert.rejects(() => ledger.rejectPlanItem({ planItemId: 'plan-999', expectedRevision: 3, reason: '   ' }), /reason required/);
  });

  test('approve/reject bridges are fixed command names, gap error when missing', async () => {
    globalThis.window = { wmb: {} };
    await assert.rejects(() => ledger.approvePlanItem({ planItemId: 'x', expectedRevision: 1 }), (err) => {
      assert.match(String(err.message), /plan_item\.approve/);
      const gap = err.gap;
      assert.ok(gap);
      assert.equal(gap.missing, 'plan_item.approve');
      assert.ok(gap.expectedCommands.includes('plan_item.approve'));
      assert.ok(gap.expectedCommands.includes('plan_item.reject'));
      return true;
    });
    await assert.rejects(() => ledger.rejectPlanItem({ planItemId: 'x', expectedRevision: 1, reason: 'test' }), (err) => {
      assert.match(String(err.message), /plan_item\.reject/);
      return true;
    });
  });

  test('ready_for_review visible with approve/reject actions (provenance/revision present)', () => {
    const ready = makeItem({
      planning_status: 'ready_for_review',
      planningStatus: 'ready_for_review',
      revision: 3,
      planning_provenance_json: JSON.stringify({ origin: 'planner', transitions: [{ from: 'draft', to: 'ready_for_review', by: 'planner', at: new Date().toISOString() }] }),
      score_reasons_json: JSON.stringify(scoredReasons(78)),
    });
    assert.equal(ledger.getPlanningStatus(ready), 'ready_for_review');
    assert.equal(ledger.getRevision(ready), 3);
    // Ready must have valid provenance and not be fallback
    const prov = ledger.getPlanningProvenance(ready);
    assert.equal(prov?.origin, 'planner');
    const score = ledger.getScoreReasons(ready);
    assert.equal(ledger.formatScoreDisplay(score, 'ready_for_review'), '78');
  });
});
