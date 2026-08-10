import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import { dispatchCancelAgentTask, dispatchCompleteAgentTask, dispatchFailAgentTask, dispatchFinishDailyIntelligence, dispatchNeedsUserAgentTask, dispatchPartialAgentTask, dispatchStartAgentTask, dispatchUpdateAgentTaskPhase } from '../src/main/agent-task-commands.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { dispatchSourceUpsertBatch } from '../src/main/source-commands.ts';
import { filterCommandsForRole } from '../src/shared/agent-capabilities.ts';
import { AUTOMATIC_TASK_GRANT_SCOPES, dispatchRevokeTaskGrantsForTask, ensureAutomaticTaskGrant, getTaskGrant, listTaskGrants } from '../src/main/task-grants.ts';
import { roleWriteCommandsWithOverlays } from '../src/main/capability-overlays.ts';
import { JOB_ERROR_CODES, mapOutcomeToTerminal, buildRoleJobReport } from '../src/main/role-job-registry.ts';
import { LANE_REASON_CODES } from '../src/main/lane-gate.ts';
import { libraryOrganizePrompt } from '../src/main/role-job-policies.ts';

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)").run('workspace_id', 'ws-job-l2', now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const employeeSnapshotCount = (runtime) => runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length;

const SUCCEEDED = { status: 'succeeded', code: 'OK', message: null, readback: null };
const OWNER_ACTOR = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const SCHEDULER_ACTOR = { type: 'scheduler', id: 'test', label: 'test' };
const INTENT_FOR_ROLE = { writer: 'studio_draft', librarian: 'page_library', planner: 'daily_judge', reporter: 'daily_scan' };
const makeGate = () => { let release; const gate = new Promise((r) => { release = r; }); return [gate, () => release()]; };
const withRuntime = async (fn) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-l2-'));
  const runtime = openRuntime(directory);
  try { return await fn(runtime); } finally { await runtime.stop({ drain: false }).catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
};
const waitFor = async (condition, timeoutMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (condition()) return; await sleep(10); }
};
const waitForAbort = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
const startTask = (runtime, { intent = 'daily_scan', requestId, contextRefs = {}, actor = SCHEDULER_ACTOR, input = {} }) =>
  dispatchStartAgentTask(runtime, { intent, businessDate: '2026-08-08', contextRefs: { workspaceId: runtime.identity.workspaceId, ...contextRefs }, ...input }, { actor, requestId });

const startGrantedTask = async (runtime, opts) => {
  const started = await startTask(runtime, opts);
  return { ...started, grantId: await ensureAutomaticTaskGrant(runtime, started.task.id) };
};
const activeGrantCount = (runtime, taskId) => listTaskGrants(runtime.database, taskId, new Date(), runtime.identity).filter((grant) => grant.status === 'active').length;

test('L2-01 same-day reporter+writer+librarian run concurrently and all succeed (role locks do not collide)', async () => {
  await withRuntime(async (runtime) => {
    const seen = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 3,
      execute: async () => { await sleep(30); return SUCCEEDED; },
      onEvent: (event) => seen.push(event.type)
    });
    const reporter = spawner.spawn({ roleId: 'reporter', brief: '扫源', businessDate: '2026-08-08' });
    const writer = spawner.spawn({ roleId: 'writer', brief: '写稿', projectId: 'project-1', businessDate: '2026-08-08' });
    const librarian = spawner.spawn({ roleId: 'librarian', brief: '整理库' });
    await waitFor(() => spawner.list().filter((job) => job.status === 'running').length >= 3);
    assert.ok(!spawner.list().some((job) => job.status === 'waiting_resource'), '角色锁互不串扰：同日三角色无等资源');
    const done = await Promise.all([reporter, writer, librarian].map((job) => spawner.await(job.id, 10_000)));
    assert.ok(done.every((job) => job.status === 'succeeded'));
    assert.ok(seen.includes('job.finished'));
    assert.equal(employeeSnapshotCount(runtime), 0);
  });
});

test('L2-02 third queues then promotes after first two complete (FIFO)', async () => {
  await withRuntime(async (runtime) => {
    const [gate, release] = makeGate();
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async ({ job }) => { if (job.roleId === 'reporter' || job.roleId === 'writer') await gate; return SUCCEEDED; }
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '1', businessDate: '2026-08-01' });
    const j2 = spawner.spawn({ roleId: 'writer', brief: '2', projectId: 'project-2', businessDate: '2026-08-02' });
    await waitFor(() => spawner.list().filter((job) => job.status === 'running').length >= 2);
    const j3 = spawner.spawn({ roleId: 'planner', brief: '3', businessDate: '2026-08-03' });
    assert.equal(spawner.get(j3.id)?.status, 'queued');
    release();
    const done = await Promise.all([j1, j2, j3].map((job) => spawner.await(job.id, 10_000)));
    assert.ok(done.every((job) => job.status === 'succeeded'));
  });
});

test('L2-03 writer same project key waits (waiting_resource); different project runs concurrently', async () => {
  await withRuntime(async (runtime) => {
    const [gate, release] = makeGate();
    // 可控 gate 保持持锁单与不同项目单同时 running，避免快单提前 succeeded 造成断言竞态。
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 3,
      execute: async ({ job }) => { if (job.projectId === 'project-a' || job.projectId === 'project-b') await gate; return SUCCEEDED; }
    });
    const a = spawner.spawn({ roleId: 'writer', brief: 'a', projectId: 'project-a', businessDate: '2026-08-08' });
    const a2 = spawner.spawn({ roleId: 'writer', brief: 'a2', projectId: 'project-a', businessDate: '2026-08-08' });
    const b = spawner.spawn({ roleId: 'writer', brief: 'b', projectId: 'project-b', businessDate: '2026-08-08' });
    await waitFor(() => spawner.get(a2.id)?.status === 'waiting_resource' && spawner.get(b.id)?.status === 'running');
    assert.equal(spawner.get(a2.id)?.status, 'waiting_resource', '同 project 键 writer 第二单等资源');
    assert.match(spawner.get(a2.id)?.waitReason ?? '', /RESOURCE_LOCK_CONFLICT/);
    assert.equal(spawner.get(b.id)?.status, 'running', '不同项目 writer 并发运行');
    release();
    assert.equal((await spawner.await(a2.id, 10_000)).status, 'succeeded', '资源释放后自动晋升成功');
    await Promise.all([spawner.await(a.id, 10_000), spawner.await(b.id, 10_000)]);
    assert.equal(employeeSnapshotCount(runtime), 0);
  });
});

test('L2-04 librarian same workspace second waits then succeeds after first finishes', async () => {
  await withRuntime(async (runtime) => {
    const [gate, release] = makeGate();
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async ({ job }) => { if (job.roleId === 'librarian') await gate; return SUCCEEDED; }
    });
    const first = spawner.spawn({ roleId: 'librarian', brief: 'first' });
    const second = spawner.spawn({ roleId: 'librarian', brief: 'second' });
    await waitFor(() => spawner.get(second.id)?.status === 'waiting_resource');
    assert.equal(spawner.get(second.id)?.status, 'waiting_resource', '同 workspace librarian 第二单等资源');
    release();
    assert.equal((await spawner.await(second.id, 10_000)).status, 'succeeded');
    await spawner.await(first.id, 10_000);
    assert.equal(employeeSnapshotCount(runtime), 0);
  });
});

test('L2-05 running cancel -> pool cancelled + agent_task cancelled + lease zero', async () => {
  await withRuntime(async (runtime) => {
    let boundTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async (ctx) => { const started = await startTask(runtime, { requestId: `test:${ctx.job.id}:start`, contextRefs: { roleId: 'reporter', jobId: ctx.job.id } }); boundTaskId = started.task.id; ctx.onTaskBound?.(started.task.id, null); await waitForAbort(ctx.signal); return SUCCEEDED; }
    });
    const job = spawner.spawn({ roleId: 'reporter', brief: 'cancel me', businessDate: '2026-08-08' });
    await waitFor(() => spawner.getHandle(job.id)?.taskId);
    assert.ok(spawner.getHandle(job.id)?.taskId, 'task bound during run');
    await spawner.cancel(job.id);
    const done = await spawner.await(job.id, 10_000);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.report?.code, 'JOB_CANCELLED');
    assert.ok(boundTaskId, 'real task created');
    assert.equal(getAgentTask(runtime.database, boundTaskId)?.status, 'cancelled', 'agent_task 同步 cancelled');
    assert.equal(employeeSnapshotCount(runtime), 0, 'employee lease released after cancel');
  });
});

test('L2-06 five terminal states flow through spawner with report and events', async () => {
  await withRuntime(async (runtime) => {
    const seen = [];
    let mode = 'succeeded';
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async () => (mode === 'succeeded' ? SUCCEEDED : mode === 'partial' ? { status: 'partial', code: 'PARTIAL_SCAN', message: '部分渠道完成', readback: { kind: 'scan_phase_reached', phase: 'channel_scanned' } } : mode === 'needs_user' ? { status: 'needs_user', code: 'PI_CONFIG_REQUIRED', message: '缺少配置', readback: null } : { status: 'failed', code: 'MCP_UNAVAILABLE', message: 'no mcp', readback: null }),
      onEvent: (event) => seen.push(event.type)
    });
    for (const [next, expectedEvent] of [['succeeded', 'job.finished'], ['partial', 'job.partial'], ['needs_user', 'job.needs_user'], ['failed', 'job.failed']]) {
      mode = next;
      const done = await spawner.await(spawner.spawn({ roleId: 'reporter', brief: next, businessDate: '2026-08-08' }).id, 10_000);
      assert.equal(done.status, next);
      assert.equal(done.report.status, next);
      assert.ok(done.report.code, 'report carries stable code');
      assert.ok(done.report.finishedAt, 'report carries finishedAt');
      assert.ok(seen.includes(expectedEvent), `${expectedEvent} emitted`);
    }
    spawner.dispose();
  });
});

test('L2-07 librarian effective grant = page_library ∩ librarian, zero expansion', async () => {
  await withRuntime(async (runtime) => {
    const base = AUTOMATIC_TASK_GRANT_SCOPES.page_library;
    const roleSet = roleWriteCommandsWithOverlays(runtime.database, 'ws-job-l2', 'librarian');
    const effective = filterCommandsForRole('librarian', base).filter((command) => command === 'agent_tasks.report_progress' || roleSet.includes(command));
    const expected = filterCommandsForRole('librarian', base);
    assert.deepEqual(new Set(effective), new Set(expected), '无 overlay 时 effective = filterCommandsForRole(librarian, page_library)');
    // §10.1 排除清单：plans.save / content.* / reviews.save / 硬删 / 发布不可达
    for (const forbidden of ['plans.save', 'content.create', 'content.save_version', 'reviews.save', 'publication.editor_prepare_complete', 'sources.delete']) {
      assert.ok(!effective.includes(forbidden), `${forbidden} 不得落入 librarian effective grant`);
    }
    // 不扩权：effective ⊆ page_library scope（零新增命令）
    for (const command of effective) assert.ok(base.includes(command), `${command} 在 page_library scope 内`);
  });
});

test('L2-08 abort + failed outcome -> cancelled; report assembly is consistent', () => {
  const outcome = { status: 'failed', code: 'JOB_FAILED', message: 'late', readback: null };
  assert.equal(mapOutcomeToTerminal(outcome, true).pool, 'cancelled');
  assert.equal(mapOutcomeToTerminal(outcome, true).agentTask, 'cancelled');
  const report = buildRoleJobReport({ jobId: 'j1', roleId: 'reporter', intent: 'daily_scan', status: 'cancelled', code: 'JOB_CANCELLED', businessDate: '2026-08-08', projectId: null, taskId: 't1', phase: null, readback: null, startedAt: '2026-08-08T00:00:00.000Z', finishedAt: '2026-08-08T01:00:00.000Z', errorMessage: null });
  assert.equal(report.status, 'cancelled');
  assert.equal(report.roleId, 'reporter');
  assert.equal(report.intent, 'daily_scan');
  assert.equal(report.taskId, 't1');
});

test('L2-09 events fire exactly once per transition (no duplicate terminal/started)', async () => {
  await withRuntime(async (runtime) => {
    const counts = {};
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async ({ job, signal }) => {
        if (job.brief === 'hold') await waitForAbort(signal);
        return SUCCEEDED;
      },
      onEvent: (event) => { counts[event.type] = (counts[event.type] ?? 0) + 1; }
    });
    // 正常成功：queued/started/finished 各一次；取消路径：queued/started/cancelled 各一次，late outcome 见终态直接退出，不重复 emit。
    await spawner.await(spawner.spawn({ roleId: 'reporter', brief: 'ok', businessDate: '2026-08-08' }).id, 10_000);
    assert.equal(counts['job.queued'], 1);
    assert.equal(counts['job.started'], 1, 'started 单点发出（spawn 不再双发）');
    assert.equal(counts['job.finished'], 1);
    assert.equal(counts['job.cancelled'], undefined);
    const b = spawner.spawn({ roleId: 'reporter', brief: 'hold', businessDate: '2026-08-08' });
    await waitFor(() => spawner.getHandle(b.id)?.sessionFile);
    await spawner.cancel(b.id);
    await spawner.await(b.id, 10_000);
    assert.equal(counts['job.queued'], 2);
    assert.equal(counts['job.started'], 2);
    assert.equal(counts['job.cancelled'], 1, '取消终态事件只发一次');
    assert.equal(counts['job.finished'], 1);
    spawner.dispose();
  });
});

test('L2-10 librarian prompt lists only grant-reachable tools (no wmb_save_source)', () => {
  // 评审追加：wmb_save_source 不可达；WMB-5116/5121 追加九值 reasonCode、禁旁路探索、job 派生 requestId、无变更终止与 ```json {"wmb_noop": true} 确认块；原有可达/不可达工具断言保留。
  const prompt = libraryOrganizePrompt({ id: 't1' }, { jobId: 'j1', brief: '整理' });
  assert.ok(!prompt.includes('wmb_save_source'), 'wmb_save_source 不可达，提示词不得列出');
  assert.ok(prompt.includes('wmb_judge_sources'));
  assert.ok(prompt.includes('wmb_restore_source'));
  assert.ok(prompt.includes('wmb_update_source_status'));
  for (const code of LANE_REASON_CODES) assert.ok(prompt.includes(code), `wmb_judge_sources 合法 reasonCode ${code} 必须出现在提示词词典中`);
  assert.ok(prompt.includes('read、bash'), '禁止旁路工具 read/bash');
  assert.ok(prompt.includes('SQLite'), '禁止绕过 MCP 直读 SQLite');
  assert.ok(prompt.includes('data-root'), '禁止探索 data-root');
  assert.ok(prompt.includes('Skill'), '禁止加载/阅读外部 Skill 文件');
  assert.ok(prompt.includes('j1:library:'), 'requestId 使用 job 派生稳定 ID（jobId:library:<action>）');
  assert.ok(prompt.includes('本次无变更'), '无需变更路径必须明确终止');
  assert.ok(prompt.includes('wmb_noop'), '提示词必须要求末条 ```json {"wmb_noop": true} 确认块');
  assert.ok(prompt.includes('```json'), '提示词必须含 JSON 围栏指令');
  assert.ok(prompt.includes('声明 wmb_noop 后不得执行任何写操作'), '声明 no-op 后不得再写');
});

test('L2-11 WMB-5116 writer per-job start identity: two job ids on same date/project build distinct tasks; direct identical retry still replays idempotently', async () => {
  await withRuntime(async (runtime) => {
    const base = { intent: 'studio_draft', businessDate: '2026-08-08', contextRefs: { projectId: 'project-1' } };
    const context = (requestId) => ({ actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId });
    // 两个不同 job identity（同 date/project）各自建任务，不触发 REQUEST_REPLAY_CONFLICT；同一 request identity 绑不同输入仍必须冲突（身份唯一是修复点，不是放宽输入容忍）。
    const first = await dispatchStartAgentTask(runtime, { ...base, piSessionId: 'conv-a' }, context('job-A:studio-draft:start'));
    assert.equal(first.reused, false);
    await dispatchCancelAgentTask(runtime, first.task.id, context(`job-A:cancel:${first.task.id}`));
    const second = await dispatchStartAgentTask(runtime, { ...base, piSessionId: 'conv-b' }, context('job-B:studio-draft:start'));
    assert.equal(second.reused, false);
    assert.notEqual(second.task.id, first.task.id, '不同 job identity 必须建立不同任务，不得共享或冲突');
    await assert.rejects(dispatchStartAgentTask(runtime, { ...base, piSessionId: 'conv-c' }, context('job-A:studio-draft:start')), (error) => error instanceof Error && error.code === 'REQUEST_REPLAY_CONFLICT');
    // direct caller 无显式 identity：默认 identity + 相同输入 → 幂等重放同一任务，不冲突也不重复建任务。
    await dispatchCancelAgentTask(runtime, second.task.id, context(`job-B:cancel:${second.task.id}`));
    const direct1 = await dispatchStartAgentTask(runtime, { ...base, piSessionId: 'conv-d' }, context('studio_draft:2026-08-08:project-1:start'));
    const direct2 = await dispatchStartAgentTask(runtime, { ...base, piSessionId: 'conv-d' }, context('studio_draft:2026-08-08:project-1:start'));
    assert.equal(direct2.task.id, direct1.task.id, '相同 identity + 相同输入必须幂等复用同一任务');
    assert.equal(direct2.reused, false, 'receipt 重放返回原执行结果，不重复建任务');
  });
});

test('L2-12 WMB-5120 each of the six agent_task terminal commands revokes task grants (no active grant remains)', async () => {
  await withRuntime(async (runtime) => {
    const terminal = [
      ['cancel', 'daily_intelligence', (id, requestId) => dispatchCancelAgentTask(runtime, id, { actor: OWNER_ACTOR, requestId, taskId: id })],
      ['fail', 'daily_intelligence', (id, requestId) => dispatchFailAgentTask(runtime, id, 'TEST_FAIL', 'fail', { actor: OWNER_ACTOR, requestId, taskId: id })],
      ['needs_user', 'daily_intelligence', (id, requestId) => dispatchNeedsUserAgentTask(runtime, id, 'TEST_NEEDS_USER', 'needs user', { actor: OWNER_ACTOR, requestId, taskId: id })],
      ['partial', 'daily_intelligence', (id, requestId) => dispatchPartialAgentTask(runtime, id, { actor: OWNER_ACTOR, requestId, taskId: id })],
      ['finish_daily', 'daily_intelligence', (id, requestId) => dispatchFinishDailyIntelligence(runtime, id, {}, { actor: OWNER_ACTOR, requestId, taskId: id })],
      ['complete', 'page_today', (id, requestId) => dispatchCompleteAgentTask(runtime, id, { actor: OWNER_ACTOR, requestId, taskId: id })]
    ];
    for (const [label, intent, dispatch] of terminal) {
      const { task, grantId } = await startGrantedTask(runtime, { intent, requestId: `t12:start:${label}`, actor: OWNER_ACTOR });
      assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'active', `${label} 运行中 grant active`);
      assert.notEqual((await dispatch(task.id, `t12:${label}:${task.id}`)).status, 'running', `${label} 到达终态`);
      const grants = listTaskGrants(runtime.database, task.id, new Date(), runtime.identity);
      assert.equal(grants.filter((grant) => grant.status === 'active').length, 0, `${label} 终态后无 active grant`);
      assert.equal(grants.length, 1, `${label} 原 grant 行仍在（revoked，非删除）`);
      assert.equal(grants[0].status, 'revoked', `${label} grant 落 revoked`);
      assert.ok(grants[0].revokedAt, `${label} revoked_at 非空`);
      assert.ok(grants[0].revision >= 2, `${label} revision 递增`);
    }
  });
});

test('L2-13 WMB-5120 envelope carrying an old grantId is rejected TASK_GRANT_REVOKED with zero domain write', async () => {
  await withRuntime(async (runtime) => {
    const { task, grantId } = await startGrantedTask(runtime, { intent: 'page_today', requestId: 't13:start', actor: OWNER_ACTOR });
    const completed = await dispatchCompleteAgentTask(runtime, task.id, { actor: OWNER_ACTOR, requestId: 't13:complete', taskId: task.id });
    assert.equal(completed.status, 'succeeded');
    assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'revoked', 'complete 终态已回收 grant');
    const staleWrite = await dispatchSourceUpsertBatch(runtime, { requestId: 't13:stale-write', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id, grantId, items: [{ title: 'Rejected after terminal', originalUrl: 'https://example.com/t13-rejected' }] });
    assert.equal(staleWrite.ok, false);
    assert.equal(staleWrite.error?.code, 'TASK_GRANT_REVOKED', '旧 grantId envelope 被 TASK_GRANT_REVOKED 拒绝');
    assert.equal(staleWrite.sideEffectState, 'not_started');
    assert.equal(runtime.database.prepare("SELECT COUNT(*) AS count FROM source_items WHERE canonical_url='https://example.com/t13-rejected'").get().count, 0);
  });
});

test('L2-14 WMB-5120 repeated per-task revocation is idempotent (second ok data=[])', async () => {
  await withRuntime(async (runtime) => {
    const { task } = await startGrantedTask(runtime, { intent: 'daily_intelligence', requestId: 't14:start', actor: OWNER_ACTOR });
    const first = await dispatchRevokeTaskGrantsForTask(runtime, { requestId: 't14:revoke-1', taskId: task.id });
    assert.equal(first.ok, true);
    assert.equal(first.data.length, 1, '首次回收返回实际撤销列表');
    assert.equal(first.data[0].status, 'revoked');
    const second = await dispatchRevokeTaskGrantsForTask(runtime, { requestId: 't14:revoke-2', taskId: task.id });
    assert.equal(second.ok, true);
    assert.deepEqual(second.data, [], '重复回收幂等：第二次空成功');
    assert.equal(activeGrantCount(runtime, task.id), 0);
  });
});

test('L2-15 WMB-5120 spawner cancel ends agent_task terminal and revokes the bound grant', async () => {
  await withRuntime(async (runtime) => {
    let boundTaskId = null;
    let grantId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async (ctx) => { const started = await startTask(runtime, { requestId: `test:${ctx.job.id}:start`, contextRefs: { roleId: 'reporter', jobId: ctx.job.id, brief: 'cancel-grant', businessDate: '2026-08-08', workspaceId: runtime.identity.workspaceId } }); boundTaskId = started.task.id; grantId = await ensureAutomaticTaskGrant(runtime, started.task.id); ctx.onTaskBound?.(started.task.id, null); await waitForAbort(ctx.signal); return SUCCEEDED; }
    });
    const job = spawner.spawn({ roleId: 'reporter', brief: 'cancel-grant', businessDate: '2026-08-08' });
    await waitFor(() => spawner.getHandle(job.id)?.taskId && grantId);
    assert.ok(boundTaskId && grantId, 'task + grant bound before cancel');
    assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'active', 'running 时 grant active');
    await spawner.cancel(job.id);
    const done = await spawner.await(job.id, 10_000);
    assert.equal(done.status, 'cancelled');
    assert.equal(getAgentTask(runtime.database, boundTaskId)?.status, 'cancelled', 'agent_task 同步 cancelled');
    assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'revoked', 'cancel 终态触发 grant revoke');
    assert.equal(activeGrantCount(runtime, boundTaskId), 0);
  });
});

test('L2-16 WMB-5120 channel_scanned handover keeps grant active (scan->judge reuse not revoked)', async () => {
  await withRuntime(async (runtime) => {
    const { task, grantId } = await startGrantedTask(runtime, { intent: 'daily_scan', requestId: 't16:start', actor: OWNER_ACTOR });
    const scanned = await dispatchUpdateAgentTaskPhase(runtime, task.id, 'channel_scanned', {}, { actor: OWNER_ACTOR, requestId: 't16:phase', taskId: task.id });
    assert.equal(scanned.status, 'running', 'channel_scanned 后任务仍 running（等待 judge 交接）');
    assert.equal(scanned.phase, 'channel_scanned');
    assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'active', 'channel_scanned 不误回收 grant');
    const handoverWrite = await dispatchSourceUpsertBatch(runtime, { requestId: 't16:handover-write', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id, grantId, items: [{ title: 'Judge handover fact', originalUrl: 'https://example.com/t16-handover' }] });
    assert.equal(handoverWrite.ok, true, 'judge 复用同一 running 任务与同一 grant 写入成功');
    assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'active', '交接写入后 grant 仍 active');
  });
});

test('L2-17 WMB-5120 revoke failure after terminal write keeps business terminal and leaves a traceable audit record', async () => {
  await withRuntime(async (runtime) => {
    const { task, grantId } = await startGrantedTask(runtime, { intent: 'daily_intelligence', requestId: 't17:start', actor: OWNER_ACTOR });
    // 预置同 requestId 冲突回执：终态钩子派发的 revoke（requestId=`<cancel-request>:grant-revoke`）命中 REQUEST_REPLAY_CONFLICT（抛错），验证 best-effort 吞错绝不覆盖业务终态写。
    const conflictRequestId = 't17:cancel:grant-revoke';
    const conflict = createCommandEnvelope({ workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, command: 'task_grants.revoke', requestId: conflictRequestId, input: { requestId: conflictRequestId, taskId: 'other-task' }, boundIdentity: { taskId: 'other-task' }, actor: { type: 'scheduler', id: 'task-grant-reaper' } });
    assert.equal((await runtime.dispatchCommand(conflict, () => ({ data: [], entityType: 'task_grant', entityId: 'other-task' }))).ok, true);
    const cancelled = await dispatchCancelAgentTask(runtime, task.id, { actor: OWNER_ACTOR, requestId: 't17:cancel', taskId: task.id });
    assert.equal(cancelled.status, 'cancelled', '终态写不受 revoke 失败影响');
    assert.equal(getAgentTask(runtime.database, task.id).status, 'cancelled');
    assert.equal(getTaskGrant(runtime.database, grantId)?.status, 'active', 'revoke 失败时 grant 保持 active（未被错误回收）');
    const stored = runtime.database.prepare('SELECT 1 AS ok FROM command_receipts WHERE request_id=? AND command=?').get(conflictRequestId, 'task_grants.revoke');
    assert.ok(stored, '冲突回执保留在 command_receipts：可追踪的现有审计路径');
  });
});

test('T-09 WMB-5119 pre-bind cancel: onTaskReady gate suspended -> cancel -> JOB_CANCELLED -> agent_task cancelled (not succeeded), no post-cancel mutation', async () => {
  await withRuntime(async (runtime) => {
    const seen = [];
    let createdTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async (ctx) => {
        // 领域原语已建任务；onTaskReady 门挂起（pre-bind 窗口：任务存在、尚未 bind/grant）。
        createdTaskId = (await startTask(runtime, { requestId: `t09:${ctx.job.id}:start`, contextRefs: { roleId: 'reporter' } })).task.id;
        await waitForAbort(ctx.signal);
        // 门恢复：abort 已到 → 拒绝 bind/grant；runner catch 链同款 bestEffortCancelTask 取消仍 running 的任务。
        if (ctx.signal.aborted) {
          if (getAgentTask(runtime.database, createdTaskId)?.status === 'running') {
            await dispatchCancelAgentTask(runtime, createdTaskId, { actor: { type: 'scheduler', id: 'generic-employee-runner', label: 'GenericEmployeeRunner' }, requestId: `${createdTaskId}:cancel:abort:t09`, workerLeaseId: ctx.lease.leaseId, taskId: createdTaskId }).catch(() => { /* 已终态则忽略 */ });
          }
          throw Object.assign(new Error(JOB_ERROR_CODES.JOB_CANCELLED), { code: JOB_ERROR_CODES.JOB_CANCELLED });
        }
        ctx.onTaskBound?.(createdTaskId, null);
        return SUCCEEDED;
      },
      onEvent: (event) => seen.push(event.type)
    });
    const job = spawner.spawn({ roleId: 'reporter', brief: 'pre-bind', businessDate: '2026-08-08' });
    await waitFor(() => createdTaskId && spawner.getHandle(job.id)?.taskId == null);
    assert.ok(createdTaskId, '任务已建（pre-bind 窗口）');
    assert.equal(spawner.getHandle(job.id)?.taskId, null, '尚未 bind（onTaskReady 门挂起）');
    await spawner.cancel(job.id);
    const done = await spawner.await(job.id, 10_000);
    assert.equal(done.status, 'cancelled', 'pre-bind 取消 → pool cancelled');
    assert.equal(done.report?.code, 'JOB_CANCELLED');
    assert.equal(getAgentTask(runtime.database, createdTaskId)?.status, 'cancelled', 'pre-bind 取消 → agent_task cancelled（非 succeeded）');
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 0, '无取消后 mutation（零 source 回执）');
    assert.equal(seen.filter((type) => type === 'job.cancelled').length, 1, 'job.cancelled 事件恰一次');
    assert.equal(employeeSnapshotCount(runtime), 0, 'lease 归零');
    spawner.dispose();
  });
});

test('T-11 WMB-5119 four-role running cancel: writer/planner/librarian registered stoppable stops Pi once; reporter no stop registration; all pool/task cancelled + lease zero within 5s', async () => {
  await withRuntime(async (runtime) => {
    const seen = [];
    const stopCalls = {};
    const taskIds = {};
    let reporterStopAtExecute = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async (ctx) => { const role = ctx.job.roleId; const intent = INTENT_FOR_ROLE[role]; const started = await startTask(runtime, { intent, requestId: `t11:${ctx.job.id}:start`, contextRefs: { roleId: role } }); taskIds[role] = started.task.id; if (role === 'reporter') reporterStopAtExecute = ctx.stopResource; else ctx.registerStoppable?.(async () => { stopCalls[role] = (stopCalls[role] ?? 0) + 1; }); ctx.onTaskBound?.(started.task.id, null); await waitForAbort(ctx.signal); return SUCCEEDED; },
      onEvent: (event) => seen.push(event.type)
    });
    const jobs = { reporter: spawner.spawn({ roleId: 'reporter', brief: 'scan', businessDate: '2026-08-08' }), planner: spawner.spawn({ roleId: 'planner', brief: 'judge', businessDate: '2026-08-08' }), writer: spawner.spawn({ roleId: 'writer', brief: 'draft', projectId: 'project-1', businessDate: '2026-08-08' }), librarian: spawner.spawn({ roleId: 'librarian', brief: 'organize' }) };
    // 注意：`every` 对空数组恒真——必须显式等四个 taskId 全部落位。
    await waitFor(() => spawner.list().filter((job) => job.status === 'running').length === 4 && Object.keys(taskIds).length === 4);
    assert.equal(Object.keys(taskIds).length, 4, '四角色任务均已创建并绑定');
    assert.equal(spawner.list().filter((job) => job.status === 'running').length, 4, '四角色同时 running');
    assert.equal(reporterStopAtExecute, null, 'reporter（scanOnly 无 Pi）不注册 stop');
    const t0 = Date.now();
    await Promise.all(Object.values(jobs).map((job) => spawner.cancel(job.id)));
    assert.ok(Date.now() - t0 < 5_000, `四角色取消总门 ≤5s（实测 ${Date.now() - t0}ms）`);
    for (const role of Object.keys(jobs)) {
      const done = await spawner.await(jobs[role].id, 10_000);
      assert.equal(done.status, 'cancelled', `${role} pool cancelled`);
      assert.equal(done.report?.code, 'JOB_CANCELLED', `${role} report code`);
      assert.equal(getAgentTask(runtime.database, taskIds[role])?.status, 'cancelled', `${role} agent_task cancelled`);
      if (role !== 'reporter') assert.equal(stopCalls[role], 1, `${role} stopResource 恰被调用一次（Pi 进程树终止）`);
    }
    assert.equal(seen.filter((type) => type === 'job.cancelled').length, 4, '每角色 job.cancelled 事件各一次（MINOR 3 去重）');
    assert.equal(employeeSnapshotCount(runtime), 0, 'employee lease 全部归零');
    spawner.dispose();
  });
});

test('WMB-5119 planner cancel race: cancel-first control marker before Pi stop keeps agent_task cancelled (domain forcePartial must not win)', async () => {
  await withRuntime(async (runtime) => {
    const seen = [];
    let boundTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async (ctx) => {
        const started = await startTask(runtime, { intent: 'daily_judge', requestId: `race:${ctx.job.id}:start`, contextRefs: { roleId: 'planner' } });
        boundTaskId = started.task.id;
        ctx.onTaskBound?.(started.task.id, null);
        // 模拟 daily 域 Pi runtime：stop 被调（Pi 进程树死亡）时按真实域收尾语义——controlAction==='cancel' → cancelIfRequested 转 cancelled；否则 forcePartial 抢先提交。
        ctx.registerStoppable?.(async () => {
          const current = getAgentTask(runtime.database, started.task.id);
          if (current?.status !== 'running') return;
          const context = { actor: { type: 'scheduler', id: 'daily-intelligence', label: 'daily-intelligence' }, requestId: `${started.task.id}:cancel-or-finish:${Date.now()}`, workerLeaseId: ctx.lease.leaseId, taskId: started.task.id };
          // 已终态则忽略
          if (current.controlAction === 'cancel') await dispatchCancelAgentTask(runtime, started.task.id, context).catch(() => {});
          else await dispatchFinishDailyIntelligence(runtime, started.task.id, { forcePartial: true, errorCode: 'DAILY_INTELLIGENCE_FAILED', errorMessage: 'Pi died before cancel marker' }, context).catch(() => {});
        });
        await waitForAbort(ctx.signal);
        return SUCCEEDED;
      },
      onEvent: (event) => seen.push(event.type)
    });
    const job = spawner.spawn({ roleId: 'planner', brief: 'judge-race', businessDate: '2026-08-08' });
    await waitFor(() => spawner.getHandle(job.id)?.taskId);
    assert.ok(boundTaskId, 'task bound');
    await spawner.cancel(job.id);
    const done = await spawner.await(job.id, 10_000);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.report?.code, 'JOB_CANCELLED');
    assert.equal(getAgentTask(runtime.database, boundTaskId)?.status, 'cancelled', 'planner cancel 竞态：agent_task 终态 cancelled（域 forcePartial 不得抢先）');
    assert.notEqual(getAgentTask(runtime.database, boundTaskId)?.status, 'partial', '不得残留 partial 双终态');
    assert.equal(seen.filter((type) => type === 'job.cancelled').length, 1, 'job.cancelled 事件恰一次');
    assert.equal(employeeSnapshotCount(runtime), 0, 'lease 归零');
    spawner.dispose();
  });
});
