import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import { dispatchBusinessCommand } from '../src/main/business-command.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createGenericEmployeeRunner, writeJobContractRefs } from '../src/main/generic-employee-runner.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import {
  OBJECT_SCOPE_MISMATCH, assertBoundaryCovers, assertJobBoundaryComplete, boundaryClaimFromContext,
  buildJobContextRefs, buildJobObjectBoundary, hasBoundaryClaim, maskBoundaryToRole, normalizeSourceIds,
  parseRoleJobRequest, readJobContract, readJobContractFromRefs, rebuildRoleJobRequest, resolveCommandObjectBoundary
} from '../src/main/role-job-registry.ts';
import { dispatchIssueTaskGrant, dispatchRevokeTaskGrant, ensureAutomaticTaskGrant, AUTOMATIC_TASK_GRANT_SCOPES } from '../src/main/task-grants.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';

const SUCCEEDED = { status: 'succeeded', code: 'OK', message: null, readback: null };
const expiry = () => new Date(Date.now() + 60_000).toISOString();
const scheduler = { type: 'scheduler', id: 'wmb-5141-test', label: 'wmb-5141-test' };
const piWorker = { type: 'pi', id: 'pi', label: 'Pi worker' };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, attempts = 300, interval = 20) {
  for (let i = 0; i < attempts; i += 1) { if (predicate()) return; await sleep(interval); }
  throw new Error('waitFor 超时');
}
function openRuntime(directory, epoch, workspaceId = `ws-5141-${randomUUID()}`) {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  database.close();
  return ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => epoch });
}
async function withRuntime(work, epoch = 'wmb-5141-epoch') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5141-'));
  let runtime;
  try {
    runtime = openRuntime(root, epoch);
    const shouldStop = await work({ root, runtime, database: runtime.database });
    if (shouldStop !== false) await runtime.stop({ drain: false });
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
async function bindJobContract(runtime, taskId, request, businessDate) {
  await writeJobContractRefs(runtime, taskId, { jobId: `job-${randomUUID()}`, request, boundary: buildJobObjectBoundary(request, businessDate) });
}
async function setupBoundAgent(runtime, request, businessDate) {
  const intent = request.roleId === 'writer' ? 'studio_draft' : request.roleId === 'librarian' ? 'page_library' : request.roleId === 'planner' ? 'daily_judge' : 'daily_scan';
  const started = await dispatchStartAgentTask(runtime, { intent, businessDate: businessDate ?? '2026-08-09', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: scheduler, requestId: `setup-${randomUUID()}` });
  await bindJobContract(runtime, started.task.id, request, businessDate);
  const lease = runtime.acquireWorkerLease(started.task.id);
  runtime.bindWorker(lease, { stop() {} });
  runtime.bindWorkerTask(lease, started.task.id);
  const grantId = await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), request.roleId);
  return { task: started.task, lease, grantId };
}
function getTaskGrantRow(database, taskId) {
  return database.prepare("SELECT id, revision, allowed_commands_json AS commands FROM task_grants WHERE task_id=? AND status='active' ORDER BY issued_at DESC LIMIT 1").get(taskId);
}

// T1 续派合同（fixture 覆盖四角色）：context_refs 字段语义 + 一键续派重建（边界参数语义等价）
test('T1 续派合同：四角色 context_refs 字段 + 一键续派重建', () => {
  const cases = [
    { name: 'reporter', request: { roleId: 'reporter', brief: '扫描 AI 资讯', businessDate: '2026-08-09', channelIds: ['x_lists', 'official_web', 'official_web'], sourceFeedIds: ['feed-2', 'feed-1'] },
      refs: { jobId: 'job-r1', roleId: 'reporter', brief: '扫描 AI 资讯', businessDate: '2026-08-09', sourceIds: ['official_web', 'x_lists'], sourceFeedIds: ['feed-1', 'feed-2'] } },
    { name: 'planner', request: { roleId: 'planner', brief: '今日判断', businessDate: '2026-08-09' },
      refs: { jobId: 'job-p1', roleId: 'planner', brief: '今日判断', businessDate: '2026-08-09' } },
    { name: 'writer', request: { roleId: 'writer', brief: '写 P1 初稿', projectId: 'P1', businessDate: '2026-08-09' },
      refs: { jobId: 'job-w1', roleId: 'writer', brief: '写 P1 初稿', businessDate: '2026-08-09', projectId: 'P1' } },
    { name: 'librarian-sources', request: { roleId: 'librarian', brief: '整理指定资料', sourceIds: ['s-2', 's-1', 's-1'] },
      refs: { jobId: 'job-l1', roleId: 'librarian', brief: '整理指定资料', sourceIds: ['s-1', 's-2'] } },
    { name: 'librarian-workspace', request: { roleId: 'librarian', brief: '整理全库' },
      refs: { jobId: 'job-l2', roleId: 'librarian', brief: '整理全库', scope: 'workspace' } }
  ];
  for (const item of cases) {
    const boundary = buildJobObjectBoundary(item.request, item.request.businessDate ?? null);
    const refs = buildJobContextRefs({ jobId: item.refs.jobId, request: item.request, boundary });
    for (const [key, value] of Object.entries(item.refs)) assert.deepEqual(refs[key], value, `${item.name}: refs.${key}`);
    const rebuilt = rebuildRoleJobRequest(refs);
    assert.ok(rebuilt, `${item.name}: rebuild 必须成功`);
    const original = parseRoleJobRequest(item.request);
    assert.deepEqual(buildJobObjectBoundary(rebuilt, boundary.businessDate), buildJobObjectBoundary(original, boundary.businessDate), `${item.name}: 重建边界等价`);
    assert.equal(rebuilt.roleId, original.roleId);
    assert.equal(rebuilt.brief, original.brief);
    assert.equal(readJobContractFromRefs(refs)?.jobId, item.refs.jobId);
  }
});

// T1b WMB-5170 research 变体：完整 research 块 + projectId 持久化进 context_refs，一键续派重建精确 research 工单；reporter 老路径零改动
test('T1b research 变体：research 块 + projectId 持久化并重建 research 工单（reporter 老路径不变）', () => {
  const request = {
    roleId: 'reporter',
    brief: '研究 GLM 5.2 官方是否涨价',
    businessDate: '2026-08-10',
    projectId: 'project-parent-1',
    research: {
      gapId: 'research-abc',
      parentJobId: 'job-parent-1',
      parentTaskId: 'task-parent-1',
      parentRoleId: 'writer',
      requiredClaims: [
        { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price' },
        { key: 'glm52_safety_policy', text: 'GLM 5.2 官方安全政策', type: 'policy' }
      ],
      budget: { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 },
      channels: ['web', 'x', 'xhs']
    }
  };
  const boundary = buildJobObjectBoundary(request, request.businessDate);
  assert.equal(boundary.projectId, 'project-parent-1', 'research 边界必须携带 projectId');
  const refs = buildJobContextRefs({ jobId: 'job-research-1', request, boundary });
  assert.equal(refs.projectId, 'project-parent-1');
  assert.deepEqual(refs.research, request.research, 'research 块全量持久化');
  const rebuilt = rebuildRoleJobRequest(refs);
  assert.ok(rebuilt, 'research 工单必须可重建');
  assert.equal(rebuilt.roleId, 'reporter');
  assert.equal(rebuilt.brief, request.brief);
  assert.equal(rebuilt.businessDate, request.businessDate);
  assert.equal(rebuilt.projectId, 'project-parent-1');
  const original = parseRoleJobRequest(request);
  assert.deepEqual(rebuilt.research, original.research, '重建 research 块与校验原值逐字段等价');
  assert.deepEqual(buildJobObjectBoundary(rebuilt, request.businessDate), boundary, '重建边界与持久边界一致');
  assert.equal(readJobContractFromRefs(refs)?.jobId, 'job-research-1');
  // reporter 老路径（无 research）不产生 research refs / projectId。
  const plain = parseRoleJobRequest({ roleId: 'reporter', brief: '扫', businessDate: '2026-08-09', channelIds: ['c1'], sourceFeedIds: ['feed-1'] });
  const plainRefs = buildJobContextRefs({ jobId: 'job-plain', request: plain, boundary: buildJobObjectBoundary(plain, '2026-08-09') });
  assert.equal('research' in plainRefs, false, '老 reporter 路径不得产生 research refs');
  assert.equal(plainRefs.projectId, undefined, '老 reporter 路径不得持久化 projectId');
  // 损坏 research refs → 重建 fail closed（null）。
  assert.equal(rebuildRoleJobRequest({ ...refs, research: { ...refs.research, channels: [] } }), null);
  assert.equal(rebuildRoleJobRequest({ ...refs, research: { ...refs.research, requiredClaims: [] } }), null);
  assert.equal(rebuildRoleJobRequest({ ...refs, research: 'not-an-object' }), null);
});

// T2 边界标准化 + 命令提取 + 纯校验器（同界/越界/缺失/角色掩码）
test('T2 对象边界标准化：sourceIds 去重排序、scope 语义、校验器 fail closed', () => {
  assert.deepEqual(normalizeSourceIds([' b ', 'a', 'a', null, 42, '']), ['a', 'b']);
  assert.deepEqual(buildJobObjectBoundary({ roleId: 'librarian', brief: 'x', sourceIds: ['s2', 's1', 's1'] }, null), { businessDate: null, projectId: null, sourceIds: ['s1', 's2'], feedIds: [], scope: null });
  assert.deepEqual(buildJobObjectBoundary({ roleId: 'reporter', brief: 'x', businessDate: '2026-08-09', channelIds: ['c2', 'c1'], sourceFeedIds: ['f2', 'f1'] }, '2026-08-09'), { businessDate: '2026-08-09', projectId: null, sourceIds: ['c1', 'c2'], feedIds: ['f1', 'f2'], scope: null });
  assert.equal(buildJobObjectBoundary({ roleId: 'librarian', brief: 'x' }, null).scope, 'workspace');
  assert.equal(buildJobObjectBoundary({ roleId: 'librarian', brief: 'x', scope: 'workspace', sourceIds: ['s1'] }, null).scope, 'workspace');
  assert.equal(buildJobObjectBoundary({ roleId: 'writer', brief: 'x', projectId: 'P1' }, '2026-08-09').projectId, 'P1');
  assert.equal(buildJobObjectBoundary({ roleId: 'planner', brief: 'x' }, '2026-08-09').businessDate, '2026-08-09');
  assert.equal(resolveCommandObjectBoundary('plans.save', { planDate: '2026-08-10' }).businessDate, '2026-08-10');
  assert.equal(resolveCommandObjectBoundary('content.save_version', { projectId: 'P2' }).projectId, 'P2');
  assert.deepEqual(resolveCommandObjectBoundary('knowledge.record_batch', { items: [{ sourceId: 's1' }, { sourceId: 's2' }, { sourceId: 's1' }] }).sourceIds, ['s1', 's2']);
  // sources.upsert_batch 真实输入 shape：items[].feedId（渠道 feed 键）
  assert.deepEqual(resolveCommandObjectBoundary('sources.upsert_batch', { items: [{ title: 'a', feedId: 'feed-2' }, { title: 'b', feedId: 'feed-1' }, { title: 'c' }] }).feedIds, ['feed-1', 'feed-2']);
  assert.deepEqual(resolveCommandObjectBoundary('sources.upsert_batch', { items: [{ title: 'no feed' }] }).feedIds, []);
  // content.create 真实输入 shape：sourceIds 为纯字符串数组（非行对象）
  assert.deepEqual(resolveCommandObjectBoundary('content.create', { planItemId: 'pi-1', sourceIds: ['s2', 's1', 's1'] }).sourceIds, ['s1', 's2']);
  assert.deepEqual(resolveCommandObjectBoundary('sources.lane_gate', { judgments: [{ sourceId: 's9' }] }).sourceIds, ['s9']);
  assert.deepEqual(resolveCommandObjectBoundary('sources.lane_restore', { sourceId: 's1' }).sourceIds, ['s1']);
  assert.deepEqual(resolveCommandObjectBoundary('sources.update_status', { id: 's1' }).sourceIds, ['s1']);
  assert.deepEqual(resolveCommandObjectBoundary('agent_tasks.report_progress', { phase: 'x' }), { businessDate: null, projectId: null, sourceIds: [], feedIds: [], scope: null });
  assert.deepEqual(resolveCommandObjectBoundary('x_lists.operation_execute', { kind: 'unfollow' }), { businessDate: null, projectId: null, sourceIds: [], feedIds: [], scope: null });
  // x_lists.observation_*：capability 绑定 reporter（task daily_scan/daily_intelligence）与 page_discover；
  // 员工自动授权 scope 均不含 → spawn 实例自动授权面不可达；page_discover 虽含但页任务无 jobId（无合同）→ 门不适用；
  // bindingIds 为独立配置实体，无与边界四维同空间可兑现对象键 → 不登记 extractor。
  for (const scope of ['daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review']) {
    for (const command of ['x_lists.observation_start', 'x_lists.observation_stop']) {
      assert.equal(AUTOMATIC_TASK_GRANT_SCOPES[scope].includes(command), false, `${scope} 不得含 ${command}`);
    }
  }
  const task = buildJobObjectBoundary({ roleId: 'writer', brief: 'x', projectId: 'P1' }, '2026-08-09');
  assert.doesNotThrow(() => assertBoundaryCovers(task, { businessDate: '2026-08-09', projectId: 'P1', sourceIds: [], feedIds: [], scope: null }));
  const mismatch = (claim) => {
    try { assertBoundaryCovers(task, claim); return null; } catch (error) { return { code: error.code, details: error.details }; }
  };
  assert.equal(mismatch({ businessDate: '2026-08-10', projectId: null, sourceIds: [], feedIds: [], scope: null }).details.reason, OBJECT_SCOPE_MISMATCH);
  assert.equal(mismatch({ businessDate: null, projectId: 'P2', sourceIds: [], feedIds: [], scope: null }).details.dimension, 'projectId');
  assert.equal(mismatch({ businessDate: null, projectId: null, sourceIds: ['s1'], feedIds: [], scope: null }).details.dimension, 'sourceIds');
  assert.equal(mismatch({ businessDate: null, projectId: null, sourceIds: [], feedIds: ['f1'], scope: null }).details.dimension, 'feedIds');
  assert.equal(mismatch({ businessDate: null, projectId: null, sourceIds: [], feedIds: [], scope: 'workspace' }).details.dimension, 'scope');
  const empty = { businessDate: null, projectId: null, sourceIds: [], feedIds: [], scope: null };
  const emptyMismatch = (claim) => {
    try { assertBoundaryCovers(empty, claim); return null; } catch (error) { return { code: error.code, details: error.details }; }
  };
  assert.equal(emptyMismatch({ businessDate: '2026-08-09', projectId: null, sourceIds: [], feedIds: [], scope: null })?.details?.reason, OBJECT_SCOPE_MISMATCH);
  assert.equal(emptyMismatch({ businessDate: null, projectId: 'P1', sourceIds: [], feedIds: [], scope: null })?.details?.dimension, 'projectId');
  assert.equal(emptyMismatch({ businessDate: null, projectId: null, sourceIds: ['s1'], feedIds: [], scope: null })?.details?.dimension, 'sourceIds');
  assert.equal(emptyMismatch({ businessDate: null, projectId: null, sourceIds: [], feedIds: ['f1'], scope: null })?.details?.dimension, 'feedIds');
  assert.equal(hasBoundaryClaim(boundaryClaimFromContext({ projectId: 'P1' })), true);
  assert.equal(hasBoundaryClaim(boundaryClaimFromContext({ ownerGoal: 'x' })), false);
  const plannerTask = buildJobObjectBoundary({ roleId: 'planner', brief: 'x', businessDate: '2026-08-09' }, '2026-08-09');
  const plannerClaim = maskBoundaryToRole({ businessDate: null, projectId: null, sourceIds: ['s1'], feedIds: ['f1'], scope: null }, 'planner');
  assert.deepEqual(plannerClaim, { businessDate: null, projectId: null, sourceIds: [], feedIds: [], scope: null });
  assert.doesNotThrow(() => assertBoundaryCovers(plannerTask, plannerClaim));
  const writerClaim = maskBoundaryToRole({ businessDate: null, projectId: 'P9', sourceIds: [], feedIds: [], scope: null }, 'writer');
  assert.deepEqual(writerClaim, { businessDate: null, projectId: 'P9', sourceIds: [], feedIds: [], scope: null });
  assert.throws(() => assertBoundaryCovers(plannerTask, writerClaim), { code: 'TASK_SCOPE_BROADENED' });
});

// T3 真实 spawn 链路：reporter 任务 refs 含续派合同且自动 grant 携带 jobBoundary
test('T3 真实 spawn 链路：reporter 任务 context_refs 含续派合同且 grant 携带 jobBoundary', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const fixture = await dispatchBusinessCommand(runtime, {
      command: 'test.website_source_fixture', requestId: 't3-website-fixture', actor: scheduler,
      input: {}, boundIdentity: {}, entityType: 'website_source',
      execute: (db) => {
        const source = createWebsiteSource(db, { inputText: 'https://example.invalid/ai-feed', name: 'AI 资讯', canonicalUrl: 'https://example.invalid/ai-feed', resolutionStatus: 'ready', trialRead: { title: 'AI 资讯', url: 'https://example.invalid/ai-feed', readable: true }, transaction: true });
        return { data: { id: source.id }, entityId: source.id };
      }
    });
    assert.equal(fixture.ok, true, '官网来源 fixture 必须可写入');
    const lease = runtime.acquireWorkerLease(null, 'reporter', 'employee');
    runtime.bindWorker(lease, { stop() {} });
    try {
      const run = createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
      const request = { roleId: 'reporter', brief: '扫描 AI 资讯渠道', businessDate: '2026-08-09', channelIds: ['official_web'] };
      const outcome = await run({
        runtime, job: { id: 'job-t3-reporter', roleId: 'reporter', brief: request.brief, businessDate: '2026-08-09', projectId: null },
        lease, taskId: null, grantId: null, sessionFile: path.join(runtime.identity.rootPath, 'agent', 'sessions', 'job-t3-reporter.jsonl'),
        signal: new AbortController().signal, stopResource: null, request
      });
      assert.ok(['failed', 'partial', 'succeeded', 'needs_user'].includes(outcome.status), `reporter 扫描必须终态，实际 ${outcome.status}`);
      const row = database.prepare(`SELECT id FROM agent_tasks WHERE intent='daily_scan' AND business_date='2026-08-09' ORDER BY created_at DESC LIMIT 1`).get();
      assert.ok(row, 'reporter spawn 必须经 startDailyChannelRun 创建 daily_scan 任务');
      const refs = getAgentTask(database, row.id).contextRefs;
      assert.equal(refs.jobId, 'job-t3-reporter');
      assert.equal(refs.roleId, 'reporter');
      assert.equal(refs.brief, '扫描 AI 资讯渠道');
      assert.equal(refs.businessDate, '2026-08-09');
      assert.deepEqual(refs.sourceIds, ['official_web']);
      assert.equal(refs.planDate, '2026-08-09', '不丢既有 refs');
      assert.equal(refs.workspaceId, runtime.identity.workspaceId);
      assert.ok(refs.intelligenceChannels && typeof refs.intelligenceChannels === 'object' && Array.isArray(refs.intelligenceChannels.sources), 'intelligenceChannels 冻结渠道保留');
      const grantRows = database.prepare('SELECT relevant_context_json AS ctxJson FROM task_grants WHERE task_id=?').all(row.id);
      assert.ok(grantRows.length >= 1, '自动 grant 必须已签发（终态 revoke 留痕）');
      const jobBoundary = JSON.parse(grantRows[0].ctxJson).jobBoundary;
      assert.equal(jobBoundary.businessDate, '2026-08-09');
      assert.equal(jobBoundary.projectId, null);
      assert.deepEqual(jobBoundary.sourceIds, ['official_web']);
      assert.ok(Array.isArray(jobBoundary.feedIds) && jobBoundary.feedIds.length >= 1, 'feedIds 从冻结渠道推导（upsert_batch 以 feedId 写渠道对象）');
      assert.equal(jobBoundary.scope, null);
    } finally {
      runtime.releaseWorker(lease);
    }
  });
});

// T4 签发硬门：jobId 在但边界缺失 → 自动授权 fail closed
test('T4 签发硬门：携带 jobId 但边界缺失的任务 → 自动授权 fail closed（不签发 grant）', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft', businessDate: '2026-08-09',
      contextRefs: { workspaceId: runtime.identity.workspaceId, jobId: 'job-broken', roleId: 'writer', brief: '缺 projectId 边界' }
    }, { actor: scheduler, requestId: 't4-start' });
    const baseline = database.prepare('SELECT COUNT(*) AS c FROM task_grants').get().c;
    let caught = null;
    try { await ensureAutomaticTaskGrant(runtime, started.task.id); } catch (error) { caught = error; }
    assert.ok(caught, '缺边界必须拒绝授权');
    assert.equal(caught.code, 'TASK_SCOPE_BROADENED');
    assert.equal(caught.details?.reason, OBJECT_SCOPE_MISMATCH);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM task_grants').get().c, baseline, '拒绝不得签发 grant');
    assert.throws(() => assertJobBoundaryComplete(buildJobObjectBoundary({ roleId: 'writer', brief: 'x' }, null), 'writer'), { code: 'TASK_SCOPE_BROADENED' });
    assert.throws(() => assertJobBoundaryComplete(buildJobObjectBoundary({ roleId: 'planner', brief: 'x' }, null), 'planner'), { code: 'TASK_SCOPE_BROADENED' });
    assert.throws(() => assertJobBoundaryComplete({ businessDate: null, projectId: null, sourceIds: [], scope: null }, 'librarian'), { code: 'TASK_SCOPE_BROADENED' });
    assert.doesNotThrow(() => assertJobBoundaryComplete(buildJobObjectBoundary({ roleId: 'librarian', brief: 'x' }, null), 'librarian'));
    assert.doesNotThrow(() => assertJobBoundaryComplete(buildJobObjectBoundary({ roleId: 'writer', brief: 'x', projectId: 'P1' }, '2026-08-09'), 'writer'));
  });
});

// T5 签发硬门：grant 边界主张越界 → 拒签 + 审计 + 零 grant 写；同界主张可签发
test('T5 签发硬门：grant 边界主张越界 → 拒签 + 审计 + 零 grant 写；同界主张可签发', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const started = await dispatchStartAgentTask(runtime, { intent: 'studio_draft', businessDate: '2026-08-09', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: scheduler, requestId: 't5-start' });
    await bindJobContract(runtime, started.task.id, { roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: '2026-08-09' }, '2026-08-09');
    const baseline = database.prepare('SELECT COUNT(*) AS c FROM task_grants').get().c;
    const crossProject = await dispatchIssueTaskGrant(runtime, {
      requestId: 't5-cross-project', taskId: started.task.id, ownerGoal: '越权写 P2', allowedCommands: ['content.save_version'],
      workers: [{ type: 'external_agent', id: 'mcp' }], relevantContext: { projectId: 'P2' }, expiresAt: expiry()
    });
    assert.equal(crossProject.ok, false);
    assert.equal(crossProject.error.code, 'TASK_SCOPE_BROADENED');
    assert.equal(crossProject.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    assert.equal(crossProject.error.details?.dimension, 'projectId');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM task_grants').get().c, baseline, '越界拒签零 grant 写');
    assert.equal(database.prepare(`SELECT status FROM command_receipts WHERE request_id='t5-cross-project'`).get()?.status, 'error');
    assert.equal(database.prepare(`SELECT side_effect_state AS se FROM command_receipts WHERE request_id='t5-cross-project'`).get()?.se, 'not_started');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM operation_log WHERE command='task_grants.issue' AND result='error' AND error_code='TASK_SCOPE_BROADENED'`).get().c, 1);
    const sameProject = await dispatchIssueTaskGrant(runtime, {
      requestId: 't5-same-project', taskId: started.task.id, ownerGoal: '写 P1', allowedCommands: ['content.save_version'],
      workers: [{ type: 'external_agent', id: 'mcp' }], relevantContext: { projectId: 'P1' }, expiresAt: expiry()
    });
    assert.equal(sameProject.ok, true, '同界主张可签发');
    const lib = await dispatchStartAgentTask(runtime, { intent: 'page_library', businessDate: '2026-08-09', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: scheduler, requestId: 't5-lib-start' });
    await bindJobContract(runtime, lib.task.id, { roleId: 'librarian', brief: '整理 s1', sourceIds: ['s1'] }, null);
    const crossScope = await dispatchIssueTaskGrant(runtime, {
      requestId: 't5-cross-scope', taskId: lib.task.id, ownerGoal: '主张全库', allowedCommands: ['sources.lane_gate'],
      workers: [{ type: 'external_agent', id: 'mcp' }], relevantContext: { scope: 'workspace' }, expiresAt: expiry()
    });
    assert.equal(crossScope.ok, false);
    assert.equal(crossScope.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    assert.equal(crossScope.error.details?.dimension, 'scope');
  });
});

// T6 执行硬门（A9）：writer 跨 projectId → BLOCKED + 审计 + 零业务写；同界成功；有效 grant 不构成边界防线
test('T6 执行硬门：writer 跨 projectId 拒绝（BLOCKED + 审计 + 零业务写），同界成功', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { task, lease, grantId } = await setupBoundAgent(runtime, { roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: '2026-08-09' }, '2026-08-09');
    const send = (requestId, projectId) => dispatchBusinessCommand(runtime, {
      command: 'content.save_version', requestId, actor: piWorker, input: { projectId, body: '正文', author: 'agent' },
      boundIdentity: { projectId, versionId: null }, taskId: task.id, workerLeaseId: lease.leaseId, grantId, entityType: 'content_version',
      execute: (db, input) => ({ data: { savedProjectId: input.projectId }, entityId: input.projectId })
    });
    const cross = await send('t6-cross-project', 'P2');
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'TASK_SCOPE_BROADENED');
    assert.equal(cross.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    assert.equal(cross.error.details?.dimension, 'projectId');
    assert.equal(cross.error.details?.got, 'P2');
    assert.equal(cross.sideEffectState, 'not_started', 'handler 未执行 → 零业务写');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM command_receipts WHERE request_id='t6-cross-project' AND status='error' AND side_effect_state='not_started'`).get().c, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM operation_log WHERE command='content.save_version' AND result='error' AND error_code='TASK_SCOPE_BROADENED'`).get().c, 1);
    const same = await send('t6-same-project', 'P1');
    assert.equal(same.ok, true, '同界写成功');
    assert.equal(same.data.savedProjectId, 'P1');
    runtime.releaseWorker(lease);
  });
});

// T7 执行硬门：planner 跨 date、librarian 跨 sourceIds 拒绝；同界成功；planner source 维度合法写不误拦
test('T7 执行硬门：planner 跨 date、librarian 跨 sourceIds 拒绝，同界成功', async () => {
  await withRuntime(async ({ runtime }) => {
    const plan = await setupBoundAgent(runtime, { roleId: 'planner', brief: '判 08-09', businessDate: '2026-08-09' }, '2026-08-09');
    const planSend = (requestId, planDate) => dispatchBusinessCommand(runtime, {
      command: 'plans.save', requestId, actor: piWorker, input: { planDate, summary: 's', items: [] }, boundIdentity: { planDate },
      taskId: plan.task.id, workerLeaseId: plan.lease.leaseId, grantId: plan.grantId, entityType: 'plan',
      execute: (db, input) => ({ data: { planDate: input.planDate }, entityId: input.planDate })
    });
    const crossDate = await planSend('t7-cross-date', '2026-08-10');
    assert.equal(crossDate.ok, false);
    assert.equal(crossDate.error.details?.dimension, 'businessDate');
    assert.equal(crossDate.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    const sameDate = await planSend('t7-same-date', '2026-08-09');
    assert.equal(sameDate.ok, true, 'planner 同界成功');
    const recordBatch = await dispatchBusinessCommand(runtime, {
      command: 'knowledge.record_batch', requestId: 't7-plan-record', actor: piWorker,
      input: { items: [{ sourceId: 's-any', topic: { canonicalKey: 'k', title: '主题', summary: '' } }] },
      boundIdentity: { entityType: 'knowledge_batch' }, taskId: plan.task.id, workerLeaseId: plan.lease.leaseId, grantId: plan.grantId, entityType: 'knowledge_batch',
      execute: (db, input) => ({ data: { recorded: input.items.length }, entityId: plan.task.id })
    });
    assert.equal(recordBatch.ok, true, 'planner 合法 source 维度写不受 sourceIds 合同维度拦截');
    runtime.releaseWorker(plan.lease);
    const lib = await setupBoundAgent(runtime, { roleId: 'librarian', brief: '整理 s1/s2', sourceIds: ['s1', 's2'] }, null);
    const libSend = (requestId, sourceId) => dispatchBusinessCommand(runtime, {
      command: 'sources.lane_gate', requestId, actor: piWorker,
      input: { workspaceLane: 'wemedia-intelligence-engine', judgedBy: 'agent', judgedAt: null, judgments: [{ sourceId, decision: 'relevant', reasonCode: 'lane_relevant', reason: '测试', expectedRevision: 1 }] },
      boundIdentity: { entityType: 'lane_judgment', workspaceLane: 'wemedia-intelligence-engine' },
      taskId: lib.task.id, workerLeaseId: lib.lease.leaseId, grantId: lib.grantId, entityType: 'lane_judgment',
      execute: (db, input) => ({ data: { sourceId: input.judgments[0].sourceId }, entityId: input.judgments[0].sourceId })
    });
    const crossSource = await libSend('t7-cross-source', 's9');
    assert.equal(crossSource.ok, false);
    assert.equal(crossSource.error.details?.dimension, 'sourceIds');
    assert.equal(crossSource.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    const sameSource = await libSend('t7-same-source', 's2');
    assert.equal(sameSource.ok, true, 'librarian 同界成功');
    runtime.releaseWorker(lib.lease);
    const libWs = await setupBoundAgent(runtime, { roleId: 'librarian', brief: '整理全库' }, null);
    const wsSend = await dispatchBusinessCommand(runtime, {
      command: 'sources.lane_gate', requestId: 't7-ws-source', actor: piWorker,
      input: { workspaceLane: 'wemedia-intelligence-engine', judgedBy: 'agent', judgedAt: null, judgments: [{ sourceId: 'any-1', decision: 'relevant', reasonCode: 'lane_relevant', reason: '测试', expectedRevision: 1 }] },
      boundIdentity: { entityType: 'lane_judgment', workspaceLane: 'wemedia-intelligence-engine' },
      taskId: libWs.task.id, workerLeaseId: libWs.lease.leaseId, grantId: libWs.grantId, entityType: 'lane_judgment',
      execute: (db, input) => ({ data: { sourceId: input.judgments[0].sourceId }, entityId: input.judgments[0].sourceId })
    });
    assert.equal(wsSend.ok, true, 'scope=workspace 不受 sourceIds 约束');
    runtime.releaseWorker(libWs.lease);
  });
});

// T8 红线不变：红线命令对有效 grant + 匹配边界组合仍被 execution grant 门拦死
test('T8 红线不变：红线命令即使携带有效 grant + 匹配边界仍被 execution grant 门拦死', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { task, lease } = await setupBoundAgent(runtime, { roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: '2026-08-09' }, '2026-08-09');
    const autoGrant = getTaskGrantRow(database, task.id);
    const redNoScope = await dispatchBusinessCommand(runtime, {
      command: 'x_lists.operation_execute', requestId: 't8-red-no-scope', actor: piWorker,
      input: { kind: 'unfollow', accountKey: 'acc', listId: 'l1' }, boundIdentity: { accountKey: 'acc' },
      taskId: task.id, workerLeaseId: lease.leaseId, grantId: autoGrant.id, entityType: 'x_list_operation',
      execute: () => ({ data: { executed: true } })
    });
    assert.equal(redNoScope.ok, false);
    assert.equal(redNoScope.error.code, 'TASK_SCOPE_BROADENED');
    const revoked = await dispatchRevokeTaskGrant(runtime, { requestId: 't8-revoke-auto', grantId: autoGrant.id, expectedRevision: autoGrant.revision });
    assert.equal(revoked.ok, true);
    const redGrant = await dispatchIssueTaskGrant(runtime, {
      requestId: 't8-red-grant', taskId: task.id, ownerGoal: '红线负断言', allowedCommands: ['x_lists.operation_execute'],
      workers: [{ type: 'pi', id: 'pi' }], relevantContext: { projectId: 'P1' }, expiresAt: expiry()
    });
    assert.equal(redGrant.ok, true, '越权 grant 可签发（授权面不变），执行仍被 execution grant 门拦截');
    const redBlocked = await dispatchBusinessCommand(runtime, {
      command: 'x_lists.operation_execute', requestId: 't8-red-blocked', actor: piWorker,
      input: { kind: 'unfollow', accountKey: 'acc', listId: 'l1' },
      boundIdentity: { accountKey: 'acc', allowedTransition: 'member:unfollow', requiredReadback: {} },
      taskId: task.id, workerLeaseId: lease.leaseId, grantId: redGrant.data.id, entityType: 'x_list_operation',
      execute: () => ({ data: { executed: true } })
    });
    assert.equal(redBlocked.ok, false);
    assert.equal(redBlocked.error.code, 'EXECUTION_GRANT_REQUIRED');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM x_list_operations').get().c, 0, '红线命令零业务写');
    runtime.releaseWorker(lease);
  });
});

// T9 同项目第二张单 → waiting_resource(RESOURCE_LOCK_CONFLICT)，释放后晋升
test('T9 同项目第二张 writer 单 → waiting_resource(RESOURCE_LOCK_CONFLICT)，释放后晋升', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async ({ job }) => {
        if (job.roleId === 'writer' && job.projectId === 'p-same') await gate;
        return SUCCEEDED;
      }
    });
    const j1 = spawner.spawn({ roleId: 'writer', brief: '第一张', projectId: 'p-same', businessDate: '2026-08-09' });
    await waitFor(() => spawner.get(j1.id)?.status === 'running');
    const j2 = spawner.spawn({ roleId: 'writer', brief: '第二张同项目', projectId: 'p-same', businessDate: '2026-08-09' });
    await waitFor(() => spawner.get(j2.id)?.status === 'waiting_resource');
    assert.equal(spawner.get(j2.id)?.waitReason?.startsWith('RESOURCE_LOCK_CONFLICT'), true);
    assert.notEqual(spawner.get(j2.id)?.status, 'failed', '同项目第二张单不落 failed');
    release();
    const done1 = await spawner.await(j1.id, 10_000);
    const done2 = await spawner.await(j2.id, 10_000);
    assert.equal(done1.status, 'succeeded');
    assert.equal(done2.status, 'succeeded', '锁释放后 FIFO 晋升成功');
    spawner.dispose();
  });
});

// T13 泊车保留原始请求：waiting_resource 晋升重跑仍收到原 spawn 请求（reporter 渠道/feed 边界不丢）
test('T13 waiting_resource 泊车保留原始请求：晋升后 execute 收到原 reporter 请求', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async ({ job, request }) => {
        seen.push(request);
        if (job.roleId === 'reporter') await gate;
        return SUCCEEDED;
      }
    });
    const request = { roleId: 'reporter', brief: '扫 c1', businessDate: '2026-08-09', channelIds: ['c1'], sourceFeedIds: ['feed-1'] };
    const j1 = spawner.spawn(request);
    await waitFor(() => spawner.get(j1.id)?.status === 'running');
    const j2 = spawner.spawn(request);
    await waitFor(() => spawner.get(j2.id)?.status === 'waiting_resource');
    assert.equal(spawner.get(j2.id)?.waitReason?.startsWith('RESOURCE_LOCK_CONFLICT'), true);
    assert.notEqual(spawner.get(j2.id)?.status, 'failed', '同渠道第二张单不落 failed');
    release();
    const done1 = await spawner.await(j1.id, 10_000);
    const done2 = await spawner.await(j2.id, 10_000);
    assert.equal(done1.status, 'succeeded');
    assert.equal(done2.status, 'succeeded', '锁释放后晋升成功');
    assert.equal(seen.length, 2, '两张单都必须经 execute');
    assert.deepEqual(seen[1], request, '泊车晋升后 execute 必须收到原始 spawn 请求（channelIds/sourceFeedIds 不丢）');
    spawner.dispose();
  });
});

// T10 三表 schema 零改动（无迁移、无新表/列）
test('T10 三表 schema 零改动（无迁移、无新表/列）', async () => {
  await withRuntime(async ({ database }) => {
    const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_tasks','task_grants','execution_grants') ORDER BY name`).all().map((row) => row.name);
    assert.deepEqual(tables, ['agent_tasks', 'execution_grants', 'task_grants']);
    const columns = (table) => database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    assert.deepEqual(columns('agent_tasks'), ['id', 'intent', 'business_date', 'status', 'phase', 'pi_session_id', 'context_refs_json', 'result_refs_json', 'progress_json', 'checkpoint_json', 'events_json', 'control_action', 'heartbeat_at', 'error_code', 'error_message', 'created_at', 'updated_at', 'finished_at']);
    assert.deepEqual(columns('task_grants'), ['id', 'workspace_id', 'runtime_epoch', 'task_id', 'owner_goal', 'allowed_commands_json', 'workers_json', 'relevant_context_json', 'status', 'issued_at', 'expires_at', 'revoked_at', 'revision']);
    assert.deepEqual(columns('execution_grants'), ['id', 'workspace_id', 'runtime_epoch', 'task_id', 'task_grant_id', 'command', 'input_hash', 'bound_identity_json', 'target_actor_type', 'target_actor_id', 'browser_profile_id', 'binding_revision', 'expected_account', 'allowed_transition', 'required_readback_json', 'status', 'issued_at', 'expires_at', 'consumed_at', 'revoked_at', 'revision']);
  });
});

// T12 执行硬门：reporter sources.upsert_batch 跨渠道 feedId 拦截、同渠道通过；content.create 越界 sourceIds 拦截
test('T12 执行硬门：reporter upsert_batch 跨 feed 拦截；content.create 越界 sourceIds 拦截', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const rep = await setupBoundAgent(runtime, { roleId: 'reporter', brief: '扫 c1', businessDate: '2026-08-09', channelIds: ['c1'], sourceFeedIds: ['feed-1'] }, '2026-08-09');
    const upsert = (requestId, feedId) => dispatchBusinessCommand(runtime, {
      command: 'sources.upsert_batch', requestId, actor: piWorker,
      input: { items: [{ title: '渠道资料', ...(feedId ? { feedId } : {}) }] },
      boundIdentity: { entityType: 'source_item' }, taskId: rep.task.id, workerLeaseId: rep.lease.leaseId, grantId: rep.grantId, entityType: 'source_item',
      execute: (db, input) => ({ data: { count: input.items.length }, entityId: rep.task.id })
    });
    const crossFeed = await upsert('t12-cross-feed', 'feed-9');
    assert.equal(crossFeed.ok, false, '跨渠道 feed 写必须拦截');
    assert.equal(crossFeed.error.code, 'TASK_SCOPE_BROADENED');
    assert.equal(crossFeed.error.details?.dimension, 'feedIds');
    assert.equal(crossFeed.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    assert.equal(crossFeed.sideEffectState, 'not_started', 'handler 未执行 → 零业务写');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM command_receipts WHERE request_id='t12-cross-feed' AND status='error' AND side_effect_state='not_started'`).get().c, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM operation_log WHERE command='sources.upsert_batch' AND result='error' AND error_code='TASK_SCOPE_BROADENED'`).get().c, 1);
    const sameFeed = await upsert('t12-same-feed', 'feed-1');
    assert.equal(sameFeed.ok, true, '本渠道 feed 写通过');
    const noFeed = await upsert('t12-no-feed', null);
    assert.equal(noFeed.ok, true, '无 feedId 的新建资料不主张渠道维度');
    runtime.releaseWorker(rep.lease);

    // content.create 真实输入 sourceIds 为字符串数组：librarian 限定任务 + 手动 grant 越界 → 拦截
    const lib = await setupBoundAgent(runtime, { roleId: 'librarian', brief: '整理 s1', sourceIds: ['s1'] }, null);
    const libAuto = getTaskGrantRow(database, lib.task.id);
    assert.equal((await dispatchRevokeTaskGrant(runtime, { requestId: 't12-revoke-lib-auto', grantId: libAuto.id, expectedRevision: libAuto.revision })).ok, true);
    const libGrant = await dispatchIssueTaskGrant(runtime, {
      requestId: 't12-lib-create-grant', taskId: lib.task.id, ownerGoal: '建项目', allowedCommands: ['content.create'],
      workers: [{ type: 'pi', id: 'pi' }], relevantContext: { sourceIds: ['s1'] }, expiresAt: expiry()
    });
    assert.equal(libGrant.ok, true);
    const create = (requestId, sourceIds) => dispatchBusinessCommand(runtime, {
      command: 'content.create', requestId, actor: piWorker, input: { planItemId: 'pi-1', sourceIds },
      boundIdentity: { planItemId: 'pi-1', entityType: 'content_project' }, taskId: lib.task.id, workerLeaseId: lib.lease.leaseId, grantId: libGrant.data.id, entityType: 'content_project',
      execute: (db, input) => ({ data: { sourceIds: input.sourceIds }, entityId: lib.task.id })
    });
    const crossCreate = await create('t12-cross-create', ['s9']);
    assert.equal(crossCreate.ok, false, 'content.create 越界 sourceIds 必须拦截');
    assert.equal(crossCreate.error.details?.dimension, 'sourceIds');
    assert.equal(crossCreate.sideEffectState, 'not_started', 'handler 未执行 → 零业务写');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM operation_log WHERE command='content.create' AND result='error' AND error_code='TASK_SCOPE_BROADENED'`).get().c, 1);
    const sameCreate = await create('t12-same-create', ['s1']);
    assert.equal(sameCreate.ok, true, 'content.create 同界通过');
    runtime.releaseWorker(lib.lease);
  });
});

// T11 重启可重建：context_refs_json 跨重启完整指认并重建原请求，可再次 spawn
test('T11 重启可重建：context_refs_json 跨重启完整指认并重建原请求', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5141-rebuild-'));
  let taskId = null;
  let persistedJobId = null;
  try {
    const runtime = openRuntime(root, 'epoch-1', 'ws-5141-rebuild');
    try {
      const started = await dispatchStartAgentTask(runtime, { intent: 'studio_draft', businessDate: '2026-08-09', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: scheduler, requestId: 't11-start' });
      taskId = started.task.id;
      const request = { roleId: 'writer', brief: '基于核心稿写小红书版', projectId: 'P11', writerTask: 'xiaohongshu_platform_version', businessDate: '2026-08-09' };
      await bindJobContract(runtime, taskId, request, '2026-08-09');
      persistedJobId = getAgentTask(runtime.database, taskId).contextRefs.jobId;
      assert.ok(persistedJobId.startsWith('job-'));
    } finally {
      await runtime.stop({ drain: false });
    }
    const reopened = openRuntime(root, 'epoch-2', 'ws-5141-rebuild');
    try {
      assert.equal(readJobContract(reopened.database, taskId).jobId, persistedJobId);
      const rebuilt = rebuildRoleJobRequest(getAgentTask(reopened.database, taskId).contextRefs);
      assert.deepEqual(rebuilt, { roleId: 'writer', brief: '基于核心稿写小红书版', projectId: 'P11', writerTask: 'xiaohongshu_platform_version', businessDate: '2026-08-09' });
      assert.deepEqual(buildJobObjectBoundary(rebuilt, '2026-08-09'), readJobContract(reopened.database, taskId).boundary, '重建边界与持久边界一致');
      const spawner = new JobSpawner(reopened, { maxWorkers: 1, execute: async () => SUCCEEDED });
      const job = spawner.spawn(rebuilt);
      assert.equal((await spawner.await(job.id, 10_000)).status, 'succeeded', '一键续派可直接再次 spawn');
      spawner.dispose();
    } finally {
      await reopened.stop({ drain: false });
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
