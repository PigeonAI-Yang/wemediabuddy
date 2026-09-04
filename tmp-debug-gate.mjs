import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './src/main/db/migrations.ts';
import { listLaneGateCandidates, shouldSkipJudgment, isTier0AutoRelevantSource } from './src/main/lane-gate.ts';
import { readWorkspaceProfile } from './src/main/workspace-profiles.ts';
import { readLatestJudgeWatermark } from './src/main/agent-tasks.ts';

const db = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
const watermark = readLatestJudgeWatermark(db);
console.log('watermark', watermark);
const since = watermark ?? new Date(Date.now() - 24*3600*1000).toISOString();
console.log('since', since);
const candidates = listLaneGateCandidates(db, { since });
console.log('candidates count', candidates.length);
console.log('candidates sample', candidates.slice(0,3));
console.log('contains Wan?', candidates.some(c=>c.sourceId==='153162be-6b20-49ea-8c17-a2fc18fafe4d'));
const wanCandidate = candidates.find(c=>c.sourceId==='153162be-6b20-49ea-8c17-a2fc18fafe4d');
if (wanCandidate) console.log('wanCandidate', wanCandidate);

// Profile
const profile = readWorkspaceProfile(db);
console.log('profile intelligencePackId', profile?.intelligencePackId);

// Check shouldSkip for Wan
if (wanCandidate) {
  console.log('shouldSkip Wan', shouldSkipJudgment(db, wanCandidate.sourceId));
  console.log('isTier0 Wan', isTier0AutoRelevantSource(db, wanCandidate, profile.intelligencePackId));
}
// Check all candidates skip status
let skipped=0, auto=0, pending=0;
for (const c of candidates) {
  if (shouldSkipJudgment(db, c.sourceId)) { skipped++; continue; }
  if (isTier0AutoRelevantSource(db, c, profile.intelligencePackId)) auto++; else pending++;
}
console.log('skipped', skipped, 'auto', auto, 'pending', pending);

// Also check brief
import { assembleEditorialBrief } from './src/main/editorial-brief.ts';
const brief = assembleEditorialBrief(db, { businessDate: '2026-08-24', watermark });
console.log('brief sources', brief.increment.sources.length);
console.log('brief contains Wan', brief.increment.sources.some(s=>s.id==='153162be-6b20-49ea-8c17-a2fc18fafe4d'));
console.log('brief sources ids tail', brief.increment.sources.slice(-10).map(s=>s.id));

db.close();
