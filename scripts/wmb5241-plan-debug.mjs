// Debug: candidate plan generation with the WMB-5241 deterministic fence.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { seedRichKnowledge } from '../tests/e2e/fixture-knowledge.mjs';
import { generateKnowledgeCandidatePlan } from '../src/main/knowledge-candidates.ts';
import { getSource } from '../src/main/sources.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'wmb5241-plan-'));
const dataRoot = root;
const workspaceId = `ws-${randomUUID()}`;
(async () => {
  try {
    seedRichKnowledge(dataRoot, workspaceId);
    const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
    const source = getSource(db, db.prepare("SELECT id FROM source_items WHERE title = 'AgentForge 发布 v2：多模型路由'").get().id);
    const topic = db.prepare("SELECT id FROM topics WHERE title = 'AI Agent 工具链'").get();
    const manifest = {
      wmb_knowledge_candidates: {
        reason: 'WMB-5241 E2E 确定性模型缝',
        topicCompile: { title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由；企业版发布扩展多租户隔离与审计能力；小红书场景批量内容生成已有验证路径；路由质量评估应先跑混合样本。' },
        entities: [{ entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', excerpt: 'AgentForge v2 企业版发布，扩展多租户隔离与审计能力。', valueRationale: '官方产品身份，可独立验证。' }],
        notes: [
          { kind: 'claim', canonicalKey: 'agentforge-v2-enterprise', statement: 'AgentForge v2 企业版支持多租户隔离与审计。', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L1', excerpt: 'AgentForge v2 企业版发布，支持多租户隔离与审计。', valueRationale: '官方发布，可验证。' },
          { kind: 'claim', canonicalKey: 'agentforge-v2-audit', statement: '企业版审计日志覆盖全部路由决策。', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L1', excerpt: '企业版审计日志覆盖全部路由决策。', valueRationale: '官方发布，可验证。' }
        ]
      }
    };
    const fence = '```json\n' + JSON.stringify(manifest, null, 2) + '\n```';
    const plan = await generateKnowledgeCandidatePlan(db, {
      workspaceId, sourceId: source.id, topicId: topic.id,
      createdBy: 'background_agent', triggerSource: 'ingest', sourceNature: 'primary_source',
      modelCall: async () => fence
    });
    console.log('PLAN ok:', plan.ok);
    if (!plan.ok) console.log('PLAN error:', JSON.stringify(plan.error, null, 2));
    else console.log('PLAN notes:', plan.plan?.notes?.length, 'entities:', plan.plan?.entities?.length, 'topicCompile:', plan.plan?.topicCompile?.title);
    db.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* keep */ }
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
