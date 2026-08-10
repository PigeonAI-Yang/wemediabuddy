import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// —— 真实 main 侧模块（dispatcher / spawner / pool / db / 投影 / roster）——
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobPool } from '../src/main/job-pool.ts';
import { JobSpawner, setActiveJobSpawner } from '../src/main/job-spawner.ts';
import { readCrewInstanceProjection } from '../src/main/crew-instance-projection.ts';
import { buildRoleRoster } from '../src/main/role-roster.ts';
import { getAgentTask, reportAgentTaskProgress } from '../src/main/agent-tasks.ts';
import { dispatchBusinessCommand } from '../src/main/business-command.ts';
import {
  dispatchFailAgentTask, dispatchNeedsUserAgentTask, dispatchStartAgentTask
} from '../src/main/agent-task-commands.ts';
import { writeJobContractRefs } from '../src/main/generic-employee-runner.ts';
import {
  OBJECT_SCOPE_MISMATCH, buildJobObjectBoundary, rebuildRoleJobRequest
} from '../src/main/role-job-registry.ts';
import { ensureAutomaticTaskGrant, dispatchIssueTaskGrant, dispatchRevokeTaskGrant } from '../src/main/task-grants.ts';

// —— 只读 registry 结构（A7/A10；A14 基线已抽至 wmb-5145-compatibility-invariants.mjs）——
import {
  AGENT_CAPABILITIES, REDLINE_COMMANDS, ROLE_CATALOG,
  roleHasPagePassThrough, roleReadProfiles, roleWriteCommands
} from '../src/shared/agent-capabilities.ts';
import { assertCompatibilityInvariants } from './wmb-5145-compatibility-invariants.mjs';

// —— 复用真实 UI 逻辑（UI 单源消费；A1/A3/A4/A11/A13）——
import {
  STATUS_WORD, filterActiveInstances, headerCounts, instanceDetail, redispatchInput, statusWord
} from '../src/renderer/agents-instance-logic.ts';

/**
 * WMB-5145 聚合验收（设计 §14 A1..A14 / SPEC EVAL-030，复用真实 dispatcher/spawner/db/投影/UI 逻辑）。
 * 每条断言可证伪；负断言（A9 跨对象写、A10 红线、A8 跨角色命令）必须真实执行，不以推断充当。
 * 项目级门禁（typecheck / check:capabilities G1 / G2 / 打包 / 实机重启续派）由主 Agent 统一执行，
 * 本套件不替代；A14 在此提供三表 schema 零改动 + 五角色固定 + 核心能力零漂移 + 红线/交集面不被新增能力扰动的结构检查，
 * 不依赖整树 git 状态、不冻结能力全名单（后续合法新增能力仅需不扰动下列派生交集面即可通过）。
 */

const SUCCEEDED = { status: 'succeeded', code: 'OK', message: null, readback: null };
const DATE = '2026-08-09';
const piWorker = { type: 'pi', id: 'pi', label: 'Pi worker' };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const waitForAbort = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
async function waitFor(predicate, attempts = 200, interval = 15) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await sleep(interval);
  }
  throw new Error('waitFor 超时');
}

function openRuntime(directory, epoch = 'wmb-5145-epoch', workspaceId = `ws-5145-${randomUUID()}`) {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(workspaceId, now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => epoch });
}

async function withRuntime(work, epoch = 'wmb-5145-epoch') {
  const root = await mkdtemp(path.join(tmpdir(), 'wmb-5145-'));
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

const schedulerCtx = (label) => ({ actor: { type: 'scheduler', id: 'wmb-5145-test', label }, requestId: `${label}:${randomUUID()}` });

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

/** 与 5141 setupBoundAgent 同款：真实任务 + 合同 refs + lease + 自动 grant。 */
async function setupBoundAgent(runtime, request, businessDate) {
  const started = await dispatchStartAgentTask(runtime, {
    intent: roleIntent(request.roleId),
    businessDate: businessDate ?? '2026-08-09',
    contextRefs: { workspaceId: runtime.identity.workspaceId }
  }, { actor: { type: 'scheduler', id: 'wmb-5145-test', label: 'setup' }, requestId: `setup-${randomUUID()}` });
  await writeJobContractRefs(runtime, started.task.id, { jobId: `job-${randomUUID()}`, request, boundary: buildJobObjectBoundary(request, businessDate) });
  const lease = runtime.acquireWorkerLease(started.task.id);
  runtime.bindWorker(lease, { stop() {} });
  runtime.bindWorkerTask(lease, started.task.id);
  const grantId = await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), request.roleId);
  return { task: started.task, lease, grantId };
}

function getTaskGrantRow(database, taskId) {
  const row = database.prepare(
    "SELECT id, revision, allowed_commands_json AS commands FROM task_grants WHERE task_id=? AND status='active' ORDER BY issued_at DESC LIMIT 1"
  ).get(taskId);
  return row ? { ...row, commands: JSON.parse(row.commands) } : null;
}

// A1 同角色多实例显式可见：两记者单并行 running、进度独立，roster/UI 双面可见
// 注：真实系统每个 (intent, businessDate) 至多一个活动 agent_task（startAgentTask 幂等复用），
// 同角色并发实例按日期区分任务（与 scan→judge 共享任务语义一致）；实例身份一律 jobId。
test('A1 同角色多实例显式可见：两记者并行 running，进度独立，roster/UI 双面可见', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const bound = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        const b = await bindTask(ctx);
        bound.push(b);
        const progress = ctx.job.businessDate === '2026-08-09' ? { planned: 3, processed: 2, currentSource: 'A1' } : { planned: 5, processed: 1, currentSource: 'B1' };
        const receipt = await dispatchBusinessCommand(runtime, {
          command: 'agent_tasks.report_progress', requestId: `a1:p:${randomUUID()}`, actor: piWorker,
          input: { phase: 'scanning_sources', progress },
          boundIdentity: { taskId: b.taskId }, entityType: 'agent_task',
          taskId: b.taskId, workerLeaseId: ctx.lease.leaseId, grantId: b.grantId,
          execute: (db, input) => { reportAgentTaskProgress(db, b.taskId, { phase: input.phase, progress: input.progress }); return { data: { id: b.taskId }, entityId: b.taskId }; }
        });
        assert.equal(receipt.ok, true, '进度经真实 dispatcher 写入');
        await gate;
        return SUCCEEDED;
      }
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: '2026-08-09', channelIds: ['c1'] });
    const j2 = spawner.spawn({ roleId: 'reporter', brief: '扫 B', businessDate: '2026-08-10', channelIds: ['c2'] });
    await waitFor(() => bound.length === 2 && spawner.get(j1.id)?.status === 'running' && spawner.get(j2.id)?.status === 'running');
    const proj = projectionOf(spawner, runtime);
    assert.equal(proj.summary.running, 2, '同角色两实例并行 running');
    const i1 = proj.active.find((i) => i.jobId === j1.id);
    const i2 = proj.active.find((i) => i.jobId === j2.id);
    assert.ok(i1 && i2, '两张实例卡并排可见');
    assert.equal(i1.roleId, 'reporter');
    assert.equal(i2.roleId, 'reporter');
    assert.notEqual(i1.progressRatio, i2.progressRatio, '各自进度独立');
    assert.equal(i1.progressLabel, '渠道 2/3 · A1');
    assert.equal(i2.progressLabel, '渠道 1/5 · B1');
    assert.equal(statusWord(i1.status), '工作中');
    assert.deepEqual(filterActiveInstances(proj.active, 'running').map((i) => i.jobId).sort(), [j1.id, j2.id].sort(), 'UI 过滤保留同角色全部卡');
    setActiveJobSpawner(spawner);
    try {
      const row = buildRoleRoster(runtime.database).find((r) => r.roleId === 'reporter');
      assert.equal(row.instances.length, 2, 'roster 同角色多实例显式可见');
      assert.deepEqual(row.instances.map((i) => i.displayNumber), [1, 2]);
    } finally {
      release();
    }
    const d1 = await spawner.await(j1.id, 10_000);
    const d2 = await spawner.await(j2.id, 10_000);
    assert.equal(d1.status, 'succeeded');
    assert.equal(d2.status, 'succeeded');
    spawner.dispose();
    setActiveJobSpawner(null);
  });
});

// A2 实例按任务创建：无 spawn 零实例卡、五角色分组可见；spawn 后实例卡出现
// 注：setActiveJobSpawner(null) 会 dispose 当前 spawner（解除池槽位监听），故 roster 检查须在 spawn 之后。
test('A2 实例按任务创建：空态零实例卡 + 五角色分组；spawn 后实例卡出现', async () => {
  await withRuntime(async ({ runtime }) => {
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => { await bindTask(ctx); return SUCCEEDED; }
    });
    const empty = projectionOf(spawner, runtime);
    assert.equal(empty.summary.active, 0);
    assert.deepEqual(Object.keys(empty.byRole).sort(), ['librarian', 'planner', 'reporter', 'writer'], '四员工角色分组始终可见');
    assert.ok(Object.values(empty.byRole).every((g) => g.active.length === 0), '空态无实例卡');
    const j1 = spawner.spawn({ roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: DATE });
    const j2 = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: DATE, channelIds: ['c1'] });
    await waitFor(() => spawner.get(j1.id)?.status === 'running' && spawner.get(j2.id)?.status === 'running');
    const mid = projectionOf(spawner, runtime);
    assert.ok(mid.byRole.writer.active.some((i) => i.jobId === j1.id), 'spawn 后实例卡出现（writer 组）');
    assert.ok(mid.byRole.reporter.active.some((i) => i.jobId === j2.id), 'spawn 后实例卡出现（reporter 组）');
    assert.equal(mid.summary.active, 2);
    setActiveJobSpawner(spawner);
    try {
      const rows = buildRoleRoster(runtime.database);
      assert.equal(rows.length, 5, '五角色分组始终可见');
      for (const row of rows.filter((r) => r.roleId !== 'desk' && r.instances.length === 0)) {
        assert.equal(row.summary, '当前无任务', `${row.roleId} 空角色无虚构待命态`);
      }
    } finally {
      // 注意：setActiveJobSpawner(null) 会 dispose 当前 spawner（取消 running 句柄），须在工单终态后调用。
    }
    const d1 = await spawner.await(j1.id, 10_000);
    const d2 = await spawner.await(j2.id, 10_000);
    assert.equal(d1.status, 'succeeded');
    assert.equal(d2.status, 'succeeded');
    setActiveJobSpawner(null);
    const after = projectionOf(spawner, runtime);
    assert.equal(after.summary.active, 0, '终态后实例卡退出活动视图');
    spawner.dispose();
  });
});

// A3 终态退出活动视图：succeeded/failed/cancelled 退出 + 历史可指认；needs_user 停留直至关闭
test('A3 终态退出活动视图：三终态退出 + 历史可指认；needs_user 停留至关闭', async () => {
  await withRuntime(async ({ runtime }) => {
    let cancelledTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 3,
      execute: async (ctx) => {
        const { taskId } = await bindTask(ctx);
        if (ctx.job.brief === '失败') {
          await dispatchFailAgentTask(runtime, taskId, 'MCP_UNAVAILABLE', '模拟失败', schedulerCtx('fail'));
          return { status: 'failed', code: 'MCP_UNAVAILABLE', message: '模拟失败', readback: null };
        }
        if (ctx.job.brief === '取消') { cancelledTaskId = taskId; await new Promise(() => {}); }
        if (ctx.job.brief === '等你批') {
          await dispatchNeedsUserAgentTask(runtime, taskId, 'NEEDS_HUMAN_DECISION', '需要你拍板', schedulerCtx('needs'));
          return { status: 'needs_user', code: 'NEEDS_HUMAN_DECISION', message: '需要你拍板', readback: { draft: 'P1 初稿' } };
        }
        // succeeded：pool 终态即退出活动视图（任务由后续接续实例持有——scan→judge 同款语义，不伪造完成校验）。
        return SUCCEEDED;
      }
    });
    const jOk = spawner.spawn({ roleId: 'reporter', brief: '成功', businessDate: DATE });
    const jFail = spawner.spawn({ roleId: 'planner', brief: '失败', businessDate: DATE });
    const jCancel = spawner.spawn({ roleId: 'writer', brief: '取消', projectId: 'P1', businessDate: DATE });
    const jNeed = spawner.spawn({ roleId: 'librarian', brief: '等你批' });
    const dOk = await spawner.await(jOk.id, 10_000);
    assert.equal(dOk.status, 'succeeded', 'succeeded 终态落池');
    assert.equal((await spawner.await(jFail.id, 10_000)).status, 'failed');
    await waitFor(() => spawner.get(jCancel.id)?.status === 'running' && cancelledTaskId !== null);
    await spawner.cancel(jCancel.id);
    assert.equal((await spawner.await(jCancel.id, 10_000)).status, 'cancelled');
    await waitFor(() => getAgentTask(runtime.database, cancelledTaskId)?.status === 'cancelled', 100, 20);
    const doneNeed = await spawner.await(jNeed.id, 10_000);
    assert.equal(doneNeed.status, 'needs_user');
    const proj = projectionOf(spawner, runtime);
    assert.equal(proj.active.some((i) => i.jobId === jOk.id), false, 'succeeded 卡退出活动视图');
    assert.equal(proj.active.some((i) => i.jobId === jFail.id), false, 'failed 卡退出活动视图');
    assert.equal(proj.active.some((i) => i.jobId === jCancel.id), false, 'cancelled 卡退出活动视图');
    assert.equal(proj.summary.active, 1, '仅 needs_user 停留活动视图');
    assert.equal(proj.summary.history, 2, 'failed/cancelled 终态进入历史面（succeeded 任务由接续实例持有）');
    for (const [job, status] of [[jFail, 'failed'], [jCancel, 'cancelled']]) {
      const row = proj.history.find((i) => i.jobId === job.id);
      assert.ok(row, `历史可指认（jobId=${job.id}）`);
      assert.equal(row.status, status);
      assert.equal(row.displayNumber, 0, '历史实例无活动期编号');
    }
    const needInst = proj.active.find((i) => i.jobId === jNeed.id);
    assert.ok(needInst, 'needs_user 卡停留活动视图');
    assert.equal(statusWord(needInst.status), '等你批');
    await spawner.cancel(jNeed.id);
    const after = projectionOf(spawner, runtime);
    assert.equal(after.summary.active, 0, '关闭后 needs_user 退出活动视图');
    assert.equal(after.summary.history, 3, '关闭的卡在历史可追');
    spawner.dispose();
  });
});

// A4 不预设空槽：全空态无待命/占位坐席文案；页头摘要 0；UI 状态词无虚构待命态
test('A4 不预设空槽：全空态无待命/占位坐席文案，摘要 0，无虚构待命态', async () => {
  await withRuntime(async ({ runtime }) => {
    const spawner = new JobSpawner(runtime, { maxWorkers: 2, execute: async () => SUCCEEDED });
    const proj = projectionOf(spawner, runtime);
    assert.deepEqual(headerCounts(proj.summary), { running: 0, queued: 0, needsUser: 0 }, '页头摘要工作中 0 · 排队 0');
    setActiveJobSpawner(spawner);
    try {
      const text = JSON.stringify(buildRoleRoster(runtime.database, { businessDate: DATE }));
      for (const banned of ['待命', '坐席', '工位', '槽位', '占位']) {
        assert.equal(text.includes(banned), false, `roster 输出不得含「${banned}」`);
      }
    } finally {
      setActiveJobSpawner(null);
      spawner.dispose();
    }
    assert.equal(Object.values(STATUS_WORD).includes('待命'), false, 'UI 状态词全集无虚构待命实例态');
  });
});

// A5 并发 = 系统容量：maxWorkers=2 三张跨角色单 → 2 running + 1 queued，FIFO 晋升；maxWorkers=0 拒收
test('A5 并发 = 系统容量：3 张跨角色单 → 2 running + 1 queued，释放后晋升；maxWorkers=0 拒收', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async () => { active += 1; peak = Math.max(peak, active); await gate; active -= 1; return SUCCEEDED; }
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: DATE });
    const j2 = spawner.spawn({ roleId: 'planner', brief: '判 A', businessDate: DATE });
    const j3 = spawner.spawn({ roleId: 'writer', brief: '写 A', projectId: 'P1', businessDate: DATE });
    await waitFor(() => spawner.get(j3.id)?.status === 'queued');
    assert.equal(spawner.get(j1.id)?.status, 'running');
    assert.equal(spawner.get(j2.id)?.status, 'running');
    assert.equal(spawner.get(j3.id)?.status, 'queued', '第三张跨角色单排队（FIFO）');
    const proj = projectionOf(spawner, runtime);
    assert.equal(proj.summary.running, 2);
    assert.equal(proj.summary.queued, 1);
    release();
    const done = await Promise.all([j1, j2, j3].map((job) => spawner.await(job.id, 10_000)));
    assert.ok(done.every((d) => d.status === 'succeeded'), '释放后排队单自动晋升并成功');
    assert.ok(peak <= 2, `并发峰值不超过系统容量（峰值 ${peak}）`);
    spawner.dispose();
    const disabled = new JobSpawner(runtime, { maxWorkers: 0, execute: async () => SUCCEEDED });
    assert.throws(() => disabled.spawn({ roleId: 'reporter', brief: 'x', businessDate: DATE }), (e) => e.code === 'JOB_SPAWN_DISABLED', 'maxWorkers=0 派工停用');
    disabled.dispose();
  });
});

// A6 并发 ≠ 角色配额：两记者占满 2 槽；调 maxWorkers=4 第三记者单直接运行，零角色/注册表改动
test('A6 并发 ≠ 角色配额：两记者占满容量；调 maxWorkers=4 第三记者单直接运行', async () => {
  await withRuntime(async ({ runtime }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spawner = new JobSpawner(runtime, { maxWorkers: 2, execute: async () => { await gate; return SUCCEEDED; } });
    const a = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: DATE, channelIds: ['c1'] });
    const b = spawner.spawn({ roleId: 'reporter', brief: '扫 B', businessDate: DATE, channelIds: ['c2'] });
    await waitFor(() => spawner.get(a.id)?.status === 'running' && spawner.get(b.id)?.status === 'running');
    assert.equal(spawner.getMaxWorkers(), 2);
    assert.equal(spawner.pool.activeEmployeeCount(), 2, '同角色两实例占满系统容量（容量非角色配额）');
    const c = spawner.spawn({ roleId: 'reporter', brief: '扫 C', businessDate: DATE, channelIds: ['c3'] });
    await waitFor(() => spawner.get(c.id)?.status === 'queued');
    spawner.setMaxWorkers(4);
    await waitFor(() => spawner.get(c.id)?.status === 'running');
    assert.equal(spawner.get(c.id).status, 'running', '容量提升后第三张同角色单直接运行');
    assert.equal(spawner.getMaxWorkers(), 4);
    release();
    await Promise.all([a, b, c].map((job) => spawner.await(job.id, 10_000)));
    spawner.dispose();
  });
});

// A7 桌助非主管工位：不可 spawn、不进员工投影、零 standing 写权、只读/编排工具
test('A7 桌助非主管工位：spawn 拒绝、不进员工投影、零 standing 写权、工具只读/编排', async () => {
  await withRuntime(async ({ runtime }) => {
    const spawner = new JobSpawner(runtime, { maxWorkers: 2, execute: async () => SUCCEEDED });
    assert.throws(() => spawner.spawn({ roleId: 'desk', brief: 'nope' }), (e) => e.code === 'ROLE_NOT_SPAWNABLE', 'spawn(roleId:desk) 拒绝');
    assert.equal(spawner.pool.activeEmployeeCount(), 0, 'desk 不占员工容量');
    const proj = projectionOf(spawner, runtime);
    assert.equal('desk' in proj.byRole, false, 'desk 不进员工投影（不计容量）');
    assert.deepEqual([...roleWriteCommands('desk')], [], 'desk 无 standing 写权');
    assert.equal(roleHasPagePassThrough('desk'), true, 'desk 仅页级透传');
    const passThrough = AGENT_CAPABILITIES.filter((c) => c.pageScopePassThrough);
    assert.equal(passThrough.length, 1, '页级透传唯一');
    assert.equal(passThrough[0].id, 'cap.desk');
    const deskCap = AGENT_CAPABILITIES.find((c) => c.id === 'cap.desk');
    assert.deepEqual([...deskCap.commands], [], '桌助工具只读/编排，无 plans.save/content.* 业务写命令');
    setActiveJobSpawner(spawner);
    try {
      const desk = buildRoleRoster(runtime.database, { businessDate: DATE }).find((r) => r.roleId === 'desk');
      assert.equal(desk.instances.length, 0, 'desk 永不进员工实例');
      assert.equal(desk.labelZh, '桌助');
      assert.equal(desk.roomZh, '协调入口');
    } finally {
      setActiveJobSpawner(null);
      spawner.dispose();
    }
  });
});

// A8 实例权限交集：grant ∩ 角色能力 ∩ 边界；跨角色命令真实拦截 + 审计 + 零业务写
test('A8 实例权限交集：写手只读借阅无组织命令；资料员无 plans.save/content.*/reviews.save；越界拦截', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const writer = await setupBoundAgent(runtime, { roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: '2026-08-09' }, '2026-08-09');
    const writerGrant = getTaskGrantRow(database, writer.task.id);
    assert.ok(writerGrant.commands.includes('content.save_version'), '写手自动 grant 含写作命令');
    for (const cmd of ['plans.save', 'sources.lane_restore', 'reviews.save']) {
      assert.equal(writerGrant.commands.includes(cmd), false, `写手 grant 不得含 ${cmd}`);
    }
    const writerWrite = new Set(roleWriteCommands('writer'));
    assert.ok(writerWrite.has('content.create') && writerWrite.has('content.save_version'));
    assert.equal(writerWrite.has('plans.save'), false, '写手无选题命令');
    assert.equal(writerWrite.has('sources.lane_restore'), false, '写手无组织命令');
    const writerRead = roleReadProfiles('writer');
    assert.ok(writerRead.includes('knowledge') && writerRead.includes('sources'), '写手可只读借阅资料库');
    const organize = await dispatchBusinessCommand(runtime, {
      command: 'sources.lane_restore', requestId: 'a8-writer-organize', actor: piWorker,
      input: { sourceId: 's1' }, boundIdentity: { entityType: 'source_item' },
      taskId: writer.task.id, workerLeaseId: writer.lease.leaseId, grantId: writerGrant.id, entityType: 'source_item',
      execute: () => ({ data: { restored: true } })
    });
    assert.equal(organize.ok, false, '写手越界组织命令必须拦截');
    assert.equal(organize.error.code, 'TASK_SCOPE_BROADENED');
    assert.equal(organize.sideEffectState, 'not_started', 'handler 未执行 → 零业务写');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM command_receipts WHERE request_id='a8-writer-organize' AND status='error' AND side_effect_state='not_started'`).get().c, 1);
    runtime.releaseWorker(writer.lease);

    const lib = await setupBoundAgent(runtime, { roleId: 'librarian', brief: '整理 s1', sourceIds: ['s1'] }, null);
    const libGrant = getTaskGrantRow(database, lib.task.id);
    const libWrite = new Set(roleWriteCommands('librarian'));
    assert.ok(libWrite.has('sources.lane_restore'), '资料员可整理库房');
    assert.equal(libWrite.has('plans.save'), false);
    assert.equal(libWrite.has('content.save_version'), false);
    assert.equal(libWrite.has('reviews.save'), false);
    const attempts = [
      ['plans.save', 'a8-lib-plans', { planDate: '2026-08-09', summary: 's', items: [] }, { planDate: '2026-08-09' }],
      ['content.save_version', 'a8-lib-content', { projectId: 'P1', body: 'b' }, { projectId: 'P1' }],
      ['reviews.save', 'a8-lib-reviews', { publicationId: 'pub-1', metricSnapshotIds: ['m1'] }, { publicationId: 'pub-1' }]
    ];
    for (const [command, requestId, input, boundIdentity] of attempts) {
      const res = await dispatchBusinessCommand(runtime, {
        command, requestId, actor: piWorker, input, boundIdentity,
        taskId: lib.task.id, workerLeaseId: lib.lease.leaseId, grantId: libGrant.id, entityType: 'x',
        execute: () => ({ data: { ok: 1 } })
      });
      assert.equal(res.ok, false, `${command} 对资料员必须拦截`);
      assert.equal(res.error.code, 'TASK_SCOPE_BROADENED');
      assert.equal(res.sideEffectState, 'not_started');
    }
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM operation_log WHERE result='error' AND error_code='TASK_SCOPE_BROADENED' AND command IN ('plans.save','content.save_version','reviews.save')`).get().c, 3, '三次越界均有审计');
    runtime.releaseWorker(lib.lease);
  });
});

// A9 资源边界（对象级硬隔离）：跨项目写 BLOCKED + 审计 + 零业务写；同项目第二单 waiting_resource 晋升
test('A9 资源边界（对象级硬隔离）：跨项目写 BLOCKED + 审计 + 零业务写；同项目第二单等待后晋升', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { task, lease, grantId } = await setupBoundAgent(runtime, { roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: '2026-08-09' }, '2026-08-09');
    const send = (requestId, projectId) => dispatchBusinessCommand(runtime, {
      command: 'content.save_version', requestId, actor: piWorker, input: { projectId, body: '正文', author: 'agent' },
      boundIdentity: { projectId, versionId: null }, taskId: task.id, workerLeaseId: lease.leaseId, grantId, entityType: 'content_version',
      execute: (db, input) => ({ data: { savedProjectId: input.projectId }, entityId: input.projectId })
    });
    const cross = await send('a9-cross-project', 'P2');
    assert.equal(cross.ok, false, '跨对象写必须拦截');
    assert.equal(cross.error.code, 'TASK_SCOPE_BROADENED');
    assert.equal(cross.error.details?.reason, OBJECT_SCOPE_MISMATCH);
    assert.equal(cross.error.details?.dimension, 'projectId');
    assert.equal(cross.error.details?.got, 'P2');
    assert.equal(cross.sideEffectState, 'not_started', 'handler 未执行 → 零业务写');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM command_receipts WHERE request_id='a9-cross-project' AND status='error' AND side_effect_state='not_started'`).get().c, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM operation_log WHERE command='content.save_version' AND result='error' AND error_code='TASK_SCOPE_BROADENED'`).get().c, 1);
    const same = await send('a9-same-project', 'P1');
    assert.equal(same.ok, true, '同界写成功');
    runtime.releaseWorker(lease);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => { if (ctx.job.brief === '第一张') await gate; return SUCCEEDED; }
    });
    const j1 = spawner.spawn({ roleId: 'writer', brief: '第一张', projectId: 'p-same', businessDate: '2026-08-09' });
    await waitFor(() => spawner.get(j1.id)?.status === 'running');
    const j2 = spawner.spawn({ roleId: 'writer', brief: '第二张同项目', projectId: 'p-same', businessDate: '2026-08-09' });
    await waitFor(() => spawner.get(j2.id)?.status === 'waiting_resource');
    assert.equal(spawner.get(j2.id)?.waitReason?.startsWith('RESOURCE_LOCK_CONFLICT'), true, '同项目第二单 waiting_resource');
    assert.notEqual(spawner.get(j2.id)?.status, 'failed');
    release();
    assert.equal((await spawner.await(j1.id, 10_000)).status, 'succeeded');
    assert.equal((await spawner.await(j2.id, 10_000)).status, 'succeeded', '锁释放后 FIFO 晋升');
    spawner.dispose();
  });
});

// A10 红线不变：发布/平台副作用命令对任何 grant 组合不可达；agentGrantable:false 能力不出现在任何覆盖面
test('A10 红线不变：红线命令冻结且只属 agentGrantable:false；有效 grant + 匹配边界仍被 fail-closed 红线门拦死', async () => {
  await withRuntime(async ({ runtime, database }) => {
    assert.deepEqual([...REDLINE_COMMANDS], ['x_lists.operation_execute', 'intelligence_channels.proposal_apply'], '红线命令冻结');
    for (const command of REDLINE_COMMANDS) {
      const caps = AGENT_CAPABILITIES.filter((c) => c.commands.includes(command));
      assert.ok(caps.length >= 1, `${command} 必须登记于能力面`);
      assert.ok(caps.every((c) => c.agentGrantable === false), `${command} 只出现在 agentGrantable:false 能力`);
      for (const role of Object.keys(ROLE_CATALOG)) {
        assert.equal(roleWriteCommands(role).includes(command), false, `${command} 不得出现在 ${role} standing 写权`);
      }
    }
    const { task, lease } = await setupBoundAgent(runtime, { roleId: 'writer', brief: '写 P1', projectId: 'P1', businessDate: '2026-08-09' }, '2026-08-09');
    const autoGrant = getTaskGrantRow(database, task.id);
    await dispatchRevokeTaskGrant(runtime, { requestId: 'a10-revoke-auto', grantId: autoGrant.id, expectedRevision: autoGrant.revision });
    const redGrant = await dispatchIssueTaskGrant(runtime, {
      requestId: 'a10-red-grant', taskId: task.id, ownerGoal: '红线负断言', allowedCommands: ['x_lists.operation_execute'],
      workers: [{ type: 'pi', id: 'pi' }], relevantContext: { projectId: 'P1' }, expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(redGrant.ok, true, '越权 grant 可签发（授权面不变），执行仍被 execution grant 门拦截');
    const red = await dispatchBusinessCommand(runtime, {
      command: 'x_lists.operation_execute', requestId: 'a10-red-blocked', actor: piWorker,
      input: { kind: 'unfollow', accountKey: 'acc', listId: 'l1' },
      boundIdentity: { accountKey: 'acc', allowedTransition: 'member:unfollow', requiredReadback: {} },
      taskId: task.id, workerLeaseId: lease.leaseId, grantId: redGrant.data.id, entityType: 'x_list_operation',
      execute: () => ({ data: { executed: true } })
    });
    assert.equal(red.ok, false);
    // 拦截层可更早收紧：红线命令先于 execution grant 门被任务侧 Owner-only 门（TASK_SCOPE_BROADENED）拦死，原执行门（EXECUTION_GRANT_REQUIRED）同样 fail-closed，前移不削弱红线
    assert.ok(['TASK_SCOPE_BROADENED', 'EXECUTION_GRANT_REQUIRED'].includes(red.error.code), '红线命令对任何实例/grant 组合不可达（fail-closed 代码集合）');
    assert.ok(Boolean(red.error.message), '红线拦截有拒绝证据（错误消息非空）');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM x_list_operations').get().c, 0, '红线命令零业务写');
    runtime.releaseWorker(lease);
  });
});

// A11 needs_user 数据流：稳定 code + 部分读回 → 呈报面；零 slot/lease/grant/锁；不自动重试；关闭闭环
test('A11 needs_user 数据流：code + 部分读回呈报；零资源；不自动重试；关闭退出活动视图', async () => {
  await withRuntime(async ({ runtime, database }) => {
    let executeCalls = 0;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        executeCalls += 1;
        if (ctx.job.brief === '同键复检') return SUCCEEDED;
        const { taskId } = await bindTask(ctx);
        await dispatchNeedsUserAgentTask(runtime, taskId, 'NEEDS_HUMAN_DECISION', '需要你拍板选题方向', schedulerCtx('needs'));
        return { status: 'needs_user', code: 'NEEDS_HUMAN_DECISION', message: '需要你拍板选题方向', readback: { draft: 'P1 初稿', choice: ['A', 'B'] } };
      }
    });
    const job = spawner.spawn({ roleId: 'planner', brief: '拍板 P1', businessDate: DATE });
    const done = await spawner.await(job.id, 10_000);
    assert.equal(done.status, 'needs_user');
    assert.equal(done.report?.code, 'NEEDS_HUMAN_DECISION', '稳定 code 呈报');
    assert.deepEqual(done.report?.readback, { draft: 'P1 初稿', choice: ['A', 'B'] }, '部分读回证据经工单面呈报');
    assert.equal(executeCalls, 1, '不自动重试');
    const proj = projectionOf(spawner, runtime);
    const inst = proj.active.find((i) => i.jobId === job.id);
    assert.ok(inst, 'needs_user 停留活动视图');
    assert.equal(inst.status, 'needs_user');
    assert.equal(inst.code, 'NEEDS_HUMAN_DECISION');
    assert.equal(statusWord(inst.status), '等你批');
    assert.match(instanceDetail(inst) ?? '', /NEEDS_HUMAN_DECISION/);
    assert.equal(employeeSnapshotCount(runtime), 0, 'needs_user 零 lease');
    assert.equal(database.prepare(`SELECT COUNT(*) AS c FROM task_grants WHERE task_id=? AND status='active'`).get(inst.taskId).c, 0, 'needs_user 零 grant');
    const relock = spawner.spawn({ roleId: 'planner', brief: '同键复检', businessDate: DATE });
    await waitFor(() => spawner.get(relock.id)?.status === 'running');
    assert.equal(spawner.get(relock.id).status, 'running', 'needs_user 零锁（同键新单可直接运行）');
    await spawner.await(relock.id, 10_000);
    await spawner.cancel(job.id);
    const after = projectionOf(spawner, runtime);
    assert.equal(after.active.some((i) => i.jobId === job.id), false, '关闭后 needs_user 退出活动视图');
    assert.equal(after.summary.needsUser, 0);
    spawner.dispose();
  });
});

// A12 取消 ≤5s：running 取消 → 任务 cancelled + lease 归零 + pool cancelled，总门 ≤5s；重复取消幂等
test('A12 取消 ≤5s：running 取消总门 ≤5s，任务/池双 cancelled，lease 归零；重复取消幂等', async () => {
  await withRuntime(async ({ runtime }) => {
    let boundTaskId = null;
    const seen = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        const { taskId } = await bindTask(ctx);
        boundTaskId = taskId;
        await waitForAbort(ctx.signal);
        return SUCCEEDED;
      },
      onEvent: (event) => seen.push(event.type)
    });
    const j1 = spawner.spawn({ roleId: 'reporter', brief: '扫 A', businessDate: DATE });
    await waitFor(() => boundTaskId !== null);
    const t0 = Date.now();
    await spawner.cancel(j1.id);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed <= 5000, `取消总门 ≤5s（实测 ${elapsed}ms）`);
    const done = await spawner.await(j1.id, 10_000);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.report?.code, 'JOB_CANCELLED');
    assert.equal(getAgentTask(runtime.database, boundTaskId)?.status, 'cancelled', 'agent_task 同步 cancelled');
    assert.equal(employeeSnapshotCount(runtime), 0, 'lease 归零');
    assert.equal(seen.filter((t) => t === 'job.cancelled').length, 1);
    const again = await spawner.cancel(j1.id);
    assert.equal(again?.status, 'cancelled', '重复取消幂等');
    assert.equal(seen.filter((t) => t === 'job.cancelled').length, 1, '重复取消不重复 emit');
    spawner.dispose();
  });
});

// A13 历史可重建与一键续派：重启（池清空）后从 context_refs_json 完整指认并重建原请求，可再次 spawn
test('A13 历史可重建与一键续派：重启后从 context_refs_json 指认并重建原请求，一键续派可再次 spawn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wmb-5145-rebuild-'));
  let persistedJobId = null;
  let taskId = null;
  try {
    const runtime = openRuntime(root, 'epoch-1', 'ws-5145-rebuild');
    try {
      const spawner = new JobSpawner(runtime, {
        maxWorkers: 2,
        execute: async (ctx) => {
          const b = await bindTask(ctx);
          taskId = b.taskId;
          await dispatchFailAgentTask(runtime, b.taskId, 'MCP_UNAVAILABLE', '模拟失败', schedulerCtx('fail'));
          return { status: 'failed', code: 'MCP_UNAVAILABLE', message: '模拟失败', readback: null };
        }
      });
      const job = spawner.spawn({ roleId: 'writer', brief: '写 P13 初稿', projectId: 'P13', businessDate: DATE });
      const done = await spawner.await(job.id, 10_000);
      assert.equal(done.status, 'failed');
      persistedJobId = job.id;
      spawner.dispose();
    } finally {
      await runtime.stop({ drain: false });
    }
    const reopened = openRuntime(root, 'epoch-2', 'ws-5145-rebuild');
    try {
      const proj = readCrewInstanceProjection({ database: reopened.database, pool: new JobPool(2) });
      assert.equal(proj.summary.history, 1, '重启后历史只从持久面重建（池已清空）');
      const row = proj.history.find((i) => i.jobId === persistedJobId);
      assert.ok(row, '历史实例以 jobId 完整指认');
      assert.equal(row.roleId, 'writer');
      assert.equal(row.brief, '写 P13 初稿');
      assert.equal(row.status, 'failed');
      assert.equal(row.projectId, 'P13');
      assert.equal(row.displayNumber, 0, '历史实例无活动期编号（编号不持久化）');
      assert.ok(row.sessionFile, '会话文件 ref 完整指认');
      const refs = getAgentTask(reopened.database, taskId).contextRefs;
      const rebuilt = rebuildRoleJobRequest(refs);
      assert.deepEqual(rebuilt, { roleId: 'writer', brief: '写 P13 初稿', projectId: 'P13', businessDate: DATE }, 'context_refs_json 重建原 RoleJobRequest');
      const uiInput = redispatchInput(row);
      assert.deepEqual(uiInput, rebuilt, 'UI 一键续派输入与持久重建一致');
      const spawner2 = new JobSpawner(reopened, { maxWorkers: 1, execute: async () => SUCCEEDED });
      const j2 = spawner2.spawn(uiInput);
      assert.equal((await spawner2.await(j2.id, 10_000)).status, 'succeeded', '一键续派直接再 spawn');
      spawner2.dispose();
    } finally {
      await reopened.stop({ drain: false });
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('A14 兼容不变量：schema 零改动、五角色固定、核心能力零漂移、新增能力不扰动交集/红线', async () => { await withRuntime(async ({ database }) => { assertCompatibilityInvariants({ database }); }); });
