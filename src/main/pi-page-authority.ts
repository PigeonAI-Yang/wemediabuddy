import { randomUUID } from 'node:crypto';
import type { DataRoot } from './data-root.ts';
import { dispatchStartAgentTask } from './agent-task-commands.ts';
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

  if (!spec.writeScope || spec.writeScope.length === 0) {
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
  let active = getActiveAgentTask(runtime.database, intent, businessDate);

  // Studio legacy: keep project-bound studio_draft when page_studio focuses a project —
  // page_studio is the dock intent; also accept existing studio_draft with same project for regression.
  if (pageRaw === 'studio' && objectType === 'project' && objectId) {
    const draft = getActiveAgentTask(runtime.database, 'studio_draft', businessDate);
    const draftProject = typeof draft?.contextRefs?.projectId === 'string' ? draft.contextRefs.projectId : null;
    if (draft && draftProject === objectId) active = draft;
  }

  if (!active) {
    const conversation = await readPiConversation(dataRoot.path);
    const contextRefs: Record<string, unknown> = {
      page: pageRaw,
      objectId: objectId ?? undefined,
      objectType: objectType ?? undefined,
      roleId: pageRaw === 'studio' ? 'writer' : pageRaw === 'library' ? 'librarian' : pageRaw === 'discover' ? 'reporter' : pageRaw === 'agents' ? 'desk' : 'desk'
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
