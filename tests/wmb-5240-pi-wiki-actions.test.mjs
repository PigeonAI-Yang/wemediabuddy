// WMB-5240：Pi/operator 全 Wiki 操作 —— main 侧受控执行器聚焦验收测试（本 worker：ImplementPiWikiActionExecutor）。
// 覆盖（合同逐项）：
//  1) 真实 SQLite 两工作空间零串扰（ingest/维护 run/索引互不可见）；
//  2) 未授权写拒绝（解析器缺 authority / 无 runtime / grant 不含命令 → TASK_SCOPE_BROADENED 零写）；
//  3) requestId 重放不重复（同 manifest 重放原回执、零重复 Source）；
//  4) 部分失败不虚报全成功（批量 ingest 逐项结果 overall='partial'）；
//  5) 不触碰人工最终发布（动作面无红线命令；执行后 publication 零行、无红线命令回执）；
//  6) 维护生命周期（start/status/pause/resume）、全局 Lint 有界步进、search/log/report 只读。
// 运行：node --test --test-concurrency=1 tests/wmb-5240-pi-wiki-actions.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// src/main 图（knowledge-maintenance → data-changed → app-window / ipc-pi-dock）含
// electron 值导入与无扩展名相对导入；bare Node ESM 无法解析，生产经 Vite bundler 解析。
// 与 tests/command-dispatcher.test.mjs 同款 inline hook：electron → 惰性 stub，无扩展名 → .ts。
const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow {',
  '  static getAllWindows() { return []; }',
  '  loadURL() { return Promise.resolve(); }',
  '  loadFile() { return Promise.resolve(); }',
  '}',
  "const app = { getAppPath: () => '', whenReady: () => Promise.resolve(), on: noop };",
  'const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };',
  "const safeStorage = { encryptString: (s) => Buffer.from(String(s), 'utf8'), decryptString: (b) => String(b) };",
  'export { app, BrowserWindow, ipcMain, safeStorage };',
  'export default { app, safeStorage };',
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  "      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };",
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { dispatchStartAgentTask } = await import('../src/main/agent-task-commands.ts');
const { ensureAutomaticTaskGrant, TASK_INTERNAL_COMMANDS } = await import('../src/main/task-grants.ts');
const { deskStandingCommands } = await import('../src/shared/agent-capabilities.ts');
const {
  executeWikiAction,
  WIKI_MAINTENANCE_COMMAND,
  WIKI_LINT_COMMAND,
  WIKI_INGEST_COMMAND
} = await import('../src/main/pi-wiki-actions.ts');
const { settleWikiActionForRound } = await import('../src/main/ipc-pi-dock.ts');
const {
  WIKI_ACTION_KINDS,
  WIKI_ACTION_MANIFEST_KEY,
  WIKI_WRITE_ACTION_KINDS,
  normalizeWikiActionManifest,
  extractWikiActionManifest,
  stripWikiActionBlock
} = await import('../src/shared/wiki-operator-protocol.ts');
const { searchWikiIndex } = await import('../src/main/knowledge-search.ts');
const { listKnowledgeLogEntries } = await import('../src/main/knowledge-global-log.ts');
const store = await import('../src/main/db/wiki-index-store.ts');
const triggers = await import('../src/main/wiki-index-triggers.ts');

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5240-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function openRuntime(prefix) {
  const root = await makeRoot(prefix);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const workspaceId = `ws-${randomUUID()}`;
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  database.close();
  const runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
  return { root, runtime, workspaceId };
}

const schedulerActor = { type: 'scheduler', id: 'wmb-5240', label: 'wmb-5240' };

/** 主管 dock 授权：desk lease + page 任务 + standing grant（覆盖 knowledge.maintenance/knowledge.lint/ingest）。 */
async function grantDesk(runtime, businessDate = '2026-08-14') {
  const lease = runtime.acquireWorkerLease(null, 'desk', 'desk');
  const started = await dispatchStartAgentTask(runtime, {
    intent: 'page_today',
    businessDate,
    contextRefs: { roleId: 'desk', page: 'today' }
  }, { actor: schedulerActor, requestId: randomUUID(), workerLeaseId: lease.leaseId });
  runtime.bindWorkerTask(lease, started.task.id);
  const grantId = await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), 'desk');
  return { lease, taskId: started.task.id, grantId, workerLeaseId: lease.leaseId, commands: deskStandingCommands() };
}

/** 员工授权（reporter daily_scan：仅 report_progress + sources.upsert_batch；无维护/Lint 命令）。 */
async function grantReporter(runtime, businessDate = '2026-08-14') {
  const lease = runtime.acquireWorkerLease(null, 'reporter', 'employee');
  const started = await dispatchStartAgentTask(runtime, {
    intent: 'daily_scan',
    businessDate,
    contextRefs: { roleId: 'reporter', planDate: businessDate }
  }, { actor: schedulerActor, requestId: randomUUID(), workerLeaseId: lease.leaseId });
  runtime.bindWorkerTask(lease, started.task.id);
  const grantId = await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), 'reporter');
  return { lease, taskId: started.task.id, grantId, workerLeaseId: lease.leaseId };
}

function authority(auth, requestId) {
  return { requestId, taskId: auth.taskId, grantId: auth.grantId, workerLeaseId: auth.workerLeaseId };
}

function sourceItem(overrides = {}) {
  return {
    title: 'AgentForge v2 发布',
    originalUrl: `https://example.com/${randomUUID()}`,
    summary: '支持多模型路由，每百万 token 0.8 美元。',
    ...overrides
  };
}

function fenced(manifest) {
  return `回答正文。\n\n\`\`\`json\n${JSON.stringify({ [WIKI_ACTION_MANIFEST_KEY]: manifest })}\n\`\`\``;
}

async function withRuntime(prefix, work) {
  const { root, runtime, workspaceId } = await openRuntime(prefix);
  try {
    return await work({ root, runtime, workspaceId });
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

// ============ tests ============

test('0 grant registration: desk standing covers wiki write commands; employee grant does not', () => {
  const standing = new Set(deskStandingCommands());
  assert.ok(standing.has(WIKI_MAINTENANCE_COMMAND), 'knowledge.maintenance 必须进入 desk standing');
  assert.ok(standing.has(WIKI_LINT_COMMAND), 'knowledge.lint 必须进入 desk standing');
  assert.ok(standing.has(WIKI_INGEST_COMMAND), 'sources.upsert_batch 已在 desk standing');
  assert.ok(TASK_INTERNAL_COMMANDS.includes(WIKI_MAINTENANCE_COMMAND), 'task grant 签发硬门须登记维护命令');
  assert.ok(TASK_INTERNAL_COMMANDS.includes(WIKI_LINT_COMMAND), 'task grant 签发硬门须登记 lint 命令');
  // 红线命令绝不进入动作面（T-PUB-1/2）
  const redlines = ['publication.editor_prepare_execute', 'x_lists.operation_execute', 'intelligence_channels.proposal_apply', 'knowledge:delete-source'];
  for (const redline of redlines) assert.equal(standing.has(redline) && WIKI_ACTION_KINDS.includes(redline), false);
});

test('1 maintain lifecycle via executor (pi actor, desk grant): start → status → pause → resume', async () => {
  await withRuntime('wmb-5240-maint-', async ({ runtime, workspaceId }) => {
    const auth = await grantDesk(runtime);
    try {
      const start = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'start', ...authority(auth, 'maint:start:1') }, { actor: 'pi' });
      assert.equal(start.ok, true);
      assert.equal(start.overall, 'succeeded');
      assert.equal(start.action, 'maintain');
      const run = start.data.run;
      assert.equal(run.workspaceId, workspaceId);
      assert.equal(run.status, 'running');
      assert.equal(start.receipts.length, 1);
      assert.equal(start.receipts[0].command, WIKI_MAINTENANCE_COMMAND);
      assert.equal(start.receipts[0].actor.type, 'pi');

      // start 幂等重放：同 requestId 重放原回执（same run，零新建）
      const replay = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'start', ...authority(auth, 'maint:start:1') }, { actor: 'pi' });
      assert.equal(replay.ok, true);
      assert.equal(replay.overall, 'succeeded', '重放返回原回执（created=true 表示该 requestId 确已创建）');
      assert.equal(replay.data.run.runId, run.runId);
      assert.equal(runtime.database.prepare("SELECT COUNT(*) AS c FROM command_receipts WHERE command = 'knowledge.maintenance'").get().c, 1, '重放不新增维护回执');

      // 新 requestId + 既有 run → 幂等复用（created=false → no_op，不新建）
      const reuse = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'start', ...authority(auth, 'maint:start:2') }, { actor: 'pi' });
      assert.equal(reuse.ok, true);
      assert.equal(reuse.overall, 'no_op');
      assert.equal(reuse.data.run.runId, run.runId);

      const status = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'status', requestId: 'maint:status:1' }, { actor: 'pi' });
      assert.equal(status.ok, true);
      assert.equal(status.data.run.status, 'running');

      const pause = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'pause', ...authority(auth, 'maint:pause:1') }, { actor: 'pi' });
      assert.equal(pause.ok, true);
      assert.equal(pause.data.run.status, 'paused');

      const resume = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'resume', ...authority(auth, 'maint:resume:1') }, { actor: 'pi' });
      assert.equal(resume.ok, true);
      assert.equal(resume.data.run.status, 'running');

      // report：run 未完成 → 低价值 no_op 且保留原资料
      const report = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'report', requestId: 'maint:report:1' }, { actor: 'pi' });
      assert.equal(report.ok, true);
      assert.equal(report.overall, 'no_op');
      assert.equal(report.data.report, null);
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('2 unauthorized write rejected: parser gate, no-runtime gate, grant-scope gate (zero write)', async () => {
  // 2a 解析器硬门：写动作缺 authority → fail-closed reject（零写零执行）
  const parsed = normalizeWikiActionManifest({ action: 'ingest', requestId: 'ingest:noauth', items: [sourceItem()] });
  assert.equal(parsed.manifest, null);
  assert.equal(parsed.reject.code, 'WIKI_ACTION_AUTHORITY_REQUIRED');

  const parsedMaintain = normalizeWikiActionManifest({ action: 'maintain', subaction: 'start', requestId: 'maint:noauth' });
  assert.equal(parsedMaintain.manifest, null);
  assert.equal(parsedMaintain.reject.code, 'WIKI_ACTION_AUTHORITY_REQUIRED');

  await withRuntime('wmb-5240-noauth-', async ({ runtime }) => {
    // 2b 执行器硬门：无活动 runtime → WIKI_ACTION_RUNTIME_UNAVAILABLE（读面无 DB 同样拒绝）
    const noRuntime = await executeWikiAction({}, { action: 'ingest', requestId: 'ingest:nort', taskId: 't', grantId: 'g', workerLeaseId: 'w', items: [sourceItem()] }, { actor: 'pi' });
    assert.equal(noRuntime.ok, false);
    assert.equal(noRuntime.error.code, 'WIKI_ACTION_RUNTIME_UNAVAILABLE');

    // 2c grant 硬门：员工（reporter）grant 不含 knowledge.maintenance → TASK_SCOPE_BROADENED，run 零创建
    const auth = await grantReporter(runtime);
    try {
      const blocked = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'start', ...authority(auth, 'maint:reporter:1') }, { actor: 'pi' });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error.code, 'TASK_SCOPE_BROADENED');
      assert.ok(blocked.receipts.length >= 1, '被拒回执作为证据落库');
      assert.equal(runtime.database.prepare("SELECT COUNT(*) AS c FROM app_meta WHERE key='wmb_knowledge_maintenance_v1'").get().c, 0, '无维护 run KV 写入（零业务写）');
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('3 ingest single + requestId replay does not duplicate', async () => {
  await withRuntime('wmb-5240-ingest-', async ({ runtime }) => {
    const auth = await grantDesk(runtime);
    try {
      const manifest = { action: 'ingest', ...authority(auth, 'ingest:replay:1'), items: [sourceItem()] };
      const first = await executeWikiAction({ runtime }, manifest, { actor: 'pi' });
      assert.equal(first.ok, true);
      assert.equal(first.overall, 'succeeded');
      assert.equal(first.data.failed, 0);
      assert.equal(first.data.items.length, 1);
      const sourceId = first.data.items[0].id;
      assert.equal(count(runtime.database, 'source_items'), 1);

      // 同 requestId + 同输入重放：dispatcher 原回执，零重复
      const replay = await executeWikiAction({ runtime }, manifest, { actor: 'pi' });
      assert.equal(replay.ok, true);
      assert.equal(replay.data.items[0].id, sourceId);
      assert.equal(count(runtime.database, 'source_items'), 1, '重放不重复');

      // 同 requestId + 异输入 → REQUEST_REPLAY_CONFLICT（零写，保持原回执语义）
      const conflict = await executeWikiAction({ runtime }, { action: 'ingest', ...authority(auth, 'ingest:replay:1'), items: [sourceItem({ title: '不同的标题' })] }, { actor: 'pi' });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.error.code, 'REQUEST_REPLAY_CONFLICT');
      assert.equal(count(runtime.database, 'source_items'), 1);

      // 批量重放（T-RE 形状：内层 requestId = 外层 requestId + item 索引确定性派生）：
      // 同 requestId + 同 items 两次 → 内层全部命中原回执、source_items 行数不变
      const batchManifest = {
        action: 'ingest',
        ...authority(auth, 'ingest:batchreplay:1'),
        items: [sourceItem(), sourceItem()]
      };
      const batchFirst = await executeWikiAction({ runtime }, batchManifest, { actor: 'pi' });
      assert.equal(batchFirst.ok, true);
      assert.equal(batchFirst.data.failed, 0);
      assert.equal(count(runtime.database, 'source_items'), 3);
      const batchReceiptIds = new Set(batchFirst.receipts.map((receipt) => receipt.receiptId));
      assert.equal(batchFirst.receipts.length, 2, '2 个 item → 2 个内层回执');

      const batchReplay = await executeWikiAction({ runtime }, batchManifest, { actor: 'pi' });
      assert.equal(batchReplay.ok, true);
      assert.equal(batchReplay.data.failed, 0);
      assert.equal(count(runtime.database, 'source_items'), 3, '批量重放零增量');
      assert.deepEqual(
        new Set(batchReplay.receipts.map((receipt) => receipt.receiptId)),
        batchReceiptIds,
        '批量重放内层全部命中原回执（同回执集）'
      );
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('4 ingest partial failure is reported honestly (overall=partial, per-item results)', async () => {
  await withRuntime('wmb-5240-partial-', async ({ runtime }) => {
    const auth = await grantDesk(runtime);
    try {
      // 先入库一条已知 source（revision 1）
      const seedItem = sourceItem();
      const seed = await executeWikiAction({ runtime }, { action: 'ingest', ...authority(auth, 'ingest:seed:1'), items: [seedItem] }, { actor: 'pi' });
      assert.equal(seed.ok, true);
      const existing = seed.data.items[0].id;
      assert.equal(count(runtime.database, 'source_items'), 1);

      // 批量：[新条目成功] + [同 URL 但 expectedRevision 冲突失败] → partial，绝不虚报全成功
      const batch = await executeWikiAction({ runtime }, {
        action: 'ingest',
        ...authority(auth, 'ingest:batch:1'),
        items: [
          sourceItem(),
          { title: '已存在的资料', originalUrl: seedItem.originalUrl, expectedRevision: 99 }
        ]
      }, { actor: 'pi' });
      assert.equal(batch.ok, true);
      assert.equal(batch.overall, 'partial', '部分失败必须显式 partial');
      assert.equal(batch.data.total, 2);
      assert.equal(batch.data.failed, 1);
      const okItem = batch.data.items.find((item) => item.ok === true);
      const badItem = batch.data.items.find((item) => item.ok === false);
      assert.ok(okItem && badItem, '逐项结果完整');
      assert.equal(count(runtime.database, 'source_items'), 2, '合法项已入库、失败项零写');
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('5 two real SQLite workspaces have zero crosstalk (ingest / maintenance run / status)', async () => {
  const a = await openRuntime('wmb-5240-ws-a-');
  const b = await openRuntime('wmb-5240-ws-b-');
  try {
    const authA = await grantDesk(a.runtime, '2026-08-14');
    const authB = await grantDesk(b.runtime, '2026-08-14');
    try {
      // ws A：ingest + maintain start
      const ingestA = await executeWikiAction({ runtime: a.runtime }, { action: 'ingest', ...authority(authA, 'ws-a:ingest:1'), items: [sourceItem({ title: '仅属于工作空间 A 的资料' })] }, { actor: 'pi' });
      assert.equal(ingestA.ok, true);
      const startA = await executeWikiAction({ runtime: a.runtime }, { action: 'maintain', subaction: 'start', ...authority(authA, 'ws-a:maint:1') }, { actor: 'pi' });
      assert.equal(startA.ok, true);

      // ws B：不可见 A 的任何对象
      assert.equal(count(b.runtime.database, 'source_items'), 0, 'B 看不到 A 的资料');
      const statusB = await executeWikiAction({ runtime: b.runtime }, { action: 'maintain', subaction: 'status', requestId: 'ws-b:status:1' }, { actor: 'pi' });
      assert.equal(statusB.ok, true);
      assert.equal(statusB.data.run, null, 'B 看不到 A 的维护 run');

      // ws B 可独立写入自己的 run
      const startB = await executeWikiAction({ runtime: b.runtime }, { action: 'maintain', subaction: 'start', ...authority(authB, 'ws-b:maint:1') }, { actor: 'pi' });
      assert.equal(startB.ok, true);
      assert.equal(startB.data.run.workspaceId, b.workspaceId);
      assert.equal(startB.data.run.runId !== startA.data.run.runId, true);

      // 互不串扰：A 的 run 仍是 A 的 workspaceId
      const statusA = await executeWikiAction({ runtime: a.runtime }, { action: 'maintain', subaction: 'status', requestId: 'ws-a:status:1' }, { actor: 'pi' });
      assert.equal(statusA.data.run.workspaceId, a.workspaceId);
    } finally {
      a.runtime.releaseWorker(authA.lease);
      b.runtime.releaseWorker(authB.lease);
    }
  } finally {
    await Promise.allSettled([
      a.runtime.stop({ drain: false }).catch(() => {}),
      b.runtime.stop({ drain: false }).catch(() => {})
    ]);
    await Promise.allSettled([
      rm(a.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(b.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    ]);
  }
});

test('6 global lint: run=true executes one bounded step via dispatcher; read returns checkpoint', async () => {
  await withRuntime('wmb-5240-lint-', async ({ runtime }) => {
    const auth = await grantDesk(runtime);
    try {
      const run = await executeWikiAction({ runtime }, { action: 'lint', run: true, ...authority(auth, 'lint:run:1') }, { actor: 'pi' });
      assert.equal(run.ok, true);
      assert.equal(run.overall, 'succeeded');
      assert.equal(run.receipts[0].command, WIKI_LINT_COMMAND);
      assert.ok(run.data.checkpoint.runId, 'checkpoint 已创建');
      assert.equal(typeof run.data.counts.scannedObjects, 'number');

      // 只读面：checkpoint + openIssues
      const status = await executeWikiAction({ runtime }, { action: 'lint', requestId: 'lint:status:1' }, { actor: 'pi' });
      assert.equal(status.ok, true);
      assert.ok(status.data.checkpoint !== null);
      assert.equal(typeof status.data.openIssues, 'number');
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('7 read surfaces: search (empty query → empty page; after ingest finds source) and log (receipt events)', async () => {
  await withRuntime('wmb-5240-read-', async ({ runtime }) => {
    // 接线真实索引投影（生产 index.ts 启动时同构）
    triggers.setWikiIndexProjectionApi({
      upsertIndexEntries: store.upsertIndexEntries,
      removeIndexEntries: store.removeIndexEntries,
      rebuildWikiIndex: store.rebuildWikiIndex
    });
    triggers.registerWikiIndexProjection();
    const auth = await grantDesk(runtime);
    try {
      // 空查询 → 空页（契约固定，非全量分页）
      const emptySearch = await executeWikiAction({ runtime }, { action: 'search', requestId: 'search:1', query: '' }, { actor: 'pi' });
      assert.equal(emptySearch.ok, true);
      assert.equal(emptySearch.data.items.length, 0);
      assert.equal(emptySearch.data.total, 0);

      // ingest 后搜索命中（Source 经投影进入索引）
      const title = `可搜索资料-${randomUUID().slice(0, 6)}`;
      const ingest = await executeWikiAction({ runtime }, { action: 'ingest', ...authority(auth, 'read:ingest:1'), items: [sourceItem({ title })] }, { actor: 'pi' });
      assert.equal(ingest.ok, true);
      const found = await executeWikiAction({ runtime }, { action: 'search', requestId: 'search:2', query: title, limit: 10 }, { actor: 'pi' });
      assert.equal(found.ok, true);
      assert.ok(found.data.items.some((item) => item.objectType === 'source'), '搜索命中已摄取 Source');

      // 维护 run 启动 → 全局日志 maintenance_started 锚点
      const started = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'start', ...authority(auth, 'read:maint:1') }, { actor: 'pi' });
      assert.equal(started.ok, true);

      // 全局日志：维护 run 启动锚点可见（派生读模型；ingest 的 command 回执属命令层，不在此日志）
      const log = await executeWikiAction({ runtime }, { action: 'log', requestId: 'log:1', limit: 20 }, { actor: 'pi' });
      assert.equal(log.ok, true);
      assert.ok(Array.isArray(log.data.items));
      assert.ok(log.data.items.some((entry) => entry.eventType === 'maintenance_started'), '日志含维护 run 启动事件');

      // 索引摘要一致性（等价读模型）
      const summary = await executeWikiAction({ runtime }, { action: 'search', requestId: 'search:3', query: title, limit: 1 }, { actor: 'pi' });
      assert.equal(summary.ok, true);
      assert.ok(summary.data.total >= 1);
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('8 no manual-final-publish touch: lifecycle leaves zero publication rows and zero redline receipts', async () => {
  await withRuntime('wmb-5240-pub-', async ({ runtime }) => {
    const auth = await grantDesk(runtime);
    try {
      await executeWikiAction({ runtime }, { action: 'ingest', ...authority(auth, 'pub:ingest:1'), items: [sourceItem()] }, { actor: 'pi' });
      await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'start', ...authority(auth, 'pub:maint:1') }, { actor: 'pi' });
      await executeWikiAction({ runtime }, { action: 'lint', run: true, ...authority(auth, 'pub:lint:1') }, { actor: 'pi' });

      const redlineCommands = ['publication.editor_prepare_execute', 'x_lists.operation_execute', 'intelligence_channels.proposal_apply'];
      const receipts = runtime.database.prepare('SELECT command FROM command_receipts').all();
      for (const row of receipts) {
        assert.equal(redlineCommands.includes(row.command), false, `动作面不得产生红线命令回执：${row.command}`);
      }
      // publication 表零行（快照/指标均未触碰；publication_results 无独立表）
      for (const table of ['publication_snapshots', 'publication_metric_snapshots']) {
        assert.equal(count(runtime.database, table), 0, `${table} 必须保持零行`);
      }
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('9 settleWikiActionForRound: no fence → null; valid read fence → executed + stripped; rejected write fence → visible reject', async () => {
  await withRuntime('wmb-5240-settle-', async ({ runtime, root }) => {
    const dataRoot = { path: root, isNew: false };
    const deps = { getActiveRuntime: () => runtime };
    const auth = await grantDesk(runtime);
    try {
      // 无围栏 → 零执行，正文原样
      const none = await settleWikiActionForRound(deps, dataRoot, { conversationId: 'c1', question: 'q', answerText: '普通回答' });
      assert.equal(none.wiki, null);
      assert.equal(none.reject, null);
      assert.equal(none.text, '普通回答');

      // 合法只读围栏（maintain status）→ 执行 + 围栏剥离（无 run 时诚实返回空状态）
      const valid = await settleWikiActionForRound(deps, dataRoot, {
        conversationId: 'c2',
        question: 'q',
        answerText: fenced({ action: 'maintain', subaction: 'status', requestId: 'settle:status:1' })
      });
      assert.ok(valid.wiki, '合法清单必须执行');
      assert.equal(valid.wiki.ok, true);
      assert.equal(valid.wiki.data.run, null, '无 run 时状态投影诚实为空');
      assert.equal(valid.text.includes('```json'), false, '协议围栏从用户可见正文剥离');

      // 非法写围栏（缺 authority）→ 零执行 + 用户可见 reject 原因
      const rejected = await settleWikiActionForRound(deps, dataRoot, {
        conversationId: 'c3',
        question: 'q',
        answerText: fenced({ action: 'ingest', requestId: 'settle:ingest:1', items: [sourceItem()] })
      });
      assert.equal(rejected.wiki, null);
      assert.equal(rejected.reject.code, 'WIKI_ACTION_AUTHORITY_REQUIRED');
      assert.equal(count(runtime.database, 'source_items'), 0, '被拒清单零写');

      // 合法写围栏（ingest，带 authority）→ 执行成功
      const written = await settleWikiActionForRound(deps, dataRoot, {
        conversationId: 'c4',
        question: 'q',
        answerText: fenced({ action: 'ingest', ...authority(auth, 'settle:ingest:2'), items: [sourceItem()] })
      });
      assert.ok(written.wiki && written.wiki.ok, '带授权的写围栏必须执行');
      assert.equal(count(runtime.database, 'source_items'), 1);
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('11 query action routes to fixed-version query executor; invalid ref → visible FIXED_VERSION_NOT_FOUND', async () => {
  await withRuntime('wmb-5240-query-', async ({ runtime }) => {
    const auth = await grantDesk(runtime);
    try {
      // 解析器要求 query 至少一个非空冻结版本引用列表；引用指向不存在的对象 → 服务端校验失败
      const parsed = normalizeWikiActionManifest({
        action: 'query',
        requestId: 'query:parse:1',
        wikiVersionRefs: ['wiki_page:missing-page:missing-version']
      });
      assert.ok(parsed.manifest, 'query 清单（固定版本引用）通过解析');
      assert.equal(parsed.manifest.action, 'query');
      assert.ok(Array.isArray(parsed.manifest.wikiVersionRefs));

      const result = await executeWikiAction({ runtime }, {
        action: 'query',
        requestId: 'query:run:1',
        wikiVersionRefs: ['wiki_page:missing-page:missing-version'],
        taskId: auth.taskId,
        grantId: auth.grantId,
        workerLeaseId: auth.workerLeaseId
      }, { actor: 'pi' });
      if (!result.ok && result.error.code === 'WIKI_ACTION_QUERY_UNAVAILABLE') {
        // 执行器未接线（fixed-version-query 未落地）时 fail-closed：动作级可见拒绝
        assert.match(result.error.message, /Query 执行器尚未注册/);
        return;
      }
      // 已接线：引用不存在 → 动作级失败 FIXED_VERSION_NOT_FOUND（零写，不虚报成功）
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'FIXED_VERSION_NOT_FOUND');
    } finally {
      runtime.releaseWorker(auth.lease);
    }
  });
});

test('10 shared parser surface: extract/strip/normalize contract stable for executor consumption', () => {
  const manifest = { action: 'report', requestId: 'proto:1' };
  const text = fenced(manifest);
  const parsed = extractWikiActionManifest(text);
  assert.ok(parsed.manifest, '围栏提取成功');
  assert.equal(parsed.manifest.action, 'report');
  assert.equal(stripWikiActionBlock(text), '回答正文。');
  // 写动作集合静态面（执行器写门依赖；Record 查找表）
  assert.deepEqual(Object.keys(WIKI_WRITE_ACTION_KINDS).sort(), ['ingest', 'lint', 'maintain']);
  assert.ok(WIKI_ACTION_KINDS.includes('query') && WIKI_ACTION_KINDS.includes('search') && WIKI_ACTION_KINDS.includes('log'));
});
