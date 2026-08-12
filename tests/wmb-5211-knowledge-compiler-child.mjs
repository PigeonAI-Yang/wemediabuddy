/**
 * WMB-5211 知识编译服务契约验收（子进程，真实 SQLite）。
 * 验收：Entity 零重复（canonicalKey 命中复用）；新 Claim（带原文 locator）；旧 Method 限域
 * （qualified 追加版本）；真实争议（contradicted → disputed，kept_disputed 保留双方）；
 * locator EvidenceLink；唯一 Topic Wiki 重编译；Receipt；同 source revision/request 幂等重放；
 * 低价值零知识（零 Note/Wiki 仍持久 receipt）；失败零写（陈旧 revision / 无效候选 /
 * 未解析 Entity key / kind 冲突 / 幽灵 Source / Topic / 重复候选）；compileSavedSource
 * 在真实 Source 保存后显式触发。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, compileSavedSource, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import {
  getChangeSet, getKnowledgeNote, getUpdateReceiptByRequest, getWikiPage,
  listKnowledgeEntities, listKnowledgeEvidenceLinks, listKnowledgeNoteVersions, listWikiPages
} from '../src/main/knowledge-flywheel.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5211-db-'));
const directoryPath = path.join(directory, 'wmb.db');

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
async function expectError(label, fn, code) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    if (code) {
      const actual = error?.code ?? '';
      if (actual !== code) throw new Error(`FAIL [${checks}] ${label} — 期望错误码 ${code}，实际 ${actual ?? error?.message}`);
    }
    return;
  }
  throw new Error(`FAIL [${checks}] ${label} — 未抛出 ${code ?? '错误'}`);
}
function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function snapshot() {
  return {
    changeSets: count(database, 'knowledge_change_sets'),
    receipts: count(database, 'knowledge_update_receipts'),
    entities: count(database, 'knowledge_entities'),
    notes: count(database, 'knowledge_notes'),
    noteVersions: count(database, 'knowledge_note_versions'),
    wikiPages: count(database, 'knowledge_wiki_pages'),
    wikiVersions: count(database, 'knowledge_wiki_page_versions'),
    evidenceLinks: count(database, 'knowledge_evidence_links')
  };
}
function assertNoWrite(label, before) {
  const after = snapshot();
  for (const key of Object.keys(before)) {
    check(`${label} 零写（${key}）`, after[key] === before[key], `${before[key]} → ${after[key]}`);
  }
}

const database = migrateDatabase(directoryPath);
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(new Date().toISOString(), new Date().toISOString());

// ============ 真实 Source + 已关联 Topic ============
const source = upsertSource(database, {
  originalUrl: 'https://news.example/agentforge-v2',
  title: 'AgentForge 发布 v2：多模型路由',
  summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
  author: 'News Desk'
});
const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
check('真实 Source 已保存（r1）', source.revision === 1);
check('真实 Topic 已保存', Boolean(topic.id));

// ============ A. 全新编译：Entity 新建 + 新 Claim + 新 Method + locator 证据 + Wiki + Receipt ============
const planA = {
  workspaceId: 'ws-a',
  sourceId: source.id,
  sourceRevision: source.revision,
  topicId: topic.id,
  reason: '摄取 AgentForge v2 发布资料（首次）',
  topicCompile: { summary: 'AI Agent 工具链主题编译' },
  entities: [
    { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', aliases: ['AF'], valueRationale: '产品发布主体，选型判断与创作复用' }
  ],
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', excerpt: 'AgentForge v2 ships multi-model routing.', entityKeys: ['agentforge'], valueRationale: '可验证产品事实，影响工具选择' },
    { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用的选型/创作方法' }
  ]
};
const a = compileSourceKnowledge(database, { ...planA, requestId: sourceCompileRequestId(source.id, source.revision) });
check('A 首次编译 ok 且非重放', a.ok === true && a.replay === false);
check('A 计数（1 Entity / 2 Note / 2 版本 / 2 证据 / 1 Wiki）',
  a.counts.entitiesCreated === 1 && a.counts.entitiesMatched === 0 && a.counts.notesCreated === 2
  && a.counts.notesUpdated === 0 && a.counts.noteVersionsCreated === 2 && a.counts.evidenceLinks === 2
  && a.counts.wikiPagesCompiled === 1 && a.counts.notesSkippedLowValue === 0);
check('A changeSetId + ingest 回执', Boolean(a.changeSetId) && a.receipt?.triggerType === 'ingest');
check('A 回执受影响 Topic 恰为关联 Topic', a.receipt?.affectedTopics?.length === 1 && a.receipt.affectedTopics[0] === topic.id);

const entityList = listKnowledgeEntities(database, { scope: 'global' });
check('A Entity 恰一个（agentforge）', entityList.items.length === 1 && entityList.items[0].canonicalKey === 'agentforge');
const entityId = entityList.items[0].id;

const claimNote = getKnowledgeNote(database, a.noteIds['agentforge-v2-multi-router']);
check('A Claim Note 落库并采用 Entity/Topic',
  claimNote?.version?.statement === 'AgentForge v2 支持多模型路由'
  && claimNote.version.adoptedEntityIds.includes(entityId)
  && claimNote.version.adoptedTopicIds.includes(topic.id)
  && claimNote.version.changeType === 'created');
const methodNote = getKnowledgeNote(database, a.noteIds['agentforge-router-eval']);
check('A Method Note kind=method', methodNote?.note.kind === 'method');

const evidence = listKnowledgeEvidenceLinks(database, { noteVersionId: claimNote.version.id });
check('A 证据带原文 locator + source',
  evidence.items.length === 1 && evidence.items[0].locator === 'L12-18'
  && evidence.items[0].evidenceObjectId === source.id
  && evidence.items[0].sourceNature === 'primary_source' && evidence.items[0].relation === 'supports');

const pages = listWikiPages(database, { scope: 'global', pageType: 'topic' });
check('A 唯一 Topic Wiki 页 current', pages.items.length === 1 && pages.items[0].compileStatus === 'current');
const pageA = getWikiPage(database, pages.items[0].id);
check('A Wiki 版本采纳两个 Note 版本',
  pageA?.version?.adoptedNoteVersionIds.length === 2
  && pageA.version.adoptedNoteVersionIds.includes(claimNote.version.id)
  && pageA.version.adoptedNoteVersionIds.includes(methodNote.version.id));
check('A Wiki 正文为 topic-wiki 且含 keyConclusions/无争议',
  pageA.version.body.kind === 'topic-wiki' && pageA.version.body.keyConclusions.length === 2
  && pageA.version.body.retainedDisputes.length === 0);
check('A 回执 wikiPageVersions 指向新 Wiki 版本',
  a.receipt?.wikiPageVersions?.length === 1 && a.receipt.wikiPageVersions[0] === pageA.version.id);

// ============ B. 同 source revision/request 幂等重放：零增量、同一回执 ============
const b = compileSourceKnowledge(database, { ...planA, requestId: sourceCompileRequestId(source.id, source.revision) });
check('B 幂等重放（同一 changeSetId/回执）', b.replay === true && b.changeSetId === a.changeSetId && b.receipt?.id === a.receipt?.id);
check('B 重放版本 id 与首次一致',
  b.noteVersionIds['agentforge-v2-multi-router'] === a.noteVersionIds['agentforge-v2-multi-router']
  && b.wikiPageVersionId === a.wikiPageVersionId);
const afterB = snapshot();
check('B 重放零增量（ChangeSet/Receipt/Entity/版本/Wiki 均不变）',
  afterB.changeSets === 1 && afterB.receipts === 1 && afterB.entities === 1
  && afterB.noteVersions === 2 && afterB.wikiVersions === 1 && afterB.wikiPages === 1);

// ============ C. 真实场景二次摄取：Entity 零重复 + 新 Claim + 旧 Method 限域 + 真实争议 + Wiki V2 ============
const sourceV2 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 更新：平台限制与争议' });
check('C 同一 Source 更新到 r2', sourceV2.id === source.id && sourceV2.revision === 2);
const planB = {
  workspaceId: 'ws-a',
  sourceId: source.id,
  sourceRevision: sourceV2.revision,
  topicId: topic.id,
  reason: '摄取 AgentForge v2 争议报道：限域旧 Method、标记争议',
  topicCompile: { summary: 'AI Agent 工具链主题编译（v2 更新）' },
  entities: [
    { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '已存在，验证零重复' }
  ],
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-xiaohongshu-claim', statement: 'AgentForge v2 可用于小红书运营场景的批量内容生成', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-9', excerpt: 'Works for xiaohongshu ops.', entityKeys: ['agentforge'], valueRationale: '平台适用事实，直接进入创作判断' },
    { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由的样本先覆盖目标平台（当前仅 xiaohongshu 验证）', conclusionStatus: 'supported', evidenceLevel: 'corroborated', appliesTo: 'xiaohongshu', changeType: 'qualified', changeReason: '新证据限制平台适用范围', locator: 'L22-27', relation: 'qualifies', entityKeys: ['agentforge'], valueRationale: '改变既有方法适用范围' },
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', changeType: 'contradicted', changeReason: '新报道与首发资料分歧，保留争议', locator: 'L30-33', relation: 'contradicts', entityKeys: ['agentforge'], valueRationale: '可信来源实质分歧，需保留争议' }
  ]
};
const c = compileSourceKnowledge(database, { ...planB, requestId: sourceCompileRequestId(source.id, sourceV2.revision) });
check('C 计数（Entity 匹配 1/新建 0 零重复；Note 新建 1/更新 2；3 版本/3 证据/1 Wiki）',
  c.counts.entitiesMatched === 1 && c.counts.entitiesCreated === 0
  && c.counts.notesCreated === 1 && c.counts.notesUpdated === 2
  && c.counts.noteVersionsCreated === 3 && c.counts.evidenceLinks === 3
  && c.counts.wikiPagesCompiled === 1);
check('C Entity 零重复（总数仍 1）', count(database, 'knowledge_entities') === 1);

const disputedNote = getKnowledgeNote(database, c.noteIds['agentforge-v2-multi-router']);
check('C 旧 Claim 追加争议版本（V2 disputed）',
  disputedNote?.note.revision === 2
  && listKnowledgeNoteVersions(database, disputedNote.note.id, {}).items.length === 2
  && disputedNote.version.conclusionStatus === 'disputed' && disputedNote.version.changeType === 'contradicted');
const qualifiedMethod = getKnowledgeNote(database, c.noteIds['agentforge-router-eval']);
check('C 旧 Method 限域（V2 qualified + appliesTo=xiaohongshu）',
  qualifiedMethod?.note.revision === 2 && qualifiedMethod.version.changeType === 'qualified'
  && qualifiedMethod.version.appliesTo === 'xiaohongshu'
  && listKnowledgeNoteVersions(database, qualifiedMethod.note.id, {}).items.length === 2);
const newClaim = getKnowledgeNote(database, c.noteIds['agentforge-v2-xiaohongshu-claim']);
check('C 新 Claim 落库（带 locator 证据）',
  newClaim?.version.conclusionStatus === 'supported'
  && listKnowledgeEvidenceLinks(database, { noteVersionId: newClaim.version.id }).items[0].locator === 'L5-9');

const pageC = getWikiPage(database, pages.items[0].id);
check('C Topic Wiki 重编译到 V2（唯一页，采纳 5 版本）',
  pageC?.version?.versionNumber === 2 && pageC.version.adoptedNoteVersionIds.length === 5);
check('C Wiki 正文保留争议与变化',
  pageC.version.body.retainedDisputes.length === 1 && pageC.version.body.recentChanges.length === 3);
check('C ChangeSet resolutionMode=kept_disputed', getChangeSet(database, c.changeSetId)?.resolutionMode === 'kept_disputed');
check('C 回执 retainedDisputes 含争议版本', c.receipt?.retainedDisputes?.includes(disputedNote.version.id) === true);
check('C 回执 autoResolutions 含 qualified/contradicted',
  c.receipt?.autoResolutions?.some((x) => x.startsWith('qualified:')) === true
  && c.receipt.autoResolutions.some((x) => x.startsWith('contradicted:')) === true);
check('C 回执 affectedMethods 含 Method', c.receipt?.affectedMethods?.includes(qualifiedMethod.note.id) === true);
check('C 回执 counts 一致', c.receipt?.counts?.notesUpdated === 2 && c.receipt.counts.notesCreated === 1);

// ============ D. 同 source revision 不同 requestId：新 ChangeSet 但不产生重复对象（去重优先） ============
const d = compileSourceKnowledge(database, {
  ...planA, sourceRevision: sourceV2.revision, requestId: `${sourceCompileRequestId(source.id, sourceV2.revision)}:reimport`
});
check('D 重复摄取不新建对象（Entity 匹配、Note 全跳过，零增量）',
  d.ok === true && d.replay === false && d.counts.entitiesMatched === 1 && d.counts.entitiesCreated === 0
  && d.counts.notesCreated === 0 && d.counts.notesUpdated === 0 && d.counts.noteVersionsCreated === 0
  && d.counts.wikiPagesCompiled === 0 && d.counts.notesSkippedLowValue === 2);
check('D 对象数不变（Entity 1 / Note 3 / 版本 5 / Wiki 页 1 / Wiki 版本 2）',
  count(database, 'knowledge_entities') === 1 && count(database, 'knowledge_notes') === 3
  && count(database, 'knowledge_note_versions') === 5 && count(database, 'knowledge_wiki_pages') === 1
  && count(database, 'knowledge_wiki_page_versions') === 2);

// ============ E. 低价值：纯复述 → 零知识成功（持久 receipt，零 Note/Wiki） ============
const sourceV3 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 报道复述' });
check('E Source 到 r3', sourceV3.revision === 3);
const planC = {
  workspaceId: 'ws-a',
  sourceId: source.id,
  sourceRevision: sourceV3.revision,
  topicId: topic.id,
  reason: '低价值复述：零知识成功',
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L1-2', valueRationale: '纯复述检查' }
  ]
};
const e = compileSourceKnowledge(database, { ...planC, requestId: sourceCompileRequestId(source.id, sourceV3.revision) });
check('E 零知识成功（receipt 持久，零 Note/证据/Wiki）',
  e.ok === true && e.replay === false
  && e.counts.notesCreated === 0 && e.counts.notesUpdated === 0 && e.counts.noteVersionsCreated === 0
  && e.counts.evidenceLinks === 0 && e.counts.wikiPagesCompiled === 0 && e.counts.notesSkippedLowValue === 1);
check('E receipt 说明跳过', e.receipt !== null && e.receipt.counts.notesSkippedLowValue === 1
  && e.receipt.failures.some((f) => f.startsWith('skipped:agentforge-v2-multi-router')));
const afterE = snapshot();
check('E 零知识零写（Note/版本/Wiki 不变）',
  afterE.notes === 3 && afterE.noteVersions === 5 && afterE.wikiPages === 1 && afterE.wikiVersions === 2);
check('E wikiPageId/version 为 null', e.wikiPageId === null && e.wikiPageVersionId === null);

// ============ F. 失败零写：全部校验失败零新增行 ============
const failureBase = { workspaceId: 'ws-a', sourceId: source.id, sourceRevision: sourceV3.revision, topicId: topic.id, reason: '失败零写测试' };
const beforeF = snapshot();
await expectError('F 陈旧 revision 拒绝', () => compileSourceKnowledge(database, { ...failureBase, sourceRevision: 1, requestId: sourceCompileRequestId(source.id, 1) }), 'COMPILE_SOURCE_REVISION_STALE');
await expectError('F 幽灵 Source 拒绝', () => compileSourceKnowledge(database, { ...failureBase, sourceId: 'ghost-source', requestId: 'fail-ghost-source' }), 'COMPILE_SOURCE_NOT_FOUND');
await expectError('F 幽灵 Topic 拒绝', () => compileSourceKnowledge(database, { ...failureBase, topicId: 'ghost-topic', requestId: 'fail-ghost-topic' }), 'COMPILE_TOPIC_NOT_FOUND');
await expectError('F 无效候选（supported+none）', () => compileSourceKnowledge(database, { ...failureBase, requestId: 'fail-bad-evidence', notes: [{ kind: 'claim', canonicalKey: 'bad-evidence', statement: 'x', conclusionStatus: 'supported', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' }] }), 'COMPILE_CANDIDATE_INVALID');
await expectError('F 未解析 Entity key', () => compileSourceKnowledge(database, { ...failureBase, requestId: 'fail-bad-key', notes: [{ kind: 'claim', canonicalKey: 'bad-key', statement: 'x', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', entityKeys: ['ghost-entity'], valueRationale: 'x' }] }), 'COMPILE_ENTITY_KEY_UNRESOLVED');
await expectError('F kind 冲突', () => compileSourceKnowledge(database, { ...failureBase, requestId: 'fail-kind', notes: [{ kind: 'method', canonicalKey: 'agentforge-v2-multi-router', statement: 'x', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', changeType: 'qualified', valueRationale: 'x' }] }), 'COMPILE_NOTE_KIND_MISMATCH');
await expectError('F 新 Note 不能 no_change', () => compileSourceKnowledge(database, { ...failureBase, requestId: 'fail-nochange', notes: [{ kind: 'claim', canonicalKey: 'brand-new-note', statement: 'x', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', changeType: 'no_change', valueRationale: 'x' }] }), 'COMPILE_NOTE_CHANGE_TYPE_INVALID');
await expectError('F 候选重复 canonicalKey', () => compileSourceKnowledge(database, { ...failureBase, requestId: 'fail-dup', notes: [
  { kind: 'claim', canonicalKey: 'dup-note', statement: 'a', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' },
  { kind: 'claim', canonicalKey: 'dup-note', statement: 'b', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L2', valueRationale: 'x' }
] }), 'COMPILE_CANDIDATE_DUPLICATE');
assertNoWrite('F 全部失败', beforeF);

// ============ G. 全程只重编译一个已关联 Topic Wiki + 回执按 request 读回 ============
check('G 全程只产生一个 Wiki 页', count(database, 'knowledge_wiki_pages') === 1);
const allPages = listWikiPages(database, { scope: 'global', limit: 50 });
check('G 唯一页为 topic 类型且 subject 为关联 Topic',
  allPages.items.length === 1 && allPages.items[0].pageType === 'topic' && allPages.items[0].subjectId === topic.id);
check('G 回执按 request 读回同一 id',
  getUpdateReceiptByRequest(database, 'ws-a', sourceCompileRequestId(source.id, 1))?.id === a.receipt.id);

// ============ H. Source 保存后显式触发（compileSavedSource：自动取当前 revision + 稳定 requestId） ============
const sourceV4 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 后续：定价公开' });
const h = compileSavedSource(database, {
  workspaceId: 'ws-a',
  sourceId: source.id,
  topicId: topic.id,
  reason: 'Source 保存后显式触发编译（compileSavedSource）',
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-pricing', statement: 'AgentForge v2 企业版定价为每席位 99 美元/月', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L40-44', entityKeys: ['agentforge'], valueRationale: '价格事实，影响选型判断' }
  ]
});
check('H compileSavedSource 自动取当前 revision 并成功',
  h.ok === true && h.replay === false && h.requestId === sourceCompileRequestId(source.id, sourceV4.revision)
  && h.counts.notesCreated === 1 && h.counts.wikiPagesCompiled === 1);
const hReplay = compileSavedSource(database, {
  workspaceId: 'ws-a', sourceId: source.id, topicId: topic.id, reason: 'Source 保存后显式触发编译（compileSavedSource）',
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-pricing', statement: 'AgentForge v2 企业版定价为每席位 99 美元/月', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L40-44', entityKeys: ['agentforge'], valueRationale: '价格事实，影响选型判断' }
  ]
});
check('H 同 source revision 显式触发重放零写', hReplay.replay === true && hReplay.changeSetId === h.changeSetId);

const finalCounts = snapshot();
check('最终对象总数（ChangeSet 5 / Receipt 5 / Entity 1 / Note 4 / 版本 6 / 证据 6 / Wiki 页 1 / Wiki 版本 3）',
  finalCounts.changeSets === 5 && finalCounts.receipts === 5 && finalCounts.entities === 1
  && finalCounts.notes === 4 && finalCounts.noteVersions === 6 && finalCounts.evidenceLinks === 6
  && finalCounts.wikiPages === 1 && finalCounts.wikiVersions === 3);

database.close();
console.log(`WMB-5211 child: ${checks} checks passed`);
await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
