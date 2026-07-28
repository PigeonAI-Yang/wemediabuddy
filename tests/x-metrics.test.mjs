import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetricValue } from '../src/main/platforms/metric-value.ts';

test('X metric labels preserve explicit zero and localized scales', () => {
  assert.equal(parseMetricValue('0 回复。回复'), 0);
  assert.equal(parseMetricValue('3 查看'), 3);
  assert.equal(parseMetricValue('1.2万 次查看'), 12_000);
  assert.equal(parseMetricValue('not visible'), null);
});
