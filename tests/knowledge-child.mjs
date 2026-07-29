import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getKnowledgeContext, listKnowledgeSources, recordKnowledgeBatch, updateKnowledgeSource } from '../src/main/knowledge.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-knowledge-'));
try {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const ids = [];
  for (let index = 0; index < 250; index += 1) {
    ids.push(upsertSource(database, { originalUrl: `https://example.com/${index}`, title: `资料 ${index}`, priority: index === 0 ? 0 : 4 }).id);
  }
  const firstPage = listKnowledgeSources(database, { limit: 100 });
  const thirdPage = listKnowledgeSources(database, { limit: 100, offset: 200 });
  if (firstPage.total !== 250 || firstPage.items.length !== 100 || !firstPage.hasMore || thirdPage.items.length !== 50 || thirdPage.hasMore) throw new Error('pagination failed');

  const state = updateKnowledgeSource(database, { id: ids[0], expectedRevision: 1, verificationStatus: 'verified', managementStatus: 'watching' });
  let staleRejected = false;
  try { updateKnowledgeSource(database, { id: ids[0], expectedRevision: 1, managementStatus: 'archived' }); } catch (error) { staleRejected = String(error).includes('REVISION_CONFLICT'); }
  if (state.revision !== 2 || !staleRejected) throw new Error('dual state concurrency failed');

  const recorded = recordKnowledgeBatch(database, { items: [{ sourceId: ids[0], topic: { canonicalKey: 'openai-agents', title: 'OpenAI Agents' }, relation: 'primary' }] });
  const replay = recordKnowledgeBatch(database, { items: [{ sourceId: ids[0], topic: { canonicalKey: 'OPENAI-AGENTS', title: 'OpenAI Agents' }, relation: 'primary' }] });
  if (recorded[0].topicId !== replay[0].topicId || database.prepare('SELECT count(*) AS count FROM topic_source_links').get().count !== 1) throw new Error('topic idempotency failed');

  saveCurrentPlan(database, { planDate: '2026-07-28', timezone: 'Asia/Shanghai', summary: '历史机会', items: [{
    topicId: recorded[0].topicId, title: '历史机会', priority: 0, whyNow: '现在', timeliness: '高', targetAudience: 'AI 用户',
    angle: '实践', pointOfView: '可用', platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头',
    structureGuidance: '结构', effortEstimate: '1h', sourceIds: [ids[0]]
  }] });
  const context = getKnowledgeContext(database, { sourceId: ids[0] });
  if (context.topics.length !== 1 || context.sources.length !== 1 || context.opportunities.length !== 1) throw new Error('historical context failed');
  database.close();
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
