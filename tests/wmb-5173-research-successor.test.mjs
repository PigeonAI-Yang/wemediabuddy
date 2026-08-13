import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';

// TS loader（与 wmb-5172 同款）：解析 .ts 相对导入。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { dispatchBusinessCommand } = await import('../src/main/business-command.ts');
const { upsertResearchClaim, listResearchClaims } = await import('../src/main/db/research-claims-store.ts');
const { dispatchPersistResearchClaims, writeResearchTerminal } = await import('../src/main/research-job-runtime.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { JobSpawner } = await import('../src/main/job-spawner.ts');
const { buildJobContextRefs, buildJobObjectBoundary } = await import('../src/main/job-object-boundary.ts');
const { getAgentTask } = await import('../src/main/agent-tasks.ts');
const { RESEARCH_DEFAULT_BUDGET } = await import('../src/main/research-job-runner.ts');
const { buildResearchEvidencePack, parseResearchEvidencePack } = await import('../src/main/research-task-state.ts');
const {
  RESEARCH_SUCCESSOR_ACTIONS,
  decideResearchSuccessor,
  decideResearchSuccessorViaRuntime,
  enqueueResearchSuccessor,
  enqueueResearchSuccessorForTask,
  getResearchSuccessor,
  handleResearchSuccessorJobEvent,
  kickResearchSuccessors,
  reconcileResearchSuccessors,
  reconcileResearchSuccessorsViaRuntime,
  reconcileStaleRunningResearchSuccessors,
  reconcileStaleRunningResearchSuccessorsViaRuntime,
  researchSuccessorDedupeKey
} = await import('../src/main/research-successor.ts');
const { deriveResearchParentRole, dispatchResearchForEvidenceGap } = await import('../src/main/research-dispatch.ts');

const BUSINESS_DATE = '2026-08-11';
const BUDGET = { ...RESEARCH_DEFAULT_BUDGET };

function nowIso() {
  return new Date().toISOString();
}

/** 裸库（无写守卫）：纯 DB 函数测试面。 */
async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5173-db-'));
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await work(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** 真实运行时（写守卫）：seed 在开库前于裸连接落盘，之后 work 用命令层/调度面。 */
async function withRuntime(seed, work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5173-rt-'));
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
      : roleId === 'librarian'
        ? { roleId, brief: `父工单 ${roleId} brief`, scope: 'workspace' }
        : { roleId, brief: `父工单 ${roleId} brief`, businessDate };
  const boundary = buildJobObjectBoundary(request, roleId === 'librarian' ? null : businessDate);
  const refs = buildJobContextRefs({ jobId, request, boundary });
  insertAgentTask(db, { id: taskId, intent, businessDate, contextRefs: refs });
  return { taskId, jobId, businessDate, projectId: roleId === 'writer' ? projectId : null, request, refs };
}

function claim(key, text = `声明 ${key}`, type = 'fact') {
  return { key, text, type };
}

/** research 任务：合同 refs（reporter + research 块）+ EvidencePack 落 result_refs。 */
function seedResearchTask(db, { parent, parentRoleId = 'writer', status = 'succeeded', taskId = `research-${randomUUID()}`, requiredClaims = [claim('claim_a')], unresolvedRequiredClaims = [], claims, terminalReason = 'claims_resolved', budget = BUDGET }) {
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
    resultRefs: pack
  });
  return { taskId, gap, pack };
}

function successorRowCount(db, parentJobId) {
  return Number(db.prepare('SELECT count(*) count FROM jobs WHERE kind = ? AND dedupe_key = ?').get('research_successor', researchSuccessorDedupeKey(parentJobId)).count);
}

function rowStatus(db, id) {
  return db.prepare('SELECT status status FROM jobs WHERE id = ?').get(id).status;
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

/** 测试夹具：经命令派发（写守卫授权）改写 research_successor 行状态/时间，模拟崩溃残留现场。 */
function mutateSuccessorRow(runtime, id, { updatedAtAgoMs = 0, status = null, attempts = null, startedAt = null }) {
  return dispatchBusinessCommand(runtime, {
    command: 'test.mutate_research_successor',
    requestId: `test:mutate:${id}:${randomUUID()}`,
    actor: { type: 'scheduler', id: 'research-successor', label: 'research-successor' },
    input: { entityId: id },
    boundIdentity: { entityType: 'research_successor', entityId: id },
    entityType: 'research_successor',
    execute: (db) => {
      const assignments = [];
      const params = [];
      if (status !== null) { assignments.push('status = ?'); params.push(status); }
      if (attempts !== null) { assignments.push('attempts = ?'); params.push(attempts); }
      if (startedAt !== null) { assignments.push('started_at = ?'); params.push(startedAt); }
      if (updatedAtAgoMs > 0) { assignments.push('updated_at = ?'); params.push(new Date(Date.now() - updatedAtAgoMs).toISOString()); }
      if (!assignments.length) throw new Error('no-op mutate');
      db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ? AND kind = 'research_successor'`).run(...params, id);
      return { data: { id }, entityId: id };
    }
  });
}

// ---------------------------------------------------------------------------
// 1. evidenceGap 自动派记者：同父唯一 + 边界继承 + 三层止环（派生层/行为层）
// ---------------------------------------------------------------------------

test('WMB-5173: dispatch — fresh parent spawns research job with inherited boundary', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner } = fakeSpawner(runtime);
  const first = dispatchResearchForEvidenceGap({
    spawner, database: runtime.database, parentTaskId: parent.taskId,
    requiredClaims: [claim('claim_a'), claim('claim_b', 'GLM 5.2 官方是否涨价', 'price')]
  });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  // 边界继承：businessDate + projectId 与父工单一致（reporter research 变体锁键含 projectId）。
  const job = spawner.get(first.spawnedJobId);
  assert.equal(job.roleId, 'reporter');
  assert.equal(job.intent, 'research');
  assert.equal(job.businessDate, BUSINESS_DATE);
  assert.equal(job.projectId, 'proj-1');
  assert.equal(spawner.list().filter((jobRecord) => jobRecord.intent === 'research').length, 1, '首次派单产生一个 research 工单');
  spawner.dispose();
}));

test('WMB-5173: dispatch — active research for same parent is reused (same-parent unique, no second spawn)', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  seedResearchTask(db, { parent, taskId: 'research-active-1', status: 'running', requiredClaims: [claim('claim_a')] });
  return { parent };
}, async (runtime, { parent }) => {
  const { spawner } = fakeSpawner(runtime);
  const result = dispatchResearchForEvidenceGap({
    spawner, database: runtime.database, parentTaskId: parent.taskId,
    requiredClaims: [claim('claim_c')]
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.existingTaskId, 'research-active-1');
  assert.equal(spawner.list().filter((jobRecord) => jobRecord.intent === 'research').length, 0, '同父唯一：不产生第二个 research 工单');
  spawner.dispose();
}));

test('WMB-5173: dispatch — parent task missing job contract fails closed (no dedupe chain)', async () => withRuntime(async (db) => {
  insertAgentTask(db, { id: 'parent-no-contract', intent: 'studio_draft' });
  return {};
}, async (runtime) => {
  const { spawner } = fakeSpawner(runtime);
  assert.throws(
    () => dispatchResearchForEvidenceGap({ spawner, database: runtime.database, parentTaskId: 'parent-no-contract', requiredClaims: [claim('claim_a')] }),
    /工单合同 jobId/
  );
  spawner.dispose();
}));

test('WMB-5173: dispatch — deriveResearchParentRole whitelist (research/reporter parents rejected)', () => {
  assert.equal(deriveResearchParentRole('studio_draft'), 'writer');
  assert.equal(deriveResearchParentRole('daily_judge'), 'planner');
  assert.equal(deriveResearchParentRole('page_library'), 'librarian');
  assert.equal(deriveResearchParentRole('research'), null);
  assert.equal(deriveResearchParentRole('daily_scan'), null);
  assert.equal(deriveResearchParentRole('daily_intelligence'), null);
  assert.equal(deriveResearchParentRole('results_review'), null);
});

test('WMB-5173: dispatch — three-layer stop loop: research parent (layer 1) and successor-job parent (layer 3) rejected', async () => withRuntime(async (db) => {
  const researchParent = seedParent(db, { intent: 'research', roleId: 'writer', taskId: 'parent-research', jobId: 'job-research' });
  const reporterParent = seedParent(db, { intent: 'daily_scan', roleId: 'reporter', taskId: 'parent-scan', jobId: 'job-scan' });
  const successorParent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', taskId: 'parent-succ', jobId: 'job-succ' });
  // 行为层种子：父工单 jobId 本身是 research_successor 行（续派产物）。
  const now = nowIso();
  db.prepare(
    `INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at)
     VALUES (?, 'research_successor', 'succeeded', ?, 0, ?, ?, NULL, ?, ?, NULL, ?)`
  ).run('job-succ', now, researchSuccessorDedupeKey('job-succ'), JSON.stringify({ parentJobId: 'job-succ' }), now, now, now);
  return { researchParent, reporterParent, successorParent };
}, async (runtime, { researchParent, reporterParent, successorParent }) => {
  const { spawner } = fakeSpawner(runtime);
  // 派生层：research 父（research→research 禁止）。
  assert.throws(
    () => dispatchResearchForEvidenceGap({ spawner, database: runtime.database, parentTaskId: researchParent.taskId, requiredClaims: [claim('claim_a')] }),
    /research→research/
  );
  // 派生层：reporter 父（daily_scan）不可作研究父。
  assert.throws(
    () => dispatchResearchForEvidenceGap({ spawner, database: runtime.database, parentTaskId: reporterParent.taskId, requiredClaims: [claim('claim_a')] }),
    /不可作研究父/
  );
  // 行为层：父工单是 research_successor 产物 → 拒绝自动再派（续派后缺料 needs_user 交人）。
  assert.throws(
    () => dispatchResearchForEvidenceGap({ spawner, database: runtime.database, parentTaskId: successorParent.taskId, requiredClaims: [claim('claim_a')] }),
    /续派产物/
  );
  spawner.dispose();
}));

// ---------------------------------------------------------------------------
// 2. 终态处理器 enqueue：dedupe UNIQUE + INSERT OR IGNORE 幂等；needs_user/pending 门
// ---------------------------------------------------------------------------

test('WMB-5173: enqueue — partial with unresolved claims → needs_user row with stable dedupe key; duplicate delivery ignored', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, {
    parent, status: 'partial', requiredClaims: [claim('claim_a'), claim('claim_b', 'B', 'price')], unresolvedRequiredClaims: ['claim_b'], terminalReason: 'budget_exhausted'
  });
  const first = enqueueResearchSuccessor(db, { researchTaskId: taskId });
  assert.equal(first.enqueued, true);
  assert.equal(first.reason, 'inserted');
  assert.equal(successorRowCount(db, parent.jobId), 1);
  const row = getResearchSuccessor(db, parent.jobId);
  assert.equal(row.status, 'needs_user', '未解决 required claim → 续派先入 needs_user');
  assert.equal(row.dedupeKey, researchSuccessorDedupeKey(parent.jobId));
  assert.equal(row.kind, 'research_successor');
  assert.equal(row.payload.parentJobId, parent.jobId);
  assert.equal(row.payload.parentTaskId, parent.taskId);
  assert.equal(row.payload.parentRoleId, 'writer');
  assert.equal(row.payload.researchTaskId, taskId);
  assert.deepEqual([...row.payload.unresolvedRequiredClaims], ['claim_b']);
  assert.equal(row.payload.decision, null);
  assert.ok(row.payload.briefSuffix.includes('claim_b') && row.payload.briefSuffix.includes('未解决声明'));

  // 终态重复投递：同 parentJobId 二次 enqueue → INSERT OR IGNORE 忽略，仍只有一行。
  const replay = enqueueResearchSuccessor(db, { researchTaskId: taskId });
  assert.equal(replay.enqueued, true);
  assert.equal(replay.reason, 'duplicate_ignored');
  assert.equal(successorRowCount(db, parent.jobId), 1);
  assert.equal(getResearchSuccessor(db, parent.jobId).status, 'needs_user', '重放不改状态');
}));

test('WMB-5173: enqueue — succeeded (all claims resolved) → pending row (direct run, no needs_user gate)', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'daily_judge', roleId: 'planner' });
  const { taskId } = seedResearchTask(db, { parent, parentRoleId: 'planner', status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  const result = enqueueResearchSuccessor(db, { researchTaskId: taskId });
  assert.equal(result.enqueued, true);
  const row = getResearchSuccessor(db, parent.jobId);
  assert.equal(row.status, 'pending', '全部 resolved → 续派直接运行');
  assert.equal(row.payload.parentRoleId, 'planner');
  assert.deepEqual([...row.payload.unresolvedRequiredClaims], []);
}));

test('WMB-5173: enqueue — failed/cancelled research never enqueues (zero successor)', () => withDb((db) => {
  for (const status of ['failed', 'cancelled']) {
    const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-x' });
    const { taskId } = seedResearchTask(db, { parent, status, requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: ['claim_a'], terminalReason: 'aborted' });
    const result = enqueueResearchSuccessor(db, { researchTaskId: taskId });
    assert.equal(result.enqueued, false, `${status} 不续派`);
    assert.equal(result.reason, 'status_not_terminal');
    assert.equal(successorRowCount(db, parent.jobId), 0, `${status} 零续派`);
  }
  // 兜底：reconcile 也不会为 failed/cancelled 建行。
  assert.equal(reconcileResearchSuccessors(db), 0);
  assert.equal(Number(db.prepare("SELECT count(*) count FROM jobs WHERE kind='research_successor'").get().count), 0);
}));

test('WMB-5173: enqueue — terminal task without EvidencePack or missing task fails closed', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-x' });
  // 终态但无 EvidencePack（result_refs 空）→ 不续派。
  const gap = {
    gapId: 'gap-no-pack', parentJobId: parent.jobId, parentTaskId: parent.taskId, parentRoleId: 'writer',
    requiredClaims: [claim('claim_a')], budget: { ...BUDGET }, channels: ['web']
  };
  const request = { roleId: 'reporter', brief: 'x', businessDate: parent.businessDate, projectId: parent.projectId, research: gap };
  const refs = buildJobContextRefs({ jobId: 'job-r', request, boundary: buildJobObjectBoundary(request, parent.businessDate) });
  insertAgentTask(db, { id: 'research-no-pack', intent: 'research', status: 'succeeded', phase: 'completed', contextRefs: refs, resultRefs: {} });
  const result = enqueueResearchSuccessor(db, { researchTaskId: 'research-no-pack' });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, 'evidence_pack_missing');
  assert.equal(successorRowCount(db, parent.jobId), 0);
  // 未知任务 → 不续派（fail-closed）。
  const missing = enqueueResearchSuccessor(db, { researchTaskId: 'does-not-exist' });
  assert.equal(missing.enqueued, false);
  assert.equal(missing.reason, 'task_not_found');
}));

// ---------------------------------------------------------------------------
// 3. needs_user 三动作：收窄 / 手动补料 / 接受标注待核实
// ---------------------------------------------------------------------------

test('WMB-5173: decide — three actions each resume needs_user → pending with distinct decision note', () => withDb((db) => {
  const created = [];
  for (const decision of RESEARCH_SUCCESSOR_ACTIONS) {
    const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: `proj-${decision}` });
    const { taskId } = seedResearchTask(db, {
      parent, status: 'partial', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: ['claim_a'], terminalReason: 'candidates_exhausted'
    });
    const enqueued = enqueueResearchSuccessor(db, { researchTaskId: taskId });
    assert.equal(enqueued.enqueued, true);
    const row = getResearchSuccessor(db, parent.jobId);
    assert.equal(row.status, 'needs_user');
    const decided = decideResearchSuccessor(db, row.id, decision);
    assert.equal(decided.ok, true);
    assert.equal(decided.data.status, 'pending', `${decision} 将续派恢复为待消费`);
    assert.equal(decided.data.payload.decision, decision);
    assert.ok(decided.data.payload.briefSuffix.includes('【主管决策'), `${decision} 写入决策说明`);
    created.push({ decision, row: decided.data });
  }
  // 三动作说明互不相同。
  const notes = created.map(({ decision, row }) => row.payload.briefSuffix.split('\n').find((line) => line.startsWith('【主管决策')).trim());
  assert.equal(new Set(notes).size, 3, '三动作决策说明互异');
  // 幂等：已 pending 的续派重复决策返回当前行（不覆盖原决策）。
  const replay = decideResearchSuccessor(db, created[0].row.id, 'accept');
  assert.equal(replay.ok, true);
  assert.equal(replay.data.status, 'pending');
  assert.equal(replay.data.payload.decision, created[0].decision, '重复决策不覆盖原决策');
}));

test('WMB-5173: decide — invalid action, unknown row and terminal rows rejected', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-z' });
  const { taskId } = seedResearchTask(db, { parent, status: 'partial', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: ['claim_a'], terminalReason: 'budget_exhausted' });
  enqueueResearchSuccessor(db, { researchTaskId: taskId });
  const row = getResearchSuccessor(db, parent.jobId);
  const bad = decideResearchSuccessor(db, row.id, 'other');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'VALIDATION_ERROR');
  const missing = decideResearchSuccessor(db, 'nope', 'accept');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
  // 终态行（succeeded）不可决策。
  const parent2 = seedParent(db, { intent: 'daily_judge', roleId: 'planner', taskId: 'parent-p2', jobId: 'job-p2' });
  const { taskId: t2 } = seedResearchTask(db, { parent: parent2, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  enqueueResearchSuccessor(db, { researchTaskId: t2 });
  const row2 = getResearchSuccessor(db, parent2.jobId);
  db.prepare(`UPDATE jobs SET status='succeeded', finished_at=? WHERE id=?`).run(nowIso(), row2.id);
  const terminalDecide = decideResearchSuccessor(db, row2.id, 'accept');
  assert.equal(terminalDecide.ok, false);
  assert.equal(terminalDecide.error.code, 'INVALID_STATE');
}));

// ---------------------------------------------------------------------------
// 4. 消费：rebuildRoleJobRequest + briefSuffix 派生原角色续派；重启只消费一次
// ---------------------------------------------------------------------------

test('WMB-5173: kick — consumes needs_user row after decision and spawns original-role successor with EvidencePack briefSuffix, same boundary', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, {
    parent, status: 'partial', requiredClaims: [claim('claim_a'), claim('claim_b', 'B', 'price')], unresolvedRequiredClaims: ['claim_b'], terminalReason: 'budget_exhausted'
  });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  assert.equal(row.status, 'needs_user');
  const decided = await decideResearchSuccessorViaRuntime(runtime, row.id, 'accept');
  assert.equal(decided.ok, true);

  const { spawner, spawned } = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, spawner), 1);
  const successorJob = spawner.get(row.id);
  assert.equal(successorJob.id, row.id, '续派工单以 research_successor 行 id 为 jobId（事件回指）');
  assert.equal(successorJob.roleId, 'writer', '原角色续派（writer）');
  assert.equal(successorJob.intent, 'studio_draft');
  assert.equal(successorJob.businessDate, BUSINESS_DATE, '同一边界 businessDate');
  assert.equal(successorJob.projectId, 'proj-1', '同一边界 projectId');
  assert.ok(successorJob.brief.includes('【研究续派'), 'brief 追加 EvidencePack 摘要');
  assert.ok(successorJob.brief.includes('【主管决策：接受标注待核实'), 'brief 追加决策说明');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawned.length, 1);
  // 行已消费（running）：第二次 kick 不再消费（重启只消费一次）。
  assert.equal(await kickResearchSuccessors(runtime, spawner), 0);
  spawner.dispose();
}));

test('WMB-5173: kick — restart consumes an enqueued-but-unconsumed successor exactly once', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  assert.equal(row.status, 'pending', '全部 resolved → pending 待消费');

  const first = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, first.spawner), 1);
  assert.equal(first.spawner.get(row.id).id, row.id);
  assert.equal(rowStatus(runtime.database, row.id), 'running', '消费即标记 running（崩溃后不重消费）');
  first.spawner.dispose();

  // 冷池（重启）：行 running → 不重消费，仍只消费一次。
  const restarted = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, restarted.spawner), 0);
  assert.equal(restarted.spawner.list().length, 0, '冷池不重复派生续派');
  assert.equal(Number(runtime.database.prepare("SELECT count(*) count FROM jobs WHERE kind='research_successor'").get().count), 1);
  restarted.spawner.dispose();
}));

test('WMB-5173: kick — disabled capacity leaves pending unconsumed, then consumes once when enabled', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);

  const spawner = new JobSpawner(runtime, { maxWorkers: 0, execute: async () => ({ status: 'succeeded', code: 'OK', message: null, readback: null }) });
  assert.equal(await kickResearchSuccessors(runtime, spawner), 0, 'maxWorkers=0 不消费');
  assert.equal(rowStatus(runtime.database, row.id), 'pending', '仍 pending');
  spawner.setMaxWorkers(1);
  assert.equal(await kickResearchSuccessors(runtime, spawner), 1, '启用后消费一次');
  assert.equal(rowStatus(runtime.database, row.id), 'running');
  spawner.dispose();
}));

test('WMB-5173: kick — parent refs rebuild failure marks row failed (no silent skip)', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  // 父任务合同 refs 损坏（缺 jobId）→ rebuildRoleJobRequest fail-closed → 行 failed。
  db.prepare("UPDATE agent_tasks SET context_refs_json = ? WHERE id = ?").run(JSON.stringify({ roleId: 'writer' }), parent.taskId);
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  const { spawner } = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, spawner), 0, '重建失败不计为成功消费');
  const after = runtime.database.prepare('SELECT status status,last_error lastError FROM jobs WHERE id=?').get(row.id);
  assert.equal(after.status, 'failed');
  assert.ok(after.lastError.includes('重建'), '失败原因记录');
  spawner.dispose();
}));

// ---------------------------------------------------------------------------
// 5. 终态事件回写 + 重启恢复 reconcile
// ---------------------------------------------------------------------------

test('WMB-5173: event — successor job terminal marks row; replay ignored', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  // 直接落一行已消费（running）的 research_successor（等价于 kick 后、终态事件前）。
  const now = nowIso();
  db.prepare(
    `INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at)
     VALUES (?, 'research_successor', 'running', ?, 1, ?, ?, NULL, ?, ?, ?, NULL)`
  ).run('successor-row-1', now, researchSuccessorDedupeKey(parent.jobId), JSON.stringify({
    parentJobId: parent.jobId, parentTaskId: parent.taskId, researchTaskId: taskId, parentRoleId: 'writer',
    unresolvedRequiredClaims: [], briefSuffix: 'suffix', decision: null
  }), now, now, now);
  return { parent };
}, async (runtime) => {
  await handleResearchSuccessorJobEvent(runtime, { type: 'job.finished', jobId: 'successor-row-1' });
  assert.equal(rowStatus(runtime.database, 'successor-row-1'), 'succeeded');
  // 重放同事件（幂等）：行已终态 → 忽略。
  await handleResearchSuccessorJobEvent(runtime, { type: 'job.finished', jobId: 'successor-row-1' });
  assert.equal(rowStatus(runtime.database, 'successor-row-1'), 'succeeded');
  // 未知 jobId 不处理。
  await handleResearchSuccessorJobEvent(runtime, { type: 'job.failed', jobId: 'unknown' });
}));

test('WMB-5173: reconcile — restart recovery enqueues missing successor for terminal research tasks; idempotent across replays', () => withDb((db) => {
  const parentA = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-a', taskId: 'parent-a', jobId: 'job-a' });
  const parentB = seedParent(db, { intent: 'daily_judge', roleId: 'planner', taskId: 'parent-b', jobId: 'job-b' });
  // 终态 research 任务已落 EvidencePack，但 successor 未入队（崩溃窗口）。
  seedResearchTask(db, { parent: parentA, taskId: 'research-a', status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  seedResearchTask(db, { parent: parentB, taskId: 'research-b', status: 'partial', requiredClaims: [claim('claim_x')], unresolvedRequiredClaims: ['claim_x'], terminalReason: 'candidates_exhausted' });
  assert.equal(successorRowCount(db, parentA.jobId), 0);
  assert.equal(reconcileResearchSuccessors(db), 2, '重启恢复：补建缺失续派');
  assert.equal(getResearchSuccessor(db, parentA.jobId).status, 'pending', 'resolved → pending');
  assert.equal(getResearchSuccessor(db, parentB.jobId).status, 'needs_user', 'unresolved → needs_user');
  // 再跑 reconcile / 直接 enqueue → 幂等（duplicate_ignored），行数不变。
  assert.equal(reconcileResearchSuccessors(db), 0);
  const replay = enqueueResearchSuccessor(db, { researchTaskId: 'research-a' });
  assert.equal(replay.reason, 'duplicate_ignored');
  assert.equal(Number(db.prepare("SELECT count(*) count FROM jobs WHERE kind='research_successor'").get().count), 2);
}));

test('WMB-5173: reconcile via runtime — guarded writes work through command dispatch', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-a', taskId: 'parent-a', jobId: 'job-a' });
  seedResearchTask(db, { parent, taskId: 'research-a', status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent };
}, async (runtime, { parent }) => {
  assert.equal(await reconcileResearchSuccessorsViaRuntime(runtime), 1);
  assert.equal(getResearchSuccessor(runtime.database, parent.jobId).status, 'pending');
  assert.equal(await reconcileResearchSuccessorsViaRuntime(runtime), 0, '重放幂等');
}));

test('WMB-5173: EvidencePack round-trips through the successor payload machinery', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId, pack } = seedResearchTask(db, {
    parent, status: 'partial', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: ['claim_a'], terminalReason: 'budget_exhausted'
  });
  // 严格解析器读回（fail-closed 形状）。
  const task = getAgentTask(db, taskId);
  assert.ok(parseResearchEvidencePack(task.resultRefs));
  assert.deepEqual([...pack.unresolvedRequiredClaims], ['claim_a']);
  assert.equal(pack.kind, 'research_evidence');
  assert.equal(pack.round, 1);
}));

// ---------------------------------------------------------------------------
// 6. 崩溃残留恢复（WMB-5173 stale-running reconciliation）：running 行 + 无池内句柄 + 超阈值 → 恢复 pending；
//    超过上限 → failed 可审计；live job 禁止恢复；重启单派不双派
// ---------------------------------------------------------------------------

test('WMB-5173: stale — pure DB settle restores under attempt limit and fails at limit (auditable)', () => withDb((db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  enqueueResearchSuccessor(db, { researchTaskId: taskId });
  const row = getResearchSuccessor(db, parent.jobId);
  const stale = new Date(Date.parse(nowIso()) - 2 * 60_000).toISOString();

  // attempts=1（<3）→ 恢复 pending；started_at 重置；attempts 保留。
  db.prepare("UPDATE jobs SET status='running', attempts=1, started_at=?, updated_at=? WHERE id=?").run(nowIso(), stale, row.id);
  assert.deepEqual(reconcileStaleRunningResearchSuccessors(db, [row.id]), { restored: 1, failed: 0 });
  const back = getResearchSuccessor(db, parent.jobId);
  assert.equal(back.status, 'pending', '超阈值 running 残留恢复为可消费状态');
  assert.equal(back.attempts, 1, 'attempts 保留（恢复次数审计）');
  assert.equal(back.startedAt, null, 'started_at 重置：下次 claim 重新计时');
  assert.equal(Number(db.prepare("SELECT count(*) count FROM operation_log WHERE command='jobs.restore_stale_research_successor' AND result='ok'").get().count), 1, '恢复操作可审计');
  // 恢复后行已 pending → 重复结算跳过（幂等）。
  assert.deepEqual(reconcileStaleRunningResearchSuccessors(db, [row.id]), { restored: 0, failed: 0 });

  // attempts=2（仍 <3）→ 再次恢复。
  db.prepare("UPDATE jobs SET status='running', attempts=2, updated_at=? WHERE id=?").run(stale, row.id);
  assert.deepEqual(reconcileStaleRunningResearchSuccessors(db, [row.id]), { restored: 1, failed: 0 });

  // attempts=3（≥上限）→ 落 failed，不再恢复；失败原因 + 审计。
  db.prepare("UPDATE jobs SET status='running', attempts=3, updated_at=? WHERE id=?").run(stale, row.id);
  assert.deepEqual(reconcileStaleRunningResearchSuccessors(db, [row.id]), { restored: 0, failed: 1 });
  const after = db.prepare('SELECT status status,last_error lastError,finished_at finishedAt FROM jobs WHERE id=?').get(row.id);
  assert.equal(after.status, 'failed');
  assert.ok(after.lastError.includes('上限'), '失败原因记录重派上限');
  assert.ok(after.finishedAt, 'finished_at 落终态');
  assert.equal(Number(db.prepare("SELECT count(*) count FROM operation_log WHERE command='jobs.fail_research_successor' AND result='error'").get().count), 1, 'failed 可审计');
  assert.deepEqual(reconcileStaleRunningResearchSuccessors(db, [row.id]), { restored: 0, failed: 0 }, '终态行不再结算');
}));

test('WMB-5173: stale — crash window: claimed-then-crashed running row (no pool handle) restored and re-kicked exactly once', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  assert.equal(row.status, 'pending');

  // 第一次消费（claim → spawn）：行 running，池内有句柄；随后进程死亡 → 池丢失，行停留 running。
  const first = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, first.spawner), 1);
  assert.equal(rowStatus(runtime.database, row.id), 'running');
  assert.equal(first.spawner.list().length, 1);
  first.spawner.dispose();

  // 时间流逝超过保守阈值（崩溃后重启间隔 > STALE_MS）。
  await mutateSuccessorRow(runtime, row.id, { updatedAtAgoMs: 120_000 });

  // 重启：冷池 stale reconcile → 恢复 pending（无 live 句柄、超阈值、attempts 未超上限）。
  const restarted = fakeSpawner(runtime);
  const result = await reconcileStaleRunningResearchSuccessorsViaRuntime(runtime, restarted.spawner);
  assert.equal(result.restored, 1);
  assert.equal(result.failed, 0);
  const restored = getResearchSuccessor(runtime.database, parent.jobId);
  assert.equal(restored.status, 'pending', '崩溃残留恢复为可消费状态');
  assert.equal(restored.attempts, 1, 'attempts 保留');
  assert.equal(restored.startedAt, null, 'started_at 重置');

  // 再 kick：只产生一个续派工单（重启单派，不双派）；行回 running，attempts+1。
  assert.equal(await kickResearchSuccessors(runtime, restarted.spawner), 1);
  assert.equal(restarted.spawner.list().length, 1, '重启单派：池内仅一个续派工单');
  assert.equal(restarted.spawner.get(row.id).id, row.id);
  assert.equal(rowStatus(runtime.database, row.id), 'running');
  assert.equal(getResearchSuccessor(runtime.database, parent.jobId).attempts, 2);
  assert.equal(Number(runtime.database.prepare("SELECT count(*) count FROM jobs WHERE kind='research_successor'").get().count), 1, '行唯一：不产生第二个续派行');
  restarted.spawner.dispose();
}));

test('WMB-5173: stale — live pool handle blocks restore (no double dispatch)', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  const spawner = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, spawner.spawner), 1);
  assert.equal(rowStatus(runtime.database, row.id), 'running');
  // 即使行已超过阈值，池内存在 live 句柄（queued/running/终态任一）→ 禁止恢复。
  await mutateSuccessorRow(runtime, row.id, { updatedAtAgoMs: 120_000 });
  const result = await reconcileStaleRunningResearchSuccessorsViaRuntime(runtime, spawner.spawner);
  assert.equal(result.restored, 0);
  assert.equal(result.failed, 0);
  assert.equal(rowStatus(runtime.database, row.id), 'running', 'live job 不恢复');
  assert.equal(spawner.spawner.list().length, 1, '池内工单未被重复派生');
  spawner.spawner.dispose();
}));

test('WMB-5173: stale — running row inside conservative threshold is not restored', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  const spawner = fakeSpawner(runtime);
  assert.equal(await kickResearchSuccessors(runtime, spawner.spawner), 1);
  spawner.spawner.dispose(); // 崩溃：池丢失，但 updated_at 仍在阈值内（claim 刚发生）
  const cold = fakeSpawner(runtime);
  const result = await reconcileStaleRunningResearchSuccessorsViaRuntime(runtime, cold.spawner);
  assert.equal(result.restored, 0, '阈值内不恢复（保守窗口）');
  assert.equal(result.failed, 0);
  assert.equal(rowStatus(runtime.database, row.id), 'running', '仍 running，等待下一次阈值判定');
  cold.spawner.dispose();
}));

test('WMB-5173: stale — attempts over limit marks failed (auditable), no further restore', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const { taskId } = seedResearchTask(db, { parent, status: 'succeeded', requiredClaims: [claim('claim_a')], unresolvedRequiredClaims: [] });
  return { parent, taskId };
}, async (runtime, { parent, taskId }) => {
  await enqueueResearchSuccessorForTask(runtime, taskId);
  const row = getResearchSuccessor(runtime.database, parent.jobId);
  // 模拟两轮崩溃恢复后的状态：attempts=3（=上限）、running、超阈值、无池内句柄。
  await mutateSuccessorRow(runtime, row.id, { status: 'running', attempts: 3, startedAt: nowIso(), updatedAtAgoMs: 120_000 });
  const spawner = fakeSpawner(runtime);
  const result = await reconcileStaleRunningResearchSuccessorsViaRuntime(runtime, spawner.spawner);
  assert.equal(result.restored, 0, '超上限不恢复');
  assert.equal(result.failed, 1);
  const after = runtime.database.prepare('SELECT status status,last_error lastError FROM jobs WHERE id=?').get(row.id);
  assert.equal(after.status, 'failed');
  assert.ok(after.lastError.includes('上限'), '失败原因记录重派上限');
  assert.equal(Number(runtime.database.prepare("SELECT count(*) count FROM operation_log WHERE command='jobs.fail_research_successor' AND result='error'").get().count), 1, 'failed 可审计');
  assert.equal(spawner.spawner.list().length, 0, '不再派生');
  spawner.spawner.dispose();
}));

// ---------------------------------------------------------------------------
// 7. 写守卫生产路径（WMB-5173 persistClaims）：经命令派发原子落库 + 失败零部分写 +
//    EvidencePack 终态/后续 enqueue 可达；bare DB 分支保持直写语义
// ---------------------------------------------------------------------------

test('WMB-5173: persistClaims under write guard — claims land via command dispatch, batch failure zero-writes, replay idempotent, terminal EvidencePack + successor enqueue reachable', async () => withRuntime(async (db) => {
  const parent = seedParent(db, { intent: 'studio_draft', roleId: 'writer', projectId: 'proj-1' });
  const research = seedResearchTask(db, {
    parent, status: 'running', taskId: 'research-claims-guard',
    requiredClaims: [claim('claim_a'), claim('claim_b', 'GLM 5.2 官方是否涨价', 'price')]
  });
  return { parent, ...research };
}, async (runtime, { parent, taskId }) => {
  const claims = [
    { claimKey: 'claim_a', claimText: '声明 claim_a', claimType: 'fact', status: 'supported', verdictReason: 'official_source', evidenceSourceIds: ['src-1'], verifiedAt: '2026-08-12T00:00:00.000Z' },
    { claimKey: 'claim_b', claimText: 'GLM 5.2 官方是否涨价', claimType: 'price', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], verifiedAt: '2026-08-12T00:00:00.000Z' }
  ];

  // 1) 守卫已装：绕过派发直写 research_claims 被拒（fail-closed，零行）。
  const direct = upsertResearchClaim(runtime.database, { taskId, claimKey: 'claim_direct', claimText: '直写', claimType: 'fact', status: 'pending' });
  assert.equal(direct.ok, false);
  assert.match(direct.error.message, /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM research_claims WHERE task_id = ?').get(taskId).count, 0);

  // 2) 原子性：批内任一 claim 校验失败 → 整批回滚零部分写（前序合法行不残留）。
  await assert.rejects(
    () => dispatchPersistResearchClaims(runtime, { taskId, claims: [{ ...claims[0], claimKey: 'claim_bad' }, { ...claims[1], status: 'bogus' }], workerLeaseId: 'lease-claims' }),
    /claim 写入失败/
  );
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM research_claims WHERE task_id = ?').get(taskId).count, 0, '失败整批零写');
  assert.equal(runtime.database.prepare("SELECT count(*) count FROM command_receipts WHERE command='research_claims.upsert_batch' AND status='error'").get().count, 1, '失败收据落库可审计');

  // 3) 生产路径：persistClaims 整批经 dispatchBusinessCommand 原子落库（写守卫内授权）。
  await dispatchPersistResearchClaims(runtime, { taskId, claims, workerLeaseId: 'lease-claims' });
  const rows = listResearchClaims(runtime.database, taskId);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.claimKey, row.status])), { claim_a: 'supported', claim_b: 'unresolved' });
  assert.equal(runtime.database.prepare("SELECT COUNT(*) count FROM command_receipts WHERE request_id LIKE ? AND status='ok'").get(`${taskId}:claims:%`).count, 1);

  // 4) 重放安全：同批同 requestId 同 inputHash → 返回原收据，不产生第二行、不重复收据。
  await dispatchPersistResearchClaims(runtime, { taskId, claims, workerLeaseId: 'lease-claims' });
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM research_claims WHERE task_id = ?').get(taskId).count, 2, 'replay 不产生第二行');
  assert.equal(runtime.database.prepare("SELECT COUNT(*) count FROM command_receipts WHERE request_id LIKE ? AND status='ok'").get(`${taskId}:claims:%`).count, 1, 'replay 命中同一收据');

  // 5) 派发结束后守卫仍生效：后续直写仍被拒（无异步逃逸写权）。
  const after = upsertResearchClaim(runtime.database, { taskId, claimKey: 'claim_after', claimText: '后写', claimType: 'fact', status: 'pending' });
  assert.equal(after.ok, false);
  assert.match(after.error.message, /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/);

  // 6) EvidencePack 终态 + 后续 enqueue 在同一受守卫运行时可达（startResearchJob 终态段同构）。
  const pack = buildResearchEvidencePack({
    jobId: taskId,
    round: 1,
    claims: [
      { id: 'claim-row-a', key: 'claim_a', status: 'supported', verdictReason: 'official_source', evidenceSourceIds: ['src-1'], needsTimeExcerpt: false },
      { id: 'claim-row-b', key: 'claim_b', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], needsTimeExcerpt: true }
    ],
    sourceIds: ['src-1'],
    validSourceCount: 2,
    candidateCount: 3,
    timeSpentMinutes: 5,
    terminalReason: 'budget_exhausted',
    unresolvedRequiredClaims: ['claim_b']
  });
  const terminal = await dispatchBusinessCommand(runtime, {
    command: 'agent_tasks.research_terminal',
    requestId: `${taskId}:terminal:partial:${randomUUID()}`,
    actor: { type: 'scheduler', id: 'research-runner', label: 'research-runner' },
    input: { taskId, status: 'partial' },
    boundIdentity: { entityType: 'agent_task', entityId: taskId },
    entityType: 'agent_task',
    execute: (db) => {
      writeResearchTerminal(db, taskId, { status: 'partial', pack });
      enqueueResearchSuccessor(db, { researchTaskId: taskId });
      return { data: { taskId, status: 'partial' }, entityId: taskId, readback: null };
    }
  });
  assert.equal(terminal.ok, true);
  const terminalTask = getAgentTask(runtime.database, taskId);
  assert.equal(terminalTask.status, 'partial');
  assert.ok(parseResearchEvidencePack(terminalTask.resultRefs), 'EvidencePack 已落 result_refs');
  const successor = getResearchSuccessor(runtime.database, parent.jobId);
  assert.equal(successor.status, 'needs_user', '未解决 claim → 续派 needs_user 可达');
  assert.equal(successor.payload.researchTaskId, taskId);
}));

test('WMB-5173: persistClaims bare-DB branch keeps direct-write semantics (no write guard)', async () => withDb(async (db) => {
  const claims = [
    { claimKey: 'bare_a', claimText: '裸库声明', claimType: 'fact', status: 'supported', verdictReason: 'official_source', evidenceSourceIds: ['src-1'], verifiedAt: '2026-08-12T00:00:00.000Z' },
    { claimKey: 'bare_b', claimText: '裸库价格声明', claimType: 'price', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], verifiedAt: '2026-08-12T00:00:00.000Z' }
  ];
  await dispatchPersistResearchClaims(db, { taskId: 'task-bare', claims });
  const rows = listResearchClaims(db, 'task-bare');
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.claimKey, row.status])), { bare_a: 'supported', bare_b: 'unresolved' });
  // 重放：upsert 幂等，不产生第二行。
  await dispatchPersistResearchClaims(db, { taskId: 'task-bare', claims });
  assert.equal(listResearchClaims(db, 'task-bare').length, 2);
}));
