/**
 * 五智能体「真工作路径」验收 — 不是子系统绿，是角色能干什么。
 * 桌助 desk | 记者 reporter | 策划 planner | 写手 writer | 资料员 librarian
 *
 * 每条必须：任务启动 + 角色授权 + 席位不串 + 可观察推进。
 * 业务写入一律走 ActiveWorkspaceRuntime + dispatch*（禁止裸 SQL 绕过写护栏）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import {
  dispatchStartAgentTask,
  dispatchCancelAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchUpdateAgentTaskPhase
} from '../src/main/agent-task-commands.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import { deriveIntentForRole } from '../src/main/role-job-registry.ts';
import { ensureAutomaticTaskGrant, AUTOMATIC_TASK_GRANT_SCOPES } from '../src/main/task-grants.ts';
import { filterCommandsForRole, roleWriteCommands, ROLE_CATALOG } from '../src/shared/agent-capabilities.ts';
import { buildRoleRoster } from '../src/main/role-roster.ts';
import { decideDailyStartGate } from '../src/main/daily-start-gate.ts';
import { createContentProject } from '../src/main/content.ts';

const ROLES = /** @type {const} */ (['reporter', 'planner', 'writer', 'librarian']);

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', `ws-${path.basename(directory)}`, now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

function actor(lane = 'agent-work-path') {
  return { actor: { type: 'scheduler', id: lane, label: lane }, requestId: randomUUID() };
}

function withWs(runtime, refs = {}) {
  return { workspaceId: runtime.identity.workspaceId, ...refs };
}

async function startTask(runtime, input, workerLeaseId) {
  const contextRefs = withWs(runtime, input.contextRefs || {});
  return dispatchStartAgentTask(runtime, { ...input, contextRefs }, { ...actor('start'), workerLeaseId, taskId: undefined });
}

async function progress(runtime, taskId, body, workerLeaseId) {
  return dispatchReportAgentTaskProgress(runtime, taskId, body, { ...actor('progress'), taskId, workerLeaseId });
}

async function cancelTask(runtime, taskId, workerLeaseId) {
  return dispatchCancelAgentTask(runtime, taskId, { ...actor('cancel'), taskId, workerLeaseId });
}

async function grantCommands(runtime, taskId, roleId) {
  const grantId = await ensureAutomaticTaskGrant(runtime, taskId, new Date(), roleId);
  const row = runtime.database.prepare(
    'SELECT allowed_commands_json AS json FROM task_grants WHERE id = ?'
  ).get(grantId);
  return { grantId, commands: JSON.parse(row.json) };
}

test('0 catalog has five agents with rooms', () => {
  assert.deepEqual(Object.keys(ROLE_CATALOG).sort(), ['desk', 'librarian', 'planner', 'reporter', 'writer']);
  assert.equal(ROLE_CATALOG.desk.labelZh, '主管');
  assert.equal(ROLE_CATALOG.reporter.labelZh, '记者');
  assert.equal(ROLE_CATALOG.planner.labelZh, '策划');
  assert.equal(ROLE_CATALOG.writer.labelZh, '写手');
  assert.equal(ROLE_CATALOG.librarian.labelZh, '资料员');
});

test('1 desk: exclusive seat, page_today start/cancel, zero standing writes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-desk-'));
  const runtime = openRuntime(directory);
  try {
    assert.equal(roleWriteCommands('desk').length, 0);

    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    assert.equal(runtime.getWorkerSnapshot()?.purpose, 'desk');
    assert.throws(() => runtime.acquireWorkerLease(null, 'desk', 'desk'), /尚未释放|BUSY|lease/i);

    const emp = runtime.acquireWorkerLease(null, 'planner', 'employee');
    assert.equal(runtime.getWorkerSnapshot()?.purpose, 'desk');
    assert.notEqual(runtime.getWorkerSnapshot()?.leaseId, emp.leaseId);

    const started = await startTask(runtime, {
      intent: 'page_today',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'desk', page: 'today' }
    }, desk.leaseId);
    assert.equal(started.task.status, 'running');
    assert.equal(started.task.intent, 'page_today');
    runtime.bindWorkerTask(desk, started.task.id);

    const cancelled = await cancelTask(runtime, started.task.id, desk.leaseId);
    assert.equal(cancelled.status, 'cancelled');

    runtime.releaseWorker(emp);
    runtime.releaseWorker(desk);
    assert.equal(runtime.getWorkerSnapshot(), null);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('2 reporter: daily_scan grant collect-only, progress, not desk seat', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-rep-'));
  const runtime = openRuntime(directory);
  try {
    const lease = runtime.acquireWorkerLease(null, 'reporter', 'employee');
    const started = await startTask(runtime, {
      intent: 'daily_scan',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'reporter', planDate: '2026-08-08' }
    }, lease.leaseId);
    assert.equal(started.task.intent, 'daily_scan');
    runtime.bindWorkerTask(lease, started.task.id);

    const { commands } = await grantCommands(runtime, started.task.id, 'reporter');
    assert.ok(commands.includes('sources.upsert_batch'));
    assert.ok(commands.includes('agent_tasks.report_progress'));
    assert.equal(commands.includes('plans.save'), false);
    assert.equal(commands.includes('content.save_version'), false);

    await progress(runtime, started.task.id, {
      phase: 'scanning_sources',
      progress: { planned: 3, processed: 1, saved: 2, currentSource: 'AI前沿' },
      message: '扫描中'
    }, lease.leaseId);
    const task = getAgentTask(runtime.database, started.task.id);
    assert.equal(task.phase, 'scanning_sources');
    assert.equal(task.progress?.processed, 1);

    assert.equal(runtime.getWorkerSnapshot(), null);
    const roster = buildRoleRoster(runtime.database, {
      businessDate: '2026-08-08',
      workers: runtime.getWorkerSnapshots()
    });
    assert.equal(roster.find((r) => r.roleId === 'reporter')?.status, 'running');
    assert.notEqual(roster.find((r) => r.roleId === 'desk')?.status, 'running');

    await cancelTask(runtime, started.task.id, lease.leaseId);
    runtime.releaseWorker(lease);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('3 planner: handoff gate + daily_judge grant plans.save, not desk seat', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-pln-'));
  const runtime = openRuntime(directory);
  try {
    const scanLease = runtime.acquireWorkerLease(null, 'reporter', 'employee');
    const scan = await startTask(runtime, {
      intent: 'daily_scan',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'reporter' }
    }, scanLease.leaseId);
    runtime.bindWorkerTask(scanLease, scan.task.id);
    await progress(runtime, scan.task.id, {
      phase: 'channel_scanned',
      progress: { planned: 5, processed: 5, saved: 10 },
      message: '扫完'
    }, scanLease.leaseId);

    assert.equal(
      decideDailyStartGate({
        active: { status: 'running', phase: 'channel_scanned', intent: 'daily_scan' },
        hasLiveCoordinator: false
      }).action,
      'start_judge_only'
    );

    // 重绑 judge intent（经 dispatch update phase）
    const rebound = await dispatchUpdateAgentTaskPhase(
      runtime,
      scan.task.id,
      'channel_scanned',
      { intent: 'daily_judge', contextRefs: withWs(runtime, { roleId: 'planner', planDate: '2026-08-08' }) },
      { ...actor('rebind'), taskId: scan.task.id, workerLeaseId: scanLease.leaseId }
    );
    assert.equal(rebound.intent, 'daily_judge');
    runtime.releaseWorker(scanLease);

    const lease = runtime.acquireWorkerLease(scan.task.id, 'planner', 'employee');
    const { commands } = await grantCommands(runtime, scan.task.id, 'planner');
    assert.ok(commands.includes('plans.save'));
    assert.ok(commands.includes('sources.lane_gate'));
    assert.equal(commands.includes('content.save_version'), false);

    await progress(runtime, scan.task.id, {
      phase: 'judging_opportunities',
      message: '正在评估新资料并更新选题池'
    }, lease.leaseId);
    assert.equal(getAgentTask(runtime.database, scan.task.id).phase, 'judging_opportunities');

    assert.equal(runtime.getWorkerSnapshot(), null);
    const roster = buildRoleRoster(runtime.database, {
      businessDate: '2026-08-08',
      workers: runtime.getWorkerSnapshots()
    });
    const planner = roster.find((r) => r.roleId === 'planner');
    const desk = roster.find((r) => r.roleId === 'desk');
    assert.equal(planner?.status, 'running');
    assert.equal(planner?.intent, 'daily_judge');
    assert.notEqual(desk?.taskId, planner?.taskId);

    await cancelTask(runtime, scan.task.id, lease.leaseId);
    runtime.releaseWorker(lease);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('4 writer: studio_draft on project, grant write-only', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-wri-'));
  // fixture 在 runtime 写护栏之外预置项目
  const seedDb = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  seedDb.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', `ws-${path.basename(directory)}`, now, now);
  const projectId = createContentProject(seedDb, { title: '验收用草稿项目' }).id;
  seedDb.close();
  const runtime = ActiveWorkspaceRuntime.open(directory);
  try {
    assert.ok(projectId);

    const lease = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const started = await startTask(runtime, {
      intent: 'studio_draft',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'writer', projectId }
    }, lease.leaseId);
    assert.equal(started.task.intent, 'studio_draft');
    runtime.bindWorkerTask(lease, started.task.id);

    const { commands } = await grantCommands(runtime, started.task.id, 'writer');
    assert.ok(commands.includes('content.save_version'));
    assert.equal(commands.includes('plans.save'), false);
    assert.equal(commands.includes('sources.upsert_batch'), false);

    await progress(runtime, started.task.id, { phase: 'running_pi', message: '撰写初稿中' }, lease.leaseId);
    assert.equal(getAgentTask(runtime.database, started.task.id).phase, 'running_pi');

    const roster = buildRoleRoster(runtime.database, {
      businessDate: '2026-08-08',
      workers: runtime.getWorkerSnapshots()
    });
    assert.equal(roster.find((r) => r.roleId === 'writer')?.status, 'running');
    assert.notEqual(roster.find((r) => r.roleId === 'desk')?.status, 'running');

    await cancelTask(runtime, started.task.id, lease.leaseId);
    runtime.releaseWorker(lease);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('5 librarian: page_library + job spawn succeeded', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-lib-'));
  const runtime = openRuntime(directory);
  try {
    assert.ok(roleWriteCommands('librarian').length > 0);
    assert.equal(roleWriteCommands('librarian').includes('plans.save'), false);

    const lease = runtime.acquireWorkerLease(null, 'librarian', 'employee');
    const started = await startTask(runtime, {
      intent: 'page_library',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'librarian', page: 'library' }
    }, lease.leaseId);
    assert.equal(started.task.intent, 'page_library');
    runtime.bindWorkerTask(lease, started.task.id);

    let librarianRunning = started.task.status === 'running';
    try {
      const { commands } = await grantCommands(runtime, started.task.id, 'librarian');
      assert.equal(commands.includes('plans.save'), false);
      await progress(runtime, started.task.id, { phase: 'running_pi', message: '整理资料库' }, lease.leaseId);
      librarianRunning = true;
    } catch (error) {
      const msg = String(error.message || error);
      assert.match(msg, /TASK_SCOPE_EMPTY|无自动写权|无剩余写权|只读/);
      librarianRunning = getAgentTask(runtime.database, started.task.id)?.status === 'running';
    }

    const roster = buildRoleRoster(runtime.database, {
      businessDate: '2026-08-08',
      workers: runtime.getWorkerSnapshots()
    });
    if (librarianRunning) assert.equal(roster.find((r) => r.roleId === 'librarian')?.status, 'running');
    assert.notEqual(roster.find((r) => r.roleId === 'desk')?.status, 'running');

    await cancelTask(runtime, started.task.id, lease.leaseId);
    runtime.releaseWorker(lease);

    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async ({ job, lease, onTaskBound }) => {
        assert.equal(job.roleId, 'librarian');
        // WMB-5116：spawner 不再自建任务；执行器经 onTaskBound 回写 handle（A1 不变量）。
        const started = await dispatchStartAgentTask(runtime, {
          intent: 'page_library',
          businessDate: job.businessDate,
          contextRefs: { roleId: 'librarian', jobId: job.id, manager: 'desk', workspaceId: runtime.identity.workspaceId }
        }, { actor: { type: 'scheduler', id: 'test', label: 'test' }, requestId: `t:${job.id}:start` });
        runtime.bindWorkerTask(lease, started.task.id);
        onTaskBound?.(started.task.id, null);
        assert.equal(spawner.getHandle(job.id)?.taskId, started.task.id, 'taskId 经 onTaskBound 回写 handle');
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const job = spawner.spawn({
      roleId: 'librarian',
      brief: '验收：整理今日入库'
    });
    const done = await spawner.await(job.id, 15_000);
    assert.equal(done.status, 'succeeded', done.error);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('6 cross: employee never becomes deskSnapshot', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-x-'));
  const runtime = openRuntime(directory);
  try {
    const emp = runtime.acquireWorkerLease('task-fake', 'planner', 'employee');
    assert.equal(runtime.getWorkerSnapshot(), null);
    assert.equal(runtime.getWorkerSnapshots()[0].purpose, 'employee');
    runtime.releaseWorker(emp);
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    assert.equal(runtime.getWorkerSnapshot()?.purpose, 'desk');
    runtime.releaseWorker(desk);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('7 permission matrix foreign writes blocked', () => {
  const daily = [...AUTOMATIC_TASK_GRANT_SCOPES.daily_intelligence];
  const reporter = filterCommandsForRole('reporter', daily);
  const planner = filterCommandsForRole('planner', daily);
  const writer = filterCommandsForRole('writer', daily);
  assert.ok(reporter.includes('sources.upsert_batch'));
  assert.equal(reporter.includes('plans.save'), false);
  assert.ok(planner.includes('plans.save'));
  assert.equal(writer.includes('plans.save'), false);
  assert.equal(roleWriteCommands('desk').length, 0);
});

test('8 all four employees spawn to terminal via JobSpawner', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-all-'));
  const runtime = openRuntime(directory);
  try {
    const seen = new Set();
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 4,
      execute: async ({ job, lease, onTaskBound }) => {
        seen.add(job.roleId);
        // WMB-5116：任务由执行器创建，taskId 经 onTaskBound 回写 handle；intent 由注册表派生。
        const started = await dispatchStartAgentTask(runtime, {
          intent: deriveIntentForRole(job.roleId),
          businessDate: job.businessDate,
          contextRefs: { roleId: job.roleId, jobId: job.id, manager: 'desk', workspaceId: runtime.identity.workspaceId }
        }, { actor: { type: 'scheduler', id: 'test', label: 'test' }, requestId: `t:${job.id}:start` });
        runtime.bindWorkerTask(lease, started.task.id);
        onTaskBound?.(started.task.id, null);
        assert.equal(lease.roleId, job.roleId);
        assert.equal(spawner.getHandle(job.id)?.taskId, started.task.id);
        // employee 席
        const snaps = runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee');
        assert.ok(snaps.some((s) => s.leaseId === lease.leaseId));
        assert.equal(runtime.getWorkerSnapshot()?.purpose === 'employee', false);
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    const jobs = ROLES.map((roleId, i) =>
      spawner.spawn(
        roleId === 'writer'
          ? { roleId, brief: `验收-${roleId}`, businessDate: `2026-10-0${i + 1}`, projectId: `proj-${i}` }
          : roleId === 'librarian'
            ? { roleId, brief: `验收-${roleId}` }
            : { roleId, brief: `验收-${roleId}`, businessDate: `2026-10-0${i + 1}` }
      )
    );
    const done = await Promise.all(jobs.map((j) => spawner.await(j.id, 20_000)));
    assert.ok(done.every((d) => d.status === 'succeeded'), done.map((d) => `${d.status}:${d.error}`).join(' | '));
    assert.deepEqual([...seen].sort(), [...ROLES].sort());
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});


test('9 getLatestDailyIntelligenceTask prefers succeeded over later cancelled', async () => {
  const { getLatestDailyIntelligenceTask } = await import('../src/main/agent-tasks.ts');
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-latest-'));
  const dbPath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(dbPath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-latest', now, now);
  try {
    // insert two tasks via raw SQL to control updated_at order
    database.prepare(`INSERT INTO agent_tasks (
      id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
      progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
      created_at, updated_at, finished_at
    ) VALUES (?,?,?,?,?,null,'{}','{}','{}','{}','[]',null,null,null,null,?,?,?)`).run(
      'ok-task', 'daily_judge', '2026-08-08', 'succeeded', 'completed',
      '2026-08-07T19:40:00.000Z', '2026-08-07T19:40:00.000Z', '2026-08-07T19:40:00.000Z'
    );
    database.prepare(`INSERT INTO agent_tasks (
      id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
      progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
      created_at, updated_at, finished_at
    ) VALUES (?,?,?,?,?,null,'{}','{}','{}','{}','[]',null,null,'CANCELLED','用户取消',?,?,?)`).run(
      'cancel-task', 'daily_judge', '2026-08-08', 'cancelled', 'cancelled',
      '2026-08-07T19:44:00.000Z', '2026-08-07T19:44:00.000Z', '2026-08-07T19:44:00.000Z'
    );
    const latest = getLatestDailyIntelligenceTask(database, '2026-08-08');
    assert.equal(latest?.id, 'ok-task');
    assert.equal(latest?.status, 'succeeded');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
