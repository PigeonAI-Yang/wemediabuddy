import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobPool, DEFAULT_MAX_WORKERS } from '../src/main/job-pool.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';

const ROLES = ['reporter', 'planner', 'writer', 'librarian'];

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-stress', now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

function uniqueDates(n, prefix = '2026-07') {
  // produce distinct planDate strings
  return Array.from({ length: n }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(7 + Math.floor(i / 28)).padStart(2, '0');
    return `2026-${month}-${day}-${i}`; // planDate used as lock key material — include i for uniqueness
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- JobPool pure boundaries ----------

test('boundary: maxWorkers domain 0..7 — negative/float rejected; 0 = dispatch disabled (submit refuses)', () => {
  assert.throws(() => new JobPool(-1), /maxWorkers/);
  assert.throws(() => new JobPool(1.5), /maxWorkers/);
  // WMB-5142：maxWorkers 合法域 0..7；0=停用派工（submit 拒绝，不建工单）。
  const zero = new JobPool(0);
  assert.throws(() => zero.submit({ roleId: 'reporter', brief: 'a', businessDate: '2026-08-09' }), (error) => {
    assert.equal(error.code, 'JOB_SPAWN_DISABLED');
    return true;
  });
  const p = new JobPool(2);
  p.setMaxWorkers(0);
  assert.equal(p.getMaxWorkers(), 0, '0 为合法容量（停用派工）');
  assert.throws(() => p.submit({ roleId: 'reporter', brief: 'a', businessDate: '2026-08-09' }), /JOB_SPAWN_DISABLED/);
});

test('boundary: maxWorkers=1 serializes completely', () => {
  const pool = new JobPool(1);
  const a = pool.submit({ roleId: 'reporter', brief: 'a', planDate: 'd1' });
  const b = pool.submit({ roleId: 'writer', brief: 'b', projectId: 'p1' });
  const c = pool.submit({ roleId: 'planner', brief: 'c', planDate: 'd2' });
  assert.equal(pool.get(a.id).status, 'running');
  assert.equal(pool.get(b.id).status, 'queued');
  assert.equal(pool.get(c.id).status, 'queued');
  pool.complete(a.id);
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.get(c.id).status, 'queued');
  pool.fail(b.id, 'x');
  assert.equal(pool.get(c.id).status, 'running');
  pool.cancel(c.id);
  assert.equal(pool.get(c.id).status, 'cancelled');
  assert.equal(pool.activeEmployeeCount(), 0);
});

test('boundary: empty brief / desk / unknown role rejected', () => {
  const pool = new JobPool(2);
  assert.throws(() => pool.submit({ roleId: 'reporter', brief: '  ' }), /brief/);
  assert.throws(() => pool.submit({ roleId: 'desk', brief: 'x' }), /员工|desk/i);
  assert.throws(() => pool.submit({ roleId: 'intern', brief: 'x' }), /员工|desk/i);
});

test('boundary: cancel is idempotent on terminal', () => {
  const pool = new JobPool(2);
  const j = pool.submit({ roleId: 'reporter', brief: 'once', planDate: 'd' });
  pool.complete(j.id);
  const again = pool.cancel(j.id);
  assert.equal(again.status, 'succeeded'); // already terminal — cancel returns terminal record
  assert.equal(pool.get(j.id).status, 'succeeded');
});

test('boundary: shrink maxWorkers does not kill running, only blocks new promote', () => {
  const pool = new JobPool(3);
  const jobs = [0, 1, 2].map((i) => pool.submit({ roleId: ROLES[i], brief: `r${i}`, planDate: `s${i}` }));
  assert.equal(pool.activeEmployeeCount(), 3);
  pool.setMaxWorkers(1);
  const extra = pool.submit({ roleId: 'librarian', brief: 'late', planDate: 's9' });
  assert.equal(pool.get(extra.id).status, 'queued');
  // running still 3 until they finish
  assert.equal(pool.activeEmployeeCount(), 3);
  for (const j of jobs) pool.complete(j.id);
  // only one promote under max=1
  assert.equal(pool.get(extra.id).status, 'running');
  assert.equal(pool.activeEmployeeCount(), 1);
});

test('stress: 200 jobs FIFO drain at maxWorkers=4', () => {
  const N = 200;
  const pool = new JobPool(4);
  const ids = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const job = pool.submit({
      roleId: ROLES[i % 4],
      brief: `job-${i}`,
      planDate: `p-${i}`,
      businessDate: `b-${i}`
    });
    ids.push(job.id);
  }
  assert.equal(pool.list().filter((j) => j.status === 'running').length, 4);
  assert.equal(pool.list().filter((j) => j.status === 'queued').length, N - 4);

  let completed = 0;
  while (completed < N) {
    const running = pool.list().filter((j) => j.status === 'running');
    assert.ok(running.length <= 4);
    for (const j of running) {
      pool.complete(j.id);
      completed += 1;
    }
  }
  const ms = performance.now() - t0;
  assert.equal(pool.activeEmployeeCount(), 0);
  assert.equal(pool.list().filter((j) => j.status === 'succeeded').length, N);
  assert.ok(ms < 2000, `200 job drain took ${ms}ms`);
  console.log(`  [stress] 200 FIFO drain max4: ${ms.toFixed(1)}ms`);
});

test('stress: alternating cancel/complete under churn', () => {
  const pool = new JobPool(3);
  const N = 100;
  const outcomes = { succeeded: 0, cancelled: 0 };
  for (let i = 0; i < N; i++) {
    pool.submit({ roleId: ROLES[i % 4], brief: `c${i}`, projectId: `proj-${i}` });
  }
  while (pool.activeEmployeeCount() > 0 || pool.list().some((j) => j.status === 'queued')) {
    const running = pool.list().filter((j) => j.status === 'running');
    for (const j of running) {
      if (Math.random() < 0.4) {
        pool.cancel(j.id);
        outcomes.cancelled += 1;
      } else {
        pool.complete(j.id);
        outcomes.succeeded += 1;
      }
    }
  }
  const terminal = pool.list().filter((j) => j.status === 'succeeded' || j.status === 'cancelled');
  assert.equal(terminal.length, N);
  assert.equal(pool.activeEmployeeCount(), 0);
  console.log('  [stress] churn', outcomes);
});

test('stress: entity lock matrix no double-hold (role locks, no shared planDate lock)', () => {
  const pool = new JobPool(7);
  const a = pool.submit({ roleId: 'planner', brief: 'A', resourceLocks: ['plan:ws:same-day'] });
  const b = pool.submit({ roleId: 'planner', brief: 'B', resourceLocks: ['plan:ws:same-day'] });
  const c = pool.submit({ roleId: 'reporter', brief: 'C', resourceLocks: ['scan:ws:same-day:all'] });
  // all running (pool slots) but locks must conflict only on the same role key
  assert.equal(pool.get(a.id).status, 'running');
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.get(c.id).status, 'running');
  const lockA = pool.acquireEntityLocks(a.id);
  assert.equal(lockA.ok, true);
  const lockB = pool.acquireEntityLocks(b.id);
  assert.equal(lockB.ok, false);
  assert.equal(lockB.code, 'JOB_LOCK_CONFLICT');
  // WMB-5116: reporter 与 planner 不再共享 planDate 锁（E4 修复）——不同角色键并发。
  const lockC = pool.acquireEntityLocks(c.id);
  assert.equal(lockC.ok, true);
  pool.complete(a.id);
  // after A done, B can take lock
  const lockB2 = pool.acquireEntityLocks(b.id);
  // b still running
  assert.equal(lockB2.ok, true);
});

// ---------- Spawner + runtime pressure ----------

test('stress: spawner maxWorkers=7 completes 24 jobs', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-stress-8-'));
  const runtime = openRuntime(directory);
  try {
    const N = 24;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 7,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const t0 = performance.now();
    const jobs = [];
    for (let i = 0; i < N; i++) {
      const roleId = ROLES[i % 4];
      const date = `2026-08-${String((i % 28) + 1).padStart(2, '0')}`;
      jobs.push(spawner.spawn(
        roleId === 'writer'
          ? { roleId, brief: `batch-${i}`, businessDate: date, projectId: `proj-${i}` }
          : roleId === 'librarian'
            ? { roleId, brief: `batch-${i}` }
            : { roleId, brief: `batch-${i}`, businessDate: date }
      ));
    }
    await new Promise((r) => setTimeout(r, 30));
    const peakRunning = spawner.list().filter((j) => j.status === 'running').length;
    assert.ok(peakRunning <= 7, `peak running ${peakRunning}`);
    assert.ok(peakRunning >= 1);

    const done = await Promise.all(jobs.map((j) => spawner.await(j.id, 30_000)));
    const ms = performance.now() - t0;
    assert.ok(done.every((d) => d.status === 'succeeded'), done.map((d) => d.status + ':' + d.error).join(','));
    assert.equal(runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length, 0);
    console.log(`  [stress] 24 jobs max8: ${ms.toFixed(0)}ms peakRunning<=7 (saw ${peakRunning})`);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boundary: lease soft cap rejects excess concurrent employees', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-stress-cap-'));
  const runtime = openRuntime(directory);
  try {
    // Hold many employee leases directly until soft cap
    const held = [];
    let hitCap = false;
    for (let i = 0; i < 20; i++) {
      try {
        const lease = runtime.acquireWorkerLease(null, 'reporter', 'employee');
        runtime.bindWorker(lease, { stop: async () => {} });
        held.push(lease);
      } catch (error) {
        assert.match(String(error.message || error), /软上限|WORKSPACE_BUSY|数量/);
        hitCap = true;
        break;
      }
    }
    assert.equal(hitCap, true);
    assert.ok(held.length >= 1 && held.length < 20);
    console.log(`  [boundary] lease soft cap at ${held.length}`);
    for (const lease of held) runtime.releaseWorker(lease);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stress: concurrent cancel during execute', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-stress-cancel-'));
  const runtime = openRuntime(directory);
  try {
    const started = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async ({ job, signal }) => {
        started.push(job.id);
        await new Promise((r) => setTimeout(r, 80));
        if (signal.aborted) return { status: 'cancelled', code: 'JOB_CANCELLED', message: null, readback: null };
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const jobs = [0, 1, 2, 3, 4, 5].map((i) => {
      const roleId = ROLES[i % 4];
      return spawner.spawn(
        roleId === 'writer'
          ? { roleId, brief: `cx-${i}`, projectId: `cx-proj-${i}`, businessDate: `2026-09-0${i + 1}` }
          : roleId === 'librarian'
            ? { roleId, brief: `cx-${i}` }
            : { roleId, brief: `cx-${i}`, businessDate: `2026-09-0${i + 1}` }
      );
    });
    await new Promise((r) => setTimeout(r, 20));
    // cancel half
    await Promise.all([jobs[0], jobs[1], jobs[2]].map((j) => spawner.cancel(j.id)));
    const rest = await Promise.all(jobs.slice(3).map((j) => spawner.await(j.id, 10_000)));
    const cancelled = jobs.slice(0, 3).map((j) => spawner.get(j.id)?.status);
    assert.ok(cancelled.every((s) => s === 'cancelled' || s === 'succeeded' || s === 'failed'));
    assert.ok(rest.every((d) => d.status === 'succeeded' || d.status === 'cancelled' || d.status === 'failed'));
    // no leaked employee leases
    assert.equal(runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length, 0);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stress: same-day lock storm — conflicts park as waiting_resource, FIFO promotes after release', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-stress-lockstorm-'));
  const runtime = openRuntime(directory);
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async ({ job }) => {
        if (job.brief === 'holder') await gate;
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const holder = spawner.spawn({ roleId: 'planner', brief: 'holder', businessDate: '2026-08-15' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(spawner.get(holder.id).status, 'running');

    // WMB-5116: 锁冲突不再在 spawn 抛 JOB_LOCK_CONFLICT——同 plan 键工单泊车 waiting_resource。
    const storms = [];
    for (let i = 0; i < 10; i++) {
      storms.push(spawner.spawn({ roleId: 'planner', brief: `storm-${i}`, businessDate: '2026-08-15' }));
    }
    await new Promise((r) => setTimeout(r, 40));
    const waitingCount = spawner.list().filter((j) => j.status === 'waiting_resource').length;
    assert.ok(waitingCount >= 1, `expected parked storm jobs, saw ${waitingCount}`);
    assert.ok(!spawner.list().some((j) => j.status === 'failed'), '锁冲突不落失败');
    release();
    const done = await Promise.all(storms.map((j) => spawner.await(j.id, 15_000)));
    assert.ok(done.every((d) => d.status === 'succeeded'), '资源释放后全部 FIFO 晋升成功');
    await spawner.await(holder.id, 10_000);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boundary: desk + max employees snapshots stable under load', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-stress-desk-'));
  const runtime = openRuntime(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    runtime.bindWorker(desk, { stop: async () => {} });
    assert.throws(() => runtime.acquireWorkerLease(null, 'desk', 'desk'), /lease|BUSY|释放/);

    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const jobs = Array.from({ length: 8 }, (_, i) => {
      const roleId = ROLES[i % 4];
      return spawner.spawn(
        roleId === 'writer'
          ? { roleId, brief: `d-${i}`, projectId: `desk-proj-${i}`, businessDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}` }
          : roleId === 'librarian'
            ? { roleId, brief: `d-${i}` }
            : { roleId, brief: `d-${i}`, businessDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}` }
      );
    });
    await new Promise((r) => setTimeout(r, 15));
    const snaps = runtime.getWorkerSnapshots();
    assert.equal(snaps.filter((s) => s.purpose === 'desk').length, 1);
    assert.ok(snaps.filter((s) => s.purpose === 'employee').length <= 4);
    // desk accessors still desk-scoped
    assert.equal(runtime.getWorkerLease()?.leaseId, desk.leaseId);

    await Promise.all(jobs.map((j) => spawner.await(j.id, 15_000)));
    runtime.releaseWorker(desk);
    assert.equal(runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length, 0);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('meta: default remains 2 unless overridden', () => {
  assert.equal(DEFAULT_MAX_WORKERS, 2);
  const pool = new JobPool();
  const a = pool.submit({ roleId: 'reporter', brief: '1', planDate: 'm1' });
  const b = pool.submit({ roleId: 'writer', brief: '2', projectId: 'm2' });
  const c = pool.submit({ roleId: 'planner', brief: '3', planDate: 'm3' });
  assert.equal(pool.get(a.id).status, 'running');
  assert.equal(pool.get(b.id).status, 'running');
  assert.equal(pool.get(c.id).status, 'queued');
});



test('fix: maxWorkers cannot exceed employee soft cap', () => {
  assert.throws(() => new JobPool(99), /软上限|maxWorkers/);
  assert.throws(() => {
    const p = new JobPool(2);
    p.setMaxWorkers(99);
  }, /软上限|maxWorkers/);
  const p = new JobPool(7);
  assert.equal(p.getMaxWorkers(), 7);
});

test('fix: lease soft-cap parks job as waiting_resource; rescan promotes (no fail, no hang)', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-slotbusy-'));
  const runtime = openRuntime(directory);
  try {
    const held = [];
    for (let i = 0; i < 20; i++) {
      try {
        const purpose = i === 0 ? 'desk' : 'employee';
        const lease = runtime.acquireWorkerLease(null, purpose === 'desk' ? 'desk' : 'reporter', purpose);
        runtime.bindWorker(lease, { stop: async () => {} });
        held.push(lease);
      } catch { break; }
    }
    assert.equal(held.length, 8);
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async () => ({ status: 'succeeded', code: 'OK', message: null, readback: null })
    });
    const job = spawner.spawn({ roleId: 'writer', brief: 'busy', projectId: 'pb', businessDate: '2026-12-02' });
    for (let i = 0; i < 100; i++) {
      if (spawner.get(job.id)?.status === 'waiting_resource') break;
      await sleep(10);
    }
    const waiting = spawner.get(job.id);
    assert.equal(waiting.status, 'waiting_resource', 'lease 忙不再 fail 工单');
    assert.match(waiting.waitReason, /RESOURCE_LEASE_BUSY/);
    // 释放一个 lease 后看门狗重扫 → 自动晋升成功
    runtime.releaseWorker(held.pop());
    spawner.pool.rescan();
    const done = await spawner.await(job.id, 5_000);
    assert.equal(done.status, 'succeeded');
    for (const lease of held) { try { runtime.releaseWorker(lease); } catch { /* */ } }
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fix: pool.park parks job as waiting_resource; rescan promotes', () => {
  const pool = new JobPool(2);
  const a = pool.submit({ roleId: 'reporter', brief: 'a', resourceLocks: ['scan:ws:rq-a:all'] });
  const b = pool.submit({ roleId: 'writer', brief: 'b', resourceLocks: ['project:ws:rq-b'] });
  assert.equal(pool.get(a.id).status, 'running');
  // lease 忙：park 后不占槽、不原地再拉起（不再 requeue + setTimeout 黑客）
  pool.park(a.id, 'RESOURCE_LEASE_BUSY', 'busy');
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  // b still running; a parked 不占槽
  assert.equal(pool.activeEmployeeCount(), 1);
  assert.equal(pool.get(a.id).status, 'waiting_resource');
  // 资源释放事件（看门狗）重扫晋升
  pool.rescan();
  assert.equal(pool.get(a.id).status, 'running');
  pool.complete(a.id);
  pool.complete(b.id);
});
