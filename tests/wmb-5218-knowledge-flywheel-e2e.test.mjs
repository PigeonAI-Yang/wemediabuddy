/**
 * WMB-5218 最终集成验收（本 worker：BuildKnowledgeFlywheelE2E）。
 *
 * 单一可清理真实 SQLite workspace fixture，按顺序跑通飞轮全链路 A–F + 附加边界：
 *   A. Ingest：新 Source 编译命中 Topic/Entity，新 Claim + 旧 Method qualify + 可信争议，
 *      Wiki+Receipt，知识进入选题上下文（getKnowledgeContext + 选题上下文包）；
 *   B. Query：冻结读取版本（服务端存在性校验），新 Synthesis 写回（derived_from 只指向冻结集），
 *      同问幂等（duplicate 零写）；知识更新后冻结版本不回读未来（不可变）；
 *   C. Creation：Topic 提案→创作简报→核心版本→平台版本全程 usage 包固定同一 Wiki 版本；
 *      平台换基（事实变化）拒绝保存且零变更；
 *   D. Publication/Metric/final Review：结果回流恰好一次（case 观察 Note + review/publication/
 *      metric_snapshot 证据 + review 回执 + Topic Wiki 同 ChangeSet 重编译立即可见），
 *      零因果 Method/pattern，重放零增量；
 *   E. Health Lint：stale/broken/conflict/duplicate 候选 —— broken relation 自动原子修复、
 *      可信冲突 open 不自动裁决、重复扫描去重、周期 Lint checkpoint 崩溃恢复续跑；
 *   F. Store：并发 beforeRevision 首成第二零写冲突、restore 追加版本、弱 Source 零 Note；
 *   G. 边界：所有 ID/链不丢（join 完整性）、单 Topic 单 Wiki、data-root A/B 隔离、
 *      Canvas 删除不删正式对象、不可变版本、生产 dispatcher 写路径 + write-guard。
 *
 * 全部复用真实 migrations / store / compiler / query-writeback / usage 链 /
 * outcome-feedback / health lint API，不复制实现逻辑；只读回真实数据库行。
 * 运行：node --test tests/wmb-5218-knowledge-flywheel-e2e.test.mjs
 * 证据：.ai/wmb-5218-e2e-evidence.md（每场景对象/版本/receipt/issue 读回摘要）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic, getKnowledgeContext } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import {
  applyKnowledgeChangeSet, getChangeSet, getHealthIssue, getKnowledgeFreeNote, getKnowledgeNote, getKnowledgeNoteVersion,
  getQueryArtifactByRequest, getUpdateReceiptByRequest, getWikiPage, getWikiPageVersion,
  listHealthIssues, listKnowledgeEntities, listKnowledgeEvidenceLinks, listKnowledgeNoteVersions,
  listWikiPages, KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND
} from '../src/main/knowledge-flywheel.ts';
import { getQueryWritebackSummary, writebackQueryKnowledge } from '../src/main/query-writeback.ts';
import { knowledgeQueryWritebackRequestId } from '../src/shared/knowledge-flywheel.ts';
import {
  createContentProjectWithVersion, saveCoreVersion, savePlatformVersion
} from '../src/main/content.ts';
import { createTopicMaintenanceProposal } from '../src/main/topic-maintenance.ts';
import {
  addKnowledgeCanvasNode, createCreativeBrief, createKnowledgeCanvas, createKnowledgeContextPackage,
  removeKnowledgeCanvasNode, getKnowledgeCanvasProjection
} from '../src/main/knowledge-canvas.ts';
import { createPublication } from '../src/main/publishing.ts';
import { savePublicationMetricSnapshot } from '../src/main/metrics.ts';
import { saveReview } from '../src/main/reviews.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { getKnowledgeUsagePackageByRequest, listKnowledgeUsageRecords } from '../src/main/knowledge-usage.ts';
import { readPublicationTimeUsage, recordCreativeBriefUsage, usageRequestId } from '../src/main/knowledge-usage-integration.ts';
import { flowBackOutcome, outcomeFeedbackRequestId } from '../src/main/outcome-feedback.ts';
import {
  beginPeriodicLint, cancelPeriodicLint, getPeriodicLintCheckpoint, runLocalLint, runPeriodicLintStep
} from '../src/main/knowledge-health.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';

const WS = 'ws-a';
const NOW = () => new Date().toISOString();

function csMeta(requestId, reason = '测试', extra = {}) {
  return { workspaceId: WS, requestId, reason, triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent', ...extra };
}
function count(database, table, where = '', args = []) {
  return Number(database.prepare(`SELECT count(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...args).c);
}
function countWhere(database, table, where, ...args) { return count(database, table, where, args); }
function packageOf(database, stage, objectId) {
  return getKnowledgeUsagePackageByRequest(database, WS, usageRequestId(stage, objectId));
}
function expectThrowsCode(label, fn, code) {
  try { fn(); } catch (error) {
    if (code) {
      assert.equal(String(error?.code ?? ''), code, `${label} 期望错误码 ${code}，实际 ${error?.code ?? error?.message}`);
    }
    return error;
  }
  throw new Error(`${label} — 未抛出 ${code ?? '错误'}`);
}

test('WMB-5218 knowledge flywheel E2E: A–F + boundaries (single real SQLite workspace fixture)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5218-e2e-'));
  const summary = { workspaceFixture: 'single real SQLite workspace (temp, cleaned at end)', scenarios: {} };
  let database;
  try {
    database = migrateDatabase(path.join(root, 'wmb.db'));
    database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)").run(WS, NOW(), NOW());

    // ===================================================================
    // A. Ingest：新 Source → Topic/Entity 命中 + 新 Claim + 旧 Method qualify
    //    + 可信争议 + Wiki/Receipt + 进入选题上下文
    // ===================================================================
    const source = upsertSource(database, {
      originalUrl: 'https://news.example/agentforge-v2',
      title: 'AgentForge 发布 v2：多模型路由',
      summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
      author: 'News Desk'
    });
    const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
    assert.ok(source.id && topic.id, '真实 Source/Topic 已保存');

    const planA = {
      workspaceId: WS, sourceId: source.id, sourceRevision: source.revision, topicId: topic.id,
      reason: '摄取 AgentForge v2 发布资料（首次）',
      topicCompile: { summary: 'AI Agent 工具链主题编译' },
      entities: [{ entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', aliases: ['AF'], valueRationale: '产品发布主体，选型判断与创作复用' }],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', excerpt: 'AgentForge v2 ships multi-model routing.', entityKeys: ['agentforge'], valueRationale: '可验证产品事实，影响工具选择' },
        { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用的选型/创作方法' }
      ]
    };
    const a = compileSourceKnowledge(database, { ...planA, requestId: sourceCompileRequestId(source.id, source.revision) });
    assert.equal(a.ok, true, 'A 首次编译 ok');
    assert.equal(a.replay, false, 'A 首次非重放');
    assert.equal(a.counts.entitiesCreated, 1, 'A Entity 新建 1');
    assert.equal(a.counts.notesCreated, 2, 'A Note 新建 2');
    assert.equal(a.counts.noteVersionsCreated, 2, 'A 版本 2');
    assert.equal(a.counts.evidenceLinks, 2, 'A 证据 2');
    assert.equal(a.counts.wikiPagesCompiled, 1, 'A Wiki 重编译 1');
    assert.equal(a.receipt?.triggerType, 'ingest', 'A 回执 triggerType=ingest');
    assert.deepEqual(a.receipt?.affectedTopics, [topic.id], 'A 回执受影响 Topic 恰为关联 Topic');

    const entityList = listKnowledgeEntities(database, { scope: 'global' });
    assert.equal(entityList.items.length, 1, 'A Entity 恰一个');
    assert.equal(entityList.items[0].canonicalKey, 'agentforge', 'A Entity agentforge');
    const entityId = entityList.items[0].id;
    const claimV1 = getKnowledgeNote(database, a.noteIds['agentforge-v2-multi-router']);
    assert.equal(claimV1.version.statement, 'AgentForge v2 支持多模型路由', 'A Claim 落库');
    assert.ok(claimV1.version.adoptedEntityIds.includes(entityId), 'A Claim 采用 Entity');
    assert.ok(claimV1.version.adoptedTopicIds.includes(topic.id), 'A Claim 采用 Topic');
    assert.equal(getKnowledgeNote(database, a.noteIds['agentforge-router-eval']).note.kind, 'method', 'A Method kind=method');
    const evA = listKnowledgeEvidenceLinks(database, { noteVersionId: claimV1.version.id }).items;
    assert.equal(evA.length, 1, 'A 证据 1 条');
    assert.equal(evA[0].locator, 'L12-18', 'A 证据 locator');
    assert.equal(evA[0].evidenceObjectId, source.id, 'A 证据指向 Source');
    assert.equal(evA[0].relation, 'supports', 'A 证据 supports');

    const topicPagesA = listWikiPages(database, { scope: 'global', pageType: 'topic' });
    assert.equal(topicPagesA.items.length, 1, 'A 唯一 Topic Wiki 页');
    assert.equal(topicPagesA.items[0].subjectId, topic.id, 'A Wiki 属于 Topic');
    assert.equal(topicPagesA.items[0].compileStatus, 'current', 'A Wiki current');
    const pageA = getWikiPage(database, topicPagesA.items[0].id);
    const wikiV1Id = pageA.version.id;
    assert.equal(pageA.version.adoptedNoteVersionIds.length, 2, 'A Wiki 采纳 2 Note 版本');
    assert.equal(pageA.version.body.kind, 'topic-wiki', 'A Wiki 正文 topic-wiki');
    assert.equal(pageA.version.body.keyConclusions.length, 2, 'A Wiki keyConclusions 2');
    assert.equal(pageA.version.body.retainedDisputes.length, 0, 'A 无争议');

    // 二次摄取：新 Claim + 旧 Method qualify + 旧 Claim 可信争议 → Wiki V2
    const sourceV2 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 更新：平台限制与争议' });
    assert.equal(sourceV2.id, source.id, 'A 同一 Source 更新到 r2');
    assert.equal(sourceV2.revision, 2, 'A Source r2');
    const planB = {
      workspaceId: WS, sourceId: source.id, sourceRevision: sourceV2.revision, topicId: topic.id,
      reason: '摄取 AgentForge v2 争议报道：限域旧 Method、标记争议',
      topicCompile: { summary: 'AI Agent 工具链主题编译（v2 更新）' },
      entities: [{ entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '已存在，验证零重复' }],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-xiaohongshu-claim', statement: 'AgentForge v2 可用于小红书运营场景的批量内容生成', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-9', excerpt: 'Works for xiaohongshu ops.', entityKeys: ['agentforge'], valueRationale: '平台适用事实，直接进入创作判断' },
        { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由的样本先覆盖目标平台（当前仅 xiaohongshu 验证）', conclusionStatus: 'supported', evidenceLevel: 'corroborated', appliesTo: 'xiaohongshu', changeType: 'qualified', changeReason: '新证据限制平台适用范围', locator: 'L22-27', relation: 'qualifies', entityKeys: ['agentforge'], valueRationale: '改变既有方法适用范围' },
        { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', changeType: 'contradicted', changeReason: '新报道与首发资料分歧，保留争议', locator: 'L30-33', relation: 'contradicts', entityKeys: ['agentforge'], valueRationale: '可信来源实质分歧，需保留争议' }
      ]
    };
    const c = compileSourceKnowledge(database, { ...planB, requestId: sourceCompileRequestId(source.id, sourceV2.revision) });
    assert.equal(c.ok, true, 'A2 编译 ok');
    assert.equal(c.counts.entitiesMatched, 1, 'A2 Entity 命中 1（零重复）');
    assert.equal(c.counts.entitiesCreated, 0, 'A2 Entity 零新建');
    assert.equal(c.counts.notesCreated, 1, 'A2 新 Claim 1');
    assert.equal(c.counts.notesUpdated, 2, 'A2 旧 Note 更新 2');
    assert.equal(c.counts.noteVersionsCreated, 3, 'A2 版本 3');
    assert.equal(c.counts.evidenceLinks, 3, 'A2 证据 3');
    assert.equal(c.counts.wikiPagesCompiled, 1, 'A2 Wiki 重编译');
    assert.equal(count(database, 'knowledge_entities'), 1, 'A2 Entity 总数仍 1');

    const disputedNote = getKnowledgeNote(database, c.noteIds['agentforge-v2-multi-router']);
    const disputedNoteId = disputedNote.note.id;
    assert.equal(disputedNote.note.revision, 2, 'A2 争议 Note revision=2');
    assert.equal(listKnowledgeNoteVersions(database, disputedNoteId, {}).items.length, 2, 'A2 争议 Note 两版本');
    assert.equal(disputedNote.version.conclusionStatus, 'disputed', 'A2 争议版本 disputed');
    assert.equal(disputedNote.version.changeType, 'contradicted', 'A2 争议 changeType=contradicted');
    const qualifiedMethod = getKnowledgeNote(database, c.noteIds['agentforge-router-eval']);
    assert.equal(qualifiedMethod.note.revision, 2, 'A2 Method revision=2');
    assert.equal(qualifiedMethod.version.changeType, 'qualified', 'A2 Method qualified');
    assert.equal(qualifiedMethod.version.appliesTo, 'xiaohongshu', 'A2 Method 限域 xiaohongshu');
    const newClaim = getKnowledgeNote(database, c.noteIds['agentforge-v2-xiaohongshu-claim']);
    assert.equal(newClaim.version.conclusionStatus, 'supported', 'A2 新 Claim supported');
    assert.equal(listKnowledgeEvidenceLinks(database, { noteVersionId: newClaim.version.id }).items[0].locator, 'L5-9', 'A2 新 Claim 证据 locator');

    const pageA2 = getWikiPage(database, topicPagesA.items[0].id);
    const wikiV2Id = pageA2.version.id;
    assert.equal(pageA2.version.versionNumber, 2, 'A2 Wiki V2');
    assert.equal(pageA2.version.adoptedNoteVersionIds.length, 5, 'A2 Wiki 采纳 5 版本');
    assert.equal(pageA2.version.body.retainedDisputes.length, 1, 'A2 Wiki 保留 1 争议');
    assert.equal(pageA2.version.body.recentChanges.length, 3, 'A2 Wiki recentChanges 3');
    assert.equal(getChangeSet(database, c.changeSetId)?.resolutionMode, 'kept_disputed', 'A2 ChangeSet kept_disputed');
    assert.ok(c.receipt?.retainedDisputes?.includes(disputedNote.version.id), 'A2 回执 retainedDisputes');
    assert.ok(c.receipt?.autoResolutions?.some((x) => x.startsWith('qualified:')), 'A2 回执 qualified');
    assert.ok(c.receipt?.autoResolutions?.some((x) => x.startsWith('contradicted:')), 'A2 回执 contradicted');
    assert.ok(c.receipt?.affectedMethods?.includes(qualifiedMethod.note.id), 'A2 回执 affectedMethods');
    assert.equal(getUpdateReceiptByRequest(database, WS, sourceCompileRequestId(source.id, 2))?.id, c.receipt?.id, 'A2 回执按 request 读回');

    // 进入选题上下文：主查询读取面（Pi 查询 + 创作共用）
    const ctxA = getKnowledgeContext(database, { topicId: topic.id, limit: 20 });
    assert.ok(Array.isArray(ctxA.knowledge?.wikiPages) && ctxA.knowledge.wikiPages.length === 1, 'A ctx Wiki 页 1');
    assert.equal(ctxA.knowledge.wikiPages[0].currentVersionId, wikiV2Id, 'A ctx 冻结当前 Wiki 版本 = V2');
    assert.ok(ctxA.knowledge.noteVersions.some((v) => v.versionId === newClaim.version.id), 'A ctx 含新 Claim 版本');
    assert.ok(ctxA.knowledge.noteVersions.some((v) => v.conclusionStatus === 'disputed'), 'A ctx 含争议版本');
    assert.ok(ctxA.knowledge.evidence.length >= 3, 'A ctx 含证据');
    // 选题上下文包：画布 → 上下文包
    const canvasCtx = createKnowledgeCanvas(database, { title: 'A 选题画布', topicId: topic.id });
    const nodeCtx = addKnowledgeCanvasNode(database, { canvasId: canvasCtx.id, objectType: 'topic', objectId: topic.id, x: 0, y: 0 });
    const pkg = createKnowledgeContextPackage(database, {
      canvasId: canvasCtx.id, name: 'AI Agent 选题上下文', objective: '进入选题判断', nodeIds: [nodeCtx.id]
    });
    assert.ok(pkg.manifest && pkg.items.some((i) => i.objectType === 'topic' && i.objectId === topic.id), 'A 选题上下文包含 Topic 项');
    summary.scenarios.A = {
      compile1: { changeSetId: a.changeSetId, receiptId: a.receipt?.id, entities: 1, notes: 2, noteVersions: 2, evidenceLinks: 2, wikiVersionId: wikiV1Id, wikiAdopted: 2 },
      compile2: { changeSetId: c.changeSetId, receiptId: c.receipt?.id, entitiesMatched: 1, notesCreated: 1, notesUpdated: 2, noteVersions: 3, wikiVersionId: wikiV2Id, wikiAdopted: 5, retainedDisputes: 1 },
      disputedNoteId, qualifiedMethodId: qualifiedMethod.note.id, newClaimNoteId: newClaim.note.id,
      context: { currentWikiVersionId: wikiV2Id, noteVersionsInContext: ctxA.knowledge.noteVersions.length, evidenceInContext: ctxA.knowledge.evidence.length, topicContextPackage: pkg.id }
    };

    // ===================================================================
    // B. Query：冻结读取版本 + 新 Synthesis 写回 + 同问幂等 + 版本不可变
    // ===================================================================
    const readNoteIds = [...pageA2.version.adoptedNoteVersionIds];
    const readWikiVersionIds = [wikiV2Id];
    const evidenceIds = [];
    for (const versionId of readNoteIds) {
      for (const item of listKnowledgeEvidenceLinks(database, { noteVersionId: versionId }).items) evidenceIds.push(item.id);
    }
    assert.ok(readNoteIds.length === 5 && evidenceIds.length >= 5, 'B 冻结读取版本就绪');
    const convId = 'e2e-conv-1';
    const q1 = 'AgentForge v2 多模型路由现在怎么评估？';
    const requestId1 = knowledgeQueryWritebackRequestId(convId, q1);
    const base = { workspaceId: WS, scope: 'global', conversationId: convId, question: q1, answerSummary: '基于既有知识复述。' };
    const readVersions = { readWikiVersionIds, readNoteVersionIds: readNoteIds, readEvidenceIds: evidenceIds };
    const beforeRestate = { changeSets: count(database, 'knowledge_change_sets'), notes: count(database, 'knowledge_notes'), noteVersions: count(database, 'knowledge_note_versions'), wikiPages: count(database, 'knowledge_wiki_pages'), wikiVersions: count(database, 'knowledge_wiki_page_versions'), evidenceLinks: count(database, 'knowledge_evidence_links') };
    const restatement = writebackQueryKnowledge(database, { ...base, requestId: requestId1, classification: 'restatement', ...readVersions });
    assert.equal(restatement.ok, true, 'B restatement ok');
    assert.equal(restatement.duplicate, false, 'B restatement 非重复');
    assert.equal(restatement.writeBackDecision, 'skipped_repetition', 'B decision=skipped_repetition');
    assert.equal(restatement.counts.notesCreated, 0, 'B 零 Note');
    assert.equal(restatement.counts.wikiPagesCompiled, 0, 'B 零 Wiki 编译');
    assert.equal(restatement.counts.restatements, 1, 'B restatements=1');
    assert.equal(count(database, 'knowledge_notes'), beforeRestate.notes, 'B 零知识写');
    assert.equal(count(database, 'knowledge_note_versions'), beforeRestate.noteVersions, 'B 零版本写');
    assert.equal(count(database, 'knowledge_wiki_page_versions'), beforeRestate.wikiVersions, 'B 零 Wiki 版本写');
    assert.equal(restatement.artifact?.readNoteVersionIds.length, 5, 'B Artifact 冻结 5 Note 版本');
    assert.equal(restatement.artifact?.readWikiVersionIds[0], wikiV2Id, 'B Artifact 冻结 Wiki V2');
    assert.equal(restatement.receipt?.triggerType, 'query', 'B 回执 triggerType=query');
    assert.equal(getUpdateReceiptByRequest(database, WS, requestId1)?.id, restatement.receipt?.id, 'B 回执按 request 读回');

    const replay = writebackQueryKnowledge(database, { ...base, requestId: requestId1, classification: 'restatement', ...readVersions });
    assert.equal(replay.duplicate, true, 'B 同问幂等 duplicate');
    assert.equal(replay.artifact?.id, restatement.artifact?.id, 'B 同问返回同一 Artifact');
    assert.equal(replay.receipt?.id, restatement.receipt?.id, 'B 同问返回同一回执');
    assert.equal(count(database, 'knowledge_query_artifacts'), 1, 'B 同问零新增 Artifact');

    // 新综合：跨资料综合 → insight Note + Synthesis Wiki（derived_from 只指向冻结集）
    const q2 = '把 AgentForge 能力和小红书实践放到一起，得出什么可复用判断？';
    const requestId2 = knowledgeQueryWritebackRequestId(convId, q2);
    const synthesisPlan = {
      canonicalKey: 'agentforge-xhs-synthesis',
      title: 'AgentForge v2 × 小红书实践综合',
      statement: '当团队已具备 AgentForge v2 多模型路由时，小红书批量内容生产应优先复用该路由做平台适配，而非另起流程。',
      basedOnNoteVersionIds: readNoteIds,
      valueRationale: '跨资料新综合：把产品能力与平台实践关联，形成可复用选型判断'
    };
    const beforeSyn = { notes: count(database, 'knowledge_notes'), noteVersions: count(database, 'knowledge_note_versions'), wikiPages: count(database, 'knowledge_wiki_pages'), wikiVersions: count(database, 'knowledge_wiki_page_versions') };
    const synthesis = writebackQueryKnowledge(database, {
      ...base, requestId: requestId2, question: q2, classification: 'new_synthesis',
      answerSummary: '综合既有资料得出可复用判断。', ...readVersions, synthesis: synthesisPlan
    });
    assert.equal(synthesis.ok, true, 'B 综合 ok');
    assert.equal(synthesis.writeBackDecision, 'created', 'B decision=created');
    assert.equal(synthesis.counts.notesCreated, 1, 'B 综合 Note 1');
    assert.equal(synthesis.counts.wikiPagesCompiled, 1, 'B 综合 Wiki 1');
    const synNote = getKnowledgeNote(database, synthesis.noteIds['agentforge-xhs-synthesis']);
    assert.equal(synNote.note.kind, 'insight', 'B 综合 Note kind=insight');
    assert.equal(synNote.version.conclusionStatus, 'inference', 'B 综合 inference');
    assert.equal(synNote.version.evidenceLevel, 'mixed', 'B 综合 mixed');
    assert.equal(synNote.version.adoptedKnowledgeVersionIds.length, readNoteIds.length, 'B 综合采用冻结集');
    assert.equal(count(database, 'knowledge_notes'), beforeSyn.notes + 1, 'B 综合零重复（恰 1 新 Note）');
    assert.equal(count(database, 'knowledge_note_versions'), beforeSyn.noteVersions + 1, 'B 综合恰 1 新版本');
    assert.equal(count(database, 'knowledge_wiki_pages'), beforeSyn.wikiPages + 1, 'B 综合恰 1 新 Wiki 页');
    assert.equal(count(database, 'knowledge_wiki_page_versions'), beforeSyn.wikiVersions + 1, 'B 综合恰 1 新 Wiki 版本');
    const synEvidence = listKnowledgeEvidenceLinks(database, { noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'] }).items;
    assert.equal(synEvidence.length, readNoteIds.length + 1, 'B 综合证据 = Note 集 + Wiki 版本');
    assert.ok(synEvidence.every((item) => item.relation === 'derived_from'), 'B 综合证据全部 derived_from');
    assert.ok(synEvidence.every((item) => readNoteIds.includes(item.evidenceObjectId) || item.evidenceObjectId === wikiV2Id), 'B 综合证据只指向冻结集');
    const synthesisPages = listWikiPages(database, { scope: 'global', pageType: 'synthesis' });
    assert.equal(synthesisPages.items.length, 1, 'B Synthesis Wiki 页 1');
    assert.equal(synthesisPages.items[0].canonicalKey, 'synthesis:agentforge-xhs-synthesis', 'B Synthesis canonicalKey');
    const synthesisPage = getWikiPage(database, synthesisPages.items[0].id);
    assert.equal(synthesisPage.version.body.kind, 'synthesis-wiki', 'B Synthesis 正文 kind');
    assert.deepEqual(synthesisPage.version.body.basedOn.noteVersionIds, readNoteIds, 'B Synthesis 冻结 Note 集');
    assert.equal(synthesisPage.version.body.basedOn.wikiVersionIds[0], wikiV2Id, 'B Synthesis 冻结 Wiki V2');
    assert.ok(synthesis.receipt?.affectedSyntheses?.includes(synthesisPages.items[0].id), 'B 回执 affectedSyntheses');
    assert.ok(synthesis.receipt?.wikiPageVersions?.includes(synthesisPage.version.id), 'B 回执 wikiPageVersions');
    assert.equal(synthesis.receipt?.triggerType, 'query', 'B 回执 query');
    assert.equal(getQueryWritebackSummary(database, requestId2)?.artifact?.id, synthesis.artifact?.id, 'B 摘要读回同一 Artifact');

    // 知识更新（新 Source 编译 → Topic Wiki V3）：Synthesis 冻结版本不回读未来
    const sourceV3 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-safety', title: 'AgentForge v2 安全边界说明', summary: '官方安全边界说明。' });
    const r3 = compileSourceKnowledge(database, {
      workspaceId: WS, sourceId: sourceV3.id, sourceRevision: sourceV3.revision, topicId: topic.id,
      reason: '新资料：安全边界',
      requestId: sourceCompileRequestId(sourceV3.id, sourceV3.revision),
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-safety', statement: 'AgentForge v2 提供内容安全边界配置', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L3-6', entityKeys: ['agentforge'], valueRationale: '补充产品事实' }
      ]
    });
    assert.equal(r3.counts.notesCreated, 1, 'B3 新 Claim 1');
    const pageV3 = getWikiPage(database, topicPagesA.items[0].id);
    const wikiV3Id = pageV3.version.id;
    assert.equal(pageV3.version.versionNumber, 3, 'B3 Topic Wiki V3');
    const frozenSyn = getWikiPage(database, synthesisPages.items[0].id);
    assert.deepEqual(frozenSyn.version.body.basedOn.noteVersionIds, readNoteIds, 'B Synthesis 冻结集不变（不回读 V3）');
    assert.equal(frozenSyn.version.body.basedOn.wikiVersionIds[0], wikiV2Id, 'B Synthesis 冻结 Wiki 版本仍 V2');
    const frozenArtifact = getQueryArtifactByRequest(database, requestId2);
    assert.deepEqual(frozenArtifact?.readNoteVersionIds, readNoteIds, 'B Artifact 冻结读取版本不变');
    assert.equal(frozenArtifact?.readWikiVersionIds[0], wikiV2Id, 'B Artifact 冻结 Wiki 版本仍 V2');

    // 用户经验：先保存不可变 FreeNote，零知识 Note
    const experience = writebackQueryKnowledge(database, {
      ...base, requestId: knowledgeQueryWritebackRequestId(convId, '我这边实际跑下来有个经验'),
      question: '我这边实际跑下来有个经验', classification: 'user_experience',
      answerSummary: '感谢分享，我会记住这个经验。', readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: [],
      experience: { body: '我们团队实际跑下来，AgentForge v2 的批量生成在小红书图片场景要先过一遍人工抽检再发布。' }
    });
    assert.ok(experience.freeNoteId, 'B 经验 FreeNote 落库');
    assert.equal(experience.writeBackDecision, 'no_write_back', 'B 经验 decision=no_write_back');
    assert.equal(getKnowledgeFreeNote(database, experience.freeNoteId)?.sourceNature, 'pi_dialogue', 'B FreeNote pi_dialogue');
    assert.equal(count(database, 'knowledge_notes'), beforeSyn.notes + 2, 'B 知识 Note = 综合 1 + r3 新 Claim 1（经验零 Note）');
    summary.scenarios.B = {
      frozenRead: { wikiVersionId: wikiV2Id, noteVersionIds: readNoteIds.length, evidenceIds: evidenceIds.length },
      restatement: { decision: 'skipped_repetition', artifactId: restatement.artifact?.id, receiptId: restatement.receipt?.id },
      sameQuestionReplay: { duplicate: true, artifactSame: replay.artifact?.id === restatement.artifact?.id },
      synthesis: { noteId: synthesis.noteIds['agentforge-xhs-synthesis'], noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'], pageId: synthesisPages.items[0].id, pageVersionId: synthesisPage.version.id, derivedEvidence: synEvidence.length, receiptId: synthesis.receipt?.id },
      freezeAfterUpdate: { wikiNow: wikiV3Id, synthesisBasedOnWikiStill: frozenSyn.version.body.basedOn.wikiVersionIds[0], artifactReadWikiStill: frozenArtifact?.readWikiVersionIds[0] },
      experienceFreeNoteId: experience.freeNoteId
    };

    // ===================================================================
    // C. Creation：proposal → brief → core → platform 固定 usage；平台不改事实
    // ===================================================================
    const wikiV3Adopted = [...pageV3.version.adoptedNoteVersionIds];
    const proposal = createTopicMaintenanceProposal(database, {
      title: 'AI Agent 工具链整理', reason: '资料已更新',
      changes: [{ kind: 'update', topicId: topic.id, after: { title: 'AI Agent 工具链（更新）', canonicalKey: 'ai-agent-updated' } }]
    });
    const proposalPkg = packageOf(database, 'topic_proposal', proposal.id);
    assert.ok(proposalPkg, 'C 提案 usage 包');
    assert.equal(proposalPkg.stage, 'topic_proposal', 'C 提案 stage');
    assert.deepEqual([...proposalPkg.wikiPageVersionIds], [wikiV3Id], 'C 提案冻结 Wiki V3');

    const canvasId = 'e2e-canvas-c';
    database.prepare('INSERT INTO knowledge_canvases (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(canvasId, '创作画布', NOW(), NOW());
    database.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
      VALUES ('cn-topic', ?, 'topic', ?, NULL, NULL, 0, 0, ?, ?)`).run(canvasId, topic.id, NOW(), NOW());
    const brief = createCreativeBrief(database, {
      canvasId, nodeIds: ['cn-topic'], selectionMode: 'selected',
      title: 'AI Agent 工具链简报', coreJudgment: '核心判断', whyNow: '为什么现在',
      structure: ['开头', '正文'], evidenceNodeIds: ['cn-topic']
    });
    recordCreativeBriefUsage(database, { briefId: brief.id, contextNodeIds: brief.contextNodeIds, reason: 'creative_brief_create' });
    const briefPkg = packageOf(database, 'creative_brief', brief.id);
    assert.ok(briefPkg, 'C 简报 usage 包');
    assert.deepEqual([...briefPkg.wikiPageVersionIds], [wikiV3Id], 'C 简报冻结 Wiki V3');
    const briefRecords = listKnowledgeUsageRecords(database, { packageId: briefPkg.id }).items;
    assert.equal(briefRecords.filter((r) => r.used === true).length, 1, 'C 简报 used 恰 1（Wiki reasoning_basis）');
    assert.equal(briefRecords.filter((r) => r.used === false).length, wikiV3Adopted.length, 'C 简报 consulted 恰为采纳 Note 集');

    const core1 = createContentProjectWithVersion(database, { title: 'AI 项目', body: '核心 V1', topicId: topic.id, sourceIds: [source.id] });
    const core1Pkg = packageOf(database, 'core_draft', core1.contentVersionId);
    assert.ok(core1Pkg, 'C 核心 V1 usage 包');
    assert.deepEqual([...core1Pkg.wikiPageVersionIds], [wikiV3Id], 'C 核心 V1 冻结 Wiki V3');
    const core2 = saveCoreVersion(database, { projectId: core1.id, body: '核心 V2', expectedRevision: 1 });
    assert.equal(core2.ok, true, 'C 核心 V2 ok');
    const core2Pkg = packageOf(database, 'core_draft', core2.data.id);
    assert.ok(core2Pkg, 'C 核心 V2 usage 包');
    assert.deepEqual([...core2Pkg.wikiPageVersionIds], [wikiV3Id], 'C 核心 V2 冻结 Wiki V3');

    const platform = savePlatformVersion(database, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'xiaohongshu', format: 'text', body: '平台 V1' });
    assert.equal(platform.ok, true, 'C 平台版本 ok');
    const platformPkg = packageOf(database, 'platform_adaptation', platform.data.id);
    assert.ok(platformPkg, 'C 平台 usage 包');
    assert.deepEqual([...platformPkg.wikiPageVersionIds], [wikiV3Id], 'C 平台继承核心同一固定 Wiki V3');
    const platformRecords = listKnowledgeUsageRecords(database, { packageId: platformPkg.id }).items;
    const platformUsed = platformRecords.filter((r) => r.used === true);
    assert.equal(platformUsed.length, 1, 'C 平台 used 恰 1');
    assert.equal(platformUsed[0].usageKind, 'structure_pattern', 'C 平台 usageKind=structure_pattern');
    assert.equal(platformUsed[0].outputObjectId, platform.data.id, 'C 平台 used 指向平台版本');

    // 平台不改事实：换基到不同核心版本 → REQUEST_REPLAY_CONFLICT，零变更
    const beforeRebase = { platformVersionId: platform.data.id, contentVersionId: core2.data.id, revision: 1 };
    expectThrowsCode('C 平台换基（事实变化）拒绝', () => {
      savePlatformVersion(database, {
        id: platform.data.id, projectId: core1.id, contentVersionId: core1.contentVersionId, platform: 'xiaohongshu', format: 'text', body: '换基正文',
        expectedRevision: 1
      }, true);
    }, 'REQUEST_REPLAY_CONFLICT');
    const platformRow = database.prepare('SELECT content_version_id AS contentVersionId, revision FROM platform_versions WHERE id = ?').get(platform.data.id);
    assert.equal(platformRow.contentVersionId, beforeRebase.contentVersionId, 'C 拒绝后平台仍指向原核心版本');
    assert.equal(platformRow.revision, beforeRebase.revision, 'C 拒绝后平台 revision 未变');
    // 同基修订可保存（血缘已在创建时固定）
    const sameBase = savePlatformVersion(database, {
      id: platform.data.id, projectId: core1.id, contentVersionId: core2.data.id, platform: 'xiaohongshu', format: 'text', body: '同基修订',
      expectedRevision: 1
    }, true);
    assert.equal(sameBase.ok, true, 'C 同基修订 ok');
    assert.equal(sameBase.data.revision, 2, 'C 同基修订 revision=2');
    summary.scenarios.C = {
      frozenWikiVersionId: wikiV3Id, proposalPkgId: proposalPkg.id, briefPkgId: briefPkg.id,
      core1PkgId: core1Pkg.id, core2PkgId: core2Pkg.id, platformPkgId: platformPkg.id,
      platformUsed: platformUsed[0]?.usageKind, rebaseRejected: { code: 'REQUEST_REPLAY_CONFLICT', platformStillContentVersionId: platformRow.contentVersionId, platformRevision: platformRow.revision },
      sameBaseUpdateRevision: sameBase.data.revision
    };

    // ===================================================================
    // D. Publication / Metric / final Review：回流恰好一次 + 零因果 Method + Wiki 立即可见
    // ===================================================================
    const account = saveAccount(database, { platform: 'xiaohongshu', accountKey: '@e2e-tester', displayName: 'tester', loginState: 'authenticated' });
    const publication = createPublication(database, { platformVersionId: platform.data.id, accountId: account.id });
    assert.equal(publication.ok, true, 'D 发布 ok');
    const pubNow = NOW();
    database.prepare(`UPDATE publications SET status='published', external_url=?, external_id=?, published_at=?, prepared_title=?, prepared_body=?, prepared_assets_json='[]', updated_at=?, revision=? WHERE id=?`)
      .run('https://x.com/e2e-tester/1', 'e2e-1', pubNow, null, '平台 V1', pubNow, 2, publication.data.id);
    const snap = savePublicationMetricSnapshot(database, {
      publicationId: publication.data.id, scheduledFor: pubNow, sourceUrl: 'https://x.com/e2e-tester/1', capturedAt: pubNow,
      normalized: { views: { status: 'value', value: 100, rawLabel: '100' } }, raw: { views: { status: 'value', value: 100, rawLabel: '100' } }
    });
    assert.equal(snap.ok, true, 'D 指标快照 ok');
    const methodsBeforeReview = countWhere(database, 'knowledge_notes', "kind = 'method'");
    const patternsBeforeReview = countWhere(database, 'knowledge_notes', "kind = 'creative_pattern'");
    const review = saveReview(database, {
      publicationId: publication.data.id, metricSnapshotIds: [snap.data.id],
      keep: ['开头钩子'], stop: ['泛 CTA'], change: ['封面先给结论'], summary: '复盘', status: 'final',
      findings: [{ title: '先给结论', body: '封面先给结论' }]
    });
    assert.equal(review.ok, true, 'D final Review ok');
    const reviewId = review.data.id;

    assert.equal(countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'"), 1, 'D 恰好一条 outcome ChangeSet');
    const outcomeCs = database.prepare(`SELECT trigger_source AS t, created_by AS c FROM knowledge_change_sets WHERE request_id = ?`).get(outcomeFeedbackRequestId(reviewId));
    assert.equal(outcomeCs.t, 'review', 'D outcome ChangeSet trigger=review');
    assert.equal(outcomeCs.c, 'system', 'D outcome ChangeSet createdBy=system');
    const caseNote = database.prepare('SELECT id, kind FROM knowledge_notes WHERE canonical_key = ?').get(`case:outcome:${reviewId}`);
    assert.ok(caseNote, 'D case 观察 Note');
    assert.equal(caseNote.kind, 'case', 'D case kind=case');
    const caseVersion = database.prepare(`SELECT id FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number DESC LIMIT 1`).get(caseNote.id);
    const caseVersionRecord = getKnowledgeNoteVersion(database, caseVersion.id);
    assert.equal(caseVersionRecord.conclusionStatus, 'unverified', 'D case 版本 unverified');
    assert.equal(caseVersionRecord.evidenceLevel, 'outcome_observed', 'D case 版本 outcome_observed');
    assert.ok(String(caseVersionRecord.statement).includes('不证明因果'), 'D case 语句不证明因果');
    assert.ok(String(caseVersionRecord.statement).includes('单次样本观察'), 'D case 语句单次样本观察');
    assert.ok(caseVersionRecord.adoptedTopicIds.includes(topic.id), 'D case 归属 Topic');
    assert.ok(String(caseVersionRecord.appliesTo).includes('platform:xiaohongshu'), 'D case 限域平台');
    const adoptedLineage = [...caseVersionRecord.adoptedKnowledgeVersionIds];
    assert.equal(adoptedLineage.length, wikiV3Adopted.length, 'D case 血缘固定发布时 Note 集');
    assert.deepEqual([...adoptedLineage].sort(), [...wikiV3Adopted].sort(), 'D case 血缘 = 发布时冻结 Note 集');
    assert.ok(!adoptedLineage.includes(caseVersionRecord.id), 'D case 不采纳自己');
    const caseEvidence = database.prepare('SELECT evidence_object_type AS t, evidence_object_id AS id, source_nature AS s FROM knowledge_evidence_links WHERE knowledge_note_version_id = ?').all(caseVersion.id);
    assert.ok(caseEvidence.some((e) => e.t === 'review' && e.id === reviewId && e.s === 'review'), 'D case 证据 review');
    assert.ok(caseEvidence.some((e) => e.t === 'publication' && e.id === publication.data.id && e.s === 'performance_observation'), 'D case 证据 publication');
    assert.ok(caseEvidence.some((e) => e.t === 'metric_snapshot' && e.id === snap.data.id && e.s === 'performance_observation'), 'D case 证据 metric_snapshot');
    assert.equal(countWhere(database, 'knowledge_notes', "kind = 'method'"), methodsBeforeReview, 'D 回流零新增 Method（单次结果不证明因果）');
    assert.equal(countWhere(database, 'knowledge_notes', "kind = 'creative_pattern'"), patternsBeforeReview, 'D 回流零新增 pattern');

    const outcomeReceipt = getUpdateReceiptByRequest(database, WS, outcomeFeedbackRequestId(reviewId));
    assert.ok(outcomeReceipt, 'D 回流回执');
    assert.equal(outcomeReceipt.triggerType, 'review', 'D 回执 triggerType=review');
    assert.equal(outcomeReceipt.counts.caseNotesCreated, 1, 'D 回执 caseNotesCreated=1');
    assert.ok(outcomeReceipt.affectedTopics.includes(topic.id), 'D 回执 affectedTopics');
    assert.equal(outcomeReceipt.impact.lineagePresent, true, 'D 回执 lineagePresent');
    assert.deepEqual([...outcomeReceipt.impact.lineageVersionIds].sort(), [...wikiV3Adopted, wikiV3Id].sort(), 'D 回执血缘 = 冻结 Wiki + Note 集');

    // Topic Wiki 同 ChangeSet 原子重编译：Review 后立即可见（下一轮）
    const wikiVersions = database.prepare('SELECT id, version_number AS n FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number').all(topicPagesA.items[0].id);
    assert.equal(wikiVersions.length, 4, 'D Topic Wiki V1..V4');
    const outcomeWiki = getWikiPageVersion(database, wikiVersions[3].id);
    assert.ok(Array.isArray(outcomeWiki.body.recentOutcomes) && outcomeWiki.body.recentOutcomes.length === 1, 'D Wiki recentOutcomes 1');
    assert.equal(outcomeWiki.body.recentOutcomes[0].reviewId, reviewId, 'D Wiki outcome reviewId');
    assert.equal(outcomeWiki.body.recentOutcomes[0].caseNoteVersionId, caseVersion.id, 'D Wiki outcome caseNoteVersionId');
    assert.ok(outcomeWiki.adoptedNoteVersionIds.includes(caseVersion.id), 'D Wiki 采纳 case 版本');
    const pageAfterD = getWikiPage(database, topicPagesA.items[0].id);
    assert.equal(pageAfterD.version.id, outcomeWiki.id, 'D Wiki 当前版本 = 结果版本');

    // 重放零增量
    const beforeReplay = { changeSets: count(database, 'knowledge_change_sets'), notes: count(database, 'knowledge_notes'), evidence: count(database, 'knowledge_evidence_links') };
    const replayed = flowBackOutcome(database, { reviewId });
    assert.equal(replayed.replay, true, 'D 重放 replay=true');
    assert.equal(count(database, 'knowledge_change_sets'), beforeReplay.changeSets, 'D 重放零新增 ChangeSet');
    assert.equal(count(database, 'knowledge_notes'), beforeReplay.notes, 'D 重放零新增 Note');
    assert.equal(count(database, 'knowledge_evidence_links'), beforeReplay.evidence, 'D 重放零新增证据');
    // 历史复盘读发布时固定血缘
    const historical = readPublicationTimeUsage(database, { publicationId: publication.data.id });
    assert.ok(historical, 'D 历史复盘可读发布时血缘');
    assert.deepEqual([...historical.platformPackage.wikiPageVersionIds], [wikiV3Id], 'D 复盘读发布时 Wiki 版本（非当前结果版本）');
    assert.equal(historical.reviewPackages.length, 1, 'D 复盘 review 包 1');
    summary.scenarios.D = {
      publicationId: publication.data.id, metricSnapshotId: snap.data.id, reviewId,
      outcomeChangeSetRequestId: outcomeFeedbackRequestId(reviewId), caseNoteId: caseNote.id, caseVersionId: caseVersion.id,
      receiptId: outcomeReceipt.id, lineageVersionIds: outcomeReceipt.impact.lineageVersionIds.length,
      wikiCurrentVersionId: pageAfterD.version.id, wikiRecentOutcomes: outcomeWiki.body.recentOutcomes.length,
      zeroCausalMethod: true, zeroPattern: true, replayZeroWrite: true
    };

    // ===================================================================
    // E. Health Lint：stale / broken / conflict / duplicate + 自动修复 + checkpoint 恢复
    // ===================================================================
    // 弱话题 Topic-2 + 显式 stale Wiki 页（供 stale 检测）
    const topic2 = upsertKnowledgeTopic(database, { title: '图文排版' });
    const pageTopic2 = applyKnowledgeChangeSet(database, csMeta('e2e-seed-stale-page'), {
      wikiPages: [{ id: 'page-topic-2', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-xhs-layout', subjectType: 'topic', subjectId: topic2.id, compileStatus: 'stale', compileNote: '待重编译' }],
      receipts: [{ triggerType: 'ingest', requestId: 'e2e-seed-stale-page', summary: 'stale 页种子', counts: { wikiPages: 1 } }]
    });
    assert.ok(pageTopic2.changeSetId, 'E stale 页种子已提交');

    // 冲突候选：既有 disputed Note（A 场景产物）→ open 不自动裁决
    const lintConflict1 = runLocalLint(database, {
      requestId: 'e2e-lint-conflict-1', workspaceId: WS, scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_note', objectId: disputedNoteId }]
    });
    assert.equal(lintConflict1.ok, true, 'E 冲突 lint ok');
    assert.equal(lintConflict1.counts.issuesCreated, 1, 'E 冲突 Issue 1');
    assert.equal(lintConflict1.issues[0]?.issueType, 'unresolved_contradiction', 'E Issue 类型');
    assert.equal(lintConflict1.issues[0]?.status, 'open', 'E 冲突 open');
    assert.equal(lintConflict1.counts.repairsApplied, 0, 'E 可信冲突不自动裁决');
    const conflictIssueId = lintConflict1.issues[0].id;
    // duplicate 候选：重复扫描去重
    const lintConflict2 = runLocalLint(database, {
      requestId: 'e2e-lint-conflict-2', workspaceId: WS, scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_note', objectId: disputedNoteId }]
    });
    assert.equal(lintConflict2.counts.issuesCreated, 0, 'E 重复扫描零新建');
    assert.equal(lintConflict2.counts.issuesDeduplicated, 1, 'E 重复扫描去重 1');
    assert.equal(getHealthIssue(database, conflictIssueId)?.status, 'open', 'E 同一 Issue 行不变');

    // broken 候选（evidence）：幽灵证据对象 → open 不自动修复（不可变）
    const claimNoteCurrentVersion = getKnowledgeNote(database, a.noteIds['agentforge-v2-multi-router']).version.id;
    const seedChangeSetId = database.prepare('SELECT id FROM knowledge_change_sets ORDER BY created_at DESC LIMIT 1').get().id;
    database.prepare(
      `INSERT INTO knowledge_evidence_links (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature, excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
       VALUES ('ev-ghost-e2e', ?, 'source', 'ghost-source-deleted', 'supports', 'primary_source', NULL, NULL, NULL, 'background_agent', ?, ?)`
    ).run(claimNoteCurrentVersion, seedChangeSetId, NOW());
    const lintBrokenEv = runLocalLint(database, {
      requestId: 'e2e-lint-broken-ev', workspaceId: WS, scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_note', objectId: a.noteIds['agentforge-v2-multi-router'] }]
    });
    assert.equal(lintBrokenEv.counts.issuesCreated, 1, 'E broken 证据 Issue 1');
    assert.equal(lintBrokenEv.issues[0]?.issueType, 'broken_reference', 'E broken_reference');
    assert.equal(lintBrokenEv.issues[0]?.status, 'open', 'E broken 证据 open');
    assert.equal(lintBrokenEv.counts.repairsApplied, 0, 'E broken 证据不自动删除');
    assert.ok(database.prepare('SELECT id FROM knowledge_evidence_links WHERE id = ?').get('ev-ghost-e2e'), 'E 证据行未删（不可变）');
    const brokenEvIssueId = lintBrokenEv.issues[0].id;

    // broken 候选（formal relation）：自动 ChangeSet 修复
    database.prepare(
      `INSERT INTO knowledge_formal_relations (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id, created_change_set_id, end_reason, created_at)
       VALUES ('rel-ghost-e2e', 'global', 'derived_from', 'knowledge_note', ?, 'source', 'ghost-source-e2e', ?, '', ?)`
    ).run(a.noteIds['agentforge-v2-multi-router'], seedChangeSetId, NOW());
    const lintRepair = runLocalLint(database, {
      requestId: 'e2e-lint-repair-1', workspaceId: WS, scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-e2e' }]
    });
    assert.equal(lintRepair.counts.repairsApplied, 1, 'E broken 关系自动修复 1');
    assert.equal(lintRepair.issues[0]?.status, 'resolved', 'E 修复 Issue resolved');
    const ghostRelRow = database.prepare('SELECT ended_change_set_id AS e, end_reason AS reason FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-e2e');
    assert.ok(ghostRelRow.e && String(ghostRelRow.reason).includes('auto-repair'), 'E 关系已终止并记录原因');
    assert.equal(lintRepair.receipt?.triggerType, 'lint', 'E 修复 lint 回执');
    assert.equal(getUpdateReceiptByRequest(database, WS, 'e2e-lint-repair-1')?.id, lintRepair.receipt?.id, 'E 修复回执读回');

    // stale 候选：stale Wiki 页 → open
    const lintStale = runLocalLint(database, {
      requestId: 'e2e-lint-stale-1', workspaceId: WS, scope: 'global',
      affectedObjects: [{ objectType: 'wiki_page', objectId: 'page-topic-2' }]
    });
    assert.equal(lintStale.counts.issuesCreated, 1, 'E stale Issue 1');
    assert.equal(lintStale.issues[0]?.issueType, 'stale_wiki_page', 'E stale_wiki_page');
    assert.equal(lintStale.issues[0]?.status, 'open', 'E stale open');
    const staleIssueId = lintStale.issues[0].id;

    // 周期 Lint checkpoint：崩溃恢复续跑、不重复 Issue
    database.prepare(
      `INSERT INTO knowledge_formal_relations (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id, created_change_set_id, end_reason, created_at)
       VALUES ('rel-ghost-periodic', 'global', 'derived_from', 'knowledge_note', ?, 'source', 'ghost-source-periodic', ?, '', ?)`
    ).run(a.noteIds['agentforge-v2-multi-router'], seedChangeSetId, NOW());
    const issuesBeforePeriodic = count(database, 'knowledge_health_issues');
    const changeSetsBeforePeriodic = count(database, 'knowledge_change_sets');
    const begin1 = beginPeriodicLint(database, { workspaceId: WS, scope: 'global', pageSize: 20, resume: false });
    assert.equal(begin1.resumed, false, 'E 周期开始（新 run）');
    const runId = begin1.checkpoint.runId;
    let step1 = runPeriodicLintStep(database);
    assert.ok(step1.counts.repairsApplied >= 1, 'E 周期步 1 修复 rel-ghost-periodic');
    // 模拟崩溃：ChangeSet 已提交但 checkpoint 未推进
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(JSON.stringify(begin1.checkpoint), NOW(), 'knowledge_lint_checkpoint_v1');
    const retry1 = runPeriodicLintStep(database);
    assert.equal(count(database, 'knowledge_change_sets'), changeSetsBeforePeriodic + 1, 'E 崩溃重试零新增 ChangeSet');
    assert.equal(count(database, 'knowledge_health_issues'), issuesBeforePeriodic + 1, 'E 崩溃重试零新增 Issue');
    const resumed = beginPeriodicLint(database, { workspaceId: WS, scope: 'global', pageSize: 20, resume: true });
    assert.equal(resumed.resumed, true, 'E resume 续同一 run');
    assert.equal(resumed.checkpoint.runId, runId, 'E resume 同 runId');
    let guard = 0;
    let cp = resumed.checkpoint;
    while (cp.status === 'running') {
      guard += 1;
      if (guard > 300) throw new Error(`E 周期 Lint 未在步数上限内完成（phase=${cp.phase} step=${cp.step}）`);
      cp = runPeriodicLintStep(database).checkpoint;
    }
    assert.equal(cp.status, 'completed', 'E 周期完成');
    assert.ok(cp.counts.scannedObjects > 0, 'E 周期五阶段扫描');
    const issuesAfterPeriodic = count(database, 'knowledge_health_issues');
    // 第二轮完整周期：重复扫描不重复 Issue
    const begin2 = beginPeriodicLint(database, { workspaceId: WS, scope: 'global', pageSize: 50, resume: false });
    let guard2 = 0;
    let cp2 = begin2.checkpoint;
    while (cp2.status === 'running') {
      guard2 += 1;
      if (guard2 > 100) throw new Error('E 第二轮周期未完成');
      cp2 = runPeriodicLintStep(database).checkpoint;
    }
    assert.equal(cp2.status, 'completed', 'E 第二轮周期完成');
    assert.equal(count(database, 'knowledge_health_issues'), issuesAfterPeriodic, 'E 第二轮零新增 Issue');
    assert.equal(getHealthIssue(database, conflictIssueId)?.status, 'open', 'E 冲突 Issue 全程 open（不自动裁决）');
    assert.equal(getHealthIssue(database, brokenEvIssueId)?.status, 'open', 'E broken 证据 Issue 保持 open');
    cancelPeriodicLint(database);
    assert.equal(getPeriodicLintCheckpoint(database), null, 'E checkpoint 已取消');
    summary.scenarios.E = {
      conflictIssueId, conflictStatus: 'open', brokenEvidenceIssueId: brokenEvIssueId, brokenEvidenceStatus: 'open',
      repairedRelationId: 'rel-ghost-e2e', repairIssueId: lintRepair.issues[0]?.id, repairReceiptId: lintRepair.receipt?.id,
      staleIssueId, staleStatus: 'open',
      periodic: { runId, completed: true, scannedObjects: cp.counts.scannedObjects, crashRetryZeroWrite: true, secondRoundZeroNewIssues: true, canceled: true }
    };

    // ===================================================================
    // F. Store：并发 beforeRevision 首成第二零写、restore 追加版本；弱 Source 零 Note
    // ===================================================================
    const weakSource = upsertSource(database, { originalUrl: 'https://news.example/agentforge-weak', title: 'AgentForge 复述', summary: '无新增信息的复述。' });
    const notesBeforeWeak = count(database, 'knowledge_notes');
    const versionsBeforeWeak = count(database, 'knowledge_note_versions');
    const weak = compileSourceKnowledge(database, {
      workspaceId: WS, sourceId: weakSource.id, sourceRevision: weakSource.revision, topicId: topic.id,
      reason: '弱 Source：纯复述零 Note',
      requestId: sourceCompileRequestId(weakSource.id, weakSource.revision),
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', locator: 'L1-2', valueRationale: '纯复述检查' }
      ]
    });
    assert.equal(weak.ok, true, 'F 弱 Source ok');
    assert.equal(weak.counts.notesCreated, 0, 'F 弱 Source 零 Note');
    assert.equal(weak.counts.notesSkippedLowValue, 1, 'F 弱 Source skipped=1');
    assert.equal(weak.counts.wikiPagesCompiled, 0, 'F 弱 Source 零 Wiki');
    assert.equal(count(database, 'knowledge_notes'), notesBeforeWeak, 'F 弱 Source 零 Note 落库');
    assert.equal(count(database, 'knowledge_note_versions'), versionsBeforeWeak, 'F 弱 Source 零版本');
    assert.ok(weak.receipt?.failures?.some((f) => f.startsWith('skipped:agentforge-v2-multi-router')), 'F 回执说明跳过');

    // 并发 beforeRevision：同基两个编译 → 首成第二零写
    applyKnowledgeChangeSet(database, csMeta('e2e-conc-v1'), {
      notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', version: { statement: 'V1 表述', conclusionStatus: 'unverified', evidenceLevel: 'none' } }]
    });
    const concV1 = getKnowledgeNote(database, 'note-conc');
    applyKnowledgeChangeSet(database, csMeta('e2e-conc-v2'), {
      notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 1, version: { statement: 'V2 加强', conclusionStatus: 'supported', evidenceLevel: 'corroborated', changeType: 'strengthened' } }]
    });
    applyKnowledgeChangeSet(database, csMeta('e2e-conc-v3a'), {
      notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 2, version: { statement: 'V3A', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }]
    });
    const versionsAfterA = count(database, 'knowledge_note_versions');
    expectThrowsCode('F 并发旧 revision 拒绝', () => {
      applyKnowledgeChangeSet(database, csMeta('e2e-conc-v3b'), {
        notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 2, version: { statement: 'V3B 不应落库', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }]
      });
    }, 'REVISION_CONFLICT');
    assert.equal(count(database, 'knowledge_note_versions'), versionsAfterA, 'F 冲突方零新增版本');
    const concV3 = getKnowledgeNote(database, 'note-conc');
    assert.equal(concV3.version.statement, 'V3A', 'F 首成版本未被覆盖');
    assert.equal(concV3.note.revision, 3, 'F 当前 revision=3');

    // restore 追加版本：恢复 V1 → V4，V1..V4 全保留可读
    applyKnowledgeChangeSet(database, csMeta('e2e-conc-restore'), {
      notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 3, version: { restoreFromVersionId: concV1.version.id, changeReason: '用户要求恢复 V1' } }]
    });
    const concV4 = getKnowledgeNote(database, 'note-conc');
    assert.equal(concV4.note.revision, 4, 'F 恢复后 revision=4');
    assert.equal(concV4.version.changeType, 'restored', 'F 恢复 changeType=restored');
    assert.equal(concV4.version.restoredFromVersionId, concV1.version.id, 'F 记录 restoredFromVersionId');
    assert.equal(concV4.version.statement, 'V1 表述', 'F V4 内容来自 V1');
    const concVersions = listKnowledgeNoteVersions(database, 'note-conc', {});
    assert.equal(concVersions.items.length, 4, 'F V1..V4 全部保留');
    assert.ok(concVersions.items.some((v) => v.versionNumber === 1) && concVersions.items.some((v) => v.versionNumber === 4), 'F 版本链完整');
    summary.scenarios.F = {
      weakSource: { sourceId: weakSource.id, notesCreated: 0, skippedLowValue: 1, receiptId: weak.receipt?.id },
      concurrency: { firstSucceededStatement: 'V3A', secondRejectedCode: 'REVISION_CONFLICT', versionsAfterConflict: versionsAfterA },
      restore: { revision: 4, changeType: 'restored', restoredFromVersionId: concV1.version.id, versionsKept: 4 }
    };

    // ===================================================================
    // G. 边界：链不丢 / 单 Topic 单 Wiki / data-root 隔离 / Canvas 不删正式对象 / 不可变 / dispatcher
    // ===================================================================
    // G-1 所有 ID/链不丢（join 完整性）
    const orphanWikiAdopted = database.prepare(`
      SELECT pv.id FROM knowledge_wiki_page_versions pv, json_each(pv.adopted_note_version_ids_json) j
      LEFT JOIN knowledge_note_versions nv ON nv.id = j.value
      WHERE nv.id IS NULL`).all();
    assert.equal(orphanWikiAdopted.length, 0, 'G Wiki 采纳 Note 版本全部存在');
    const orphanEvidence = database.prepare(`
      SELECT el.id FROM knowledge_evidence_links el
      LEFT JOIN knowledge_note_versions nv ON nv.id = el.knowledge_note_version_id
      WHERE nv.id IS NULL`).all();
    assert.equal(orphanEvidence.length, 0, 'G 证据 → Note 版本链完整');
    const orphanEvidenceObj = database.prepare(`
      SELECT el.id, el.evidence_object_type AS t, el.evidence_object_id AS id FROM knowledge_evidence_links el
      LEFT JOIN knowledge_note_versions nv ON nv.id = el.evidence_object_id AND el.evidence_object_type = 'knowledge_note_version'
      LEFT JOIN knowledge_wiki_page_versions wv ON wv.id = el.evidence_object_id AND el.evidence_object_type = 'wiki_page_version'
      WHERE el.evidence_object_type IN ('knowledge_note_version','wiki_page_version') AND nv.id IS NULL AND wv.id IS NULL`).all();
    assert.equal(orphanEvidenceObj.length, 0, 'G 版本级证据对象全部存在');
    const orphanReceipts = database.prepare(`
      SELECT r.id FROM knowledge_update_receipts r
      LEFT JOIN knowledge_change_sets cs ON cs.id = r.change_set_id
      WHERE cs.id IS NULL`).all();
    assert.equal(orphanReceipts.length, 0, 'G 回执 → ChangeSet 链完整');
    const brokenNoteChain = database.prepare(`
      SELECT n.id FROM knowledge_notes n
      LEFT JOIN knowledge_note_versions nv ON nv.id = n.current_version_id
      WHERE n.current_version_id IS NOT NULL AND nv.id IS NULL`).all();
    assert.equal(brokenNoteChain.length, 0, 'G Note → 当前版本链完整');
    const brokenPageChain = database.prepare(`
      SELECT p.id FROM knowledge_wiki_pages p
      LEFT JOIN knowledge_wiki_page_versions pv ON pv.id = p.current_version_id
      WHERE p.current_version_id IS NOT NULL AND pv.id IS NULL`).all();
    assert.equal(brokenPageChain.length, 0, 'G Wiki 页 → 当前版本链完整');

    // G-2 单 Topic 单 Wiki
    const perTopic = database.prepare(`
      SELECT subject_id AS subjectId, count(*) AS c FROM knowledge_wiki_pages
      WHERE lifecycle = 'active' AND subject_type = 'topic' GROUP BY subject_id`).all();
    assert.ok(perTopic.every((row) => Number(row.c) === 1), `G 每 Topic 恰 1 Wiki：${JSON.stringify(perTopic)}`);
    assert.equal(perTopic.length, 2, 'G 两个 Topic 各 1 Wiki');

    // G-3 data-root A/B 隔离
    expectThrowsCode('G 跨 data-root 拒绝', () => {
      applyKnowledgeChangeSet(database, { ...csMeta('e2e-cross-root'), workspaceId: 'ws-b' }, {
        freeNotes: [{ id: 'fn-cross-e2e', scope: 'global', sourceNature: 'user_quick_note', body: '不得跨 root' }]
      });
    }, 'WORKSPACE_MISMATCH');
    assert.equal(count(database, 'knowledge_free_notes'), 1, 'G 跨 root 零写');
    expectThrowsCode('G 跨 root Query 写回拒绝', () => {
      writebackQueryKnowledge(database, {
        workspaceId: 'ws-b', scope: 'global', conversationId: 'conv-other', question: 'q',
        requestId: knowledgeQueryWritebackRequestId('conv-other', 'q'), classification: 'restatement',
        answerSummary: 'x', readWikiVersionIds: [wikiV3Id], readNoteVersionIds: [], readEvidenceIds: []
      });
    }, 'WORKSPACE_MISMATCH');
    const dbB = migrateDatabase(path.join(root, 'ws-b.db'));
    dbB.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-b', ?, ?, 1)").run(NOW(), NOW());
    assert.equal(count(dbB, 'knowledge_change_sets'), 0, 'G data-root B 零 ChangeSet');
    assert.equal(count(dbB, 'knowledge_notes'), 0, 'G data-root B 零 Note');
    assert.equal(count(dbB, 'knowledge_wiki_pages'), 0, 'G data-root B 零 Wiki');
    dbB.close();

    // G-4 Canvas 删除不删正式对象
    const canvasDel = createKnowledgeCanvas(database, { title: '删除测试画布', topicId: topic.id });
    const nodeDelTopic = addKnowledgeCanvasNode(database, { canvasId: canvasDel.id, objectType: 'topic', objectId: topic.id, x: 0, y: 0 });
    const nodeDelReview = addKnowledgeCanvasNode(database, { canvasId: canvasDel.id, objectType: 'review', objectId: reviewId, x: 10, y: 10 });
    removeKnowledgeCanvasNode(database, { canvasId: canvasDel.id, nodeId: nodeDelTopic.id, expectedRevision: 1 });
    assert.ok(!database.prepare('SELECT id FROM knowledge_canvas_nodes WHERE id = ?').get(nodeDelTopic.id), 'G Canvas 节点已删');
    assert.ok(database.prepare('SELECT id FROM topics WHERE id = ?').get(topic.id), 'G 正式 Topic 未删');
    assert.ok(database.prepare('SELECT id FROM reviews WHERE id = ?').get(reviewId), 'G 正式 Review 未删');
    assert.ok(getKnowledgeNote(database, caseNote.id), 'G 正式 case Note 未删');
    assert.ok(getWikiPage(database, topicPagesA.items[0].id), 'G 正式 Wiki 未删');
    const projDel = getKnowledgeCanvasProjection(database, { canvasId: canvasDel.id, mode: 'relation' });
    assert.equal(projDel.nodes.length, 1, 'G Canvas 剩余 1 节点');
    assert.equal(projDel.nodes[0].id, nodeDelReview.id, 'G 剩余节点为 Review 节点');

    // G-5 不可变版本
    const immutVersion = getKnowledgeNote(database, 'note-conc').version;
    expectThrowsCode('G 版本 UPDATE 拒绝', () => database.prepare('UPDATE knowledge_note_versions SET statement = ? WHERE id = ?').run('篡改', immutVersion.id));
    expectThrowsCode('G 版本 DELETE 拒绝', () => database.prepare('DELETE FROM knowledge_note_versions WHERE id = ?').run(immutVersion.id));
    expectThrowsCode('G 正式 Note DELETE 拒绝', () => database.prepare('DELETE FROM knowledge_notes WHERE id = ?').run('note-conc'));
    const anyCs = database.prepare('SELECT id FROM knowledge_change_sets LIMIT 1').get();
    expectThrowsCode('G ChangeSet 不可变', () => database.prepare('UPDATE knowledge_change_sets SET reason = ? WHERE id = ?').run('篡改', anyCs.id));
    expectThrowsCode('G FreeNote 原文不可变', () => database.prepare('UPDATE knowledge_free_notes SET body = ? WHERE id = ?').run('改写原文', experience.freeNoteId));
    assert.equal(getKnowledgeFreeNote(database, experience.freeNoteId)?.body, '我们团队实际跑下来，AgentForge v2 的批量生成在小红书图片场景要先过一遍人工抽检再发布。', 'G FreeNote 原文保留');

    // G-6 生产 dispatcher 写路径 + write-guard（独立 runtime root）
    const rtRoot = await mkdtemp(path.join(os.tmpdir(), 'wmb-5218-rt-'));
    let runtime = null;
    try {
      const rtDb = migrateDatabase(path.join(rtRoot, 'wmb.db'));
      rtDb.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-rt', ?, ?, 1)").run(NOW(), NOW());
      ensureOfficialWorkspaceProfile(rtDb, 'official.ai');
      rtDb.close();
      runtime = ActiveWorkspaceRuntime.open(rtRoot, { openDatabase: migrateDatabase, createEpoch: () => 'e2e-epoch-1' });
      const envelope = createCommandEnvelope({
        workspaceId: runtime.identity.workspaceId,
        runtimeEpoch: runtime.identity.runtimeEpoch,
        command: KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
        requestId: 'e2e-rt-apply-1',
        actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' },
        input: {
          entities: [{ scope: 'global', entityType: 'organization', canonicalKey: 'e2e-rt-org', canonicalName: 'E2E RT Org' }],
          receipts: [{ triggerType: 'ingest', requestId: 'e2e-rt-apply-1', summary: 'dispatcher 路径验收', counts: { entities: 1 } }]
        },
        boundIdentity: { entityType: 'knowledge_change_set', requestId: 'e2e-rt-apply-1' }
      });
      const receipt = await runtime.dispatchCommand(envelope, () => {
        const result = applyKnowledgeChangeSet(runtime.database, {
          workspaceId: runtime.identity.workspaceId, requestId: 'e2e-rt-apply-1', reason: 'dispatcher 路径验收',
          triggerSource: 'user', resolutionMode: 'manual_correction', createdBy: 'user'
        }, {
          entities: [{ scope: 'global', entityType: 'organization', canonicalKey: 'e2e-rt-org', canonicalName: 'E2E RT Org' }],
          receipts: [{ triggerType: 'ingest', requestId: 'e2e-rt-apply-1', summary: 'dispatcher 路径验收', counts: { entities: 1 } }]
        }, false);
        return { data: result, entityType: 'knowledge_change_set', entityId: result.changeSetId, readback: result };
      });
      assert.equal(receipt.ok, true, 'G dispatcher 命令 ok');
      assert.equal(receipt.command, KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND, 'G 命令常量一致');
      assert.equal(count(runtime.database, 'command_receipts'), 1, 'G 审计收据 1');
      assert.equal(count(runtime.database, 'operation_log'), 1, 'G operation_log 1');
      assert.equal(count(runtime.database, 'knowledge_change_sets'), 1, 'G ChangeSet 1');
      assert.equal(getUpdateReceiptByRequest(runtime.database, runtime.identity.workspaceId, 'e2e-rt-apply-1')?.summary, 'dispatcher 路径验收', 'G 回执读回');
      // write-guard：绕过 dispatcher 直写被拒
      expectThrowsCode('G write-guard 直写拒绝', () => runtime.database.prepare(
        `INSERT INTO knowledge_free_notes (id, scope, source_nature, body, processing_state, revision, created_at, updated_at)
         VALUES ('bypass-1', 'global', 'user_quick_note', 'x', 'captured', 1, ?, ?)`
      ).run(NOW(), NOW()));
      assert.equal(count(runtime.database, 'knowledge_free_notes'), 0, 'G 直写零落库');
      await runtime.stop({ drain: false });
      runtime = null;
    } finally {
      await runtime?.stop({ drain: false }).catch(() => {});
      await rm(rtRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    summary.scenarios.G = {
      chainIntegrity: { orphanWikiAdopted: 0, orphanEvidence: 0, orphanReceipts: 0, orphanNoteCurrent: 0, orphanPageCurrent: 0 },
      singleTopicSingleWiki: perTopic.length === 2 && perTopic.every((row) => Number(row.c) === 1),
      dataRootIsolation: { crossRootWriteRejected: true, dataRootBCounts: { changeSets: 0, notes: 0, wikiPages: 0 } },
      canvasDelete: { canvasId: canvasDel.id, formalTopicStillExists: true, formalReviewStillExists: true, formalCaseNoteStillExists: true, formalWikiStillExists: true },
      immutableVersions: true, immutableFreeNoteBody: true,
      dispatcher: { command: KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND, commandReceipts: 1, changeSets: 1, receiptReadBack: 'dispatcher 路径验收', directSqlWriteBlocked: true }
    };
  } finally {
    database?.close();
  }

  console.log('WMB-5218 E2E PASS', JSON.stringify(summary));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

