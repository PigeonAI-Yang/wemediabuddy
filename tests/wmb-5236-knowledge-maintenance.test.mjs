// WMB-5236：持久化「维护整个 Wiki」运行（full-wiki maintenance orchestrator）聚焦测试。
// 覆盖（合同逐项）：启动幂等、预算续跑（有界批次连续调度到 checkpoint completed）、暂停/继续
// （批次边界生效；paused 不占执行）、失败恢复（run 级失败保留错误 + resume；回溯停滞 fail →
// 修复后 resume）、重启恢复（重新打开 DB/新 deps 沿持久 checkpoint 继续）、完成报告（数字来自
// checkpoint/DB）、空库、跨 workspace 拒绝。compile callback 为真实可执行管线（WMB-5228 候选
// 计划 + WMB-5211 编译器，脚本化模型输出——与 WMB-5229/5230 测试同款注入面）。
// 运行：node --test --test-concurrency=1 tests/wmb-5236-knowledge-maintenance.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { writeSourceBodyCache } = await import('../src/main/source-body-cache.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const { setDataChangedPublisher } = await import('../src/main/data-changed.ts');
const {
  startMaintenanceRun,
  pauseMaintenanceRun,
  resumeMaintenanceRun,
  failMaintenanceRun,
  getMaintenanceRun,
  getMaintenanceStatus,
  getMaintenanceReport,
  clearMaintenanceRun,
  advanceMaintenanceRun,
  runMaintenanceStep,
  countOpenHealthIssues,
  emptyMaintenanceStatus
} = await import('../src/main/knowledge-maintenance.ts');
const {
  getKnowledgeBackfillCheckpoint,
  createKnowledgeBackfillCompile
} = await import('../src/main/knowledge-backfill.ts');
const { getPeriodicLintCheckpoint } = await import('../src/main/knowledge-health.ts');

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5236-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeDatabase(root, workspaceId) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  const ws = workspaceId ?? `ws-${randomUUID()}`;
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(ws, now, now);
  return { database, workspaceId: ws };
}

function fenced(manifest) {
  return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

const SOURCE_SUMMARY = [
  'AgentForge v2 正式发布，支持多模型路由。',
  '官方定价为每百万 token 0.8 美元。',
  '社区反馈称高峰时段延迟明显上升。'
].join('\n');

/** 按 sourceId 派生确定性 manifest（canonicalKey 唯一 → 多 Source 编译互不冲突）。 */
function manifestFor(sourceId) {
  const tag = `mt-${sourceId.slice(0, 8)}`;
  return {
    wmb_knowledge_candidates: {
      reason: 'fixture 维护 run 测试。',
      topicCompile: { title: '维护 Wiki', summary: '从存量 Source 编译的 Topic Wiki' },
      entities: [
        { entityType: 'product', canonicalKey: tag, canonicalName: `产品${tag}`, excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方产品身份，可独立验证。' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: `${tag}-claim`, statement: `${tag} 支持多模型路由。`, conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方发布，可验证。' }
      ]
    }
  };
}

/** 脚本化模型：从 prompt 提取 sourceId 并返回其确定性 manifest；badIds 抛错（模拟模型失败）。 */
function modelOf({ bad = new Set() } = {}) {
  return async (prompt) => {
    const match = /sourceId=([0-9A-Za-z-]+)/.exec(prompt);
    const sourceId = match?.[1];
    if (!sourceId || bad.has(sourceId)) throw new Error('MODEL_CALL_FAILED');
    return fenced(manifestFor(sourceId));
  };
}

function maintenanceDepsFor(root, modelCall) {
  const compileDeps = { databasePath: path.join(root, 'wmb.db'), modelCall, openDatabase: migrateDatabase };
  return {
    backfill: {
      databasePath: path.join(root, 'wmb.db'),
      compileSource: createKnowledgeBackfillCompile(compileDeps),
      openDatabase: migrateDatabase
    }
  };
}

function seedTopic(database, title) {
  return upsertKnowledgeTopic(database, { title });
}

function linkTopic(database, sourceId, topicId) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
    .run(topicId, sourceId, 'primary', now, now);
}

function seedSource(database, input) {
  return upsertSource(database, {
    title: input.title,
    originalUrl: `https://example.com/${input.title}`,
    summary: input.summary === undefined ? SOURCE_SUMMARY : input.summary,
    priority: input.priority,
    verificationStatus: input.verificationStatus ?? 'verified',
    valueJudgment: input.valueJudgment,
    managementStatus: input.managementStatus
  });
}

function seedBodyCache(database, sourceId) {
  const now = new Date().toISOString();
  writeSourceBodyCache(database, {
    sourceId,
    url: `https://example.com/body-${sourceId}`,
    status: 'ready',
    contentType: 'text/plain',
    extractedText: SOURCE_SUMMARY,
    extractedChars: SOURCE_SUMMARY.length,
    errorMessage: null,
    fetchedAt: now,
    updatedAt: now
  });
}

/** 一条 eligible Source：活跃 Topic + 正文 + verified 信号。 */
function seedEligibleSource(database, title) {
  const topic = seedTopic(database, `主题-${title}`);
  const source = seedSource(database, { title });
  linkTopic(database, source.id, topic.id);
  return { topic, source };
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

/** 沿 run 状态机推进直到 completed / failed / 达到上限（每 tick 恰好一个有界单元）。 */
async function driveToTerminal(database, deps, workspaceId, { maxSteps = 200, onStep = null } = {}) {
  const steps = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const result = await runMaintenanceStep(database, deps, { workspaceId });
    steps.push(result);
    onStep?.(result, i);
    if (result.done || result.failed || result.run.status === 'failed') return { steps, result: steps.at(-1) };
  }
  throw new Error(`维护 run 在 ${maxSteps} 步内未收敛（status=${steps.at(-1)?.run.status} phase=${steps.at(-1)?.run.phase}）。`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ 1. 启动幂等 ============

test('WMB-5236 start: idempotent on active run; new run after completed; rejects other workspace', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    const first = startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
    assert.equal(first.created, true, '首启新建 run');
    assert.equal(first.run.status, 'running');
    assert.equal(first.run.phase, 'scan_compile');

    const again = startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
    assert.equal(again.created, false, '重复 start 幂等（不新建）');
    assert.equal(again.run.runId, first.run.runId, '同一 runId');

    // paused 也幂等
    const paused = pauseMaintenanceRun(database, ws);
    assert.equal(paused.status, 'paused');
    const afterPause = startMaintenanceRun(database, { workspaceId: ws });
    assert.equal(afterPause.created, false, 'paused 仍视为活动 run，start 幂等返回');
    assert.equal(afterPause.run.status, 'paused');

    // 恢复后跑到完成 → start 开启新一轮
    resumeMaintenanceRun(database, ws);
    await driveToTerminal(database, deps, ws);
    const completed = getMaintenanceRun(database);
    assert.equal(completed.status, 'completed');
    const next = startMaintenanceRun(database, { workspaceId: ws });
    assert.equal(next.created, true, 'completed 后 start 开启新一轮');
    assert.notEqual(next.run.runId, completed.runId);

    // 跨 workspace 拒绝（run 存在时以其它 workspaceId 操作一律拒绝）
    const other = `ws-${randomUUID()}`;
    assert.throws(() => startMaintenanceRun(database, { workspaceId: other }), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
    assert.throws(() => getMaintenanceStatus(database, other), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
    assert.throws(() => pauseMaintenanceRun(database, other), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
    assert.throws(() => resumeMaintenanceRun(database, other), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 2. 预算续跑（有界批次连续调度到 checkpoint completed）+ 完成报告数字 ============

test('WMB-5236 budget continuation: bounded ticks drive backfill to checkpoint completed; report numbers come from checkpoint/DB', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    const seeded = [];
    for (let i = 0; i < 5; i += 1) seeded.push(seedEligibleSource(database, `src-budget-${i}`));
    const compiledIds = seeded.map((entry) => entry.source.id).sort();

    const start = startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
    assert.equal(start.run.config.batchLimit, 2, '预算冻结进 run');

    const backfillDeltas = [];
    let previousProcessed = 0;
    const { result } = await driveToTerminal(database, deps, ws, {
      onStep: (stepResult) => {
        const cp = getKnowledgeBackfillCheckpoint(database);
        if (cp) backfillDeltas.push(cp.counts.processed - previousProcessed);
        if (cp) previousProcessed = cp.counts.processed;
        void stepResult;
      }
    });

    assert.equal(result.run.status, 'completed', 'run 完成');
    assert.equal(result.run.phase, 'completed');
    const backfillTicks = backfillDeltas.length;
    assert.ok(backfillTicks >= 3, `5 个 Source / batchLimit=2 至少 3 个回溯 tick（实际 ${backfillTicks}）`);
    for (const delta of backfillDeltas) {
      assert.ok(delta <= 2, `每 tick 处理的 Source 不超过 batchLimit（delta=${delta}）`);
    }

    // 报告数字来自 checkpoint/DB
    const backfillCp = getKnowledgeBackfillCheckpoint(database);
    assert.equal(backfillCp.status, 'completed', '回溯 checkpoint completed');
    assert.equal(backfillCp.counts.compiled, 5, '编译 5 个 Source');
    const lintCp = getPeriodicLintCheckpoint(database);
    assert.equal(lintCp.status, 'completed', 'lint checkpoint completed');

    const status = getMaintenanceStatus(database, ws);
    const report = status.report;
    assert.ok(report, '完成报告存在');
    assert.equal(report.runId, result.run.runId, '报告归属本 run');
    assert.equal(report.backfill.runId, backfillCp.runId);
    assert.equal(report.backfill.scanned, backfillCp.counts.scanned);
    assert.equal(report.backfill.processed, backfillCp.counts.processed);
    assert.equal(report.backfill.compiled, backfillCp.counts.compiled, '报告 compiled 数字来自 checkpoint');
    assert.equal(report.backfill.failed, backfillCp.counts.failed);
    assert.deepEqual(report.backfill.pendingRetry, backfillCp.pendingRetry);
    assert.equal(report.lint.runId, lintCp.runId);
    assert.equal(report.lint.steps, lintCp.step, '报告 Lint steps 来自 checkpoint');
    assert.equal(report.lint.scannedObjects, lintCp.counts.scannedObjects);
    assert.equal(report.lint.openIssues, countOpenHealthIssues(database), 'openIssues 来自 DB');
    assert.deepEqual(report.changedSources, compiledIds, '改动文件 = 本 run 编译成功的 Source id（来自 operation_log）');
    assert.ok(report.startedAt && report.completedAt, '报告含开始/结束时间');
    assert.ok(report.startedAt <= report.completedAt);
    assert.ok(Array.isArray(report.failures) && Array.isArray(report.risks), '报告含失败摘要与已知风险');
    assert.equal(report.workspaceId, ws);
    assert.equal(count(database, 'knowledge_update_receipts'), 5, '每个 (source, revision, topic) 一个回执');

    // 持久读模型可独立读取
    const persistedReport = getMaintenanceReport(database);
    assert.deepEqual(persistedReport, report, '报告落 app_meta KV（重启后可读）');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 3. 暂停 / 继续（批次边界；paused 不占执行） ============

test('WMB-5236 pause/resume: pause at batch boundary, paused does not execute, resume continues along checkpoint', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    for (let i = 0; i < 4; i += 1) seedEligibleSource(database, `src-pause-${i}`);

    startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
    const step1 = await runMaintenanceStep(database, deps, { workspaceId: ws });
    assert.equal(step1.run.status, 'running');
    const processedAfterStep1 = getKnowledgeBackfillCheckpoint(database).counts.processed;

    const paused = pauseMaintenanceRun(database, ws);
    assert.equal(paused.status, 'paused', '暂停生效');
    assert.equal(pauseMaintenanceRun(database, ws).status, 'paused', 'paused 再次 pause 幂等返回（不抛）');

    // paused 不占执行：继续 step 不推进任何状态
    const skipped = await runMaintenanceStep(database, deps, { workspaceId: ws });
    assert.equal(skipped.changed, false, 'paused 时 tick 不执行');
    assert.equal(skipped.run.status, 'paused');
    assert.equal(getKnowledgeBackfillCheckpoint(database).counts.processed, processedAfterStep1, 'checkpoint 未被推进');
    assert.equal(getKnowledgeBackfillCheckpoint(database).counts.scanned, 2, '扫描停在暂停点');

    const resumed = resumeMaintenanceRun(database, ws);
    assert.equal(resumed.status, 'running', 'resume 恢复执行');
    const step2 = await runMaintenanceStep(database, deps, { workspaceId: ws });
    assert.equal(step2.changed, true, 'resume 后沿 checkpoint 继续');
    assert.equal(getKnowledgeBackfillCheckpoint(database).counts.processed, processedAfterStep1 + 2, '续跑不重扫不重复编译');

    await driveToTerminal(database, deps, ws);
    assert.equal(getMaintenanceRun(database).status, 'completed');
    assert.equal(count(database, 'knowledge_update_receipts'), 4, '最终 4 个回执（无重复编译）');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 4. 失败恢复 ============

test('WMB-5236 failure recovery: run-level fail keeps error, resume continues; backfill stall fails run, resume after fix completes', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const bad = new Set();
    const deps = maintenanceDepsFor(root, modelOf({ bad }));
    seedEligibleSource(database, 'src-fail-recover');

    // 4a. run 级失败：保留错误 → resume 继续
    startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
    failMaintenanceRun(database, ws, { code: 'MAINTENANCE_TEST_BOOM', message: '模拟基础设施失败。' });
    const failed = getMaintenanceRun(database);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'MAINTENANCE_TEST_BOOM', '失败保留错误');
    const statusFailed = getMaintenanceStatus(database, ws);
    assert.equal(statusFailed.run.error.code, 'MAINTENANCE_TEST_BOOM');

    resumeMaintenanceRun(database, ws);
    const afterResume = getMaintenanceRun(database);
    assert.equal(afterResume.status, 'running');
    // 错误保留到下一次成功推进；失败后 resume 允许继续直到完成
    const { result } = await driveToTerminal(database, deps, ws, { maxSteps: 100 });
    assert.equal(result.run.status, 'completed', 'run 级失败 resume 后可完成');
    assert.equal(result.run.error, null, '成功推进后错误清除');
    assert.equal(getMaintenanceRun(database).reportId, `report:${result.run.runId}`);

    // 4b. 回溯停滞：模型持续失败 → stall 检测 fail run（保留错误）→ 修复 → resume → 完成
    const stalledSource = seedEligibleSource(database, 'src-fail-recover-2');
    bad.add(stalledSource.source.id);
    const start2 = startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2, stallLimit: 3 });
    assert.equal(start2.created, true, 'completed 后新一轮');
    const stalled = await driveToTerminal(database, deps, ws, { maxSteps: 100 });
    assert.equal(stalled.result.run.status, 'failed', '持续失败触发停滞 fail');
    assert.equal(stalled.result.run.error.code, 'MAINTENANCE_BACKFILL_STALLED');
    assert.equal(stalled.result.failed, true);
    assert.equal(getMaintenanceRun(database).error.code, 'MAINTENANCE_BACKFILL_STALLED', '停滞错误保留');

    // 修复模型（不再失败）→ resume → 重试成功 → 完成
    bad.delete(stalledSource.source.id);
    resumeMaintenanceRun(database, ws);
    const { result: recovered } = await driveToTerminal(database, deps, ws, { maxSteps: 100 });
    assert.equal(recovered.run.status, 'completed', '修复后 resume 完成');
    const report2 = getMaintenanceStatus(database, ws).report;
    assert.ok(report2.changedSources.includes(stalledSource.source.id), '重试成功的 Source 计入改动文件');
    assert.ok(report2.backfill.failed >= 1, '报告记录曾失败（checkpoint 计数）');
    assert.ok(report2.risks.some((risk) => risk.includes('失败')), '已知风险含失败摘要');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 5. 重启恢复（重新打开 DB / 新 deps 沿持久 checkpoint 继续） ============

test('WMB-5236 restart recovery: persisted running run continues after fresh connections with same runId, zero duplicate receipts', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    for (let i = 0; i < 6; i += 1) seedEligibleSource(database, `src-restart-${i}`);

    startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
    const step1 = await runMaintenanceStep(database, deps, { workspaceId: ws });
    const step2 = await runMaintenanceStep(database, deps, { workspaceId: ws });
    assert.equal(step1.run.phase, 'scan_compile');
    assert.equal(step2.run.phase, 'scan_compile', '重启前仍在回溯阶段（预算续跑中）');
    assert.equal(step2.run.status, 'running');
    assert.equal(getKnowledgeBackfillCheckpoint(database).counts.processed, 4, '2 个 tick 各处理 2 个 Source');
    const runIdBefore = step2.run.runId;
    database.close();
    database = null;

    // 模拟重启：全新连接 + 全新 deps；run 状态与 checkpoint 全部来自 SQLite
    const reopened = migrateDatabase(path.join(root, 'wmb.db'));
    database = reopened;
    const freshDeps = maintenanceDepsFor(root, modelOf());
    const resumed = await runMaintenanceStep(database, freshDeps, { workspaceId: ws });
    assert.equal(resumed.run.runId, runIdBefore, '重启后沿同一 run 继续');
    assert.equal(resumed.run.status, 'running');

    await driveToTerminal(database, freshDeps, ws);
    const finished = getMaintenanceRun(database);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.runId, runIdBefore);
    assert.equal(count(database, 'knowledge_update_receipts'), 6, '重启续跑零重复编译');
    assert.ok(getMaintenanceReport(database), '重启后报告可读');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 6. 空库 ============

test('WMB-5236 empty library: run completes quickly with zero-count report', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });

    const { steps, result } = await driveToTerminal(database, deps, ws, { maxSteps: 50 });
    assert.equal(result.run.status, 'completed', '空库 run 完成');
    assert.equal(result.done, true);
    // 固定编排阶段推导：1 个空回溯批次 + 14 个 lint phase 各一页 + 1 个报告 tick = 16。
    assert.equal(steps.length, 16, `空库 tick 数 = 1 回溯 + 14 lint phase + 1 报告（实际 ${steps.length}）`);

    const report = getMaintenanceStatus(database, ws).report;
    assert.ok(report);
    assert.equal(report.backfill.scanned, 0);
    assert.equal(report.backfill.processed, 0);
    assert.equal(report.backfill.compiled, 0);
    assert.equal(report.lint.scannedObjects, 0);
    assert.deepEqual(report.changedSources, [], '空库无改动文件');
    assert.equal(report.lint.steps, 14, '周期 Lint 14 个 phase 各一步（WMB-5237 v2 检测器全集）');
    assert.equal(getMaintenanceRun(database).phase, 'completed');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 7. 广播（knowledge/topics/health/receipt/library） ============

test('WMB-5236 broadcast: completion emits knowledge/topics/health/receipt/library scopes', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    seedEligibleSource(database, 'src-broadcast');
    const events = [];
    setDataChangedPublisher((event) => events.push(event));
    try {
      startMaintenanceRun(database, { workspaceId: ws, batchLimit: 2 });
      await driveToTerminal(database, deps, ws);
      await sleep(80); // 等广播 coalesce flush
    } finally {
      setDataChangedPublisher(null);
    }
    const allScopes = new Set(events.flatMap((event) => event.scopes));
    for (const scope of ['knowledge', 'topics', 'health', 'receipt', 'library']) {
      assert.ok(allScopes.has(scope), `广播含 ${scope} scope`);
    }
    assert.ok(events.some((event) => event.reason?.includes('knowledge.maintenance')), '广播 reason 标识维护 run');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 8. 跨 workspace 拒绝（严格身份；不可跨 root） ============

test('WMB-5236 cross-workspace rejection: all APIs reject mismatched workspace identity', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    const deps = maintenanceDepsFor(root, modelOf());
    seedEligibleSource(database, 'src-cross-ws');
    startMaintenanceRun(database, { workspaceId: ws });

    const other = `ws-${randomUUID()}`;
    // 无 run 时 start 绑定自身 workspace；存在 run 时所有其它 workspace 操作拒绝
    assert.throws(() => startMaintenanceRun(database, { workspaceId: other }), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
    assert.throws(() => advanceMaintenanceRun(database, { workspaceId: other }), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
    assert.throws(() => failMaintenanceRun(database, other, { code: 'X', message: 'x' }), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');
    await assert.rejects(() => runMaintenanceStep(database, deps, { workspaceId: other }), (error) => error.code === 'MAINTENANCE_WORKSPACE_MISMATCH');

    // 独立 root：另一个工作空间数据库互不干扰（各自 run/checkpoint 隔离）
    const root2 = await makeRoot('wmb-5236-b-');
    let database2;
    let ws2;
    try {
      ({ database: database2, workspaceId: ws2 } = await makeDatabase(root2));
      const deps2 = maintenanceDepsFor(root2, modelOf());
      const start2 = startMaintenanceRun(database2, { workspaceId: ws2 });
      assert.equal(start2.created, true, '另一 root 独立 start');
      assert.notEqual(start2.run.runId, getMaintenanceRun(database).runId);
      await driveToTerminal(database2, deps2, ws2);
      assert.equal(getMaintenanceRun(database2).status, 'completed');
      // 原 root 的 run 状态不受影响
      assert.equal(getMaintenanceRun(database).status, 'running');
    } finally {
      database2?.close();
      await rm(root2, { recursive: true, force: true });
    }

    // 清理后无 run → status 返回空视图
    clearMaintenanceRun(database);
    assert.equal(getMaintenanceRun(database), null);
    const empty = getMaintenanceStatus(database, ws);
    assert.deepEqual(empty, emptyMaintenanceStatus(), '无 run 时空视图');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============ 9. advance 缺回溯 checkpoint fail-closed ============

test('WMB-5236 advance without backfill checkpoint fails closed (MAINTENANCE_BACKFILL_CHECKPOINT_MISSING)', async () => {
  const root = await makeRoot();
  let database;
  let ws;
  try {
    ({ database, workspaceId: ws } = await makeDatabase(root));
    startMaintenanceRun(database, { workspaceId: ws });
    // 生产拆法：调度器先在独立连接跑回溯批次再 advance；若批次从未执行，advance 必须 fail-closed
    assert.throws(() => advanceMaintenanceRun(database, { workspaceId: ws }), (error) => error.code === 'MAINTENANCE_BACKFILL_CHECKPOINT_MISSING');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});
