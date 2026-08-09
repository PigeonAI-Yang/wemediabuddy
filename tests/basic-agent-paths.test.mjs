/**
 * 所有智能体「基本工作」路径验收 — 不许用子系统绿代替主路径。
 * 覆盖：desk/employee 占座、今日扫判门闩、工单派/取/取消、页任务生命周期、孤儿收尸。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import { decideDailyStartGate } from '../src/main/daily-start-gate.ts';
import { isOrphanChannelScannedTask } from '../src/main/daily-control-policy.ts';
import {
  startAgentTask,
  cancelAgentTask,
  completeAgentTask,
  failAgentTask,
  getAgentTask,
  updateAgentTaskPhase,
  reportAgentTaskProgress
} from '../src/main/agent-tasks.ts';
import { filterCommandsForRole, roleWriteCommands } from '../src/shared/agent-capabilities.ts';
import { AUTOMATIC_TASK_GRANT_SCOPES } from '../src/main/task-grants.ts';

const ROLES = ['reporter', 'planner', 'writer', 'librarian'];

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-basic-agent', now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

// ---------- A. 今日扫判门闩（基本中的基本）----------

test('A1 daily gate: live coordinator returns active', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'scanning_sources', intent: 'daily_scan' },
    hasLiveCoordinator: true
  });
  assert.equal(d.action, 'return_active');
});

test('A2 daily gate: channel_scanned without coordinator starts judge only', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'channel_scanned', intent: 'daily_scan' },
    hasLiveCoordinator: false
  });
  assert.equal(d.action, 'start_judge_only');
});

test('A3 daily gate: no active starts full', () => {
  assert.equal(decideDailyStartGate({ active: null, hasLiveCoordinator: false }).action, 'start_full');
});

test('A3b daily gate: terminal partial continues as judge only', () => {
  assert.equal(
    decideDailyStartGate({
      active: null,
      latest: { status: 'partial', phase: 'partial', intent: 'daily_scan', savedCount: 100 },
      hasLiveCoordinator: false
    }).action,
    'start_judge_only'
  );
});

test('A4 daily gate: resume_pending starts full', () => {
  assert.equal(
    decideDailyStartGate({
      active: { status: 'running', phase: 'resume_pending', intent: 'daily_intelligence' },
      hasLiveCoordinator: false
    }).action,
    'start_full'
  );
});

test('A5 daily gate: judging without coordinator restarts judge only (no double judge, no re-scan)', () => {
  assert.equal(
    decideDailyStartGate({
      active: { status: 'running', phase: 'judging_opportunities', intent: 'daily_judge' },
      hasLiveCoordinator: false
    }).action,
    'start_judge_only'
  );
});

test('A6 orphan channel_scanned after 3min', () => {
  const now = Date.parse('2026-08-07T12:30:00.000Z');
  assert.equal(
    isOrphanChannelScannedTask({
      status: 'running',
      phase: 'channel_scanned',
      intent: 'daily_scan',
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:20:00.000Z',
      progress: { lastActivityAt: '2026-08-07T12:20:00.000Z' }
    }, now),
    true
  );
});

// ---------- B. Desk / employee 占座（对话 vs 干活）----------

test('B1 desk and employee leases coexist', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-b1-'));
  const runtime = openRuntime(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const emp = runtime.acquireWorkerLease(null, 'reporter', 'employee');
    runtime.bindWorker(desk, { stop: async () => {} });
    runtime.bindWorker(emp, { stop: async () => {} });
    const snaps = runtime.getWorkerSnapshots();
    assert.equal(snaps.filter((s) => s.purpose === 'desk').length, 1);
    assert.equal(snaps.filter((s) => s.purpose === 'employee').length, 1);
    runtime.releaseWorker(emp);
    runtime.releaseWorker(desk);
  } finally {
    void runtime.stop({ drain: false });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('B2 second desk rejected while first held', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-b2-'));
  const runtime = openRuntime(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    runtime.bindWorker(desk, { stop: async () => {} });
    assert.throws(() => runtime.acquireWorkerLease(null, 'desk', 'desk'), /尚未释放|BUSY/);
    runtime.releaseWorker(desk);
  } finally {
    void runtime.stop({ drain: false });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('B3 withRuntimeWorker source uses employee not desk', () => {
  const src = path.join(process.cwd(), 'src/main/index.ts');
  const text = readFileSync(src, 'utf8');
  const start = text.indexOf('async function withRuntimeWorker');
  assert.ok(start >= 0);
  const endMarker = 'async function ensurePi';
  const end = text.indexOf(endMarker, start);
  const body = text.slice(start, end > start ? end : start + 2500);
  assert.match(body, /acquireWorkerLease\([\s\S]*?'employee'\)/);
  assert.doesNotMatch(body, /acquireWorkerLease\([\s\S]*?'desk'\)/);
});


// ---------- C. 角色任务生命周期（page / runner intents）----------

test('C1 start/complete page_today desk task', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-c1-'));
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-c1', now, now);
  try {
    const started = startAgentTask(database, {
      intent: 'page_today',
      businessDate: '2026-08-07',
      contextRefs: { roleId: 'desk', page: 'today' }
    });
    assert.equal(started.ok, true);
    const task = started.data;
    assert.equal(task.status, 'running');
    updateAgentTaskPhase(database, task.id, 'working', {});
    const done = completeAgentTask(database, task.id);
    assert.equal(done.ok, true);
    assert.equal(getAgentTask(database, task.id).status, 'succeeded');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('C2 cancel daily_scan running task', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-c2-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-c2', now, now);
  try {
    const started = startAgentTask(database, {
      intent: 'daily_scan',
      businessDate: '2026-08-07',
      contextRefs: { roleId: 'reporter' }
    });
    assert.equal(started.ok, true);
    const cancelled = cancelAgentTask(database, started.data.id);
    assert.equal(cancelled.ok, true);
    assert.equal(getAgentTask(database, started.data.id).status, 'cancelled');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('C3 fail studio_draft with message', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-c3-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-c3', now, now);
  try {
    const started = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: '2026-08-07',
      contextRefs: { roleId: 'writer', projectId: 'p1' }
    });
    const failed = failAgentTask(database, started.data.id, 'TEST', 'draft failed');
    assert.equal(failed.ok, true);
    assert.equal(getAgentTask(database, started.data.id).status, 'failed');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('C4 results_review intent can start', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-c4-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-c4', now, now);
  try {
    const started = startAgentTask(database, {
      intent: 'results_review',
      businessDate: '2026-08-07',
      contextRefs: { roleId: 'planner', publicationId: 'pub1' }
    });
    assert.equal(started.ok, true);
    assert.equal(started.data.intent, 'results_review');
    completeAgentTask(database, started.data.id);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------- D. 员工工单基本工作 ----------

test('D1 spawn employee job succeeds with session path', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-d1-'));
  const runtime = openRuntime(directory);
  try {
    let sessionFile = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        sessionFile = ctx.sessionFile;
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const job = spawner.spawn({
      roleId: 'reporter',
      brief: '基本工作：扫一眼源',
      businessDate: '2026-08-11'
    });
    const done = await spawner.await(job.id, 10_000);
    assert.equal(done.status, 'succeeded', done.error);
    assert.ok(sessionFile && sessionFile.includes('job-') && sessionFile.endsWith('.jsonl'));
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('D2 all four employee roles can be spawned', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-d2-'));
  const runtime = openRuntime(directory);
  try {
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async () => ({ status: 'succeeded', code: 'OK', message: null, readback: null })
    });
    const jobs = ROLES.map((roleId, i) =>
      spawner.spawn(
        roleId === 'writer'
          ? { roleId, brief: `role-${roleId}`, businessDate: `2026-09-0${i + 1}`, projectId: `proj-${i}` }
          : roleId === 'librarian'
            ? { roleId, brief: `role-${roleId}` }
            : { roleId, brief: `role-${roleId}`, businessDate: `2026-09-0${i + 1}` }
      )
    );
    const done = await Promise.all(jobs.map((j) => spawner.await(j.id, 15_000)));
    assert.ok(done.every((d) => d.status === 'succeeded'), done.map((d) => d.status + d.error).join(','));
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('D3 cancel job releases employee lease', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-d3-'));
  const runtime = openRuntime(directory);
  try {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async ({ signal }) => {
        await Promise.race([
          gate,
          new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
        ]).catch(() => {});
        return signal.aborted
          ? { status: 'cancelled', code: 'JOB_CANCELLED', message: null, readback: null }
          : { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const job = spawner.spawn({
      roleId: 'writer',
      brief: 'long',
      projectId: 'px',
      businessDate: '2026-08-12'
    });
    await new Promise((r) => setTimeout(r, 40));
    await spawner.cancel(job.id);
    release();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length, 0);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------- E. 权限基本形状（角色干不了越权活）----------

test('E1 writer cannot save plans; planner can', () => {
  const union = [...AUTOMATIC_TASK_GRANT_SCOPES.daily_intelligence];
  const writer = filterCommandsForRole('writer', union);
  const planner = filterCommandsForRole('planner', union);
  assert.equal(writer.includes('plans.save'), false);
  assert.ok(planner.includes('plans.save'));
});

test('E2 reporter collect only from daily union', () => {
  const union = [...AUTOMATIC_TASK_GRANT_SCOPES.daily_intelligence];
  const reporter = filterCommandsForRole('reporter', union);
  assert.ok(reporter.includes('sources.upsert_batch'));
  assert.equal(reporter.includes('plans.save'), false);
});

test('E3 each employee role has standing write commands', () => {
  for (const role of ROLES) {
    assert.ok(roleWriteCommands(role).length > 0, role);
  }
  assert.equal(roleWriteCommands('desk').length, 0);
});

// ---------- F. 进度/心跳基本可写 ----------

test('F1 report progress on running task', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-f1-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-f1', now, now);
  try {
    const started = startAgentTask(database, {
      intent: 'daily_scan',
      businessDate: '2026-08-07',
      contextRefs: { roleId: 'reporter' }
    });
    const reported = reportAgentTaskProgress(database, started.data.id, {
      phase: 'scanning_sources',
      progress: { planned: 5, processed: 2, currentSource: 'AI前沿' },
      message: '扫描中'
    });
    assert.equal(reported.ok, true);
    const task = getAgentTask(database, started.data.id);
    assert.equal(task.phase, 'scanning_sources');
    assert.equal(task.progress?.processed, 2);
    cancelAgentTask(database, task.id);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
