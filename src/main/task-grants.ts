import { PAGE_TASK_GRANT_SCOPES, type PageTaskIntent } from '../shared/page-authority.ts';
import { AGENT_CAPABILITIES, deskStanding, deskStandingCommands, filterCommandsForRole, isRoleId, type RoleId } from '../shared/agent-capabilities.ts';
import { roleWriteCommandsWithOverlays } from './capability-overlays.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CommandDispatchError, commandInputHash, createCommandEnvelope, type CommandActorV1, type CommandEnvelopeV1, type CommandReceiptV1 } from './command-dispatcher.ts';
import { getAgentTask } from './agent-tasks.ts';
import {
  assertBoundaryCovers,
  assertJobBoundaryComplete,
  boundaryClaimFromContext,
  hasBoundaryClaim,
  isEmployeeRole,
  maskBoundaryToRole,
  readJobContract,
  resolveCommandObjectBoundary
} from './role-job-registry.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const TASK_GRANT_ISSUE_COMMAND = 'task_grants.issue';
export const TASK_GRANT_REVOKE_COMMAND = 'task_grants.revoke';
export const TASK_INTERNAL_COMMANDS = Object.freeze([
  'agent_tasks.report_progress',
  'content.create',
  'content.save_version',
  'content_derivative.ensure',
  'content_derivative.save_version',
  'content_derivative.finalize_version',
  'daily_content_cycle.ensure',
  'daily_content_cycle.pause',
  'daily_content_cycle.resume',
  'daily_content_target.carry',
  'daily_content_target.replace',
  'daily_content_target.select',
  'daily_content_target.skip',
  'daily_content_target.transition',
  'daily_iteration.draft_ensure',
  'daily_iteration.published_ensure',
  'daily_iteration.projection',
  'daily_iteration.version_create',
  'intelligence.zhihu_hot.scan',
  'intelligence_channels.proposal_apply',
  'intelligence_channels.proposal_apply_safe',
  'investigation.direction_save',
  'investigation.outline_save',
  'investigation.review_research',
  'knowledge.creative_brief_create',
  'knowledge.creative_brief_create_project',
  'knowledge.creative_brief_update',
  'knowledge.domain_create',
  'knowledge.domain_update',
  'knowledge.lint',
  'knowledge.maintenance',
  'knowledge.record_batch',
  'knowledge.topic_maintenance_approve',
  'knowledge.topic_maintenance_propose',
  'knowledge.topic_maintenance_reject',
  'knowledge.topic_maintenance_reproposal_retry',
  'knowledge.suggestion_create',
  'knowledge_flywheel.change_set_apply',
  'media.recommendations_generate',
  'plan_item.advance',
  'plan_item.approve',
  'plan_item.reject',
  'plan_item.rework',
  'plan_item.submit',
  'plans.save',
  'publication.snapshot_create',
  'reviews.save',
  'sources.lane_gate',
  'sources.lane_restore',
  'sources.update_status',
  'sources.upsert_batch',
  'x_lists.observation_start',
  'x_lists.observation_stop',
  'x_lists.operation_execute',
  'x_lists.prepare'
] as const);

/** cap.topic_approval 命令族（注册表唯一真源；WMB-5183 §5/A4 执行面角色门，只读消费 5182 定义）。 */
const TOPIC_APPROVAL_COMMANDS: ReadonlySet<string> = Object.freeze(new Set<string>(
  AGENT_CAPABILITIES.find((cap) => cap.id === 'cap.topic_approval')?.commands ?? []
));

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
    // WMB-5141 §12.2.7 签发硬门：任务携带 spawn 合同时，对象边界必须完整（缺失 fail closed），
    // 且 relevantContext 若有边界主张必须被任务边界覆盖（越界拒签；主张按角色合同维度掩码）。
    const contract = readJobContract(runtime.database, input.taskId);
    if (contract) {
      if (isEmployeeRole(contract.roleId)) assertJobBoundaryComplete(contract.boundary, contract.roleId);
      const claim = boundaryClaimFromContext(input.relevantContext ?? {});
      const masked = isEmployeeRole(contract.roleId) ? maskBoundaryToRole(claim, contract.roleId) : claim;
      if (hasBoundaryClaim(masked)) assertBoundaryCovers(contract.boundary, masked);
    }
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
    'plan_item.submit',
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
    'plan_item.submit',
    'plans.save',
    'sources.lane_gate'
  ]),
  research: Object.freeze([
    'agent_tasks.report_progress',
    'sources.upsert_batch'
  ]),
  studio_draft: Object.freeze([
    'agent_tasks.report_progress',
    'content.save_version',
    'content_derivative.ensure',
    'content_derivative.save_version',
    'content_derivative.finalize_version'
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
  // 仅扫/判/研究拆分强制角色（runner 拆分线程的固定角色）：combined daily_intelligence 仍跟 caller/context，
  // 避免丢掉 reporter 专属写权。page_* 一律由显式任务 contextRefs.roleId / caller 解析（WMB-5185：
  // 页 dock 恒为主管 desk，员工 page_library 工单经 contextRefs.roleId='librarian' 保持车道）。
  if (intent === 'daily_scan') return 'reporter';
  if (intent === 'daily_judge') return 'planner';
  if (intent === 'research') return 'reporter';
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
  // Intent 绑定角色优先：扫->判同进程时 caller 仍可能是 reporter，不能盖住 daily_judge/planner 写权。
  const intentRole = roleForTaskIntent(task.intent);
  const contextRole = typeof task.contextRefs?.roleId === 'string' && isRoleId(task.contextRefs.roleId) ? task.contextRefs.roleId : null;
  const callerRole = roleId && isRoleId(roleId) ? roleId : null;
  const resolvedRole = intentRole ?? contextRole ?? callerRole;
  let allowedCommands: readonly string[];
  if (resolvedRole === 'desk') {
    // WMB-5182 §4.3 I2：主管签发基底 = standing 全量（不经 intent 收窄、跳过 overlays，A 子决策）。
    allowedCommands = deskStandingCommands();
  } else {
    const baseCommands = AUTOMATIC_TASK_GRANT_SCOPES[task.intent as keyof typeof AUTOMATIC_TASK_GRANT_SCOPES];
    if (!baseCommands || baseCommands.length === 0) throw new CommandDispatchError('TASK_SCOPE_EMPTY', '该任务 intent 无自动写权（只读页）。');
    allowedCommands = filterCommandsForRole(resolvedRole, baseCommands);
    if (resolvedRole) {
      try {
        const overlayAllowed = new Set(roleWriteCommandsWithOverlays(runtime.database, runtime.identity.workspaceId, resolvedRole));
        for (const infra of ['agent_tasks.report_progress']) overlayAllowed.add(infra);
        allowedCommands = allowedCommands.filter((command) => overlayAllowed.has(command));
      } catch {
        /* overlays table may be absent on old DBs mid-migration */
      }
    }
  }
  if (!allowedCommands.length) throw new CommandDispatchError('TASK_SCOPE_EMPTY', '角色过滤后无剩余写权。');
  // WMB-5141 §12.2.7 签发硬门：携带 spawn 合同的工单对象边界必须完整（缺失 fail closed），
  // 先于 grant 复用/签发执行，杜绝缺边界任务借旧证放行。
  const contract = readJobContract(runtime.database, taskId);
  if (contract && isEmployeeRole(contract.roleId)) assertJobBoundaryComplete(contract.boundary, contract.roleId);
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
      objectId: typeof task.contextRefs?.objectId === 'string' ? task.contextRefs.objectId : (typeof task.contextRefs?.projectId === 'string' ? task.contextRefs.projectId : undefined),
      ...(contract ? { jobBoundary: Object.freeze({ ...contract.boundary }) } : {})
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
  // WMB-5182 §5：topic approve/reject/reproposal_retry 重分类为主管内部审批——删除 Owner-UI 硬拦，
  // 统一由 standing 集成员资格（cap.topic_approval 仅 {desk:true}）+ grant scope 校验把关；
  // 员工/外部 Agent 因 grant 不含该命令仍零写拒绝（TASK_SCOPE_BROADENED）。
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
  // WMB-5183 §5/A4：cap.topic_approval 仅绑定主管（{desk:true}）。即使 grant 被手工误含该命令，
  // 员工角色任务与外部 Agent 也在写前被角色/执行边界拒绝（handler 未执行 → 零业务写，无 grant-free 路径）。
  if (TOPIC_APPROVAL_COMMANDS.has(envelope.command)) {
    const task = getAgentTask(database, envelope.taskId);
    const taskRole = task
      ? (roleForTaskIntent(task.intent) ?? (typeof task.contextRefs?.roleId === 'string' && isRoleId(task.contextRefs.roleId) ? task.contextRefs.roleId : null))
      : null;
    if (taskRole !== 'desk' || envelope.actor.type !== 'pi') {
      throw new CommandDispatchError('TASK_SCOPE_BROADENED', '主题审批命令仅主管（desk）可执行，员工与外部 Agent 不代批。', { reason: 'ROLE_SCOPE_BLOCKED' });
    }
  }
  requireRunningTask(database, envelope.taskId, envelope.workspaceId);
  // WMB-5141 §12.2.7 执行硬门：任务携带 spawn 合同时，命令对象必须落在任务持久边界内
  // （跨对象写 BLOCKED + details.reason=OBJECT_SCOPE_MISMATCH；handler 未执行 → 零业务写，
  // 拒绝由 dispatcher persistError 落 command_receipts + operation_log 审计）。
  const contract = readJobContract(database, envelope.taskId);
  if (contract) {
    const claim = resolveCommandObjectBoundary(envelope.command, envelope.input);
    assertBoundaryCovers(contract.boundary, isEmployeeRole(contract.roleId) ? maskBoundaryToRole(claim, contract.roleId) : claim);
  }
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

/**
 * WMB-5182 §4.8 写前 stale-scope 判定（窄派发边界）：主管会话的写请求命中「命令超出 Task grant 范围」
 * 且命令 ∈ deskStanding → 旧证未换发（§4.7）或本页旧证过窄，需要恰一次重签后重放同一 envelope。
 * 红线/基建类（expired/revoked/stale/worker 不匹配）与员工命令一律不触发（员工越界 = 语义不变拒绝）。
 */
export function shouldRefreshDeskStaleScope(database: DatabaseSync, envelope: CommandEnvelopeV1, now: Date): boolean {
  if (envelope.actor.type !== 'pi' && envelope.actor.type !== 'external_agent') return false;
  if (!envelope.taskId || !envelope.grantId) return false;
  if (!deskStanding.has(envelope.command)) return false;
  const grant = getTaskGrant(database, envelope.grantId, now);
  if (!grant || grant.status !== 'active') return false;
  if (grant.workspaceId !== envelope.workspaceId || grant.runtimeEpoch !== envelope.runtimeEpoch) return false;
  if (grant.allowedCommands.includes(envelope.command)) return false;
  const task = getAgentTask(database, envelope.taskId);
  if (!task) return false;
  const contextRole = typeof task.contextRefs?.roleId === 'string' && isRoleId(task.contextRefs.roleId) ? task.contextRefs.roleId : null;
  return (roleForTaskIntent(task.intent) ?? contextRole) === 'desk';
}

/** 重签后把同一 envelope 改绑到新 grant（inputHash 覆盖 grantId，需重算；此前无任何已落收据，改绑安全）。 */
export function rebindEnvelopeGrant<T>(envelope: CommandEnvelopeV1<T>, grantId: string): CommandEnvelopeV1<T> {
  const next = { ...envelope, grantId };
  return Object.freeze({ ...next, inputHash: commandInputHash(next) });
}
