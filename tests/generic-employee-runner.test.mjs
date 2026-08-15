import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { createGenericEmployeeRunner, writeAgentTaskTerminal } from '../src/main/generic-employee-runner.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { getAgentTask, getLatestAgentTask } from '../src/main/agent-tasks.ts';
import { JOB_ERROR_CODES, mapOutcomeToTerminal, roleFailureCode } from '../src/main/role-job-registry.ts';
import { ensureOfficialWorkspaceProfile, readWorkspaceProfile } from '../src/main/workspace-profiles.ts';

/**
 * WMB-5137 聚焦测试（Backend 前三项：角色语义错误码、message 保留、job 失败即时 agent_task 终态、
 * 取消优先回归）。reporter/planner 经真实 runner + 真实 runtime 的可证伪 no-code 异常路径；
 * writer/librarian 的域映射由 roleFailureCode 全角色表覆盖（runner catch 对四角色走同一行映射）。
 * T8 经真实 runner 接线（createGenericEmployeeRunner → runScanPolicy → startDailyChannelRun）
 * 覆盖 catch 的 createdTaskId 写终态段：删该段则任务保持 running，T8 失败。
 */

const withRuntime = async (fn, { corruptProfile = false } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5137-'));
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)").run('workspace_id', 'ws-5137', now, now);
  if (corruptProfile) {
    // 损坏 platforms_json：readWorkspaceProfile 的 JSON.parse 抛无 code SyntaxError（no-code 异常 fixture）。
    database.prepare(`INSERT INTO workspace_profiles (id, profile_id, revision, official_template_id, official_template_version,
      display_name, audience, content_goal, editorial_brief, intelligence_pack_id, intelligence_pack_version,
      creation_pack_id, creation_pack_version, platforms_json, created_at, updated_at)
      VALUES ('effective', 'profile.ai.official', 1, 'official.ai', 2, 'x', 'x', 'x', 'x', 'wemedia-intelligence-engine', 1, 'wmb-core-creation', 1, '{broken json', ?, ?)`).run(now, now);
  } else {
    // 默认分支：有效官方 effective profile。T8 需 reporter 真实接线经 requireWorkspaceProfile
    // 与 startDailyChannelRun 创建 daily_scan 任务；不影响 corruptProfile fixture。
    ensureOfficialWorkspaceProfile(database, 'official.ai');
  }
  database.close();
  const runtime = ActiveWorkspaceRuntime.open(directory);
  try {
    return await fn(runtime);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
};

const makeCtx = (runtime, roleId, signal = new AbortController().signal) => ({
  runtime,
  job: { id: `job-${roleId}-${Date.now()}`, roleId, brief: '执行工单', businessDate: '2026-08-09', projectId: null },
  lease: { leaseId: `lease-${roleId}-${Date.now()}` },
  taskId: null,
  grantId: null,
  sessionFile: path.join(runtime.identity.rootPath, 'agent', 'sessions', `job-${roleId}.jsonl`),
  signal,
  stopResource: null
});

const failedOutcome = (code, message) => ({ status: 'failed', code, message, readback: null });

test('T1 无 code 异常角色域错误码映射：四角色各落本角色语义码，LIBRARY_ORGANIZE_FAILED 仅剩 librarian', () => {
  assert.equal(roleFailureCode('reporter'), 'REPORTER_SCAN_FAILED');
  assert.equal(roleFailureCode('planner'), 'PLANNER_JUDGE_FAILED');
  assert.equal(roleFailureCode('writer'), 'WRITER_DRAFT_FAILED');
  assert.equal(roleFailureCode('librarian'), JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED);
  assert.equal(JOB_ERROR_CODES.REPORTER_SCAN_FAILED, 'REPORTER_SCAN_FAILED');
  assert.equal(JOB_ERROR_CODES.PLANNER_JUDGE_FAILED, 'PLANNER_JUDGE_FAILED');
  assert.equal(JOB_ERROR_CODES.WRITER_DRAFT_FAILED, 'WRITER_DRAFT_FAILED');
  // 语义边界：LIBRARY_ORGANIZE_FAILED 不再被任何非 librarian 角色借用。
  for (const role of ['reporter', 'planner', 'writer']) {
    assert.notEqual(roleFailureCode(role), JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED, `${role} 不得映射到 organize 域`);
  }
});

test('T2 真实 runner no-code 异常：reporter 落 REPORTER_SCAN_FAILED 且原始 message 原文保留（不再 LIBRARY_ORGANIZE_FAILED）', async () => {
  await withRuntime(async (runtime) => {
    let expectedMessage = '';
    try {
      readWorkspaceProfile(runtime.database); // 与 runner 内部同一 JSON.parse 抛点
    } catch (error) {
      expectedMessage = error instanceof Error ? error.message : String(error);
    }
    assert.ok(expectedMessage, 'corrupt profile fixture 必须先可证伪地抛错');
    const run = createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
    const outcome = await run(makeCtx(runtime, 'reporter'));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.code, 'REPORTER_SCAN_FAILED', 'reporter no-code 异常落角色语义码');
    assert.notEqual(outcome.code, JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED, '不得再跨域映射到 library');
    assert.equal(outcome.message, expectedMessage, 'errorMessage 保留原始 message 原文');
  }, { corruptProfile: true });
});

test('T3 真实 runner no-code 异常：planner 落 PLANNER_JUDGE_FAILED 且原始 message 原文保留', async () => {
  await withRuntime(async (runtime) => {
    let expectedMessage = '';
    try {
      readWorkspaceProfile(runtime.database);
    } catch (error) {
      expectedMessage = error instanceof Error ? error.message : String(error);
    }
    const run = createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
    const outcome = await run(makeCtx(runtime, 'planner'));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.code, 'PLANNER_JUDGE_FAILED');
    assert.notEqual(outcome.code, JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED);
    assert.equal(outcome.message, expectedMessage);
  }, { corruptProfile: true });
});

test('T4 带 code 异常仍走原 code（既有行为回归），message 保留', async () => {
  await withRuntime(async (runtime) => {
    const run = createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
    const ctx = makeCtx(runtime, 'reporter');
    // 通过 corrupt profile 抛错前无法注入带 code 异常；改用 MCP 缺失路径验证 code 语义透传。
    const noMcp = createGenericEmployeeRunner(() => runtime, () => null);
    const outcome = await noMcp(ctx);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.code, JOB_ERROR_CODES.MCP_UNAVAILABLE);
    assert.match(outcome.message ?? '', /MCP/);
  });
});

test('T5 job 失败即时终态：仍 running 的 created task 同步 failed + 同一映射 errorCode + 原始 message（非 sweeper 周期）', async () => {
  await withRuntime(async (runtime) => {
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'daily_scan', businessDate: '2026-08-09',
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'reporter' }
    }, { actor: { type: 'scheduler', id: 'test', label: 'test' }, requestId: `t5:${Date.now()}:start` });
    assert.equal(started.task.status, 'running');
    const outcome = failedOutcome(roleFailureCode('reporter'), '无 code 异常原文 message');
    // 同一映射函数产出 pool 与 agent_task 终态（五态契约）：先验证映射本身。
    const mapping = mapOutcomeToTerminal(outcome, false);
    assert.equal(mapping.pool, 'failed');
    assert.equal(mapping.agentTask, 'failed');
    assert.equal(mapping.code, 'REPORTER_SCAN_FAILED');
    // runner catch 路径的同一写终态入口：同步（非 sweeper）落 failed。
    await writeAgentTaskTerminal({ runtime, lease: { leaseId: 't5-lease' }, signal: new AbortController().signal }, outcome, started.task.id);
    const task = getAgentTask(runtime.database, started.task.id);
    assert.equal(task?.status, 'failed', '短窗口内 agent_task 立即落 failed');
    assert.equal(task?.errorCode, 'REPORTER_SCAN_FAILED', 'agent_task errorCode 与 pool 同一映射 code');
    assert.equal(task?.errorMessage, '无 code 异常原文 message', '原始 message 写入 agent_task');
    // 双终态防护：已终态任务再写不同 outcome 不改变原终态。
    await writeAgentTaskTerminal({ runtime, lease: { leaseId: 't5-lease' }, signal: new AbortController().signal }, failedOutcome('OTHER', 'late'), started.task.id);
    const after = getAgentTask(runtime.database, started.task.id);
    assert.equal(after?.status, 'failed');
    assert.equal(after?.errorCode, 'REPORTER_SCAN_FAILED', '已终态任务不被二次改写');
  });
});

test('T6 取消优先：abort 信号下 runner 直接落 cancelled（JOB_CANCELLED），不产生 failed', async () => {
  await withRuntime(async (runtime) => {
    const controller = new AbortController();
    controller.abort();
    const run = createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
    const outcome = await run(makeCtx(runtime, 'reporter', controller.signal));
    assert.equal(outcome.status, 'cancelled', '取消优先于错误路径');
    assert.equal(outcome.code, JOB_ERROR_CODES.JOB_CANCELLED);
    assert.equal(mapOutcomeToTerminal(outcome, true).pool, 'cancelled');
  });
});

test('T7 取消优先回归（runner 层）：cancelled outcome + 非 abort 信号也映射 cancelled 终态（五态契约不回归）', async () => {
  const cancelled = { status: 'cancelled', code: JOB_ERROR_CODES.JOB_CANCELLED, message: null, readback: null };
  const mapping = mapOutcomeToTerminal(cancelled, false);
  assert.equal(mapping.pool, 'cancelled');
  assert.equal(mapping.agentTask, 'cancelled');
  assert.equal(mapping.code, JOB_ERROR_CODES.JOB_CANCELLED);
});

test('T8 真实 runner 接线：onTaskReady 之后 post-task 无 code 异常 → REPORTER_SCAN_FAILED + 即时 failed 终态（删 runner catch 写终态段则任务保持 running 使测试失败）', async () => {
  await withRuntime(async (runtime) => {
    const message = 'post-task no-code failure';
    // 覆盖实例方法：抛点位于 runner onTaskReady 已设置 createdTaskId 之后（A1 bind 处），
    // 是「任务已建、绑定阶段无 code 异常」的真实 runner 接线路径（非直接调 helper）。
    const originalBindWorkerTask = runtime.bindWorkerTask;
    runtime.bindWorkerTask = () => { throw new Error(message); };
    try {
      const run = createGenericEmployeeRunner(() => runtime, () => ({ mcpUrl: 'http://127.0.0.1:1/mcp' }));
      const outcome = await run(makeCtx(runtime, 'reporter'));
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.code, 'REPORTER_SCAN_FAILED');
      assert.equal(outcome.message, message);
      // 按 businessDate/intent 读取 runner 内部经 startDailyChannelRun 创建的 daily_scan 任务。
      const task = getLatestAgentTask(runtime.database, 'daily_scan', '2026-08-09');
      assert.ok(task, 'runner 必须经 startDailyChannelRun 创建 daily_scan 任务后进入 onTaskReady');
      assert.equal(task.intent, 'daily_scan');
      assert.equal(task.status, 'failed', '删 runner catch 的 createdTaskId 写终态段后本断言失败（任务保持 running）');
      assert.equal(task.errorCode, 'REPORTER_SCAN_FAILED', 'agent_task errorCode 与 pool 同一映射 code');
      assert.equal(task.errorMessage, message, '原始 message 原样写入 agent_task');
    } finally {
      runtime.bindWorkerTask = originalBindWorkerTask;
    }
  });
});
