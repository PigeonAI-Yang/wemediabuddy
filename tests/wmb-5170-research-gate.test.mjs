import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AUTOMATIC_TASK_GRANT_SCOPES
} from '../src/main/task-grants.ts';
import {
  TASK_INTENT_NEEDED_CAPS
} from '../src/shared/agent-capabilities.ts';
import {
  deriveIntentForRole,
  deriveRoleJobSpec,
  JOB_ERROR_CODES,
  parseRoleJobRequest,
  roleFailureCode,
  roleToPolicy,
  roleToReadbackKind
} from '../src/main/role-job-registry.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { WorkspaceProposalStore } from '../src/main/workspace-proposals.ts';
import { IntelligenceChannelProposalStore } from '../src/main/intelligence-channel-proposals.ts';
import { callTool } from '../.pi/extensions/wmb-mcp/wmb-mcp-client.ts';

// ---- research projections: grant scope -----------------------------------

test('research projections grant scope is exact two commands and existing scopes are untouched', () => {
  assert.deepEqual([...AUTOMATIC_TASK_GRANT_SCOPES.research], ['agent_tasks.report_progress', 'sources.upsert_batch']);
  // 既有 scope 字节不变（零回归）。
  assert.deepEqual([...AUTOMATIC_TASK_GRANT_SCOPES.daily_scan], ['agent_tasks.report_progress', 'sources.upsert_batch']);
  assert.deepEqual([...AUTOMATIC_TASK_GRANT_SCOPES.daily_judge], [
    'agent_tasks.report_progress', 'knowledge.record_batch', 'knowledge.suggestion_create', 'plans.save', 'sources.lane_gate'
  ]);
  assert.deepEqual([...AUTOMATIC_TASK_GRANT_SCOPES.studio_draft], ['agent_tasks.report_progress', 'content.save_version']);
  assert.deepEqual([...AUTOMATIC_TASK_GRANT_SCOPES.results_review], ['agent_tasks.report_progress', 'knowledge.record_batch', 'reviews.save']);
});

// ---- research projections: intent capability wiring ----------------------

test('research projections intent capability wiring maps research to cap.research only', () => {
  assert.deepEqual(TASK_INTENT_NEEDED_CAPS.research, ['cap.research']);
  assert.deepEqual(TASK_INTENT_NEEDED_CAPS.daily_scan, ['cap.collect']);
  assert.deepEqual(TASK_INTENT_NEEDED_CAPS.daily_judge, ['cap.lane_judge', 'cap.topic_decide', 'cap.knowledge_curate']);
  assert.deepEqual(TASK_INTENT_NEEDED_CAPS.studio_draft, ['cap.write']);
  assert.deepEqual(TASK_INTENT_NEEDED_CAPS.results_review, ['cap.review']);
});

// ---- research projections: role derivation -------------------------------

const RESEARCH_REQUEST = {
  roleId: 'reporter',
  brief: '研究 GLM 5.2 官方是否涨价',
  businessDate: '2026-08-10',
  projectId: 'project-parent-1',
  research: {
    gapId: 'research-abc',
    parentJobId: 'job-parent-1',
    parentTaskId: 'task-parent-1',
    parentRoleId: 'writer',
    requiredClaims: [
      { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price' },
      { key: 'glm52_safety_policy', text: 'GLM 5.2 官方安全政策', type: 'policy' }
    ],
    budget: { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 },
    channels: ['web', 'x', 'xhs']
  }
};

test('research projections role derivation maps reporter+research to intent research', () => {
  const parsed = parseRoleJobRequest(RESEARCH_REQUEST);
  assert.equal(parsed.roleId, 'reporter');
  assert.equal(parsed.projectId, 'project-parent-1');
  assert.equal(parsed.research.gapId, 'research-abc');
  assert.equal(parsed.research.parentRoleId, 'writer');
  assert.deepEqual(parsed.research.channels, ['web', 'x', 'xhs']);
  const spec = deriveRoleJobSpec(parsed, 'ws');
  assert.equal(spec.roleId, 'reporter');
  assert.equal(spec.intent, 'research');
  assert.equal(spec.policy, 'research');
  assert.equal(spec.readback, 'research_evidence');
  assert.equal(spec.businessDate, '2026-08-10');
  assert.equal(spec.projectId, 'project-parent-1');
  // resourceLocks = reporter 锁键（scan:ws:date:all，research 无 channelIds）+ research:{parentJobId}
  assert.deepEqual(spec.resourceLocks, ['scan:ws:2026-08-10:all', 'research:job-parent-1']);
});

test('research projections role derivation uses registry maps for research policy/readback/failure', () => {
  const parsed = parseRoleJobRequest(RESEARCH_REQUEST);
  const spec = deriveRoleJobSpec(parsed, 'ws');
  // deriveRoleJobSpec 的 policy/readback 来自扩展后的注册表映射。
  assert.equal(spec.policy, 'research');
  assert.equal(spec.readback, 'research_evidence');
  // 既有角色映射不受 research 映射扩展扰动。
  assert.equal(roleToPolicy('reporter'), 'scan');
  assert.equal(roleToPolicy('planner'), 'judge');
  assert.equal(roleToPolicy('writer'), 'draft');
  assert.equal(roleToPolicy('librarian'), 'organize');
  assert.equal(roleToReadbackKind('reporter'), 'scan_phase');
  assert.equal(roleToReadbackKind('planner'), 'plans_revision');
  assert.equal(roleToReadbackKind('writer'), 'content_version');
  assert.equal(roleToReadbackKind('librarian'), 'library_mutation');
  assert.equal(roleFailureCode('reporter'), JOB_ERROR_CODES.REPORTER_SCAN_FAILED);
  assert.equal(roleFailureCode('planner'), JOB_ERROR_CODES.PLANNER_JUDGE_FAILED);
  assert.equal(roleFailureCode('writer'), JOB_ERROR_CODES.WRITER_DRAFT_FAILED);
  assert.equal(roleFailureCode('librarian'), JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED);
});

// ---- research projections: malformed / non-reporter rejection ------------

test('research projections reject research block on non-reporter roles', () => {
  for (const roleId of ['planner', 'writer', 'librarian']) {
    assert.throws(() => parseRoleJobRequest({ roleId, brief: 'x', research: RESEARCH_REQUEST.research }), (error) => {
      assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
      return true;
    }, `${roleId} 不得接收 research 块`);
  }
});

test('research projections reject malformed research gaps fail-closed', () => {
  const cases = [
    // 缺 gapId
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, gapId: undefined } },
    // 缺 parentJobId
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, parentJobId: undefined } },
    // 缺 parentTaskId
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, parentTaskId: undefined } },
    // 父角色为 reporter/research/未知
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, parentRoleId: 'reporter' } },
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, parentRoleId: 'research' } },
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, parentRoleId: 'desk' } },
    // requiredClaims 空 / 缺 type / 缺 text
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, requiredClaims: [] } },
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, requiredClaims: [{ key: 'k', text: 't', type: 'bogus' }] } },
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, requiredClaims: [{ key: 'k', text: '', type: 'fact' }] } },
    // budget 缺字段 / 非正数
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, budget: { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3 } } },
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, budget: { timeMinutes: 0, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 } } },
    // channels 空 / 非枚举
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, channels: [] } },
    { ...RESEARCH_REQUEST, research: { ...RESEARCH_REQUEST.research, channels: ['web', 'facebook'] } },
    // research 块非对象
    { ...RESEARCH_REQUEST, research: 'not-an-object' }
  ];
  for (const input of cases) {
    assert.throws(() => parseRoleJobRequest(input), (error) => {
      assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
      return true;
    }, `malformed research must be rejected`);
  }
  // 外部 intent 输入仍被拒绝（派生唯一真相源不变）。
  assert.throws(() => parseRoleJobRequest({ ...RESEARCH_REQUEST, intent: 'research' }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
    return true;
  });
  // research 变体不接收 reporter 渠道键。
  assert.throws(() => parseRoleJobRequest({ ...RESEARCH_REQUEST, channelIds: ['c1'] }), (error) => {
    assert.equal(error.code, JOB_ERROR_CODES.VALIDATION_ERROR);
    return true;
  });
});

// ---- research projections: zero regression -------------------------------

test('research projections zero regression: existing role requests derive unchanged specs', () => {
  assert.equal(deriveIntentForRole('reporter'), 'daily_scan');
  assert.equal(deriveIntentForRole('planner'), 'daily_judge');
  assert.equal(deriveIntentForRole('writer'), 'studio_draft');
  assert.equal(deriveIntentForRole('librarian'), 'page_library');

  const reporter = deriveRoleJobSpec(parseRoleJobRequest({ roleId: 'reporter', brief: '扫', businessDate: '2026-08-10', channelIds: ['c1'] }), 'ws');
  assert.equal(reporter.intent, 'daily_scan');
  assert.equal(reporter.policy, 'scan');
  assert.equal(reporter.readback, 'scan_phase');
  assert.deepEqual(reporter.resourceLocks, ['scan:ws:2026-08-10:c1']);

  const planner = deriveRoleJobSpec(parseRoleJobRequest({ roleId: 'planner', brief: '判', businessDate: '2026-08-10' }), 'ws');
  assert.equal(planner.intent, 'daily_judge');
  assert.equal(planner.policy, 'judge');
  assert.equal(planner.readback, 'plans_revision');
  assert.deepEqual(planner.resourceLocks, ['plan:ws:2026-08-10']);

  const writer = deriveRoleJobSpec(parseRoleJobRequest({ roleId: 'writer', brief: '写', projectId: 'p1', businessDate: '2026-08-10' }), 'ws');
  assert.equal(writer.intent, 'studio_draft');
  assert.equal(writer.policy, 'draft');
  assert.equal(writer.readback, 'content_version');
  assert.deepEqual(writer.resourceLocks, ['project:ws:p1']);

  const librarian = deriveRoleJobSpec(parseRoleJobRequest({ roleId: 'librarian', brief: '理', sourceIds: ['s1'], scope: null }), 'ws');
  assert.equal(librarian.intent, 'page_library');
  assert.equal(librarian.policy, 'organize');
  assert.equal(librarian.readback, 'library_mutation');
  assert.deepEqual(librarian.resourceLocks, ['library-maintenance:ws']);
});

// ---- research MCP read gate: mounted dispatch -----------------------------

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

/** 预置 research / 非 research 任务行（intent CHECK 在 WMB-5171 才含 research，测试用 ignore_check_constraints 注入）。 */
function seedTasks(database) {
  database.exec('PRAGMA ignore_check_constraints = ON');
  const now = new Date().toISOString();
  const insert = (id, intent) => database.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
    created_at, updated_at, finished_at
  ) VALUES (?,?,?,?,?,null,'{}','{}','{}','{}','[]',null,null,null,null,?,?,?)`).run(
    id, intent, '2026-08-11', 'running', 'researching', now, now, now
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

test('research MCP read gate blocks off-whitelist tools in a research session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      // 有效 lease + research 会话：白名单外工具仍必须被拦（handler 未执行）。
      const meta = { taskId: 'research-task', workerLeaseId: lease.leaseId };
      const blocked = [
        ['context.get_workbench', {}],
        ['plans.get', {}],
        ['content.get', { project_id: 'missing' }],
        ['knowledge.get_context', {}],
        ['x_lists.prepare', { request_id: 'r', account_key: '@owner', kind: 'create', task_id: 'research-task', grant_id: 'g', worker_lease_id: 'w' }]
      ];
      for (const [name, args] of blocked) {
        const result = await dispatchTool(mcp, name, args, meta);
        assert.equal(result.ok, false, `${name} must be blocked`);
        assert.equal(result.error.code, 'READ_PROFILE_BLOCKED', name);
        assert.deepEqual(result.error.details, { reason: 'RESEARCH_READ_WHITELIST' }, name);
      }
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate allows whitelist tools through to existing handlers with a valid lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      const meta = { taskId: 'research-task', workerLeaseId: lease.leaseId };
      // sources.get 白名单内 → 到达既有 handler（缺失 id 返回 null，而非 BLOCKED）。
      const got = await dispatchTool(mcp, 'sources.get', { id: 'missing' }, meta);
      assert.equal(got, null);
      const searched = await dispatchTool(mcp, 'sources.search', { query: 'x' }, meta);
      assert.deepEqual(searched, []);
      // agent_tasks.get 基础设施白名单 → 到达 handler 并回读 research 任务。
      const task = await dispatchTool(mcp, 'agent_tasks.get', { task_id: 'research-task' }, meta);
      assert.equal(task?.id, 'research-task');
      // x_lists.read_index 白名单内 → 到达 handler（无浏览器绑定 → BROWSER_NEEDS_USER，而非 READ_PROFILE_BLOCKED）。
      const read = await dispatchTool(mcp, 'x_lists.read_index', {}, meta);
      assert.equal(read.error.code, 'BROWSER_NEEDS_USER');
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate writes role_authority_blocked audit row with role/command/taskId/reason/time', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      // 有效 lease 下越权调用 → 白名单拦截 + 审计。
      const result = await dispatchTool(mcp, 'context.get_workbench', {}, { taskId: 'research-task', workerLeaseId: lease.leaseId });
      assert.equal(result.error.code, 'READ_PROFILE_BLOCKED');
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
    const audit = migrateDatabase(path.join(root, 'wmb.db'));
    try {
      const row = audit.prepare("SELECT * FROM operation_log WHERE entity_type='role_authority_blocked' ORDER BY created_at DESC LIMIT 1").get();
      assert.ok(row, 'audit row must exist');
      assert.equal(row.entity_type, 'role_authority_blocked');
      assert.equal(row.entity_id, 'research-task');
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

test('research MCP read gate blocks research task with missing worker lease (fail closed)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  const mcp = await startMcp(root);
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db'));
    try { seedTasks(db); } finally { db.close(); }
    // 只带 taskId 不带 workerLeaseId：research 任务仍必须被拦（taskId-only 旧通道已封死，
    // 白名单工具也不例外）。
    const result = await dispatchTool(mcp, 'sources.get', { id: 'missing' }, { taskId: 'research-task' });
    assert.equal(result.error.code, 'READ_PROFILE_BLOCKED');
    assert.deepEqual(result.error.details, { reason: 'RESEARCH_READ_WHITELIST' });
    const audit = migrateDatabase(path.join(root, 'wmb.db'));
    try {
      const row = audit.prepare("SELECT * FROM operation_log WHERE entity_type='role_authority_blocked' ORDER BY created_at DESC LIMIT 1").get();
      assert.equal(row.entity_id, 'research-task');
      assert.equal(row.command, 'sources.get');
      assert.equal(row.error_code, 'RESEARCH_READ_WHITELIST');
    } finally {
      audit.close();
    }
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate blocks stale/forged lease: handler not called and audited', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      // 伪造：lease 绑定到别的任务（scan-task），却以 research-task 身份调用。
      const forged = bindLease(runtime, 'scan-task');
      const forgedResult = await dispatchTool(mcp, 'x_lists.read_index', {}, { taskId: 'research-task', workerLeaseId: forged.leaseId });
      assert.equal(forgedResult.error.code, 'READ_PROFILE_BLOCKED', '伪造 taskId+lease 必须被拦');
      runtime.releaseWorker(forged);
      // 过期：lease 已释放（workers 条目移除）→ isCurrentWorkerLease false。
      const stale = bindLease(runtime, 'research-task');
      const staleLeaseId = stale.leaseId;
      runtime.releaseWorker(stale);
      const staleResult = await dispatchTool(mcp, 'x_lists.read_index', {}, { taskId: 'research-task', workerLeaseId: staleLeaseId });
      assert.equal(staleResult.error.code, 'READ_PROFILE_BLOCKED', '过期 lease 必须被拦');
      // 两者都不是 BROWSER_NEEDS_USER（真 handler 对无浏览器绑定会返回它）→ 证明 handler 未被调用。
      const audit = migrateDatabase(path.join(root, 'wmb.db'));
      try {
        const rows = audit.prepare("SELECT * FROM operation_log WHERE entity_type='role_authority_blocked' AND command='x_lists.read_index' ORDER BY created_at DESC LIMIT 2").all();
        assert.equal(rows.length, 2, '两次拦截都必须审计');
        for (const row of rows) {
          assert.equal(row.entity_id, 'research-task');
          assert.equal(row.client_label, 'reporter');
          assert.equal(row.error_code, 'RESEARCH_READ_WHITELIST');
          assert.equal(row.result, 'error');
        }
      } finally {
        audit.close();
      }
    } finally {
      await mcp.close();
    }
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate: real extension client injects env-derived taskId+workerLeaseId into tools/call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-client-'));
  let runtime = null;
  const previous = {
    WMB_MCP_URL: process.env.WMB_MCP_URL,
    WMB_AGENT_TASK_ID: process.env.WMB_AGENT_TASK_ID,
    WMB_WORKER_LEASE_ID: process.env.WMB_WORKER_LEASE_ID
  };
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      process.env.WMB_MCP_URL = mcp.url;
      process.env.WMB_AGENT_TASK_ID = 'research-task';
      process.env.WMB_WORKER_LEASE_ID = lease.leaseId;
      // 白名单工具经真实扩展客户端到达 handler（sources.get missing → null，非 BLOCKED）。
      const got = await callTool('sources.get', { id: 'missing' });
      assert.equal(JSON.parse(got.content[0].text), null);
      // 越权工具 → READ_PROFILE_BLOCKED（_meta 已随请求注入并被服务端识别）。
      const blocked = await callTool('context.get_workbench', {});
      assert.equal(JSON.parse(blocked.content[0].text).error.code, 'READ_PROFILE_BLOCKED');
      // 任一 env 缺失 → 不注入 _meta → taskless 老路径放行。
      delete process.env.WMB_AGENT_TASK_ID;
      delete process.env.WMB_WORKER_LEASE_ID;
      const taskless = await callTool('context.get_workbench', {});
      assert.notEqual(JSON.parse(taskless.content[0].text).error?.code, 'READ_PROFILE_BLOCKED');
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate blocks channel resolve/trial and manager spawn in research sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  let runtime = null;
  try {
    runtime = await openResearchGateRuntime(root);
    const lease = bindLease(runtime, 'research-task');
    const mcp = await startMcp(root, runtime.gate, gateApplication(), runtime);
    try {
      const meta = { taskId: 'research-task', workerLeaseId: lease.leaseId };
      const blocked = [
        ['intelligence_channels.resolve_website', { input_text: 'Example' }],
        ['intelligence_channels.trial_website', { url: 'https://example.com' }],
        ['jobs.spawn', { role_id: 'reporter', brief: 'x' }],
        ['plans.save', { request_id: 'r', task_id: 'research-task', grant_id: 'g', plan_date: '2026-08-11', summary: 's', items: [] }],
        ['knowledge.record_batch', { request_id: 'r', task_id: 'research-task', grant_id: 'g', items: [{ sourceId: 's1', topic: { title: 't' } }] }],
        ['sources.lane_gate', { request_id: 'r', task_id: 'research-task', grant_id: 'g', judgments: [{ sourceId: 's1', decision: 'irrelevant', reasonCode: 'off_lane_content', expectedRevision: 1 }] }]
      ];
      for (const [name, args] of blocked) {
        const result = await dispatchTool(mcp, name, args, meta);
        assert.equal(result.ok, false, `${name} must be blocked`);
        assert.equal(result.error.code, 'READ_PROFILE_BLOCKED', name);
        assert.deepEqual(result.error.details, { reason: 'RESEARCH_READ_WHITELIST' }, name);
      }
      // 唯一写回 wmb_save_source（sources.upsert_batch）与基础设施 report_progress 放行到既有 handler。
      const saved = await dispatchTool(mcp, 'sources.upsert_batch', {
        request_id: 'research-save-1', task_id: 'research-task',
        items: [{ title: 't', originalUrl: 'https://example.com/s' }]
      }, meta);
      assert.notEqual(saved.error?.code, 'READ_PROFILE_BLOCKED');
      const reported = await dispatchTool(mcp, 'agent_tasks.report_progress', {
        request_id: 'research-progress-1', task_id: 'research-task', grant_id: 'grant-x',
        phase: 'researching'
      }, meta);
      assert.notEqual(reported.error?.code, 'READ_PROFILE_BLOCKED');
      runtime.releaseWorker(lease);
    } finally {
      await mcp.close();
    }
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate leaves non-research sessions on the old path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  const mcp = await startMcp(root);
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db'));
    try { seedTasks(db); } finally { db.close(); }
    // daily_scan 任务（非 research）带 taskId+lease 调 workbench → 老路径（handler 正常执行，不被拦截）。
    const result = await dispatchTool(mcp, 'context.get_workbench', {}, { taskId: 'scan-task', workerLeaseId: 'scan-lease' });
    assert.notEqual(result.error?.code, 'READ_PROFILE_BLOCKED');
    const got = await dispatchTool(mcp, 'sources.get', { id: 'missing' }, { taskId: 'scan-task', workerLeaseId: 'scan-lease' });
    assert.equal(got, null);
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('research MCP read gate leaves taskless requests on the old path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5170-gate-'));
  const mcp = await startMcp(root);
  try {
    // 无 taskId 的请求（UI/桌助）→ 老路径，不查白名单。
    const result = await dispatchTool(mcp, 'context.get_workbench', {});
    assert.notEqual(result.error?.code, 'READ_PROFILE_BLOCKED');
    const got = await dispatchTool(mcp, 'sources.get', { id: 'missing' });
    assert.equal(got, null);
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
