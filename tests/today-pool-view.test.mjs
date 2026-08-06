import assert from 'node:assert/strict';
import test from 'node:test';
import { poolBadges, poolBadgeClass, poolItemToPlanItem } from '../src/renderer/today-pool-view.ts';

const NOW = Date.parse('2026-08-05T06:00:00.000Z');
const base = {
  planItemId: 'pi-1',
  planDate: '2026-08-05',
  title: '池内机会',
  priority: 1,
  timeliness: '爆点 24 小时',
  timelinessClass: 'breaking',
  expiresAt: '2026-08-05T10:00:00.000Z',
  topicId: null,
  sourceIds: ['s1'],
  whyNow: '为什么是现在',
  angle: '角度',
  pointOfView: '观点',
  targetAudience: '受众',
  platforms: ['x'],
  formats: ['text'],
  titleGuidance: '标题',
  openingGuidance: '开头',
  structureGuidance: '结构',
  effortEstimate: '30m',
  availableMaterials: [],
  missingMaterials: [],
  trendEvidence: [],
  createdAt: '2026-08-05T05:00:00.000Z',
  isNew: true,
  demotion: null
};

test('poolItemToPlanItem maps planItemId to id and carries full fields', () => {
  const item = poolItemToPlanItem(base);
  assert.equal(item.id, 'pi-1');
  assert.equal(item.title, '池内机会');
  assert.equal(item.timeliness, '爆点 24 小时');
  assert.deepEqual(item.platforms, ['x']);
  assert.equal(item.titleGuidance, '标题');
  assert.deepEqual(item.sourceIds, ['s1']);
});

test('poolBadges emits new, class, countdown and demotion annotations', () => {
  const badges = poolBadges(base, NOW);
  assert.deepEqual(badges.map((badge) => badge.text), ['新', '爆点', '还剩 ~4h']);

  const demoted = poolBadges({ ...base, isNew: false, demotion: { publishedAt: '2026-08-05T04:00:00.000Z', platform: 'x' } }, NOW);
  assert.deepEqual(demoted.map((badge) => badge.text), ['爆点', '还剩 ~4h', '刚发布过同主题']);

  const evergreen = poolBadges({ ...base, isNew: false, timelinessClass: 'evergreen', expiresAt: null }, NOW);
  assert.deepEqual(evergreen.map((badge) => badge.text), ['长青']);

  const minutes = poolBadges({ ...base, isNew: false, expiresAt: '2026-08-05T06:30:00.000Z' }, NOW);
  assert.deepEqual(minutes.map((badge) => badge.text), ['爆点', '还剩 ~30m']);

  const past = poolBadges({ ...base, isNew: false, expiresAt: '2026-08-05T05:00:00.000Z' }, NOW);
  assert.deepEqual(past.map((badge) => badge.text), ['爆点'], 'past expiry renders no countdown');
});

test('poolBadgeClass maps badge kinds to pill tones', () => {
  assert.equal(poolBadgeClass({ kind: 'new', text: '新' }), 'pool-new');
  assert.equal(poolBadgeClass({ kind: 'timeliness', text: '爆点', tone: 'breaking' }), 'pool-breaking');
  assert.equal(poolBadgeClass({ kind: 'timeliness', text: '长青', tone: 'evergreen' }), 'pool-evergreen');
  assert.equal(poolBadgeClass({ kind: 'demotion', text: '刚发布过同主题' }), 'pool-demotion');
  assert.equal(poolBadgeClass({ kind: 'expiry', text: '还剩 ~4h' }), 'gray');
});
