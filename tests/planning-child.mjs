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
  saveCurrentPlan(database, { planDate: '2026-07-27', timezone: 'Asia/Shanghai', summary: 'first', items: [item] });
  saveCurrentPlan(database, { planDate: '2026-07-27', timezone: 'Asia/Shanghai', summary: 'second', items: [item] });
  const current = database.prepare('SELECT summary FROM plans WHERE plan_date = ? AND is_current = 1').get('2026-07-27');
  const stored = database.prepare('SELECT available_materials_json AS available, missing_materials_json AS missing FROM plan_items WHERE plan_id = (SELECT id FROM plans WHERE plan_date = ? AND is_current = 1)').get('2026-07-27');
  if (current.summary !== 'second' || JSON.parse(stored.available)[0] !== 'official release' || JSON.parse(stored.missing)[0] !== 'first-party test'
    || database.prepare('SELECT COUNT(*) AS count FROM plans WHERE plan_date = ? AND is_current = 1').get('2026-07-27').count !== 1) throw new Error('current plan rule failed');
  database.close();
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
