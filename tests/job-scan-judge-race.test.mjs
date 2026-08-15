import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentRequestId, getAgentTask, startAgentTask, updateAgentTaskPhase } from '../src/main/agent-tasks.ts';
import { dispatchCompleteAgentTask } from '../src/main/agent-task-commands.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JOB_ERROR_CODES, mapOutcomeToTerminal, readbackScanPhase, snapshotScanReadback } from '../src/main/role-job-registry.ts';
import { buildOfficialTemplateProfile, insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';

/**
 * WMB-5118 scan/judge 并发读回竞态（R1）复现与回归。
 * 设计：docs/spark/2026-08-08-agent-crew-residual-risk-closure-design.md §5。
 * - 守卫命中 → deferred 让路信号（不再把 judge 任务当扫描任务返回）；
 * - scan 返回瞬间捕获不可变读回快照（judge rebind 无法改写）；
 * - spawner 对 deferred outcome 泊车 RESOURCE_JUDGE_IN_FLIGHT（waiting_resource 车道），
 *   judge settle 事件触发晋升（≤1s），60s 看门狗兜底；泊车可取消且无 agent_task；
 * - deferred 不写 agent_task 终态、不进五态映射（交叉 C 无伪成功）。
 */

const BUSINESS_DATE = '2026-08-08';
const RUNTIME_WS = 'ws-5118';

async function makeRoot(prefix = 'wmb-5118-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(RUNTIME_WS, now, now);
  return { root, database, workspaceId: RUNTIME_WS };
}

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', RUNTIME_WS, now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

function seedWebsite(database, slug) {
  const url = `https://example.com/${slug}`;
  return createWebsiteSource(database, {
    inputText: url,
    name: `Example ${slug}`,
    canonicalUrl: url,
    resolutionStatus: 'ready',
    trialRead: { title: `Example ${slug}`, url, readable: true, summary: 'A readable source page for the scan/judge race test.' }
  });
}

/** running daily_judge 任务（phase=judging_opportunities，命中守卫 /judg|synth|validat|running_pi/）。 */
function seedJudge(database) {
  const started = startAgentTask(database, { intent: 'daily_judge', businessDate: BUSINESS_DATE });
  assert.equal(started.ok, true, 'seed judge task');
  const task = started.data;
  updateAgentTaskPhase(database, task.id, 'judging_opportunities');
  return getAgentTask(database, task.id);
}

/** running daily_scan 任务已到 channel_scanned（真实扫描完成态）：任务 + 成功回执 + 冻结上下文。 */
function seedScannedScan(database, workspaceId, source) {
  const started = startAgentTask(database, {
    intent: 'daily_scan',
    businessDate: BUSINESS_DATE,
    contextRefs: {
      workspaceId,
      intelligenceChannels: {
        workspaceId,
        profileRevision: 1,
        modules: ['official_web'],
        sources: [{ module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId, revision: source.revision }]
      }
    }
  });
  assert.equal(started.ok, true, 'seed scanned scan task');
  const task = started.data;
  updateAgentTaskPhase(database, task.id, 'channel_scanned');
  recordSourceScanReceipt(database, {
    taskId: task.id, workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId,
    status: 'succeeded', candidateCount: 1, savedCount: 1
  });
  return getAgentTask(database, task.id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function employeeSnapshotCount(runtime) {
  return runtime.getWorkerSnapshots().filter((s) => s.purpose === 'employee').length;
}

function scanOnlyExecute(runtime) {
  // 与 GenericEmployeeRunner.assembleOutcome 同款路由（§5.2）：deferred 优先 → 快照读回；
  // 真实 scanOnly 领域入口由本测试文件直接调用，避免 electron 依赖。
  return async (ctx) => {
    if (ctx.job.roleId === 'planner') return { status: 'succeeded', code: 'OK', message: null, readback: null };
    const run = await startWorkspaceDailyIntelligence({
      dataRootPath: runtime.identity.rootPath,
      businessDate: ctx.job.businessDate ?? BUSINESS_DATE,
      mcpUrl: 'http://127.0.0.1:1/mcp',
      activeRuntime: runtime,
      workerLeaseId: ctx.lease.leaseId,
      scanOnly: true
    });
    if (run.deferred) {
      return { status: 'deferred', code: JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT, message: `判定任务进行中（task ${run.deferred.taskId}），扫描让路。`, readback: null };
    }
    const snapshot = snapshotScanReadback(run.task);
    if (!snapshot) return { status: 'failed', code: JOB_ERROR_CODES.JOB_READBACK_MISSING, message: '缺少 scan 读回证据。', readback: null };
    return { status: 'succeeded', code: 'SCAN_CHANNEL_SCANNED', message: null, readback: snapshot };
  };
}

test('T-01 守卫命中：run.deferred 为真且零 source 回执（复现用例由红转绿，judge 不再被当作扫描任务）', async () => {
  const current = await makeRoot('wmb-5118-guard-');
  try {
    seedWebsite(current.database, 'guard');
    const judge = seedJudge(current.database);
    const run = await startDailyChannelRun(current.database, {
      businessDate: BUSINESS_DATE, workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web']
    });
    assert.ok(run.deferred, '守卫命中必须打 deferred 让路标记（旧代码此处为 undefined → 伪失败）');
    assert.equal(run.deferred.reason, 'JUDGE_IN_FLIGHT');
    assert.equal(run.deferred.taskId, judge.id);
    assert.equal(run.shouldRunJudgment, false);
    assert.equal(run.task.id, judge.id, 'task 引用仅供参考，不得当作扫描结果');
    const receipts = current.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count;
    assert.equal(receipts, 0, '守卫命中零 source 回执');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('T-02 workspace scanOnly 入口透传 deferred（reporter 让路，不建 daily_scan 任务）', async () => {
  const current = await makeRoot('wmb-5118-scanonly-');
  try {
    insertWorkspaceProfile(current.database, buildOfficialTemplateProfile('official.ai', 1));
    seedWebsite(current.database, 'scanonly');
    const judge = seedJudge(current.database);
    const run = await startWorkspaceDailyIntelligence({
      dataRootPath: current.root, businessDate: BUSINESS_DATE, mcpUrl: 'http://127.0.0.1:1/mcp', scanOnly: true
    });
    assert.ok(run.deferred, 'scanOnly 分支透传 deferred');
    assert.equal(run.deferred.taskId, judge.id);
    assert.equal(run.task.id, judge.id);
    const scanTasks = current.database.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE intent='daily_scan'").get().count;
    assert.equal(scanTasks, 0, '守卫命中不创建 daily_scan 任务');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('T-03 交叉 C：judge 自建任务带自身回执仍 defer（读回 checkpoint 伪成功路径关闭，无伪成功）', async () => {
  const current = await makeRoot('wmb-5118-crossc-');
  try {
    const source = seedWebsite(current.database, 'crossc');
    const judge = seedJudge(current.database);
    // judgeOnly 交接场景：judge 任务自身持有 channel 收据（非 reporter 扫描证据）。
    recordSourceScanReceipt(current.database, {
      taskId: judge.id, workspaceId: current.workspaceId, module: 'official_web',
      sourceId: source.id, sourceFeedId: source.sourceFeedId, status: 'succeeded', candidateCount: 1, savedCount: 1
    });
    const run = await startDailyChannelRun(current.database, {
      businessDate: BUSINESS_DATE, workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web']
    });
    assert.ok(run.deferred, 'judge 任务有回执也不得被当作扫描成功（防伪成功）');
    assert.equal(run.deferred.taskId, judge.id);
    assert.equal(run.shouldRunJudgment, false);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('T-04 spawner：deferred outcome 泊车 RESOURCE_JUDGE_IN_FLIGHT（waiting_resource 非 failed，lease/锁归零，无 agent_task）', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5118-park-'));
  const runtime = openRuntime(directory);
  try {
    const seen = [];
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async ({ job }) => {
        if (job.brief === 'defer-me') return { status: 'deferred', code: JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT, message: '判定任务进行中，扫描让路。', readback: null };
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      },
      onEvent: (event) => seen.push(event.type)
    });
    const a = spawner.spawn({ roleId: 'reporter', brief: 'defer-me', businessDate: BUSINESS_DATE });
    for (let i = 0; i < 100; i += 1) {
      if (spawner.get(a.id)?.status === 'waiting_resource') break;
      await sleep(10);
    }
    const parked = spawner.get(a.id);
    assert.equal(parked.status, 'waiting_resource', 'deferred 落 waiting_resource 车道而非 failed');
    assert.match(parked.waitReason ?? '', /RESOURCE_JUDGE_IN_FLIGHT/);
    assert.match(parked.waitReason ?? '', /SCAN_JUDGE_IN_FLIGHT/);
    assert.equal(parked.report, null, 'deferred 不写 pool 终态报告');
    assert.equal(employeeSnapshotCount(runtime), 0, 'employee lease 已释放');
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get().count, 0, 'deferred 不写 agent_task');
    // 实体锁已归零：同锁键 reporter 新单可直接运行（park 时池内 clearLocks）。
    const b = spawner.spawn({ roleId: 'reporter', brief: 'plain', businessDate: BUSINESS_DATE });
    const doneB = await spawner.await(b.id, 10_000);
    assert.equal(doneB.status, 'succeeded', 'parked 工单锁已释放，同键新单可运行');
    assert.ok(seen.includes('job.waiting_resource'), 'job.waiting_resource 事件已发出');
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('T-05 judge settle 后 ≤1s 事件触发晋升：reporter 重跑 → 真实扫描读回 → succeeded(scan_phase_reached)', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5118-promote-'));
  // fixture 在 runtime 写护栏之外预置（agent-work-paths 同款模式）：profile / 来源 / judge / 扫描证据。
  const seedDb = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  seedDb.prepare("INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)").run('workspace_id', RUNTIME_WS, now, now);
  insertWorkspaceProfile(seedDb, buildOfficialTemplateProfile('official.ai', 1));
  const source = seedWebsite(seedDb, 'promote');
  const judge = seedJudge(seedDb);
  seedScannedScan(seedDb, RUNTIME_WS, source);
  // judge 终态（dispatchCompleteAgentTask）要求当日 current plan + 本任务 plans.save 归属证据。
  saveCurrentPlan(seedDb, { planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: '今日没有新增机会', items: [] });
  seedDb.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)')
    .run('plans.save', agentRequestId(judge.id, 'plan'), '{}', new Date().toISOString());
  seedDb.close();
  const runtime = ActiveWorkspaceRuntime.open(directory);
  try {
    let gateResolve;
    const gate = new Promise((resolve) => { gateResolve = resolve; });
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async (ctx) => {
        if (ctx.job.roleId === 'planner') { await gate; return { status: 'succeeded', code: 'OK', message: null, readback: null }; }
        return scanOnlyExecute(runtime)(ctx);
      }
    });
    const reporter = spawner.spawn({ roleId: 'reporter', brief: 'scan', businessDate: BUSINESS_DATE });
    const planner = spawner.spawn({ roleId: 'planner', brief: 'judge', businessDate: BUSINESS_DATE });
    for (let i = 0; i < 100; i += 1) {
      if (spawner.get(reporter.id)?.status === 'waiting_resource') break;
      await sleep(10);
    }
    assert.equal(spawner.get(reporter.id)?.status, 'waiting_resource', 'judge 运行时 reporter 泊车等待');
    // judge 终态（写护栏内走命令调度）→ 释放 judge 工单（pool 侧 settle 触发晋升）。
    await dispatchCompleteAgentTask(runtime, judge.id, {
      actor: { type: 'scheduler', id: 'test', label: 'test' },
      requestId: `test:${judge.id}:complete`,
      taskId: judge.id
    });
    const t0 = Date.now();
    gateResolve();
    const done = await spawner.await(reporter.id, 10_000);
    const elapsed = Date.now() - t0;
    assert.equal(done.status, 'succeeded', '晋升后真实扫描成功（非 re-park、非 failed）');
    assert.equal(done.report?.code, 'SCAN_CHANNEL_SCANNED');
    assert.deepEqual(done.report?.readback, { kind: 'scan_phase_reached', phase: 'channel_scanned' });
    assert.ok(elapsed <= 1000, `judge settle 后 ≤1s 事件触发晋升（实际 ${elapsed}ms）`);
    await spawner.await(planner.id, 10_000);
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('T-06 泊车中取消：cancelled 且无 agent_task、lease 归零（等待车道可取消，复用 parked 分支）', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5118-cancel-'));
  const runtime = openRuntime(directory);
  try {
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 2,
      execute: async () => ({ status: 'deferred', code: JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT, message: '判定任务进行中，扫描让路。', readback: null })
    });
    const a = spawner.spawn({ roleId: 'reporter', brief: 'cancel-me', businessDate: BUSINESS_DATE });
    for (let i = 0; i < 100; i += 1) {
      if (spawner.get(a.id)?.status === 'waiting_resource') break;
      await sleep(10);
    }
    assert.equal(spawner.get(a.id)?.status, 'waiting_resource');
    await spawner.cancel(a.id);
    const done = await spawner.await(a.id, 10_000);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.report?.code, 'JOB_CANCELLED');
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get().count, 0, '泊车取消无 agent_task（从未创建/已释放）');
    assert.equal(employeeSnapshotCount(runtime), 0, 'lease 归零');
    spawner.dispose();
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('T-07 deferred 不进五态映射：mapOutcomeToTerminal 拒收（类型 + 运行期双保险）；取消优先不变量保留', () => {
  const deferred = { status: 'deferred', code: JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT, message: null, readback: null };
  assert.throws(() => mapOutcomeToTerminal(deferred, false), /JOB_DEFERRED_NOT_MAPPABLE/);
  assert.equal(mapOutcomeToTerminal(deferred, true).pool, 'cancelled', 'abort 恒优先');
  assert.equal(mapOutcomeToTerminal(deferred, true).agentTask, 'cancelled');
});

test('T-08 channel_scanned 快照：不可变；judge rebind 推进 phase 后快照仍判定成功、重读回落为 null（旧伪失败窗口）', async () => {
  const current = await makeRoot('wmb-5118-snapshot-');
  try {
    const source = seedWebsite(current.database, 'snapshot');
    const scanTask = seedScannedScan(current.database, current.workspaceId, source);
    const snapshot = snapshotScanReadback({ status: scanTask.status, phase: scanTask.phase });
    assert.deepEqual(snapshot, { kind: 'scan_phase_reached', phase: 'channel_scanned' });
    assert.ok(Object.isFrozen(snapshot), '快照一次性捕获且不可变');
    assert.deepEqual(readbackScanPhase(current.database, scanTask.id), { kind: 'scan_phase_reached', phase: 'channel_scanned' }, 'rebind 前兜底重读同样成立');
    // judge rebind：同一 daily_scan 任务被并发 judge 推进到 judging_opportunities。
    updateAgentTaskPhase(current.database, scanTask.id, 'judging_opportunities');
    assert.equal(readbackScanPhase(current.database, scanTask.id), null, 'rebind 后重读被顶掉 → 旧路径伪失败窗口');
    assert.deepEqual(snapshot, { kind: 'scan_phase_reached', phase: 'channel_scanned' }, '快照不受 rebind 影响');
    assert.deepEqual(snapshotScanReadback({ status: 'succeeded', phase: 'completed' }), { kind: 'scan_phase_reached', phase: 'completed' }, '零增量收尾同样产生快照');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('T-09 workspace scanOnly 返回瞬间即捕获快照：rebind 后快照仍成功而重读失败（runner 读回优先快照）', async () => {
  const current = await makeRoot('wmb-5118-capture-');
  try {
    insertWorkspaceProfile(current.database, buildOfficialTemplateProfile('official.ai', 1));
    const source = seedWebsite(current.database, 'capture');
    seedScannedScan(current.database, current.workspaceId, source);
    const run = await startWorkspaceDailyIntelligence({
      dataRootPath: current.root, businessDate: BUSINESS_DATE, mcpUrl: 'http://127.0.0.1:1/mcp', scanOnly: true
    });
    assert.equal(run.deferred, null, '无 judge 时正常扫描');
    // 捕获点 = resolve 返回瞬间（runScanPolicy 以 snapshotScanReadback(run.task) 落 EmployeePolicyRun.readback）。
    const captured = snapshotScanReadback(run.task);
    assert.deepEqual(captured, { kind: 'scan_phase_reached', phase: 'channel_scanned' });
    // judge rebind 推进 phase（并发读回竞态窗口）。
    updateAgentTaskPhase(current.database, run.task.id, 'judging_opportunities');
    assert.equal(readbackScanPhase(current.database, run.task.id), null, '重读已失效');
    assert.deepEqual(captured, { kind: 'scan_phase_reached', phase: 'channel_scanned' }, '快照仍判定成功（不可变快照优先）');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});
