/**
 * WMB-5240 固定版本 Query/写回串联聚焦验收（子进程，真实 SQLite + 真实 ActiveWorkspaceRuntime）。
 *
 * 覆盖（Pi 固定版本 Query 读面 + 既有 settle 写回串联）：
 * A. runFixedVersionQuery 按 ref 读取真实冻结版本（wiki_page:<pageId>:<versionId> /
 *    knowledge_note:<noteId>:<versionId> / evidence:<id>），内容与 DB 一致，versionRefs 幂等；
 * B. 裸 id 输入（readWikiVersionIds 等）与 refs 合并去重，同一 ID 空间；
 * C. 读回 id 可直接通过 settle 写回存在性校验：restatement 仅 Artifact+Receipt 零知识；
 * D. new_synthesis 基于读回 Note 版本写回（basedOn ⊆ read，derived_from 证据，Synthesis Wiki）；
 * E. 重放幂等：同问同清单 → duplicate 零增量；
 * F. 幽灵版本（删除）→ FIXED_VERSION_NOT_FOUND，写回 settle not_written（QUERY_WRITEBACK_VERSION_NOT_FOUND）；
 * G. 引用漂移（versionId 不属于 objectId）→ FIXED_VERSION_DRIFT；
 * H. 跨 workspace（ws-b 版本 id 在 ws-a DB 读取）→ FIXED_VERSION_NOT_FOUND（结构性隔离）；
 * I. 超限（每类 >64）→ FIXED_VERSION_LIMIT_EXCEEDED（读面）与 QUERY_WRITEBACK_INPUT_INVALID（写回输入面）
 *    / manifest 超限 → settle not_written（清单非法），零写；
 * J. 回答与写回结果均用户可见：settle 正文原样返回（剥离协议块）、摘要投影 artifact+settle。
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
  getQueryArtifactByRequest,
  getWikiPage,
  listKnowledgeEvidenceLinks,
  listWikiPages
} from '../src/main/knowledge-flywheel.ts';
import {
  getQueryWritebackSettleOutcome,
  getQueryWritebackSummary
} from '../src/main/query-writeback.ts';
import {
  parseFixedVersionRef,
  runFixedVersionQuery,
  resolveFixedVersionRefs
} from '../src/main/fixed-version-query.ts';
import { knowledgeQueryWritebackRequestId } from '../src/shared/knowledge-flywheel.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5240-fvq-db-'));
let runtime = null;

function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function snapshot() {
  return {
    changeSets: count(runtime.database, 'knowledge_change_sets'),
    receipts: count(runtime.database, 'knowledge_update_receipts'),
    artifacts: count(runtime.database, 'knowledge_query_artifacts'),
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
  ).run('workspace_id', 'ws-5240-fvq', now, now);
  const sourceA = upsertSource(seedDatabase, {
    originalUrl: 'https://news.example/agentforge-v2',
    title: 'AgentForge v2 发布：多模型路由',
    summary: 'AgentForge 官方发布 v2，引入多模型路由能力。',
    author: 'News Desk'
  });
  const topic = upsertKnowledgeTopic(seedDatabase, { title: 'AI Agent 工具链' });
  const planA = {
    workspaceId: 'ws-5240-fvq',
    sourceId: sourceA.id,
    sourceRevision: sourceA.revision,
    topicId: topic.id,
    reason: 'WMB-5240 前置编译：冻结读取版本 A',
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
    workspaceId: 'ws-5240-fvq',
    sourceId: sourceB.id,
    sourceRevision: sourceB.revision,
    topicId: topic.id,
    reason: 'WMB-5240 前置编译：冻结读取版本 B',
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
  const topicPage = getWikiPage(seedDatabase, topicPages.items[0].id);
  const topicWikiVersionId = topicPage.version.id;
  const topicPageId = topicPages.items[0].id;
  const evidenceIds = [];
  for (const versionId of readNoteIds) {
    for (const item of listKnowledgeEvidenceLinks(seedDatabase, { noteVersionId: versionId }).items) evidenceIds.push(item.id);
  }
  check('前置：冻结读取版本就绪（3 Note 版本 + 1 Topic Wiki 版本 + ≥3 证据）',
    readNoteIds.length === 3 && Boolean(topicWikiVersionId) && evidenceIds.length >= 3);
  seedDatabase.close();

  runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'wmb5240-fvq-runtime' });
  check('前置：活动工作空间运行时就绪', runtime.isActive === true && runtime.identity.workspaceId === 'ws-5240-fvq');

  // ============ A. ref 读取真实冻结版本（引用字符串 → 内容） ============
  const wikiRef = `wiki_page:${topicPageId}:${topicWikiVersionId}`;
  const noteRefs = readNoteIds.map((id) => {
    const row = runtime.database.prepare('SELECT note_id AS noteId FROM knowledge_note_versions WHERE id = ?').get(id);
    return `knowledge_note:${row.noteId}:${id}`;
  });
  const evidenceRefs = evidenceIds.map((id) => `evidence:${id}`);
  const readA = runFixedVersionQuery(runtime.database, {
    question: '基于这些版本回答：AgentForge v2 与小红书实践',
    wikiVersionRefs: [wikiRef],
    noteVersionRefs: noteRefs,
    evidenceRefs
  });
  check('A ok + 读取集一致', readA.ok === true);
  if (readA.ok) {
    check('A readWikiVersionIds 恰为冻结 Topic Wiki 版本', readA.readWikiVersionIds[0] === topicWikiVersionId);
    check('A readNoteVersionIds 与冻结 Note 版本一致', JSON.stringify([...readA.readNoteVersionIds].sort()) === JSON.stringify([...readNoteIds].sort()));
    check('A readEvidenceIds 与冻结证据一致', JSON.stringify([...readA.readEvidenceIds].sort()) === JSON.stringify([...evidenceIds].sort()));
    check('A 内容与 DB 一致（wiki title / note statement / evidence relation）',
      readA.wikiPages[0]?.versionId === topicWikiVersionId && readA.wikiPages[0]?.pageType === 'topic'
      && readA.noteVersions.length === 3
      && readA.noteVersions.some((n) => n.statement === 'AgentForge v2 支持多模型路由')
      && readA.evidence.length >= 3 && readA.evidence.every((e) => e.relation !== undefined));
    check('A versionRefs 幂等（包含输入引用字符串）',
      readA.versionRefs.includes(wikiRef) && noteRefs.every((ref) => readA.versionRefs.includes(ref))
      && evidenceRefs.every((ref) => readA.versionRefs.includes(ref)));
    check('A workspaceId 绑定当前工作空间', readA.workspaceId === 'ws-5240-fvq');
  }

  // ============ B. 裸 id 输入与 refs 合并去重 ============
  const readB = runFixedVersionQuery(runtime.database, {
    wikiVersionIds: [topicWikiVersionId],
    noteVersionRefs: [noteRefs[0]],
    evidenceIds: [evidenceIds[0]]
  });
  check('B 裸 id + refs 合并去重', readB.ok === true);
  if (readB.ok) {
    check('B wiki 恰好 1 个', readB.readWikiVersionIds.length === 1 && readB.readWikiVersionIds[0] === topicWikiVersionId);
    check('B note 恰好 1 个', readB.readNoteVersionIds.length === 1 && readB.readNoteVersionIds[0] === readNoteIds[0]);
    check('B evidence 恰好 1 个', readB.readEvidenceIds.length === 1 && readB.readEvidenceIds[0] === evidenceIds[0]);
  }
  // parseFixedVersionRef 语法门
  check('B 语法门：合法 ref 解析 / 非法 ref 为 null',
    parseFixedVersionRef(wikiRef)?.kind === 'wiki_page'
    && parseFixedVersionRef('wiki_page:a:b')?.objectId === 'a'
    && parseFixedVersionRef('wiki_page:a') === null
    && parseFixedVersionRef('entity:x:y') === null
    && parseFixedVersionRef('  ') === null);
  const refResolve = resolveFixedVersionRefs(runtime.database, [wikiRef, ...noteRefs, ...evidenceRefs]);
  check('B resolveFixedVersionRefs ok + 三集合一致',
    refResolve.ok === true
    && (refResolve.ok ? refResolve.wikiVersionIds[0] === topicWikiVersionId && refResolve.evidenceIds.length === evidenceIds.length : false));

  // ============ C. restatement：读回 id 直连 settle 写回（仅 Artifact+Receipt 零知识） ============
  const convC = 'conv-5240-fvq-c';
  const qC = 'AgentForge v2 支持什么？';
  const requestIdC = knowledgeQueryWritebackRequestId(convC, qC);
  const beforeC = snapshot();
  const settledC = await settleRound(convC, qC,
    `按固定版本复述：AgentForge v2 支持多模型路由。\n${manifestBlock('restatement', { readNoteVersionIds: readNoteIds, readWikiVersionIds: [topicWikiVersionId] })}`);
  check('C 正文剥离协议块且原样可见', settledC.text === '按固定版本复述：AgentForge v2 支持多模型路由。' && !settledC.text.includes('wmb_query_writeback'));
  check('C restatement 写回成功（skipped_repetition）',
    settledC.writeback?.ok === true && settledC.writeback?.classification === 'restatement'
    && settledC.writeback?.writeBackDecision === 'skipped_repetition');
  check('C 零知识写（仅 ChangeSet+Receipt+Artifact 新增）',
    snapshot().notes === beforeC.notes && snapshot().noteVersions === beforeC.noteVersions
    && snapshot().wikiPages === beforeC.wikiPages && snapshot().wikiVersions === beforeC.wikiVersions
    && snapshot().evidenceLinks === beforeC.evidenceLinks
    && snapshot().changeSets === beforeC.changeSets + 1 && snapshot().receipts === beforeC.receipts + 1
    && snapshot().artifacts === beforeC.artifacts + 1);
  const outcomeC = getQueryWritebackSettleOutcome(requestIdC);
  check('C settle=written + 摘要投影可见', outcomeC?.state === 'written'
    && getQueryWritebackSummary(runtime.database, requestIdC).artifact?.readNoteVersionIds.length === 3);

  // ============ E. 重放幂等（同问同清单 → duplicate 零增量） ============
  const beforeE = snapshot();
  const replayedC = await settleRound(convC, qC,
    `按固定版本复述：AgentForge v2 支持多模型路由。\n${manifestBlock('restatement', { readNoteVersionIds: readNoteIds, readWikiVersionIds: [topicWikiVersionId] })}`);
  check('E 重放 duplicate 返回既有 Artifact',
    replayedC.writeback?.ok === true && replayedC.writeback?.duplicate === true
    && replayedC.writeback?.artifact?.id === settledC.writeback?.artifact?.id);
  assertNoWrite('E 同问重放', beforeE);

  // ============ D. new_synthesis：基于读回 Note 版本写回（basedOn ⊆ read） ============
  const convD = 'conv-5240-fvq-d';
  const qD = '把 AgentForge 能力和小红书实践放一起，能得出什么可复用判断？';
  const requestIdD = knowledgeQueryWritebackRequestId(convD, qD);
  const synthesisKey = 'fvq-xhs-agentforge-synthesis';
  const statementD = 'AgentForge v2 的多模型路由用于小红书批量内容生产时，先按平台分流的样本做抽检再规模化。';
  const beforeD = snapshot();
  const settledD = await settleRound(convD, qD,
    `综合如下：${statementD}\n${manifestBlock('new_synthesis', {
      readNoteVersionIds: readNoteIds,
      readWikiVersionIds: [topicWikiVersionId],
      readEvidenceIds: evidenceIds,
      synthesis: { canonicalKey: synthesisKey, title: '小红书 × AgentForge 综合（固定版本）', statement: statementD, basedOnNoteVersionIds: readNoteIds, valueRationale: '两个独立来源互相印证，形成可复用工作流判断' }
    })}`);
  check('D 综合写回成功（created）+ 恰 1 Note + 1 Wiki 页',
    settledD.writeback?.ok === true && settledD.writeback?.writeBackDecision === 'created'
    && snapshot().notes === beforeD.notes + 1 && snapshot().wikiPages === beforeD.wikiPages + 1);
  const summaryD = getQueryWritebackSummary(runtime.database, requestIdD);
  check('D 摘要投影：Artifact + riskFlags 可读 + settle written',
    summaryD.artifact?.readNoteVersionIds.length === 3 && summaryD.settle?.state === 'written');

  // ============ F. 幽灵版本（删除）→ 读面 NOT_FOUND + 写回 not_written ============
  const ghost = 'ghost-note-version-5240';
  const readF = runFixedVersionQuery(runtime.database, { noteVersionRefs: [`knowledge_note:any:${ghost}`] });
  check('F 读面幽灵版本 → FIXED_VERSION_NOT_FOUND', readF.ok === false && readF.error.code === 'FIXED_VERSION_NOT_FOUND');
  const convF = 'conv-5240-fvq-f';
  const qF = '复述幽灵版本';
  const requestIdF = knowledgeQueryWritebackRequestId(convF, qF);
  const beforeF = snapshot();
  const settledF = await settleRound(convF, qF,
    `按既有知识复述。\n${manifestBlock('restatement', { readNoteVersionIds: [ghost] })}`);
  check('F 写回幽灵版本失败不阻断回答', settledF.writeback === null);
  assertNoWrite('F 写回幽灵版本', beforeF);
  check('F settle=not_written + QUERY_WRITEBACK_VERSION_NOT_FOUND',
    getQueryWritebackSettleOutcome(requestIdF)?.state === 'not_written'
    && getQueryWritebackSettleOutcome(requestIdF)?.code === 'QUERY_WRITEBACK_VERSION_NOT_FOUND');

  // ============ G. 引用漂移（versionId 不属于 objectId）→ FIXED_VERSION_DRIFT ============
  const readG = runFixedVersionQuery(runtime.database, { noteVersionRefs: [`knowledge_note:wrong-object:${readNoteIds[0]}`] });
  check('G 读面漂移 → FIXED_VERSION_DRIFT', readG.ok === false && readG.error.code === 'FIXED_VERSION_DRIFT');
  const resolveG = resolveFixedVersionRefs(runtime.database, [`wiki_page:wrong-page:${topicWikiVersionId}`]);
  check('G resolve 面漂移 → FIXED_VERSION_DRIFT', resolveG.ok === false && resolveG.error.code === 'FIXED_VERSION_DRIFT');
  // 语法非法 → REF_INVALID
  const readG2 = runFixedVersionQuery(runtime.database, { noteVersionRefs: ['knowledge_note:only-one-segment'] });
  check('G 语法非法 → FIXED_VERSION_REF_INVALID', readG2.ok === false && readG2.error.code === 'FIXED_VERSION_REF_INVALID');

  // ============ H. 跨 workspace（ws-b 版本 id 在 ws-a DB 读取）→ NOT_FOUND（结构性隔离） ============
  const readH = runFixedVersionQuery(runtime.database, { noteVersionRefs: [`knowledge_note:${topic.id}:ws-b-version-id`] });
  check('H 跨 workspace id 读面 → FIXED_VERSION_NOT_FOUND', readH.ok === false && readH.error.code === 'FIXED_VERSION_NOT_FOUND');

  // ============ I. 超限（每类 >64）→ 读面 LIMIT + 写回输入面 INVALID / manifest 非法零写 ============
  const overLimit = Array.from({ length: 65 }, (_, i) => `knowledge_note:obj${i}:v${i}`);
  const readI = runFixedVersionQuery(runtime.database, { noteVersionRefs: overLimit });
  check('I 读面超限 → FIXED_VERSION_LIMIT_EXCEEDED', readI.ok === false && readI.error.code === 'FIXED_VERSION_LIMIT_EXCEEDED');
  const overLimitIds = Array.from({ length: 65 }, (_, i) => `n${i}`);
  const convI = 'conv-5240-fvq-i';
  const qI = '超限清单轮';
  const requestIdI = knowledgeQueryWritebackRequestId(convI, qI);
  const beforeI = snapshot();
  const settledI = await settleRound(convI, qI,
    `复述。\n${manifestBlock('restatement', { readNoteVersionIds: overLimitIds })}`);
  check('I 写回超限清单零写（manifest 非法）', settledI.writeback === null);
  assertNoWrite('I 写回超限清单', beforeI);
  check('I settle=not_written + 清单非法原因', getQueryWritebackSettleOutcome(requestIdI)?.state === 'not_written'
    && getQueryWritebackSettleOutcome(requestIdI)?.code === 'QUERY_WRITEBACK_MANIFEST_INVALID');

  // ============ J. 回答与写回结果均用户可见（未知 requestId settle null；正文原样） ============
  const summaryGhost = getQueryWritebackSummary(runtime.database, 'query:ghost:deadbeef');
  check('J 未知 requestId → artifact null + settle null', summaryGhost.artifact === null && summaryGhost.settle === null);
  const convJ = 'conv-5240-fvq-j';
  const qJ = '无清单寒暄';
  const settledJ = await settleRound(convJ, qJ, '你好，今天有什么需要帮忙的吗？');
  check('J 无清单正文原样返回且零写可见', settledJ.text === '你好，今天有什么需要帮忙的吗？' && settledJ.writeback === null
    && getQueryWritebackSummary(runtime.database, knowledgeQueryWritebackRequestId(convJ, qJ)).settle?.state === 'not_written');

  // 最终对象总数（2 次前置编译 + C restatement + D synthesis：ChangeSet 4 / Receipt 4 / Artifact 2 /
  // Note 4 / Wiki 页 2；F/G/H/I/J 全部零写）
  const finalCounts = snapshot();
  check('最终对象总数（ChangeSet 4 / Receipt 4 / Artifact 2 / Note 4 / Wiki 页 2）',
    finalCounts.changeSets === 4 && finalCounts.receipts === 4 && finalCounts.artifacts === 2
    && finalCounts.notes === 4 && finalCounts.wikiPages === 2,
    JSON.stringify(finalCounts));

  await runtime.stop({ drain: false });
  runtime = null;
  console.log(`WMB-5240 fixed-version-query child: ${checks} checks passed`);
} catch (error) {
  console.error(error);
  try { await runtime?.stop({ drain: false }); } catch {}
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
