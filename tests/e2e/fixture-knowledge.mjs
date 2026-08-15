// Shared knowledge fixture seeding for the five-surface E2E journeys (WMB-5243).
//
// Seeds REAL knowledge into an isolated workspace DB through the production
// pipeline (upsertSource / upsertKnowledgeTopic / compileSourceKnowledge /
// applyKnowledgeChangeSet / createTopicMaintenanceProposal) — no business code
// is modified, no second store is created. All fixtures are deterministic so
// renderer assertions can reference exact user-facing text.
//
// Usage: scenario.launch.seedFixture = async (workspace) => seedRichKnowledge(workspace.dataRoot, workspace.workspaceId)
// (the harness calls seedFixture after seedWorkspace, before the app launch).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../../src/main/db/migrations.ts';
import { upsertSource } from '../../src/main/sources.ts';
import { recordKnowledgeBatch, upsertKnowledgeTopic } from '../../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../../src/main/knowledge-compiler.ts';
import { applyKnowledgeChangeSet } from '../../src/main/knowledge-flywheel.ts';
import { createTopicMaintenanceProposal } from '../../src/main/topic-maintenance.ts';

const NOW = () => new Date().toISOString();

function csMeta(workspaceId, requestId, reason = 'E2E 种子') {
  return { workspaceId, requestId, reason, triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent' };
}

/** Open a read-write connection to the workspace DB (idempotent schema). */
export function openWorkspaceDb(dataRoot, { readOnly = false } = {}) {
  const dbPath = path.join(dataRoot, 'wmb.db');
  const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA busy_timeout = 10000');
    migrateDatabase(dbPath);
  }
  return db;
}

/**
 * Rich knowledge workspace used by topic / library / canvas journeys:
 * - Topic A「AI Agent 工具链」compiled (wiki 当前认识 + 4 知识结论 + 实体 AgentForge + 正式关系)
 * - Topic B「历史遗留主题」legacy shell（初始档案）
 * - Topic C「尚未整理主题」uncompiled（等待整理）
 * - 2 sources with knowledge digest + 1 raw source
 * Returns stable ids + exact user-facing texts for assertions.
 */
export function seedRichKnowledge(dataRoot, workspaceId) {
  const db = openWorkspaceDb(dataRoot);
  try {
    const source1 = upsertSource(db, {
      originalUrl: 'https://news.example/agentforge-v2',
      title: 'AgentForge 发布 v2：多模型路由',
      summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
      author: 'News Desk'
    });
    const topicA = upsertKnowledgeTopic(db, {
      title: 'AI Agent 工具链',
      summary: 'AgentForge v2 引入多模型路由，面向小红书场景的批量内容生成已有验证路径。'
    });
    // WMB-5243：保存资料 → 关联主题（与生产 ingest 同源链路 recordKnowledgeBatch；
    // compileSourceKnowledge 只编译已关联 Topic，fixture 必须先建 topic_source_links）。
    const link1 = recordKnowledgeBatch(db, {
      items: [{ sourceId: source1.id, topic: { title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由，面向小红书场景的批量内容生成已有验证路径。' } }]
    });
    if (link1[0]?.topicId !== topicA.id) throw new Error('source1 关联主题 A 失败');
    const compileA = compileSourceKnowledge(db, {
      workspaceId,
      sourceId: source1.id,
      sourceRevision: source1.revision,
      topicId: topicA.id,
      reason: 'E2E 种子编译 A',
      requestId: sourceCompileRequestId(source1.id, source1.revision),
      entities: [
        { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '可验证产品事实，全库复用身份' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', title: 'AgentForge v2 支持多模型路由', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', excerpt: 'AgentForge v2 ships multi-model routing.', entityKeys: ['agentforge'], valueRationale: '可验证产品事实' },
        { kind: 'method', canonicalKey: 'agentforge-router-eval', title: '多模型路由评估方法', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用方法' },
        { kind: 'claim', canonicalKey: 'agentforge-xhs-claim', title: 'AgentForge v2 小红书场景可用', statement: 'AgentForge v2 可用于小红书运营场景的批量内容生成', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-9', appliesTo: 'xiaohongshu', entityKeys: ['agentforge'], valueRationale: '平台适用事实' }
      ],
      topicCompile: {
        title: 'AI Agent 工具链',
        summary: 'AgentForge v2 引入多模型路由；面向小红书运营场景的批量内容生成已有验证路径；路由质量评估应先跑混合样本。'
      }
    });
    if (!compileA.ok) throw new Error(`compile A 失败: ${compileA.error?.message ?? 'unknown'}`);

    const source2 = upsertSource(db, {
      originalUrl: 'https://news.example/agentforge-v2-dispute',
      title: 'AgentForge v2 更新：平台限制与争议',
      summary: '后续报道对企业版开放范围与小红书依赖度提出分歧。',
      author: 'News Desk'
    });
    const link2 = recordKnowledgeBatch(db, {
      items: [{ sourceId: source2.id, topic: { title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由，面向小红书场景的批量内容生成已有验证路径。' } }]
    });
    if (link2[0]?.topicId !== topicA.id) throw new Error('source2 关联主题 A 失败');
    const compileB = compileSourceKnowledge(db, {
      workspaceId,
      sourceId: source2.id,
      sourceRevision: source2.revision,
      topicId: topicA.id,
      reason: 'E2E 种子编译 B',
      requestId: sourceCompileRequestId(source2.id, source2.revision),
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-xhs-dependence', title: '小红书对路由质量依赖度存疑', statement: '小红书场景批量内容生成对路由质量的依赖被高估', conclusionStatus: 'contradicted', evidenceLevel: 'corroborated', locator: 'L21-26', relation: 'contradicts', entityKeys: ['agentforge'], valueRationale: '可信来源实质分歧' }
      ],
      topicCompile: {
        title: 'AI Agent 工具链',
        summary: 'AgentForge v2 引入多模型路由；面向小红书运营场景的批量内容生成已有验证路径；路由质量评估应先跑混合样本。'
      }
    });
    if (!compileB.ok) throw new Error(`compile B 失败: ${compileB.error?.message ?? 'unknown'}`);

    const entityRow = db.prepare("SELECT id FROM knowledge_entities WHERE canonical_key = 'agentforge'").get();
    const entityId = String(entityRow.id);
    const noteIds = {};
    for (const key of ['agentforge-v2-multi-router', 'agentforge-router-eval', 'agentforge-xhs-claim', 'agentforge-xhs-dependence']) {
      const row = db.prepare('SELECT id FROM knowledge_notes WHERE canonical_key = ?').get(key);
      noteIds[key] = String(row.id);
    }

    // 正式关系（端点均为可见节点）：about（note→entity）、applies_to（note→topic）、contradicts（note→note）。
    applyKnowledgeChangeSet(db, csMeta(workspaceId, 'e2e-seed-relations', 'E2E 种子正式关系'), {
      relations: [
        { op: 'create', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: noteIds['agentforge-v2-multi-router'], toObjectType: 'knowledge_entity', toObjectId: entityId },
        { op: 'create', scope: 'global', relationKey: 'applies_to', fromObjectType: 'knowledge_note', fromObjectId: noteIds['agentforge-xhs-claim'], toObjectType: 'topic', toObjectId: topicA.id },
        { op: 'create', scope: 'global', relationKey: 'contradicts', fromObjectType: 'knowledge_note', fromObjectId: noteIds['agentforge-xhs-dependence'], toObjectType: 'knowledge_note', toObjectId: noteIds['agentforge-xhs-claim'] }
      ],
      receipts: [{ triggerType: 'ingest', requestId: 'e2e-seed-relations', summary: 'E2E 种子关系已建立', counts: { relations: 3 } }]
    });

    // legacy shell 主题：初始档案（migration 版本 + 零采纳，诚实三态）。
    const topicB = upsertKnowledgeTopic(db, { title: '历史遗留主题', summary: '由旧资料迁移建立的初始档案。' });
    applyKnowledgeChangeSet(db, csMeta(workspaceId, 'e2e-seed-legacy-shell', 'E2E 种子 legacy shell'), {
      wikiPages: [{
        id: 'page-e2e-legacy-shell', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-e2e-legacy-shell',
        subjectType: 'topic', subjectId: topicB.id, compileStatus: 'current', compileNote: '历史初始化（legacy migration）',
        version: {
          title: '主题档案初始化',
          body: { kind: 'topic-wiki', migration: true, title: '主题档案初始化', summary: '历史遗留初始化', keyConclusions: [], retainedDisputes: [], recentChanges: [] },
          adoptedNoteVersionIds: [], flags: ['migration'], compileReason: 'legacy migration（历史初始化）', changeSummary: '历史初始化'
        }
      }],
      receipts: [{ triggerType: 'migration', requestId: 'e2e-seed-legacy-shell', summary: 'E2E legacy shell 已建立', counts: { wikiPages: 1 } }]
    });

    // uncompiled 主题：仅有 topics 行，无 wiki → 等待整理。
    const topicC = upsertKnowledgeTopic(db, { title: '尚未整理主题', summary: null });

    // 第三条 raw source（无知识编译）。
    const source3 = upsertSource(db, {
      originalUrl: 'https://news.example/raw-memo',
      title: '行业圆桌速记：AI 工具选型',
      summary: '一份尚未进入知识编译的原始资料。',
      author: 'E2E'
    });

    return {
      workspaceId,
      topicA: { id: topicA.id, title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由，面向小红书场景的批量内容生成已有验证路径。' },
      topicB: { id: topicB.id, title: '历史遗留主题' },
      topicC: { id: topicC.id, title: '尚未整理主题' },
      entityId,
      entityName: 'AgentForge',
      noteIds,
      noteTitles: {
        'agentforge-v2-multi-router': 'AgentForge v2 支持多模型路由',
        'agentforge-router-eval': '多模型路由评估方法',
        'agentforge-xhs-claim': 'AgentForge v2 小红书场景可用',
        'agentforge-xhs-dependence': '小红书对路由质量依赖度存疑'
      },
      wikiSummary: 'AgentForge v2 引入多模型路由；面向小红书运营场景的批量内容生成已有验证路径；路由质量评估应先跑混合样本。',
      source1: { id: source1.id, title: 'AgentForge 发布 v2：多模型路由' },
      source2: { id: source2.id, title: 'AgentForge v2 更新：平台限制与争议' },
      source3: { id: source3.id, title: '行业圆桌速记：AI 工具选型' }
    };
  } finally {
    db.close();
  }
}

/**
 * Context-budget fixture for CV-008: one compiled topic + 20 long knowledge
 * notes (≈2.8k chars each) + 1 entity. A full selection far exceeds the
 * 30000-char package cap, so the UI must report 超限/未纳入 instead of
 * silently swapping to the whole graph.
 */
export function seedLongNotes(dataRoot, workspaceId) {
  const db = openWorkspaceDb(dataRoot);
  try {
    const source = upsertSource(db, {
      originalUrl: 'https://news.example/budget-stress',
      title: '上下文压力测试来源',
      summary: '用于验证框选上下文预算边界的来源。',
      author: 'E2E'
    });
    const topic = upsertKnowledgeTopic(db, { title: '上下文压力主题', summary: '长文本知识结论用于验证有界选择包。' });
    const notes = [];
    for (let i = 1; i <= 20; i += 1) {
      notes.push({
        kind: 'claim',
        canonicalKey: `budget-note-${i}`,
        title: `预算测试知识结论 ${i}`,
        statement: `预算测试知识结论 ${i}：${'长文本内容用于撑大冻结正文包，'.repeat(120)}（编号 ${i}）`,
        conclusionStatus: 'supported',
        evidenceLevel: 'single',
        locator: `L${i}-${i + 1}`,
        excerpt: `预算测试摘录 ${i}。`,
        valueRationale: '上下文预算边界验证'
      });
    }
    const result = compileSourceKnowledge(db, {
      workspaceId,
      sourceId: source.id,
      sourceRevision: source.revision,
      topicId: topic.id,
      reason: 'E2E 预算压力种子',
      requestId: sourceCompileRequestId(source.id, source.revision),
      notes,
      topicCompile: { title: '上下文压力主题', summary: '已沉淀 20 条长文本知识结论用于预算验证。' }
    });
    if (!result.ok) throw new Error(`budget compile 失败: ${result.error?.message ?? 'unknown'}`);
    const ids = db.prepare("SELECT id FROM knowledge_notes WHERE canonical_key LIKE 'budget-note-%' ORDER BY canonical_key").all().map((row) => String(row.id));
    return { topicId: topic.id, noteIds: ids, nodeCount: ids.length + 1 };
  } finally {
    db.close();
  }
}

/** One open health issue attached to a knowledge note (library 知识健康 tab). */
export function seedHealthIssue(dataRoot, workspaceId, noteId) {
  const db = openWorkspaceDb(dataRoot);
  try {
    applyKnowledgeChangeSet(db, csMeta(workspaceId, 'e2e-seed-health', 'E2E 种子健康问题'), {
      healthIssues: [{
        op: 'create', id: 'health-e2e-stale-claim', scope: 'global', issueType: 'stale_claim',
        affectedObjectType: 'knowledge_note', affectedObjectId: noteId, severity: 'medium',
        suggestedAction: '重新核验该主张的时效性。'
      }],
      receipts: [{ triggerType: 'ingest', requestId: 'e2e-seed-health', summary: 'E2E 健康问题已建立', counts: { healthIssues: 1 } }]
    });
    return { issueId: 'health-e2e-stale-claim', severity: 'medium', issueType: 'stale_claim' };
  } finally {
    db.close();
  }
}

/** One pending topic-maintenance proposal (整理台账 待批卡). */
export function seedProposal(dataRoot, workspaceId, topicId, topicTitle) {
  const db = openWorkspaceDb(dataRoot);
  try {
    const proposal = createTopicMaintenanceProposal(db, {
      taskId: null,
      title: '整理建议：更新 AI Agent 工具链当前认识',
      reason: 'E2E 种子提案：基于新资料更新主题摘要。',
      changes: [{
        kind: 'update', topicId,
        after: { title: topicTitle, summary: '更新后的当前认识：多模型路由 + 小红书验证路径（E2E）。', status: 'active' }
      }]
    });
    return { proposalId: proposal.id, status: proposal.status };
  } finally {
    db.close();
  }
}

/**
 * Seed two Pi conversations (+ index) into the data root so the Pi dock has
 * local history without any provider call (PI-005 会话管理).
 */
export function seedPiSessions(dataRoot) {
  const conversationsDir = path.join(dataRoot, 'pi-agent', 'conversations');
  const sessionsDir = path.join(dataRoot, 'pi-agent', 'sessions');
  mkdirSync(conversationsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const now = NOW();
  const convA = {
    id: 'e2e-conv-a',
    title: 'E2E 会话甲',
    sessionFile: path.join(sessionsDir, 'e2e-conv-a.jsonl'),
    sessionId: null,
    messages: [
      { role: 'user', text: '帮我整理今日 AI 热点', createdAt: now },
      { role: 'assistant', text: '已整理 3 条热点：AgentForge v2、多模型路由、小红书场景验证。', createdAt: now }
    ],
    createdAt: now,
    updatedAt: now
  };
  const convB = {
    id: 'e2e-conv-b',
    title: 'E2E 会话乙',
    sessionFile: path.join(sessionsDir, 'e2e-conv-b.jsonl'),
    sessionId: null,
    messages: [
      { role: 'user', text: '上一轮结论是什么', createdAt: now }
    ],
    createdAt: now,
    updatedAt: now
  };
  writeFileSync(path.join(conversationsDir, 'e2e-conv-a.json'), `${JSON.stringify(convA, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(conversationsDir, 'e2e-conv-b.json'), `${JSON.stringify(convB, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(conversationsDir, 'index.json'), `${JSON.stringify({
    activeId: 'e2e-conv-a',
    conversations: [
      { id: 'e2e-conv-a', title: 'E2E 会话甲', preview: '已整理 3 条热点：AgentForge v2、多模型路由、小红书场景验证。', createdAt: now, updatedAt: now, archivedAt: null },
      { id: 'e2e-conv-b', title: 'E2E 会话乙', preview: '上一轮结论是什么', createdAt: now, updatedAt: now, archivedAt: null }
    ]
  }, null, 2)}\n`, 'utf8');
  return { activeId: 'e2e-conv-a', titles: ['E2E 会话甲', 'E2E 会话乙'] };
}
