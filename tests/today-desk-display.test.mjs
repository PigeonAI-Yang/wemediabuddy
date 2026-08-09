import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChairDisplayItems } from '../src/renderer/today-pool-view.ts';

function poolItem(id, title) {
  return {
    planItemId: id,
    planDate: '2026-08-07',
    title,
    priority: 1,
    timeliness: '热点',
    timelinessClass: 'hot',
    expiresAt: null,
    topicId: null,
    sourceIds: [],
    whyNow: 'why',
    angle: 'angle',
    pointOfView: 'pov',
    targetAudience: 'aud',
    platforms: ['x'],
    formats: ['text'],
    titleGuidance: 't',
    openingGuidance: 'o',
    structureGuidance: 's',
    effortEstimate: '30m',
    availableMaterials: [],
    missingMaterials: [],
    trendEvidence: [],
    createdAt: '2026-08-07T00:00:00.000Z',
    isNew: false,
    demotion: null
  };
}

test('chair keeps latest non-empty plan when pool is empty array', () => {
  const latestPlan = { items: [{ id: 'old-1', title: '上一份可批' }] };
  const items = resolveChairDisplayItems([], null, latestPlan);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '上一份可批');
});

test('chair prefers non-empty pool over plans', () => {
  const pool = [poolItem('p1', '池内可批')];
  const latestPlan = { items: [{ id: 'old-1', title: '上一份可批' }] };
  const items = resolveChairDisplayItems(pool, null, latestPlan);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '池内可批');
});

test('empty current plan does not blank chair when latest non-empty exists', () => {
  const todayPlan = { items: [], summary: '今日空方案保档' };
  const latestPlan = { items: [{ id: 'amd', title: 'AMD 收购 Taalas' }] };
  const items = resolveChairDisplayItems([], todayPlan, latestPlan);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'AMD 收购 Taalas');
});

test('chair empty only when pool and non-empty plans are absent', () => {
  assert.deepEqual(resolveChairDisplayItems([], null, null), []);
  assert.deepEqual(resolveChairDisplayItems(null, { items: [] }, { items: [] }), []);
});
