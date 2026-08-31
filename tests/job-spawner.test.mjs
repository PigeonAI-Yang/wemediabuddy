import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-job-test', now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

const SUCCEEDED = { status: 'succeeded', code: 'OK', message: null, readback: null };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function employeeSnapshotCount(runtime) {
  return runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length;
}

async function withRuntime(prefix, fn, cleanup) {
  const directory = mkdtempSync(path.join(tmpdir(), `wmb-spawner-${prefix}-`));
  const runtime = openRuntime(directory);
  try {
    await fn(runtime);
  } finally {
    if (cleanup) await cleanup(runtime);
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}

function onAbort(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', resolve, { once: true });
  });
}

async function waitFor(predicate, attempts = 100, interval = 10) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await sleep(interval);
  }
}

async function awaitStatus(spawner, jobId, status, message) {
  const done = await spawner.await(jobId, 10_000);
  assert.equal(done.status, status, message);
  return done;
}

async function withHeldReporter(runtime, brief, setup, opts = {}) {
  const { readyMessage, ...spawnOptions } = opts;
  let registered = false;
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 1,
    execute: async (ctx) => {
      if (ctx.job.roleId === 'reporter') {
        await setup(ctx);
        registered = true;
        await onAbort(ctx.signal);
      }
      return SUCCEEDED;
    },
    ...spawnOptions
  });
  const job = spawner.spawn({ roleId: 'reporter', brief, businessDate: '2026-08-08' });
  await waitFor(() => registered);
  assert.equal(registered, true, readyMessage);
  return { spawner, job };
}

function runtimeTest(name, prefix, fn, cleanup) {
  test(name, async () => {
    await withRuntime(prefix, fn, cleanup);
  });
}

runtimeTest('spawner runs two employee jobs with maxWorkers=5', '', async (runtime) => {
  const seen = [];
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 5,
    execute: async () => {
      await sleep(30);
      return SUCCEEDED;
    },
    onEvent: (event) => seen.push(event.type)
  });
  const a = spawner.spawn({ roleId: 'reporter', brief: '扫源 A', businessDate: '2026-08-07' });
  const b = spawner.spawn({ roleId: 'librarian', brief: '整理库' });
  assert.ok(a.status === 'running' || a.status === 'queued');
  assert.ok(b.status === 'running' || b.status === 'queued');
  await awaitStatus(spawner, a.id, 'succeeded');
  await awaitStatus(spawner, b.id, 'succeeded');
  assert.ok(seen.includes('job.finished') || seen.includes('job.started'));
  assert.equal(employeeSnapshotCount(runtime), 0);
  spawner.dispose();
});

runtimeTest('sixth job queues then promotes after slot free', 'q', async (runtime) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 5,
    execute: async () => {
      await gate;
      return SUCCEEDED;
    }
  });
  const jobs = [
    spawner.spawn({ roleId: 'reporter', brief: '1', businessDate: '2026-08-01' }),
    spawner.spawn({ roleId: 'writer', brief: '2', projectId: 'p2', businessDate: '2026-08-02' }),
    spawner.spawn({ roleId: 'planner', brief: '3', businessDate: '2026-08-03' }),
    spawner.spawn({ roleId: 'librarian', brief: '4' }),
    spawner.spawn({ roleId: 'reporter', brief: '5', businessDate: '2026-08-05', channelIds: ['c5'] }),
    spawner.spawn({ roleId: 'planner', brief: '6', businessDate: '2026-08-06' })
  ];
  await waitFor(() => spawner.list().filter((job) => job.status === 'running').length === 5, 100, 20);
  assert.equal(spawner.get(jobs[5].id)?.status, 'queued');
  release();
  const done = await Promise.all(jobs.map((job) => spawner.await(job.id, 10_000)));
  assert.ok(done.every((job) => job.status === 'succeeded'));
  spawner.dispose();
});

runtimeTest('L1-1 spawn rejects intent / planDate / unknown keys at runtime', 'validate', async (runtime) => {
  const spawner = new JobSpawner(runtime, { maxWorkers: 1, execute: async () => SUCCEEDED });
  const VALIDATION_ERROR = (error) => { assert.equal(error.code, 'VALIDATION_ERROR'); return true; };
  assert.throws(() => spawner.spawn({ roleId: 'reporter', brief: 'x', intent: 'studio_draft' }), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /intent/);
    return true;
  });
  for (const input of [
    { roleId: 'planner', brief: 'x', planDate: '2026-08-08' },
    { roleId: 'reporter', brief: 'x', bogus: 1 }
  ]) assert.throws(() => spawner.spawn(input), VALIDATION_ERROR);
  assert.throws(() => spawner.spawn({ roleId: 'writer', brief: 'x' }), (error) => {
    assert.equal(error.code, 'JOB_PROJECT_REQUIRED');
    return true;
  });
  assert.throws(() => spawner.spawn({ roleId: 'desk', brief: 'nope' }), /ROLE_NOT_SPAWNABLE|员工/);
  spawner.dispose();
});

runtimeTest('L1-2 derived intent on job records: no external intent, registry derives', 'derive', async (runtime) => {
  const spawner = new JobSpawner(runtime, { maxWorkers: 3, execute: async () => SUCCEEDED });
  const reporter = spawner.spawn({ roleId: 'reporter', brief: '扫', businessDate: '2026-08-08' });
  const planner = spawner.spawn({ roleId: 'planner', brief: '判', businessDate: '2026-08-08' });
  const writer = spawner.spawn({ roleId: 'writer', brief: '写', projectId: 'p1', businessDate: '2026-08-08' });
  const librarian = spawner.spawn({ roleId: 'librarian', brief: '整理' });
  assert.equal(reporter.intent, 'daily_scan');
  assert.equal(planner.intent, 'daily_judge');
  assert.equal(writer.intent, 'studio_draft');
  assert.equal(librarian.intent, 'page_library');
  assert.equal(librarian.projectId, null);
  assert.match(librarian.businessDate, /^\d{4}-\d{2}-\d{2}$/, 'librarian 缺省业务日期为今日（仅上下文，不参与锁）');
  assert.deepEqual(librarian.resourceLocks, [`library-maintenance:ws-job-test`]);
  await Promise.all([
    spawner.await(reporter.id, 10_000),
    spawner.await(planner.id, 10_000),
    spawner.await(writer.id, 10_000),
    spawner.await(librarian.id, 10_000)
  ]);
  spawner.dispose();
});

runtimeTest('L0-1 lock conflict -> waiting_resource -> auto-promote on release (spawner level)', 'wait', async (runtime) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 5,
    execute: async ({ job }) => {
      if (job.roleId === 'reporter') await gate;
      return SUCCEEDED;
    },
    onEvent: (event) => seen.push(event.type)
  });
  const a = spawner.spawn({ roleId: 'reporter', brief: 'scan A', channelIds: ['c1'], businessDate: '2026-08-08' });
  const b = spawner.spawn({ roleId: 'reporter', brief: 'scan B', channelIds: ['c1'], businessDate: '2026-08-08' });
  await waitFor(() => spawner.get(b.id)?.status === 'waiting_resource');
  const waiting = spawner.get(b.id);
  assert.equal(waiting.status, 'waiting_resource', 'second same-channel scan waits for resource');
  assert.match(waiting.waitReason, /RESOURCE_LOCK_CONFLICT/);
  assert.ok(seen.includes('job.waiting_resource'));
  release();
  await awaitStatus(spawner, b.id, 'succeeded', 'auto-promoted after lock released, never failed');
  await awaitStatus(spawner, a.id, 'succeeded');
  spawner.dispose();
});

const held = [];
runtimeTest('L0-2 lease soft cap -> waiting_resource(RESOURCE_LEASE_BUSY), rescan promotes', 'lease', async (runtime) => {
  for (let i = 0; i < 8; i += 1) held.push(runtime.acquireWorkerLease(null, 'reporter', 'employee'));
  const seen = [];
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 5,
    execute: async () => SUCCEEDED,
    onEvent: (event) => seen.push(event.type)
  });
  const job = spawner.spawn({ roleId: 'reporter', brief: 'wait lease', businessDate: '2026-08-08' });
  await waitFor(() => spawner.get(job.id)?.status === 'waiting_resource');
  const waiting = spawner.get(job.id);
  assert.equal(waiting.status, 'waiting_resource');
  assert.match(waiting.waitReason, /RESOURCE_LEASE_BUSY/);
  assert.ok(seen.includes('job.waiting_resource'));
  // lease 可用后（模拟看门狗重扫）自动晋升并成功，全程不落 failed。
  runtime.releaseWorker(held.pop());
  spawner.pool.rescan();
  await awaitStatus(spawner, job.id, 'succeeded');
  spawner.dispose();
}, (runtime) => { for (const lease of held) runtime.releaseWorker(lease); });

runtimeTest('L0-3 cancel matrix: queued / waiting_resource / running all end cancelled', 'cancel', async (runtime) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 5,
    execute: async ({ job }) => {
      // 可控 gate 保持五个 Reporter running，避免快单提前 succeeded 造成断言竞态。
      if (job.roleId === 'reporter') await gate;
      return SUCCEEDED;
    }
  });
  // a 持锁 running；b 同扫描键 → waiting_resource；c-f 不同渠道键 → running。
  const a = spawner.spawn({ roleId: 'reporter', brief: 'hold', businessDate: '2026-08-08' });
  const b = spawner.spawn({ roleId: 'reporter', brief: 'same-key', businessDate: '2026-08-08' });
  const c = spawner.spawn({ roleId: 'reporter', brief: 'other-key', channelIds: ['c2'], businessDate: '2026-08-08' });
  const d = spawner.spawn({ roleId: 'reporter', brief: 'other-key-2', channelIds: ['c3'], businessDate: '2026-08-08' });
  const e = spawner.spawn({ roleId: 'reporter', brief: 'other-key-3', channelIds: ['c4'], businessDate: '2026-08-08' });
  const f = spawner.spawn({ roleId: 'reporter', brief: 'other-key-4', channelIds: ['c5'], businessDate: '2026-08-08' });
  await waitFor(() => spawner.get(b.id)?.status === 'waiting_resource' && [a, c, d, e, f].every((job) => spawner.get(job.id)?.status === 'running'));
  assert.equal(spawner.get(b.id)?.status, 'waiting_resource');
  assert.equal(spawner.get(c.id)?.status, 'running');
  // queued：五个 running 占满容量 → g 排队。
  const g = spawner.spawn({ roleId: 'reporter', brief: 'queued', channelIds: ['c6'], businessDate: '2026-08-08' });
  await waitFor(() => spawner.get(g.id)?.status === 'queued');
  assert.equal(spawner.get(g.id)?.status, 'queued');
  const queuedCancelled = await spawner.cancel(g.id);
  assert.equal(queuedCancelled.status, 'cancelled');
  const waitingCancelled = await spawner.cancel(b.id);
  assert.equal(waitingCancelled.status, 'cancelled');
  const runningCancelled = await spawner.cancel(a.id);
  assert.equal(runningCancelled.status, 'cancelled');
  release();
  await Promise.all([c, d, e, f].map((job) => spawner.await(job.id, 10_000)));
  assert.equal(employeeSnapshotCount(runtime), 0, 'all leases released after cancels');
  spawner.dispose();
});

runtimeTest('L0-5 five states flow through the pool; abort beats late outcome', 'states', async (runtime) => {
  const seen = [];
  let mode = 'partial';
  const MODE_OUTCOMES = {
    partial: { status: 'partial', code: 'PARTIAL_SCAN', message: null, readback: null },
    needs_user: { status: 'needs_user', code: 'PI_CONFIG_REQUIRED', message: '缺少配置', readback: null },
    failed: { status: 'failed', code: 'MCP_UNAVAILABLE', message: 'no mcp', readback: null },
    'cancel-race': { status: 'failed', code: 'JOB_FAILED', message: 'late failure', readback: null }
  };
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 1,
    execute: async ({ signal }) => {
      if (mode === 'cancel-race') await onAbort(signal);
      return MODE_OUTCOMES[mode];
    },
    onEvent: (event) => seen.push(event.type)
  });
  const p = spawner.spawn({ roleId: 'reporter', brief: 'partial', businessDate: '2026-08-08' });
  await awaitStatus(spawner, p.id, 'partial');
  assert.ok(seen.includes('job.partial'));
  mode = 'needs_user';
  const n = spawner.spawn({ roleId: 'planner', brief: 'needs', businessDate: '2026-08-08' });
  await awaitStatus(spawner, n.id, 'needs_user');
  assert.ok(seen.includes('job.needs_user'));
  mode = 'failed';
  const f = spawner.spawn({ roleId: 'writer', brief: 'fail', projectId: 'p1', businessDate: '2026-08-08' });
  const doneF = await awaitStatus(spawner, f.id, 'failed');
  assert.equal(doneF.error, 'MCP_UNAVAILABLE');
  assert.ok(seen.includes('job.failed'));
  // abort + late failed outcome -> cancelled（abort 永远胜出）
  mode = 'cancel-race';
  const r = spawner.spawn({ roleId: 'librarian', brief: 'race' });
  await waitFor(() => spawner.getHandle(r.id)?.sessionFile, 100, 20);
  await spawner.cancel(r.id);
  await awaitStatus(spawner, r.id, 'cancelled');
  spawner.dispose();
});

runtimeTest('terminal record carries report with code/message/readback', 'report', async (runtime) => {
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 1,
    execute: async () => ({
      status: 'succeeded',
      code: 'CONTENT_VERSION',
      message: null,
      readback: { kind: 'content_version', projectId: 'p1', versionId: 'ver-1' }
    })
  });
  const job = spawner.spawn({ roleId: 'writer', brief: 'draft', projectId: 'p1', businessDate: '2026-08-08' });
  const done = await awaitStatus(spawner, job.id, 'succeeded');
  assert.ok(done.report, 'report attached to terminal record');
  assert.equal(done.report.code, 'CONTENT_VERSION');
  assert.equal(done.report.intent, 'studio_draft');
  assert.equal(done.report.businessDate, '2026-08-08');
  assert.equal(done.report.projectId, 'p1');
  assert.deepEqual(done.report.readback, { kind: 'content_version', projectId: 'p1', versionId: 'ver-1' });
  assert.equal(done.report.status, 'succeeded');
  assert.ok(done.report.finishedAt);
  spawner.dispose();
});

runtimeTest('T-08 running cancel invokes registered stopResource exactly once and still cancels', 'stop', async (runtime) => {
  let stopCalls = 0;
  const { spawner, job } = await withHeldReporter(runtime, 'hold', async (ctx) => {
    // ctx.stopResource 是实时 getter：必须属性访问（解构会在函数入口快照为 null）。
    assert.equal(typeof ctx.registerStoppable, 'function');
    assert.equal(ctx.stopResource, null, '注册前 stopResource 为 null');
    ctx.registerStoppable(async () => { stopCalls += 1; });
    assert.equal(typeof ctx.stopResource, 'function', '注册后 ctx.stopResource 实时可见');
  }, { readyMessage: '执行器已注册 stoppable' });
  const cancelled = await spawner.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(stopCalls, 1, 'stopResource 恰被调用一次');
  await awaitStatus(spawner, job.id, 'cancelled');
  assert.equal(employeeSnapshotCount(runtime), 0, 'lease 归零');
  spawner.dispose();
});

runtimeTest('T-10 registering a stoppable after abort stops it immediately (late Pi window closed)', 'late', async (runtime) => {
  let stopCalls = 0;
  let registered = false;
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 1,
    execute: async ({ job, signal, registerStoppable }) => {
      if (job.roleId === 'reporter') {
        // 模拟 Pi 晚创建窗口：先挂起，abort 触发后才注册。
        await onAbort(signal);
        registerStoppable(async () => { stopCalls += 1; });
        registered = true;
        await sleep(30); // 让已触发的 stop 执行完
      }
      return SUCCEEDED;
    }
  });
  const job = spawner.spawn({ roleId: 'reporter', brief: 'late', businessDate: '2026-08-08' });
  await waitFor(() => spawner.getHandle(job.id)?.sessionFile);
  await spawner.cancel(job.id);
  await waitFor(() => registered);
  assert.equal(registered, true);
  assert.equal(stopCalls, 1, 'abort 后注册：stop 在注册返回前即被同步调用');
  await awaitStatus(spawner, job.id, 'cancelled');
  spawner.dispose();
});

runtimeTest('T-13 hanging stopResource does not block cancellation (stop bounded ≤2s)', 'slowstop', async (runtime) => {
  const { spawner, job } = await withHeldReporter(runtime, 'slow', async (ctx) => {
    ctx.registerStoppable(() => new Promise(() => {})); // 永不 resolve 的 stop
  });
  const t0 = Date.now();
  const cancelled = await spawner.cancel(job.id);
  const elapsed = Date.now() - t0;
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(elapsed < 10_000, `cancel 有界（实测 ${elapsed}ms，stop 永不 resolve）`);
  await awaitStatus(spawner, job.id, 'cancelled');
  spawner.dispose();
});

runtimeTest('registerStoppable last registration wins (single slot, no double stop)', 'reslot', async (runtime) => {
  const calls = [];
  const { spawner, job } = await withHeldReporter(runtime, 'slot', async (ctx) => {
    ctx.registerStoppable(async () => { calls.push('first'); });
    ctx.registerStoppable(async () => { calls.push('second'); });
  });
  await spawner.cancel(job.id);
  assert.deepEqual(calls, ['second'], 'last registration wins，旧槽不再被 stop');
  await awaitStatus(spawner, job.id, 'cancelled');
  spawner.dispose();
});

runtimeTest('T-02 repeated cancel is idempotent and does not duplicate job.cancelled events', 'recancel', async (runtime) => {
  const seen = [];
  const { spawner, job } = await withHeldReporter(runtime, 'repeat', async () => {}, {
    onEvent: (event) => seen.push(event.type)
  });
  const first = await spawner.cancel(job.id);
  assert.equal(first.status, 'cancelled');
  const again = await spawner.cancel(job.id);
  assert.equal(again.status, 'cancelled', '重复取消幂等（返回当前终态）');
  await spawner.await(job.id, 10_000);
  assert.equal(seen.filter((type) => type === 'job.cancelled').length, 1, 'job.cancelled 事件不重复（MINOR 3 去重）');
  spawner.dispose();
});

runtimeTest('review-1 cancel after terminal succeeded emits no job.cancelled and keeps succeeded', 'terminal-cancel', async (runtime) => {
  const seen = [];
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 1,
    execute: async () => SUCCEEDED,
    onEvent: (event) => seen.push(event.type)
  });
  const job = spawner.spawn({ roleId: 'reporter', brief: 'done', businessDate: '2026-08-08' });
  await awaitStatus(spawner, job.id, 'succeeded');
  const after = await spawner.cancel(job.id);
  assert.equal(after.status, 'succeeded', '终态 succeeded 工单 cancel 不改状态');
  assert.equal(seen.filter((type) => type === 'job.cancelled').length, 0, '不误发 job.cancelled');
  spawner.dispose();
});

const unhandled = [];
const onUnhandled = (reason) => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);
runtimeTest('review-2 late-rejecting stopResource emits no unhandledRejection', 'late-reject', async (runtime) => {
  let lateRejected = false;
  const { spawner, job } = await withHeldReporter(runtime, 'late-reject', async (ctx) => {
    // stop 在 2s 有界窗口之后才 reject：迟到 rejection 必须被吞并，不得 unhandledRejection。
    ctx.registerStoppable(() => new Promise((_, reject) => {
      setTimeout(() => { lateRejected = true; reject(new Error('late boom')); }, 2300);
    }));
  });
  const cancelled = await spawner.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(lateRejected, false, 'cancel 在迟到 rejection 之前返回（未等待 stop 完成）');
  // 等到迟到 rejection 实际触发之后，确认被吞并、无 unhandledRejection。
  await sleep(600);
  assert.equal(lateRejected, true, '测试前提：迟到 rejection 确实发生');
  assert.deepEqual(unhandled, [], '迟到 rejection 被吞并，无 unhandledRejection');
  spawner.dispose();
}, () => process.removeListener('unhandledRejection', onUnhandled));

runtimeTest('T-12 WMB-5119 cancel after late failed outcome stays cancelled with exactly one job.cancelled event (no double terminal)', 'late-outcome', async (runtime) => {
  const seen = [];
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 1,
    execute: async ({ signal }) => {
      await onAbort(signal);
      // cancel 之后才到达的 late outcome：abort 优先，pool 终态必须仍 cancelled、不得改写。
      return { status: 'failed', code: 'LATE_FAIL', message: 'late failure after cancel', readback: null };
    },
    onEvent: (event) => seen.push(event.type)
  });
  const job = spawner.spawn({ roleId: 'writer', brief: 'late', projectId: 'project-1', businessDate: '2026-08-08' });
  await waitFor(() => spawner.getHandle(job.id)?.sessionFile);
  await spawner.cancel(job.id);
  const done = await awaitStatus(spawner, job.id, 'cancelled', 'cancel 后 late failed outcome 仍 cancelled（终态不被改写）');
  assert.equal(done.report?.code, 'JOB_CANCELLED');
  assert.equal(seen.filter((type) => type === 'job.cancelled').length, 1, 'job.cancelled 事件计数 =1（MINOR 3 去重）');
  assert.equal(seen.filter((type) => type === 'job.failed').length, 0, '不产生 job.failed 事件（双终态禁止）');
  assert.equal(employeeSnapshotCount(runtime), 0, 'lease 归零');
  spawner.dispose();
});
runtimeTest('WMB-5159 maxWorkers=0 freezes queued durable jobs until capacity resumes', 'capacity-zero', async (runtime) => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 5,
    execute: async ({ job }) => {
      if (job.brief === 'first' || job.brief.startsWith('hold-')) await firstGate;
      return SUCCEEDED;
    }
  });
  const first = spawner.spawn({ roleId: 'reporter', brief: 'first', businessDate: '2026-08-10' });
  const holds = [
    spawner.spawn({ roleId: 'planner', brief: 'hold-planner', businessDate: '2026-08-11' }),
    spawner.spawn({ roleId: 'writer', brief: 'hold-writer', projectId: 'p-capacity', businessDate: '2026-08-10' }),
    spawner.spawn({ roleId: 'reporter', brief: 'hold-reporter', channelIds: ['capacity'], businessDate: '2026-08-10' }),
    spawner.spawn({ roleId: 'librarian', brief: 'hold-librarian' })
  ];
  await waitFor(() => spawner.list().filter((job) => job.status === 'running').length === 5);
  const second = spawner.spawn({ roleId: 'librarian', brief: 'durable', scope: 'workspace' }, 'persistent-job');
  assert.equal(spawner.get(second.id).status, 'queued');
  spawner.setEnabled(false); releaseFirst();
  await awaitStatus(spawner, first.id, 'succeeded');
  await Promise.all(holds.map((job) => awaitStatus(spawner, job.id, 'succeeded')));
  await sleep(50);
  assert.equal(spawner.get(second.id).status, 'queued', 'capacity zero must not promote queued work');
  spawner.setMaxWorkers(1);
  assert.equal(spawner.getMaxWorkers(), 5, 'positive capacity settings retain the Reporter floor');
  await awaitStatus(spawner, second.id, 'succeeded');
  spawner.dispose();
});
