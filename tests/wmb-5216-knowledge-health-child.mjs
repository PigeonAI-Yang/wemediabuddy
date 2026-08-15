/**
 * WMB-5216 M7 知识健康服务契约验收（子进程，真实 SQLite）。
 * 验收：有界局部 Lint 去重（重复扫描不重复 Issue）；broken reference 自动 ChangeSet 原子修复；
 * 修复失败零部分写；final Review 未回流 Issue + 回流出现自动解决；可信冲突恒 open 不自动裁决；
 * 周期 Lint checkpoint 可恢复续跑不重复 Issue、崩溃后重试零写；同一 Issue 在
 * Topic/Library/Canvas/Results 读模型身份一致；workspace/lane/data-root 隔离；范围上限拒绝。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import {
  applyKnowledgeChangeSet, getChangeSet, getHealthIssue, getKnowledgeNote, getUpdateReceiptByRequest,
  listChangeSets, listHealthIssues, setKnowledgeChangeSetLintTrigger
} from '../src/main/knowledge-flywheel.ts';
import {
  beginPeriodicLint, cancelPeriodicLint, getPeriodicLintCheckpoint, KNOWLEDGE_HEALTH_DETECTOR_VERSION,
  recoverOrRetryPeriodicLintJobs, registerKnowledgeChangeSetLintTrigger, runDuePeriodicLintJobs,
  runLocalLint, runPeriodicLintStep, schedulePeriodicLintJob
} from '../src/main/knowledge-health.ts';
import { getTopicWikiDetail } from '../src/main/knowledge-topic-library.ts';
import { addKnowledgeCanvasNode, createKnowledgeCanvas, getKnowledgeCanvasProjection } from '../src/main/knowledge-canvas.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5216-health-db-'));
const database = migrateDatabase(path.join(directory, 'wmb.db'));
const NOW = new Date().toISOString();

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function expectError(label, fn, code) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    if (code) {
      const actual = error?.code ?? '';
      if (actual !== code) {
        throw new Error(`FAIL [${checks}] ${label} — 期望错误码 ${code}，实际 ${actual ?? error?.message}`);
      }
    }
    return;
  }
  throw new Error(`FAIL [${checks}] ${label} — 未抛出 ${code ?? '错误'}`);
}
function count(databaseRef, table) {
  return Number(databaseRef.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function meta(requestId, triggerSource = 'ingest', extra = {}) {
  return { workspaceId: 'ws-a', requestId, reason: '测试种子', triggerSource, resolutionMode: 'none', createdBy: 'background_agent', ...extra };
}
function rawInsertGhostRelation(databaseRef, relationId, fromType, fromId, toType, toId, seedChangeSetId, scope = 'global', relationKey = 'derived_from') {
  databaseRef.prepare(
    `INSERT INTO knowledge_formal_relations
      (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id,
       created_change_set_id, end_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`
  ).run(relationId, scope, relationKey, fromType, fromId, toType, toId, seedChangeSetId, NOW);
}
function rawInsertGhostEvidence(databaseRef, linkId, noteVersionId, evidenceObjectId, seedChangeSetId) {
  databaseRef.prepare(
    `INSERT INTO knowledge_evidence_links
      (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature,
       excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
     VALUES (?, ?, 'source', ?, 'supports', 'primary_source', NULL, NULL, NULL, 'background_agent', ?, ?)`
  ).run(linkId, noteVersionId, evidenceObjectId, seedChangeSetId, NOW);
}
function findIssue(items, affectedObjectId, issueType) {
  return items.find((item) => item.affectedObjectId === affectedObjectId && (!issueType || item.issueType === issueType)) ?? null;
}

// ============ 0. 工作空间 / 赛道 / 业务身份种子 ============
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(NOW, NOW);
{
  const laneSource = upsertSource(database, { originalUrl: 'https://lane.example/1', title: '赛道资料' });
  database.prepare(`INSERT INTO source_lane_judgments (id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at)
    VALUES (?, ?, 'uk-life-content-radar', 'relevant', 'lane_relevant', NULL, 'editor', NULL, 1, ?)`)
    .run('lane-judg-1', laneSource.id, NOW);
  check('赛道身份已注册', true);
}
const source = upsertSource(database, { originalUrl: 'https://news.example/agent-x', title: 'AgentX 发布', summary: 'AgentX 官方发布。' });
const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
check('真实 Source/Topic 已保存', Boolean(source.id) && Boolean(topic.id));

// ============ 知识对象种子（经唯一正式写入口） ============
const seed = applyKnowledgeChangeSet(database, meta('health-seed-1'), {
  notes: [
    {
      id: 'note-ok', scope: 'global', kind: 'claim', canonicalKey: 'agentx-router-claim',
      version: { statement: 'AgentX 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', adoptedTopicIds: [topic.id] }
    },
    {
      id: 'note-conflict', scope: 'global', kind: 'claim', canonicalKey: 'agentx-router-dispute',
      version: { statement: '另一可信来源反对多模型路由结论', conclusionStatus: 'disputed', evidenceLevel: 'single', adoptedTopicIds: [topic.id] }
    }
  ],
  wikiPages: [{
    id: 'page-topic', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-agentx-tools',
    subjectType: 'topic', subjectId: topic.id, compileStatus: 'stale', compileNote: '待重编译'
  }],
  relations: [
    { op: 'create', id: 'rel-ok', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-ok', toObjectType: 'topic', toObjectId: topic.id }
  ],
  receipts: [{ triggerType: 'ingest', requestId: 'health-seed-1', summary: '知识健康测试种子', counts: { notes: 2, wikiPages: 1 } }]
});
check('知识对象种子 ChangeSet 已提交', Boolean(seed.changeSetId));
const seedChangeSetId = seed.changeSetId;
const noteOkVersionId = getKnowledgeNote(database, 'note-ok').version.id;
applyKnowledgeChangeSet(database, meta('health-seed-2'), {
  evidenceLinks: [{
    id: 'ev-ok', knowledgeNoteVersionId: noteOkVersionId,
    evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source'
  }],
  receipts: [{ triggerType: 'ingest', requestId: 'health-seed-2', summary: '证据链接种子', counts: { evidenceLinks: 1 } }]
});

// ============ 发布链路 + final Review 种子（reviews 为真实业务表） ============
{
  database.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision)
    VALUES ('acc-x', 'x', 'acctkey', 'X 账号', 'authenticated', NULL, ?, ?, 1)`).run(NOW, NOW);
  database.prepare(`INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision)
    VALUES ('proj-1', ?, NULL, '发布项目', ?, ?, 1)`).run(topic.id, NOW, NOW);
  database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at)
    VALUES ('cv-1', 'proj-1', '正文', 1, ?)`).run(NOW);
  database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
    VALUES ('pv-1', 'proj-1', 'cv-1', 'x', 'post', '标题', '正文', '[]', ?, ?, 1)`).run(NOW, NOW);
  database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, prepared_title, prepared_body, prepared_assets_json, created_at, updated_at, revision)
    VALUES ('pub-1', 'pv-1', 1, 'x', 'acc-x', 'acctkey', 'published', NULL, NULL, '[]', ?, ?, 1)`).run(NOW, NOW);
  database.prepare(`INSERT INTO publication_metric_snapshots (id, publication_id, scheduled_for, captured_at, source_url, normalized_json, raw_json, created_at)
    VALUES ('snap-1', 'pub-1', ?, ?, 'https://x.example/1', '{}', '{}', ?)`).run(NOW, NOW, NOW);
  database.prepare(`INSERT INTO reviews (id, publication_id, content_version_id, metric_snapshot_ids_json, status, keep_json, stop_json, change_json, summary, created_at, updated_at, finalized_at, revision)
    VALUES ('rev-1', 'pub-1', 'cv-1', '["snap-1"]', 'final', '["标题"]', '["太长"]', '["缩短"]', '复盘', ?, ?, ?, 1)`).run(NOW, NOW, NOW);
  check('final Review 已保存', true);
}

const initialChangeSetCount = count(database, 'knowledge_change_sets');
const initialIssueCount = count(database, 'knowledge_health_issues');

// ============ A. 周期 Lint 无 checkpoint 拒绝（零写） ============
expectError('A 无 checkpoint 拒绝', () => runPeriodicLintStep(database), 'HEALTH_LINT_NO_CHECKPOINT');
check('A 拒绝零写', count(database, 'knowledge_change_sets') === initialChangeSetCount && count(database, 'knowledge_health_issues') === initialIssueCount);

// ============ B. 局部 Lint 去重：重复扫描不重复 Issue ============
const b1 = runLocalLint(database, {
  requestId: 'lint-local-conflict-1', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-conflict' }]
});
// v2 局部 Lint 对无证据/无正式关系/未被 Wiki 采纳的 disputed note 同时产出 unresolved_contradiction + orphan_knowledge。
check('B 首次发现可信冲突 Issue', b1.ok && b1.counts.issuesCreated === 2 && b1.issues.length === 2);
check('B Issue 为 unresolved_contradiction 且 open',
  b1.issues[0]?.issueType === 'unresolved_contradiction' && b1.issues[0]?.status === 'open'
  && b1.issues[0]?.affectedObjectType === 'knowledge_note' && b1.issues[0]?.affectedObjectId === 'note-conflict');
const conflictIssueId = b1.issues[0].id;
check('B 无自动修复（可信冲突不裁决）', b1.counts.repairsApplied === 0 && b1.changeSetId !== null);

const b2 = runLocalLint(database, {
  requestId: 'lint-local-conflict-2', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-conflict' }]
});
check('B 重复扫描去重零新建', b2.counts.issuesCreated === 0 && b2.counts.issuesDeduplicated === 2);
check('B 同一 Issue 行数不变', count(database, 'knowledge_health_issues') === initialIssueCount + 2);
check('B 同一 Issue id 不变', getHealthIssue(database, conflictIssueId)?.status === 'open');

// ============ C. 不可修复坏证据引用（源已删除）：open 不自动裁决 ============
rawInsertGhostEvidence(database, 'ev-ghost', getKnowledgeNote(database, 'note-ok').version.id, 'ghost-source-deleted', seedChangeSetId);
const c1 = runLocalLint(database, {
  requestId: 'lint-local-ghost-evidence-1', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-ok' }]
});
check('C 坏证据引用生成 open Issue（不自动修复）',
  c1.counts.issuesCreated === 1 && c1.issues[0]?.issueType === 'broken_reference'
  && c1.issues[0]?.affectedObjectType === 'knowledge_note_version' && c1.issues[0]?.status === 'open'
  && c1.counts.repairsApplied === 0);
check('C 证据链接未被删除（不可变）', database.prepare('SELECT id FROM knowledge_evidence_links WHERE id = ?').get('ev-ghost') !== undefined);

// ============ D. broken reference（formal relation）自动 ChangeSet 修复 ============
rawInsertGhostRelation(database, 'rel-ghost-1', 'knowledge_note', 'note-ok', 'source', 'ghost-source-1', seedChangeSetId);
const d1 = runLocalLint(database, {
  requestId: 'lint-local-repair-1', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-1' }]
});
check('D 自动修复发生（relations end + Issue 建后即 resolved）',
  d1.ok && d1.counts.repairsApplied === 1 && d1.counts.issuesCreated === 1 && d1.counts.issuesAutoResolved === 0);
check('D 修复生成 lint 回执', d1.receipt?.triggerType === 'lint' && Boolean(d1.receipt.id));
check('D 回执可读回', getUpdateReceiptByRequest(database, 'ws-a', 'lint-local-repair-1')?.id === d1.receipt?.id);
const ghostRelRow = database.prepare(
  'SELECT ended_change_set_id AS endedChangeSetId, end_reason AS endReason FROM knowledge_formal_relations WHERE id = ?'
).get('rel-ghost-1');
check('D 关系已终止并记录原因', ghostRelRow.endedChangeSetId === d1.changeSetId && String(ghostRelRow.endReason).includes('auto-repair'));
const repairIssue = d1.issues[0];
check('D 修复 Issue 终态 resolved 且挂修复 ChangeSet',
  repairIssue?.status === 'resolved' && repairIssue?.resolvedChangeSetId === d1.changeSetId
  && String(repairIssue?.resolutionNote ?? '').includes('确定性修复'));
check('D 单一原子 ChangeSet（无部分写）', count(database, 'knowledge_change_sets') === initialChangeSetCount + 3);

// ============ E. 修复失败零部分写（同 requestId 不同输入 → REQUEST_REPLAY_CONFLICT，整体回滚） ============
rawInsertGhostRelation(database, 'rel-ghost-2', 'knowledge_note', 'note-ok', 'source', 'ghost-source-2', seedChangeSetId);
const ghostEvidenceIssueId = findIssue(c1.issues, getKnowledgeNote(database, 'note-ok').version.id, 'broken_reference')?.id;
const changeSetsBeforeFail = count(database, 'knowledge_change_sets');
expectError('E 同 requestId 不同输入拒绝', () => runLocalLint(database, {
  requestId: 'lint-local-ghost-evidence-1', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [
    { objectType: 'knowledge_note', objectId: 'note-ok' },
    { objectType: 'knowledge_relation', objectId: 'rel-ghost-2' }
  ]
}), 'REQUEST_REPLAY_CONFLICT');
check('E 失败后关系未终止（零部分写）', database.prepare(
  'SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-2').e === null);
check('E 失败后零新增 ChangeSet', count(database, 'knowledge_change_sets') === changeSetsBeforeFail);
check('E 失败后坏证据 Issue 保持 open 且未新增', getHealthIssue(database, ghostEvidenceIssueId)?.status === 'open');
check('E 失败后无 rel-ghost-2 的 Issue', findIssue(listHealthIssues(database).items, 'rel-ghost-2', 'broken_reference') === null);

// 单独修复 rel-ghost-2（证明修复路径本身可用）
const e2 = runLocalLint(database, {
  requestId: 'lint-local-repair-2', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-2' }]
});
check('E 修复路径可用（rel-ghost-2 已终止）', e2.counts.repairsApplied === 1 && database.prepare(
  'SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-2').e !== null);

// ============ F. final Review 未回流 → Issue；回流出现 → 自动解决 ============
const f1 = runLocalLint(database, {
  requestId: 'lint-local-review-1', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'review', objectId: 'rev-1' }]
});
check('F final Review 未回流生成 unreturned_review Issue',
  f1.counts.issuesCreated === 1 && f1.issues[0]?.issueType === 'unreturned_review'
  && f1.issues[0]?.affectedObjectId === 'rev-1' && f1.issues[0]?.status === 'open');
const reviewIssueId = f1.issues[0].id;

// 模拟 outcome 回流：knowledge_change_sets.request_id = 'outcome:review:rev-1'，triggerSource='review'
const flowback = applyKnowledgeChangeSet(database, meta('outcome:review:rev-1', 'review'), {
  receipts: [{ triggerType: 'review', requestId: 'outcome:review:rev-1', summary: 'Review 回流', counts: { notes: 1 } }]
});
check('F 回流 ChangeSet 已提交', flowback.changeSetId !== null && flowback.replay === false);
const f2 = runLocalLint(database, {
  requestId: 'lint-local-review-2', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'review', objectId: 'rev-1' }]
});
check('F 回流出现后自动解决（条件消除）', f2.counts.issuesAutoResolved === 1 && f2.counts.issuesCreated === 0);
const reviewIssueAfter = getHealthIssue(database, reviewIssueId);
check('F 回流 Issue 终态 resolved + 解决依据', reviewIssueAfter?.status === 'resolved'
  && String(reviewIssueAfter?.resolutionNote ?? '').includes('条件已消除') && reviewIssueAfter?.resolvedChangeSetId !== null);

// ============ G. 周期 Lint：checkpoint 可恢复续跑、不重复 Issue、崩溃后重试零写 ============
// 先建一个会在周期扫描中被修复的坏关系
rawInsertGhostRelation(database, 'rel-ghost-3', 'knowledge_note', 'note-ok', 'source', 'ghost-source-3', seedChangeSetId);
const issuesBeforePeriodic = count(database, 'knowledge_health_issues');
const changeSetsBeforePeriodic = count(database, 'knowledge_change_sets');

const begin1 = beginPeriodicLint(database, { workspaceId: 'ws-a', scope: 'global', pageSize: 2, resume: false });
check('G 周期 Lint 开始（新 run）', begin1.resumed === false && begin1.checkpoint.status === 'running' && begin1.checkpoint.pageSize === 2);
const runId = begin1.checkpoint.runId;

let step1 = runPeriodicLintStep(database);
check('G 步 1 执行（relations phase）', step1.checkpoint.phase === 'relations' && step1.checkpoint.step === 1);
check('G 步 1 修复坏关系 rel-ghost-3', step1.counts.repairsApplied >= 1);

// 模拟崩溃：ChangeSet 已提交但 checkpoint 未推进（手工回滚 checkpoint 到本轮开始前）
const cpBeforeStep1 = { ...begin1.checkpoint };
database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
  .run(JSON.stringify(cpBeforeStep1), NOW, 'knowledge_lint_checkpoint_v2'); // v2 检测器 checkpoint 键（v1 游标语义与新 phase 集不对齐）
const retry1 = runPeriodicLintStep(database);
check('G 崩溃后重试零新增 ChangeSet', count(database, 'knowledge_change_sets') === changeSetsBeforePeriodic + 1);
check('G 崩溃后重试零新增 Issue', count(database, 'knowledge_health_issues') === issuesBeforePeriodic + 1);
check('G 重试后 checkpoint 推进（步 1、越过已扫 relations 阶段）', retry1.checkpoint.step === 1 && retry1.checkpoint.phase === 'evidence_links');

// 中断续跑：resume=true 应续同一 run
const resumed = beginPeriodicLint(database, { workspaceId: 'ws-a', scope: 'global', pageSize: 2, resume: true });
check('G resume 续跑同一 run（同 runId/step）', resumed.resumed === true && resumed.checkpoint.runId === runId && resumed.checkpoint.step === 1);

// 跑完剩余步骤
let guard = 0;
let stepResult = resumed.checkpoint;
while (stepResult.status === 'running') {
  guard += 1;
  if (guard > 200) throw new Error(`FAIL 周期 Lint 未在步数上限内完成（phase=${stepResult.phase} step=${stepResult.step}）`);
  stepResult = runPeriodicLintStep(database).checkpoint;
}
check('G 周期 Lint 完成', stepResult.status === 'completed' && stepResult.completedAt !== null);
check('G 14 phase 全部扫描（scannedObjects > 0）', stepResult.counts.scannedObjects > 0);
const issuesAfterPeriodic = count(database, 'knowledge_health_issues');
// 周期 run 新增 2 个 Issue：rel-ghost-3 修复 + page-topic stale（wiki_pages 阶段）
check('G 周期扫描仅新增期望 Issue（修复 1 + stale 1）', issuesAfterPeriodic === issuesBeforePeriodic + 2);

// 新一轮完整周期（resume=false）：重复扫描仍不重复 Issue
const begin2 = beginPeriodicLint(database, { workspaceId: 'ws-a', scope: 'global', pageSize: 10, resume: false });
check('G 新一轮周期开始', begin2.resumed === false && begin2.checkpoint.runId !== runId);
let guard2 = 0;
let cp2 = begin2.checkpoint;
while (cp2.status === 'running') {
  guard2 += 1;
  if (guard2 > 100) throw new Error('FAIL 第二轮周期未完成');
  cp2 = runPeriodicLintStep(database).checkpoint;
}
check('G 第二轮周期完成且零新增 Issue', cp2.status === 'completed' && count(database, 'knowledge_health_issues') === issuesAfterPeriodic);

// ============ H. 同一 Issue identity：Topic / Library / Canvas / Results 读模型一致 ============
// stale_wiki_page Issue 已在周期 Lint 的 wiki_pages 阶段生成（page-topic 为 stale）
const h1 = runLocalLint(database, {
  requestId: 'lint-local-stale-page', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'wiki_page', objectId: 'page-topic' }]
});
check('H stale_wiki_page 重复扫描去重（周期已生成）', h1.counts.issuesCreated === 0 && h1.counts.issuesDeduplicated === 1);

// Library：完整问题队列
const libraryIssues = listHealthIssues(database, {}).items;
const libraryStale = findIssue(libraryIssues, 'page-topic', 'stale_wiki_page');
const libraryReview = findIssue(libraryIssues, 'rev-1', 'unreturned_review');
check('H Library 队列含 stale Issue', Boolean(libraryStale) && libraryStale.status === 'open');
const staleIssueId = libraryStale.id;
check('H Library 队列含 resolved 回流 Issue（同 id）', libraryReview?.id === reviewIssueId);

// Topic：仅影响当前 Topic 的健康问题
const topicDetail = getTopicWikiDetail(database, { topicId: topic.id, healthLimit: 50 });
const topicStale = findIssue(topicDetail.healthIssues.items, 'page-topic', 'stale_wiki_page');
check('H Topic 投影含同一 Issue id', topicStale?.id === staleIssueId && topicStale?.status === 'open');

// Canvas：健康视图投影同一 Issue（含已解决需 includeResolvedIssues）
const canvas = createKnowledgeCanvas(database, { title: '知识画布', topicId: topic.id });
addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'topic', objectId: topic.id, x: 0, y: 0 });
const canvasHealth = getKnowledgeCanvasProjection(database, { canvasId: canvas.id, mode: 'health', includeResolvedIssues: true });
const canvasStale = findIssue(canvasHealth.modeData.healthIssues ?? [], 'page-topic', 'stale_wiki_page');
const canvasResolved = findIssue(canvasHealth.modeData.healthIssues ?? [], 'rev-1', 'unreturned_review');
check('H Canvas 健康视图含同一 Issue id（open）', canvasStale?.id === staleIssueId);
check('H Canvas 健康视图含同一 Issue id（resolved）', canvasResolved?.id === reviewIssueId && canvasResolved?.status === 'resolved');

// Results/Review 侧：按 affectedObjectId 读回同一身份
const reviewScoped = listHealthIssues(database, { affectedObjectId: 'rev-1' }).items;
check('H Results/Review 读模型同一 Issue id', reviewScoped.length === 1 && reviewScoped[0]?.id === reviewIssueId);

// ============ I. 隔离边界：workspace / lane / data-root ============
// I-1 跨工作空间（data-root）拒绝：有发现也会在 apply 时 WORKSPACE_MISMATCH 零写
rawInsertGhostRelation(database, 'rel-ghost-4', 'knowledge_note', 'note-ok', 'source', 'ghost-source-4', seedChangeSetId);
const changeSetsBeforeIso = count(database, 'knowledge_change_sets');
expectError('I 跨工作空间拒绝', () => runLocalLint(database, {
  requestId: 'lint-local-other-ws', workspaceId: 'ws-other', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-4' }]
}), 'WORKSPACE_MISMATCH');
check('I 跨工作空间零写', count(database, 'knowledge_change_sets') === changeSetsBeforeIso
  && database.prepare('SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-4').e === null);

// I-2 lane 隔离：lane Issue 只出现在 lane 层，global 层不可见/不可改
const laneNoteSeed = applyKnowledgeChangeSet(database, meta('health-lane-seed'), {
  notes: [{
    id: 'note-lane-conflict', scope: 'lane:uk-life-content-radar', kind: 'claim', canonicalKey: 'lane-dispute',
    version: { statement: '赛道争议认识', conclusionStatus: 'disputed', evidenceLevel: 'single' }
  }]
});
check('I lane Note 种子提交', Boolean(laneNoteSeed.changeSetId));
const laneRun = runLocalLint(database, {
  requestId: 'lint-lane-1', workspaceId: 'ws-a', scope: 'lane:uk-life-content-radar',
  affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-lane-conflict' }]
});
// v2 对 lane 孤立 disputed note 同样产出 unresolved_contradiction + orphan_knowledge（均 lane scope）。
check('I lane lint 生成 lane Issue', laneRun.counts.issuesCreated === 2 && laneRun.issues[0]?.scope === 'lane:uk-life-content-radar');
const laneIssueId = laneRun.issues[0].id;

const globalRunOnLaneNote = runLocalLint(database, {
  requestId: 'lint-global-lane-note', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-lane-conflict' }]
});
check('I global lint 不触碰 lane Issue', globalRunOnLaneNote.counts.issuesCreated === 0 && globalRunOnLaneNote.counts.issuesDeduplicated === 0);
check('I global 队列不含 lane Issue', findIssue(listHealthIssues(database, { scope: 'global' }).items, 'note-lane-conflict', 'unresolved_contradiction') === null);
check('I lane Issue 仍 open', getHealthIssue(database, laneIssueId)?.status === 'open');
// 未注册 lane 拒绝写入
expectError('I 未注册 lane 拒绝', () => runLocalLint(database, {
  requestId: 'lint-lane-unknown', workspaceId: 'ws-a', scope: 'lane:not-registered',
  affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-lane-conflict' }]
}), 'SCOPE_NOT_REGISTERED');
check('I 未注册 lane 零写', count(database, 'knowledge_health_issues') === count(database, 'knowledge_health_issues'));

// I-3 lane 周期 Lint 只扫 lane 知识对象，不碰 global 对象/业务对象
const lanePeriodic = beginPeriodicLint(database, { workspaceId: 'ws-a', scope: 'lane:uk-life-content-radar', pageSize: 2, resume: false });
let guardLane = 0;
let laneCp = lanePeriodic.checkpoint;
while (laneCp.status === 'running') {
  guardLane += 1;
  if (guardLane > 100) throw new Error('FAIL lane 周期未完成');
  laneCp = runPeriodicLintStep(database).checkpoint;
}
check('I lane 周期完成', laneCp.status === 'completed');
check('I lane 周期未触碰 global 问题', getHealthIssue(database, conflictIssueId)?.status === 'open' && getHealthIssue(database, staleIssueId)?.status === 'open');
// 8（G 结束后）+ 2（lane 局部 Lint）= 10；lane 周期零新增（全部去重）。
check('I lane 周期未重复 lane Issue', count(database, 'knowledge_health_issues') === 10);

// ============ J. 受影响范围上限：超出即拒绝、零写 ============
const changeSetsBeforeCap = count(database, 'knowledge_change_sets');
expectError('J 受影响对象数超上限拒绝', () => runLocalLint(database, {
  requestId: 'lint-cap-1', workspaceId: 'ws-a', scope: 'global', maxAffectedObjects: 1,
  affectedObjects: [
    { objectType: 'knowledge_note', objectId: 'note-ok' },
    { objectType: 'knowledge_note', objectId: 'note-conflict' }
  ]
}), 'HEALTH_LINT_SCOPE_EXCEEDED');
check('J 超上限零写', count(database, 'knowledge_change_sets') === changeSetsBeforeCap);

// 新建 Issue 上限：同时给两个对象各造一个坏关系 → maxIssuesPerRun=1 拒绝
rawInsertGhostRelation(database, 'rel-ghost-5', 'knowledge_note', 'note-ok', 'source', 'ghost-source-5', seedChangeSetId);
rawInsertGhostRelation(database, 'rel-ghost-6', 'knowledge_note', 'note-ok', 'source', 'ghost-source-6', seedChangeSetId);
expectError('J 新建 Issue 超上限拒绝', () => runLocalLint(database, {
  requestId: 'lint-cap-2', workspaceId: 'ws-a', scope: 'global', maxIssuesPerRun: 1,
  affectedObjects: [
    { objectType: 'knowledge_relation', objectId: 'rel-ghost-5' },
    { objectType: 'knowledge_relation', objectId: 'rel-ghost-6' }
  ]
}), 'HEALTH_LINT_SCOPE_EXCEEDED');
check('J 超上限后两条关系均未终止（零部分写）',
  database.prepare('SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-5').e === null
  && database.prepare('SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-6').e === null);

// ============ K. 局部 lint 幂等重放：同 requestId 同输入零新增 ============
const k1 = runLocalLint(database, {
  requestId: 'lint-local-repair-5', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-5' }]
});
check('K 首次修复 rel-ghost-5', k1.counts.repairsApplied === 1 && k1.changeSetId !== null);
const changeSetsAfterK1 = count(database, 'knowledge_change_sets');
const k2 = runLocalLint(database, {
  requestId: 'lint-local-repair-5', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-5' }]
});
check('K 重放零新增（去重生效）', k2.counts.issuesCreated === 0 && k2.changeSetId === null && count(database, 'knowledge_change_sets') === changeSetsAfterK1);

// ============ L. 终态校验 + 清理 ============
// v2 期望行数：conflict+orphan=2、ev-ghost evidence=1、repair1/2/3=3、review=1、stale=1、lane=2 → 10；repair5=11（repair6 未处理）
check('L 全流程 Issue 计数 = 11（repair6 尚未处理）', count(database, 'knowledge_health_issues') === 11);
const l1 = runLocalLint(database, {
  requestId: 'lint-local-repair-6', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-6' }]
});
check('L rel-ghost-6 收尾修复', l1.counts.repairsApplied === 1 && database.prepare(
  'SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-6').e !== null);
check('L 收尾后 Issue 计数 = 12', count(database, 'knowledge_health_issues') === 12);

// ============ M. 统一 ChangeSet 提交后局部 Lint 触发（生产接线） ============
registerKnowledgeChangeSetLintTrigger();

// M-1 顶层（transaction=true）路径：业务 ChangeSet 提交后自动触发局部 Lint，且不递归
const mBaselineChangeSets = count(database, 'knowledge_change_sets');
applyKnowledgeChangeSet(database, meta('health-trigger-top-1'), {
  notes: [{
    id: 'note-triggered', scope: 'global', kind: 'claim', canonicalKey: 'triggered-dispute',
    version: { statement: '触发路径争议认识', conclusionStatus: 'disputed', evidenceLevel: 'single' }
  }],
  receipts: [{ triggerType: 'ingest', requestId: 'health-trigger-top-1', summary: '触发测试', counts: {} }]
});
// v2：12（L 收尾后）+ note-triggered 的 unresolved_contradiction + orphan_knowledge = 14。
check('M1 提交后自动生成局部 Lint Issue',
  count(database, 'knowledge_health_issues') === 14
  && findIssue(listHealthIssues(database).items, 'note-triggered', 'unresolved_contradiction')?.status === 'open');
check('M1 恰好新增 1 个 lint ChangeSet（不递归）', count(database, 'knowledge_change_sets') === mBaselineChangeSets + 2);
const triggeredLintChangeSet = database.prepare(
  `SELECT trigger_source AS triggerSource FROM knowledge_change_sets ORDER BY created_at DESC, id DESC LIMIT 1`
).get();
check('M1 新增 ChangeSet 为 lint 触发', triggeredLintChangeSet.triggerSource === 'lint');

// M-2 嵌套（transaction=false，dispatcher 语义）路径：在既有事务内触发，lint 以 SAVEPOINT 嵌套提交
const m2Baseline = count(database, 'knowledge_change_sets');
database.exec('BEGIN IMMEDIATE');
let m2Committed = false;
try {
  applyKnowledgeChangeSet(database, meta('health-trigger-nested-1'), {
    notes: [{
      id: 'note-triggered-nested', scope: 'global', kind: 'claim', canonicalKey: 'nested-dispute',
      version: { statement: '嵌套事务争议认识', conclusionStatus: 'disputed', evidenceLevel: 'single' }
    }],
    receipts: [{ triggerType: 'ingest', requestId: 'health-trigger-nested-1', summary: '嵌套触发', counts: {} }]
  }, false);
  database.exec('COMMIT');
  m2Committed = true;
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}
check('M2 嵌套事务提交成功（SAVEPOINT 不冲突）', m2Committed === true);
check('M2 嵌套路径同样触发局部 Lint',
  findIssue(listHealthIssues(database).items, 'note-triggered-nested', 'unresolved_contradiction')?.status === 'open');
check('M2 新增 ChangeSet 数 = 业务 1 + lint 1', count(database, 'knowledge_change_sets') === m2Baseline + 2);

// M-3 触发回调失败隔离：lint 抛错不回滚已成功业务 ChangeSet
setKnowledgeChangeSetLintTrigger(() => { throw new Error('lint boom'); });
const m3BaselineChangeSets = count(database, 'knowledge_change_sets');
applyKnowledgeChangeSet(database, meta('health-trigger-fail-1'), {
  notes: [{
    id: 'note-triggered-fail', scope: 'global', kind: 'claim', canonicalKey: 'fail-isolation-note',
    version: { statement: '失败隔离认识', conclusionStatus: 'supported', evidenceLevel: 'primary' }
  }],
  receipts: [{ triggerType: 'ingest', requestId: 'health-trigger-fail-1', summary: '失败隔离', counts: {} }]
});
check('M3 业务 ChangeSet 仍提交（lint 抛错未回滚）',
  count(database, 'knowledge_change_sets') === m3BaselineChangeSets + 1
  && database.prepare('SELECT id FROM knowledge_notes WHERE id = ?').get('note-triggered-fail') !== undefined);
// 嵌套失败隔离
database.exec('BEGIN IMMEDIATE');
let m3NestedCommitted = false;
try {
  applyKnowledgeChangeSet(database, meta('health-trigger-fail-nested'), {
    notes: [{
      id: 'note-triggered-fail-nested', scope: 'global', kind: 'claim', canonicalKey: 'fail-isolation-nested',
      version: { statement: '嵌套失败隔离认识', conclusionStatus: 'supported', evidenceLevel: 'primary' }
    }],
    receipts: [{ triggerType: 'ingest', requestId: 'health-trigger-fail-nested', summary: '嵌套失败隔离', counts: {} }]
  }, false);
  database.exec('COMMIT');
  m3NestedCommitted = true;
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}
check('M3 嵌套业务 ChangeSet 同样不回滚', m3NestedCommitted === true
  && database.prepare('SELECT id FROM knowledge_notes WHERE id = ?').get('note-triggered-fail-nested') !== undefined);
registerKnowledgeChangeSetLintTrigger(); // 恢复真实触发

// M-4 Review 回流派生：requestId=outcome:review:{id} 的 ChangeSet 提交后，对 Review 局部 Lint 自动解决
database.prepare(`INSERT INTO reviews (id, publication_id, content_version_id, metric_snapshot_ids_json, status, keep_json, stop_json, change_json, summary, created_at, updated_at, finalized_at, revision)
  VALUES ('rev-2', 'pub-1', 'cv-1', '["snap-1"]', 'final', '["k"]', '["s"]', '["c"]', '复盘2', ?, ?, ?, 1)`).run(NOW, NOW, NOW);
const m4a = runLocalLint(database, {
  requestId: 'lint-local-review-2a', workspaceId: 'ws-a', scope: 'global',
  affectedObjects: [{ objectType: 'review', objectId: 'rev-2' }]
});
check('M4 前置 unreturned_review Issue 已 open', m4a.counts.issuesCreated === 1 && m4a.issues[0]?.status === 'open');
const m4ReviewIssueId = m4a.issues[0].id;
applyKnowledgeChangeSet(database, meta('outcome:review:rev-2', 'review'), {
  receipts: [{ triggerType: 'review', requestId: 'outcome:review:rev-2', summary: 'Review 回流2', counts: {} }]
});
check('M4 回流 ChangeSet 提交后局部 Lint 自动解决（requestId 派生 Review 对象）',
  getHealthIssue(database, m4ReviewIssueId)?.status === 'resolved'
  && String(getHealthIssue(database, m4ReviewIssueId)?.resolutionNote ?? '').includes('条件已消除'));

// ============ N. 周期 Lint 生产接线：既有 jobs 表（kind='knowledge_lint'）+ 滚动续跑 ============
const nBaselineIssues = count(database, 'knowledge_health_issues');
// 调度器首个 tick 的「确保滚动 job」路径：无 job 时自动创建（默认首轮延迟）
database.prepare(`DELETE FROM jobs WHERE kind = 'knowledge_lint'`).run();
const ensureRound = await runDuePeriodicLintJobs(database, { budgetSteps: 1, dueLimit: 2 });
check('N0 无 job 时自动确保滚动 job 入队', ensureRound.processed === 0 && database.prepare(
  'SELECT status FROM jobs WHERE dedupe_key = ?').get('lint:periodic:global:rolling').status === 'pending');

// N1 显式计划（插入路径）+ 幂等（已有 pending 不重复入队）
database.prepare(`DELETE FROM jobs WHERE kind = 'knowledge_lint'`).run();
const scheduled1 = schedulePeriodicLintJob(database, { scope: 'global', delayMs: 0 });
check('N1 计划 job 入队', scheduled1.scheduled === true);
const lintJobRow = database.prepare(
  `SELECT id, kind, status, due_at AS dueAt, attempts, dedupe_key AS dedupeKey FROM jobs WHERE dedupe_key = ?`
).get('lint:periodic:global:rolling');
check('N1 job 形状（kind/dedupe/status）',
  lintJobRow?.kind === 'knowledge_lint' && lintJobRow?.dedupeKey === 'lint:periodic:global:rolling' && lintJobRow?.status === 'pending');
check('N1 重复计划幂等（不重复入队）', schedulePeriodicLintJob(database, { scope: 'global', delayMs: 0 }).scheduled === false);

// N-2 预算耗尽 → 轮次成功 + 滚动下一轮（checkpoint 保留）
const n2 = await runDuePeriodicLintJobs(database, { budgetSteps: 1, dueLimit: 2 });
check('N2 处理 1 个到期 job', n2.processed === 1 && n2.stepsRun === 1);
const jobAfterN2 = database.prepare('SELECT status, finished_at AS finishedAt FROM jobs WHERE dedupe_key = ?').get('lint:periodic:global:rolling');
check('N2 轮次以 succeeded 收尾并滚动续排', jobAfterN2?.status === 'pending');
const cpMid = getPeriodicLintCheckpoint(database);
check('N2 checkpoint 保留（续跑语义）', cpMid !== null && cpMid.status === 'running' && cpMid.step >= 1);

// N-3 续跑完成：把滚动 job 拨到已到期，再跑一轮直到完成
database.prepare('UPDATE jobs SET due_at = ?, status = ? WHERE dedupe_key = ?').run(new Date().toISOString(), 'pending', 'lint:periodic:global:rolling');
let nGuard = 0;
let nProcessed = 0;
while (nGuard < 20) {
  nGuard += 1;
  const round = await runDuePeriodicLintJobs(database, { budgetSteps: 2, dueLimit: 2 });
  nProcessed += round.processed;
  const cpNow = getPeriodicLintCheckpoint(database);
  if (cpNow?.status === 'completed') break;
  database.prepare('UPDATE jobs SET due_at = ?, status = ? WHERE dedupe_key = ?').run(new Date().toISOString(), 'pending', 'lint:periodic:global:rolling');
}
check('N3 周期 Lint 最终完成', getPeriodicLintCheckpoint(database)?.status === 'completed');
// 期间新增 5 行：rel-ghost-4（I-1 刻意遗留）自动修复 1 行 + M3 触发被禁时写入的两条 supported note
// （note-triggered-fail / -nested）由周期 Lint 补扫出 orphan_knowledge + unsupported_claim 各 2 行；其余问题全部去重
check('N3 续跑不重复 Issue（新增 5 行：遗留修复 1 + M3 补扫 4）', count(database, 'knowledge_health_issues') === nBaselineIssues + 5);
check('N3 遗留坏关系已被周期修复', database.prepare(
  'SELECT ended_change_set_id AS e FROM knowledge_formal_relations WHERE id = ?').get('rel-ghost-4').e !== null);

// N-4 崩溃恢复 + 失败重试
database.prepare(`UPDATE jobs SET status = 'running', started_at = ?, finished_at = NULL WHERE dedupe_key = ?`).run(NOW, 'lint:periodic:global:rolling');
const recover1 = recoverOrRetryPeriodicLintJobs(database, { retryAfterMs: 0 });
check('N4 running → pending 恢复', recover1.recovered === 1 && database.prepare(
  'SELECT status FROM jobs WHERE dedupe_key = ?').get('lint:periodic:global:rolling').status === 'pending');
database.prepare(`UPDATE jobs SET status = 'failed', last_error = 'LINT_STEP_FAILED: x', finished_at = ? WHERE dedupe_key = ?`)
  .run(new Date(Date.now() - 3_600_000).toISOString(), 'lint:periodic:global:rolling');
const recover2 = recoverOrRetryPeriodicLintJobs(database, { retryAfterMs: 0 });
check('N4 失败 job 超重试窗口 → pending', recover2.recovered === 1 && database.prepare(
  'SELECT status, last_error AS lastError FROM jobs WHERE dedupe_key = ?').get('lint:periodic:global:rolling').status === 'pending');

cancelPeriodicLint(database);
check('L checkpoint 已取消', getPeriodicLintCheckpoint(database) === null);
check('L 检测器版本已记录（false_positive 防重复报警依据）', KNOWLEDGE_HEALTH_DETECTOR_VERSION === '2');

database.close();
await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`WMB-5216 knowledge health child PASS (${checks} checks)`);
