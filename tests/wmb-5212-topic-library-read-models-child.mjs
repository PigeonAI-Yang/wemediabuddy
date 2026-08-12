/**
 * WMB-5212 主题与资料库后端读模型契约验收（子进程，真实 SQLite）。
 * 验收：
 * - 同一 Topic ID：Topic Wiki 详情返回既有 topics.id，wiki.subjectId=body.topicId=topicId；
 * - stale/failed/disputed/inference 读回：risks 计数 + compile_status + 正文结论；
 * - Source receipt→Topic：Source 详情回执 impact.sourceId 命中；Topic 详情回执
 *   affectedTopics 命中；双向同一 receipt；
 * - 有界分页：versions/receipts/evidence/health/usage 全有界且 hasMore 正确；
 * - 过滤扩展：listWikiPages subject、listEvidenceLinks object、listUpdateReceipts
 *   topicId/sourceId、listHealthIssues severity/affectedObject、usage 版本引用；
 * - 深链：topic→wiki page（无编译页回退 topicId）、source→library、知识对象；
 * - Inbox：rediscovery 三池 + 每项 latestReceipt。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { listRediscovery, upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import {
  applyKnowledgeChangeSet, getWikiPage, listHealthIssues, listKnowledgeEvidenceLinks,
  listUpdateReceipts, listWikiPages
} from '../src/main/knowledge-flywheel.ts';
import { createKnowledgeUsage, listKnowledgeUsageRecords } from '../src/main/knowledge-usage.ts';
import { getSourceKnowledgeDetail, getTopicWikiDetail, resolveKnowledgeDeepLink } from '../src/main/knowledge-topic-library.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5212-db-'));
const directoryPath = path.join(directory, 'wmb.db');
const now = () => new Date().toISOString();

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}

const database = migrateDatabase(directoryPath);
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(now(), now());

// ============ 真实 Source + 已关联 Topic ============
const source = upsertSource(database, {
  originalUrl: 'https://news.example/agentforge-v2',
  title: 'AgentForge 发布 v2：多模型路由',
  summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
  author: 'News Desk'
});
database.prepare('UPDATE source_items SET priority = 1 WHERE id = ?').run(source.id);
const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
const topicNoWiki = upsertKnowledgeTopic(database, { title: '尚未编译主题' });
database.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, 'primary', ?, ?)`)
  .run(topic.id, source.id, now(), now());
check('真实 Source 已保存（r1）+ Topic 已保存', source.revision === 1 && Boolean(topic.id) && Boolean(topicNoWiki.id));

const base = {
  workspaceId: 'ws-a', sourceId: source.id, topicId: topic.id,
  entities: [
    { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', aliases: ['AF'], valueRationale: '产品发布主体' }
  ]
};

// ============ A. r1 首编译：2 Note + 2 证据 + Wiki V1 ============
const a = compileSourceKnowledge(database, {
  ...base,
  sourceRevision: source.revision,
  reason: '首次摄取',
  topicCompile: { summary: 'AI Agent 工具链主题编译' },
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', entityKeys: ['agentforge'], valueRationale: '可验证产品事实' },
    { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用方法' }
  ],
  requestId: sourceCompileRequestId(source.id, source.revision)
});
check('A 首编译成功且非重放', a.ok === true && a.replay === false && a.counts.wikiPagesCompiled === 1);

// ============ B. r2 二次摄取：真实争议（disputed 保留）+ 限域 ============
const sourceV2 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 更新：平台限制与争议' });
check('B 同 Source 更新到 r2', sourceV2.id === source.id && sourceV2.revision === 2);
const b = compileSourceKnowledge(database, {
  ...base,
  sourceRevision: sourceV2.revision,
  reason: '摄取争议报道：限域旧 Method、保留争议',
  topicCompile: { summary: 'AI Agent 工具链主题编译（v2 更新）' },
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-xiaohongshu-claim', statement: 'AgentForge v2 可用于小红书运营场景的批量内容生成', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-9', entityKeys: ['agentforge'], valueRationale: '平台适用事实' },
    { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由的样本先覆盖目标平台（当前仅 xiaohongshu 验证）', conclusionStatus: 'supported', evidenceLevel: 'corroborated', appliesTo: 'xiaohongshu', changeType: 'qualified', changeReason: '新证据限制平台适用范围', locator: 'L22-27', relation: 'qualifies', entityKeys: ['agentforge'], valueRationale: '改变既有方法适用范围' },
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', changeType: 'contradicted', changeReason: '新报道与首发资料分歧，保留争议', locator: 'L30-33', relation: 'contradicts', entityKeys: ['agentforge'], valueRationale: '可信来源实质分歧' }
  ],
  requestId: sourceCompileRequestId(source.id, sourceV2.revision)
});
check('B 争议编译成功（kept_disputed）', b.ok === true && b.counts.noteVersionsCreated === 3 && b.counts.wikiPagesCompiled === 1);

// ============ C. r3 第三次：inference 推断 + question 待研究 ============
const sourceV3 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 后续：市场反馈' });
const c = compileSourceKnowledge(database, {
  ...base,
  sourceRevision: sourceV3.revision,
  reason: '摄取市场反馈：推断 + 待研究问题',
  topicCompile: { summary: 'AI Agent 工具链主题编译（市场反馈）' },
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-sme-inference', statement: 'AgentForge v2 可能加速中小团队工具选型', conclusionStatus: 'inference', evidenceLevel: 'insufficient', locator: 'L50-55', entityKeys: ['agentforge'], valueRationale: '基于市场反馈的推断' },
    { kind: 'question', canonicalKey: 'agentforge-v2-pricing-question', statement: 'AgentForge v2 企业版定价何时公开？', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L56-58', valueRationale: '待研究' }
  ],
  requestId: sourceCompileRequestId(source.id, sourceV3.revision)
});
check('C 推断 + 问题编译成功', c.ok === true && c.counts.noteVersionsCreated === 2 && c.counts.wikiPagesCompiled === 1);

const page = getWikiPage(database, b.wikiPageId ?? a.wikiPageId ?? '');
check('C Wiki 当前版本为 V3', page?.version?.versionNumber === 3);
const pageId = page.page.id;
const currentVersionId = page.version.id;
const adoptedVersionIds = page.version.adoptedNoteVersionIds;
check('C 当前版本采纳 >= 5 个 Note 版本', adoptedVersionIds.length >= 5);
check('C Wiki 正文含争议/推断/问题',
  page.version.body.retainedDisputes.length === 1
  && page.version.body.keyConclusions.some((k) => k.conclusionStatus === 'inference')
  && page.version.body.pendingQuestions.length === 1);

// ============ D. Topic Wiki 详情：同一 Topic ID + 全区块 + risks 读回 ============
const detail = getTopicWikiDetail(database, { topicId: topic.id });
check('D 同一 Topic ID（topic.id / subjectId / body.topicId 一致）',
  detail.topicId === topic.id && detail.topic?.id === topic.id
  && detail.wiki?.page?.subjectId === topic.id && detail.wiki.body?.topicId === topic.id);
check('D 主题身份 + 计数', detail.topic?.title === 'AI Agent 工具链' && detail.topic.sourceCount === 1);
check('D wiki current + compileStatus current',
  detail.wiki?.page?.compileStatus === 'current' && detail.wiki.current?.versionNumber === 3);
check('D 版本时间线 V3→V1（3 个版本）',
  detail.versions.items.length === 3 && detail.versions.items[0].versionNumber === 3
  && detail.versions.items[2].versionNumber === 1 && detail.versions.hasMore === false);
check('D 最近变化回执 3 条（affectedTopics 命中，同一 source）',
  detail.receipts.items.length === 3 && detail.receipts.total === 3
  && detail.receipts.items.every((r) => r.impact.sourceId === source.id)
  && detail.receipts.items.every((r) => r.affectedTopics.includes(topic.id)));
check('D 证据非空且带 note 一句话',
  detail.evidence.items.length >= 1 && detail.evidence.items.every((e) => e.noteStatement.length > 0));
check('D 待研究含问题', detail.questions.includes('AgentForge v2 企业版定价何时公开？'));
check('D dossier 八类计数存在', detail.dossierCounts !== null && detail.dossierCounts.sources === 1
  && Object.keys(detail.dossierCounts).length === 8);
check('D risks：disputed/inference 读回，非 stale/failed',
  detail.risks.disputed >= 1 && detail.risks.inference >= 1
  && detail.risks.stale === false && detail.risks.failed === false);
check('D health 暂无（未创建健康问题）', detail.healthIssues.items.length === 0);

// ============ E. 创作影响：Usage Record 固定引用当前 Wiki 版本 ============
// Usage 记录要求产物真实存在：先建 plan + plan_item + creative_brief。
const nowIso = now();
database.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision)
  VALUES ('plan-1', '2026-08-12', 'Asia/Shanghai', '选题计划', 1, ?, ?, 1)`).run(nowIso, nowIso);
database.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience,
  angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance,
  effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
  VALUES ('plan-item-1', 'plan-1', ?, '选题 A', 1, '为什么现在', '时效', '受众', '角度', '观点', '[]', '[]', '', '', '', '', ?, '[]', '[]', 0, ?, ?, 1)`)
  .run(topic.id, JSON.stringify([source.id]), nowIso, nowIso);
database.prepare(`INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision)
  VALUES ('project-1', ?, 'plan-item-1', '内容项目', ?, ?, 1)`).run(topic.id, nowIso, nowIso);
database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at)
  VALUES ('content-ver-1', 'project-1', '正文', 1, ?)`).run(nowIso);
const usage = createKnowledgeUsage(database, {
  workspaceId: 'ws-a', requestId: 'usage-brief-1', reason: '创作简报采用当前 Wiki 认识', createdBy: 'pi'
}, {
  package: {
    scope: 'global', stage: 'creative_brief', topicId: topic.id, sourceIds: [source.id], planItemId: 'plan-item-1', projectId: 'project-1',
    wikiPageVersionIds: [currentVersionId], noteVersionIds: [adoptedVersionIds[0]],
    selectionReasons: ['当前综合直接支撑选题'], compilerSchemaVersion: 'v1'
  },
  records: [
    { outputObjectType: 'content_version', outputObjectId: 'content-ver-1', versionKind: 'wiki_page', versionId: currentVersionId, usageKind: 'paraphrased', reason: '正文采用当前综合', actor: 'pi' },
    { outputObjectType: 'plan_item', outputObjectId: 'plan-item-1', versionKind: 'note', versionId: adoptedVersionIds[0], usageKind: 'reasoning_basis', reason: '选题依据', actor: 'pi' }
  ]
});
check('E Usage 包创建且非重放', usage.replay === false && usage.recordIds.length === 2);
const detailWithUsage = getTopicWikiDetail(database, { topicId: topic.id, usageLimit: 5 });
check('E 创作影响含 Usage Record（wiki 版本命中）',
  detailWithUsage.creationImpact.items.length === 2
  && detailWithUsage.creationImpact.items.some((e) => e.knowledgeVersionId === currentVersionId && e.knowledgeVersionKind === 'wiki_page' && e.used === true)
  && detailWithUsage.creationImpact.items.some((e) => e.knowledgeVersionKind === 'note'));
check('E usage 过滤 wikiPageVersionId / noteVersionId',
  listKnowledgeUsageRecords(database, { wikiPageVersionId: currentVersionId }).items.length === 1
  && listKnowledgeUsageRecords(database, { noteVersionId: adoptedVersionIds[0] }).items.length === 1);

// ============ F. 健康问题 + 批注（ChangeSet 写入后读回） ============
const healthCs = applyKnowledgeChangeSet(database, {
  workspaceId: 'ws-a', requestId: 'cs-health-1', reason: '健康检查', createdBy: 'system', triggerSource: 'lint', scope: 'global', resolutionMode: 'none'
}, {
  healthIssues: [
    { op: 'create', scope: 'global', issueType: 'stale_wiki_page', affectedObjectType: 'wiki_page', affectedObjectId: pageId, severity: 'high', suggestedAction: '重新编译', evidence: { brokenBy: 'r3' } },
    { op: 'create', scope: 'global', issueType: 'unreturned_review', affectedObjectType: 'source', affectedObjectId: source.id, severity: 'medium', suggestedAction: '补复盘', evidence: { sourceId: source.id } }
  ]
});
check('F 健康 ChangeSet 成功', healthCs.changeSetId.length > 0);
const annotationCs = applyKnowledgeChangeSet(database, {
  workspaceId: 'ws-a', requestId: 'cs-ann-1', reason: '用户批注', createdBy: 'user', triggerSource: 'user', scope: 'global', resolutionMode: 'none'
}, {
  annotations: [
    { op: 'create', scope: 'global', targetType: 'knowledge_note_version', targetId: adoptedVersionIds[0], quotedText: '多模型路由', intent: 'qualify', body: '注意：企业版才支持', userIdentity: 'tester' }
  ]
});
check('F 批注 ChangeSet 成功', annotationCs.changeSetId.length > 0);

const detailHealth = getTopicWikiDetail(database, { topicId: topic.id, healthLimit: 5 });
check('F Topic 详情健康含 wiki 页问题（affectedObjectId=pageId）',
  detailHealth.healthIssues.items.length === 1
  && detailHealth.healthIssues.items[0].affectedObjectId === pageId
  && detailHealth.healthIssues.items[0].severity === 'high');
check('F listHealthIssues 过滤 severity/affectedObject',
  listHealthIssues(database, { severity: 'high' }).items.length === 1
  && listHealthIssues(database, { affectedObjectType: 'source', affectedObjectId: source.id }).items.length === 1
  && listHealthIssues(database, { affectedObjectType: 'source', affectedObjectId: source.id }).items[0].issueType === 'unreturned_review');

// ============ G. Source 详情：Raw 关联 + Evidence + 回执 + 健康 + 批注 ============
const sourceDetail = getSourceKnowledgeDetail(database, { sourceId: source.id });
check('G Source 行 + 关联 Topic',
  sourceDetail.source?.id === source.id && sourceDetail.source?.title === 'AgentForge v2 后续：市场反馈'
  && sourceDetail.topics.length === 1 && sourceDetail.topics[0].id === topic.id);
check('G 证据按 objectType/objectId 命中（>= 6 条，带 note 一句话）',
  sourceDetail.evidence.items.length >= 6
  && sourceDetail.evidence.items.every((e) => e.evidenceObjectId === source.id && e.noteStatement.length > 0)
  && sourceDetail.evidence.total === sourceDetail.evidence.items.length);
check('G Source 回执 3 条（impact.sourceId 命中，同一 Topic）',
  sourceDetail.receipts.items.length === 3
  && sourceDetail.receipts.items.every((r) => r.impact.sourceId === source.id)
  && sourceDetail.receipts.items[0].affectedTopics.includes(topic.id));
check('G Source 健康含 source 作用域问题', sourceDetail.healthIssues.items.length === 1
  && sourceDetail.healthIssues.items[0].affectedObjectType === 'source');
check('G Source 批注命中（Note 版本证据链）', sourceDetail.annotations.items.length === 1
  && sourceDetail.annotations.items[0].intent === 'qualify');
check('G listEvidenceLinks object 过滤',
  listKnowledgeEvidenceLinks(database, { evidenceObjectType: 'source', evidenceObjectId: source.id }).items.length >= 6);
check('G listUpdateReceipts topicId/sourceId 过滤',
  listUpdateReceipts(database, { topicId: topic.id }).total === 3
  && listUpdateReceipts(database, { sourceId: source.id }).total === 3
  && listUpdateReceipts(database, { sourceId: 'ghost-source' }).total === 0);
check('G listWikiPages subject 过滤',
  listWikiPages(database, { subjectType: 'topic', subjectId: topic.id, pageType: 'topic', lifecycle: 'active' }).items.length === 1
  && listWikiPages(database, { subjectType: 'topic', subjectId: topic.id, lifecycle: 'active', compileStatus: 'current' }).items.length === 1);

// ============ H. 有界分页 ============
const bounded = getTopicWikiDetail(database, { topicId: topic.id, versionsLimit: 1, receiptsLimit: 1, evidenceLimit: 1, healthLimit: 1 });
check('H versions 有界且 hasMore', bounded.versions.items.length === 1 && bounded.versions.hasMore === true);
check('H receipts 有界且 hasMore', bounded.receipts.items.length === 1 && bounded.receipts.hasMore === true);
check('H evidence 有界且 hasMore', bounded.evidence.items.length === 1 && bounded.evidence.hasMore === true);
check('H health 有界', bounded.healthIssues.items.length === 1 && bounded.healthIssues.items[0].severity === 'high');

// ============ I. stale/failed 读回（ChangeSet 显式标记） ============
const staleCs = applyKnowledgeChangeSet(database, {
  workspaceId: 'ws-a', requestId: 'cs-stale-1', reason: '知识变化无法编译', createdBy: 'system', triggerSource: 'lint', scope: 'global', resolutionMode: 'none'
}, {
  wikiPages: [{
    id: pageId, scope: 'global', pageType: 'topic', canonicalKey: `wiki-topic:${topic.id}`,
    subjectType: 'topic', subjectId: topic.id, beforeRevision: page.page.revision,
    markStaleInstead: { reason: '新资料与旧结论冲突' }
  }]
});
check('I stale 标记成功', staleCs.changeSetId.length > 0);
const detailStale = getTopicWikiDetail(database, { topicId: topic.id });
check('I stale 读回（compileStatus + risks）',
  detailStale.wiki?.page?.compileStatus === 'stale' && detailStale.risks.stale === true);
check('I listWikiPages compileStatus 过滤（stale）',
  listWikiPages(database, { subjectId: topic.id, compileStatus: 'stale' }).items.length === 1);

const failedCs = applyKnowledgeChangeSet(database, {
  workspaceId: 'ws-a', requestId: 'cs-failed-1', reason: '编译运行失败', createdBy: 'system', triggerSource: 'lint', scope: 'global', resolutionMode: 'none'
}, {
  wikiPages: [{
    id: pageId, scope: 'global', pageType: 'topic', canonicalKey: `wiki-topic:${topic.id}`,
    subjectType: 'topic', subjectId: topic.id, beforeRevision: detailStale.wiki?.page?.revision,
    compileStatus: 'failed', compileNote: '编译进程超时'
  }]
});
check('I failed 标记成功', failedCs.changeSetId.length > 0);
const detailFailed = getTopicWikiDetail(database, { topicId: topic.id });
check('I failed 读回（compileStatus + risks，无半成品正文）',
  detailFailed.wiki?.page?.compileStatus === 'failed' && detailFailed.risks.failed === true
  && detailFailed.wiki?.page?.compileNote === '编译进程超时');

// ============ J. 深链 payload ============
const topicLink = resolveKnowledgeDeepLink(database, { objectType: 'topic', objectId: topic.id });
check('J topic 深链 → wiki page',
  topicLink.route === 'topic' && topicLink.targetType === 'topic_wiki'
  && topicLink.targetId === pageId && topicLink.hasWiki === true
  && topicLink.formalObjectId === pageId && topicLink.exists === true);
const noWikiLink = resolveKnowledgeDeepLink(database, { objectType: 'topic', objectId: topicNoWiki.id });
check('J 未编译 topic 深链回退 topicId（hasWiki=false）',
  noWikiLink.route === 'topic' && noWikiLink.targetId === topicNoWiki.id && noWikiLink.hasWiki === false && noWikiLink.exists === true);
const ghostTopic = resolveKnowledgeDeepLink(database, { objectType: 'topic', objectId: 'ghost-topic' });
check('J 幽灵 topic 深链 exists=false', ghostTopic.exists === false);
const sourceLink = resolveKnowledgeDeepLink(database, { objectType: 'source', objectId: source.id });
check('J source 深链 → library',
  sourceLink.route === 'library' && sourceLink.targetType === 'source'
  && sourceLink.targetId === source.id && sourceLink.exists === true);
const ghostSource = resolveKnowledgeDeepLink(database, { objectType: 'source', objectId: 'ghost-source' });
check('J 幽灵 source 深链 exists=false', ghostSource.exists === false);
const pageLink = resolveKnowledgeDeepLink(database, { objectType: 'wiki_page', objectId: pageId });
check('J wiki_page 深链 → knowledge_object',
  pageLink.route === 'object' && pageLink.targetType === 'knowledge_object'
  && pageLink.targetId === pageId && pageLink.formalObjectId === pageId && pageLink.exists === true);
const ghostObject = resolveKnowledgeDeepLink(database, { objectType: 'knowledge_note', objectId: 'ghost-note' });
check('J 幽灵知识对象深链 exists=false', ghostObject.exists === false);

// ============ K. Inbox：rediscovery 三池 + latestReceipt ============
const inbox = listRediscovery(database);
check('K unused 池含 Source 且 latestReceipt 命中（证据变化摘要）',
  inbox.unused.length >= 1 && inbox.unused.some((item) => item.id === source.id && item.latestReceipt !== null
    && item.latestReceipt.impact.sourceId === source.id));
check('K watching/pending 池结构存在', Array.isArray(inbox.watching) && Array.isArray(inbox.pending));

// ============ L. 无 Wiki 主题详情：wiki=null 不抛错 ============
const noWikiDetail = getTopicWikiDetail(database, { topicId: topicNoWiki.id });
check('L 未编译主题 wiki=null 且 topic 存在',
  noWikiDetail.wiki === null && noWikiDetail.topic?.id === topicNoWiki.id
  && noWikiDetail.dossierCounts !== null && noWikiDetail.versions.items.length === 0);
const ghostDetail = getTopicWikiDetail(database, { topicId: 'ghost-topic' });
check('L 幽灵主题 topic=null 且 wiki=null', ghostDetail.topic === null && ghostDetail.wiki === null);

database.close();
console.log(`WMB-5212 child: ${checks} checks passed`);
await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
