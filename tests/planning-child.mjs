import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createTopic, saveCurrentPlan } from '../src/main/planning.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-plans-'));
try {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const source = upsertSource(database, { originalUrl: 'https://example.com/source', title: 'Source' });
  const topic = createTopic(database, 'Topic');
  const item = { topicId: topic.id, title: 'Topic', priority: 1, whyNow: 'today', timeliness: 'high', targetAudience: 'builders', angle: 'test', pointOfView: 'useful', platforms: ['x'], formats: ['text'], titleGuidance: 'title', openingGuidance: 'opening', structureGuidance: 'structure', effortEstimate: '1h', sourceIds: [source.id], availableMaterials: ['official release'], missingMaterials: ['first-party test'] };
  const items = [7, 2, 0, 5, 1, 6, 3, 4].map((priority, index) => ({ ...item, title: `Grade-${priority}-${index}`, priority }));
  saveCurrentPlan(database, { planDate: '2026-07-27', timezone: 'Asia/Shanghai', summary: 'first', items });
  saveCurrentPlan(database, { planDate: '2026-07-27', timezone: 'Asia/Shanghai', summary: 'second', items });
  const current = database.prepare('SELECT summary FROM plans WHERE plan_date = ? AND is_current = 1').get('2026-07-27');
  const stored = database.prepare('SELECT available_materials_json AS available, missing_materials_json AS missing FROM plan_items WHERE plan_id = (SELECT id FROM plans WHERE plan_date = ? AND is_current = 1)').get('2026-07-27');
  const ordered = database.prepare('SELECT priority FROM plan_items WHERE plan_id = (SELECT id FROM plans WHERE plan_date = ? AND is_current = 1) ORDER BY sort_order').all('2026-07-27').map(({ priority }) => priority);
  let rejectedInvalid = false;
  try { saveCurrentPlan(database, { planDate: '2026-07-28', timezone: 'Asia/Shanghai', summary: 'invalid', items: [{ ...item, priority: 8 }] }); } catch { rejectedInvalid = true; }
  if (current.summary !== 'second' || JSON.parse(stored.available)[0] !== 'official release' || JSON.parse(stored.missing)[0] !== 'first-party test'
    || ordered.join(',') !== '0,1,2,3,4,5,6,7' || !rejectedInvalid
    || database.prepare('SELECT COUNT(*) AS count FROM plans WHERE plan_date = ? AND is_current = 1').get('2026-07-27').count !== 1) throw new Error('current plan rule failed');
  database.close();
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
