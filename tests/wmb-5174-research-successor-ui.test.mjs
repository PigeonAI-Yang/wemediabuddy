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
const { RESEARCH_DEFAULT_BUDGET } = await import('../src/main/research-job-runner.ts');
const { buildResearchEvidencePack } = await import('../src/main/research-task-state.ts');
const { upsertResearchClaim } = await import('../src/main/db/research-claims-store.ts');
const { decideResearchSuccessor, decideResearchSuccessorViaRuntime, enqueueResearchSuccessor, getResearchSuccessorById } = await import('../src/main/research-successor.ts');
const { listResearchSuccessorNeedsUser, readCrewResearchSummary } = await import('../src/main/research-successor-projection.ts');
const { readCrewInstanceProjection } = await import('../src/main/crew-instance-projection.ts');
const { instanceStatusWord, researchClaimLine } = await import('../src/renderer/agents-instance-logic.ts');

const BUSINESS_DATE = '2026-08-13';
const BUDGET = { ...RESEARCH_DEFAULT_BUDGET };

function nowIso() {
  return new Date().toISOString();
}

/** 裸库（无写守卫）：纯 DB 函数测试面。 */
async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5174-db-'));
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5174-rt-'));
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

/** 父任务（原角色工单）：agent_tasks 行 + 持久续派合同 refs。 */
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

/** research 任务：合同 refs + EvidencePack；可带 progress（记者卡预算计数）。 */
function seedResearchTask(db, { parent, parentRoleId = 'writer', status = 'succeeded', taskId = `research-${randomUUID()}`, requiredClaims = [claim('claim_a')], unresolvedRequiredClaims = [], progress = {}, terminalReason = 'claims_resolved', budget = BUDGET }) {
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
  const pack = buildResearchEvidencePack({
    jobId: taskId,
    round: 1,
    claims: requiredClaims.map((c) => ({
      id: `claim-row-${c.key}`,
      key: c.key,
      status: unresolvedRequiredClaims.includes(c.key) ? 'unresolved' : 'supported',
      verdictReason: unresolvedRequiredClaims.includes(c.key) ? 'threshold_not_met' : 'official_source',
      evidenceSourceIds: [],
      needsTimeExcerpt: c.type !== 'fact'
    })),
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

// ---------------------------------------------------------------------------
// 1. Today 投影：只含 unresolved required needs_user；原文来自 research_claims；候选/进度不上桌
// ---------------------------------------------------------------------------

test('WMB-5174: Today projection exposes only needs_user successors with unresolved claim texts', () => withDb((db) => {
  const parentNeeds = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-needs', jobId: 'job-needs' });
  const researchNeeds = seedResearchTask(db, {
    parent: parentNeeds, status: 'partial', taskId: 'research-needs',
    requiredClaims: [claim('claim_a', 'GLM 5.2 官方是否涨价', 'price'), claim('claim_b', 'X 订阅是否降价')],
    unresolvedRequiredClaims: ['claim_a'], progress: { planned: 40, processed: 22, verified: 15, saved: 12 }
  });
  seedClaim(db, researchNeeds.taskId, { key: 'claim_a', text: 'GLM 5.2 官方是否涨价', type: 'price', status: 'unresolved' });
  const enqueued = enqueueResearchSuccessor(db, { researchTaskId: researchNeeds.taskId });
  assert.equal(enqueued.job?.status, 'needs_user');

  // 全部 resolved → pending：不得上 Today（无未解决声明不占桌）。
  const parentOk = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-2', taskId: 'parent-ok', jobId: 'job-ok' });
  const researchOk = seedResearchTask(db, { parent: parentOk, status: 'succeeded', taskId: 'research-ok', requiredClaims: [claim('claim_ok')], unresolvedRequiredClaims: [] });
  const enqueuedOk = enqueueResearchSuccessor(db, { researchTaskId: researchOk.taskId });
  assert.equal(enqueuedOk.job?.status, 'pending');

  const items = listResearchSuccessorNeedsUser(db);
  assert.equal(items.length, 1, '只有 needs_user 上桌；pending 不上桌');
  const item = items[0];
  assert.equal(item.id, enqueued.job.id);
  assert.equal(item.parentJobId, 'job-needs');
  assert.equal(item.parentRoleId, 'writer');
  assert.equal(item.projectId, 'proj-1', 'WMB-5296：父任务持久 refs 的 projectId 精确投影（Studio 匹配依据）');
  assert.equal(item.decision, null, 'needs_user 尚未决策');
  assert.equal(item.unresolvedClaims.length, 1);
  assert.equal(item.unresolvedClaims[0].key, 'claim_a');
  assert.equal(item.unresolvedClaims[0].text, 'GLM 5.2 官方是否涨价', '原文来自 research_claims 冻结行');
  assert.equal(item.unresolvedClaims[0].type, 'price');
  // 只投影声明语义：候选/进度/裸资料字段不得出现。
  const allowed = ['id', 'parentJobId', 'parentTaskId', 'researchTaskId', 'parentRoleId', 'projectId', 'unresolvedClaims', 'decision', 'createdAt', 'updatedAt'];
  assert.deepEqual(Object.keys(item).sort(), allowed.sort(), '投影只含声明语义，候选/进度/裸资料不上桌');
  const decidedPayload = { ...JSON.parse(enqueued.job.payload ? JSON.stringify(enqueued.job.payload) : '{}'), decision: 'narrow' };
  db.prepare("UPDATE jobs SET status='needs_user', payload_json=? WHERE id=?").run(JSON.stringify(decidedPayload), enqueued.job.id);
  assert.equal(listResearchSuccessorNeedsUser(db).length, 0, '已自动决策的续派不得因后续 needs_user 重复索要研究选择');
}));

test('WMB-5174: Today projection omits claim text when research_claims row is missing (never fabricates)', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'daily_judge', roleId: 'planner', taskId: 'parent-pl', jobId: 'job-pl' });
  const research = seedResearchTask(db, {
    parent, parentRoleId: 'planner', status: 'partial', taskId: 'research-pl',
    requiredClaims: [claim('claim_x')], unresolvedRequiredClaims: ['claim_x']
  });
  enqueueResearchSuccessor(db, { researchTaskId: research.taskId });
  const items = listResearchSuccessorNeedsUser(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].parentRoleId, 'planner');
  assert.equal(items[0].projectId, null, 'WMB-5296：planner 父任务无 projectId（非项目边界）→ null，不推断');
  assert.equal(items[0].unresolvedClaims[0].key, 'claim_x');
  assert.equal(items[0].unresolvedClaims[0].text, null, 'claim 行缺失 → text=null，不编造原文');
}));

// ---------------------------------------------------------------------------
// 2. 记者卡研究摘要：research 任务有预算计数 + claim 计数；非 research 恒 null
// ---------------------------------------------------------------------------

test('WMB-5174: reporter research summary carries progress counts and claim verdicts; non-research is null', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-r', jobId: 'job-r' });
  const research = seedResearchTask(db, {
    parent, status: 'running', taskId: 'research-running',
    requiredClaims: [claim('a'), claim('b'), claim('c')], unresolvedRequiredClaims: ['c'],
    progress: { planned: 40, processed: 18, verified: 15, saved: 11, message: '研究进行中' }
  });
  seedClaim(db, research.taskId, { key: 'a', text: 'A', type: 'fact', status: 'supported' });
  seedClaim(db, research.taskId, { key: 'b', text: 'B', type: 'fact', status: 'contradicted' });
  seedClaim(db, research.taskId, { key: 'c', text: 'C', type: 'price', status: 'unresolved' });

  // 非 research 记者（daily_scan）摘要恒 null。
  assert.equal(readCrewResearchSummary(db, { id: 'scan-1', intent: 'daily_scan', progress: {} }), null);

  const summary = readCrewResearchSummary(db, { id: research.taskId, intent: 'research', progress: { planned: 40, processed: 18, verified: 15, saved: 11 } });
  assert.deepEqual(summary, {
    planned: 40, processed: 18, verified: 15, saved: 11,
    claims: { total: 3, supported: 1, contradicted: 1, unresolved: 1, sourceUnavailable: 0, pending: 0 }
  });

  // 缺字段不伪造：progress 缺 verified → null；无 claim 行 → claims null。
  const sparse = readCrewResearchSummary(db, { id: 'research-sparse', intent: 'research', progress: { planned: 10, processed: 4 } });
  assert.equal(sparse.verified, null);
  assert.equal(sparse.claims, null);
}));

test('WMB-5174: crew projection attaches research summary to reporter instances', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-cp', jobId: 'job-cp' });
  seedResearchTask(db, {
    parent, status: 'succeeded', taskId: 'research-cp', requiredClaims: [claim('k1')], unresolvedRequiredClaims: [],
    progress: { planned: 40, processed: 18, verified: 15, saved: 11 }
  });
  seedClaim(db, 'research-cp', { key: 'k1', text: 'K1', type: 'fact', status: 'supported' });
  const projection = readCrewInstanceProjection({ database: db, pool: null });
  const researchInstance = [...projection.active, ...projection.history].find((i) => i.jobId === 'research-job-research-cp');
  assert.ok(researchInstance, 'research 工单实例可从持久面投影');
  assert.equal(researchInstance.research?.processed, 18);
  assert.equal(researchInstance.research?.verified, 15);
  assert.equal(researchInstance.research?.claims?.total, 1);
}));

// ---------------------------------------------------------------------------
// 3. 三动作精确接 decideResearchSuccessor：状态/决策说明/错误诚实
// ---------------------------------------------------------------------------

test('WMB-5174: three actions each resume needs_user → pending with distinct decision note', () => withDb((db) => {
  const makeRow = (key) => {
    const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: `parent-${key}`, jobId: `job-${key}` });
    const research = seedResearchTask(db, { parent, status: 'partial', taskId: `research-${key}`, requiredClaims: [claim('c')], unresolvedRequiredClaims: ['c'] });
    const enqueued = enqueueResearchSuccessor(db, { researchTaskId: research.taskId });
    assert.equal(enqueued.job.status, 'needs_user');
    return enqueued.job;
  };
  const expectations = [
    ['narrow', '【主管决策：收窄】'],
    ['supplement', '【主管决策：手动补料】'],
    ['accept', '【主管决策：接受标注待核实】']
  ];
  for (const [decision, note] of expectations) {
    const row = makeRow(decision);
    const result = decideResearchSuccessor(db, row.id, decision);
    assert.equal(result.ok, true, `${decision} 决策成功`);
    assert.equal(result.data.status, 'pending', `${decision}：needs_user → pending`);
    assert.equal(result.data.payload.decision, decision);
    assert.match(result.data.payload.briefSuffix, new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${decision} 决策说明写入续派 brief`);
  }
}));

test('WMB-5174: decide errors are honest (unknown/terminal/invalid action)', () => withDb((db) => {
  const unknown = decideResearchSuccessor(db, 'no-such-row', 'accept');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'NOT_FOUND');

  const invalid = decideResearchSuccessor(db, 'no-such-row', 'whatever');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'NOT_FOUND');

  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-t', jobId: 'job-t' });
  const research = seedResearchTask(db, { parent, status: 'partial', taskId: 'research-t', requiredClaims: [claim('c')], unresolvedRequiredClaims: ['c'] });
  const row = enqueueResearchSuccessor(db, { researchTaskId: research.taskId }).job;
  const badAction = decideResearchSuccessor(db, row.id, 'skip');
  assert.equal(badAction.ok, false);
  assert.equal(badAction.error.code, 'VALIDATION_ERROR');
  assert.match(badAction.error.message, /收窄\/手动补料\/接受标注待核实/);

  // 已终态行不可再决策。
  const parentDone = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-d', jobId: 'job-d' });
  const researchDone = seedResearchTask(db, { parent: parentDone, status: 'succeeded', taskId: 'research-d', requiredClaims: [claim('ok')], unresolvedRequiredClaims: [] });
  const doneRow = enqueueResearchSuccessor(db, { researchTaskId: researchDone.taskId }).job;
  assert.equal(doneRow.status, 'pending');
  const doneDecide = decideResearchSuccessor(db, doneRow.id, 'accept');
  assert.equal(doneDecide.ok, true, 'pending 行决策幂等返回当前行（重放安全）');
  assert.equal(doneDecide.data.status, 'pending');
}));

test('WMB-5174: runtime decide path (IPC 使用的封装) works through write guard', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1', taskId: 'parent-rt', jobId: 'job-rt' });
  const research = seedResearchTask(db, { parent, status: 'partial', taskId: 'research-rt', requiredClaims: [claim('c')], unresolvedRequiredClaims: ['c'] });
  const row = enqueueResearchSuccessor(db, { researchTaskId: research.taskId }).job;
  return { row };
}, async (runtime, { row }) => {
  const result = await decideResearchSuccessorViaRuntime(runtime, row.id, 'narrow');
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'pending');
  assert.equal(result.data.payload.decision, 'narrow');
  const readback = getResearchSuccessorById(runtime.database, row.id);
  assert.equal(readback.status, 'pending', '决策经写守卫持久化');
}));

// ---------------------------------------------------------------------------
// 4. Renderer 纯逻辑：研究中状态词 + claim 摘要行（数据缺失不伪造）
// ---------------------------------------------------------------------------

test('WMB-5174: renderer instanceStatusWord shows 研究中 for running research only', () => {
  assert.equal(instanceStatusWord({ intent: 'research', status: 'running' }), '研究中');
  assert.equal(instanceStatusWord({ intent: 'research', status: 'needs_user' }), '等你批', '非 running 不冒充研究中');
  assert.equal(instanceStatusWord({ intent: 'daily_scan', status: 'running' }), '工作中');
  assert.equal(instanceStatusWord({ intent: null, status: 'succeeded' }), '已完成');
});

test('WMB-5174: renderer researchClaimLine never fabricates counts', () => {
  assert.equal(researchClaimLine(null), null);
  assert.equal(researchClaimLine({ claims: null }), null);
  assert.equal(
    researchClaimLine({ claims: { total: 3, supported: 1, contradicted: 1, unresolved: 1, sourceUnavailable: 0, pending: 0 } }),
    '声明 3：支持 1 · 反驳 1 · 待核实 1'
  );
  assert.equal(
    researchClaimLine({ claims: { total: 2, supported: 2, contradicted: 0, unresolved: 0, sourceUnavailable: 0, pending: 0 } }),
    '声明 2：支持 2'
  );
  assert.equal(
    researchClaimLine({ claims: { total: 4, supported: 0, contradicted: 0, unresolved: 1, sourceUnavailable: 2, pending: 1 } }),
    '声明 4：支持 0 · 待核实 3 · 待判定 1'
  );
});
