import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetricValue, xMetricEvidence, xMetricEvidenceMap, xMetricValues } from '../src/main/platforms/metric-value.ts';
import { isXListTimelineResponse } from '../src/main/platforms/x-list-primitives.ts';

test('X metric labels preserve explicit zero and localized scales', () => {
  assert.equal(parseMetricValue('0 回复。回复'), 0);
  assert.equal(parseMetricValue('3 查看'), 3);
  assert.equal(parseMetricValue('1.2万 次查看'), 12_000);
  assert.equal(parseMetricValue('not visible'), null);
});

test('X metric evidence distinguishes value, unavailable and parse failure', () => {
  assert.deepEqual(xMetricEvidence('1.2万 次查看', 'dom'), { status: 'value', value: 12_000, rawLabel: '1.2万 次查看', rawValue: '1.2万 次查看', source: 'dom' });
  assert.deepEqual(xMetricEvidence('1.2亿 次查看', 'dom').value, 120_000_000);
  assert.deepEqual(xMetricEvidence(null, 'graphql', 'views.count'), { status: 'unavailable', rawLabel: 'views.count', rawValue: null, source: 'graphql' });
  assert.deepEqual(xMetricEvidence('hidden', 'dom'), { status: 'parse_failed', rawLabel: 'hidden', rawValue: 'hidden', source: 'dom' });
  assert.equal(xMetricEvidence('foo 12', 'dom').status, 'parse_failed');
  const evidence = xMetricEvidenceMap({ replies: 0, views: '3' }, 'graphql');
  assert.deepEqual(xMetricValues(evidence), { replies: 0, reposts: null, likes: null, bookmarks: null, views: 3 });
});

test('List timeline responses require the exact GraphQL variables.listId', () => {
  const response = (listId) => `https://x.com/i/api/graphql/query/ListLatestTweetsTimeline?variables=${encodeURIComponent(JSON.stringify({ listId, count: 20 }))}`;
  assert.equal(isXListTimelineResponse(response('123'), '123'), true);
  assert.equal(isXListTimelineResponse(response('456'), '123'), false);
  assert.equal(isXListTimelineResponse('https://x.com/i/api/graphql/query/ListLatestTweetsTimeline', '123'), false);
});
