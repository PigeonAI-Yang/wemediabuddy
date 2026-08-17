import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';

// TS loader（与 wmb-5172/5173/5174 同款）：解析 .ts 相对导入。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

// ---- 5169-5174 产品真源（验收测试复用真实路径，不做 source-text 检查） ----------
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { JobSpawner } = await import('../src/main/job-spawner.ts');
const { buildJobContextRefs, buildJobObjectBoundary } = await import('../src/main/job-object-boundary.ts');
const { RESEARCH_DEFAULT_BUDGET, runResearchJob, researchSourceKeyFor } = await import('../src/main/research-job-runner.ts');
const { buildResearchEvidencePack, parseResearchEvidencePack } = await import('../src/main/research-task-state.ts');
const { upsertResearchClaim } = await import('../src/main/db/research-claims-store.ts');
const { dispatchResearchForEvidenceGap, deriveResearchParentRole } = await import('../src/main/research-dispatch.ts');
const {
  RESEARCH_SUCCESSOR_ACTIONS,
  buildSuccessorBriefSuffix,
  decideResearchSuccessor,
  decideResearchSuccessorViaRuntime,
  enqueueResearchSuccessor,
  getResearchSuccessorById,
  isResearchSuccessorRow,
  kickResearchSuccessors,
  reconcileResearchSuccessors,
  researchSuccessorDedupeKey
} = await import('../src/main/research-successor.ts');
const { listResearchSuccessorNeedsUser, readCrewResearchSummary } = await import('../src/main/research-successor-projection.ts');
const { readCrewInstanceProjection } = await import('../src/main/crew-instance-projection.ts');
const { instanceStatusWord } = await import('../src/renderer/agents-instance-logic.ts');
const { validateClaimProposal, assessSupportThreshold, evidenceDomainOf } = await import('../src/main/research-claim-validation.ts');
const { canonicalizeUrl } = await import('../src/main/sources.ts');
const { readWebPage } = await import('../src/main/research-web-read.ts');
const { buildSaveSourcePayload } = await import('../.pi/extensions/wmb-mcp/wmb-mcp-tools-core.ts');
const { startMcp } = await import('../src/main/mcp.ts');
const { WorkspaceProposalStore } = await import('../src/main/workspace-proposals.ts');
const { IntelligenceChannelProposalStore } = await import('../src/main/intelligence-channel-proposals.ts');

const BUSINESS_DATE = '2026-08-13';
const BUDGET = { ...RESEARCH_DEFAULT_BUDGET };
const FIXTURE_DIR = new URL('./fixtures/glm52/', import.meta.url);

function fixture(name) {
  return readFile(new URL(name, FIXTURE_DIR), 'utf8');
}

const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const staticOk = (body, { status = 200, contentType = 'text/html' } = {}) => async () =>
  new Response(body, { status, headers: { 'content-type': contentType } });
const publicDns = () => async () => [{ address: '93.184.216.34', family: 4 }];

function nowIso() {
  return new Date().toISOString();
}

/** 裸库（无写守卫）：纯 DB 函数测试面。 */
async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5175-db-'));
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await work(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** 真实运行时（写守卫）：seed 在开库前于裸连接落盘，之后 work 用命令层/调度面。 */
async function withRuntime(seed, work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5175-rt-'));
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
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function insertAgentTask(db, { id, intent, businessDate = BUSINESS_DATE, status = 'running', phase = 'starting', contextRefs = {}, resultRefs = {}, progress = {}, checkpoint = {}, errorCode = null, errorMessage = null }) {
  const now = nowIso();
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at,
    error_code, error_message, created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, NULL)`).run(
    id, intent, businessDate, status, phase, JSON.stringify(contextRefs), JSON.stringify(resultRefs),
    JSON.stringify(progress), JSON.stringify(checkpoint), errorCode, errorMessage, now, now
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

/** research 任务：合同 refs（reporter + research 块）+ EvidencePack 落 result_refs。 */
function seedResearchTask(db, { parent, parentRoleId = 'writer', status = 'succeeded', taskId = `research-${randomUUID()}`, requiredClaims = [claim('claim_a')], unresolvedRequiredClaims = [], claims, terminalReason = 'claims_resolved', budget = BUDGET, progress = {} }) {
  const gap = {
    gapId: `gap-${taskId}`,
    parentJobId: parent.jobId,
    parentTaskId: parent.taskId,
    parentRoleId,
    requiredClaims,
    budget: { ...budget },
    channels: ['web', 'x', 'xhs']
  };
  const request = { roleId: 'reporter', brief: '研究补料工单', businessDate: parent.businessDate, projectId: parent.projectId, research: gap };
  const refs = buildJobContextRefs({ jobId: `research-job-${taskId}`, request, boundary: buildJobObjectBoundary(request, parent.businessDate) });
  const packClaims = claims ?? requiredClaims.map((c) => ({
    id: `claim-row-${c.key}`,
    key: c.key,
    status: unresolvedRequiredClaims.includes(c.key) ? 'unresolved' : 'supported',
    verdictReason: unresolvedRequiredClaims.includes(c.key) ? 'threshold_not_met' : 'official_source',
    evidenceSourceIds: [],
    needsTimeExcerpt: c.type !== 'fact'
  }));
  const pack = buildResearchEvidencePack({
    jobId: taskId,
    round: 1,
    claims: packClaims,
    sourceIds: unresolvedRequiredClaims.length === 0 ? ['src-1'] : [],
    validSourceCount: unresolvedRequiredClaims.length === 0 ? 2 : 0,
    candidateCount: 3,
    timeSpentMinutes: 5,
    terminalReason,
    unresolvedRequiredClaims: [...unresolvedRequiredClaims]
  });
  insertAgentTask(db, {
    id: taskId,
    intent: 'research',
    status,
    phase: status === 'succeeded' ? 'completed' : status === 'partial' ? 'partial' : status,
    contextRefs: refs,
    resultRefs: pack,
    progress
  });
  return { taskId, gap, pack };
}

/** 落 research_claims 冻结行（claim 原文来源；与 runner persistClaims 同构）。 */
function seedClaim(db, taskId, { key, text, type = 'fact', status = 'unresolved' }) {
  const result = upsertResearchClaim(db, { taskId, claimKey: key, claimText: text, claimType: type, status });
  assert.equal(result.ok, true);
  return result.data;
}

function successorRowCount(db, parentJobId) {
  return Number(db.prepare('SELECT count(*) count FROM jobs WHERE kind = ? AND dedupe_key = ?').get('research_successor', researchSuccessorDedupeKey(parentJobId)).count);
}

function fakeSpawner(runtime, { maxWorkers = 1, onSpawn } = {}) {
  const spawned = [];
  return {
    spawner: new JobSpawner(runtime, {
      maxWorkers,
      execute: async (ctx) => {
        spawned.push({ jobId: ctx.job.id, roleId: ctx.job.roleId, intent: ctx.job.intent, brief: ctx.job.brief, businessDate: ctx.job.businessDate, projectId: ctx.job.projectId });
        onSpawn?.(ctx);
        return { status: 'succeeded', code: 'TEST_OK', message: null, readback: null };
      }
    }),
    spawned
  };
}

// ---- 5170 同款 MCP 门测试面 ------------------------------------------------

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

async function dispatchTool(mcp, name, args, meta) {
  const params = { name, arguments: args };
  if (meta) params._meta = meta;
  const called = await mcpRequest(mcp.url, 'tools/call', params);
  return JSON.parse(called.data.content[0].text);
}

/** 预置 research 任务行（intent CHECK 在 WMB-5171 才含 research，测试用 ignore_check_constraints 注入）。 */
function seedTasks(database) {
  database.exec('PRAGMA ignore_check_constraints = ON');
  const now = new Date().toISOString();
  const insert = (id, intent) => database.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
    created_at, updated_at, finished_at
  ) VALUES (?,?,?,?,?,null,'{}','{}','{}','{}','[]',null,null,null,null,?,?,?)`).run(
    id, intent, BUSINESS_DATE, 'running', 'researching', now, now, now
  );
  insert('research-task', 'research');
  insert('scan-task', 'daily_scan');
}

/** 预置带运行时身份的研究门测试环境（workspace_id + official profile + 任务行）。 */
async function openResearchGateRuntime(root) {
  const seed = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  seed.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
  ensureOfficialWorkspaceProfile(seed, 'official.ai');
  seedTasks(seed);
  seed.close();
  return ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => `research-gate-${randomUUID()}` });
}

const gateApplication = () => ({
  listWorkspaces: async () => ({ activeWorkspaceId: null, workspaces: [] }),
  proposals: new WorkspaceProposalStore(() => true),
  channelProposals: new IntelligenceChannelProposalStore()
});

/** 为任务获取绑定员工 lease（acquireWorkerLease 已把 taskId 计入 boundTaskIds → isCurrentWorkerLease 为真）。 */
function bindLease(runtime, taskId) {
  const lease = runtime.acquireWorkerLease(taskId, 'reporter', 'employee');
  runtime.bindWorker(lease, { stop() {} });
  return lease;
}

// ---- 5172 同款 runner deps（runner 是产品真函数；deps 是其 I/O 接缝） -------------

function candidate(key, claimKey, url, extra = {}) {
  return { key, claimKey, url, title: `Title ${key}`, author: 'Author', summary: 'Summary text', publishedAt: '2026-08-12', excerpt: '原文关键句摘录。', sourceKind: 'secondary', ...extra };
}

const T0 = Date.UTC(2026, 7, 13, 1, 0, 0);

function makeDeps(overrides = {}) {
  const state = {
    nowMs: overrides.nowMs ?? T0,
    candidates: overrides.candidates ?? [],
    fetch: overrides.fetch ?? (async () => ({ ok: true, text: 'body' })),
    proposals: overrides.proposals ?? [],
    writes: [],
    progress: [],
    claims: overrides.initialClaims ? overrides.initialClaims.map((claim) => ({ ...claim })) : [],
    writeReceipts: overrides.initialWriteReceipts ? overrides.initialWriteReceipts.map((receipt) => ({ ...receipt })) : [],
    fetchCalls: 0, fetchInFlight: 0, maxInFlight: 0, proposeCalls: 0, discoverCalls: 0,
    sourceSeq: 0,
    sourcesByUrl: overrides.sourcesByUrl ?? new Map(),
    ...overrides.state
  };
  const deps = {
    now: () => new Date(state.nowMs),
    discoverCandidates: async (gap, options) => { state.discoverCalls += 1; state.lastDiscoverOptions = options; return state.candidates; },
    fetchCandidate: async (candidate) => {
      state.fetchCalls += 1;
      state.fetchInFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.fetchInFlight);
      try { return await state.fetch(candidate, state); } finally { state.fetchInFlight -= 1; }
    },
    writeSource: async (input) => {
      state.writes.push({ ...input, evidenceSourceIds: undefined });
      const replay = state.writeReceipts.find((receipt) => receipt.requestId === input.requestId);
      if (replay) return { sourceId: replay.sourceId, created: replay.created };
      const key = canonicalizeUrl(input.url);
      const existing = state.sourcesByUrl.get(key);
      const sourceId = existing ?? `src-${++state.sourceSeq}`;
      state.sourcesByUrl.set(key, sourceId);
      const receipt = { requestId: input.requestId, sourceId, created: !existing };
      state.writeReceipts.push(receipt);
      return { sourceId, created: receipt.created };
    },
    listSourceWriteReceipts: async () => state.writeReceipts.map(({ sourceId, created }) => ({ sourceId, created })),
    proposeClaims: async () => { state.proposeCalls += 1; return state.proposals; },
    persistProgress: async (progressInput) => { state.progress.push(progressInput); },
    persistClaims: async (claims) => {
      for (const claim of claims) {
        const existing = state.claims.find((row) => row.claimKey === claim.claimKey);
        if (existing) Object.assign(existing, { status: claim.status, verdictReason: claim.verdictReason, evidenceSourceIds: [...claim.evidenceSourceIds] });
        else state.claims.push({ id: `claim-row-${claim.claimKey}`, claimKey: claim.claimKey, status: claim.status, verdictReason: claim.verdictReason, evidenceSourceIds: [...claim.evidenceSourceIds], needsTimeExcerpt: claim.claimType === 'price' || claim.claimType === 'policy' });
      }
    },
    listClaims: async () => state.claims.map((row) => ({ ...row, evidenceSourceIds: [...row.evidenceSourceIds] }))
  };
  return { deps, state };
}

function run(inputOverrides = {}, depsOverrides = {}) {
  const { deps, state } = makeDeps(depsOverrides);
  const input = { task: makeTask(), gap: makeGap(), signal: new AbortController().signal, ...inputOverrides };
  return { promise: runResearchJob(input, deps), deps, state };
}

function makeGap(overrides = {}) {
  return { gapId: 'research-gap-1', parentJobId: 'job-parent-1', parentTaskId: 'task-parent-1', parentRoleId: 'writer',
    requiredClaims: [{ key: 'claim_a', text: '声明 A（事实）', type: 'fact' }, { key: 'claim_b', text: '声明 B（价格）', type: 'price' }],
    budget: { ...BUDGET }, channels: ['web'], ...overrides };
}

function makeTask(overrides = {}) {
  return { id: 'task-research-1', businessDate: BUSINESS_DATE, contextRefs: {}, checkpoint: {}, progress: {}, ...overrides };
}

function proposal(claimKey, status, evidenceSourceIds = [], verdictReason = null) {
  return { claimKey, status, evidenceSourceIds, verdictReason };
}

// ===========================================================================
// EVAL-032 13 项验收（SPEC EVAL-032 / PRD AC-029 / 设计 §12.1，汇总 5169-5174 产品路径）
// ===========================================================================

// #0 fixture 集自洽：manifest 与文件一一对应，覆盖 EVAL-032 规定的四类 fixture
test('EVAL-032 fixture set: manifest lists every file; covers post/official/OpenRouter/dynamic/auth-wall', async () => {
  const manifest = JSON.parse(await fixture('manifest.json'));
  assert.equal(manifest.scenario.claimKey, 'glm52_official_price_rise');
  assert.equal(manifest.scenario.claimType, 'price');
  const ids = manifest.fixtures.map((entry) => entry.id);
  // EVAL-032 规定的 fixture：@AbionMorse 帖 / 智谱官方定价页 / OpenRouter 模型页 / 动态渲染 fallback。
  for (const required of ['abionmorse-post', 'zhipu-pricing', 'openrouter-glm52', 'dynamic-pricing-shell']) {
    assert.ok(ids.includes(required), `manifest must include ${required}`);
  }
  assert.ok(ids.includes('auth-wall'), '安全负断言需要验证码/登录墙 fixture');
  const seen = new Set();
  for (const entry of manifest.fixtures) {
    assert.ok(!seen.has(entry.id), `duplicate fixture id ${entry.id}`);
    seen.add(entry.id);
    await assert.doesNotReject(() => fixture(entry.file), `fixture file missing: ${entry.file}`);
    assert.ok(entry.canonicalUrl.startsWith('https://'), `${entry.id} canonicalUrl must be https`);
    assert.ok(['official', 'secondary', 'unavailable'].includes(entry.role), `${entry.id} role enum`);
    assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0, `${entry.id} assertions`);
  }
  assert.ok(manifest.safety_negatives.length >= 6, '安全负断言清单齐备');
});

// #1 evidenceGap 自动派记者：边界继承 + 同父唯一
test('EVAL-032 #1: dispatch — writer evidenceGap auto-spawns reporter research with inherited boundary', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-p' });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner } = fakeSpawner(runtime);
  const first = dispatchResearchForEvidenceGap({
    spawner, database: runtime.database, parentTaskId: parent.taskId,
    requiredClaims: [{ key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price' }]
  });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  const job = spawner.get(first.spawnedJobId);
  assert.equal(job.roleId, 'reporter', '自动派生记者研究工单');
  assert.equal(job.intent, 'research');
  assert.equal(job.businessDate, BUSINESS_DATE, 'businessDate 继承父任务业务日');
  assert.equal(job.projectId, 'proj-p', 'projectId 继承父工单边界');
  assert.match(job.brief, /glm52_official_price_rise/, 'brief 包含 required claim');
  assert.equal(spawner.list().filter((jobRecord) => jobRecord.intent === 'research').length, 1);
  spawner.dispose();
}));

test('EVAL-032 #1: dispatch — same-parent unique returns the existing active research task, no second spawn', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-p' });
  seedResearchTask(db, { parent, taskId: 'research-active-1', status: 'running', requiredClaims: [claim('glm52_official_price_rise', 'GLM 5.2 官方在 OpenRouter 涨价', 'price')] });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner } = fakeSpawner(runtime);
  const again = dispatchResearchForEvidenceGap({
    spawner, database: runtime.database, parentTaskId: parent.taskId,
    requiredClaims: [{ key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price' }]
  });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(again.existingTaskId, 'research-active-1', '返回既有 research 任务 id');
  assert.equal(spawner.list().filter((jobRecord) => jobRecord.intent === 'research').length, 0, '同一 parentJobId 至多一个活动 research 任务，不产生第二个 job');
  spawner.dispose();
}));

// #2 记者卡：进度真实推进（planned=40 / verified 目标 15）
test('EVAL-032 #2: reporter card — research summary carries planned=40/verified target 15 from real budget', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-r2', jobId: 'job-r2' });
  const research = seedResearchTask(db, {
    parent, status: 'succeeded', taskId: 'research-r2',
    requiredClaims: [claim('glm52_official_price_rise', 'GLM 5.2 官方在 OpenRouter 涨价', 'price')],
    progress: { planned: 40, processed: 18, verified: 15, saved: 11, message: '研究进行中' }
  });
  seedClaim(db, research.taskId, { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price', status: 'supported' });

  // 预算真源：planned=40（maxCandidates）、verified 目标 15（minValidSources）。
  assert.equal(RESEARCH_DEFAULT_BUDGET.maxCandidates, 40);
  assert.equal(RESEARCH_DEFAULT_BUDGET.minValidSources, 15);

  const summary = readCrewResearchSummary(db, { id: research.taskId, intent: 'research', progress: { planned: 40, processed: 18, verified: 15, saved: 11 } });
  assert.deepEqual(summary, {
    planned: 40, processed: 18, verified: 15, saved: 11,
    claims: { total: 1, supported: 1, contradicted: 0, unresolved: 0, sourceUnavailable: 0, pending: 0 }
  });
  assert.equal(instanceStatusWord({ intent: 'research', status: 'running' }), '研究中');

  // crew 投影把研究摘要挂到记者实例（jobId 锚点；历史视图由持久面重建）。
  const projection = readCrewInstanceProjection({ database: db, pool: null });
  const researchInstance = [...projection.active, ...projection.history].find((i) => i.jobId === 'research-job-research-r2');
  assert.ok(researchInstance, 'research 工单实例可从持久面投影');
  assert.equal(researchInstance.research?.planned, 40);
  assert.equal(researchInstance.research?.verified, 15);
  assert.equal(researchInstance.research?.claims?.supported, 1);
}));

// #3 读硬门：白名单外拒绝 + 审计；白名单内放行
test('EVAL-032 #3: read gate — off-whitelist blocked with audit, in-whitelist passes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5175-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      const meta = { taskId: 'research-task', workerLeaseId: lease.leaseId };
      // 白名单外（含 context.get_workbench 与 channel resolve/trial）：READ_PROFILE_BLOCKED + RESEARCH_READ_WHITELIST。
      const blocked = [
        ['context.get_workbench', {}],
        ['intelligence_channels.resolve_website', { input_text: 'Example' }],
        ['intelligence_channels.trial_website', { url: 'https://example.com' }]
      ];
      for (const [name, args] of blocked) {
        const result = await dispatchTool(mcp, name, args, meta);
        assert.equal(result.ok, false, `${name} must be blocked`);
        assert.equal(result.error.code, 'READ_PROFILE_BLOCKED', name);
        assert.deepEqual(result.error.details, { reason: 'RESEARCH_READ_WHITELIST' }, name);
      }
      // 白名单内：到达既有 handler（sources.get 缺失 id → null，而非 BLOCKED）。
      const got = await dispatchTool(mcp, 'sources.get', { id: 'missing' }, meta);
      assert.equal(got, null);
      const searched = await dispatchTool(mcp, 'sources.search', { query: 'glm' }, meta);
      assert.deepEqual(searched, []);
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('EVAL-032 #3: read gate denial is audited with role/command/taskId/reason/time', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5175-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      const result = await dispatchTool(mcp, 'context.get_workbench', {}, { taskId: 'research-task', workerLeaseId: lease.leaseId });
      assert.equal(result.error.code, 'READ_PROFILE_BLOCKED');
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
    const audit = migrateDatabase(path.join(root, 'wmb.db'));
    try {
      const row = audit.prepare("SELECT * FROM operation_log WHERE entity_type='role_authority_blocked' ORDER BY created_at DESC LIMIT 1").get();
      assert.ok(row, 'audit row exists');
      assert.equal(row.command, 'context.get_workbench');
      assert.equal(row.client_label, 'reporter');
      assert.equal(row.error_code, 'RESEARCH_READ_WHITELIST');
      assert.equal(row.result, 'error');
      assert.ok(row.created_at, 'audit must carry time');
    } finally {
      audit.close();
    }
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// #4 证据写回：canonical 去重 + price 时间/摘录 + 无 feedId + 信封缺失拒绝
test('EVAL-032 #4: write-back — research payload carries canonical originalUrl + price time/excerpt, no feedId; envelope missing rejects', async () => {
  const research = buildSaveSourcePayload({
    requestId: 'task-research-1:source:1', taskId: 'task-research-1', grantId: 'grant-1', workerLeaseId: 'lease-1',
    title: 'GLM-5.2 官方定价', originalUrl: 'https://zhipuai.cn/pricing', summary: '官方页显示 GLM-5.2 价格上调', author: '智谱AI',
    publishedAt: '2026-08-12', excerpt: 'GLM-5.2 输入价格自 2026-08-12 起由 0.5 元上调至 0.6 元每百万 tokens', clientLabel: 'WMB research'
  });
  const item = research.items[0];
  assert.equal(item.originalUrl, 'https://zhipuai.cn/pricing', 'originalUrl 必带（canonical 去重锚）');
  assert.equal(item.publishedAt, '2026-08-12', 'price 证据带时间');
  assert.deepEqual(JSON.parse(item.evidence), { excerpt: 'GLM-5.2 输入价格自 2026-08-12 起由 0.5 元上调至 0.6 元每百万 tokens' }, 'price 证据带 verbatim 摘录');
  assert.equal('feedId' in item, false, '研究写回禁止 feedId');

  // 信封缺失（taskId/grantId/workerLeaseId/requestId）或 author 缺失 → 拒绝（fail-closed，零写）。
  const base = { requestId: 'r1', taskId: 't1', grantId: 'g1', workerLeaseId: 'l1', title: 'T', originalUrl: 'https://zhipuai.cn/pricing', summary: 'S', clientLabel: 'WMB research' };
  assert.throws(() => buildSaveSourcePayload({ ...base, author: undefined }), /RESEARCH_EVIDENCE_FIELDS_REQUIRED/);
  assert.throws(() => buildSaveSourcePayload({ ...base, author: 'A', workerLeaseId: undefined }), /RESEARCH_ENVELOPE_REQUIRED/);
  assert.throws(() => buildSaveSourcePayload({ ...base, author: 'A', taskId: '' }), /RESEARCH_ENVELOPE_REQUIRED/);
  assert.throws(() => buildSaveSourcePayload({ ...base, author: 'A', requestId: undefined }), /RESEARCH_ENVELOPE_REQUIRED/);
});

test('EVAL-032 #4: canonical URL dedupe — duplicate candidate re-import adds no new source', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 360_000, candidatesProcessed: 0, claimsSnapshot: {} };
  const candidates = [
    candidate('c0', 'claim_a', 'https://zhipuai.cn/pricing', { sourceKind: 'official' }),
    candidate('c1', 'claim_a', 'https://zhipuai.cn/pricing#frag', { sourceKind: 'official' })
  ];
  const { deps, state } = makeDeps({ candidates, proposals: [proposal('claim_a', 'supported', ['src-1'])] });
  const result = await runResearchJob({ task: makeTask({ checkpoint }), gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }), signal: new AbortController().signal }, deps);
  assert.equal(result.progress.processed, 2);
  assert.equal(result.progress.saved, 1, 'canonical URL 去重：重复候选不新增 source');
  assert.equal(state.writes.length, 2, '两次写入同一 requestId（幂等重放）');
  assert.equal(state.writes[0].requestId, state.writes[1].requestId);
  assert.equal(state.writes[0].requestId, `task-research-1:source:${researchSourceKeyFor('https://zhipuai.cn/pricing')}`);
  for (const write of state.writes) assert.equal('feedId' in write, false, 'runner 写回不带 feedId');
});

// #5 claim 机器校验四态 + 门槛矩阵
test('EVAL-032 #5: claim machine validation — threshold matrix from GLM 5.2 fixtures', async () => {
  const official = {
    sourceId: 'src-official', title: '智谱AI 开放平台 - 模型价格', url: 'https://zhipuai.cn/pricing',
    author: '智谱AI', summary: '官方价格页，2026-08-12 更新', sourceKind: 'official',
    publishedAt: '2026-08-12', excerpt: 'GLM-5.2 输入价格自 2026-08-12 起由 0.5 元上调至 0.6 元每百万 tokens，输出价格由 3.15 元上调至 3.8 元每百万 tokens。'
  };
  const openrouter = {
    sourceId: 'src-or', title: 'GLM-5.2 - Model - OpenRouter', url: 'https://openrouter.ai/models/zhipu/glm-5.2',
    author: 'OpenRouter', summary: '模型页，2026-08-12 更新', sourceKind: 'secondary',
    publishedAt: '2026-08-12', excerpt: 'OpenRouter listing for Z.ai GLM-5.2: prompt 0.60 USD and completion 3.80 USD per 1M tokens, updated 2026-08-12.'
  };
  const noRiseOfficial = { ...official, excerpt: 'GLM-5.2 输入输出价格近期未作调整，本页价格为当前有效价格。' };
  const ctx = (evidence, extra = {}) => ({ claimKey: 'glm52_official_price_rise', claimType: 'price', evidence: new Map(evidence.map((item) => [item.sourceId, item])), candidateTotal: 2, candidateFailed: 0, ...extra });

  // 伪造 supported：1 条二手（不独立/数量不足）→ unresolved（threshold_not_met）。
  const forgedOneSecondary = validateClaimProposal(ctx([openrouter], { candidateFailed: 1 }), proposal('glm52_official_price_rise', 'supported', ['src-or']));
  assert.deepEqual(forgedOneSecondary, { status: 'unresolved', verdictReason: 'threshold_not_met' });

  // 伪造 supported：官方一手但缺时间 → threshold_not_met（price 必需时间）。
  const noTime = validateClaimProposal(ctx([{ ...official, publishedAt: '' }]), proposal('glm52_official_price_rise', 'supported', ['src-official']));
  assert.deepEqual(noTime, { status: 'unresolved', verdictReason: 'threshold_not_met' });

  // 伪造 supported：官方一手但缺摘录 → threshold_not_met（price 必需摘录）。
  const noExcerpt = validateClaimProposal(ctx([{ ...official, excerpt: '' }]), proposal('glm52_official_price_rise', 'supported', ['src-official']));
  assert.deepEqual(noExcerpt, { status: 'unresolved', verdictReason: 'threshold_not_met' });

  // 官方一手 + 独立二手 → supported（official_source）。
  const supported = validateClaimProposal(ctx([official, openrouter]), proposal('glm52_official_price_rise', 'supported', ['src-official', 'src-or']));
  assert.equal(supported.status, 'supported');
  assert.equal(supported.verdictReason, 'official_source');
  assert.equal(assessSupportThreshold([official, openrouter], 'price').passes, true);

  // 官方页明确未涨 → contradicted。
  const contradicted = validateClaimProposal(ctx([noRiseOfficial]), proposal('glm52_official_price_rise', 'contradicted', ['src-official']));
  assert.deepEqual(contradicted, { status: 'contradicted', verdictReason: 'official_source' });

  // 全部候选不可读 → source_unavailable（机器推导，优先于建议）。
  const unavailable = validateClaimProposal(ctx([], { candidateTotal: 2, candidateFailed: 2, failureReason: 'auth_required' }), proposal('glm52_official_price_rise', 'supported', []));
  assert.deepEqual(unavailable, { status: 'source_unavailable', verdictReason: 'auth_required' });

  // 独立二手判定：域互异。
  assert.notEqual(evidenceDomainOf('https://openrouter.ai/x'), evidenceDomainOf('https://zhipuai.cn/x'));
});

// #6 仅一轮：候选耗尽 → partial + EvidencePack（round=1）
test('EVAL-032 #6: single round — candidates exhausted → partial + EvidencePack round=1', async () => {
  const candidates = Array.from({ length: 6 }, (_, i) => candidate(`c${i}`, 'claim_a', `https://a${i}.example.com/p${i}`, { sourceKind: 'official' }));
  const { promise, state } = run(
    { gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }, { key: 'claim_b', text: 'B', type: 'price' }] }) },
    { candidates, proposals: [proposal('claim_a', 'supported', ['src-1', 'src-2'])] }
  );
  const result = await promise;
  assert.equal(result.terminal, 'partial');
  assert.equal(result.pack.round, 1, '仅一轮');
  assert.equal(result.pack.terminalReason, 'candidates_exhausted');
  assert.deepEqual(result.pack.unresolvedRequiredClaims, ['claim_b'], '未答 claim 进 EvidencePack');
  assert.ok(parseResearchEvidencePack({ ...result.pack }), 'EvidencePack 严格解析读回');
  assert.equal(state.proposeCalls, 1, '仅一轮建议阶段');
});

// #7 自动续派：dedupe_key 唯一 + 重放只产一个 + 原角色续派带 EvidencePack 摘要
test('EVAL-032 #7: auto successor — dedupe_key UNIQUE, replay yields exactly one, writer successor with briefSuffix', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const research = seedResearchTask(db, {
    parent, status: 'partial', requiredClaims: [claim('glm52_official_price_rise', 'GLM 5.2 官方在 OpenRouter 涨价', 'price')],
    unresolvedRequiredClaims: ['glm52_official_price_rise']
  });
  seedClaim(db, research.taskId, { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price', status: 'unresolved' });
  const enqueued = enqueueResearchSuccessor(db, { researchTaskId: research.taskId });
  assert.equal(enqueued.job.status, 'needs_user', 'partial 未答 claim 先入等你批');
  assert.equal(enqueued.job.dedupeKey, researchSuccessorDedupeKey(parent.jobId), 'dedupe_key=research-succ:{parentJobId}');
  const replay = enqueueResearchSuccessor(db, { researchTaskId: research.taskId });
  assert.equal(replay.job.id, enqueued.job.id, '重放终态处理器 → 同一行（INSERT OR IGNORE 幂等）');
  assert.equal(successorRowCount(db, parent.jobId), 1, '至多一个续派');
  return { parent, row: enqueued.job };
}, async (runtime, { parent, row }) => {
  const decided = await decideResearchSuccessorViaRuntime(runtime, row.id, 'accept');
  assert.equal(decided.ok, true);
  assert.equal(decided.data.status, 'pending');
  const { spawner } = fakeSpawner(runtime);
  const kicked = await kickResearchSuccessors(runtime, spawner);
  assert.equal(kicked, 1, '消费派生原角色续派');
  const successorJob = spawner.get(row.id);
  assert.equal(successorJob.roleId, 'writer', '续派 = 原角色（writer）');
  assert.equal(successorJob.intent, 'studio_draft');
  assert.equal(successorJob.projectId, 'proj-1', '续派同 projectId');
  assert.match(successorJob.brief, /研究续派 — EvidencePack 摘要/, 'brief 追加 EvidencePack 摘要');
  assert.match(successorJob.brief, /【主管决策：接受标注待核实】/, 'brief 追加决策说明');
  const rowAfter = getResearchSuccessorById(runtime.database, row.id);
  assert.equal(rowAfter.status, 'running', '消费后行 running（崩溃后不重消费）');
  const again = await kickResearchSuccessors(runtime, spawner);
  assert.equal(again, 0, '第二次 kick 不重消费');
  spawner.dispose();
}));

// #8 硬止环：research 父拒绝 + 续派产物父拒绝（不再自动再派）
test('EVAL-032 #8: hard stop-loop — research parent and successor-row parent rejected fail-closed', () => withDb((db) => {
  const researchParent = seedParent(db, { intent: 'research', roleId: 'reporter', projectId: null, taskId: 'parent-research', jobId: 'job-research' });
  assert.equal(deriveResearchParentRole('research'), null, 'research 不可作研究父');
  assert.throws(() => dispatchResearchForEvidenceGap({
    spawner: null, database: db, parentTaskId: researchParent.taskId,
    requiredClaims: [{ key: 'k', text: 't', type: 'fact' }]
  }), (error) => error.code === 'VALIDATION_ERROR' && /research→research 禁止/.test(error.message));

  // 行为层：父工单是 research_successor 行 → 续派后再缺料不自动再派。
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-succ', jobId: 'job-succ' });
  const now = nowIso();
  db.prepare(`INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, created_at, updated_at)
    VALUES (?, 'research_successor', 'needs_user', ?, 0, ?, '{}', ?, ?)`)
    .run(parent.jobId, now, researchSuccessorDedupeKey('job-grandparent'), now, now);
  assert.equal(isResearchSuccessorRow(db, parent.jobId), true);
  assert.throws(() => dispatchResearchForEvidenceGap({
    spawner: null, database: db, parentTaskId: parent.taskId,
    requiredClaims: [{ key: 'k', text: 't', type: 'fact' }]
  }), (error) => error.code === 'VALIDATION_ERROR' && /不自动再派研究/.test(error.message));
}));

// #9 Today 投影：唯一等你批卡 + 三动作；研究进度/裸资料不上桌
test('EVAL-032 #9: Today projection — exactly one needs_user card with three actions; no progress/raw material', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-today', jobId: 'job-today' });
  const research = seedResearchTask(db, {
    parent, status: 'partial', taskId: 'research-today',
    requiredClaims: [claim('glm52_official_price_rise', 'GLM 5.2 官方在 OpenRouter 涨价', 'price')],
    unresolvedRequiredClaims: ['glm52_official_price_rise'],
    progress: { planned: 40, processed: 22, verified: 15, saved: 12 }
  });
  seedClaim(db, research.taskId, { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price', status: 'unresolved' });
  const row = enqueueResearchSuccessor(db, { researchTaskId: research.taskId }).job;
  assert.equal(row.status, 'needs_user');

  // 全 resolved 续派 pending → 不上 Today。
  const parentOk = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-2', taskId: 'parent-ok2', jobId: 'job-ok2' });
  const researchOk = seedResearchTask(db, { parent: parentOk, status: 'succeeded', taskId: 'research-ok2', requiredClaims: [claim('ok')], unresolvedRequiredClaims: [] });
  enqueueResearchSuccessor(db, { researchTaskId: researchOk.taskId });

  const items = listResearchSuccessorNeedsUser(db);
  assert.equal(items.length, 1, '只有 needs_user 上桌；pending 不上桌');
  const item = items[0];
  assert.equal(item.id, row.id);
  assert.equal(item.parentRoleId, 'writer');
  assert.deepEqual(item.unresolvedClaims, [{
    key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price'
  }], 'claim 原文来自 research_claims 冻结行');
  assert.equal(item.decision, null);
  assert.deepEqual(RESEARCH_SUCCESSOR_ACTIONS, ['narrow', 'supplement', 'accept'], '三动作：收窄/手动补料/接受标注待核实');
  // 投影只含声明语义：候选/进度/裸资料字段不得出现。
  const allowed = ['id', 'parentJobId', 'parentTaskId', 'researchTaskId', 'parentRoleId', 'projectId', 'unresolvedClaims', 'decision', 'createdAt', 'updatedAt'];
  assert.deepEqual(Object.keys(item).sort(), allowed.sort(), '研究进度/候选/裸资料永不上桌');
}));

// #10 重启恢复：checkpoint + research_claims 续跑；enqueued 续派重启后只消费一次
test('EVAL-032 #10: restart recovery — resume within remaining budget from checkpoint + claims; successor consumed exactly once', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 240_000, candidatesProcessed: 0, claimsSnapshot: { claim_a: 'supported' } };
  const progress = { planned: 40, processed: 0, verified: 1, saved: 1 };
  const initialClaims = [{ id: 'claim-row-a', claimKey: 'claim_a', status: 'supported', verdictReason: 'official_source', evidenceSourceIds: ['src-prev'], needsTimeExcerpt: false }];
  const candidates = Array.from({ length: 6 }, (_, i) => candidate(`c${i}`, 'claim_b', `https://b${i}.example.com/${i}.html`, { sourceKind: 'official' }));
  const { promise, state } = run(
    { task: makeTask({ checkpoint, progress }) },
    { candidates, initialClaims, proposals: [proposal('claim_a', 'supported', ['src-prev']), proposal('claim_b', 'supported', ['src-1'])] }
  );
  const result = await promise;
  assert.equal(result.terminal, 'succeeded', '剩余预算内续跑完成');
  assert.equal(result.checkpoint.candidatesProcessed, 6);
  assert.equal(state.fetchCalls, 6, '已判定 claim_a 不再重抓，只处理 claim_b 候选');
  assert.equal(result.progress.verified, 7, '恢复种子 1 + 新 6');
  assert.ok(result.pack.unresolvedRequiredClaims.length === 0);
});

test('EVAL-032 #10: enqueued-but-unconsumed successor is consumed exactly once after restart', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-rst', jobId: 'job-rst' });
  const research = seedResearchTask(db, { parent, status: 'succeeded', taskId: 'research-rst', requiredClaims: [claim('ok')], unresolvedRequiredClaims: [] });
  enqueueResearchSuccessor(db, { researchTaskId: research.taskId });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner, spawned } = fakeSpawner(runtime);
  const first = await kickResearchSuccessors(runtime, spawner);
  assert.equal(first, 1, '重启后消费一次');
  const second = await kickResearchSuccessors(runtime, spawner);
  assert.equal(second, 0, '不重复消费');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawned.length, 1);
  spawner.dispose();
}));

test('EVAL-032 #10: reconcile — restart recovery enqueues missing successor idempotently', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-rc', jobId: 'job-rc' });
  seedResearchTask(db, { parent, status: 'succeeded', taskId: 'research-rc', requiredClaims: [claim('ok')], unresolvedRequiredClaims: [] });
  const first = reconcileResearchSuccessors(db);
  assert.equal(first, 1, '终态 research 无续派行 → 补齐 enqueue');
  assert.equal(successorRowCount(db, parent.jobId), 1);
  const second = reconcileResearchSuccessors(db);
  assert.equal(second, 0, '重放幂等（INSERT OR IGNORE）');
  assert.equal(successorRowCount(db, parent.jobId), 1);
}));

// #11 产物质量：续派 brief 只带内部 EvidencePack 摘要，并强制输出干净正文
test('EVAL-032 #11: artifact quality — unresolved claims are internally excluded, never padded into article disclaimers', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-q', jobId: 'job-q' });
  const research = seedResearchTask(db, {
    parent, status: 'partial', taskId: 'research-q',
    requiredClaims: [claim('glm52_official_price_rise', 'GLM 5.2 官方在 OpenRouter 涨价', 'price')],
    unresolvedRequiredClaims: ['glm52_official_price_rise']
  });
  const suffix = buildSuccessorBriefSuffix(research.pack, research.gap, 'accept');
  assert.match(suffix, /研究续派 — EvidencePack 摘要/);
  assert.match(suffix, /glm52_official_price_rise（price\/policy，需时间\+摘录）：unresolved（threshold_not_met）/);
  assert.match(suffix, /仅供内部剔除的未解决声明：glm52_official_price_rise/);
  assert.match(suffix, /未解决声明只用于内部删减，不得写入正式正文/);
  assert.match(suffix, /不得输出研究过程、核查摘要、残余不确定项或免责声明式尾注/);
  assert.match(suffix, /【主管决策：接受标注待核实】/, 'accept 决策仍保留内部状态，但禁止免责声明式正文');
  assert.match(suffix, /正式正文不得出现待核实清单、研究过程说明或免责声明式尾注/);
  assert.doesNotMatch(suffix, /zhipuai\.cn|openrouter\.ai|candidate|https?:\/\//, '续派 brief 不带候选 URL/裸资料/旧稿正文');

  // accept 只保留内部决策状态；未解决声明仍不得写入正式正文。
  const enqueued = enqueueResearchSuccessor(db, { researchTaskId: research.taskId }).job;
  const decided = decideResearchSuccessor(db, enqueued.id, 'accept');
  assert.equal(decided.ok, true);
  const readback = getResearchSuccessorById(db, enqueued.id);
  assert.equal(readback.payload.decision, 'accept');
  assert.match(readback.payload.briefSuffix, /【主管决策：接受标注待核实】/);
}));

// #12 取消/失败：已入库证据保留、不续派
test('EVAL-032 #12: cancel/failure — committed evidence retained, zero successor', async () => {
  // runner 取消：已写入证据保留（writes 在 state），终态 cancelled、无 pack。
  const controller = new AbortController();
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 360_000, candidatesProcessed: 0, claimsSnapshot: {} };
  const candidates = [candidate('c0', 'claim_a', 'https://zhipuai.cn/pricing', { sourceKind: 'official' })];
  const { deps, state } = makeDeps({
    candidates,
    fetch: async () => { controller.abort(); return { ok: true, text: 'body' }; },
    proposals: [proposal('claim_a', 'supported', ['src-1'])]
  });
  const result = await runResearchJob({ task: makeTask({ checkpoint }), gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }), signal: controller.signal }, deps);
  assert.equal(result.terminal, 'cancelled');
  assert.equal(result.pack, null);
  assert.equal(state.writes.length, 1, '取消前已提交的证据保留');
  assert.equal(state.writes[0].url, 'https://zhipuai.cn/pricing');

  // 取消/失败 research 终态不触发续派。
  await withDb((db) => {
    const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-cx', jobId: 'job-cx' });
    seedResearchTask(db, { parent, status: 'failed', taskId: 'research-fail', requiredClaims: [claim('a')], unresolvedRequiredClaims: ['a'] });
    seedResearchTask(db, { parent, status: 'cancelled', taskId: 'research-cancel', requiredClaims: [claim('b')], unresolvedRequiredClaims: ['b'] });
    assert.equal(successorRowCount(db, parent.jobId), 0, 'failed/cancelled 不续派');
    const enqueued = enqueueResearchSuccessor(db, { researchTaskId: 'research-fail' });
    assert.equal(enqueued.job, null);
  });
});

// #13 Web 安全：静态失败 → fallback 渲染动态 fixture；验证码墙明确失败；SSRF/DNS/重定向/体积/类型/超时拒绝
test('EVAL-032 #13: web security — dynamic fixture renders via fallback; auth wall fails closed; negative matrix rejected', async () => {
  const shell = await fixture('dynamic-pricing-shell.html');
  const renderedPayload = JSON.parse(shell.match(/<script id="rendered-content" type="application\/json">([\s\S]*?)<\/script>/)[1]);

  // 静态读取失败（空壳无标题/正文 → parse，retryable）→ fallback 渲染动态公网页并返回正文。
  let renderCalls = 0;
  const fallback = await readWebPage({
    url: 'https://pricing.zhipu.example/dynamic/glm52',
    lookupImpl: publicDns(),
    fetchImpl: staticOk(shell),
    renderFn: async (url, options) => {
      renderCalls += 1;
      await options.validateUrl('https://pricing.zhipu.example/dynamic/glm52');
      return { status: renderedPayload.status, contentType: renderedPayload.contentType, finalUrl: renderedPayload.finalUrl, title: renderedPayload.title, bodyText: renderedPayload.bodyText };
    }
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.data.renderMode, 'fallback');
  assert.match(fallback.data.bodyText, /GLM-5.2 输入 0\.6 元每百万 tokens/, 'fallback 返回动态页真实正文');
  assert.equal(renderCalls, 1);

  // 同一 URL 含验证码/登录墙 → 明确失败（auth_required），不渲染、不绕过。
  const wall = await fixture('auth-wall.html');
  let renderedOnWall = 0;
  const walled = await readWebPage({
    url: 'https://paywall.zhipu.example/pricing',
    lookupImpl: publicDns(),
    fetchImpl: staticOk(wall),
    renderFn: async () => { renderedOnWall += 1; throw new Error('must not render a wall'); }
  });
  assert.equal(walled.ok, false);
  assert.equal(walled.error.code, 'SOURCE_UNAVAILABLE');
  assert.equal(walled.error.reason, 'auth_required');
  assert.equal(renderedOnWall, 0, '验证码/登录墙不触发渲染回退、不携带会话凭证');

  // 私网/环回 → SSRF 拒绝（零请求零渲染）。
  for (const url of ['http://127.0.0.1/private', 'http://10.0.0.1/x', 'http://169.254.169.254/latest']) {
    let fetched = 0, rendered = 0;
    const result = await readWebPage({
      url,
      fetchImpl: async () => { fetched += 1; return new Response('x', { status: 200 }); },
      renderFn: async () => { rendered += 1; return { status: 200, contentType: 'text/html', finalUrl: url, title: 'x', bodyText: 'x' }; }
    });
    assert.equal(result.ok, false, url);
    assert.equal(result.error.reason, 'ssrf', url);
    assert.equal(fetched, 0, `must not fetch ${url}`);
    assert.equal(rendered, 0, `must not render ${url}`);
  }

  // DNS 重绑定宿主（解析到私网）→ dns 拒绝（零请求）。
  let reboundFetched = 0;
  const rebound = await readWebPage({
    url: 'https://evil.example.com/page',
    lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }],
    fetchImpl: async () => { reboundFetched += 1; return new Response('x', { status: 200 }); }
  });
  assert.equal(rebound.ok, false);
  assert.equal(rebound.error.reason, 'dns');
  assert.equal(reboundFetched, 0);

  // 重定向跳出可信域/跳到私网 → 拒绝（私网目标按 SSRF 分类；协议外跳按 redirect 分类）。
  const privateRedirect = await readWebPage({
    url: 'https://a.example/start',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
  });
  assert.equal(privateRedirect.ok, false);
  assert.equal(privateRedirect.error.reason, 'ssrf', '重定向跳到私网 → 拒绝（SSRF 分类）');

  const protocolEscape = await readWebPage({
    url: 'https://a.example/start',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } })
  });
  assert.equal(protocolEscape.ok, false);
  assert.equal(protocolEscape.error.reason, 'redirect', '重定向协议外跳 → 拒绝（redirect 分类）');

  // >2 MiB → too_large；非文档类型 → unsupported_type；超时 → timeout。
  const oversized = await readWebPage({
    url: 'https://big.example/page',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.reason, 'too_large');

  const binary = await readWebPage({
    url: 'https://img.example/x.png',
    lookupImpl: publicDns(),
    fetchImpl: staticOk('not really a png', { contentType: 'image/png' })
  });
  assert.equal(binary.ok, false);
  assert.equal(binary.error.reason, 'unsupported_type');

  const slow = await readWebPage({
    url: 'https://slow.example/page',
    lookupImpl: publicDns(),
    timeoutMs: 300,
    fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); return new Response('late', { status: 200, headers: { 'content-type': 'text/html' } }); }
  });
  assert.equal(slow.ok, false);
  assert.equal(slow.error.reason, 'timeout');

  // 全候选不可读（auth_required）→ claim 判定 source_unavailable（安全拒绝计入判定）。
  const denialVerdict = validateClaimProposal(
    { claimKey: 'glm52_official_price_rise', claimType: 'price', evidence: new Map(), candidateTotal: 3, candidateFailed: 3, failureReason: 'auth_required' },
    null
  );
  assert.deepEqual(denialVerdict, { status: 'source_unavailable', verdictReason: 'auth_required' });
});
