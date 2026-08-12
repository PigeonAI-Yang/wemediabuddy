import { randomUUID } from 'node:crypto';
import type { DataRoot } from './data-root.ts';
import { dispatchReportAgentTaskProgress, dispatchStartAgentTask } from './agent-task-commands.ts';
import { getActiveAgentTask, type AgentIntent } from './agent-tasks.ts';
import { shanghaiDate } from './ferment.ts';
import { ownerUiActor } from './ipc-business-context.ts';
import { readPiConversation } from './pi-conversation.ts';
import type { PiRpcSupervisor } from './pi-runtime.ts';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { isPageAuthorityView, pageAuthoritySpec, type PageAuthorityView } from '../shared/page-authority.ts';

export type PageAuthorityResult =
  | { ok: true; mode: 'granted'; page: PageAuthorityView; taskId: string; grantId: string; workerLeaseId: string; chipLabel: string }
  | { ok: true; mode: 'readonly'; page: PageAuthorityView | 'unknown'; reason: string; chipLabel: string }
  | { ok: false; reason: string };

export function extractContextField(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`(?:^|\\n)${key}=([^\\n]*)`));
  const value = match?.[1]?.trim() ?? '';
  return value ? value : null;
}

/**
 * 页 dock 绑定角色（design §4.1/§4.3 + Owner lock §8-2 + WMB-5185）：默认 dock 恒为主管（desk）。
 * 员工角色仅经显式 job/task `contextRefs.roleId` 进入（generic-employee-runner / role-job-policies /
 * ensureAutomaticTaskGrant 角色交叉），不在页 dock 上做 per-page 员工映射。
 */
const DOCK_ROLE = 'desk' as const;

export function injectAuthority(raw: string, authority: { taskId: string; grantId: string; workerLeaseId: string }): string {
  const marker = '[USER_MESSAGE]';
  const idx = raw.indexOf(marker);
  const block = `taskId=${authority.taskId}\ngrantId=${authority.grantId}\nworkerLeaseId=${authority.workerLeaseId}`;
  if (idx < 0) {
    return `${raw}\n\n[WMB_TASK_AUTHORITY]\n${block}\n`;
  }
  const head = raw.slice(0, idx).replace(/\s+$/, '');
  const tail = raw.slice(idx);
  const cleaned = head
    .replace(/\n(?:taskId|grantId|workerLeaseId)=[^\n]*/g, '')
    .replace(/\n\[WMB_TASK_AUTHORITY\][^\n]*/g, '')
    .replace(/\n\[WMB_AUTHORITY_BLOCKED\][^\n]*/g, '');
  return `${cleaned}\n${block}\n${tail}`;
}

export function injectAuthorityBlocked(raw: string, reason: string): string {
  const marker = '[USER_MESSAGE]';
  const idx = raw.indexOf(marker);
  const line = `[WMB_AUTHORITY_BLOCKED] reason=${reason}`;
  if (idx < 0) return `${raw}\n\n${line}\n`;
  const head = raw.slice(0, idx).replace(/\s+$/, '');
  const tail = raw.slice(idx);
  const cleaned = head
    .replace(/\n(?:taskId|grantId|workerLeaseId)=[^\n]*/g, '')
    .replace(/\n\[WMB_TASK_AUTHORITY\][^\n]*/g, '')
    .replace(/\n\[WMB_AUTHORITY_BLOCKED\][^\n]*/g, '');
  return `${cleaned}\n${line}\n${tail}`;
}

/**
 * Dock freeform: map current [WMB_CONTEXT] page → page_* task + automatic grant.
 * Replaces studio-only ensureStudioDraftAuthority (M-4980).
 */
export async function ensurePageAuthority(
  runtime: ActiveWorkspaceRuntime,
  dataRoot: DataRoot,
  ensurePi: (dataRoot: DataRoot, options?: { skipProfileIds?: Iterable<string> }) => Promise<PiRpcSupervisor>,
  raw: string
): Promise<{ message: string; status: PageAuthorityResult }> {
  const pageRaw = extractContextField(raw, 'page');
  const objectId = extractContextField(raw, 'objectId');
  const objectType = extractContextField(raw, 'objectType');
  const spec = pageAuthoritySpec(pageRaw);

  if (!spec || !isPageAuthorityView(pageRaw)) {
    const message = injectAuthorityBlocked(raw, 'unknown_page');
    return { message, status: { ok: true, mode: 'readonly', page: 'unknown', reason: 'unknown_page', chipLabel: '只读' } };
  }

  const pageRole = DOCK_ROLE;
  if ((!spec.writeScope || spec.writeScope.length === 0) && pageRole !== 'desk') {
    // 员工绑定只读页（发布页）保持 readonly_page（A2 员工回归）；主管跳过该分支，下方签发全量 standing grant。
    // 当前 dock 恒为 desk，该分支保留作为员工绑定只读页的既有闸门（任务/授权路径不回退）。
    const message = injectAuthorityBlocked(raw, 'readonly_page');
    return {
      message,
      status: { ok: true, mode: 'readonly', page: pageRaw, reason: 'readonly_page', chipLabel: spec.chipLabel }
    };
  }

  try {
    await ensurePi(dataRoot);
  } catch {
    const message = injectAuthorityBlocked(raw, 'pi_unavailable');
    return { message, status: { ok: false, reason: 'pi_unavailable' } };
  }

  const lease = runtime.getWorkerLease();
  if (!lease) {
    const message = injectAuthorityBlocked(raw, 'worker_lease_missing');
    return { message, status: { ok: false, reason: 'worker_lease_missing' } };
  }

  const businessDate = shanghaiDate();
  const intent = spec.intent as AgentIntent;
  // WMB-5185：dock 只复用 roleId='desk' 的 page_* 任务（role-aware reuse），
  // 绝不复用员工工单任务（资料员 page_library / 写手 studio_draft 等）——
  // 员工任务经 startAgentTask 的 roleId 匹配继续走各自车道。
  let active = getActiveAgentTask(runtime.database, intent, businessDate, DOCK_ROLE);

  if (!active) {
    const conversation = await readPiConversation(dataRoot.path);
    const contextRefs: Record<string, unknown> = {
      page: pageRaw,
      objectId: objectId ?? undefined,
      objectType: objectType ?? undefined,
      roleId: pageRole
    };
    if (pageRaw === 'studio' && objectId) contextRefs.projectId = objectId;
    const started = await dispatchStartAgentTask(runtime, {
      intent,
      businessDate,
      contextRefs,
      piSessionId: conversation.sessionId
    }, {
      actor: ownerUiActor,
      requestId: randomUUID(),
      workerLeaseId: lease.leaseId
    });
    active = started.task;
  }

  if (!active || active.status !== 'running') {
    const message = injectAuthorityBlocked(raw, 'task_not_active');
    return { message, status: { ok: false, reason: 'task_not_active' } };
  }

  // WMB-5186：活跃回合刷新 heartbeat_at/updated_at（新建与 role-aware reuse 一致），
  // 保留 phase/status 与授权边界；失活收尸以心跳陈旧判定，跨回合会话由此免于误杀。
  // WMB-5185：经真实 dispatch 路径（scheduler actor + agent_tasks.report_progress 空载荷）执行，
  // 使写守卫（WMB_WRITE_REQUIRES_COMMAND_DISPATCH）放行——与 runner 15s 心跳同一模式；
  // 载荷为空 → 仅刷新 heartbeat_at/updated_at，phase/status/progress/checkpoint 原样保留。
  await dispatchReportAgentTaskProgress(
    runtime,
    active.id,
    {},
    {
      actor: { type: 'scheduler', id: 'page-authority', label: 'page-authority' },
      requestId: `page-authority:heartbeat:${active.id}:${randomUUID()}`
    }
  ).catch(() => {
    /* best-effort：心跳失败不阻断授权回合；任务非 running 时下方 grant 路径以 TASK_NOT_ACTIVE 收口 */
  });

  runtime.rebindWorkerTask(lease, active.id);
  const roleFromTask = typeof active.contextRefs?.roleId === 'string' ? active.contextRefs.roleId : null;
  const grantId = await ensureAutomaticTaskGrant(
    runtime,
    active.id,
    new Date(),
    roleFromTask === 'writer' || roleFromTask === 'librarian' || roleFromTask === 'reporter' || roleFromTask === 'planner' || roleFromTask === 'desk'
      ? roleFromTask
      : 'desk'
  );

  const bound = runtime.getWorkerLease();
  if (!bound?.taskId || bound.taskId !== active.id) {
    const message = injectAuthorityBlocked(raw, 'lease_rebind_failed');
    return { message, status: { ok: false, reason: 'lease_rebind_failed' } };
  }

  const message = injectAuthority(raw, {
    taskId: active.id,
    grantId,
    workerLeaseId: bound.leaseId
  });
  return {
    message,
    status: {
      ok: true,
      mode: 'granted',
      page: pageRaw,
      taskId: active.id,
      grantId,
      workerLeaseId: bound.leaseId,
      chipLabel: spec.chipLabel
    }
  };
}
