import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// —— 真实 main 侧模块（runtime / dispatcher / grant / 页 dock 消息管线）——
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import {
  AUTOMATIC_TASK_GRANT_WORKERS, ensureAutomaticTaskGrant, dispatchIssueTaskGrant, dispatchRevokeTaskGrant, getTaskGrant
} from '../src/main/task-grants.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { injectAuthorityBlocked } from '../src/main/pi-page-authority.ts';
import { extractAuthorityBlock } from '../src/main/ipc-pi-dock.ts';

/**
 * WMB-5185 A7 非中止（回归）——本批次唯一真实缺口测试。
 *
 * A1–A6 由既有 5182/5183 测试覆盖，此处只引用不重复：
 * - A1 standing 等值 + 红线负断言：tests/agent-capabilities.test.mjs（WMB-5182 A1）；
 * - A2 跨页写（发布页主管全量 grant / 员工 readonly_page）：tests/agent-work-paths.test.mjs（7/10）、tests/page-authority.test.mjs；
 * - A3 红线类别（渠道安全应用 / precise 执行不可达）：tests/agent-work-paths.test.mjs（12/13）、tests/agent-capabilities.test.mjs；
 * - A4 主题审批归主管（员工/外部 Agent ROLE_SCOPE_BLOCKED 零写）：tests/wmb-5150-topic-maintenance.test.mjs（EVAL-031 语义）；
 * - A5 员工隔离 + spawn(desk) 拒绝：tests/agent-work-paths.test.mjs、tests/wmb-5142-instance-projection.test.mjs、本套件 A7 re-baseline；
 * - A6 续期 + 恰一次重签重放：tests/agent-work-paths.test.mjs（11/12）。
 *
 * 本文件只守 A7：主管/会话每类权威拦截均经真实 dispatch 路径注入，
 * 逐类证伪「非中止（任务/会话存活）+ 零业务写 + 每条拦截恰一条审计」——
 * 其中 desk stale-scope 二次失败分支（注册缺口 → `role_authority_blocked` 流水）此前无任何测试覆盖。
 */

const DATE = '2026-08-11';
const PI_WORKER = { type: 'pi', id: 'pi', label: 'Pi worker' };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function openRuntime(directory) {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(`ws-5185-${randomUUID()}`, now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5185-epoch' });
}

async function withRuntime(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'wmb-5185-'));
  let runtime;
  try {
    runtime = openRuntime(root);
    await work({ runtime, database: runtime.database });
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const schedulerCtx = (label) => ({ actor: { type: 'scheduler', id: 'wmb-5185-test', label }, requestId: `${label}:${randomUUID()}` });

/** 建真实任务（running）+ 绑定 lease；autoGrant=true 时签发主管全量 standing 自动 grant。
 *  注意：startAgentTask 按 (intent, businessDate) 幂等复用，辅助任务须用互异 businessDate。 */
async function startBoundTask(runtime, lease, roleId, intent, page, { autoGrant, businessDate = DATE } = {}) {
  const started = await dispatchStartAgentTask(runtime, {
    intent,
    businessDate,
    contextRefs: { workspaceId: runtime.identity.workspaceId, roleId, page }
  }, schedulerCtx('start'));
  runtime.bindWorkerTask(lease, started.task.id);
  const grantId = autoGrant ? await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), roleId) : null;
  return { taskId: started.task.id, grantId };
}

async function issueGrant(runtime, taskId, { commands, workers = AUTOMATIC_TASK_GRANT_WORKERS, expiresInMs = 60_000, ownerGoal = 'A7 手工 grant' }) {
  const issued = await dispatchIssueTaskGrant(runtime, {
    requestId: `a7:issue:${randomUUID()}`,
    taskId,
    ownerGoal,
    allowedCommands: commands,
    workers,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString()
  });
  assert.equal(issued.ok, true, `grant 签发失败：${JSON.stringify(issued.error ?? null)}`);
  return issued.data.id;
}

async function revokeGrant(runtime, grantId) {
  const grant = getTaskGrant(runtime.database, grantId, new Date());
  assert.ok(grant, '待撤销 grant 存在');
  const revoked = await dispatchRevokeTaskGrant(runtime, { requestId: `a7:revoke:${randomUUID()}`, grantId, expectedRevision: grant.revision });
  assert.equal(revoked.ok, true, `grant 撤销失败：${JSON.stringify(revoked.error ?? null)}`);
}

/** 会话存活证据：拦截后同一 lease 仍可经真实 dispatch 路径成功写入。 */
async function aliveWrite(runtime, { taskId, lease, grantId, command = 'knowledge.record_batch', label }) {
  let calls = 0;
  const receipt = await runtime.dispatchCommand(createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command,
    requestId: `a7:alive:${label}:${randomUUID()}`,
    input: command === 'plans.save' ? { planDate: DATE, summary: 's', items: [] } : { items: [] },
    boundIdentity: command === 'plans.save' ? { planDate: DATE } : { entityType: 'knowledge_batch' },
    actor: PI_WORKER,
    taskId,
    workerLeaseId: lease.leaseId,
    grantId
  }), () => { calls += 1; return { data: { ok: true }, entityType: 'command' }; });
  assert.equal(receipt.ok, true, `${label} 会话存活：拦截后同一 lease 仍可写入（${JSON.stringify(receipt.error ?? null)}）`);
  assert.equal(calls, 1, `${label} 存活写入 handler 恰一次`);
}

function countOperationAudit(database, t0, code, command) {
  return database.prepare(
    "SELECT COUNT(*) AS c FROM operation_log WHERE created_at>=? AND entity_type='command' AND result='error' AND error_code=? AND command=?"
  ).get(t0, code, command).c;
}

function countRoleBlockedAudit(database, t0, code, role) {
  return database.prepare(
    "SELECT COUNT(*) AS c FROM operation_log WHERE created_at>=? AND entity_type='role_authority_blocked' AND error_code=? AND client_label=?"
  ).get(t0, code, role).c;
}

/**
 * 经真实 dispatch 路径注入一类权威拦截，逐项证伪：
 * 拒绝码正确 + 零业务写（handler 未执行）+ 恰一条操作审计 + 任务存活 + 会话存活（可继续写）。
 */
async function verifyRejection(runtime, database, {
  label, command, expectedCode, envelope, aliveTaskId, extraRoleBlockedAudit, followUp
}) {
  let handlerCalls = 0;
  const t0 = new Date().toISOString();
  const receipt = await runtime.dispatchCommand(envelope(), () => {
    handlerCalls += 1;
    return { data: { ok: true }, entityType: 'command' };
  });
  assert.equal(receipt.ok, false, `${label} 必须拒绝`);
  assert.equal(receipt.error.code, expectedCode, `${label} 错误码=${expectedCode}`);
  assert.equal(receipt.sideEffectState, 'not_started', `${label} 零业务写（handler 未执行）`);
  assert.equal(handlerCalls, 0, `${label} handler 未执行`);
  assert.equal(countOperationAudit(database, t0, expectedCode, command), 1, `${label} 恰一条操作审计（entity_type=command）`);
  if (extraRoleBlockedAudit) {
    assert.equal(countRoleBlockedAudit(database, t0, extraRoleBlockedAudit.code, extraRoleBlockedAudit.role), 1,
      `${label} 恰一条 role_authority_blocked 审计（role=${extraRoleBlockedAudit.role}, reason=${extraRoleBlockedAudit.code}）`);
  }
  if (aliveTaskId) {
    assert.equal(getAgentTask(database, aliveTaskId)?.status, 'running', `${label} 后任务存活（非中止）`);
  }
  if (followUp) await followUp();
}

test('WMB-5185 A7: 主管/会话每类权威拦截经真实 dispatch 路径非中止——零业务写、任务存活、恰一条审计', async () => {
  await withRuntime(async ({ runtime, database }) => {
    // —— 主管（desk）常驻会话 fixture：真实任务 + lease + 全量 standing grant ——
    const deskLease = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const { taskId, grantId: initialGrantId } = await startBoundTask(runtime, deskLease, 'desk', 'page_today', 'today', { autoGrant: true });
    const workspaceId = runtime.identity.workspaceId;
    const runtimeEpoch = runtime.identity.runtimeEpoch;
    // 换发循环（④⑤⑦）会 revoke+reissue 全量证，fullGrantId 随续发更新。
    let fullGrantId = initialGrantId;
    const fullGrant = getTaskGrant(database, fullGrantId, new Date());
    assert.ok(fullGrant && fullGrant.allowedCommands.includes('knowledge.record_batch'), 'fixture：主管持有全量 standing grant');

    const alive = (label) => aliveWrite(runtime, { taskId, lease: deskLease, grantId: fullGrantId, label });
    const base = { workspaceId, runtimeEpoch };

    // ① 基建：无 task grant
    await verifyRejection(runtime, database, {
      label: 'TASK_GRANT_REQUIRED', command: 'knowledge.record_batch', expectedCode: 'TASK_GRANT_REQUIRED',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-grant-required', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER }),
      aliveTaskId: taskId, followUp: () => alive('grant-required')
    });

    // ② 基建：grant 不存在
    await verifyRejection(runtime, database, {
      label: 'TASK_GRANT_NOT_FOUND', command: 'knowledge.record_batch', expectedCode: 'TASK_GRANT_NOT_FOUND',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-grant-not-found', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER, taskId, workerLeaseId: deskLease.leaseId, grantId: 'a7-no-such-grant' }),
      aliveTaskId: taskId, followUp: () => alive('grant-not-found')
    });

    // ③ 基建：grant 绑定另一任务（stale）
    const ghostLease = runtime.acquireWorkerLease(null, 'desk', 'employee'); // desk lease 全局唯一，辅助任务用 employee purpose
    const ghost = await startBoundTask(runtime, ghostLease, 'desk', 'page_today', 'today', { businessDate: '2026-08-12' });
    const ghostGrantId = await issueGrant(runtime, ghost.taskId, { commands: ['knowledge.record_batch'], ownerGoal: 'A7 stale 源证' });
    await verifyRejection(runtime, database, {
      label: 'TASK_GRANT_STALE', command: 'knowledge.record_batch', expectedCode: 'TASK_GRANT_STALE',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-grant-stale', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER, taskId, workerLeaseId: deskLease.leaseId, grantId: ghostGrantId }),
      aliveTaskId: taskId, followUp: () => alive('grant-stale')
    });
    runtime.releaseWorker(ghostLease);

    // ④ 基建：grant 过期（换发循环：撤全量 → 发短命窄证 → 过期 → 重发全量）
    const expiredGrantId = await (async () => {
      await revokeGrant(runtime, fullGrantId);
      return issueGrant(runtime, taskId, { commands: ['agent_tasks.report_progress'], expiresInMs: 60, ownerGoal: 'A7 短命窄证' });
    })();
    await sleep(150);
    await verifyRejection(runtime, database, {
      label: 'TASK_GRANT_EXPIRED', command: 'knowledge.record_batch', expectedCode: 'TASK_GRANT_EXPIRED',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-grant-expired', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER, taskId, workerLeaseId: deskLease.leaseId, grantId: expiredGrantId }),
      aliveTaskId: taskId,
      followUp: async () => {
        fullGrantId = await ensureAutomaticTaskGrant(runtime, taskId, new Date(), 'desk');
        await aliveWrite(runtime, { taskId, lease: deskLease, grantId: fullGrantId, label: 'grant-expired' });
      }
    });

    // ⑤ 基建：grant 已撤销（换发循环）
    const revokedGrantId = await (async () => {
      await revokeGrant(runtime, fullGrantId);
      const id = await issueGrant(runtime, taskId, { commands: ['agent_tasks.report_progress'], ownerGoal: 'A7 待撤销窄证' });
      await revokeGrant(runtime, id);
      return id;
    })();
    await verifyRejection(runtime, database, {
      label: 'TASK_GRANT_REVOKED', command: 'knowledge.record_batch', expectedCode: 'TASK_GRANT_REVOKED',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-grant-revoked', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER, taskId, workerLeaseId: deskLease.leaseId, grantId: revokedGrantId }),
      aliveTaskId: taskId,
      followUp: async () => {
        fullGrantId = await ensureAutomaticTaskGrant(runtime, taskId, new Date(), 'desk');
        await aliveWrite(runtime, { taskId, lease: deskLease, grantId: fullGrantId, label: 'grant-revoked' });
      }
    });

    // ⑥ 注册面/红线：命令不在任何 grant（红线命令对主管全量 standing 仍不可达）
    await verifyRejection(runtime, database, {
      label: 'TASK_SCOPE_BROADENED(红线)', command: 'x_lists.operation_execute', expectedCode: 'TASK_SCOPE_BROADENED',
      envelope: () => createCommandEnvelope({ ...base, command: 'x_lists.operation_execute', requestId: 'a7-redline-nongrantable', input: { kind: 'unfollow', accountKey: 'acc', listId: 'l1' }, boundIdentity: { accountKey: 'acc', allowedTransition: 'member:unfollow', requiredReadback: {} }, actor: PI_WORKER, taskId, workerLeaseId: deskLease.leaseId, grantId: fullGrantId }),
      aliveTaskId: taskId, followUp: () => alive('redline-nongrantable')
    });

    // ⑦ 基建：worker 身份不匹配（换发循环）
    const mismatchGrantId = await (async () => {
      await revokeGrant(runtime, fullGrantId);
      return issueGrant(runtime, taskId, { commands: ['knowledge.record_batch'], workers: [{ type: 'pi', id: 'other-worker' }], ownerGoal: 'A7 worker 错配证' });
    })();
    await verifyRejection(runtime, database, {
      label: 'TASK_WORKER_MISMATCH', command: 'knowledge.record_batch', expectedCode: 'TASK_WORKER_MISMATCH',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-worker-mismatch', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER, taskId, workerLeaseId: deskLease.leaseId, grantId: mismatchGrantId }),
      aliveTaskId: taskId,
      followUp: async () => {
        fullGrantId = await ensureAutomaticTaskGrant(runtime, taskId, new Date(), 'desk');
        await aliveWrite(runtime, { taskId, lease: deskLease, grantId: fullGrantId, label: 'worker-mismatch' });
      }
    });

    // ⑧ 基建：lease 失效
    await verifyRejection(runtime, database, {
      label: 'WORKER_LEASE_STALE', command: 'knowledge.record_batch', expectedCode: 'WORKER_LEASE_STALE',
      envelope: () => createCommandEnvelope({ ...base, command: 'knowledge.record_batch', requestId: 'a7-lease-stale', input: { items: [] }, boundIdentity: { entityType: 'knowledge_batch' }, actor: PI_WORKER, taskId, workerLeaseId: `a7-bogus-lease-${randomUUID()}`, grantId: fullGrantId }),
      aliveTaskId: taskId, followUp: () => alive('lease-stale')
    });

    // ⑨ 红线 precise 门：无 execution grant（owner UI 人类路径，任务 grant 门不适用）
    await verifyRejection(runtime, database, {
      label: 'EXECUTION_GRANT_REQUIRED', command: 'x_lists.operation_execute', expectedCode: 'EXECUTION_GRANT_REQUIRED',
      envelope: () => createCommandEnvelope({ ...base, command: 'x_lists.operation_execute', requestId: 'a7-execution-grant-required', input: { kind: 'unfollow', accountKey: 'acc', listId: 'l1' }, boundIdentity: { accountKey: 'acc', allowedTransition: 'member:unfollow', requiredReadback: {} }, actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' } }),
      followUp: () => alive('execution-grant-required')
    });

    // ⑩ 注册缺口：desk stale-scope 重签失败（任务已非 running，旧窄证仍 active）→ TASK_SCOPE_BROADENED +
    //    role_authority_blocked 审计（workspace-runtime dispatchCommand 二次失败分支；此前无测试覆盖）。
    const gapLease = runtime.acquireWorkerLease(null, 'desk', 'employee'); // desk lease 全局唯一，辅助任务用 employee purpose
    const gap = await startBoundTask(runtime, gapLease, 'desk', 'page_today', 'today', { businessDate: '2026-08-13' });
    const gapNarrow = await issueGrant(runtime, gap.taskId, { commands: ['agent_tasks.report_progress'], ownerGoal: 'A7 注册缺口窄证' });
    // 终态命令路径（agent_tasks.cancel 等）会 best-effort 撤销 grant（走 TASK_GRANT_REVOKED 而非本分支），
    // 故在真实 dispatch 的 handler 内（write-guard 授权窗口）直接翻转任务终态、保持窄证 active，
    // 以确定性触发「重签失败 → 原证拒绝 → role_authority_blocked」注册缺口审计分支。
    const flip = await runtime.dispatchCommand(createCommandEnvelope({
      ...base,
      command: 'agent_tasks.report_progress',
      requestId: 'a7-gap-fixture-flip',
      input: { id: gap.taskId, input: { phase: 'fixture' } },
      boundIdentity: { entityType: 'agent_task' },
      actor: PI_WORKER,
      taskId: gap.taskId,
      workerLeaseId: gapLease.leaseId,
      grantId: gapNarrow
    }), () => {
      database.prepare("UPDATE agent_tasks SET status='cancelled', finished_at=? WHERE id=?").run(new Date().toISOString(), gap.taskId);
      return { data: { ok: true }, entityType: 'agent_task', entityId: gap.taskId };
    });
    assert.equal(flip.ok, true, `fixture 任务终态翻转失败：${JSON.stringify(flip.error ?? null)}`);
    let gapHandlerCalls = 0;
    const gapT0 = new Date().toISOString();
    const gapReceipt = await runtime.dispatchCommand(createCommandEnvelope({
      ...base,
      command: 'knowledge.record_batch',
      requestId: 'a7-registration-gap',
      input: { items: [] },
      boundIdentity: { entityType: 'knowledge_batch' },
      actor: PI_WORKER,
      taskId: gap.taskId,
      workerLeaseId: gapLease.leaseId,
      grantId: gapNarrow
    }), () => { gapHandlerCalls += 1; return { data: { ok: true }, entityType: 'command' }; });
    assert.equal(gapReceipt.ok, false, '注册缺口必须拒绝');
    assert.equal(gapReceipt.error.code, 'TASK_SCOPE_BROADENED', '注册缺口错误码=TASK_SCOPE_BROADENED');
    assert.equal(gapReceipt.sideEffectState, 'not_started', '注册缺口零业务写');
    assert.equal(gapHandlerCalls, 0, '注册缺口 handler 未执行');
    assert.equal(countOperationAudit(database, gapT0, 'TASK_SCOPE_BROADENED', 'knowledge.record_batch'), 1, '注册缺口恰一条操作审计');
    assert.equal(countRoleBlockedAudit(database, gapT0, 'TASK_SCOPE_BROADENED', 'desk'), 1, '注册缺口恰一条 role_authority_blocked 审计（role=desk）');
    // 会话存活：runtime 仍活动、lease 仍绑定、同 lease 新任务可正常写入。
    assert.equal(runtime.isActive, true, '注册缺口后 runtime 存活');
    assert.equal(runtime.isCurrentWorkerLease(gapLease.leaseId, gap.taskId), true, '注册缺口后 lease 仍绑定');
    const resumed = await startBoundTask(runtime, gapLease, 'desk', 'page_today', 'today', { autoGrant: true, businessDate: '2026-08-14' });
    await aliveWrite(runtime, { taskId: resumed.taskId, lease: gapLease, grantId: resumed.grantId, label: 'registration-gap' });
    runtime.releaseWorker(gapLease);

    // ⑪ 员工角色执行面：主题审批（cap.topic_approval 仅 {desk:true}）→ ROLE_SCOPE_BLOCKED（EVAL-031 语义；全量语义见 wmb-5150）
    const plannerLease = runtime.acquireWorkerLease(null, 'planner', 'employee');
    const planner = await startBoundTask(runtime, plannerLease, 'planner', 'page_today', 'today', { businessDate: '2026-08-15' });
    const plannerGrantId = await issueGrant(runtime, planner.taskId, {
      commands: ['knowledge.topic_maintenance_approve', 'knowledge.topic_maintenance_reject', 'knowledge.topic_maintenance_reproposal_retry'],
      ownerGoal: 'A7 员工错误持有审批证（手工误签）'
    });
    await verifyRejection(runtime, database, {
      label: 'ROLE_SCOPE_BLOCKED(员工代批)', command: 'knowledge.topic_maintenance_approve', expectedCode: 'TASK_SCOPE_BROADENED',
      envelope: () => createCommandEnvelope({
        ...base, command: 'knowledge.topic_maintenance_approve', requestId: 'a7-role-scope-blocked',
        input: { id: 'p-1', expectedRevision: 1, decision: 'approve' },
        boundIdentity: { entityType: 'topic_maintenance_proposal', entityId: 'p-1' }, actor: PI_WORKER,
        taskId: planner.taskId, workerLeaseId: plannerLease.leaseId, grantId: plannerGrantId
      }),
      aliveTaskId: planner.taskId,
      followUp: async () => {
        const plannerGrant = await ensureAutomaticTaskGrant(runtime, planner.taskId, new Date(), 'planner');
        await aliveWrite(runtime, { taskId: planner.taskId, lease: plannerLease, grantId: plannerGrant, command: 'plans.save', label: 'role-scope-blocked' });
      }
    });
    // 员工零审批权（grant 侧）：自动续发后 planner grant 仍不含审批命令（registry 零绑定，wmb-5150 同语义）。
    const activePlannerRow = database.prepare(
      "SELECT allowed_commands_json AS json FROM task_grants WHERE task_id=? AND status='active' ORDER BY issued_at DESC LIMIT 1"
    ).get(planner.taskId);
    assert.ok(activePlannerRow, 'planner 自动 grant 存在');
    const activePlannerCommands = JSON.parse(activePlannerRow.json);
    for (const command of ['knowledge.topic_maintenance_approve', 'knowledge.topic_maintenance_reject', 'knowledge.topic_maintenance_reproposal_retry']) {
      assert.equal(activePlannerCommands.includes(command), false, `员工自动 grant 不得含 ${command}（零审批权）`);
    }
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS c FROM operation_log WHERE entity_type='role_authority_blocked' AND client_label='planner'").get().c,
      0,
      '员工路径不产生 desk stale-scope 审计（role_authority_blocked 仅主管注册缺口/研究读门使用）'
    );
    runtime.releaseWorker(plannerLease);
    runtime.releaseWorker(deskLease);
  });
});

test('WMB-5185 A7: [WMB_AUTHORITY_BLOCKED] 标记注入→提取往返，每类拦截恰一个标记且正文/旧 authority 处理正确', () => {
  const codes = [
    'unknown_page', 'readonly_page', 'pi_unavailable', 'worker_lease_missing',
    'TASK_GRANT_REQUIRED', 'TASK_GRANT_NOT_FOUND', 'TASK_GRANT_STALE', 'TASK_GRANT_EXPIRED',
    'TASK_GRANT_REVOKED', 'TASK_SCOPE_BROADENED', 'TASK_WORKER_MISMATCH', 'TASK_NOT_ACTIVE',
    'WORKER_LEASE_STALE', 'EXECUTION_GRANT_REQUIRED'
  ];
  for (const code of codes) {
    const raw = '[WMB_CONTEXT]\npage=publish\ntaskId=t-stale\ngrantId=g-stale\nworkerLeaseId=w-stale\n[USER_MESSAGE]\n把草稿发到公众号';
    const intercepted = injectAuthorityBlocked(raw, code);
    assert.equal((intercepted.match(/\[WMB_AUTHORITY_BLOCKED\]/g) ?? []).length, 1, `${code} 恰一个标记`);
    assert.match(intercepted, new RegExp(`\\[WMB_AUTHORITY_BLOCKED\\] reason=${code}`), `${code} 标记携带 reason`);
    assert.equal(extractAuthorityBlock(intercepted), `[WMB_AUTHORITY_BLOCKED] reason=${code}`, `${code} 注入→提取往返一致`);
    assert.equal(extractAuthorityBlock(intercepted).includes('taskId='), false, `${code} 拦截块剥离旧 taskId/grantId/workerLeaseId（不留过期 authority）`);
    assert.ok(intercepted.includes('[USER_MESSAGE]\n把草稿发到公众号'), `${code} 用户消息正文保留`);
    const reinjected = injectAuthorityBlocked(intercepted, code);
    assert.equal((reinjected.match(/\[WMB_AUTHORITY_BLOCKED\]/g) ?? []).length, 1, `${code} 重复注入不产生重复标记`);
  }
});
