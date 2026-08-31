import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChairDisplayItems, poolItemToPlanItem } from '../src/renderer/today-pool-view.ts';
import { resolvePropagationGrade, propagationGradeFromScore, PROPAGATION_NEUTRAL_GRADE } from '../src/shared/propagation.ts';
import { scoredReasons } from './helpers/planning-fixture.mjs';

// Helper: build valid scored reasons JSON for a given total, ensuring 6 criteria weights and sum matches.
function buildValidScoreJson(score) {
  return JSON.stringify(scoredReasons(score));
}

function pendingScoreJson(reason = 'insufficient_evidence') {
  return JSON.stringify({ status: 'pending', score: 0, reasons: [], pending_reason: reason });
}

function makePoolItem(overrides = {}) {
  return {
    planItemId: overrides.planItemId ?? `item-${Math.random().toString(36).slice(2, 8)}`,
    planDate: overrides.planDate ?? '2026-08-26',
    title: overrides.title ?? '测试标题',
    priority: overrides.priority ?? 1,
    timeliness: overrides.timeliness ?? '热点',
    timelinessClass: overrides.timelinessClass ?? 'hot',
    expiresAt: overrides.expiresAt ?? null,
    topicId: overrides.topicId ?? null,
    sourceIds: overrides.sourceIds ?? ['s1'],
    whyNow: overrides.whyNow ?? 'why',
    angle: overrides.angle ?? 'angle',
    pointOfView: overrides.pointOfView ?? 'pov',
    targetAudience: overrides.targetAudience ?? 'aud',
    platforms: overrides.platforms ?? ['xiaohongshu'],
    formats: overrides.formats ?? ['图文'],
    titleGuidance: overrides.titleGuidance ?? 'tg',
    openingGuidance: overrides.openingGuidance ?? 'og',
    structureGuidance: overrides.structureGuidance ?? 'sg',
    effortEstimate: overrides.effortEstimate ?? '1h',
    availableMaterials: overrides.availableMaterials ?? ['m1'],
    missingMaterials: overrides.missingMaterials ?? [],
    trendEvidence: overrides.trendEvidence ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    isNew: overrides.isNew ?? false,
    demotion: overrides.demotion ?? null,
    planningStatus: overrides.planningStatus ?? null,
    revision: overrides.revision ?? null,
    planningProvenanceJson: overrides.planningProvenanceJson ?? null,
    scoreReasonsJson: overrides.scoreReasonsJson ?? null,
  };
}

function makePlanItem(id, { planningStatus = 'approved', score = 80, title = '测试标题', topicId = null, sourceIds = ['s1'] } = {}) {
  return {
    id,
    topicId,
    title,
    priority: 1,
    whyNow: 'why',
    timeliness: '热点',
    targetAudience: 'aud',
    angle: 'angle',
    pointOfView: 'pov',
    platforms: ['xiaohongshu'],
    formats: ['图文'],
    titleGuidance: 'tg',
    openingGuidance: 'og',
    structureGuidance: 'sg',
    effortEstimate: '1h',
    sourceIds,
    availableMaterials: ['m1'],
    missingMaterials: [],
    planningStatus,
    revision: 1,
    planningProvenanceJson: JSON.stringify({ origin: 'daily_judge', transitions: [{ from: null, to: planningStatus, by: 'system', at: new Date().toISOString() }] }),
    scoreReasonsJson: (planningStatus === 'approved' || planningStatus === 'ready_for_review') ? buildValidScoreJson(score) : pendingScoreJson(),
    trendEvidence: [],
  };
}

test('scored approved/ready -> S/A grades, pending/draft/invalid -> 待评分', () => {
  // 85 -> S, 80 -> S, 78 -> A, 77 -> A, 76 -> A per thresholds, both approved and ready_for_review should grade
  const cases = [
    { score: 85, expected: 'S' },
    { score: 80, expected: 'S' },
    { score: 78, expected: 'A' },
    { score: 77, expected: 'A' },
    { score: 76, expected: 'A' },
  ];
  for (const { score, expected } of cases) {
    for (const status of ['approved', 'ready_for_review']) {
      const item = { planning_status: status, score_reasons_json: buildValidScoreJson(score) };
      assert.equal(resolvePropagationGrade(item), expected, `status ${status} score ${score} should be ${expected}`);
      assert.equal(propagationGradeFromScore(score), expected);
    }
  }
  // pending drafts remain 待评分 (draft/rejected not in {approved,ready})
  const pending = { planning_status: 'draft', score_reasons_json: pendingScoreJson() };
  assert.equal(resolvePropagationGrade(pending), PROPAGATION_NEUTRAL_GRADE);
  const pendingDraftScoredButInvalid = { planning_status: 'draft', score_reasons_json: buildValidScoreJson(80) };
  // draft even with valid scored reasons is not grade-eligible
  assert.equal(resolvePropagationGrade(pendingDraftScoredButInvalid), PROPAGATION_NEUTRAL_GRADE);
  const pendingRejected = { planning_status: 'rejected', score_reasons_json: buildValidScoreJson(80) };
  assert.equal(resolvePropagationGrade(pendingRejected), PROPAGATION_NEUTRAL_GRADE);
});

test('pending/invalid shows 待评分 for approved/ready, draft stays pending', () => {
  // approved and ready but score_reasons is pending -> neutral
  for (const status of ['approved', 'ready_for_review']) {
    const pendingApproved = { planning_status: status, score_reasons_json: pendingScoreJson() };
    assert.equal(resolvePropagationGrade(pendingApproved), PROPAGATION_NEUTRAL_GRADE, `pending ${status} should be neutral`);
  }
  // invalid: total mismatch (score says 99 but reasons sum 80)
  const valid = JSON.parse(buildValidScoreJson(80));
  valid.score = 99;
  for (const status of ['approved', 'ready_for_review']) {
    const mismatch = { planning_status: status, score_reasons_json: JSON.stringify(valid) };
    assert.equal(resolvePropagationGrade(mismatch), PROPAGATION_NEUTRAL_GRADE, `mismatch ${status} should be neutral`);
  }
  // invalid: missing criterion (only 5 reasons)
  const missing = { status: 'scored', score: 60, reasons: valid.reasons.slice(0, 5) };
  for (const status of ['approved', 'ready_for_review']) {
    const missingItem = { planning_status: status, score_reasons_json: JSON.stringify(missing) };
    assert.equal(resolvePropagationGrade(missingItem), PROPAGATION_NEUTRAL_GRADE, `missing ${status} should be neutral`);
  }
  // invalid: wrong weights (legacy criteria)
  const legacy = { status: 'scored', score: 76, reasons: [
    { criterion: 'evidence_coverage', weight: 25, score: 15, reason: 'x' },
    { criterion: 'timeliness', weight: 20, score: 15, reason: 'x' },
    { criterion: 'audience_fit', weight: 20, score: 15, reason: 'x' },
    { criterion: 'angle_novelty', weight: 15, score: 12, reason: 'x' },
    { criterion: 'effort_feasibility', weight: 15, score: 11, reason: 'x' },
    { criterion: 'compliance', weight: 5, score: 4, reason: 'x' },
  ] };
  for (const status of ['approved', 'ready_for_review']) {
    const legacyItem = { planning_status: status, score_reasons_json: JSON.stringify(legacy) };
    assert.equal(resolvePropagationGrade(legacyItem), PROPAGATION_NEUTRAL_GRADE, `legacy ${status} should be neutral`);
  }
});

test('pool projection preserves ordering/materials and consumes authoritative score via stable id', () => {
  // pool has 3 items, unsorted input order must be preserved, materials untouched
  const pool = [
    makePoolItem({ planItemId: 'a-111', planDate: '2026-08-26', title: 'A标题', priority: 2, availableMaterials: ['matA'], missingMaterials: ['missA'], planningStatus: null, scoreReasonsJson: null }),
    makePoolItem({ planItemId: 'b-222', planDate: '2026-08-25', title: 'B标题', priority: 1, availableMaterials: ['matB'], scoreReasonsJson: buildValidScoreJson(80), planningStatus: 'approved' }),
    makePoolItem({ planItemId: 'c-333', planDate: '2026-08-26', title: 'A标题', priority: 3, planningStatus: 'draft', scoreReasonsJson: pendingScoreJson() }), // same title as A but different id
  ];
  // authoritative current plan contains a-111 with approved 85 (S), c-333 absent from authoritative (so its own pending stays)
  const todayPlan = {
    id: 'plan-today',
    planDate: '2026-08-26',
    summary: 'today',
    items: [
      makePlanItem('a-111', { planningStatus: 'approved', score: 85, title: 'A标题' }),
      // note: b-222 not in todayPlan (it's from 2026-08-25), c-333 not in authoritative map
    ],
  };
  const latestPlan = {
    id: 'plan-latest',
    planDate: '2026-08-25',
    summary: 'latest',
    items: [
      makePlanItem('b-222', { planningStatus: 'approved', score: 80, title: 'B标题' }),
    ],
  };

  const display = resolveChairDisplayItems(pool, todayPlan, latestPlan);
  assert.equal(display.length, 3);
  // ordering preserved
  assert.equal(display[0].id, 'a-111');
  assert.equal(display[1].id, 'b-222');
  assert.equal(display[2].id, 'c-333');
  // materials preserved from pool, not overwritten by authoritative
  assert.deepEqual(display[0].availableMaterials, ['matA']);
  assert.deepEqual(display[0].missingMaterials, ['missA']);
  // a-111 reconciled from authoritative todayPlan (85 -> S) even though pool had null
  assert.equal(resolvePropagationGrade(display[0]), 'S');
  // b-222 from latestPlan (via reconciliation) or its own pool score both 80 -> S
  assert.equal(resolvePropagationGrade(display[1]), 'S');
  // c-333 same title as a-111 but different stable id -> must NOT get S via title mis-association, stays pending
  assert.equal(resolvePropagationGrade(display[2]), PROPAGATION_NEUTRAL_GRADE);
});

test('date/current-plan boundary: pool item without authoritative match uses own embedded score; cross-date not cross-contaminated', () => {
  const pool = [
    makePoolItem({ planItemId: 'x-001', planDate: '2026-08-26', planningStatus: null, scoreReasonsJson: null }),
    makePoolItem({ planItemId: 'y-002', planDate: '2026-08-23', planningStatus: 'approved', scoreReasonsJson: buildValidScoreJson(77) }),
  ];
  // todayPlan only has x-001 but y-002 is older date not in todayPlan/latestPlan (latest is 08-26)
  const todayPlan = {
    id: 'plan-0826',
    planDate: '2026-08-26',
    summary: '',
    items: [makePlanItem('x-001', { planningStatus: 'approved', score: 85 })],
  };
  const latestPlan = null; // no latest, to force y-002 fallback to pool's own
  const display = resolveChairDisplayItems(pool, todayPlan, latestPlan);
  assert.equal(resolvePropagationGrade(display[0]), 'S'); // x from todayPlan
  assert.equal(resolvePropagationGrade(display[1]), 'A'); // y from its own embedded 77 -> A, not contaminated by x's S
});

test('poolItemToPlanItem truthfully maps pending as 待评分 and scored as grade', () => {
  const scored = makePoolItem({ planItemId: 'scored1', planningStatus: 'approved', scoreReasonsJson: buildValidScoreJson(76) });
  const pending = makePoolItem({ planItemId: 'pending1', planningStatus: 'draft', scoreReasonsJson: pendingScoreJson() });
  const scoredPlan = poolItemToPlanItem(scored);
  const pendingPlan = poolItemToPlanItem(pending);
  assert.equal(resolvePropagationGrade(scoredPlan), 'A');
  assert.equal(resolvePropagationGrade(pendingPlan), PROPAGATION_NEUTRAL_GRADE);
  // ready_for_review valid also grades
  const ready = makePoolItem({ planItemId: 'ready1', planningStatus: 'ready_for_review', scoreReasonsJson: buildValidScoreJson(88) });
  assert.equal(resolvePropagationGrade(poolItemToPlanItem(ready)), 'S');
});

test('ready_for_review pool reconciles to S/A same as approved, draft stays pending', () => {
  const pool = [
    makePoolItem({ planItemId: 'r-1', planDate: '2026-08-25', title: 'Ready标题', planningStatus: null, scoreReasonsJson: null }),
    makePoolItem({ planItemId: 'd-1', planDate: '2026-08-25', title: 'Draft标题', planningStatus: 'draft', scoreReasonsJson: pendingScoreJson() }),
  ];
  const latestPlan = {
    id: 'plan-0825',
    planDate: '2026-08-25',
    summary: '',
    items: [
      makePlanItem('r-1', { planningStatus: 'ready_for_review', score: 86, title: 'Ready标题' }),
      makePlanItem('d-1', { planningStatus: 'draft', score: 0, title: 'Draft标题' }),
    ],
  };
  // todayPlan empty, latestPlan provides authoritative ready 86->S
  const display = resolveChairDisplayItems(pool, null, latestPlan);
  assert.equal(resolvePropagationGrade(display[0]), 'S');
  assert.equal(resolvePropagationGrade(display[1]), PROPAGATION_NEUTRAL_GRADE);
  // Also direct pool without reconciliation: ready embedded should grade
  const directReady = makePoolItem({ planItemId: 'x', planningStatus: 'ready_for_review', scoreReasonsJson: buildValidScoreJson(82) });
  assert.equal(resolvePropagationGrade(poolItemToPlanItem(directReady)), 'S');
});
