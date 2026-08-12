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
  dispatchCompleteAgentTask,
  dispatchReportAgentTaskProgress,
  dispatchUpdateAgentTaskPhase
} from '../src/main/agent-task-commands.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import { deriveIntentForRole } from '../src/main/role-job-registry.ts';
import {
  AUTOMATIC_TASK_GRANT_SCOPES,
  dispatchIssueTaskGrant,
  ensureAutomaticTaskGrant,
  getTaskGrant,
  listTaskGrants
} from '../src/main/task-grants.ts';
import { deskStandingCommands, filterCommandsForRole, roleWriteCommands, ROLE_CATALOG } from '../src/shared/agent-capabilities.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { buildRoleRoster } from '../src/main/role-roster.ts';
import { decideDailyStartGate } from '../src/main/daily-start-gate.ts';
import { createContentProject } from '../src/main/content.ts';
import { dispatchConfirmIntelligenceChannelProposalSafe } from '../src/main/intelligence-channel-command.ts';
import { readChannelProposalContext } from '../src/main/intelligence-channel-confirmation.ts';
import { IntelligenceChannelProposalStore, channelProposalBinding } from '../src/main/intelligence-channel-proposals.ts';
import { readIntelligenceChannelsSummary } from '../src/main/intelligence-channels.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { readManagerProjection, syncManagerTaskFromLegacyChild, updateManagerTaskCheckpoint } from '../src/main/manager-dispatch.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { dispatchBusinessCommand } from '../src/main/business-command.ts';

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

test('1 desk: exclusive seat, page_today start/cancel, full standing grant (A5)', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-desk-'));
  const runtime = openRuntime(directory);
  try {
    assert.deepEqual([...roleWriteCommands('desk')].sort(), deskStandingCommands(), 'desk standing = full internal set');

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

    // 主管签发基底 = standing 全量：页收窄不再截断（page_today 页 scope 不含 approve/review，standing 含）。
    const { commands } = await grantCommands(runtime, started.task.id, 'desk');
    assert.deepEqual([...commands].sort(), deskStandingCommands(), 'desk page grant covers full standing');
    assert.ok(commands.includes('plans.save'));
    assert.ok(commands.includes('knowledge.topic_maintenance_approve'));

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
  assert.deepEqual([...roleWriteCommands('desk')].sort(), deskStandingCommands(), 'desk standing full while employees stay page∩role');
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

test('10 A2 supervisor cross-page full grant; employee publish page stays readonly', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-a2-'));
  const runtime = openRuntime(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    // 发布页（writeScope=null）：主管跳过只读分支，签发全量 standing grant。
    const published = await startTask(runtime, {
      intent: 'page_publish',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'desk', page: 'publish' }
    }, desk.leaseId);
    assert.equal(published.task.status, 'running');
    runtime.bindWorkerTask(desk, published.task.id);
    const { commands } = await grantCommands(runtime, published.task.id, 'desk');
    assert.deepEqual([...commands].sort(), deskStandingCommands(), 'publish page desk grant = full standing');
    await cancelTask(runtime, published.task.id, desk.leaseId);
    runtime.releaseWorker(desk);

    // 智能体页（agents）对主管同样签发全量（页 scope 不含 plans.save，standing 含）。
    const desk2 = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const agents = await startTask(runtime, {
      intent: 'page_agents',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'desk', page: 'agents' }
    }, desk2.leaseId);
    runtime.bindWorkerTask(desk2, agents.task.id);
    const agentsGrant = await grantCommands(runtime, agents.task.id, 'desk');
    assert.ok(agentsGrant.commands.includes('plans.save'), 'desk grant not narrowed by page scope');
    assert.ok(agentsGrant.commands.includes('knowledge.topic_maintenance_approve'));
    await cancelTask(runtime, agents.task.id, desk2.leaseId);
    runtime.releaseWorker(desk2);

    // 员工绑定发布页 intent：baseCommands 为空 → TASK_SCOPE_EMPTY（员工发布页仍只读，A2 回归）。
    const emp = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const empTask = await startTask(runtime, {
      intent: 'page_publish',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'writer', page: 'publish' }
    }, emp.leaseId);
    runtime.bindWorkerTask(emp, empTask.task.id);
    await assert.rejects(
      () => ensureAutomaticTaskGrant(runtime, empTask.task.id, new Date(), 'writer'),
      (error) => error.code === 'TASK_SCOPE_EMPTY',
      'employee publish page grant must be refused'
    );
    await cancelTask(runtime, empTask.task.id, emp.leaseId);
    runtime.releaseWorker(emp);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('11 A6 desk stale-scope write refreshes exactly once, replay succeeds (no loop, no duplicate write)', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-a6-'));
  const runtime = openRuntime(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const started = await startTask(runtime, {
      intent: 'page_today',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'desk', page: 'today' }
    }, desk.leaseId);
    runtime.bindWorkerTask(desk, started.task.id);

    // 构造旧证：手工签发仅含基建命令的窄 grant（同 AUTOMATIC_TASK_GRANT_WORKERS 绑定 pi+mcp）。
    const narrow = await dispatchIssueTaskGrant(runtime, {
      requestId: randomUUID(),
      taskId: started.task.id,
      ownerGoal: '窄证模拟旧证未换发',
      allowedCommands: ['agent_tasks.report_progress'],
      workers: [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(narrow.ok, true);

    let handlerCalls = 0;
    const envelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'knowledge.record_batch',
      requestId: 'a6-stale-scope-write',
      input: { items: [] },
      boundIdentity: { entityType: 'knowledge_batch' },
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: started.task.id,
      workerLeaseId: desk.leaseId,
      grantId: narrow.data.id
    });
    const receipt = await runtime.dispatchCommand(envelope, () => {
      handlerCalls += 1;
      return { data: { ok: true }, entityType: 'knowledge_batch' };
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? null));
    assert.equal(handlerCalls, 1, 'exactly one business write — no recursive retry, no duplicate write');

    // 旧窄证已撤销，新 active grant = deskStanding（sameCommandSet 换发）。
    const oldGrant = getTaskGrant(runtime.database, narrow.data.id);
    assert.equal(oldGrant.status, 'revoked', 'old narrow grant must be revoked by sameCommandSet renewal');
    const active = listTaskGrants(runtime.database, started.task.id, new Date(), runtime.identity)
      .find((grant) => grant.status === 'active');
    assert.ok(active, 'renewed active grant exists');
    assert.deepEqual([...active.allowedCommands].sort(), deskStandingCommands(), 'renewed grant = deskStanding');

    // 同 requestId 以换发后 grant 重放 → 幂等返回同一成功收据（无重复业务写）。
    const replayEnvelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'knowledge.record_batch',
      requestId: 'a6-stale-scope-write',
      input: { items: [] },
      boundIdentity: { entityType: 'knowledge_batch' },
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: started.task.id,
      workerLeaseId: desk.leaseId,
      grantId: active.id
    });
    const replay = await runtime.dispatchCommand(replayEnvelope, () => {
      handlerCalls += 1;
      return { data: { ok: true }, entityType: 'knowledge_batch' };
    });
    assert.equal(replay.ok, true);
    assert.deepEqual(replay, receipt);
    assert.equal(handlerCalls, 1, 'idempotent replay must not re-run the handler');

    await cancelTask(runtime, started.task.id, desk.leaseId);
    runtime.releaseWorker(desk);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('12 A6 redline and employee writes never trigger the stale-scope refresh', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-a6b-'));
  const runtime = openRuntime(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const started = await startTask(runtime, {
      intent: 'page_today',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'desk', page: 'today' }
    }, desk.leaseId);
    runtime.bindWorkerTask(desk, started.task.id);

    // 红线命令（x_lists.operation_execute）即使站在 desk 上也不触发重签 → 原样拒绝，grant 不被换发。
    const narrow = await dispatchIssueTaskGrant(runtime, {
      requestId: randomUUID(),
      taskId: started.task.id,
      ownerGoal: '窄证',
      allowedCommands: ['agent_tasks.report_progress'],
      workers: [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(narrow.ok, true);
    const redline = await runtime.dispatchCommand(createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'x_lists.operation_execute',
      requestId: 'a6-redline-write',
      input: {},
      boundIdentity: {},
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: started.task.id,
      workerLeaseId: desk.leaseId,
      grantId: narrow.data.id
    }), () => { throw new Error('HANDLER_MUST_NOT_RUN'); });
    assert.equal(redline.ok, false);
    assert.equal(redline.error.code, 'TASK_SCOPE_BROADENED', 'redline never enters any grant');
    assert.equal(getTaskGrant(runtime.database, narrow.data.id).status, 'active', 'redline must not trigger renewal');

    await cancelTask(runtime, started.task.id, desk.leaseId);
    runtime.releaseWorker(desk);

    // 员工越界命令（planner 持 plans.save，写 content.save_version 不在其 grant）→ 原样拒绝，不重签。
    const plannerLease = runtime.acquireWorkerLease(null, 'planner', 'employee');
    const plannerTask = await startTask(runtime, {
      intent: 'page_today',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'planner', page: 'today' }
    }, plannerLease.leaseId);
    runtime.bindWorkerTask(plannerLease, plannerTask.task.id);
    const { grantId } = await grantCommands(runtime, plannerTask.task.id, 'planner');
    const employeeWrite = await runtime.dispatchCommand(createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'content.save_version',
      requestId: 'a6-employee-out-of-scope',
      input: {},
      boundIdentity: {},
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: plannerTask.task.id,
      workerLeaseId: plannerLease.leaseId,
      grantId
    }), () => { throw new Error('HANDLER_MUST_NOT_RUN'); });
    assert.equal(employeeWrite.ok, false);
    assert.equal(employeeWrite.error.code, 'TASK_SCOPE_BROADENED', 'employee out-of-role write stays rejected');
    assert.equal(
      listTaskGrants(runtime.database, plannerTask.task.id, new Date(), runtime.identity).filter((g) => g.status === 'active').length,
      1,
      'employee write must not trigger renewal'
    );
    await cancelTask(runtime, plannerTask.task.id, plannerLease.leaseId);
    runtime.releaseWorker(plannerLease);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('13 WMB-5183 channel safe-apply: desk applies add/enable/disable with readback; remove proposal denied pre-mutation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5183-channel-'));
  const seedDb = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  seedDb.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', `ws-${path.basename(directory)}`, now, now);
  ensureOfficialWorkspaceProfile(seedDb, 'official.ai');
  seedDb.close();
  const runtime = ActiveWorkspaceRuntime.open(directory);
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const started = await startTask(runtime, {
      intent: 'page_publish',
      businessDate: '2026-08-08',
      contextRefs: { roleId: 'desk', page: 'publish' }
    }, desk.leaseId);
    assert.equal(started.task.status, 'running');
    runtime.bindWorkerTask(desk, started.task.id);
    const { grantId } = await grantCommands(runtime, started.task.id, 'desk');
    const grant = getTaskGrant(runtime.database, grantId);
    assert.ok(grant.allowedCommands.includes('intelligence_channels.proposal_apply_safe'), 'safe-apply is desk standing');
    assert.equal(grant.allowedCommands.includes('intelligence_channels.proposal_apply'), false, 'precise apply never enters any grant');

    // 安全应用（add 官网）：主管执行成功且完整读回。
    const candidate = { inputText: 'Example', name: 'Example', url: 'https://example.com/', canonicalUrl: 'https://example.com/', origin: 'direct' };
    const trial = { title: 'Example', url: 'https://example.com/', requestedUrl: 'https://example.com/', readable: true, itemCount: 0 };
    const store = new IntelligenceChannelProposalStore();
    const proposal = store.prepare({
      requestId: 'wmb5183-safe-add',
      changes: [{ action: 'add', module: 'official_web', inputText: 'Example', candidate, trialRead: trial }]
    }, readChannelProposalContext(runtime.database));
    const receipt = await dispatchConfirmIntelligenceChannelProposalSafe(runtime, {
      store,
      binding: channelProposalBinding(proposal),
      trialWebsite: async () => trial,
      taskId: started.task.id,
      taskGrantId: grantId,
      workerLeaseId: desk.leaseId
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? null));
    assert.equal(receipt.command, 'intelligence_channels.proposal_apply_safe');
    assert.equal(receipt.actor.type, 'pi');
    assert.equal(receipt.data.applied, 1);
    assert.deepEqual(receipt.readback, { proposalId: proposal.id, normalizedHash: proposal.normalizedHash, state: 'applied', applied: 1 });
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM website_sources').get().count, 1);
    assert.equal(receipt.executionGrantId, null, 'safe-apply needs no precise execution grant');

    // 含 remove 的提案 → 主管信封在业务写前拒绝（REDLINE_REQUIRED），零业务写、无 precise grant。
    const summary = readIntelligenceChannelsSummary(runtime.database);
    const added = summary.sources.find((source) => source.module === 'official_web');
    assert.ok(added, 'added website source present');
    const removeStore = new IntelligenceChannelProposalStore();
    const removeProposal = removeStore.prepare({
      requestId: 'wmb5183-remove',
      changes: [{ action: 'remove', module: 'official_web', sourceId: added.sourceId, expectedRevision: added.revision }]
    }, readChannelProposalContext(runtime.database));
    const before = runtime.database.prepare('SELECT COUNT(*) AS count FROM website_sources').get().count;
    const denied = await dispatchConfirmIntelligenceChannelProposalSafe(runtime, {
      store: removeStore,
      binding: channelProposalBinding(removeProposal),
      trialWebsite: async () => trial,
      taskId: started.task.id,
      taskGrantId: grantId,
      workerLeaseId: desk.leaseId
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'REDLINE_REQUIRED');
    assert.equal(denied.sideEffectState, 'not_started');
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM website_sources').get().count, before, 'remove proposal must not mutate');
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM execution_grants").get().count, 0,
      'no precise execution grant issued for denied remove'
    );

    await cancelTask(runtime, started.task.id, desk.leaseId);
    runtime.releaseWorker(desk);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('14 terminal planner recovery stops stale manager work projection idempotently', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-manager-terminal-'));
  const businessDate = '2026-08-11';
  const runtime = openRuntime(directory);
  try {
    const manager = await startTask(runtime, {
      intent: 'page_agents',
      businessDate,
      contextRefs: { roleId: 'desk', manager: true }
    });
    await updateManagerTaskCheckpoint(runtime, manager.task.id, {
      status: 'running',
      phase: 'monitor_planner',
      summary: '策划生成方案中'
    });

    const planner = await startTask(runtime, {
      intent: 'daily_judge',
      businessDate,
      contextRefs: { roleId: 'planner' }
    });
    const plannerLease = runtime.acquireWorkerLease(planner.task.id, 'planner', 'employee');
    runtime.bindWorkerTask(plannerLease, planner.task.id);
    const plannerGrantId = await ensureAutomaticTaskGrant(runtime, planner.task.id, new Date(), 'planner');
    const planInput = { planDate: businessDate, timezone: 'Asia/Shanghai', summary: '测试方案', items: [] };
    const planReceipt = await dispatchBusinessCommand(runtime, {
      command: 'plans.save',
      requestId: `test:plan:${planner.task.id}`,
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: planner.task.id,
      workerLeaseId: plannerLease.leaseId,
      grantId: plannerGrantId,
      input: planInput,
      boundIdentity: { planDate: businessDate },
      entityType: 'plan',
      execute: (database, value) => {
        const data = saveCurrentPlan(database, value, false);
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    });
    assert.equal(planReceipt.ok, true, JSON.stringify(planReceipt.error ?? null));
    await dispatchCompleteAgentTask(runtime, planner.task.id, { ...actor('complete-planner'), taskId: planner.task.id });
    runtime.releaseWorker(plannerLease);

    const projection = readManagerProjection(runtime, businessDate);
    assert.equal(projection.legacyChild?.id, planner.task.id, '终态 child 仍能按 manager 创建时间恢复');
    assert.equal(projection.legacyChild?.status, 'partial', '缺少渠道收据时仍是已结束 child');
    const synced = await syncManagerTaskFromLegacyChild(runtime, businessDate, projection.legacyChild);
    assert.equal(synced?.checkpoint.status, 'waiting_human');
    assert.equal(synced?.checkpoint.phase, 'report');
    assert.equal(synced?.checkpoint.children.find((child) => child.roleId === 'planner')?.status, 'succeeded');

    const repeated = await syncManagerTaskFromLegacyChild(runtime, businessDate, projection.legacyChild);
    assert.equal(repeated?.updatedAt, synced?.updatedAt, '相同终态重复刷新不得续写 manager');
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
