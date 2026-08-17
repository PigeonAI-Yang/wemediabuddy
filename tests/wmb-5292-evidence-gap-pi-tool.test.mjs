/**
 * WMB-5292: Studio 事实写作证据缺口交接 —— 受控 Pi 工具面。
 *
 * - 工具存在性：wmb_dispatch_research 经扩展 index 注册（writer/planner/librarian 的 Pi 运行时
 *   都经 preparePiExtension 挂载同一扩展包，注册即三角色可达），camelCase 参数 schema 齐备。
 * - 参数映射（运行时级）：真实执行 Pi 工具 execute，捕获发往 MCP 的 tools/call arguments，
 *   camelCase 参数必须逐键映射为 research.dispatch 的 snake_case 输入，required claims 原样透传。
 * - 指引（guidance）：evidence-grounded-writer 只指向 wmb_dispatch_research，不得出现
 *   wmb_spawn_job / jobs.spawn 记者误路由，派单成功后停止当前交付；operator Skill 登记该工具。
 * - 既有合同不变（经既有公开函数）：deriveResearchParentRole 父角色白名单、三层止环
 *   （research 父 / research_successor 父拒绝）、同父唯一幂等复用仍由 dispatchResearchForEvidenceGap 强制。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';

// TS loader（与 wmb-5172/5173/5175 同款）：解析 .ts 相对导入。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { JobSpawner } = await import('../src/main/job-spawner.ts');
const { buildJobContextRefs, buildJobObjectBoundary } = await import('../src/main/job-object-boundary.ts');
const { RESEARCH_DEFAULT_BUDGET } = await import('../src/main/research-job-runner.ts');
const { dispatchResearchForEvidenceGap, deriveResearchParentRole, handoffParentAfterResearchDispatch } = await import('../src/main/research-dispatch.ts');
const { researchSuccessorDedupeKey } = await import('../src/main/research-successor.ts');
const { draftPrompt } = await import('../src/main/agent-runner.ts');
const { getAgentTask } = await import('../src/main/agent-tasks.ts');
const { assertStudioDraftResearchReady } = await import('../src/main/mcp-business-commands.ts');

const BUSINESS_DATE = '2026-08-16';

function nowIso() {
  return new Date().toISOString();
}

/** 捕获 tools/call arguments 的极简 MCP stub（initialize + tools/call 两段握手）。 */
function captureMcpCall() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    if (payload.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'wmb-5292-stub', version: '1' } } }));
      return;
    }
    if (payload.method === 'tools/call') {
      calls.push(payload.params);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [] } }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        calls,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

async function loadPiTools(query) {
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?${query}=${Date.now()}`)).default;
  extension({ registerTool: (tool) => tools.set(tool.name, tool) });
  return tools;
}

// ---------------------------------------------------------------------------
// 1. 工具存在性：扩展注册 wmb_dispatch_research（writer/planner/librarian 共用扩展面）
// ---------------------------------------------------------------------------

test('WMB-5292: 扩展注册 wmb_dispatch_research，camelCase schema 与受控指引齐备', async () => {
  const tools = await loadPiTools('wmb5292-presence');
  const dispatch = tools.get('wmb_dispatch_research');
  assert.ok(dispatch, '扩展必须注册 wmb_dispatch_research');
  assert.deepEqual(dispatch.parameters.required, ['parentTaskId', 'requiredClaims']);
  const claimSchema = dispatch.parameters.properties.requiredClaims.items;
  assert.deepEqual(claimSchema.required, ['key', 'text', 'type']);
  assert.deepEqual(claimSchema.properties.type.enum, ['fact', 'price', 'policy']);
  const budgetProps = dispatch.parameters.properties.budget.properties;
  for (const key of ['timeMinutes', 'minValidSources', 'maxCandidates', 'maxParallelFetches', 'maxRounds']) {
    assert.ok(key in budgetProps, `budget 必须暴露 ${key}`);
  }
  assert.deepEqual(dispatch.parameters.properties.channels.items.enum, ['web', 'x', 'xhs']);
  assert.equal(dispatch.parameters.additionalProperties, false);
  // 描述承载受控入口指引：禁止普通 reporter 派单/临时联网代替；派单成功后停止当前交付。
  assert.match(dispatch.description, /普通 reporter|reporter\/daily_scan/);
  assert.match(dispatch.description, /代替/);
  assert.match(dispatch.description, /结束当前交付|不保存/);
});

// ---------------------------------------------------------------------------
// 2. 参数映射（运行时级）：execute → MCP arguments 逐键 snake_case
// ---------------------------------------------------------------------------

test('WMB-5292: Pi 工具 execute 把 camelCase 参数逐键映射为 research.dispatch snake_case 输入', async () => {
  const stub = await captureMcpCall();
  process.env.WMB_MCP_URL = stub.url;
  try {
    const tools = await loadPiTools('wmb5292-map');
    const dispatch = tools.get('wmb_dispatch_research');
    assert.ok(dispatch, '扩展必须注册 wmb_dispatch_research');
    // 全参数：parentTaskId/requiredClaims/budget/channels/brief/gapId 全部映射。
    await dispatch.execute('wmb5292-map', {
      parentTaskId: 'task-writer-1',
      requiredClaims: [
        { key: 'glm52_price', text: 'GLM 5.2 官方价格', type: 'price' },
        { key: 'policy_eff', text: '政策生效日期', type: 'policy' }
      ],
      budget: { timeMinutes: 5, minValidSources: 8, maxCandidates: 10, maxParallelFetches: 2, maxRounds: 1 },
      channels: ['web', 'x'],
      brief: '优先官方来源',
      gapId: 'gap-abc'
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].name, 'research.dispatch');
    assert.deepEqual(stub.calls[0].arguments, {
      parent_task_id: 'task-writer-1',
      required_claims: [
        { key: 'glm52_price', text: 'GLM 5.2 官方价格', type: 'price' },
        { key: 'policy_eff', text: '政策生效日期', type: 'policy' }
      ],
      budget: { time_minutes: 5, min_valid_sources: 8, max_candidates: 10, max_parallel_fetches: 2, max_rounds: 1 },
      channels: ['web', 'x'],
      brief: '优先官方来源',
      gap_id: 'gap-abc'
    });
    // 最小参数：只传必填，缺失可选键不进入请求。
    await dispatch.execute('wmb5292-map-min', {
      parentTaskId: 'task-planner-2',
      requiredClaims: [{ key: 'fact_a', text: '声明 A', type: 'fact' }]
    });
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(stub.calls[1].arguments, {
      parent_task_id: 'task-planner-2',
      required_claims: [{ key: 'fact_a', text: '声明 A', type: 'fact' }]
    });
  } finally {
    delete process.env.WMB_MCP_URL;
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 指引：evidence-grounded-writer 只指向受控派单；operator Skill 登记工具
// ---------------------------------------------------------------------------

test('WMB-5292: evidence-grounded-writer 指引只指向 wmb_dispatch_research，禁止 reporter 误路由与临时联网', async () => {
  const skill = await readFile('skills/evidence-grounded-writer/SKILL.md', 'utf8');
  assert.match(skill, /wmb_dispatch_research/);
  assert.match(skill, /parentTaskId/);
  assert.match(skill, /requiredClaims/);
  assert.match(skill, /fact\/price\/policy/);
  assert.match(skill, /结束当前交付|停止当前交付|不保存/);
  assert.match(skill, /WMB 工单内[\s\S]{0,160}现有资料不足即进入 3\.1/);
  assert.doesNotMatch(skill, /当前资料不足时，使用当前可用的只读研究能力/);
  assert.match(skill, /续派|原角色/);
  // 指引不得把证据缺口路由到普通记者派单：wmb_spawn_job / jobs.spawn 只能出现在「禁止/代替」否定语境。
  const spawnMentions = [...skill.matchAll(/(?:wmb_spawn_job|jobs\.spawn)/g)];
  assert.ok(spawnMentions.length >= 1, '指引必须点名被禁止的替代路径');
  for (const match of spawnMentions) {
    const window = skill.slice(Math.max(0, match.index - 60), match.index + 40);
    assert.match(window, /禁止|不用|不得|代替/, `spawn 提及只允许否定语境: ${window}`);
  }
  // operator Skill 登记该工具（pi-operator-skill 精确对账测试的配套要求）。
  const operator = await readFile('skills/wemedia-buddy-operator/SKILL.md', 'utf8');
  assert.match(operator, /`wmb_dispatch_research`/);
  assert.match(operator, /reporter\/daily_scan/);
});

test('WMB-5295: 普通核心初稿强制先派外部研究，只有研究就绪轮次可写作', () => {
  const task = { id: 'writer-parent-task' };
  const firstPass = draftPrompt(task, 'project-1', 'version-request');
  assert.match(firstPass, /外部研究前置交接/);
  assert.match(firstPass, /必须调用 wmb_dispatch_research/);
  assert.match(firstPass, /即使项目已有少量关联资料，也必须派单做外部独立核查/);
  assert.match(firstPass, /禁止生成图片，禁止保存任何正文/);
  assert.match(firstPass, /派单成功后立即结束当前交付/);

  const successor = draftPrompt(task, 'project-1', 'version-request', 'core_draft', 'EvidencePack', true);
  assert.doesNotMatch(successor, /外部研究前置交接/);
  assert.match(successor, /wmb_save_core_version/);
  assert.match(successor, /研究续派任务也禁止再次派研究/);

  const platform = draftPrompt(task, 'project-1', 'platform-request', 'xiaohongshu_platform_version');
  assert.match(platform, /wmb_save_platform_version/);
  assert.doesNotMatch(platform, /外部研究前置交接/);
});

test('WMB-5295: first-pass writer is machine-blocked from content/image mutation until research is ready', async () => withRuntime(async (db) => {
  insertAgentTask(db, { id: 'writer-required', intent: 'studio_draft', contextRefs: { projectId: 'p1', writerTask: 'core_draft', researchGate: 'required' } });
  insertAgentTask(db, { id: 'writer-ready', intent: 'studio_draft', contextRefs: { projectId: 'p1', writerTask: 'core_draft', researchGate: 'satisfied' } });
  insertAgentTask(db, { id: 'writer-legacy', intent: 'studio_draft', contextRefs: { projectId: 'p1', writerTask: 'core_draft' } });
}, async (runtime) => {
  assert.throws(
    () => assertStudioDraftResearchReady(runtime, 'writer-required'),
    (error) => error.code === 'RESEARCH_REQUIRED' && /禁止保存正文或导入配图/.test(error.message)
  );
  assert.doesNotThrow(() => assertStudioDraftResearchReady(runtime, 'writer-ready'));
  assert.doesNotThrow(() => assertStudioDraftResearchReady(runtime, 'writer-legacy'), '遗留任务无显式 gate 时保持兼容');
}));

// ---------------------------------------------------------------------------
// 4. 既有合同不变（经公开函数）：父角色白名单 + 三层止环 + 同父唯一
// ---------------------------------------------------------------------------

/** 真实运行时（写守卫）：seed 在开库前于裸连接落盘，之后 work 用调度面。 */
async function withRuntime(seed, work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5292-rt-'));
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

function insertAgentTask(db, { id, intent, businessDate = BUSINESS_DATE, status = 'running', contextRefs = {} }) {
  const now = nowIso();
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at,
    error_code, error_message, created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, NULL)`).run(
    id, intent, businessDate, status, 'starting', JSON.stringify(contextRefs), JSON.stringify({}),
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

/** 活动 research 任务：合同 refs（reporter + research 块），供同父唯一复用命中。 */
function seedResearchTask(db, { parent, status = 'running', taskId = `research-${randomUUID()}`, requiredClaims = [claim('claim_a')] }) {
  const gap = {
    gapId: `gap-${taskId}`,
    parentJobId: parent.jobId,
    parentTaskId: parent.taskId,
    parentRoleId: 'writer',
    requiredClaims,
    budget: { ...RESEARCH_DEFAULT_BUDGET },
    channels: ['web', 'x', 'xhs']
  };
  const request = { roleId: 'reporter', brief: '研究补料工单', businessDate: parent.businessDate, projectId: parent.projectId, research: gap };
  const refs = buildJobContextRefs({ jobId: `research-job-${taskId}`, request, boundary: buildJobObjectBoundary(request, parent.businessDate) });
  insertAgentTask(db, { id: taskId, intent: 'research', status, contextRefs: refs });
  return { taskId, gap };
}

function fakeSpawner(runtime, { maxWorkers = 1 } = {}) {
  const spawned = [];
  return {
    spawner: new JobSpawner(runtime, {
      maxWorkers,
      execute: async (ctx) => {
        spawned.push({ jobId: ctx.job.id, roleId: ctx.job.roleId, intent: ctx.job.intent });
        return { status: 'succeeded', code: 'TEST_OK', message: null, readback: null };
      }
    }),
    spawned
  };
}

test('WMB-5292: 既有派单合同不变 — 父角色白名单 / 三层止环 / 同父唯一', async () => withRuntime(async (db) => {
  const writerParent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-writer', jobId: 'job-writer' });
  const successorParent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-succ', jobId: 'job-succ' });
  const researchParent = seedParent(db, { intent: 'research', roleId: 'reporter', taskId: 'parent-research', jobId: 'job-research' });
  // 同父唯一：活动 research 任务（合同 refs 含 research 块）已存在。
  seedResearchTask(db, { parent: writerParent, taskId: 'research-active-1', requiredClaims: [claim('k3')] });
  // 行为层种子：父工单 jobId 本身是 research_successor 行（续派产物）。
  const now = nowIso();
  db.prepare(
    `INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, created_at, updated_at)
     VALUES (?, 'research_successor', 'needs_user', ?, 0, ?, '{}', ?, ?)`
  ).run(successorParent.jobId, now, researchSuccessorDedupeKey('job-grandparent'), now, now);
  return { writerParent, successorParent, researchParent };
}, async (runtime, { writerParent, successorParent, researchParent }) => {
  // 派生层白名单不变：writer/planner/librarian 可作父，research 及其余不可。
  assert.equal(deriveResearchParentRole('studio_draft'), 'writer');
  assert.equal(deriveResearchParentRole('daily_judge'), 'planner');
  assert.equal(deriveResearchParentRole('page_library'), 'librarian');
  assert.equal(deriveResearchParentRole('research'), null);
  assert.equal(deriveResearchParentRole('daily_scan'), null);
  assert.equal(deriveResearchParentRole('daily_intelligence'), null);
  assert.equal(deriveResearchParentRole('results_review'), null);
  // 三层止环（层 1）：research 父拒绝。
  assert.throws(() => dispatchResearchForEvidenceGap({
    spawner: null, database: runtime.database, parentTaskId: researchParent.taskId, requiredClaims: [claim('k1')]
  }), (error) => error.code === 'VALIDATION_ERROR' && /research→research 禁止/.test(error.message));
  // 三层止环（层 3）：父工单是研究续派产物 → 不自动再派。
  assert.throws(() => dispatchResearchForEvidenceGap({
    spawner: null, database: runtime.database, parentTaskId: successorParent.taskId, requiredClaims: [claim('k2')]
  }), (error) => error.code === 'VALIDATION_ERROR' && /不自动再派研究/.test(error.message));
  // 同父唯一：已有活动 research 任务时幂等复用，不产生第二个 job。
  const { spawner } = fakeSpawner(runtime);
  try {
    const again = dispatchResearchForEvidenceGap({
      spawner, database: runtime.database, parentTaskId: writerParent.taskId, requiredClaims: [claim('k4')]
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(again.existingTaskId, 'research-active-1');
    assert.equal(spawner.list().filter((job) => job.intent === 'research').length, 0, '不产生第二个 research job');
  } finally {
    spawner.dispose();
  }
}));

test('WMB-5295: 研究派单成功后父写手立即 partial，不能继续保存或完成', async () => withRuntime(async (db) => {
  return { parent: seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-handoff', taskId: 'parent-handoff', jobId: 'job-handoff' }) };
}, async (runtime, { parent }) => {
  const { spawner } = fakeSpawner(runtime);
  try {
    const dispatched = dispatchResearchForEvidenceGap({
      spawner,
      database: runtime.database,
      parentTaskId: parent.taskId,
      requiredClaims: [claim('subject'), claim('mechanism'), claim('cases'), claim('counterevidence')]
    });
    const handedOff = await handoffParentAfterResearchDispatch(runtime, parent.taskId, dispatched);
    assert.equal(handedOff.status, 'partial');
    assert.equal(handedOff.phase, 'research_dispatched');
    assert.equal(handedOff.resultRefs?.researchHandoff?.researchJobId, dispatched.spawnedJobId);
    assert.equal(handedOff.resultRefs?.researchHandoff?.reused, false);
    assert.ok(handedOff.events?.some((event) => /当前任务停止，等待研究完成后续派/.test(event.message ?? '')));
    assert.equal(getAgentTask(runtime.database, parent.taskId)?.status, 'partial');
    const replay = await handoffParentAfterResearchDispatch(runtime, parent.taskId, dispatched);
    assert.equal(replay?.status, 'partial', '终态重放保持 partial，不覆盖为 completed');
  } finally {
    spawner.dispose();
  }
}));
