import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './src/main/db/migrations.ts';
import { createTopicMaintenanceProposal, decideTopicMaintenanceProposal } from './src/main/topic-maintenance.ts';
import { listFermentingBundle } from './src/main/ferment.ts';

const dbPath = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const db = migrateDatabase(dbPath);
console.log('DB opened', dbPath);

const five = [
  '0b67447d-5425-4280-af44-5732c0ba48f7',
  'd8aa99fb-e4bc-42a4-aa74-300d83031770',
  'e68eef71-d679-4aec-b191-6864f2dbbdf0',
  '5b29648f-a117-44a5-8c75-415a9cc035d8',
  'd809d856-520a-46db-8189-3d9dd1756d50',
];

console.log('=== Before: verify five topics exist and are active ===');
for (const id of five) {
  const t = db.prepare('SELECT id, title, status, revision FROM topics WHERE id=?').get(id);
  console.log(id.slice(0,8), t?.title?.slice(0,20), t?.status, 'rev', t?.revision);
  const pis = db.prepare('SELECT id, planning_status, score_reasons_json FROM plan_items WHERE topic_id=?').all(id);
  console.log('  plan_items:', pis.map(p=> `${p.planning_status}:${JSON.parse(p.score_reasons_json)?.status || 'no-status'}`).join(', '));
}

const bundleBefore = listFermentingBundle(db, '2026-08-25');
console.log('\n=== Fermenting before (should contain 5) ===');
console.log('items', bundleBefore.items.map(i=>i.title));
console.log('count', bundleBefore.items.length, 'watching', bundleBefore.watchingItems.length);
console.log('topics summary', bundleBefore.topics.map(t=>t.title));

console.log('\n=== Creating archive proposal for 5 topics ===');
const proposal = createTopicMaintenanceProposal(db, {
  title: '持续关注治理：归档 5 个未达传播评分的草案衍生主题',
  reason: '五条主题仅来源于 draft/unscored plan_items（无 approved+scored 传播评分），按契约 A 需经可逆归档过渡；保留全部历史记录与关联，仅从持续关注投影移除。通过既有 topic_maintenance_proposals 冻结审计链，永不硬删。',
  changes: five.map(topicId=> ({ kind:'archive', topicId }))
});
console.log('proposal created', proposal.id, 'status', proposal.status, 'rev', proposal.revision);
console.log('changes', JSON.stringify(proposal.changes, null, 2));

console.log('\n=== Approving proposal (domain command) ===');
const decided = decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision:'approve' });
console.log('decided status', decided.status, 'rev', decided.revision);

console.log('\n=== After: verify five topics archived but preserved ===');
for (const id of five) {
  const t = db.prepare('SELECT id, title, status, revision FROM topics WHERE id=?').get(id);
  console.log(id.slice(0,8), t?.title?.slice(0,20), t?.status, 'rev', t?.revision);
  // ensure record still exists
  if (!t) console.error('ERROR: topic missing after archive (deleted)!');
}

const bundleAfter = listFermentingBundle(db, '2026-08-25');
console.log('\n=== Fermenting after (should NOT contain 5) ===');
console.log('items', bundleAfter.items.map(i=>i.title));
console.log('count', bundleAfter.items.length);
console.log('topics summary', bundleAfter.topics.map(t=>t.title));
const stillHasFive = bundleAfter.items.some(i=> five.includes(i.topicId)) || bundleAfter.topics.some(t=> five.includes(t.topicId));
console.log('stillHasFive?', stillHasFive ? 'FAIL - still contains' : 'PASS - removed');

console.log('\n=== Readback: other Today content preserved (sources, plans) ===');
const dayStart = new Date('2026-08-25T00:00:00.000+08:00').toISOString();
const dayEnd = new Date('2026-08-25T23:59:59.999+08:00').toISOString();
// Check sources count
const srcCount = db.prepare(`SELECT COUNT(*) as c FROM source_items WHERE management_status != 'archived' AND collected_at >= ? AND collected_at <= ?`).get(dayStart, dayEnd);
console.log('sources today', srcCount.c);
const plan = db.prepare(`SELECT id FROM plans WHERE plan_date='2026-08-25' AND is_current=1`).get();
console.log('current plan exists', !!plan);

db.close();
console.log('\nDONE');
