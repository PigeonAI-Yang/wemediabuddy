import { mkdtemp, rm } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts'; import { upsertSource } from '../src/main/sources.ts'; import { saveCurrentPlan } from '../src/main/planning.ts'; import { getToday } from '../src/main/workbench.ts'; import { createProjectFromPlanItem, getStudio } from '../src/main/content.ts';
const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-today-'));
let db;
try {
  db = migrateDatabase(path.join(directory, 'wmb.db'));
  const businessDate = '2026-07-27';
  const source = upsertSource(db, { originalUrl: 'https://example.com', title: 'Source', summary: 'Summary source', categories: ['官方发布'], priority: 2 });
  db.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run(`${businessDate}T12:00:00.000+08:00`, source.id);
  const item = { title: 'Plan', priority: 1, whyNow: 'now', timeliness: 'high', targetAudience: 'all', angle: 'angle', pointOfView: 'view', platforms: ['x'], formats: ['text'], titleGuidance: 't', openingGuidance: 'o', structureGuidance: 's', effortEstimate: '1h', sourceIds: [source.id], availableMaterials: ['release'], missingMaterials: ['test'] };
  saveCurrentPlan(db, { planDate: businessDate, timezone: 'Asia/Shanghai', summary: 'Summary', items: [item] });
  const today = getToday(db, businessDate);
  const planItem = today.plan?.items[0];
  if (today.sources[0]?.summary !== 'Summary source' || today.sources[0]?.categories[0] !== '官方发布' || planItem?.pointOfView !== 'view' || planItem.platforms[0] !== 'x' || planItem.availableMaterials[0] !== 'release' || planItem.missingMaterials[0] !== 'test') throw new Error('Rich Today readback mismatch');
  const first = createProjectFromPlanItem(db, planItem.id);
  const replay = createProjectFromPlanItem(db, planItem.id);
  const studio = getStudio(db);
  if (!first.created || replay.created || first.id !== replay.id || studio[0]?.revisions[0]?.number !== 1) throw new Error('Plan-to-project mismatch');
} finally {
  db?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
