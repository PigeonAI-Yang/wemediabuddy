import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobPool } from '../src/main/job-pool.ts';
import { JobSpawner, setActiveJobSpawner } from '../src/main/job-spawner.ts';
import { instanceProgressRatio, readCrewInstanceProjection } from '../src/main/crew-instance-projection.ts';
import { buildRoleRoster } from '../src/main/role-roster.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import {
  dispatchFailAgentTask,
  dispatchNeedsUserAgentTask,
  dispatchStartAgentTask,
  dispatchUpdateAgentTaskPhase
} from '../src/main/agent-task-commands.ts';
import { writeJobContractRefs } from '../src/main/generic-employee-runner.ts';
import { createGenericEmployeeRunner, closeStaleNeedsUserCards } from '../src/main/generic-employee-runner.ts';
import { buildJobObjectBoundary, rebuildRoleJobRequest } from '../src/main/role-job-registry.ts';
import { readJobContractFromRefs } from '../src/main/job-object-boundary.ts';
import { ensureAutomaticTaskGrant } from '../src/main/task-grants.ts';

/**
 * WMB-5142 实例运行投影聚焦测试（设计 §14 A1/A3/A13 本任务切片）。
 * - 实例一等身份 jobId + 不可变 roleId；活动期编号纯显示、重启重新计数（AC-024）；
 * - 终态顺序（agent_task 终态 → grant 回收 → lease/锁释放 → pool 终态 + JOB_EVENT）与
 *   needs_user 零资源保留（AC-025/CAP-027.4）；
 * - scan→judge 共享同一 agent_task 不双计（AC-025）；
 * - 历史只从持久面重建 + 续派输入可建（AC-026）；
 * - desk spawn 拒绝 + maxWorkers 0 拒绝派工（AC-027）。
 */

const SUCCEEDED = { status: 'succeeded', code: 'OK', message: null, readback: null };
const TERMINAL_EVENTS = new Set(['job.finished', 'job.failed', 'job.cancelled', 'job.partial', 'job.needs_user']);
const DATE = '2026-08-09';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, attempts = 100, interval = 10) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await sleep(interval);
  }
}

function openRuntime(directory, epoch = 'wmb-5142-epoch', workspaceId = `ws-5142-${randomUUID()}`) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(workspaceId, now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => epoch });
}

async function withRuntime(work, epoch = 'wmb-5142-epoch') {
  const root = await mkdtemp(path.join(tmpdir(), 'wmb-5142-'));
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

function employeeSnapshotCount(runtime) {
  return runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length;
}

function roleIntent(roleId) {
  return roleId === 'writer' ? 'studio_draft' : roleId === 'librarian' ? 'page_library' : roleId === 'planner' ? 'daily_judge' : 'daily_scan';
}

function defaultRequest(job) {
  return job.roleId === 'writer'
    ? { roleId: 'writer', brief: job.brief, projectId: job.projectId ?? 'p-1', businessDate: job.businessDate ?? DATE }
    : job.roleId === 'librarian'
      ? { roleId: 'librarian', brief: job.brief }
      : { roleId: job.roleId, brief: job.brief, businessDate: job.businessDate ?? DATE };
}

const schedulerCtx = (label) => ({ actor: { type: 'scheduler', id: 'wmb-5142-test', label }, requestId: `${label}:${randomUUID()}` });

/** 与 GenericEmployeeRunner.onTaskReady 同款：建任务 → 绑 lease → 写续派合同 refs → 自动 grant。 */
async function bindTask(ctx) {
  const request = ctx.request ?? defaultRequest(ctx.job);
  const businessDate = ctx.job.businessDate ?? DATE;
  const started = await dispatchStartAgentTask(ctx.runtime, {
    intent: roleIntent(ctx.job.roleId),
    businessDate,
    contextRefs: { workspaceId: ctx.runtime.identity.workspaceId }
  }, schedulerCtx('bind'));
  const taskId = started.task.id;
  ctx.runtime.bindWorkerTask(ctx.lease, taskId);
  await writeJobContractRefs(ctx.runtime, taskId, {
    jobId: ctx.job.id,
    request,
    boundary: buildJobObjectBoundary(request, businessDate)
  }, ctx.lease.leaseId);
  const grantId = await ensureAutomaticTaskGrant(ctx.runtime, taskId, new Date(), ctx.job.roleId);
  ctx.onTaskBound?.(taskId, grantId);
  return { taskId, grantId, request };
}

function projectionOf(spawner, runtime) {
  return readCrewInstanceProjection({
    database: runtime.database,
    pool: spawner.pool,
    getHandle: (jobId) => spawner.getHandle(jobId)
  });
}

test('T1 同角色多实例独立投影：running + waiting_resource 并排可见，活动期编号 1..N', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async () => { await gate; return SUCCEEDED; }
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '扫渠道 A', businessDate: DATE, channelIds: ['c1'] });
    const j2 = spawner.spawn({ roleId: 'reporter', brief: '扫渠道 B', businessDate: DATE, channelIds: ['c1'] });
    const j3 = spawner.spawn({ roleId: 'reporter', brief: '扫渠道 C', businessDate: DATE, channelIds: ['c2'] });
    await waitFor(() => spawner.get(j2.id)?.status === 'waiting_resource' && spawner.get(j3.id)?.status === 'running');
    const proj = projectionOf(spawner, runtime);
    assert.equal(proj.summary.active, 3);
    assert.equal(proj.summary.running, 2, '两个记者实例并行 running');
    assert.equal(proj.summary.waitingResource, 1, '同渠道第二张单 waiting_resource 不占槽');
    assert.equal(proj.summary.queued, 0);
    assert.equal(proj.active.length, 3);
    assert.equal(new Set(proj.active.map((i) => i.jobId)).size, 3, '实例以 jobId 唯一标识');
    assert.ok(proj.active.every((i) => i.roleId === 'reporter' && i.displayNumber > 0));
    assert.deepEqual(proj.active.map((i) => i.displayNumber).sort((a, b) => a - b), [1, 2, 3], '每角色活动期序数按 queuedAt 稳定派生');
    const waitInst = proj.active.find((i) => i.jobId === j2.id);
    assert.equal(waitInst.status, 'waiting_resource', 'waiting_resource 实例可见且带原因');
    assert.match(waitInst.waitReason ?? '', /RESOURCE_LOCK_CONFLICT/);
    assert.equal(proj.byRole.reporter.active.length, 3);
    assert.equal(proj.byRole.writer.active.length, 0);
    release();
    await spawner.await(j1.id, 10_000);
    await spawner.await(j2.id, 10_000);
    await spawner.await(j3.id, 10_000);
    spawner.dispose();
  });
});

test('T2 空投影：无实例时 summary 全 0，active/history 空', async () => {
  await withRuntime(async ({ runtime }) => {
    const pool = new JobPool(2);
    const proj = readCrewInstanceProjection({ database: runtime.database, pool });
    assert.deepEqual(proj.summary, { active: 0, queued: 0, waitingResource: 0, running: 0, needsUser: 0, history: 0 });
    assert.equal(proj.active.length, 0);
    assert.equal(proj.history.length, 0);
  });
});

test('T3 活动期编号纯显示：重启后历史编号为 0，新活动期从 1 重新计数；编号不落库', async () => {
  await withRuntime(async ({ runtime, root }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let boundTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        const { taskId } = await bindTask(ctx);
        boundTaskId = taskId;
        await dispatchFailAgentTask(runtime, taskId, 'MCP_UNAVAILABLE', '模拟失败', schedulerCtx('fail'));
        await gate;
        return { status: 'failed', code: 'MCP_UNAVAILABLE', message: '模拟失败', readback: null };
      }
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: DATE });
    await waitFor(() => spawner.get(j1.id)?.status === 'running' && boundTaskId !== null);
    const activeProj = projectionOf(spawner, runtime);
    assert.equal(activeProj.active.length, 1);
    assert.equal(activeProj.active[0].displayNumber, 1, '活动期编号 =1');
    assert.equal(activeProj.active[0].jobId, j1.id);
    // 编号不进入任何持久面：refs 不含 displayNumber（schema 零改动）。
    const refs = getAgentTask(runtime.database, boundTaskId).contextRefs;
    assert.equal('displayNumber' in refs, false, '编号不进入 context_refs_json');
    release();
    const done = await spawner.await(j1.id, 10_000);
    assert.equal(done.status, 'failed');
    spawner.dispose();
    await runtime.stop({ drain: false });

    // 重启（新 epoch + 全新池）：历史从持久面重建、编号 0；新活动期从 1 重新计数。
    const reopened = openRuntime(root, 'epoch-2', runtime.identity.workspaceId);
    try {
      const historyProj = readCrewInstanceProjection({ database: reopened.database, pool: new JobPool(2) });
      assert.equal(historyProj.active.length, 0);
      assert.equal(historyProj.summary.history, 1, '重启后历史从持久面重建');
      const historyRow = historyProj.history.find((i) => i.jobId === j1.id);
      assert.ok(historyRow, '历史实例可指认（jobId）');
      assert.equal(historyRow.status, 'failed');
      assert.equal(historyRow.roleId, 'reporter');
      assert.equal(historyRow.brief, '扫 A');
      assert.equal(historyRow.displayNumber, 0, '历史实例无活动期编号');
      assert.equal(historyRow.taskId, boundTaskId);
      assert.ok(historyRow.sessionFile, '会话文件 ref 可指认');
      assert.match(historyRow.sessionFile, /job-.*\.jsonl$/);

      let release2;
      const gate2 = new Promise((resolve) => { release2 = resolve; });
      const spawner2 = new JobSpawner(reopened, {
        maxWorkers: 2,
        execute: async () => { await gate2; return SUCCEEDED; }
      });
      const j2 = spawner2.spawn({ roleId: 'reporter', brief: '新活动期', businessDate: DATE });
      await waitFor(() => spawner2.get(j2.id)?.status === 'running');
      const freshActive = readCrewInstanceProjection({ database: reopened.database, pool: spawner2.pool, getHandle: (id) => spawner2.getHandle(id) });
      assert.equal(freshActive.active.length, 1);
      assert.equal(freshActive.active[0].displayNumber, 1, '重启后新活动期从 1 重新计数');
      assert.equal(freshActive.active[0].jobId, j2.id);
      release2();
      await spawner2.await(j2.id, 10_000);
      spawner2.dispose();
    } finally {
      await reopened.stop({ drain: false });
    }
  });
});

test('T4 scan→judge 共享同一 agent_task：reporter 终态退出、judge 接管进度/等你批，活动视图不双计', async () => {
  await withRuntime(async ({ runtime }) => {
    let releaseScan;
    let releaseJudge;
    const scanGate = new Promise((resolve) => { releaseScan = resolve; });
    const judgeGate = new Promise((resolve) => { releaseJudge = resolve; });
    let sharedTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        if (ctx.job.brief === 'scan-hold') {
          const { taskId } = await bindTask(ctx);
          sharedTaskId = taskId;
          await scanGate;
          // reporter 实例终态（pool succeeded）但 agent_task 保持 running（channel_scanned 待 judge rebind）。
          return SUCCEEDED;
        }
        if (ctx.job.brief === 'judge-rebind') {
          // judge rebind：复用同一 daily_scan 任务，推进 phase + 覆写 refs jobId（§5 规则 3 例外）。
          await dispatchUpdateAgentTaskPhase(runtime, sharedTaskId, 'judging_opportunities', {}, schedulerCtx('rebind-phase'));
          await writeJobContractRefs(runtime, sharedTaskId, {
            jobId: ctx.job.id,
            request: { roleId: 'planner', brief: ctx.job.brief, businessDate: DATE },
            boundary: buildJobObjectBoundary({ roleId: 'planner', brief: ctx.job.brief, businessDate: DATE }, DATE)
          }, ctx.lease.leaseId);
          ctx.onTaskBound?.(sharedTaskId, null);
          await judgeGate;
          await dispatchNeedsUserAgentTask(runtime, sharedTaskId, 'PLANNER_NEEDS_INPUT', '需要主管定夺', schedulerCtx('rebind-needs'));
          return { status: 'needs_user', code: 'PLANNER_NEEDS_INPUT', message: '需要主管定夺', readback: null };
        }
        return SUCCEEDED;
      }
    });
    const reporter = spawner.spawn({ roleId: 'reporter', brief: 'scan-hold', businessDate: DATE });
    await waitFor(() => sharedTaskId !== null && spawner.get(reporter.id)?.status === 'running');
    const judge = spawner.spawn({ roleId: 'planner', brief: 'judge-rebind', businessDate: DATE });
    await waitFor(() => spawner.get(judge.id)?.status === 'running');
    // reporter 终态退出活动视图，judge 接管共享任务进度。
    releaseScan();
    await spawner.await(reporter.id, 10_000);
    assert.equal(spawner.get(reporter.id).status, 'succeeded', 'reporter 实例终态退出');
    const mid = projectionOf(spawner, runtime);
    assert.equal(mid.active.length, 1, '活动视图只有 judge 一个活动实例');
    assert.equal(mid.active[0].jobId, judge.id);
    assert.equal(mid.active[0].taskId, sharedTaskId);
    assert.equal(mid.active[0].phase, 'judging_opportunities', 'judge 接管共享任务进度投影');
    assert.equal(mid.summary.running, 1);
    assert.equal(mid.active.filter((i) => i.taskId === sharedTaskId).length, 1, '同一任务同一时刻只归属一个活动实例');
    // judge 终态 needs_user：等你批 只计当前活动实例。
    releaseJudge();
    await spawner.await(judge.id, 10_000);
    const done = projectionOf(spawner, runtime);
    assert.equal(done.summary.needsUser, 1);
    assert.equal(done.active.length, 1);
    assert.equal(done.active[0].jobId, judge.id);
    assert.equal(done.active[0].status, 'needs_user', '共享任务等你批 投影归属接续实例');
    // 重启（池清空）：persisted needs_user 仍卡留活动视图（needs_user 保留，零资源）。
    const restarted = readCrewInstanceProjection({ database: runtime.database, pool: new JobPool(2) });
    assert.equal(restarted.summary.needsUser, 1, '重启后 needs_user 保留在活动视图');
    assert.equal(restarted.active.length, 1);
    assert.equal(restarted.active[0].jobId, judge.id);
    assert.equal(restarted.active[0].status, 'needs_user');
    spawner.dispose();
  });
});

test('T5 重启历史可读 + 续派输入可建：jobId 指认、重建原 RoleJobRequest、再 spawn 成功', async () => {
  await withRuntime(async ({ runtime, root }) => {
    let boundTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        const { taskId } = await bindTask(ctx);
        boundTaskId = taskId;
        await dispatchNeedsUserAgentTask(runtime, taskId, 'PI_CONFIG_REQUIRED', '需要补料', schedulerCtx('needs'));
        return { status: 'needs_user', code: 'PI_CONFIG_REQUIRED', message: '需要补料', readback: null };
      }
    });
    const job = spawner.spawn({ roleId: 'writer', brief: '写 P11 初稿', projectId: 'P11', businessDate: DATE });
    const doneJob = await spawner.await(job.id, 10_000);
    assert.equal(doneJob.status, 'needs_user');
    assert.ok(boundTaskId, '任务已绑定');
    spawner.dispose();
    await runtime.stop({ drain: false });

    const reopened = openRuntime(root, 'epoch-2', runtime.identity.workspaceId);
    try {
      const proj = readCrewInstanceProjection({ database: reopened.database, pool: new JobPool(2) });
      assert.equal(proj.summary.needsUser, 1, '重启后 needs_user 保留');
      const row = proj.active.find((i) => i.jobId === job.id);
      assert.ok(row, '历史/活动实例以 jobId 可指认');
      assert.equal(row.roleId, 'writer');
      assert.equal(row.status, 'needs_user');
      assert.equal(row.error, '需要补料');
      assert.equal(row.code, 'PI_CONFIG_REQUIRED');
      assert.equal(row.projectId, 'P11');
      const refs = getAgentTask(reopened.database, boundTaskId).contextRefs;
      const rebuilt = rebuildRoleJobRequest(refs);
      assert.deepEqual(rebuilt, { roleId: 'writer', brief: '写 P11 初稿', projectId: 'P11', writerTask: 'core_draft', businessDate: DATE, researchMode: 'auto' }, '续派参数与 5141 合同一致');
      const spawner2 = new JobSpawner(reopened, { maxWorkers: 1, execute: async () => SUCCEEDED });
      const job2 = spawner2.spawn(rebuilt);
      const done = await spawner2.await(job2.id, 10_000);
      assert.equal(done.status, 'succeeded', '续派输入可再次 spawn');
      spawner2.dispose();
    } finally {
      await reopened.stop({ drain: false });
    }
  });
});

test('T6 终态顺序（四角色）+ needs_user 零 slot/lease/grant/锁、不自动重试、JOB_EVENT 最后', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const boundTaskIds = new Map();
    let executeCalls = 0;
    const orderAtEvent = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async (ctx) => {
        executeCalls += 1;
        const { taskId } = await bindTask(ctx);
        boundTaskIds.set(ctx.job.id, taskId);
        await gate;
        await dispatchNeedsUserAgentTask(runtime, taskId, 'NEEDS_USER_TEST', `${ctx.job.roleId} 需要主管`, schedulerCtx(`needs-${ctx.job.roleId}`));
        return { status: 'needs_user', code: 'NEEDS_USER_TEST', message: `${ctx.job.roleId} 需要主管`, readback: null };
      },
      onEvent: (event) => {
        if (TERMINAL_EVENTS.has(event.type)) {
          const taskId = boundTaskIds.get(event.jobId);
          const activeGrants = taskId
            ? Number(runtime.database.prepare(`SELECT COUNT(*) AS active FROM task_grants WHERE task_id=? AND status='active'`).get(taskId).active)
            : -1;
          const task = taskId ? getAgentTask(runtime.database, taskId) : null;
          const handle = spawner.getHandle(event.jobId);
          const owningLeaseHeld = Boolean(handle?.leaseId && runtime.getWorkerSnapshots().some((s) => s.leaseId === handle.leaseId));
          orderAtEvent.push({
            type: event.type,
            jobStatus: spawner.get(event.jobId)?.status,
            taskStatus: task?.status ?? null,
            activeGrants,
            owningLeaseHeld
          });
        }
      }
    });
    const jobs = [
      spawner.spawn({ roleId: 'reporter', brief: '扫', businessDate: DATE }),
      spawner.spawn({ roleId: 'planner', brief: '判', businessDate: DATE }),
      spawner.spawn({ roleId: 'writer', brief: '写', projectId: 'p-t6', businessDate: DATE }),
      spawner.spawn({ roleId: 'librarian', brief: '整理' })
    ];
    await waitFor(() => jobs.every((j) => boundTaskIds.has(j.id)), 200, 20);
    release();
    for (const job of jobs) await spawner.await(job.id, 10_000);

    // 终态顺序：JOB_EVENT 触发时 agent_task 终态 + grant 已回收 + 本工单 lease 已释放 + pool 已终态。
    assert.equal(orderAtEvent.length, 4, '四角色各一个终态事件');
    for (const snap of orderAtEvent) {
      assert.equal(snap.jobStatus, 'needs_user', 'JOB_EVENT 时 pool 终态已落');
      assert.equal(snap.taskStatus, 'needs_user', 'JOB_EVENT 时 agent_task 终态先落');
      assert.equal(snap.activeGrants, 0, 'JOB_EVENT 时 grant 已回收（agent_task 终态钩子）');
      assert.equal(snap.owningLeaseHeld, false, 'JOB_EVENT 时本工单 employee lease 已释放');
    }
    // needs_user 保留在活动视图（等你批），不自动重试。
    assert.equal(executeCalls, 4, '每个实例恰好执行一次（无自动重试）');
    const proj = projectionOf(spawner, runtime);
    assert.equal(proj.summary.needsUser, 4);
    assert.equal(proj.active.filter((i) => i.status === 'needs_user').length, 4);
    assert.ok(proj.active.every((i) => i.displayNumber >= 1), 'needs_user 实例停留活动视图并带编号');
    // 实体锁已释放：同锁键 reporter 新单可直接运行（needs_user 不持锁）。
    const relock = spawner.spawn({ roleId: 'reporter', brief: '同键复检', businessDate: DATE });
    await waitFor(() => spawner.get(relock.id)?.status === 'running');
    assert.equal(spawner.get(relock.id).status, 'running', 'needs_user 实例零锁（同键新单可直接运行）');
    const doneRelock = await spawner.await(relock.id, 10_000);
    assert.equal(doneRelock.status, 'needs_user');
    assert.equal(employeeSnapshotCount(runtime), 0, 'needs_user 实例零 lease');
    spawner.dispose();
  });
});

test('T7 maxWorkers 0..7 域：0 拒绝派工（池与 spawner 双保险），超界拒绝', async () => {
  await withRuntime(async ({ runtime }) => {
    const zero = new JobPool(0);
    assert.throws(() => zero.submit({ roleId: 'reporter', brief: 'x', businessDate: DATE }), (error) => {
      assert.equal(error.code, 'JOB_SPAWN_DISABLED');
      return true;
    });
    assert.throws(() => new JobPool(8), /不能超过员工软上限/);
    assert.throws(() => new JobPool(-1), /0\.\.7/);
    assert.throws(() => new JobPool(1.5), /0\.\.7/);
    const disabled = new JobSpawner(runtime, { maxWorkers: 0, execute: async () => SUCCEEDED });
    assert.throws(() => disabled.spawn({ roleId: 'reporter', brief: 'x', businessDate: DATE }), (error) => {
      assert.equal(error.code, 'JOB_SPAWN_DISABLED');
      return true;
    });
    disabled.dispose();
  });
});

test('T8 desk 不可 spawn、不出现在投影；roster 从投影驱动（同角色多实例行 + 空角色当前无任务）', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async () => { await gate; return SUCCEEDED; }
    });
    assert.throws(() => spawner.spawn({ roleId: 'desk', brief: 'nope' }), (error) => {
      assert.equal(error.code, 'ROLE_NOT_SPAWNABLE');
      return true;
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: DATE, channelIds: ['c1'] });
    const j2 = spawner.spawn({ roleId: 'reporter', brief: '扫 B', businessDate: DATE, channelIds: ['c2'] });
    await waitFor(() => spawner.get(j1.id)?.status === 'running' && spawner.get(j2.id)?.status === 'running');
    setActiveJobSpawner(spawner);
    try {
      const rows = buildRoleRoster(runtime.database, { businessDate: DATE });
      const reporter = rows.find((row) => row.roleId === 'reporter');
      assert.equal(reporter.status, 'running', '代表实例 running');
      assert.equal(reporter.instances.length, 2, '同角色多实例经 roster 显式可见');
      assert.deepEqual(reporter.instances.map((i) => i.displayNumber), [1, 2]);
      const writer = rows.find((row) => row.roleId === 'writer');
      assert.equal(writer.status, 'idle');
      assert.equal(writer.summary, '当前无任务', '空角色无虚构待命态，API 输出中性文案「当前无任务」（§14 A4）');
      assert.equal(writer.instances.length, 0);
      const desk = rows.find((row) => row.roleId === 'desk');
      assert.equal(desk.instances.length, 0, 'desk 永不进员工投影');
      assert.equal(desk.summary, '当前无任务', 'desk 空态同样无「待命」文案');
      assert.equal(desk.labelZh, '主管', 'desk 行展示面为主管（2026-08-10 主管授权翻转）');
      assert.equal(desk.roomZh, '主编席', 'desk 行 room 为主编席（不再显示协调入口）');
    } finally {
      release();
    }
    await spawner.await(j1.id, 10_000);
    await spawner.await(j2.id, 10_000);
    spawner.dispose();
    setActiveJobSpawner(null);
    // 无 spawner（纯数据库）时 roster 仍可用（遗留/历史回落，不崩）。
    const rowsNoSpawner = buildRoleRoster(runtime.database, { businessDate: DATE });
    assert.equal(rowsNoSpawner.length, 5);
    const proj = readCrewInstanceProjection({ database: runtime.database, pool: new JobPool(2) });
    assert.ok(proj.byRole.reporter.active.length >= 0, '投影始终可读');
  });
});

test('T9 needs_user 续派（reuse 同任务）旧卡唯一：同任务最多一个活动实例，重复卡退出', async () => {
  await withRuntime(async ({ runtime }) => {
    let sharedTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        if (ctx.job.brief === 'needs-hold') {
          const { taskId } = await bindTask(ctx);
          sharedTaskId = taskId;
          await dispatchNeedsUserAgentTask(runtime, taskId, 'PI_CONFIG_REQUIRED', '需要补料', schedulerCtx('needs'));
          return { status: 'needs_user', code: 'PI_CONFIG_REQUIRED', message: '需要补料', readback: null };
        }
        // 续派：runner 复用同一 needs_user 任务（resolveAgentPiPrerequisite.reused 路径），不再绑定新任务；
        // 与真实 runner 同款回写 handle 任务引用（WMB-5142 评审 P1：`onTaskBound(run.task.id)`）——settle 报告
        // 携带 taskId，第二张卡走去重分支（needsUserTaskIds）而非锚点分支；assembleOutcome 见任务仍
        // needs_user → 同映射 needs_user settle。
        assert.ok(sharedTaskId, '续派必须发生在 needs_user 卡之后');
        ctx.onTaskBound?.(sharedTaskId, null);
        return { status: 'needs_user', code: 'PI_CONFIG_REQUIRED', message: '需要补料', readback: null };
      }
    });
    const first = spawner.spawn({ roleId: 'writer', brief: 'needs-hold', projectId: 'P1', businessDate: DATE });
    const done1 = await spawner.await(first.id, 10_000);
    assert.equal(done1.status, 'needs_user');
    assert.ok(sharedTaskId, '任务已绑定并 needs_user');
    const respawn = spawner.spawn({ roleId: 'writer', brief: '续派同任务', projectId: 'P1', businessDate: DATE });
    const done2 = await spawner.await(respawn.id, 10_000);
    assert.equal(done2.status, 'needs_user', '续派 reuse 同任务仍 settle needs_user');
    assert.equal(done2.report?.taskId, sharedTaskId, '续派卡携带任务引用（走去重分支，非锚点分支）');

    const proj = projectionOf(spawner, runtime);
    assert.equal(proj.summary.needsUser, 1, '同任务只保留一张 needs_user 卡（重复卡退出）');
    assert.equal(proj.active.length, 1);
    assert.equal(proj.active[0].jobId, first.id, '持有任务锚点的旧卡保留');
    assert.equal(proj.active[0].taskId, sharedTaskId);
    assert.equal(proj.active.filter((i) => i.taskId === sharedTaskId).length, 1, '同一任务同一时刻只归属一个活动实例');
    // 重启（池清空）：持久面仍只重建一张卡（锚点语义一致，历史完整性不牺牲）。
    const restarted = readCrewInstanceProjection({ database: runtime.database, pool: new JobPool(2) });
    assert.equal(restarted.summary.needsUser, 1);
    assert.equal(restarted.active[0].jobId, first.id);
    spawner.dispose();
  });
});

test('T10 锚点读取语义：无 jobId 合同/非员工角色任务不进投影（单次读重建语义保留）', async () => {
  await withRuntime(async ({ runtime }) => {
    // reporter 任务：带 jobId 合同 → 进入锚点。
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'daily_scan', businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, schedulerCtx('t10-reporter'));
    await writeJobContractRefs(runtime, started.task.id, {
      jobId: 'job-t10-reporter',
      request: { roleId: 'reporter', brief: '扫', businessDate: DATE },
      boundary: buildJobObjectBoundary({ roleId: 'reporter', brief: '扫', businessDate: DATE }, DATE)
    }, 'lease-t10-reporter');
    // 无 jobId 合同的任务（daily 编排直连）：不进锚点。
    const plain = await dispatchStartAgentTask(runtime, {
      intent: 'daily_judge', businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, schedulerCtx('t10-plain'));
    // desk roleId 合同：非员工角色，不进锚点（refs 形状与 buildJobContextRefs 一致）。
    const deskStarted = await dispatchStartAgentTask(runtime, {
      intent: 'page_today', businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, schedulerCtx('t10-desk'));
    await dispatchUpdateAgentTaskPhase(runtime, deskStarted.task.id, deskStarted.task.phase, {
      contextRefs: { ...deskStarted.task.contextRefs, jobId: 'job-t10-desk', roleId: 'desk', brief: '主编席' }
    }, schedulerCtx('t10-desk-refs'));
    for (const taskId of [started.task.id, plain.task.id, deskStarted.task.id]) {
      await dispatchFailAgentTask(runtime, taskId, 'TEST_FAIL', '模拟失败', schedulerCtx('t10-fail'));
    }

    const proj = readCrewInstanceProjection({ database: runtime.database, pool: new JobPool(2) });
    assert.equal(proj.history.length, 1, '仅带 jobId 合同的员工角色任务进历史');
    assert.equal(proj.history[0].jobId, 'job-t10-reporter');
    assert.equal(proj.history[0].roleId, 'reporter');
    assert.equal(proj.history[0].taskId, started.task.id);
    assert.equal(proj.summary.history, 1);
    assert.equal(proj.summary.active, 0);
  });
});


test('T12 配置缺失前置卡带工单合同：重启后持久重建仍一张卡（修复重启即丢）', async () => {
  await withRuntime(async ({ runtime, root }) => {
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }))
    });
    const first = spawner.spawn({ roleId: 'writer', brief: '写 T12 初稿', projectId: 'P12', businessDate: DATE });
    const done1 = await spawner.await(first.id, 20_000);
    assert.equal(done1.status, 'needs_user');
    assert.equal(done1.report?.code, 'ROLE_MODEL_AUTH_FAILED');
    assert.ok(done1.report?.taskId, '真实 runner 的 needs_user 报告携带任务 id');
    // 前置卡任务带工单合同（重启后按 jobId 可重建）——修复前无合同、重启即丢。
    const task = getAgentTask(runtime.database, done1.report.taskId);
    const contract = readJobContractFromRefs(task.contextRefs);
    assert.ok(contract, '配置缺失前置卡已绑定工单合同（jobId/roleId/brief）');
    assert.equal(contract.jobId, first.id);
    assert.equal(contract.roleId, 'writer');
    assert.equal(contract.brief, '写 T12 初稿');
    const inMem = projectionOf(spawner, runtime);
    assert.equal(inMem.summary.needsUser, 1);
    spawner.dispose();
    await runtime.stop({ drain: false });

    // 重启（池清空）：持久面仍只重建一张卡——修复前该卡无合同、活动视图消失（T11 无重启断言的缺口补上）。
    const reopened = openRuntime(root, 'epoch-2', runtime.identity.workspaceId);
    try {
      const restarted = readCrewInstanceProjection({ database: reopened.database, pool: new JobPool(2) });
      assert.equal(restarted.summary.needsUser, 1, '重启后配置缺失卡保留在活动视图');
      assert.equal(restarted.active.length, 1);
      assert.equal(restarted.active[0].jobId, first.id);
      assert.equal(restarted.active[0].status, 'needs_user');
      assert.equal(restarted.active[0].code, 'ROLE_MODEL_AUTH_FAILED');
      assert.equal(restarted.active[0].taskId, done1.report.taskId, '持久卡仍指认同一任务');
    } finally {
      await reopened.stop({ drain: false });
    }
  });
});

test('T13 用户关闭 needs_user 卡：pool/任务双 cancelled、active=0、history 可追、重启不复发', async () => {
  await withRuntime(async ({ runtime, root }) => {
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }))
    });
    const first = spawner.spawn({ roleId: 'writer', brief: '写 T13 初稿', projectId: 'P13', businessDate: DATE });
    const done1 = await spawner.await(first.id, 20_000);
    assert.equal(done1.status, 'needs_user');
    assert.ok(done1.report?.taskId, '卡携带任务引用');
    const before = projectionOf(spawner, runtime);
    assert.equal(before.summary.needsUser, 1, '关闭前卡留活动视图');
    // 用户关闭：jobs.cancel → 取消序列须真实迁移终态 needs_user（修复 pool.cancel no-op）。
    const closed = await spawner.cancel(first.id);
    assert.equal(closed.status, 'cancelled', '关闭后池记录 cancelled（终态 needs_user 真实迁移）');
    const task = getAgentTask(runtime.database, done1.report.taskId);
    assert.equal(task.status, 'cancelled', '任务侧 needs_user → cancelled（关闭路径可及任务，非 INVALID_STATE）');
    const after = projectionOf(spawner, runtime);
    assert.equal(after.summary.active, 0, 'close 后 active=0');
    assert.equal(after.summary.needsUser, 0);
    assert.equal(after.active.length, 0);
    assert.equal(after.summary.history, 1, 'history 可追（cancelled 任务从持久面重建）');
    assert.equal(after.history[0].jobId, first.id);
    assert.equal(after.history[0].status, 'cancelled');
    assert.equal(after.history[0].taskId, done1.report.taskId);
    spawner.dispose();
    await runtime.stop({ drain: false });

    // 重启：关闭的卡不再复现（任务已终态 cancelled，不进活动视图）。
    const reopened = openRuntime(root, 'epoch-2', runtime.identity.workspaceId);
    try {
      const restarted = readCrewInstanceProjection({ database: reopened.database, pool: new JobPool(2) });
      assert.equal(restarted.summary.active, 0, '重启后关闭卡不复发');
      assert.equal(restarted.summary.history, 1, '历史仍可追');
    } finally {
      await reopened.stop({ drain: false });
    }
  });
});

test('T14 补配置续派（处理）：旧卡/旧任务关闭退出，新实例唯一', async () => {
  await withRuntime(async ({ runtime }) => {
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }))
    });
    const first = spawner.spawn({ roleId: 'writer', brief: '写 T14 初稿', projectId: 'P14', businessDate: DATE });
    const done1 = await spawner.await(first.id, 20_000);
    assert.equal(done1.status, 'needs_user');
    assert.equal(done1.report?.code, 'ROLE_MODEL_AUTH_FAILED');
    assert.ok(done1.report?.taskId);
    const oldTaskId = done1.report.taskId;
    // 配置补齐：runner 在真实任务已建（createdTaskId）后执行同一关闭路径（补配置续派 → 旧卡退出）。
    await closeStaleNeedsUserCards(runtime, spawner.pool, { roleId: 'writer', businessDate: DATE, projectId: 'P14', workerLeaseId: null });
    assert.equal(getAgentTask(runtime.database, oldTaskId).status, 'cancelled', '旧任务转 cancelled（历史可追、不再复用）');
    assert.equal(spawner.get(first.id).status, 'cancelled', '旧池卡转 cancelled（退出活动视图、jobs:list 不残留）');
    const afterClose = projectionOf(spawner, runtime);
    assert.equal(afterClose.summary.active, 0, '处理后旧卡退出活动视图');
    assert.equal(afterClose.summary.history, 1);
    assert.equal(afterClose.history[0].jobId, first.id);
    // 续派新实例：独立新任务 + 新卡，活动视图只此一张（旧 jobId 不残留）。
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spawner2 = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        const { taskId } = await bindTask(ctx);
        await dispatchNeedsUserAgentTask(runtime, taskId, 'NEEDS_USER_TEST', '续派新实例等你批', schedulerCtx('t14-needs'));
        await gate;
        return { status: 'needs_user', code: 'NEEDS_USER_TEST', message: '续派新实例等你批', readback: null };
      }
    });
    const respawn = spawner2.spawn({ roleId: 'writer', brief: '写 T14 续派', projectId: 'P14', businessDate: DATE });
    release();
    const done2 = await spawner2.await(respawn.id, 20_000);
    assert.equal(done2.status, 'needs_user');
    const proj = projectionOf(spawner2, runtime);
    assert.equal(proj.summary.needsUser, 1, '新实例唯一（活动视图一张卡）');
    assert.equal(proj.active.length, 1);
    assert.equal(proj.active[0].jobId, respawn.id, '新卡为新实例');
    assert.notEqual(proj.active[0].taskId, oldTaskId, '新实例绑定新任务（不复用已关闭旧任务）');
    assert.equal(proj.active.filter((i) => i.jobId === first.id).length, 0, '旧 jobId 不在活动视图');
    assert.equal(proj.summary.history, 1, '旧卡留在 history（cancelled，可追）');
    spawner2.dispose();
    spawner.dispose();
  });
});


/** 任务状进度纯函数测试：直接构造 running AgentTask 切片（其余字段不影响 ratio 语义）。 */
const runningTask = (progress, phase = null) => ({ status: 'running', phase, progress });

test('T16 真实进度比例：仅 planned>0 时返回 clamp(processed/planned)', () => {
  assert.equal(instanceProgressRatio(runningTask({ planned: 10, processed: 4 })), 0.4);
  assert.equal(instanceProgressRatio(runningTask({ planned: 10, processed: 10 })), 1);
  assert.equal(instanceProgressRatio(runningTask({ planned: 10, processed: 0 })), 0);
  assert.equal(instanceProgressRatio(runningTask({ planned: 4, processed: 10 })), 1, '超量 processed 收敛到 1');
  assert.equal(instanceProgressRatio(runningTask({ planned: 4, processed: -2 })), 0, '负 processed 收敛到 0');
  assert.equal(instanceProgressRatio(runningTask({ planned: 0, processed: 0 })), null, 'planned=0 无真实比例');
  assert.equal(instanceProgressRatio(runningTask({ planned: -1, processed: 3 })), null, '负 planned 视为无计划量');
  assert.equal(instanceProgressRatio(runningTask({ processed: 3 })), null, '缺 planned 无真实比例');
  assert.equal(instanceProgressRatio(runningTask({ planned: 10 })), 0, '缺 processed 按 0 计（已处理 0）');
  assert.equal(instanceProgressRatio(runningTask({})), null, 'progress 为空对象无比例');
  assert.equal(instanceProgressRatio(runningTask(null, null)), null, 'progress 缺省无比例');
  assert.equal(instanceProgressRatio(null), null);
});

test('T17 不凭阶段/状态猜比例：phase 启发式与终态一律 null', () => {
  // 修复前 judge/synth/scan 等 phase 会回退 0.62/0.28/0.15——现必须为 null（不确定态空轨）。
  for (const phase of ['judging', 'synthesis', 'validating', 'running_pi', 'scan_channels', 'channel_fetch', 'unmapped_phase']) {
    assert.equal(instanceProgressRatio(runningTask({}, phase)), null, `phase=${phase} 无计划量不得猜比例`);
    assert.equal(instanceProgressRatio(runningTask({ planned: 8, processed: 2 }, phase)), 0.25, `phase=${phase} 有真实比例时正常返回`);
  }
  // 终态沿用真实语义：非 running 一律 null（终态卡由历史面呈现，不凭状态猜比例）。
  for (const status of ['succeeded', 'partial', 'failed', 'cancelled', 'needs_user', 'waiting_resource']) {
    assert.equal(instanceProgressRatio({ status, phase: 'judging', progress: { planned: 10, processed: 5 } }), null, `status=${status} 无比例`);
  }
});
