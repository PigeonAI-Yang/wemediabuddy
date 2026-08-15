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

test('chair does not revive latest-plan items when authoritative pool is empty', () => {
  const latestPlan = { items: [{ id: 'old-1', title: '上一份已终结方案' }] };
  assert.deepEqual(resolveChairDisplayItems([], null, latestPlan), []);
});

test('chair prefers non-empty pool over plans', () => {
  const pool = [poolItem('p1', '池内可批')];
  const latestPlan = { items: [{ id: 'old-1', title: '上一份可批' }] };
  const items = resolveChairDisplayItems(pool, null, latestPlan);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '池内可批');
});

test('empty current plan relies on cross-date pool instead of latest-plan fallback', () => {
  const todayPlan = { items: [], summary: '今日空方案保档' };
  const latestPlan = { items: [{ id: 'amd', title: '已终结历史方案' }] };
  assert.deepEqual(resolveChairDisplayItems([], todayPlan, latestPlan), []);
});

test('chair empty only when pool and non-empty plans are absent', () => {
  assert.deepEqual(resolveChairDisplayItems([], null, null), []);
  assert.deepEqual(resolveChairDisplayItems(null, { items: [] }, { items: [] }), []);
});
