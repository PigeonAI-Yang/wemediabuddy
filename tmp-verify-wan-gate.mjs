import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { migrateDatabase } from './src/main/db/migrations.ts';
import { readLatestJudgeWatermark, getAgentTask } from './src/main/agent-tasks.ts';
import { buildDailyGateRun } from './src/main/agent-runner.ts';
import { assembleEditorialBrief } from './src/main/editorial-brief.ts';

const dbPath = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const db = migrateDatabase(dbPath);
const watermark = readLatestJudgeWatermark(db);
console.log('recoveredWatermark', watermark);
const trusted = '2026-08-23T17:58:50.209Z';
console.log('matches trusted?', watermark === trusted);

// Simulate a new task for gate run
// Create a temp task object with businessDate 2026-08-24
const fakeTask = {
  id: 'test-gate-'+Date.now(),
  businessDate: '2026-08-24',
  checkpoint: {}, // no watermark, so resolve will use readLatest
  intent: 'daily_judge'
};
const gateRun = buildDailyGateRun(db, fakeTask);
console.log('gateRun lane', gateRun.lane);
console.log('autoRelevant count', gateRun.autoRelevant.length);
console.log('pending count', gateRun.pending.length);
const allIds = [...gateRun.autoRelevant.map(c=>c.sourceId), ...gateRun.pending.map(c=>c.sourceId)];
console.log('contains Wan 153162be?', allIds.includes('153162be-6b20-49ea-8c17-a2fc18fafe4d'));
console.log('autoRelevant ids sample', gateRun.autoRelevant.slice(0,5).map(c=>c.sourceId));
console.log('pending ids sample', gateRun.pending.slice(0,5).map(c=>c.sourceId));

// Also check editorial brief increment
const brief = assembleEditorialBrief(db, { businessDate: '2026-08-24', watermark });
console.log('brief increment since', brief.increment.since);
console.log('brief watermark', brief.increment.watermark);
console.log('brief sources count', brief.increment.sources.length);
console.log('brief contains Wan?', brief.increment.sources.some(s=>s.id==='153162be-6b20-49ea-8c17-a2fc18fafe4d'));
console.log('brief truncated', brief.increment.truncated);
console.log('brief sources ids', brief.increment.sources.map(s=>s.id).slice(0,10));

db.close();
