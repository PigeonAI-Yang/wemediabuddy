import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// —— 真实 main 侧模块（runtime / dispatcher / grant / 页 dock 授权管线）——
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import { AUTOMATIC_TASK_GRANT_WORKERS, dispatchIssueTaskGrant, ensureAutomaticTaskGrant, listTaskGrants } from '../src/main/task-grants.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { ensurePageAuthority } from '../src/main/pi-page-authority.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { PAGE_TASK_GRANT_SCOPES, pageAuthoritySpec } from '../src/shared/page-authority.ts';
import { roleWriteCommands } from '../src/shared/agent-capabilities.ts';

/**
 * WMB-5185 A9 翻转回归（WMB-5185 唯一真实缺口测试）：
 *
 * 默认 Pi dock 页授权恒为主管（desk）——design §4.1/§4.3 + Owner lock §8-2。
 * - 旧 `pageRoleFor` 把 studio/library/discover 页 dock 映射为 writer/librarian/reporter，
 *   导致真实 dock 回合在这些页拿到员工范围 grant（与 §7 A9 / §8-2 冲突）；
 * - 本测试用真实 ActiveWorkspaceRuntime + desk lease + stub ensurePi（仅单测桩），
 *   对全部 10 个 page intent 调用真实 `ensurePageAuthority`，逐页证伪：
 *   任务 contextRefs.roleId='desk' + granted + active grant == roleWriteCommands('desk')（排序后）。
 * - 员工车道不变：发布页对员工仍 TASK_SCOPE_EMPTY（readonly）；写手/资料员 grant 保持页∩standing。
 * - unknown_page / worker_lease_missing 等既有闸门回归。
 *
 * 已知边界已闭合（WMB-5185 集成修复）：
 * - task-grants.ts roleForTaskIntent 移除 page_library 覆盖 → 角色经 contextRefs.roleId/caller 解析；
 * - agent-tasks.ts page_* 任务按 (intent, businessDate, roleId) 幂等复用 + pi-page-authority.ts
 *   仅复用 roleId='desk' 任务、删除 page_studio→studio_draft 员工回退 → 同页同日期并存时，
 *   dock（desk 全量 standing）与员工工单（资料员 page_library / 写手 studio_draft 车道）任务互不复用。
 */

const DATE = '2026-08-11';
const PAGES = ['today', 'agents', 'discover', 'proposals', 'topic', 'library', 'canvas', 'studio', 'publish', 'results'];

function openRuntime(directory) {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(`ws-5185-dock-${randomUUID()}`, now, now);
  // 与生产工作空间创建一致：有效配方行（ensurePageAuthority 创建的任务经 readTaskProfileContext
  // 自动携带 workspaceId/workspaceProfileId，requireRunningTask 的 TASK_GRANT_STALE 门依赖它）。
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  database.close();
  return ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5185-dock-epoch' });
}

async function withRuntime(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'wmb-5185-dock-'));
  let runtime;
  try {
    runtime = openRuntime(root);
    await work({ runtime, database: runtime.database, root });
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const schedulerCtx = (label) => ({ actor: { type: 'scheduler', id: 'wmb-5185-dock-test', label }, requestId: `${label}:${randomUUID()}` });

/** 仅单测桩：ensurePageAuthority 只 await 它，不调用其任何方法。 */
const stubEnsurePi = async () => ({ __wmb_5185_stub: true });

function dockRaw(page) {
  return `[WMB_CONTEXT]\npage=${page}\npageLabel=${page}\nobjectType=manager_task\nobjectId=\n` +
    `contextRule=你是主管。自动编排是你的工具：scan/judge/full 用 wmb_run_daily_stage。\n` +
    `[USER_MESSAGE]\nWMB-5185 dock desk authority probe`;
}

async function activeGrantOf(runtime, taskId) {
  const grants = listTaskGrants(runtime.database, taskId, new Date(), runtime.identity);
  return grants.find((grant) => grant.status === 'active') ?? null;
}

async function issueGrant(runtime, taskId, { commands, workers = AUTOMATIC_TASK_GRANT_WORKERS, expiresInMs = 60_000, ownerGoal = 'WMB-5185 手工 grant' }) {
  const issued = await dispatchIssueTaskGrant(runtime, {
    requestId: `wmb-5185:issue:${randomUUID()}`,
    taskId,
    ownerGoal,
    allowedCommands: commands,
    workers,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString()
  });
  assert.equal(issued.ok, true, `grant 签发失败：${JSON.stringify(issued.error ?? null)}`);
  return issued.data.id;
}

test('WMB-5185 A9: 默认 dock 全页 desk 授权——真实 runtime + desk lease + stub ensurePi，全部 page intent', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const deskStanding = [...roleWriteCommands('desk')];
    const lease = runtime.acquireWorkerLease(null, 'desk', 'desk');
    assert.equal(lease.kind, 'pi-worker');

    const seen = {};
    for (const page of PAGES) {
      const spec = pageAuthoritySpec(page);
      assert.ok(spec, `page ${page} 有共享 spec`);
      const { status } = await ensurePageAuthority(runtime, { path: runtime.identity.rootPath, isNew: false }, stubEnsurePi, dockRaw(page));

      assert.equal(status.ok, true, `${page} 授权必须成功`);
      assert.equal(status.mode, 'granted', `${page} 必须 granted`);
      assert.equal(status.page, page, `${page} 页标识一致`);
      assert.ok(status.taskId && status.grantId && status.workerLeaseId, `${page} 携带 taskId/grantId/workerLeaseId`);

      const task = getAgentTask(runtime.database, status.taskId);
      assert.ok(task, `${page} 任务存在`);
      assert.equal(task.intent, spec.intent, `${page} 任务 intent=page_*`);
      assert.equal(task.contextRefs?.roleId, 'desk',
        `${page} dock 任务 roleId=desk（旧 pageRoleFor 员工映射在此失败）`);

      const grant = await activeGrantOf(runtime, status.taskId);
      assert.ok(grant, `${page} 有 active grant`);
      assert.equal(grant.status, 'active', `${page} grant active`);

      const sorted = [...grant.allowedCommands].sort();
      assert.deepEqual(sorted, deskStanding, `${page} active grant == roleWriteCommands('desk')（排序后）`);
      seen[page] = { taskId: status.taskId, grantId: status.grantId, grantCommands: sorted.length };
    }

    assert.equal(Object.keys(seen).length, PAGES.length, '全部 page intent 覆盖');
    // 全量 standing 语义抽查：主管专属命令进入全部页 grant（含 library 页 dock）
    for (const deskOnly of ['plans.save', 'content.save_version', 'knowledge.topic_maintenance_approve']) {
      assert.ok(deskStanding.includes(deskOnly), `fixture：${deskOnly} ∈ deskStanding`);
      assert.equal(seen.library.grantCommands, deskStanding.length, `library dock grant 全量 standing（${deskOnly} 含）`);
    }
    assert.equal(seen.studio.grantCommands, deskStanding.length, 'studio dock grant 全量 standing');
    assert.equal(seen.publish.grantCommands, deskStanding.length, 'publish dock grant 全量 standing（A2 跨页写）');
  });
});

test('WMB-5185 A2/A5: 员工车道不变——发布页对员工仍只读、写手/资料员 grant 保持页∩standing', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const deskStanding = [...roleWriteCommands('desk')];
    const infra = 'agent_tasks.report_progress';

    // 员工发布页：page_publish writeScope=null → 自动 grant TASK_SCOPE_EMPTY（readonly 保留）
    const writerLease = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const pub = await dispatchStartAgentTask(runtime, {
      intent: 'page_publish',
      businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'writer', page: 'publish' },
      piSessionId: null
    }, schedulerCtx('employee-publish'));
    runtime.bindWorkerTask(writerLease, pub.task.id);
    await assert.rejects(
      () => ensureAutomaticTaskGrant(runtime, pub.task.id, new Date(), 'writer'),
      (error) => error?.code === 'TASK_SCOPE_EMPTY' || /TASK_SCOPE_EMPTY/.test(String(error?.message ?? '')),
      '员工发布页自动 grant 必须 TASK_SCOPE_EMPTY（readonly 保留）'
    );

    // 写手创作页：content.* 仅（页∩standing）
    const studio = await dispatchStartAgentTask(runtime, {
      intent: 'page_studio',
      businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'writer', page: 'studio' },
      piSessionId: null
    }, schedulerCtx('employee-studio'));
    runtime.bindWorkerTask(writerLease, studio.task.id);
    const writerGrantId = await ensureAutomaticTaskGrant(runtime, studio.task.id, new Date(), 'writer');
    const writerGrant = await activeGrantOf(runtime, studio.task.id);
    assert.ok(writerGrant, '写手 studio grant 存在');
    const writerCommands = [...writerGrant.allowedCommands].sort();
    assert.ok(writerCommands.includes('content.create') && writerCommands.includes('content.save_version'), '写手 studio = content.* 仅');
    assert.equal(writerCommands.includes('plans.save'), false, '写手不持 plans.save');
    assert.ok(writerCommands.every((command) => command === infra || roleWriteCommands('writer').includes(command)), '写手 grant ⊆ 写手 standing ∪ infra');
    assert.notDeepEqual(writerCommands, deskStanding, '写手 grant != desk standing');
    runtime.releaseWorker(writerLease);

    // 资料员资料库页：页∩standing 车道
    const librarianLease = runtime.acquireWorkerLease(null, 'librarian', 'employee');
    const lib = await dispatchStartAgentTask(runtime, {
      intent: 'page_library',
      businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'librarian', page: 'library' },
      piSessionId: null
    }, schedulerCtx('employee-library'));
    runtime.bindWorkerTask(librarianLease, lib.task.id);
    const librarianGrantId = await ensureAutomaticTaskGrant(runtime, lib.task.id, new Date(), 'librarian');
    const librarianGrant = await activeGrantOf(runtime, lib.task.id);
    assert.ok(librarianGrant, '资料员 library grant 存在');
    const librarianCommands = [...librarianGrant.allowedCommands].sort();
    assert.ok(librarianCommands.length > 0, '资料员 grant 非空');
    assert.ok(librarianCommands.every((command) => command === infra || roleWriteCommands('librarian').includes(command)), '资料员 grant ⊆ 资料员 standing ∪ infra');
    assert.notDeepEqual(librarianCommands, deskStanding, '资料员 grant != desk standing');
    assert.equal(librarianCommands.includes('plans.save'), false, '资料员不持 plans.save');
    runtime.releaseWorker(librarianLease);
  });
});

test('WMB-5185: unknown_page / worker_lease_missing 既有闸门回归', async () => {
  await withRuntime(async ({ runtime, database }) => {
    // unknown_page：无 spec 的页 → readonly + unknown_page（不改）
    const raw = '[WMB_CONTEXT]\npage=no-such-page\n[USER_MESSAGE]\nx';
    const unknown = await ensurePageAuthority(runtime, { path: runtime.identity.rootPath, isNew: false }, stubEnsurePi, raw);
    assert.equal(unknown.status.ok, true);
    assert.equal(unknown.status.mode, 'readonly');
    assert.equal(unknown.status.reason, 'unknown_page');

    // worker_lease_missing：无 desk lease → 拒绝（不改）
    const lease = runtime.acquireWorkerLease(null, 'desk', 'desk');
    runtime.releaseWorker(lease);
    const noLease = await ensurePageAuthority(runtime, { path: runtime.identity.rootPath, isNew: false }, stubEnsurePi, dockRaw('today'));
    assert.equal(noLease.status.ok, false);
    assert.equal(noLease.status.reason, 'worker_lease_missing');
  });
});

test('WMB-5185: 主题审批角色门（cap.topic_approval 仅 {desk:true}）——resolver 变更回归：资料员 page_library 不代批、library dock 可批', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const base = { workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch };
    const approvalEnvelope = (taskId, leaseId, grantId) => createCommandEnvelope({
      ...base,
      command: 'knowledge.topic_maintenance_approve',
      requestId: `wmb-5185-approval-${randomUUID()}`,
      input: { id: 'p-1', expectedRevision: 1, decision: 'approve' },
      boundIdentity: { entityType: 'topic_maintenance_proposal', entityId: 'p-1' },
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId,
      workerLeaseId: leaseId,
      grantId
    });

    // 资料员 page_library 工单（contextRefs.roleId='librarian'，与 dock 回合同日期）+ 手工误含审批证
    // → 角色门拒绝、零业务写（assertTaskGrantForEnvelope 的 taskRole 现经 contextRefs.roleId 解析）
    const librarianLease = runtime.acquireWorkerLease(null, 'librarian', 'employee');
    const lib = await dispatchStartAgentTask(runtime, {
      intent: 'page_library',
      businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'librarian', page: 'library' },
      piSessionId: null
    }, schedulerCtx('approval-gate-librarian'));
    runtime.bindWorkerTask(librarianLease, lib.task.id);
    const librarianGrant = await issueGrant(runtime, lib.task.id, {
      commands: ['agent_tasks.report_progress', 'knowledge.topic_maintenance_approve'],
      ownerGoal: '审批门误签证'
    });
    let libCalls = 0;
    const libReceipt = await runtime.dispatchCommand(approvalEnvelope(lib.task.id, librarianLease.leaseId, librarianGrant), () => {
      libCalls += 1;
      return { data: { ok: true }, entityType: 'command' };
    });
    assert.equal(libReceipt.ok, false, '资料员代批必须拒绝');
    assert.equal(libReceipt.error.code, 'TASK_SCOPE_BROADENED', '资料员代批错误码=TASK_SCOPE_BROADENED');
    assert.equal(libReceipt.error.details?.reason, 'ROLE_SCOPE_BLOCKED', '资料员代批 details.reason=ROLE_SCOPE_BLOCKED');
    assert.equal(libReceipt.sideEffectState, 'not_started', '资料员代批零业务写');
    assert.equal(libCalls, 0, '资料员代批 handler 未执行');

    // 同日期 library dock 回合：role-aware reuse 不复用资料员工单 → 全新 desk 页任务 + 全量 standing
    const dockLease = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const { status } = await ensurePageAuthority(runtime, { path: runtime.identity.rootPath, isNew: false }, stubEnsurePi, dockRaw('library'));
    assert.equal(status.ok && status.mode, 'granted', 'library dock granted');
    assert.notEqual(status.taskId, lib.task.id, 'dock 不复用资料员工单任务（同日期并存）');
    const libTaskAfter = getAgentTask(runtime.database, lib.task.id);
    assert.equal(libTaskAfter?.status, 'running', '资料员工单任务保持 running（未被 dock 劫持）');
    const libGrantAfter = await activeGrantOf(runtime, lib.task.id);
    assert.ok(libGrantAfter && libGrantAfter.id === librarianGrant && libGrantAfter.status === 'active', '资料员工单原 grant 保持 active（车道不变）');
    const dockGrant = await activeGrantOf(runtime, status.taskId);
    assert.ok(dockGrant, 'library dock active grant 存在');
    assert.ok(dockGrant.allowedCommands.includes('knowledge.topic_maintenance_approve'), 'library dock 全量 standing 含审批命令');
    let deskCalls = 0;
    const deskReceipt = await runtime.dispatchCommand(approvalEnvelope(status.taskId, dockLease.leaseId, status.grantId), () => {
      deskCalls += 1;
      return { data: { ok: true }, entityType: 'command' };
    });
    assert.equal(deskReceipt.ok, true, `library dock 可执行主题审批（${JSON.stringify(deskReceipt.error ?? null)}）`);
    assert.equal(deskCalls, 1, 'library dock 审批 handler 恰一次');
    runtime.releaseWorker(dockLease);
    runtime.releaseWorker(librarianLease);
  });
});

test('WMB-5185: 同日期写手 studio_draft 与创作页 dock 并存——不复用员工任务、dock 全量、员工车道不变（删除 page_studio→studio_draft 回退）', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const deskStanding = [...roleWriteCommands('desk')];
    const writerLease = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const draft = await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft',
      businessDate: DATE,
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'writer', projectId: 'p-writer-5185', page: 'studio' },
      piSessionId: null
    }, schedulerCtx('writer-studio-draft'));
    runtime.bindWorkerTask(writerLease, draft.task.id);
    const draftGrantId = await ensureAutomaticTaskGrant(runtime, draft.task.id, new Date(), 'writer');
    const draftGrant = await activeGrantOf(runtime, draft.task.id);
    assert.ok(draftGrant, '写手 studio_draft grant 存在');

    // 创作页 dock 回合（project 焦点——旧逻辑经 studio legacy 回退复用 studio_draft）→
    // 删除回退后必须新建 desk page_studio 任务，写手工单不受影响。
    const dockLease = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const raw = '[WMB_CONTEXT]\npage=studio\npageLabel=创作\nobjectType=project\nobjectId=p-writer-5185\n[USER_MESSAGE]\nWMB-5185 studio dock probe';
    const { status } = await ensurePageAuthority(runtime, { path: runtime.identity.rootPath, isNew: false }, stubEnsurePi, raw);
    assert.equal(status.ok && status.mode, 'granted', 'studio dock granted');
    assert.equal(status.page, 'studio');
    assert.notEqual(status.taskId, draft.task.id, 'dock 不复用写手 studio_draft（删除回退后）');

    const draftTask = getAgentTask(runtime.database, draft.task.id);
    assert.equal(draftTask?.status, 'running', '写手 studio_draft 保持 running（未被劫持）');
    assert.equal(draftTask?.intent, 'studio_draft', '写手任务 intent 不变');
    const draftGrantAfter = await activeGrantOf(runtime, draft.task.id);
    assert.ok(draftGrantAfter && draftGrantAfter.id === draftGrantId && draftGrantAfter.status === 'active', '写手 studio_draft 原 grant 保持 active（车道不变）');

    const dockTask = getAgentTask(runtime.database, status.taskId);
    assert.equal(dockTask?.intent, 'page_studio', 'dock 任务 intent=page_studio');
    assert.equal(dockTask?.contextRefs?.roleId, 'desk', 'dock 任务 roleId=desk');
    assert.equal(dockTask?.contextRefs?.projectId, 'p-writer-5185', 'dock 任务携带 projectId');
    const dockGrant = await activeGrantOf(runtime, status.taskId);
    assert.ok(dockGrant, 'studio dock grant 存在');
    assert.deepEqual([...dockGrant.allowedCommands].sort(), deskStanding, 'studio dock grant == 全量 deskStanding');
    runtime.releaseWorker(dockLease);
    runtime.releaseWorker(writerLease);
  });
});

