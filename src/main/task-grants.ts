import { PAGE_TASK_GRANT_SCOPES, type PageTaskIntent } from '../shared/page-authority.ts';
import { filterCommandsForRole, isRoleId, type RoleId } from '../shared/agent-capabilities.ts';
import { roleWriteCommandsWithOverlays } from './capability-overlays.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CommandDispatchError, createCommandEnvelope, type CommandActorV1, type CommandEnvelopeV1, type CommandReceiptV1 } from './command-dispatcher.ts';
import { getAgentTask } from './agent-tasks.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const TASK_GRANT_ISSUE_COMMAND = 'task_grants.issue';
export const TASK_GRANT_REVOKE_COMMAND = 'task_grants.revoke';
export const TASK_INTERNAL_COMMANDS = Object.freeze([
  'agent_tasks.report_progress',
  'content.create',
  'content.save_version',
  'intelligence_channels.proposal_apply',
  'knowledge.creative_brief_create',
  'knowledge.creative_brief_create_project',
  'knowledge.creative_brief_update',
  'knowledge.domain_create',
  'knowledge.domain_update',
  'knowledge.record_batch',
  'knowledge.suggestion_create',
  'plans.save',
  'reviews.save',
  'sources.upsert_batch',
  'sources.lane_gate',
  'sources.lane_restore',
  'sources.update_status',
  'x_lists.observation_start',
  'x_lists.observation_stop',
  'x_lists.operation_execute'
] as const);

export type TaskGrantWorker = Readonly<{
  type: 'pi' | 'external_agent';
  id: string;
}>;

export type TaskGrantStatus = 'active' | 'revoked';

export type TaskGrant = Readonly<{
  version: 'TaskGrantV1';
  id: string;
  workspaceId: string;
  runtimeEpoch: string;
  taskId: string;
  ownerGoal: string;
  allowedCommands: readonly string[];
  workers: readonly TaskGrantWorker[];
  relevantContext: Readonly<Record<string, unknown>>;
  status: TaskGrantStatus | 'expired' | 'stale';
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revision: number;
}>;

type TaskGrantRow = {
  id: string;
  workspace_id: string;
  runtime_epoch: string;
  task_id: string;
  owner_goal: string;
  allowed_commands_json: string;
  workers_json: string;
  relevant_context_json: string;
  status: TaskGrantStatus;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revision: number;
};

type IssueTaskGrantInput = {
  requestId: string;
  taskId: string;
  ownerGoal: string;
  allowedCommands: string[];
  workers: TaskGrantWorker[];
  relevantContext?: Record<string, unknown>;
  expiresAt: string;
};

export function getTaskGrant(database: DatabaseSync, id: string, now = new Date(), identity?: { workspaceId: string; runtimeEpoch: string }): TaskGrant | null {
  const row = database.prepare('SELECT * FROM task_grants WHERE id=?').get(id) as TaskGrantRow | undefined;
  return row ? parseTaskGrant(row, now, identity) : null;
}

export function listTaskGrants(database: DatabaseSync, taskId: string, now = new Date(), identity?: { workspaceId: string; runtimeEpoch: string }): TaskGrant[] {
  return (database.prepare('SELECT * FROM task_grants WHERE task_id=? ORDER BY issued_at DESC').all(taskId) as TaskGrantRow[])
    .map((row) => parseTaskGrant(row, now, identity));
}

export function dispatchIssueTaskGrant(runtime: ActiveWorkspaceRuntime, input: IssueTaskGrantInput): Promise<CommandReceiptV1<TaskGrant>> {
  const ownerGoal = input.ownerGoal.trim();
  const allowedCommands = [...new Set(input.allowedCommands)].sort();
  const workers = uniqueWorkers(input.workers);
  const expiresAt = requireFutureTimestamp(input.expiresAt);
  if (!ownerGoal) throw new CommandDispatchError('TASK_GRANT_INVALID', 'Owner goal 不能为空。');
  if (!allowedCommands.length || allowedCommands.some((command) => !TASK_INTERNAL_COMMANDS.includes(command as typeof TASK_INTERNAL_COMMANDS[number]))) {
    throw new CommandDispatchError('TASK_SCOPE_BROADENED', 'Task grant 只能包含已登记的内部业务命令。');
  }
  if (!workers.length) throw new CommandDispatchError('TASK_GRANT_INVALID', 'Task grant 必须绑定至少一个 worker。');
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: TASK_GRANT_ISSUE_COMMAND,
    requestId: input.requestId,
    input: { taskId: input.taskId, ownerGoal, allowedCommands, workers, relevantContext: input.relevantContext ?? {}, expiresAt },
    boundIdentity: { taskId: input.taskId },
    actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }
  });
  return runtime.dispatchCommand(envelope, () => {
    requireRunningTask(runtime.database, input.taskId, runtime.identity.workspaceId);
    const issuedAt = new Date().toISOString();
    const active = runtime.database.prepare("SELECT id FROM task_grants WHERE task_id=? AND runtime_epoch=? AND status='active' AND expires_at>? LIMIT 1")
      .get(input.taskId, runtime.identity.runtimeEpoch, issuedAt);
    if (active) throw new CommandDispatchError('TASK_GRANT_EXISTS', '当前任务已有有效 Task grant。');
    const id = randomUUID();
    runtime.database.prepare(`INSERT INTO task_grants (
      id, workspace_id, runtime_epoch, task_id, owner_goal, allowed_commands_json, workers_json,
      relevant_context_json, status, issued_at, expires_at, revoked_at, revision
    ) VALUES (?,?,?,?,?,?,?,?, 'active', ?,?,NULL,1)`).run(
      id, runtime.identity.workspaceId, runtime.identity.runtimeEpoch, input.taskId, ownerGoal,
      JSON.stringify(allowedCommands), JSON.stringify(workers), JSON.stringify(input.relevantContext ?? {}), issuedAt, expiresAt
    );
    const grant = getTaskGrant(runtime.database, id);
    if (!grant) throw new CommandDispatchError('TASK_GRANT_NOT_FOUND', 'Task grant 写入后无法读回。');
    return { data: grant, entityType: 'task_grant', entityId: id, afterRevision: 1, readback: grant };
  });
}

export function dispatchRevokeTaskGrant(runtime: ActiveWorkspaceRuntime, input: { requestId: string; grantId: string; expectedRevision: number }): Promise<CommandReceiptV1<TaskGrant>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: TASK_GRANT_REVOKE_COMMAND,
    requestId: input.requestId,
    input,
    boundIdentity: { grantId: input.grantId, expectedRevision: input.expectedRevision },
    actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }
  });
  return runtime.dispatchCommand(envelope, () => {
    const current = getTaskGrant(runtime.database, input.grantId);
    if (!current) throw new CommandDispatchError('TASK_GRANT_NOT_FOUND', 'Task grant 不存在。');
    if (current.workspaceId !== runtime.identity.workspaceId || current.runtimeEpoch !== runtime.identity.runtimeEpoch) {
      throw new CommandDispatchError('TASK_GRANT_STALE', 'Task grant 不属于当前运行时。');
    }
    if (current.revision !== input.expectedRevision) throw new CommandDispatchError('REVISION_CONFLICT', 'Task grant 已被其他操作更新。');
    if (current.status !== 'active') throw new CommandDispatchError('TASK_GRANT_INACTIVE', 'Task grant 已失效。');
    const revokedAt = new Date().toISOString();
    runtime.database.prepare("UPDATE task_grants SET status='revoked', revoked_at=?, revision=revision+1 WHERE id=? AND revision=?")
      .run(revokedAt, input.grantId, input.expectedRevision);
    const revoked = getTaskGrant(runtime.database, input.grantId);
    if (!revoked) throw new CommandDispatchError('TASK_GRANT_NOT_FOUND', 'Task grant 撤销后无法读回。');
    return { data: revoked, entityType: 'task_grant', entityId: revoked.id, beforeRevision: current.revision, afterRevision: revoked.revision, readback: revoked };
  });
}

/**
 * R3（WMB-5120）：任务终态时按 task 幂等回收全部 active grant。
 * 复用 TASK_GRANT_REVOKE_COMMAND + receipt + operation audit；scheduler actor 旁路 grant 门；
 * 原子幂等 UPDATE（重复 0 行），receipt data = 本次实际撤销的 grant 列表（重复 = []）。
 * 唯一触发点 = agent_task 终态（写包已被 requireRunningTask 拦截），不要求 expectedRevision。
 */
export function dispatchRevokeTaskGrantsForTask(
  runtime: ActiveWorkspaceRuntime,
  input: { requestId: string; taskId: string }
): Promise<CommandReceiptV1<TaskGrant[]>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: TASK_GRANT_REVOKE_COMMAND,
    requestId: input.requestId,
    input,
    boundIdentity: { taskId: input.taskId },
    actor: { type: 'scheduler', id: 'task-grant-reaper', label: 'task-grant-reaper' }
  });
  return runtime.dispatchCommand(envelope, () => {
    const revokedAt = new Date().toISOString();
    const active = runtime.database.prepare(
      "SELECT id FROM task_grants WHERE task_id=? AND runtime_epoch=? AND status='active'"
    ).all(input.taskId, runtime.identity.runtimeEpoch) as Array<{ id: string }>;
    if (active.length > 0) {
      runtime.database.prepare(
        "UPDATE task_grants SET status='revoked', revoked_at=?, revision=revision+1 WHERE task_id=? AND runtime_epoch=? AND status='active'"
      ).run(revokedAt, input.taskId, runtime.identity.runtimeEpoch);
    }
    const revoked = active
      .map((row) => getTaskGrant(runtime.database, row.id))
      .filter((grant): grant is TaskGrant => grant !== null);
    return { data: revoked, entityType: 'task_grant', entityId: input.taskId, readback: revoked };
  });
}

export const AUTOMATIC_TASK_GRANT_SCOPES = Object.freeze({
  daily_intelligence: Object.freeze([
    'agent_tasks.report_progress',
    'knowledge.record_batch',
    'knowledge.suggestion_create',
    'plans.save',
    'sources.upsert_batch',
    'sources.lane_gate'
  ]),
  daily_scan: Object.freeze([
    'agent_tasks.report_progress',
    'sources.upsert_batch'
  ]),
  daily_judge: Object.freeze([
    'agent_tasks.report_progress',
    'knowledge.record_batch',
    'knowledge.suggestion_create',
    'plans.save',
    'sources.lane_gate'
  ]),
  studio_draft: Object.freeze([
    'agent_tasks.report_progress',
    'content.save_version'
  ]),
  results_review: Object.freeze([
    'agent_tasks.report_progress',
    'knowledge.record_batch',
    'reviews.save'
  ]),
  page_today: PAGE_TASK_GRANT_SCOPES.today.writeScope ?? Object.freeze([] as const),
  page_agents: PAGE_TASK_GRANT_SCOPES.agents.writeScope ?? Object.freeze([] as const),
  page_discover: PAGE_TASK_GRANT_SCOPES.discover.writeScope ?? Object.freeze([] as const),
  page_proposals: PAGE_TASK_GRANT_SCOPES.proposals.writeScope ?? Object.freeze([] as const),
  page_topic: PAGE_TASK_GRANT_SCOPES.topic.writeScope ?? Object.freeze([] as const),
  page_library: PAGE_TASK_GRANT_SCOPES.library.writeScope ?? Object.freeze([] as const),
  page_canvas: PAGE_TASK_GRANT_SCOPES.canvas.writeScope ?? Object.freeze([] as const),
  page_studio: PAGE_TASK_GRANT_SCOPES.studio.writeScope ?? Object.freeze([] as const),
  page_publish: PAGE_TASK_GRANT_SCOPES.publish.writeScope ?? Object.freeze([] as const),
  page_results: PAGE_TASK_GRANT_SCOPES.results.writeScope ?? Object.freeze([] as const),
} as const);

export const AUTOMATIC_TASK_GRANT_EXPIRY_MS = 4 * 60 * 60_000;

export const AUTOMATIC_TASK_GRANT_WORKERS = Object.freeze([
  Object.freeze({ type: 'pi', id: 'pi' }),
  Object.freeze({ type: 'external_agent', id: 'mcp' })
] as const);

export type TaskReadyGrantHook = (taskId: string) => Promise<string>;

function roleForTaskIntent(intent: string | null | undefined): RoleId | null {
  if (!intent) return null;
  // 仅扫/判/整理拆分强制角色：combined daily_intelligence 仍跟 caller/context，避免丢掉 reporter 专属写权。
  if (intent === 'daily_scan') return 'reporter';
  if (intent === 'daily_judge') return 'planner';
  if (intent === 'page_library') return 'librarian';
  return null;
}

export async function ensureAutomaticTaskGrant(
  runtime: ActiveWorkspaceRuntime,
  taskId: string,
  now = new Date(),
  roleId?: RoleId | null
): Promise<string> {
  const task = getAgentTask(runtime.database, taskId);
  if (!task || task.status !== 'running') throw new CommandDispatchError('TASK_NOT_ACTIVE', '无法为非运行中的任务绑定自动授权。');
  const baseCommands = AUTOMATIC_TASK_GRANT_SCOPES[task.intent as keyof typeof AUTOMATIC_TASK_GRANT_SCOPES];
  if (!baseCommands || baseCommands.length === 0) throw new CommandDispatchError('TASK_SCOPE_EMPTY', '该任务 intent 无自动写权（只读页）。');
  // Intent 绑定角色优先：扫->判同进程时 caller 仍可能是 reporter，不能盖住 daily_judge/planner 写权。
  const intentRole = roleForTaskIntent(task.intent);
  const contextRole = typeof task.contextRefs?.roleId === 'string' && isRoleId(task.contextRefs.roleId) ? task.contextRefs.roleId : null;
  const callerRole = roleId && isRoleId(roleId) ? roleId : null;
  const resolvedRole = intentRole ?? contextRole ?? callerRole;
  let allowedCommands = filterCommandsForRole(resolvedRole, baseCommands);
  if (resolvedRole && resolvedRole !== 'desk') {
    try {
      const overlayAllowed = new Set(roleWriteCommandsWithOverlays(runtime.database, runtime.identity.workspaceId, resolvedRole));
      for (const infra of ['agent_tasks.report_progress']) overlayAllowed.add(infra);
      allowedCommands = allowedCommands.filter((command) => overlayAllowed.has(command));
    } catch {
      /* overlays table may be absent on old DBs mid-migration */
    }
  }
  if (!allowedCommands.length) throw new CommandDispatchError('TASK_SCOPE_EMPTY', '角色过滤后无剩余写权。');
  const active = listTaskGrants(runtime.database, taskId, now, runtime.identity).find((grant) => grant.status === 'active');
  if (active && sameCommandSet(active.allowedCommands, allowedCommands) && sameWorkerSet(active.workers, AUTOMATIC_TASK_GRANT_WORKERS)) return active.id;
  if (active) {
    const revoked = await dispatchRevokeTaskGrant(runtime, {
      requestId: `automatic-grant:${taskId}:replace:${randomUUID()}`,
      grantId: active.id,
      expectedRevision: active.revision
    });
    if (!revoked.ok) throw new CommandDispatchError(revoked.error?.code ?? 'TASK_GRANT_REVOKE_FAILED', revoked.error?.message ?? '旧 Task grant 无法撤销。');
  }
  const issued = await dispatchIssueTaskGrant(runtime, {
    requestId: `automatic-grant:${taskId}:${randomUUID()}`,
    taskId,
    ownerGoal: `自动授权：完成 ${task.intent} 任务所需的业务事实写入`,
    allowedCommands: [...allowedCommands],
    workers: [...AUTOMATIC_TASK_GRANT_WORKERS],
    relevantContext: {
      intent: task.intent,
      businessDate: task.businessDate,
      automatic: true,
      roleId: resolvedRole ?? undefined,
      page: typeof task.contextRefs?.page === 'string' ? task.contextRefs.page : undefined,
      objectId: typeof task.contextRefs?.objectId === 'string' ? task.contextRefs.objectId : (typeof task.contextRefs?.projectId === 'string' ? task.contextRefs.projectId : undefined)
    },
    expiresAt: new Date(now.getTime() + AUTOMATIC_TASK_GRANT_EXPIRY_MS).toISOString()
  });
  if (!issued.ok || !issued.data) throw new CommandDispatchError(issued.error?.code ?? 'TASK_GRANT_ISSUE_FAILED', issued.error?.message ?? '自动 Task grant 无法签发。');
  return issued.data.id;
}

function sameCommandSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(actual);
  return expected.every((command) => set.has(command));
}

function sameWorkerSet(actual: readonly TaskGrantWorker[], expected: readonly TaskGrantWorker[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((worker) => actual.some((item) => item.type === worker.type && item.id === worker.id));
}

export function assertTaskGrantForEnvelope(
  database: DatabaseSync,
  envelope: CommandEnvelopeV1,
  now: Date,
  isCurrentPiLease: (leaseId: string, taskId: string) => boolean
): void {
  if (envelope.actor.type !== 'pi' && envelope.actor.type !== 'external_agent') return;
  if (!envelope.taskId || !envelope.grantId) throw new CommandDispatchError('TASK_GRANT_REQUIRED', 'Pi 或外部 Agent 写入必须携带 task grant。');
  const grant = getTaskGrant(database, envelope.grantId, now);
  if (!grant) throw new CommandDispatchError('TASK_GRANT_NOT_FOUND', 'Task grant 不存在。');
  if (grant.workspaceId !== envelope.workspaceId || grant.runtimeEpoch !== envelope.runtimeEpoch || grant.taskId !== envelope.taskId) {
    throw new CommandDispatchError('TASK_GRANT_STALE', 'Task grant 与当前 workspace、runtime 或 task 不匹配。');
  }
  if (grant.status === 'expired') throw new CommandDispatchError('TASK_GRANT_EXPIRED', 'Task grant 已过期。');
  if (grant.status === 'revoked') throw new CommandDispatchError('TASK_GRANT_REVOKED', 'Task grant 已撤销。');
  if (!grant.allowedCommands.includes(envelope.command)) throw new CommandDispatchError('TASK_SCOPE_BROADENED', '命令超出 Task grant 范围。');
  if (!grant.workers.some((worker) => worker.type === envelope.actor.type && worker.id === envelope.actor.id)) {
    throw new CommandDispatchError('TASK_WORKER_MISMATCH', 'Worker 身份与 Task grant 不匹配。');
  }
  requireRunningTask(database, envelope.taskId, envelope.workspaceId);
  if (envelope.actor.type === 'pi') {
    if (!envelope.workerLeaseId || !isCurrentPiLease(envelope.workerLeaseId, envelope.taskId)) {
      throw new CommandDispatchError('WORKER_LEASE_STALE', 'Pi worker lease 已失效。');
    }
  }
}

function parseTaskGrant(row: TaskGrantRow, now: Date, identity?: { workspaceId: string; runtimeEpoch: string }): TaskGrant {
  const status = row.status === 'revoked' ? 'revoked'
    : identity && (row.workspace_id !== identity.workspaceId || row.runtime_epoch !== identity.runtimeEpoch)
      ? 'stale' : Date.parse(row.expires_at) <= now.getTime() ? 'expired' : 'active';
  return Object.freeze({
    version: 'TaskGrantV1' as const,
    id: row.id,
    workspaceId: row.workspace_id,
    runtimeEpoch: row.runtime_epoch,
    taskId: row.task_id,
    ownerGoal: row.owner_goal,
    allowedCommands: Object.freeze(JSON.parse(row.allowed_commands_json) as string[]),
    workers: Object.freeze(JSON.parse(row.workers_json) as TaskGrantWorker[]),
    relevantContext: Object.freeze(JSON.parse(row.relevant_context_json) as Record<string, unknown>),
    status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revision: row.revision
  });
}

function uniqueWorkers(workers: TaskGrantWorker[]): TaskGrantWorker[] {
  const seen = new Set<string>();
  const result: TaskGrantWorker[] = [];
  for (const worker of workers) {
    if (worker.type !== 'pi' && worker.type !== 'external_agent') throw new CommandDispatchError('TASK_GRANT_INVALID', 'Worker type 不受支持。');
    const id = worker.id.trim();
    if (!id) throw new CommandDispatchError('TASK_GRANT_INVALID', 'Worker id 不能为空。');
    const key = `${worker.type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ type: worker.type, id }));
  }
  return result;
}

function requireFutureTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new CommandDispatchError('TASK_GRANT_INVALID', 'Task grant 到期时间必须是未来时间。');
  return new Date(timestamp).toISOString();
}

function requireRunningTask(database: DatabaseSync, taskId: string, workspaceId: string): void {
  const row = database.prepare('SELECT status, context_refs_json AS contextRefsJson FROM agent_tasks WHERE id=?').get(taskId);
  if (!row || typeof row !== 'object' || !('status' in row) || row.status !== 'running') {
    throw new CommandDispatchError('TASK_NOT_ACTIVE', 'Task grant 只适用于当前运行中的任务。');
  }
  const context = 'contextRefsJson' in row && typeof row.contextRefsJson === 'string'
    ? JSON.parse(row.contextRefsJson) as Record<string, unknown> : {};
  if (context.workspaceId !== workspaceId) {
    throw new CommandDispatchError('TASK_GRANT_STALE', 'Task 不属于当前 workspace。');
  }
}
