/**
 * WMB-5173/5174 生产阻塞：research.dispatch 调用方不可放大机器硬预算。
 *
 * - RESEARCH_DEFAULT_BUDGET 即机器硬上限（12 分钟 / 15 有效目标 / 40 候选 / 3 并行 / 1 轮）。
 * - resolveResearchBudget：逐键回落硬默认；合法下调保留；上调一律钳制到硬上限。
 * - dispatchResearchForEvidenceGap：spawn 的 gap.budget 已钳制（真实派单路径断言）。
 * - MCP research.dispatch schema：budget 字段暴露 maximum 硬上限，越界在 schema 层拒绝。
 *
 * 全部为真实 guarded runtime 测试：真实模块、真实 ActiveWorkspaceRuntime/JobSpawner、真实 MCP HTTP 服务。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';

// TS loader（与 wmb-5172/5173 同款）：解析 .ts 相对导入。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { JobSpawner } = await import('../src/main/job-spawner.ts');
const { buildJobContextRefs, buildJobObjectBoundary } = await import('../src/main/job-object-boundary.ts');
const { RESEARCH_DEFAULT_BUDGET, resolveResearchBudget } = await import('../src/main/research-job-runner.ts');
const { dispatchResearchForEvidenceGap } = await import('../src/main/research-dispatch.ts');
const { startMcp } = await import('../src/main/mcp.ts');

const BUSINESS_DATE = '2026-08-13';

function nowIso() {
  return new Date().toISOString();
}

/** 真实运行时（写守卫）：seed 在开库前于裸连接落盘，之后 work 用命令层/调度面。 */
async function withRuntime(seed, work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5173-budget-rt-'));
  let runtime;
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db')), now = nowIso();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`ws-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(db, 'official.ai');
    const seeds = await seed(db);
    db.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => `epoch-${randomUUID()}` });
    await work(runtime, seeds ?? {});
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function insertAgentTask(db, { id, intent, businessDate = BUSINESS_DATE, status = 'running', phase = 'starting', contextRefs = {} }) {
  const now = nowIso();
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at,
    error_code, error_message, created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, NULL)`).run(
    id, intent, businessDate, status, phase, JSON.stringify(contextRefs), JSON.stringify({}),
    JSON.stringify({}), JSON.stringify({}), null, null, now, now
  );
}

/** 父任务（原角色工单）：agent_tasks 行 + 持久续派合同 refs（与 runner onTaskReady 同构）。 */
function seedParent(db, { intent, roleId, projectId = null, businessDate = BUSINESS_DATE, taskId = `parent-${randomUUID()}`, jobId = `job-${randomUUID()}` }) {
  const request = roleId === 'writer'
    ? { roleId, brief: `父工单 ${roleId} brief`, projectId, writerTask: 'core_draft', businessDate }
    : roleId === 'planner'
      ? { roleId, brief: `父工单 ${roleId} brief`, businessDate }
      : { roleId, brief: `父工单 ${roleId} brief`, scope: 'workspace' };
  const boundary = buildJobObjectBoundary(request, roleId === 'librarian' ? null : businessDate);
  const refs = buildJobContextRefs({ jobId, request, boundary });
  insertAgentTask(db, { id: taskId, intent, businessDate, contextRefs: refs });
  return { taskId, jobId, businessDate, projectId: roleId === 'writer' ? projectId : null, request, refs };
}

function claim(key, text = `声明 ${key}`, type = 'fact') {
  return { key, text, type };
}

/** 捕获 spawn 请求（含 research gap 的完整 RoleJobRequest），供断言真实派单预算。 */
function fakeSpawner(runtime, { maxWorkers = 2 } = {}) {
  const spawned = [];
  return {
    spawner: new JobSpawner(runtime, {
      maxWorkers,
      execute: async (ctx) => {
        spawned.push({
          jobId: ctx.job.id,
          roleId: ctx.job.roleId,
          intent: ctx.job.intent,
          research: ctx.request?.research ?? null
        });
        return { status: 'succeeded', code: 'TEST_OK', message: null, readback: null };
      }
    }),
    spawned
  };
}

// ---------------------------------------------------------------------------
// 1. resolveResearchBudget：机器硬上限（极端上调钳制 / 单键钳制 / 混合 / 非法回落 / 默认）
// ---------------------------------------------------------------------------

test('WMB-5173: budget ceiling — 极端上调逐键钳制到 RESEARCH_DEFAULT_BUDGET（12/15/40/3/1）', () => {
  const amplified = resolveResearchBudget({
    timeMinutes: 9999, minValidSources: 999, maxCandidates: 99999, maxParallelFetches: 99, maxRounds: 99
  });
  assert.deepEqual(amplified, {
    timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1
  });
  assert.equal(amplified.timeMinutes, RESEARCH_DEFAULT_BUDGET.timeMinutes);
  assert.equal(amplified.minValidSources, RESEARCH_DEFAULT_BUDGET.minValidSources);
  assert.equal(amplified.maxCandidates, RESEARCH_DEFAULT_BUDGET.maxCandidates);
  assert.equal(amplified.maxParallelFetches, RESEARCH_DEFAULT_BUDGET.maxParallelFetches);
  assert.equal(amplified.maxRounds, RESEARCH_DEFAULT_BUDGET.maxRounds);
});

test('WMB-5173: budget ceiling — 单键上调钳制到该键上限，其余键回落硬默认', () => {
  assert.equal(resolveResearchBudget({ maxRounds: 5 }).maxRounds, 1);
  assert.equal(resolveResearchBudget({ maxParallelFetches: 9 }).maxParallelFetches, 3);
  assert.equal(resolveResearchBudget({ maxCandidates: 500 }).maxCandidates, 40);
  assert.equal(resolveResearchBudget({ timeMinutes: 120 }).timeMinutes, 12);
  assert.equal(resolveResearchBudget({ minValidSources: 100 }).minValidSources, 15);
  // 上调键之外的键仍回落硬默认（不随调用方部分上调放大）。
  const partial = resolveResearchBudget({ maxRounds: 5 });
  assert.equal(partial.maxCandidates, 40);
  assert.equal(partial.timeMinutes, 12);
  assert.equal(partial.minValidSources, 15);
  assert.equal(partial.maxParallelFetches, 3);
});

test('WMB-5173: budget ceiling — 合法下调保留，上调钳制（混合输入逐键独立）', () => {
  assert.deepEqual(
    resolveResearchBudget({ timeMinutes: 5, minValidSources: 8, maxCandidates: 10, maxParallelFetches: 2, maxRounds: 1 }),
    { timeMinutes: 5, minValidSources: 8, maxCandidates: 10, maxParallelFetches: 2, maxRounds: 1 }
  );
  const mixed = resolveResearchBudget({ timeMinutes: 5, minValidSources: 3, maxCandidates: 400, maxParallelFetches: 2, maxRounds: 1 });
  assert.deepEqual(mixed, { timeMinutes: 5, minValidSources: 3, maxCandidates: 40, maxParallelFetches: 2, maxRounds: 1 });
});

test('WMB-5173: budget ceiling — 缺省/非正数/NaN/Infinity 逐键回落硬默认', () => {
  assert.deepEqual(resolveResearchBudget(undefined), RESEARCH_DEFAULT_BUDGET);
  assert.deepEqual(resolveResearchBudget({}), RESEARCH_DEFAULT_BUDGET);
  assert.deepEqual(
    resolveResearchBudget({ timeMinutes: 0, minValidSources: -1, maxCandidates: NaN, maxParallelFetches: Infinity, maxRounds: 0 }),
    RESEARCH_DEFAULT_BUDGET
  );
});

// ---------------------------------------------------------------------------
// 2. dispatchResearchForEvidenceGap：真实派单路径的 gap.budget 已钳制
// ---------------------------------------------------------------------------

test('WMB-5173: dispatch — 调用方放大预算被钳制到机器硬上限（spawn 的 research gap 预算）', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner, spawned } = fakeSpawner(runtime);
  try {
    const result = dispatchResearchForEvidenceGap({
      spawner, database: runtime.database, parentTaskId: parent.taskId,
      requiredClaims: [claim('claim_a')],
      budget: { timeMinutes: 999, minValidSources: 99, maxCandidates: 9999, maxParallelFetches: 99, maxRounds: 99 }
    });
    assert.equal(result.ok, true);
    await spawner.await(result.spawnedJobId, 15_000);
    const job = spawned.find((entry) => entry.jobId === result.spawnedJobId);
    assert.ok(job, 'spawned research job 已执行');
    assert.equal(job.roleId, 'reporter');
    assert.ok(job.research, 'spawn 请求携带 research gap');
    assert.deepEqual(job.research.budget, { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 });
  } finally {
    spawner.dispose();
  }
}));

test('WMB-5173: dispatch — 缺省 budget 回落机器硬默认（spawn 的 research gap 预算）', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner, spawned } = fakeSpawner(runtime);
  try {
    const result = dispatchResearchForEvidenceGap({
      spawner, database: runtime.database, parentTaskId: parent.taskId,
      requiredClaims: [claim('claim_a')]
    });
    assert.equal(result.ok, true);
    await spawner.await(result.spawnedJobId, 15_000);
    const job = spawned.find((entry) => entry.jobId === result.spawnedJobId);
    assert.ok(job, 'spawned research job 已执行');
    assert.deepEqual(job.research.budget, { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 });
  } finally {
    spawner.dispose();
  }
}));

test('WMB-5173: dispatch — 合法下调保留、未提供键回落硬默认（spawn 的 research gap 预算）', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner, spawned } = fakeSpawner(runtime);
  try {
    const result = dispatchResearchForEvidenceGap({
      spawner, database: runtime.database, parentTaskId: parent.taskId,
      requiredClaims: [claim('claim_a')],
      budget: { timeMinutes: 5, minValidSources: 8, maxCandidates: 10, maxParallelFetches: 2, maxRounds: 1 }
    });
    assert.equal(result.ok, true);
    await spawner.await(result.spawnedJobId, 15_000);
    const job = spawned.find((entry) => entry.jobId === result.spawnedJobId);
    assert.ok(job, 'spawned research job 已执行');
    assert.deepEqual(job.research.budget, { timeMinutes: 5, minValidSources: 8, maxCandidates: 10, maxParallelFetches: 2, maxRounds: 1 });
  } finally {
    spawner.dispose();
  }
}));

// ---------------------------------------------------------------------------
// 3. MCP research.dispatch schema：maximum 硬上限暴露 + 越界 schema 层拒绝
// ---------------------------------------------------------------------------

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })
  });
  assert.ok(response.ok, `${method} returned ${response.status}`);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

/** 原样返回 JSON-RPC payload（tools/call 的 isError 结果与 schema 拒绝都走 result 而非 error）。 */
async function rawMcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })
  });
  assert.ok(response.ok, `${method} returned ${response.status}`);
  const body = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
}

/** research.dispatch 只在传入 ActiveWorkspaceRuntime 时注册（mcp.ts registerJobToolsMcp 分支）。 */
async function withMcpRuntime(work) {
  return withRuntime(async () => ({}), async (runtime) => {
    const mcp = await startMcp(runtime.identity.rootPath, runtime.gate, undefined, runtime);
    try {
      await work(mcp, runtime);
    } finally {
      await mcp.close();
    }
  });
}

test('WMB-5173: MCP research.dispatch schema 暴露机器硬上限（budget 字段 maximum=12/15/40/3/1）', () => withMcpRuntime(async (mcp) => {
  await mcpRequest(mcp.url, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-5173-budget-test', version: '1' }
  });
  const listed = await mcpRequest(mcp.url, 'tools/list', {});
  const tool = listed.data.tools.find((entry) => entry.name === 'research.dispatch');
  assert.ok(tool, 'research.dispatch 必须被列出');
  const budgetProps = tool.inputSchema?.properties?.budget?.properties ?? {};
  assert.equal(budgetProps.time_minutes?.maximum, RESEARCH_DEFAULT_BUDGET.timeMinutes);
  assert.equal(budgetProps.min_valid_sources?.maximum, RESEARCH_DEFAULT_BUDGET.minValidSources);
  assert.equal(budgetProps.max_candidates?.maximum, RESEARCH_DEFAULT_BUDGET.maxCandidates);
  assert.equal(budgetProps.max_parallel_fetches?.maximum, RESEARCH_DEFAULT_BUDGET.maxParallelFetches);
  assert.equal(budgetProps.max_rounds?.maximum, RESEARCH_DEFAULT_BUDGET.maxRounds);
}));

test('WMB-5173: MCP research.dispatch 越界 budget 在 schema 层拒绝（handler 不执行）', () => withMcpRuntime(async (mcp) => {
  await mcpRequest(mcp.url, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-5173-budget-test', version: '1' }
  });
  const payload = await rawMcpRequest(mcp.url, 'tools/call', {
    name: 'research.dispatch',
    arguments: {
      parent_task_id: 'parent-does-not-matter',
      required_claims: [{ key: 'claim_a', text: '声明 A', type: 'fact' }],
      budget: { max_rounds: 5, max_candidates: 999, time_minutes: 120 }
    }
  });
  assert.equal(payload.error, undefined, 'schema 拒绝走 tools/call isError 结果而非 JSON-RPC error');
  assert.equal(payload.result?.isError, true, '越界 budget 必须产生工具错误结果');
  const message = String(payload.result.content?.[0]?.text ?? '');
  assert.match(message, /research\.dispatch/, '错误信息点名 research.dispatch');
  assert.match(message, /max_rounds|max_candidates|time_minutes/, '错误信息点名越界字段');
}));

test('WMB-5173: MCP research.dispatch 合法 budget 通过 schema 并到达 handler（fail-closed 业务校验）', () => withMcpRuntime(async (mcp) => {
  await mcpRequest(mcp.url, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-5173-budget-test', version: '1' }
  });
  const payload = await rawMcpRequest(mcp.url, 'tools/call', {
    name: 'research.dispatch',
    arguments: {
      parent_task_id: 'ghost-parent',
      required_claims: [{ key: 'claim_a', text: '声明 A', type: 'fact' }],
      budget: { time_minutes: 5, max_candidates: 10, max_rounds: 1 }
    }
  });
  assert.equal(payload.error, undefined);
  assert.equal(payload.result?.isError, true, '合法 budget 通过 schema，handler 执行业务 fail-closed');
  const message = String(payload.result.content?.[0]?.text ?? '');
  assert.match(message, /父任务不存在/, 'handler 已执行（schema 接受合法下调值）');
}));
