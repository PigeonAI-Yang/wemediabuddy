import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREATION_EXPERIMENT_PROMOTION_THRESHOLDS,
  evaluateCreationExperimentCohorts
} from '../src/main/creation-experiment-observation.ts';

const sample = (overrides = {}) => ({ articleSaved: true, durationMs: 110, misuse: false, selectionMargin: 8, ...overrides });

test('WMB-5402 keeps one-shot evidence in observation instead of promoting early', () => {
  const decision = evaluateCreationExperimentCohorts({
    experiment: [sample()],
    baseline: [sample({ durationMs: 100 })]
  });
  assert.equal(decision.status, 'observe');
  assert.ok(decision.reasons.some((reason) => reason.includes('实验样本不足')));
  assert.ok(decision.reasons.some((reason) => reason.includes('基线样本不足')));
});

test('WMB-5402 only marks stable benefit as eligible for a later product-design decision', () => {
  const experiment = Array.from({ length: CREATION_EXPERIMENT_PROMOTION_THRESHOLDS.minExperimentCount }, () => sample());
  const baseline = Array.from({ length: CREATION_EXPERIMENT_PROMOTION_THRESHOLDS.minBaselineCount }, (_, index) =>
    sample({ articleSaved: index < 8, durationMs: 100, selectionMargin: null })
  );
  const decision = evaluateCreationExperimentCohorts({ experiment, baseline });
  assert.equal(decision.status, 'eligible_for_product_design');
  assert.equal(decision.articleRateLift, 0.2);
  assert.equal(decision.misuseRate, 0);
  assert.equal(decision.medianSelectionMargin, 8);
  assert.equal(decision.medianLatencyOverhead, 0.1);
  assert.deepEqual(decision.reasons, []);
});

test('WMB-5402 rejects unstable benefit when misuse or latency cost crosses the gate', () => {
  const experiment = Array.from({ length: 10 }, (_, index) => sample({ misuse: index === 0, durationMs: 140 }));
  const baseline = Array.from({ length: 10 }, (_, index) => sample({ articleSaved: index < 8, durationMs: 100, selectionMargin: null }));
  const decision = evaluateCreationExperimentCohorts({ experiment, baseline });
  assert.equal(decision.status, 'observe');
  assert.equal(decision.misuseRate, 0.1);
  assert.equal(decision.medianLatencyOverhead, 0.4);
  assert.ok(decision.reasons.some((reason) => reason.includes('误用率')));
  assert.ok(decision.reasons.some((reason) => reason.includes('额外时延')));
});
