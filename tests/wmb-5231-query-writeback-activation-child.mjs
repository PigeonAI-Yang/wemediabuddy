/**
 * WMB-5231 Query 写回真实激活验收（子进程，真实 SQLite + 真实 ActiveWorkspaceRuntime）。
 *
 * 覆盖（settle 六类区分 + 面板可见性 + 幂等）：
 * A. 无清单（未声明知识读取）→ settle not_written（QUERY_WRITEBACK_MANIFEST_MISSING），零写；
 * B. 有围栏但非法 → settle not_written（QUERY_WRITEBACK_MANIFEST_INVALID），零写；
 * C. restatement（纯复述）→ 写回 Artifact + 回执，零 Note/零 Wiki/零 Evidence；
 * D. new_synthesis → 写回 insight Note + derived_from 证据（仅冻结读取版本）+ Synthesis Wiki；
 * E. user_experience → 先保存不可变 FreeNote，零知识 Note；
 * F. 冻结版本不存在（幽灵版本）→ not_written（QUERY_WRITEBACK_VERSION_NOT_FOUND），零写；
 * G. basedOn 不在读取集（回答冒充证据）→ not_written（QUERY_WRITEBACK_BASED_ON_NOT_READ），零写；
 * H. 同问重放（同 conversationId+question+answer）→ duplicate 零增量；
 * I. 摘要投影：getQueryWritebackSummary 合并 settle（无 Artifact 时零写原因可见）。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { settleQueryWritebackForRound } from '../src/main/ipc-pi-dock.ts';
import {
  getKnowledgeFreeNote,
  getKnowledgeNote,
  getQueryArtifactByRequest,
  getWikiPage,
  listKnowledgeEvidenceLinks,
  listWikiPages
} from '../src/main/knowledge-flywheel.ts';
import {
  getQueryWritebackSettleOutcome,
  getQueryWritebackSummary,
  hasQueryWritebackFence
} from '../src/main/query-writeback.ts';
import { knowledgeQueryWritebackRequestId } from '../src/shared/knowledge-flywheel.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5231-db-'));
let runtime = null;

function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function snapshot() {
  return {
    changeSets: count(runtime.database, 'knowledge_change_sets'),
    receipts: count(runtime.database, 'knowledge_update_receipts'),
    artifacts: count(runtime.database, 'knowledge_query_artifacts'),
    freeNotes: count(runtime.database, 'knowledge_free_notes'),
    notes: count(runtime.database, 'knowledge_notes'),
    noteVersions: count(runtime.database, 'knowledge_note_versions'),
    wikiPages: count(runtime.database, 'knowledge_wiki_pages'),
    wikiVersions: count(runtime.database, 'knowledge_wiki_page_versions'),
    evidenceLinks: count(runtime.database, 'knowledge_evidence_links')
  };
}

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function assertNoWrite(label, before) {
  const after = snapshot();
  for (const key of Object.keys(before)) {
    check(`${label} 零写（${key}）`, after[key] === before[key], `${before[key]} → ${after[key]}`);
  }
}

function manifestBlock(classification, extra = {}) {
  const payload = {
    classification,
    readWikiVersionIds: extra.readWikiVersionIds ?? [],
    readNoteVersionIds: extra.readNoteVersionIds ?? [],
    readEvidenceIds: extra.readEvidenceIds ?? [],
    ...(extra.synthesis ? { synthesis: extra.synthesis } : {}),
    ...(extra.experience ? { experience: extra.experience } : {})
  };
  return `\`\`\`json\n${JSON.stringify({ wmb_query_writeback: payload })}\n\`\`\``;
}

async function settleRound(conversationId, question, answerText) {
  return settleQueryWritebackForRound(
    { getActiveRuntime: () => runtime },
    { path: directory, isNew: false },
    { conversationId, question, answerText }
  );
}

try {
  // ============ 前置：真实冻结读取版本（Topic Wiki + Note 版本 + 证据） ============
  const seedDatabase = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  seedDatabase.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-5231', now, now);
  const sourceA = upsertSource(seedDatabase, {
    originalUrl: 'https://news.example/agentforge-v2',
    title: 'AgentForge v2 发布：多模型路由',
    summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
    author: 'News Desk'
  });
  const topic = upsertKnowledgeTopic(seedDatabase, { title: 'AI Agent 工具链' });
  const planA = {
    workspaceId: 'ws-5231',
    sourceId: sourceA.id,
    sourceRevision: sourceA.revision,
    topicId: topic.id,
    reason: 'WMB-5231 前置编译：冻结读取版本 A',
    topicCompile: { summary: 'AI Agent 工具链主题编译' },
    entities: [
      { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '选型判断与创作复用' }
    ],
    notes: [
      { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', entityKeys: ['agentforge'], valueRationale: '可验证产品事实' },
      { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用方法' }
    ]
  };
  const a = compileSourceKnowledge(seedDatabase, { ...planA, requestId: sourceCompileRequestId(sourceA.id, sourceA.revision) });
  const sourceB = upsertSource(seedDatabase, {
    originalUrl: 'https://news.example/xiaohongshu-agent',
    title: '小红书运营 Agent 实践',
    summary: '团队用 AgentForge v2 跑通小红书批量内容生产。',
    author: 'Ops Team'
  });
  const planB = {
    workspaceId: 'ws-5231',
    sourceId: sourceB.id,
    sourceRevision: sourceB.revision,
    topicId: topic.id,
    reason: 'WMB-5231 前置编译：冻结读取版本 B',
    entities: [
      { entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '复用' }
    ],
    notes: [
      { kind: 'claim', canonicalKey: 'xhs-agent-practice', statement: '小红书批量内容生产可用 AgentForge v2 跑通', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-12', entityKeys: ['agentforge'], valueRationale: '平台适用事实' }
    ]
  };
  const b = compileSourceKnowledge(seedDatabase, { ...planB, requestId: sourceCompileRequestId(sourceB.id, sourceB.revision) });
  const readNoteIds = [a.noteVersionIds['agentforge-v2-multi-router'], a.noteVersionIds['agentforge-router-eval'], b.noteVersionIds['xhs-agent-practice']];
  const topicPages = listWikiPages(seedDatabase, { scope: 'global', pageType: 'topic' });
  const topicWikiVersionId = getWikiPage(seedDatabase, topicPages.items[0].id).version.id;
  const evidenceIds = [];
  for (const versionId of readNoteIds) {
    for (const item of listKnowledgeEvidenceLinks(seedDatabase, { noteVersionId: versionId }).items) evidenceIds.push(item.id);
  }
  check('前置：冻结读取版本就绪（3 Note 版本 + 1 Topic Wiki 版本 + ≥3 证据）',
    readNoteIds.length === 3 && Boolean(topicWikiVersionId) && evidenceIds.length >= 3);
  seedDatabase.close();

  runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'wmb5231-runtime' });
  check('前置：活动工作空间运行时就绪', runtime.isActive === true && runtime.identity.workspaceId === 'ws-5231');

  // ============ A. 无清单（未声明知识读取）→ 零写 + 原因可见 ============
  const convA = 'conv-5231-a';
  const qA = '普通寒暄，没有读取知识';
  const requestIdA = knowledgeQueryWritebackRequestId(convA, qA);
  const beforeA = snapshot();
  const settledA = await settleRound(convA, qA, '你好，今天有什么需要帮忙的吗？');
  check('A 正文原样返回（不阻断回答）', settledA.text === '你好，今天有什么需要帮忙的吗？' && settledA.writeback === null);
  assertNoWrite('A 无清单', beforeA);
  const outcomeA = getQueryWritebackSettleOutcome(requestIdA);
  check('A settle=not_written + QUERY_WRITEBACK_MANIFEST_MISSING + 可读原因',
    outcomeA?.state === 'not_written' && outcomeA?.code === 'QUERY_WRITEBACK_MANIFEST_MISSING'
    && typeof outcomeA?.reason === 'string' && outcomeA.reason.includes('未声明真实知识读取'));
  check('A hasQueryWritebackFence 区分无围栏', hasQueryWritebackFence('纯文本回复') === false);
  const summaryA = getQueryWritebackSummary(runtime.database, requestIdA);
  check('A 摘要投影：artifact null + settle 可见（面板显示未写回原因）',
    summaryA.artifact === null && summaryA.settle?.state === 'not_written' && summaryA.settle?.reason === outcomeA?.reason);

  // ============ B. 有围栏但非法 → 零写 + 清单非法原因 ============
  const convB = 'conv-5231-b';
  const qB = '非法清单轮';
  const requestIdB = knowledgeQueryWritebackRequestId(convB, qB);
  const beforeB = snapshot();
  const settledB = await settleRound(convB, qB, '这是回答正文。\n```json\n{not json}\n```');
  check('B 非法清单不阻断回答（正文原样）', settledB.text.includes('这是回答正文。') && settledB.writeback === null);
  assertNoWrite('B 非法清单', beforeB);
  const outcomeB = getQueryWritebackSettleOutcome(requestIdB);
  check('B settle=not_written + QUERY_WRITEBACK_MANIFEST_INVALID + 清单非法原因',
    outcomeB?.state === 'not_written' && outcomeB?.code === 'QUERY_WRITEBACK_MANIFEST_INVALID'
    && typeof outcomeB?.reason === 'string' && outcomeB.reason.includes('清单非法'));
  check('B hasQueryWritebackFence 识别非法围栏', hasQueryWritebackFence('```json\n{not json}\n```') === true);

  // ============ C. restatement（纯复述）→ 仅 Artifact + 回执，零知识 ============
  const convC = 'conv-5231-c';
  const qC = 'AgentForge v2 支持什么？';
  const requestIdC = knowledgeQueryWritebackRequestId(convC, qC);
  const beforeC = snapshot();
  const settledC = await settleRound(convC, qC,
    `按既有知识复述：AgentForge v2 支持多模型路由。\n${manifestBlock('restatement', { readNoteVersionIds: readNoteIds, readWikiVersionIds: [topicWikiVersionId] })}`);
  check('C restatement 正文剥离协议块', settledC.text === '按既有知识复述：AgentForge v2 支持多模型路由。' && !settledC.text.includes('wmb_query_writeback'));
  check('C restatement 写回成功（decision=skipped_repetition）',
    settledC.writeback?.ok === true && settledC.writeback?.classification === 'restatement'
    && settledC.writeback?.writeBackDecision === 'skipped_repetition');
  check('C 零知识写（Note/Wiki/版本/证据不变；仅 ChangeSet+Receipt+Artifact 新增）',
    snapshot().notes === beforeC.notes && snapshot().noteVersions === beforeC.noteVersions
    && snapshot().wikiPages === beforeC.wikiPages && snapshot().wikiVersions === beforeC.wikiVersions
    && snapshot().evidenceLinks === beforeC.evidenceLinks
    && snapshot().changeSets === beforeC.changeSets + 1 && snapshot().receipts === beforeC.receipts + 1
    && snapshot().artifacts === beforeC.artifacts + 1);
  check('C Artifact 冻结读取版本 + 回执',
    settledC.writeback?.artifact?.readNoteVersionIds.length === 3
    && settledC.writeback?.artifact?.readWikiVersionIds[0] === topicWikiVersionId
    && settledC.writeback?.artifact?.writeBackDecision === 'skipped_repetition'
    && settledC.writeback?.receipt?.triggerType === 'query');
  const outcomeC = getQueryWritebackSettleOutcome(requestIdC);
  check('C settle=written + restatement 分类', outcomeC?.state === 'written' && outcomeC?.classification === 'restatement');
  const summaryC = getQueryWritebackSummary(runtime.database, requestIdC);
  check('C 摘要投影：artifact 非空 + settle written', summaryC.artifact?.id === settledC.writeback?.artifact?.id && summaryC.settle?.state === 'written');

  // ============ H. 同问重放 → duplicate 零增量 ============
  const beforeH = snapshot();
  const replayedC = await settleRound(convC, qC,
    `按既有知识复述：AgentForge v2 支持多模型路由。\n${manifestBlock('restatement', { readNoteVersionIds: readNoteIds, readWikiVersionIds: [topicWikiVersionId] })}`);
  check('H 重放 duplicate 返回既有 Artifact',
    replayedC.writeback?.ok === true && replayedC.writeback?.duplicate === true
    && replayedC.writeback?.artifact?.id === settledC.writeback?.artifact?.id);
  assertNoWrite('H 同问重放', beforeH);
  const outcomeH = getQueryWritebackSettleOutcome(requestIdC);
  check('H settle 覆盖为 written（同问幂等）', outcomeH?.state === 'written' && outcomeH?.reason.includes('同问幂等'));

  // ============ D. new_synthesis → insight Note + derived_from 证据 + Synthesis Wiki ============
  const convD = 'conv-5231-d';
  const qD = '把 AgentForge 能力和小红书实践放一起，能得出什么可复用判断？';
  const requestIdD = knowledgeQueryWritebackRequestId(convD, qD);
  const synthesisKey = 'xhs-agentforge-synthesis';
  const statementD = 'AgentForge v2 的多模型路由用于小红书批量内容生产时，先按平台分流的样本做抽检再规模化。';
  const beforeD = snapshot();
  const settledD = await settleRound(convD, qD,
    `综合如下：${statementD}\n${manifestBlock('new_synthesis', {
      readNoteVersionIds: readNoteIds,
      readWikiVersionIds: [topicWikiVersionId],
      readEvidenceIds: evidenceIds,
      synthesis: { canonicalKey: synthesisKey, title: '小红书 × AgentForge 综合', statement: statementD, basedOnNoteVersionIds: readNoteIds, valueRationale: '两个独立来源互相印证，形成可复用工作流判断' }
    })}`);
  check('D 综合写回成功（decision=created）',
    settledD.writeback?.ok === true && settledD.writeback?.classification === 'new_synthesis'
    && settledD.writeback?.writeBackDecision === 'created'
    && settledD.writeback?.counts.notesCreated === 1 && settledD.writeback?.counts.noteVersionsCreated === 1
    && settledD.writeback?.counts.wikiPagesCompiled === 1);
  check('D 恰 1 新 Note + 1 新 Wiki 页', snapshot().notes === beforeD.notes + 1 && snapshot().wikiPages === beforeD.wikiPages + 1);
  check('D Note 为 insight + 采用冻结版本',
    getKnowledgeNote(runtime.database, settledD.writeback.noteIds[synthesisKey])?.note.kind === 'insight'
    && getKnowledgeNote(runtime.database, settledD.writeback.noteIds[synthesisKey])?.version.adoptedKnowledgeVersionIds.length === 3);
  check('D 证据只指向冻结读取版本（derived_from；回答本身不是证据）',
    listKnowledgeEvidenceLinks(runtime.database, { noteVersionId: settledD.writeback.noteVersionIds[synthesisKey] }).items.length >= 4
    && listKnowledgeEvidenceLinks(runtime.database, { noteVersionId: settledD.writeback.noteVersionIds[synthesisKey] }).items
      .every((item) => item.relation === 'derived_from' && (readNoteIds.includes(item.evidenceObjectId) || item.evidenceObjectId === topicWikiVersionId)));
  const synthesisPages = listWikiPages(runtime.database, { scope: 'global', pageType: 'synthesis' });
  const synthesisPage = getWikiPage(runtime.database, synthesisPages.items[0].id);
  check('D Synthesis Wiki 页创建且正文冻结本轮读取集',
    synthesisPages.items.length === 1 && synthesisPages.items[0].canonicalKey === `synthesis:${synthesisKey}`
    && synthesisPage.version.body.kind === 'synthesis-wiki'
    && JSON.stringify(synthesisPage.version.body.basedOn.noteVersionIds) === JSON.stringify(readNoteIds)
    && synthesisPage.version.body.basedOn.wikiVersionIds[0] === topicWikiVersionId);
  check('D Artifact 保留冻结证据读取', settledD.writeback?.artifact?.readEvidenceIds.length === evidenceIds.length);
  const outcomeD = getQueryWritebackSettleOutcome(requestIdD);
  check('D settle=written + new_synthesis 分类', outcomeD?.state === 'written' && outcomeD?.classification === 'new_synthesis');

  // ============ E. user_experience → 先保存不可变 FreeNote ============
  const convE = 'conv-5231-e';
  const qE = '我这边实际跑下来有个经验想记下来';
  const requestIdE = knowledgeQueryWritebackRequestId(convE, qE);
  const experienceBody = '我们团队实际跑下来，AgentForge v2 的批量生成在小红书图片场景要先过一遍人工抽检再发布。';
  const beforeE = snapshot();
  const settledE = await settleRound(convE, qE,
    `明白，我帮你记录这条经验。\n${manifestBlock('user_experience', { experience: { body: experienceBody } })}`);
  check('E 用户经验写回成功（decision=no_write_back + FreeNote 落库）',
    settledE.writeback?.ok === true && settledE.writeback?.classification === 'user_experience'
    && settledE.writeback?.writeBackDecision === 'no_write_back'
    && settledE.writeback?.freeNoteId !== null
    && getKnowledgeFreeNote(runtime.database, settledE.writeback.freeNoteId)?.body === experienceBody
    && getKnowledgeFreeNote(runtime.database, settledE.writeback.freeNoteId)?.sourceNature === 'pi_dialogue'
    && getKnowledgeFreeNote(runtime.database, settledE.writeback.freeNoteId)?.sessionRef === convE);
  check('E 零知识 Note/零 Wiki/零证据', snapshot().notes === beforeE.notes && snapshot().wikiPages === beforeE.wikiPages
    && snapshot().noteVersions === beforeE.noteVersions && snapshot().evidenceLinks === beforeE.evidenceLinks);
  const outcomeE = getQueryWritebackSettleOutcome(requestIdE);
  check('E settle=written + user_experience 分类', outcomeE?.state === 'written' && outcomeE?.classification === 'user_experience');
  const summaryE = getQueryWritebackSummary(runtime.database, requestIdE);
  check('E 摘要投影：Artifact no_write_back + FreeNote 原因可见',
    summaryE.artifact?.writeBackDecision === 'no_write_back' && summaryE.artifact?.skipReason?.includes(settledE.writeback.freeNoteId) === true);

  // ============ F. 幽灵冻结版本 → not_written + 零写 ============
  const convF = 'conv-5231-f';
  const qF = '复述幽灵版本';
  const requestIdF = knowledgeQueryWritebackRequestId(convF, qF);
  const beforeF = snapshot();
  const settledF = await settleRound(convF, qF,
    `按既有知识复述。\n${manifestBlock('restatement', { readNoteVersionIds: ['ghost-note-version-1'] })}`);
  check('F 幽灵版本失败不阻断回答', settledF.writeback === null);
  assertNoWrite('F 幽灵版本', beforeF);
  const outcomeF = getQueryWritebackSettleOutcome(requestIdF);
  check('F settle=not_written + QUERY_WRITEBACK_VERSION_NOT_FOUND + 可读原因',
    outcomeF?.state === 'not_written' && outcomeF?.code === 'QUERY_WRITEBACK_VERSION_NOT_FOUND'
    && typeof outcomeF?.reason === 'string' && outcomeF.reason.includes('ghost-note-version-1'));

  // ============ G. basedOn 不在读取集（回答冒充证据）→ not_written + 零写 ============
  const convG = 'conv-5231-g';
  const qG = '基于未读取版本做综合';
  const requestIdG = knowledgeQueryWritebackRequestId(convG, qG);
  const beforeG = snapshot();
  const settledG = await settleRound(convG, qG,
    `综合判断。\n${manifestBlock('new_synthesis', {
      readNoteVersionIds: readNoteIds,
      synthesis: { canonicalKey: 'stolen-basedon', statement: '基于未读取版本的综合', basedOnNoteVersionIds: ['ghost-not-read'], valueRationale: 'x' }
    })}`);
  check('G basedOn 越界失败不阻断回答', settledG.writeback === null);
  assertNoWrite('G basedOn 越界', beforeG);
  const outcomeG = getQueryWritebackSettleOutcome(requestIdG);
  check('G settle=not_written + QUERY_WRITEBACK_BASED_ON_NOT_READ + 可读原因',
    outcomeG?.state === 'not_written' && outcomeG?.code === 'QUERY_WRITEBACK_BASED_ON_NOT_READ'
    && typeof outcomeG?.reason === 'string' && outcomeG.reason.includes('ghost-not-read'));

  // ============ I. 摘要投影：无记录 requestId → settle null ============
  const summaryGhost = getQueryWritebackSummary(runtime.database, 'query:ghost:deadbeef');
  check('I 未知 requestId → artifact null 且 settle null', summaryGhost.artifact === null && summaryGhost.settle === null);

  const finalCounts = snapshot();
  check('最终对象总数（ChangeSet 5 / Receipt 5 / Artifact 3 / FreeNote 1 / Note 4 / Wiki 页 2）',
    finalCounts.changeSets === 5 && finalCounts.receipts === 5 && finalCounts.artifacts === 3 && finalCounts.freeNotes === 1
    && finalCounts.notes === 4 && finalCounts.wikiPages === 2,
    JSON.stringify(finalCounts));

  await runtime.stop({ drain: false });
  runtime = null;
  console.log(`WMB-5231 child: ${checks} checks passed`);
} catch (error) {
  console.error(error);
  try { await runtime?.stop({ drain: false }); } catch {}
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
