/**
 * WMB-5214 Query 写回服务契约验收（子进程，真实 SQLite）。
 * 场景（设计 compiler §10 + object contract §25）：
 * A. 纯复述：零知识写（零 Note/零 Wiki），仅 QueryArtifact + query 回执；
 * B. 新综合：去重后 ChangeSet 创建 insight Note + derived_from 证据（仅冻结读取版本）+
 *    Synthesis Wiki 页，receipt 受影响综合可追溯，回答本身不是证据；
 * C. 同问幂等：同 requestId 重放 → duplicate 零写；
 * D. 同陈述跨轮（不同 requestId）：零重复知识，仅 Artifact + 回执（skipped_repetition）；
 * E. 综合更新：同 canonicalKey 新陈述 → Note 追加版本（recompiled）+ Wiki 版本 2（updated）；
 * F. 用户经验：先保存不可变 FreeNote（pi_dialogue），零知识 Note；
 * G. 失败零写：basedOn 不在读取集 / 经验冒充回答 / 幽灵读取版本 / 复述零读取 / 非法分类；
 * H. manifest 严格解析与剥离（无围栏/非法/非本协议 → null；剥离只删本协议块）；
 * I. 风险标记 + 每轮摘要 + requestId 约定；
 * J. 主查询服务（knowledge.get_context）冻结版本读取面。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic, getKnowledgeContext } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import {
  getKnowledgeFreeNote,
  getKnowledgeNote,
  getQueryArtifactByRequest,
  getUpdateReceiptByRequest,
  getWikiPage,
  listKnowledgeEvidenceLinks,
  listKnowledgeFreeNotes,
  listWikiPages
} from '../src/main/knowledge-flywheel.ts';
import {
  extractQueryWritebackManifest,
  getQueryWritebackSummary,
  stripQueryWritebackBlock,
  writebackQueryKnowledge
} from '../src/main/query-writeback.ts';
import { knowledgeQueryWritebackRequestId } from '../src/shared/knowledge-flywheel.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5214-db-'));
const database = migrateDatabase(path.join(directory, 'wmb.db'));
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(new Date().toISOString(), new Date().toISOString());

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
async function expectError(label, fn, code) {
  checks += 1;
  try {
    fn();
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
    artifacts: count(database, 'knowledge_query_artifacts'),
    freeNotes: count(database, 'knowledge_free_notes'),
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

// ============ 前置：真实 Topic + 两份资料编译出冻结读取版本 ============
const sourceA = upsertSource(database, {
  originalUrl: 'https://news.example/agentforge-v2',
  title: 'AgentForge v2 发布：多模型路由',
  summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
  author: 'News Desk'
});
const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
const planA = {
  workspaceId: 'ws-a',
  sourceId: sourceA.id,
  sourceRevision: sourceA.revision,
  topicId: topic.id,
  reason: '前置编译：冻结读取版本 A',
  topicCompile: { summary: 'AI Agent 工具链主题编译' },
  entities: [
    { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '选型判断与创作复用' }
  ],
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', entityKeys: ['agentforge'], valueRationale: '可验证产品事实' },
    { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用方法' }
  ]
};
const a = compileSourceKnowledge(database, { ...planA, requestId: sourceCompileRequestId(sourceA.id, sourceA.revision) });
const sourceB = upsertSource(database, {
  originalUrl: 'https://news.example/xiaohongshu-agent',
  title: '小红书运营 Agent 实践',
  summary: '团队用 AgentForge v2 跑通小红书批量内容生产。',
  author: 'Ops Team'
});
const planB = {
  workspaceId: 'ws-a',
  sourceId: sourceB.id,
  sourceRevision: sourceB.revision,
  topicId: topic.id,
  reason: '前置编译：冻结读取版本 B',
  entities: [
    { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '复用' }
  ],
  notes: [
    { kind: 'claim', canonicalKey: 'xhs-agent-practice', statement: '小红书批量内容生产可用 AgentForge v2 跑通', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-12', entityKeys: ['agentforge'], valueRationale: '平台适用事实' }
  ]
};
const b = compileSourceKnowledge(database, { ...planB, requestId: sourceCompileRequestId(sourceB.id, sourceB.revision) });
const readNoteIds = [a.noteVersionIds['agentforge-v2-multi-router'], a.noteVersionIds['agentforge-router-eval'], b.noteVersionIds['xhs-agent-practice']];
const topicPages = listWikiPages(database, { scope: 'global', pageType: 'topic' });
const topicWikiVersionId = getWikiPage(database, topicPages.items[0].id).version.id;
const evidenceIds = [];
for (const versionId of readNoteIds) {
  for (const item of listKnowledgeEvidenceLinks(database, { noteVersionId: versionId }).items) evidenceIds.push(item.id);
}
check('前置：冻结读取版本就绪（3 Note 版本 + 1 Topic Wiki 版本 + 3 证据）',
  readNoteIds.length === 3 && Boolean(topicWikiVersionId) && evidenceIds.length >= 3);

const convId = 'conv-5214-a';
const q1 = 'AgentForge v2 和已有小红书流程怎么配合？';
const requestId = knowledgeQueryWritebackRequestId(convId, q1);
const readVersions = {
  readWikiVersionIds: [topicWikiVersionId],
  readNoteVersionIds: readNoteIds,
  readEvidenceIds: evidenceIds
};
const base = { workspaceId: 'ws-a', scope: 'global', conversationId: convId, question: q1, answerSummary: '基于既有知识复述。' };

// ============ A. 纯复述：零知识，仅 Artifact + query 回执 ============
const beforeA = snapshot();
const restatement = writebackQueryKnowledge(database, { ...base, requestId, classification: 'restatement', ...readVersions });
check('A restatement ok 非重放', restatement.ok === true && restatement.replay === false && restatement.duplicate === false);
check('A decision=skipped_repetition + 零 Note/Wiki 计数',
  restatement.writeBackDecision === 'skipped_repetition' && restatement.counts.notesCreated === 0
  && restatement.counts.notesUpdated === 0 && restatement.counts.noteVersionsCreated === 0
  && restatement.counts.wikiPagesCompiled === 0 && restatement.counts.restatements === 1);
check('A 零知识写（Note/版本/Wiki/证据不变；仅 ChangeSet+Receipt+Artifact 新增）',
  snapshot().notes === beforeA.notes && snapshot().noteVersions === beforeA.noteVersions
  && snapshot().wikiPages === beforeA.wikiPages && snapshot().wikiVersions === beforeA.wikiVersions
  && snapshot().evidenceLinks === beforeA.evidenceLinks
  && snapshot().changeSets === beforeA.changeSets + 1 && snapshot().receipts === beforeA.receipts + 1
  && snapshot().artifacts === beforeA.artifacts + 1);
check('A Artifact 冻结读取版本 + 回执',
  restatement.artifact?.readNoteVersionIds.length === 3 && restatement.artifact.readWikiVersionIds[0] === topicWikiVersionId
  && restatement.artifact.readEvidenceIds.length === evidenceIds.length
  && restatement.artifact.writeBackDecision === 'skipped_repetition'
  && restatement.receipt?.triggerType === 'query' && Boolean(restatement.receipt.id));
check('A 回执按 request 读回一致', getUpdateReceiptByRequest(database, 'ws-a', requestId)?.id === restatement.receipt?.id);

// ============ C. 同问幂等：同 requestId 重放 → duplicate 零写 ============
const beforeC = snapshot();
const replay = writebackQueryKnowledge(database, { ...base, requestId, classification: 'restatement', ...readVersions });
check('C duplicate 零写返回既有 Artifact',
  replay.duplicate === true && replay.artifact?.id === restatement.artifact?.id && replay.receipt?.id === restatement.receipt?.id);
assertNoWrite('C 同问幂等', beforeC);

// ============ B. 新综合：创建 Synthesis Wiki，追溯冻结读取版本 ============
const q2 = '把 AgentForge 能力和小红书实践放到一起看，得出什么可复用判断？';
const requestId2 = knowledgeQueryWritebackRequestId(convId, q2);
const synthesisPlan = {
  canonicalKey: 'agentforge-xhs-synthesis',
  title: 'AgentForge v2 × 小红书实践综合',
  statement: '当团队已具备 AgentForge v2 多模型路由时，小红书批量内容生产应优先复用该路由做平台适配，而非另起流程。',
  basedOnNoteVersionIds: [readNoteIds[0], readNoteIds[1], readNoteIds[2]],
  valueRationale: '跨资料新综合：把产品能力与平台实践关联，形成可复用选型判断'
};
const beforeB = snapshot();
const synthesis = writebackQueryKnowledge(database, {
  ...base, requestId: requestId2, question: q2, classification: 'new_synthesis',
  answerSummary: '综合既有资料得出可复用判断。', ...readVersions, synthesis: synthesisPlan
});
check('B 综合 ok 且 decision=created',
  synthesis.ok === true && synthesis.writeBackDecision === 'created' && synthesis.counts.notesCreated === 1
  && synthesis.counts.noteVersionsCreated === 1 && synthesis.counts.wikiPagesCompiled === 1);
check('B 零重复（恰 1 新 Note/1 新 Wiki 页/2 页总数不变前置页）',
  snapshot().notes === beforeB.notes + 1 && snapshot().wikiPages === beforeB.wikiPages + 1);
check('B Note 为 insight + inference/mixed + 采用冻结版本',
  getKnowledgeNote(database, synthesis.noteIds['agentforge-xhs-synthesis'])?.note.kind === 'insight'
  && getKnowledgeNote(database, synthesis.noteIds['agentforge-xhs-synthesis'])?.version.conclusionStatus === 'inference'
  && getKnowledgeNote(database, synthesis.noteIds['agentforge-xhs-synthesis'])?.version.evidenceLevel === 'mixed'
  && getKnowledgeNote(database, synthesis.noteIds['agentforge-xhs-synthesis'])?.version.adoptedKnowledgeVersionIds.length === 3);
check('B 证据只指向冻结读取版本（derived_from，回答不是证据）',
  listKnowledgeEvidenceLinks(database, { noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'] }).items.length >= 4
  && listKnowledgeEvidenceLinks(database, { noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'] }).items
    .every((item) => item.relation === 'derived_from' && ['knowledge_note_version', 'wiki_page_version'].includes(item.evidenceObjectType))
  && listKnowledgeEvidenceLinks(database, { noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'] }).items
    .every((item) => readNoteIds.includes(item.evidenceObjectId) || item.evidenceObjectId === topicWikiVersionId));
const synthesisPages = listWikiPages(database, { scope: 'global', pageType: 'synthesis' });
check('B Synthesis Wiki 页创建（canonicalKey=synthesis:…）',
  synthesisPages.items.length === 1 && synthesisPages.items[0].canonicalKey === 'synthesis:agentforge-xhs-synthesis');
const synthesisPage = getWikiPage(database, synthesisPages.items[0].id);
check('B Synthesis Wiki 正文冻结固定输入版本（body.basedOn = 冻结读取集）',
  synthesisPage.version.body.kind === 'synthesis-wiki'
  && JSON.stringify(synthesisPage.version.body.basedOn.noteVersionIds) === JSON.stringify(readNoteIds)
  && synthesisPage.version.body.basedOn.wikiVersionIds[0] === topicWikiVersionId
  && synthesisPage.version.adoptedNoteVersionIds.includes(synthesis.noteVersionIds['agentforge-xhs-synthesis']));
check('B 回执受影响综合 + Wiki 版本可追溯',
  synthesis.receipt?.affectedSyntheses?.includes(synthesisPages.items[0].id) === true
  && synthesis.receipt?.wikiPageVersions?.includes(synthesisPage.version.id) === true
  && synthesis.receipt?.triggerType === 'query');
check('B Artifact decision=created 且 candidates 含综合',
  synthesis.artifact?.writeBackDecision === 'created'
  && synthesis.artifact.candidates[0]?.kind === 'synthesis'
  && synthesis.artifact.candidates[0]?.canonicalKey === 'agentforge-xhs-synthesis');

// ============ D. 同陈述跨轮（不同 requestId）：零重复知识，仅 Artifact + 回执 ============
const beforeD = snapshot();
const requestId3 = knowledgeQueryWritebackRequestId(convId, '换个问法再确认这个判断');
const dupSynthesis = writebackQueryKnowledge(database, {
  ...base, requestId: requestId3, question: '换个问法再确认这个判断', classification: 'new_synthesis',
  answerSummary: '同样的综合结论。', ...readVersions, synthesis: synthesisPlan
});
check('D 同陈述跨轮 skipped_repetition 零知识',
  dupSynthesis.writeBackDecision === 'skipped_repetition' && dupSynthesis.counts.noteVersionsCreated === 0
  && dupSynthesis.counts.wikiPagesCompiled === 0);
check('D 零重复（Note/版本/Wiki 页与版本数不变）',
  snapshot().notes === beforeD.notes && snapshot().noteVersions === beforeD.noteVersions
  && snapshot().wikiPages === beforeD.wikiPages && snapshot().wikiVersions === beforeD.wikiVersions
  && snapshot().evidenceLinks === beforeD.evidenceLinks);
check('D 仅新增 Artifact + 回执', snapshot().artifacts === beforeD.artifacts + 1 && snapshot().receipts === beforeD.receipts + 1);

// ============ E. 综合更新：同 canonicalKey 新陈述 → Note V2 + Wiki V2（updated） ============
const requestId4 = knowledgeQueryWritebackRequestId(convId, '综合结论有新证据，更新一下判断');
const updatedPlan = {
  canonicalKey: 'agentforge-xhs-synthesis',
  title: 'AgentForge v2 × 小红书实践综合（更新）',
  statement: '当团队已具备 AgentForge v2 多模型路由时，小红书批量内容生产应优先复用该路由做平台适配；若路由质量未达阈值则先做 20 条样本评估。',
  basedOnNoteVersionIds: [readNoteIds[0], readNoteIds[1], readNoteIds[2]],
  valueRationale: '补充可执行评估门槛，更新既有综合'
};
const beforeE = snapshot();
const updated = writebackQueryKnowledge(database, {
  ...base, requestId: requestId4, question: '综合结论有新证据，更新一下判断', classification: 'new_synthesis',
  answerSummary: '更新后的综合。', ...readVersions, synthesis: updatedPlan
});
check('E decision=updated + Note 追加版本（recompiled）',
  updated.writeBackDecision === 'updated' && updated.counts.notesUpdated === 1 && updated.counts.noteVersionsCreated === 1
  && getKnowledgeNote(database, updated.noteIds['agentforge-xhs-synthesis'])?.note.revision === 2
  && getKnowledgeNote(database, updated.noteIds['agentforge-xhs-synthesis'])?.version.changeType === 'recompiled');
const updatedPage = getWikiPage(database, synthesisPages.items[0].id);
check('E Synthesis Wiki 版本 2（同页追加，不新建身份）',
  updatedPage?.version?.versionNumber === 2 && snapshot().wikiPages === beforeE.wikiPages
  && snapshot().wikiVersions === beforeE.wikiVersions + 1);
check('E 新版本继续冻结同一读取集', updatedPage.version.body.basedOn.noteVersionIds.length === 3);

// ============ F. 用户经验：先保存不可变 FreeNote，零知识 Note ============
const requestId5 = knowledgeQueryWritebackRequestId(convId, '我这边实际跑下来有个经验');
const beforeF = snapshot();
const experience = writebackQueryKnowledge(database, {
  ...base, requestId: requestId5, question: '我这边实际跑下来有个经验', classification: 'user_experience',
  answerSummary: '感谢分享，我会记住这个经验。', readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: [],
  experience: { body: '我们团队实际跑下来，AgentForge v2 的批量生成在小红书图片场景要先过一遍人工抽检再发布。' }
});
check('F FreeNote 落库（pi_dialogue + captured + 原文不可变）',
  experience.freeNoteId !== null && experience.writeBackDecision === 'no_write_back'
  && getKnowledgeFreeNote(database, experience.freeNoteId)?.body === '我们团队实际跑下来，AgentForge v2 的批量生成在小红书图片场景要先过一遍人工抽检再发布。'
  && getKnowledgeFreeNote(database, experience.freeNoteId)?.sourceNature === 'pi_dialogue'
  && getKnowledgeFreeNote(database, experience.freeNoteId)?.processingState === 'captured'
  && getKnowledgeFreeNote(database, experience.freeNoteId)?.sessionRef === convId);
check('F 零知识 Note/零 Wiki/零证据', snapshot().notes === beforeF.notes && snapshot().wikiPages === beforeF.wikiPages
  && snapshot().noteVersions === beforeF.noteVersions && snapshot().evidenceLinks === beforeF.evidenceLinks);
check('F Artifact no_write_back + 原因含 FreeNote id',
  experience.artifact?.writeBackDecision === 'no_write_back' && experience.artifact?.skipReason?.includes(experience.freeNoteId) === true);

// ============ G. 失败零写：全部校验失败零新增行 ============
const beforeG = snapshot();
await expectError('G basedOn 不在读取集（回答冒充证据）', () => writebackQueryKnowledge(database, {
  ...base, requestId: knowledgeQueryWritebackRequestId(convId, 'g1'), classification: 'new_synthesis',
  answerSummary: 'x', readWikiVersionIds: [], readNoteVersionIds: [readNoteIds[0]], readEvidenceIds: [],
  synthesis: { canonicalKey: 'bad-based-on', statement: 'x', basedOnNoteVersionIds: ['ghost-version-not-read'], valueRationale: 'x' }
}), 'QUERY_WRITEBACK_BASED_ON_NOT_READ');
await expectError('G 经验冒充回答', () => writebackQueryKnowledge(database, {
  ...base, requestId: knowledgeQueryWritebackRequestId(convId, 'g2'), classification: 'user_experience',
  answerSummary: '这是回答本身', readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: [],
  experience: { body: '这是回答本身' }
}), 'QUERY_WRITEBACK_EXPERIENCE_NOT_USER');
await expectError('G 幽灵读取版本', () => writebackQueryKnowledge(database, {
  ...base, requestId: knowledgeQueryWritebackRequestId(convId, 'g3'), classification: 'restatement',
  readWikiVersionIds: ['ghost-wiki-version'], readNoteVersionIds: [], readEvidenceIds: []
}), 'QUERY_WRITEBACK_VERSION_NOT_FOUND');
await expectError('G 复述零读取', () => writebackQueryKnowledge(database, {
  ...base, requestId: knowledgeQueryWritebackRequestId(convId, 'g4'), classification: 'restatement',
  readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: []
}), 'QUERY_WRITEBACK_INPUT_INVALID');
await expectError('G 非法分类', () => writebackQueryKnowledge(database, {
  ...base, requestId: knowledgeQueryWritebackRequestId(convId, 'g5'), classification: 'chat'
}), 'QUERY_WRITEBACK_INPUT_INVALID');
assertNoWrite('G 全部失败', beforeG);

// ============ H. manifest 严格解析与剥离 ============
const manifestJson = JSON.stringify({
  wmb_query_writeback: {
    classification: 'restatement',
    readWikiVersionIds: [topicWikiVersionId],
    readNoteVersionIds: [readNoteIds[0]],
    readEvidenceIds: []
  }
});
const answerText = `按既有知识回答。\n\n\`\`\`json\n${manifestJson}\n\`\`\``;
const parsed = extractQueryWritebackManifest(answerText);
check('H manifest 解析', parsed !== null && parsed.classification === 'restatement' && parsed.readNoteVersionIds[0] === readNoteIds[0]);
check('H strip 只删本协议块', stripQueryWritebackBlock(answerText) === '按既有知识回答。' && !stripQueryWritebackBlock(answerText).includes('wmb_query_writeback'));
check('H 无围栏 → null', extractQueryWritebackManifest('plain text') === null);
check('H 非法 JSON 围栏 → null', extractQueryWritebackManifest('```json\n{not json}\n```') === null);
check('H 非本协议围栏 → null', extractQueryWritebackManifest('```json\n{"wmb_noop":true}\n```') === null);
check('H 非法分类 → null', extractQueryWritebackManifest(`\`\`\`json\n${JSON.stringify({ wmb_query_writeback: { classification: 'chat', readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: [] } })}\n\`\`\``) === null);
check('H restatement 携带 synthesis → null', extractQueryWritebackManifest(`\`\`\`json\n${JSON.stringify({ wmb_query_writeback: { classification: 'restatement', readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: [], synthesis: { canonicalKey: 'k', statement: 's', valueRationale: 'v' } } })}\n\`\`\``) === null);
check('H 保留其他 JSON 围栏', stripQueryWritebackBlock(`正文\n\`\`\`json\n${manifestJson}\n\`\`\`\n\n\`\`\`json\n{"wmb_noop":true}\n\`\`\``) === '正文\n\`\`\`json\n{"wmb_noop":true}\n\`\`\`');

// ============ I. 风险标记 + 每轮摘要 + requestId 约定 ============
const disputedSource = upsertSource(database, {
  originalUrl: 'https://news.example/agentforge-v2-dispute',
  title: 'AgentForge v2 多模型路由仅限企业版',
  summary: '新报道：多模型路由仅限企业版开放。',
  author: 'Second Desk'
});
compileSourceKnowledge(database, {
  workspaceId: 'ws-a',
  sourceId: disputedSource.id,
  sourceRevision: disputedSource.revision,
  topicId: topic.id,
  reason: '制造 disputed 读取版本',
  requestId: sourceCompileRequestId(disputedSource.id, disputedSource.revision),
  notes: [
    { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', changeType: 'contradicted', changeReason: '新报道分歧，保留争议', locator: 'L8-10', entityKeys: ['agentforge'], valueRationale: '可信来源分歧' }
  ]
});
const disputedRead = writebackQueryKnowledge(database, {
  ...base, requestId: knowledgeQueryWritebackRequestId(convId, '争议读取轮'), classification: 'restatement',
  answerSummary: '复述争议。', readWikiVersionIds: [], readNoteVersionIds: [disputedReadVersionId()], readEvidenceIds: []
});
function disputedReadVersionId() {
  return getKnowledgeNote(database, a.noteIds['agentforge-v2-multi-router']).version.id;
}
check('I 争议版本已生成', disputedReadVersionId().length > 0 && disputedReadVersionId() !== readNoteIds[0]);
const summary = getQueryWritebackSummary(database, knowledgeQueryWritebackRequestId(convId, '争议读取轮'));
check('I 摘要含 artifact + disputed 风险标记',
  summary.artifact?.id === disputedRead.artifact?.id
  && summary.riskFlags.some((flag) => flag.kind === 'disputed' && flag.versionId === disputedReadVersionId()) === true
  && summary.receipt?.id === disputedRead.receipt?.id);
check('I 摘要未知 requestId → artifact null', getQueryWritebackSummary(database, 'query:ghost:deadbeef').artifact === null);
check('I requestId 约定：同会话同问题同键 / 问题不同键不同 / trim 后同键',
  knowledgeQueryWritebackRequestId('conv-x', '问题') === knowledgeQueryWritebackRequestId('conv-x', ' 问题 ')
  && knowledgeQueryWritebackRequestId('conv-x', '问题') !== knowledgeQueryWritebackRequestId('conv-x', '另一个问题')
  && knowledgeQueryWritebackRequestId('conv-x', '问题') !== knowledgeQueryWritebackRequestId('conv-y', '问题'));

// ============ J. 主查询服务冻结版本读取面 ============
const context = getKnowledgeContext(database, { topicId: topic.id, limit: 10 });
check('J get_context 返回冻结飞轮知识（Topic Wiki 当前版本 + 采纳 Note 版本）',
  Array.isArray(context.knowledge?.wikiPages) && context.knowledge.wikiPages.length === 1
  && context.knowledge.wikiPages[0].pageType === 'topic'
  && typeof context.knowledge.wikiPages[0].currentVersionId === 'string' && context.knowledge.wikiPages[0].currentVersionId.length > 0
  && Array.isArray(context.knowledge?.noteVersions) && context.knowledge.noteVersions.length >= 3
  && context.knowledge.noteVersions.every((version) => typeof version.versionId === 'string')
  && Array.isArray(context.knowledge?.evidence) && context.knowledge.evidence.length >= 3);

const finalCounts = snapshot();
check('最终对象总数（ChangeSet 9 / Receipt 9 / Artifact 6 / FreeNote 1 / Note 4 / 版本 6 / Wiki 页 2 / Wiki 版本 5 / 证据 12）',
  finalCounts.changeSets === 9 && finalCounts.receipts === 9 && finalCounts.artifacts === 6 && finalCounts.freeNotes === 1
  && finalCounts.notes === 4 && finalCounts.noteVersions === 6 && finalCounts.wikiPages === 2
  && finalCounts.wikiVersions === 5 && finalCounts.evidenceLinks === 12);

database.close();
console.log(`WMB-5214 child: ${checks} checks passed`);
await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
