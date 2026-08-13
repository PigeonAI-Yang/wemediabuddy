/**
 * WMB-5233 空壳健康三态验收（子进程，真实 SQLite）。
 * 验收：零知识 / legacy-init / 真实编译 三种工作空间在 Topic / Library(列表) / Canvas
 * 读模型显示诚实三态（uncompiled / legacy_shell / compiled）——空壳不得显示 current/已编译；
 * Lint 对合法空壳零伪造 issue，对 stale/broken/disputed 保持既有检测与修复边界；
 * 判定只读（不写 schema/DB CHECK/compile_status）。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { listKnowledgeTopics, upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { getTopicCompileState } from '../src/main/knowledge-compile-state.ts';
import { getTopicWikiDetail } from '../src/main/knowledge-topic-library.ts';
import { runLegacyKnowledgeInit } from '../src/main/legacy-knowledge-init.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import {
  getWikiPage, listHealthIssues, listWikiPages
} from '../src/main/knowledge-flywheel.ts';
import { runLocalLint } from '../src/main/knowledge-health.ts';
import {
  addKnowledgeCanvasNode, createKnowledgeCanvas, getCanvasNodeDetail, getKnowledgeCanvasProjection
} from '../src/main/knowledge-canvas.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5233-state-db-'));
const database = migrateDatabase(path.join(directory, 'wmb.db'));
const NOW = new Date().toISOString();

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function count(databaseRef, table) {
  return Number(databaseRef.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function linkTopic(databaseRef, sourceId, topicId) {
  databaseRef.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
    .run(topicId, sourceId, 'primary', NOW, NOW);
}
function findIssue(items, affectedObjectId, issueType) {
  return items.find((item) => item.affectedObjectId === affectedObjectId && (!issueType || item.issueType === issueType)) ?? null;
}
function lintTopic(databaseRef, requestId, objectType, objectId) {
  return runLocalLint(databaseRef, {
    requestId,
    workspaceId: 'ws-a',
    scope: 'global',
    reason: 'WMB-5233 空壳 Lint 边界',
    detectors: ['broken_reference', 'unreturned_review', 'unresolved_contradiction', 'stale_wiki_page'],
    affectedObjects: [{ objectType, objectId }]
  });
}

// ============ 0. 工作空间 / 三个工作区状态种子 ============
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(NOW, NOW);
const topicUncompiled = upsertKnowledgeTopic(database, { title: '零知识主题（尚未编译）' });
const topicLegacy = upsertKnowledgeTopic(database, { title: 'legacy 初始主题（空壳）' });
const topicCompiled = upsertKnowledgeTopic(database, { title: '已编译主题' });
check('三个业务 Topic 已保存', Boolean(topicUncompiled.id) && Boolean(topicLegacy.id) && Boolean(topicCompiled.id));

const pagesBefore = count(database, 'knowledge_wiki_pages');
const issuesBefore = count(database, 'knowledge_health_issues');

// ============ A. 零知识工作区：uncompiled（无任何正式编译） ============
{
  const state = getTopicCompileState(database, topicUncompiled.id);
  check('A uncompiled：判定为 uncompiled 且无页面', state.state === 'uncompiled' && state.page === null && state.current === null);
  const detail = getTopicWikiDetail(database, { topicId: topicUncompiled.id });
  check('A uncompiled：Topic 详情 wiki 为空（诚实未编译）', detail.wiki === null);
  const list = listKnowledgeTopics(database, { limit: 100 }).items.find((item) => item.id === topicUncompiled.id);
  check('A uncompiled：列表投影 compileState=uncompiled', list?.compileState === 'uncompiled');
  const canvas = createKnowledgeCanvas(database, { title: '三态画布', topicId: topicUncompiled.id });
  addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'topic', objectId: topicUncompiled.id, x: 0, y: 0 });
  const proj = getKnowledgeCanvasProjection(database, { canvasId: canvas.id, mode: 'relation' });
  const node = proj.nodes.find((item) => item.objectType === 'topic' && item.objectId === topicUncompiled.id);
  check('A uncompiled：Canvas 投影节点 compileState=uncompiled', node?.compileState === 'uncompiled');
  const nodeDetail = getCanvasNodeDetail(database, { canvasId: canvas.id, nodeId: node.id });
  check('A uncompiled：Canvas 节点详情 formal.compileState=uncompiled', nodeDetail.formal.compileState === 'uncompiled');
  // Lint 边界：合法空壳零伪造 issue、零写。
  const lint = lintTopic(database, 'lint:5233:uncompiled:1', 'topic', topicUncompiled.id);
  check('A uncompiled：Lint 零新建 Issue 零 ChangeSet',
    lint.ok && lint.counts.issuesCreated === 0 && lint.counts.repairsApplied === 0 && lint.changeSetId === null);
  check('A uncompiled：Lint 后零新增 Issue 行', count(database, 'knowledge_health_issues') === issuesBefore);
}

// ============ B. legacy-init 工作区：legacy_shell（migration/derived，零采纳知识） ============
let legacyPageId = null;
{
  const init = runLegacyKnowledgeInit(database, { workspaceId: 'ws-a', scope: 'global', topicIds: [topicLegacy.id] });
  const initResult = init.topics.find((item) => item.topicId === topicLegacy.id);
  check('B legacy init 完成并创建初始 Wiki', initResult?.status === 'initialized' && init.totals.wikiPagesCreated === 1);
  legacyPageId = initResult.wikiPageId;
  const page = getWikiPage(database, legacyPageId);
  check('B legacy 页面存在且版本为 migration/derived-from-legacy',
    Boolean(page) && (page.version.flags ?? []).includes('migration') && (page.version.flags ?? []).includes('derived-from-legacy'));
  check('B legacy 页面零采纳知识', (page.version.adoptedNoteVersionIds ?? []).length === 0);
  // 空壳不得以 current 误导：DB compile_status 仍是 current（不改 schema/CHECK），但诚实三态必须为 legacy_shell。
  check('B legacy 页面 DB compile_status=current（既有语义保留）', page.page.compileStatus === 'current');
  const state = getTopicCompileState(database, topicLegacy.id);
  check('B legacy：诚实三态为 legacy_shell（不随 compile_status 谎报已编译）', state.state === 'legacy_shell');
  const detail = getTopicWikiDetail(database, { topicId: topicLegacy.id });
  check('B legacy：Topic 详情 wiki.compileState=legacy_shell', detail.wiki?.compileState === 'legacy_shell');
  check('B legacy：详情 compileStatus 为 current 但 compileState 诚实为 legacy_shell',
    detail.wiki?.compileStatus === 'current' && detail.wiki.compileState === 'legacy_shell');
  const list = listKnowledgeTopics(database, { limit: 100 }).items.find((item) => item.id === topicLegacy.id);
  check('B legacy：列表投影 compileState=legacy_shell', list?.compileState === 'legacy_shell');
  // legacy init 自身创建的真实健康问题（孤儿知识）保留：真实问题不消失。
  const orphan = findIssue(listHealthIssues(database, {}).items, legacyPageId, 'orphan_knowledge');
  check('B legacy：init 创建的 orphan_knowledge 真实问题存在', Boolean(orphan) && orphan.status === 'open');
  // Canvas 三态一致。
  const canvas = createKnowledgeCanvas(database, { title: 'legacy 画布', topicId: topicLegacy.id });
  addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'topic', objectId: topicLegacy.id, x: 0, y: 0 });
  const proj = getKnowledgeCanvasProjection(database, { canvasId: canvas.id, mode: 'health', includeResolvedIssues: true });
  const node = proj.nodes.find((item) => item.objectType === 'topic' && item.objectId === topicLegacy.id);
  check('B legacy：Canvas 投影节点 compileState=legacy_shell', node?.compileState === 'legacy_shell');
  const nodeDetail = getCanvasNodeDetail(database, { canvasId: canvas.id, nodeId: node.id });
  check('B legacy：Canvas 节点详情 formal.compileState=legacy_shell', nodeDetail.formal.compileState === 'legacy_shell');
  // Lint 边界：合法空壳（legacy 初始页）零伪造 issue —— orphan 是 init 自建的真实问题，不是 lint 伪造。
  const issuesAfterInit = count(database, 'knowledge_health_issues');
  const lintTopicShell = lintTopic(database, 'lint:5233:legacy:1', 'topic', topicLegacy.id);
  check('B legacy：Lint(topic) 零新建 Issue 零 ChangeSet',
    lintTopicShell.ok && lintTopicShell.counts.issuesCreated === 0 && lintTopicShell.changeSetId === null);
  const lintPageShell = runLocalLint(database, {
    requestId: 'lint:5233:legacy-page:1',
    workspaceId: 'ws-a', scope: 'global', reason: 'WMB-5233 空壳 Lint 边界',
    detectors: ['broken_reference', 'unreturned_review', 'unresolved_contradiction', 'stale_wiki_page'],
    affectedObjects: [{ objectType: 'wiki_page', objectId: legacyPageId }]
  });
  check('B legacy：Lint(wiki_page) 零新建 Issue 零 ChangeSet',
    lintPageShell.ok && lintPageShell.counts.issuesCreated === 0 && lintPageShell.changeSetId === null);
  check('B legacy：Lint 后 Issue 行数不变（仅 init 自建 orphan）', count(database, 'knowledge_health_issues') === issuesAfterInit);
  // 重复 Lint 同样零伪造（幂等）。
  const lintAgain = lintTopic(database, 'lint:5233:legacy:2', 'topic', topicLegacy.id);
  check('B legacy：重复 Lint 仍零新建', lintAgain.ok && lintAgain.counts.issuesCreated === 0 && lintAgain.changeSetId === null);
}

// ============ C. 真实编译工作区：compiled（有 ingest 正式编译 + 采纳知识） ============
let compiledPageId = null;
{
  const source = upsertSource(database, { originalUrl: 'https://news.example/agentx-v2', title: 'AgentX v2 官方公告', summary: 'AgentX v2 支持多模型路由。' });
  linkTopic(database, source.id, topicCompiled.id);
  const compiled = compileSourceKnowledge(database, {
    requestId: sourceCompileRequestId(source.id, source.revision),
    workspaceId: 'ws-a',
    sourceId: source.id,
    sourceRevision: source.revision,
    topicId: topicCompiled.id,
    reason: 'WMB-5233 真实编译种子',
    triggerSource: 'ingest',
    notes: [
      {
        kind: 'claim', canonicalKey: 'agentx-v2-routing', statement: 'AgentX v2 支持多模型路由。',
        conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'https://news.example/agentx-v2#p1',
        excerpt: 'AgentX v2 支持多模型路由。', valueRationale: '官方发布，可复用'
      },
      {
        kind: 'method', canonicalKey: 'multi-route-latency', statement: '多模型路由在高峰时段降低延迟。',
        conclusionStatus: 'inference', evidenceLevel: 'single', locator: 'https://news.example/agentx-v2#p2',
        excerpt: '社区反馈高峰时段延迟明显下降。', valueRationale: '改变认识的可用方法'
      }
    ]
  });
  check('C 真实编译成功且重编译 Wiki', compiled.ok && compiled.counts.wikiPagesCompiled === 1 && compiled.wikiPageId !== null);
  compiledPageId = compiled.wikiPageId;
  const page = getWikiPage(database, compiledPageId);
  check('C compiled 页面有采纳知识', (page.version.adoptedNoteVersionIds ?? []).length === 2);
  const state = getTopicCompileState(database, topicCompiled.id);
  check('C compiled：诚实三态为 compiled', state.state === 'compiled');
  const detail = getTopicWikiDetail(database, { topicId: topicCompiled.id });
  check('C compiled：Topic 详情 wiki.compileState=compiled', detail.wiki?.compileState === 'compiled');
  const list = listKnowledgeTopics(database, { limit: 100 }).items.find((item) => item.id === topicCompiled.id);
  check('C compiled：列表投影 compileState=compiled', list?.compileState === 'compiled');
  const canvas = createKnowledgeCanvas(database, { title: 'compiled 画布', topicId: topicCompiled.id });
  addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'topic', objectId: topicCompiled.id, x: 0, y: 0 });
  const proj = getKnowledgeCanvasProjection(database, { canvasId: canvas.id, mode: 'relation' });
  const node = proj.nodes.find((item) => item.objectType === 'topic' && item.objectId === topicCompiled.id);
  check('C compiled：Canvas 投影节点 compileState=compiled', node?.compileState === 'compiled');
  const nodeDetail = getCanvasNodeDetail(database, { canvasId: canvas.id, nodeId: node.id });
  check('C compiled：Canvas 节点详情 formal.compileState=compiled', nodeDetail.formal.compileState === 'compiled');
  // 健康编译页：Lint 零伪造。
  const lint = lintTopic(database, 'lint:5233:compiled:1', 'topic', topicCompiled.id);
  check('C compiled：Lint 零新建 Issue', lint.ok && lint.counts.issuesCreated === 0 && lint.changeSetId === null);
}

// ============ D. Lint 既有行为保持：stale / broken / disputed 仍被检测与修复 ============
{
  // D-1 stale_wiki_page：compile_status 显式 stale 仍报警（既有检测边界）。
  const issuesBeforeStale = count(database, 'knowledge_health_issues');
  database.prepare(`UPDATE knowledge_wiki_pages SET compile_status = 'stale', compile_note = 'WMB-5233 测试标记 stale' WHERE id = ?`).run(compiledPageId);
  const staleRun = lintTopic(database, 'lint:5233:stale:1', 'topic', topicCompiled.id);
  const staleIssue = staleRun.issues.find((item) => item.issueType === 'stale_wiki_page');
  check('D stale：compile_status=stale 仍生成 stale_wiki_page（open）',
    staleRun.counts.issuesCreated === 1 && staleIssue?.status === 'open' && staleIssue.affectedObjectId === compiledPageId);
  check('D stale：Issue 行数 +1', count(database, 'knowledge_health_issues') === issuesBeforeStale + 1);
  // 恢复 current，重复 Lint 自动解决（既有条件消除行为：局部 lint 按 affectedObjectId 复查）。
  database.prepare(`UPDATE knowledge_wiki_pages SET compile_status = 'current', compile_note = NULL WHERE id = ?`).run(compiledPageId);
  const cleared = runLocalLint(database, {
    requestId: 'lint:5233:stale-clear:1',
    workspaceId: 'ws-a', scope: 'global', reason: 'WMB-5233 空壳 Lint 边界',
    detectors: ['broken_reference', 'unreturned_review', 'unresolved_contradiction', 'stale_wiki_page'],
    affectedObjects: [{ objectType: 'wiki_page', objectId: compiledPageId }]
  });
  check('D stale：条件消除后自动解决（既有行为）', cleared.counts.issuesAutoResolved === 1 && cleared.issues[0]?.status === 'resolved');

  // D-2 broken_reference：坏关系自动 ChangeSet 修复（既有自动修复 allowlist 行为）。
  const seedChangeSetId = database.prepare('SELECT id FROM knowledge_change_sets ORDER BY created_at DESC, id DESC LIMIT 1').get().id;
  database.prepare(`INSERT INTO knowledge_formal_relations
    (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id,
     created_change_set_id, end_reason, created_at)
    VALUES ('rel-5233-ghost', 'global', 'derived_from', 'knowledge_note', 'note-ghost', 'source', 'source-ghost-5233', ?, '', ?)`)
    .run(seedChangeSetId, NOW);
  const brokenRun = lintTopic(database, 'lint:5233:broken:1', 'knowledge_relation', 'rel-5233-ghost');
  check('D broken：坏引用自动修复（repairsApplied=1 且 Issue 终态 resolved）',
    brokenRun.ok && brokenRun.counts.repairsApplied === 1 && brokenRun.counts.issuesCreated === 1
    && brokenRun.issues[0]?.issueType === 'broken_reference' && brokenRun.issues[0]?.status === 'resolved'
    && brokenRun.issues[0]?.resolvedChangeSetId === brokenRun.changeSetId);
  check('D broken：关系已终止', database.prepare(
    'SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-5233-ghost').e === brokenRun.changeSetId);

  // D-3 unresolved_contradiction：可信分歧恒 open 不自动裁决（既有检测边界）。
  const conflictSeed = { changeSetId: seedChangeSetId };
  database.prepare(`INSERT INTO knowledge_notes (id, scope, kind, lifecycle, canonical_key, title, current_version_id, revision, created_at, updated_at)
    VALUES ('note-5233-conflict', 'global', 'claim', 'active', '5233-conflict', '冲突断言', NULL, 1, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO knowledge_note_versions
    (id, note_id, version_number, title, statement, conclusion_status, evidence_level, applies_to, change_type,
     change_reason, creator_nature, change_set_id, created_at)
    VALUES ('nver-5233-conflict', 'note-5233-conflict', 1, '冲突断言', '当前认识为 disputed。', 'disputed', 'corroborated', '', 'created',
      'WMB-5233 冲突种子', 'background_agent', ?, ?)`).run(conflictSeed.changeSetId, NOW);
  database.prepare('UPDATE knowledge_notes SET current_version_id = ? WHERE id = ?').run('nver-5233-conflict', 'note-5233-conflict');
  const conflictRun = lintTopic(database, 'lint:5233:disputed:1', 'knowledge_note', 'note-5233-conflict');
  check('D disputed：可信冲突生成 open Issue 且零自动修复',
    conflictRun.counts.issuesCreated === 1 && conflictRun.issues[0]?.issueType === 'unresolved_contradiction'
    && conflictRun.issues[0]?.status === 'open' && conflictRun.counts.repairsApplied === 0);
}

// ============ E. 空壳判定只读：不写 schema/DB CHECK/compile_status ============
{
  const pagesNow = count(database, 'knowledge_wiki_pages');
  const statusRow = database.prepare('SELECT compile_status AS s, compile_note AS n FROM knowledge_wiki_pages WHERE id = ?').get(legacyPageId);
  check('E 三态判定零写（页面数不变）', pagesNow === pagesBefore + 2); // 仅 legacy + compiled 两个页面
  check('E legacy 空壳 compile_status 仍为 current（DB CHECK 未破坏）', statusRow.s === 'current');
  // 合法空壳（uncompiled + legacy_shell）在全部既有检测器下累计零伪造。
  const uncompiledAgain = lintTopic(database, 'lint:5233:uncompiled:2', 'topic', topicUncompiled.id);
  const legacyAgain = lintTopic(database, 'lint:5233:legacy:3', 'topic', topicLegacy.id);
  check('E 空壳累计零伪造（uncompiled/legacy 重复 Lint 均零新建）',
    uncompiledAgain.counts.issuesCreated === 0 && legacyAgain.counts.issuesCreated === 0
    && uncompiledAgain.changeSetId === null && legacyAgain.changeSetId === null);
}

database.close();
await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`WMB-5233 compile state child PASS (${checks} checks)`);
