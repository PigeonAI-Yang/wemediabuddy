import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CommandDispatchError,
  createCommandEnvelope,
  type CommandActorV1,
  type CommandEnvelopeV1,
  type CommandReceiptV1
} from './command-dispatcher.ts';
import { getTaskGrant } from './task-grants.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const EXECUTION_GRANT_ISSUE_COMMAND = 'execution_grants.issue';
export const EXECUTION_GRANT_REVOKE_COMMAND = 'execution_grants.revoke';
export const PRECISE_EXECUTION_COMMANDS = Object.freeze([
  'intelligence_channels.proposal_apply',
  'x_lists.operation_execute',
  'publication.editor_prepare_execute'
] as const);

export type PreciseExecutionGrant = Readonly<{
  version: 'PreciseExecutionGrantV1';
  id: string;
  workspaceId: string;
  runtimeEpoch: string;
  taskId: string | null;
  taskGrantId: string | null;
  command: typeof PRECISE_EXECUTION_COMMANDS[number];
  inputHash: string;
  boundIdentity: Readonly<Record<string, unknown>>;
  targetActor: CommandActorV1;
  browserProfileId: string | null;
  bindingRevision: number | null;
  expectedAccount: string | null;
  allowedTransition: string;
  requiredReadback: Readonly<Record<string, unknown>>;
  status: 'active' | 'consumed' | 'revoked' | 'expired' | 'stale';
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revision: number;
}>;
export type PreciseExecutionGrantV1 = PreciseExecutionGrant;

export type IssueExecutionGrantInput = Readonly<{
  requestId: string;
  taskId?: string;
  taskGrantId?: string;
  command: string;
  inputHash: string;
  boundIdentity: Readonly<Record<string, unknown>>;
  targetActor: CommandActorV1;
  browserProfileId?: string;
  bindingRevision?: number;
  expectedAccount?: string;
  allowedTransition: string;
  requiredReadback: Readonly<Record<string, unknown>>;
  expiresAt: string;
}>;

type ExecutionGrantRow = {
  id: string;
  workspace_id: string;
  runtime_epoch: string;
  task_id: string | null;
  task_grant_id: string | null;
  command: typeof PRECISE_EXECUTION_COMMANDS[number];
  input_hash: string;
  bound_identity_json: string;
  target_actor_type: CommandActorV1['type'];
  target_actor_id: string;
  browser_profile_id: string | null;
  binding_revision: number | null;
  expected_account: string | null;
  allowed_transition: string;
  required_readback_json: string;
  status: 'active' | 'consumed' | 'revoked';
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  revision: number;
};

type RuntimeIdentity = Readonly<{ workspaceId: string; runtimeEpoch: string }>;

export function getExecutionGrant(
  database: DatabaseSync,
  id: string,
  now = new Date(),
  identity?: RuntimeIdentity
): PreciseExecutionGrant | null {
  const row = database.prepare('SELECT * FROM execution_grants WHERE id=?').get(id) as ExecutionGrantRow | undefined;
  return row ? parseExecutionGrant(row, now, identity) : null;
}

export function listExecutionGrants(
  database: DatabaseSync,
  filters: { taskId?: string | null; status?: PreciseExecutionGrant['status'] } = {},
  now = new Date(),
  identity?: RuntimeIdentity
): PreciseExecutionGrant[] {
  const rows = filters.taskId === undefined
    ? database.prepare('SELECT * FROM execution_grants ORDER BY issued_at DESC').all()
    : filters.taskId === null
      ? database.prepare('SELECT * FROM execution_grants WHERE task_id IS NULL ORDER BY issued_at DESC').all()
      : database.prepare('SELECT * FROM execution_grants WHERE task_id=? ORDER BY issued_at DESC').all(filters.taskId);
  const grants = (rows as ExecutionGrantRow[]).map((row) => parseExecutionGrant(row, now, identity));
  return filters.status ? grants.filter((grant) => grant.status === filters.status) : grants;
}

export function dispatchIssueExecutionGrant(
  runtime: ActiveWorkspaceRuntime,
  input: IssueExecutionGrantInput
): Promise<CommandReceiptV1<PreciseExecutionGrant>> {
  const taskId = optionalText(input.taskId);
  const taskGrantId = optionalText(input.taskGrantId);
  if (Boolean(taskId) !== Boolean(taskGrantId)) {
    throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', 'taskId 与 taskGrantId 必须同时提供或同时省略。');
  }
  const command = requireTargetCommand(input.command);
  const inputHash = requireInputHash(input.inputHash);
  const boundIdentity = normalizeRecord(input.boundIdentity, 'boundIdentity');
  const requiredReadback = normalizeRecord(input.requiredReadback, 'requiredReadback');
  const targetActor = requireOwnerTarget(input.targetActor);
  const browserProfileId = optionalText(input.browserProfileId);
  const bindingRevision = optionalRevision(input.bindingRevision);
  const expectedAccount = optionalText(input.expectedAccount);
  const allowedTransition = requiredText(input.allowedTransition, 'allowedTransition');
  const expiresAt = requireFutureTimestamp(input.expiresAt);
  if (taskId && taskGrantId) {
    requireTaskGrant(databaseIdentity(runtime), runtime.database, taskId, taskGrantId, command, new Date());
  }

  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: EXECUTION_GRANT_ISSUE_COMMAND,
    requestId: input.requestId,
    input: {
      taskId, taskGrantId, command, inputHash, boundIdentity, targetActor, browserProfileId,
      bindingRevision, expectedAccount, allowedTransition, requiredReadback, expiresAt
    },
    boundIdentity: { taskId, taskGrantId, command, inputHash, targetActor },
    actor: ownerUiActor()
  });

  return runtime.dispatchCommand(envelope, () => {
    if (taskId && taskGrantId) {
      requireTaskGrant(databaseIdentity(runtime), runtime.database, taskId, taskGrantId, command, new Date());
    }
    const id = randomUUID();
    const issuedAt = new Date().toISOString();
    runtime.database.prepare(`INSERT INTO execution_grants (
      id, workspace_id, runtime_epoch, task_id, task_grant_id, command, input_hash,
      bound_identity_json, target_actor_type, target_actor_id, browser_profile_id,
      binding_revision, expected_account, allowed_transition, required_readback_json,
      status, issued_at, expires_at, consumed_at, revoked_at, revision
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,NULL,NULL,1)`).run(
      id, runtime.identity.workspaceId, runtime.identity.runtimeEpoch, taskId, taskGrantId,
      command, inputHash, stableJson(boundIdentity), targetActor.type, targetActor.id,
      browserProfileId, bindingRevision, expectedAccount, allowedTransition,
      stableJson(requiredReadback), issuedAt, expiresAt
    );
    const grant = getExecutionGrant(runtime.database, id, new Date(), runtime.identity);
    if (!grant) throw grantError('EXECUTION_GRANT_NOT_FOUND', 'Precise execution grant 写入后无法读回。');
    return { data: grant, entityType: 'execution_grant', entityId: id, afterRevision: 1, readback: grant };
  });
}

export function dispatchRevokeExecutionGrant(
  runtime: ActiveWorkspaceRuntime,
  input: { requestId: string; executionGrantId: string; expectedRevision: number }
): Promise<CommandReceiptV1<PreciseExecutionGrant>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: EXECUTION_GRANT_REVOKE_COMMAND,
    requestId: input.requestId,
    input,
    boundIdentity: { executionGrantId: input.executionGrantId, expectedRevision: input.expectedRevision },
    actor: ownerUiActor()
  });
  return runtime.dispatchCommand(envelope, () => {
    const current = requireGrant(runtime.database, input.executionGrantId, new Date(), runtime.identity);
    requireActive(current);
    if (current.revision !== input.expectedRevision) {
      throw grantError('EXECUTION_GRANT_REVISION_CONFLICT', 'Precise execution grant revision 已变化。');
    }
    const revokedAt = new Date().toISOString();
    const result = runtime.database.prepare(`UPDATE execution_grants
      SET status='revoked', revoked_at=?, revision=revision+1
      WHERE id=? AND status='active' AND revision=?`).run(revokedAt, current.id, input.expectedRevision);
    if (result.changes !== 1) throw grantError('EXECUTION_GRANT_REVISION_CONFLICT', 'Precise execution grant 撤销发生并发冲突。');
    const revoked = requireGrant(runtime.database, current.id, new Date(), runtime.identity);
    return {
      data: revoked, entityType: 'execution_grant', entityId: revoked.id,
      beforeRevision: current.revision, afterRevision: revoked.revision, readback: revoked
    };
  });
}

export function assertExecutionGrantForEnvelope(database: DatabaseSync, envelope: CommandEnvelopeV1, now: Date): void {
  if (!PRECISE_EXECUTION_COMMANDS.includes(envelope.command as typeof PRECISE_EXECUTION_COMMANDS[number])) return;
  if (!envelope.executionGrantId) {
    throw grantError('EXECUTION_GRANT_REQUIRED', '该命令必须携带 precise execution grant。');
  }
  const grant = requireGrant(database, envelope.executionGrantId, now);
  if (grant.workspaceId !== envelope.workspaceId || grant.runtimeEpoch !== envelope.runtimeEpoch) {
    throw grantError('EXECUTION_GRANT_STALE', 'Precise execution grant 不属于当前 workspace 或 runtime。');
  }
  if (grant.taskId !== (envelope.taskId ?? null) || grant.taskGrantId !== (envelope.grantId ?? null)
    || grant.command !== envelope.command || grant.inputHash !== envelope.inputHash) {
    throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', '命令、任务或输入指纹超出 precise execution grant 范围。');
  }
  if (stableJson(grant.boundIdentity) !== stableJson(envelope.boundIdentity)
    || grant.targetActor.type !== envelope.actor.type || grant.targetActor.id !== envelope.actor.id) {
    throw grantError('EXECUTION_GRANT_IDENTITY_MISMATCH', '命令身份与 precise execution grant 不匹配。');
  }
  const identityBrowserProfile = optionalIdentityText(envelope.boundIdentity.browserProfileId);
  const identityBindingRevision = optionalIdentityRevision(envelope.boundIdentity.browserBindingRevision);
  const identityExpectedAccount = optionalIdentityText(envelope.boundIdentity.expectedAccount);
  const identityAllowedTransition = requiredIdentityText(envelope.boundIdentity.allowedTransition, 'allowedTransition');
  const identityRequiredReadback = normalizeRecord(envelope.boundIdentity.requiredReadback, 'requiredReadback');
  if (grant.browserProfileId !== identityBrowserProfile || grant.bindingRevision !== identityBindingRevision
    || grant.expectedAccount !== identityExpectedAccount || grant.allowedTransition !== identityAllowedTransition
    || stableJson(grant.requiredReadback) !== stableJson(identityRequiredReadback)) {
    throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', '浏览器、账号、状态转换或回读要求超出 precise execution grant 范围。');
  }
  requireActive(grant);
  if (grant.taskId && grant.taskGrantId) {
    requireTaskGrant({ workspaceId: envelope.workspaceId, runtimeEpoch: envelope.runtimeEpoch }, database,
      grant.taskId, grant.taskGrantId, grant.command, now);
  }
  const consumedAt = now.toISOString();
  const result = database.prepare(`UPDATE execution_grants
    SET status='consumed', consumed_at=?, revision=revision+1
    WHERE id=? AND status='active' AND revision=? AND expires_at>?`).run(consumedAt, grant.id, grant.revision, consumedAt);
  if (result.changes !== 1) {
    const latest = requireGrant(database, grant.id, now);
    requireActive(latest);
    throw grantError('EXECUTION_GRANT_REVISION_CONFLICT', 'Precise execution grant 消费发生并发冲突。');
  }
}

function requireGrant(database: DatabaseSync, id: string, now: Date, identity?: RuntimeIdentity): PreciseExecutionGrant {
  const grant = getExecutionGrant(database, id, now, identity);
  if (!grant) throw grantError('EXECUTION_GRANT_NOT_FOUND', 'Precise execution grant 不存在。');
  return grant;
}

function requireActive(grant: PreciseExecutionGrant): void {
  if (grant.status === 'stale') throw grantError('EXECUTION_GRANT_STALE', 'Precise execution grant 已不属于当前运行时。');
  if (grant.status === 'expired') throw grantError('EXECUTION_GRANT_EXPIRED', 'Precise execution grant 已过期。');
  if (grant.status === 'revoked') throw grantError('EXECUTION_GRANT_REVOKED', 'Precise execution grant 已撤销。');
  if (grant.status === 'consumed') throw grantError('EXECUTION_GRANT_CONSUMED', 'Precise execution grant 已消费。');
}

function requireTaskGrant(
  identity: RuntimeIdentity,
  database: DatabaseSync,
  taskId: string,
  taskGrantId: string,
  command: string,
  now: Date
): void {
  const taskGrant = getTaskGrant(database, taskGrantId, now, identity);
  if (!taskGrant) throw grantError('EXECUTION_GRANT_NOT_FOUND', '引用的 TaskGrantV1 不存在。');
  if (taskGrant.workspaceId !== identity.workspaceId || taskGrant.runtimeEpoch !== identity.runtimeEpoch || taskGrant.taskId !== taskId) {
    throw grantError('EXECUTION_GRANT_STALE', '引用的 TaskGrantV1 不属于当前 workspace、runtime 或 task。');
  }
  if (taskGrant.status === 'expired') throw grantError('EXECUTION_GRANT_EXPIRED', '引用的 TaskGrantV1 已过期。');
  if (taskGrant.status === 'revoked') throw grantError('EXECUTION_GRANT_REVOKED', '引用的 TaskGrantV1 已撤销。');
  if (taskGrant.status !== 'active' || !taskGrant.allowedCommands.includes(command)) {
    throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', '命令超出引用的 TaskGrantV1 范围。');
  }
  const task = database.prepare('SELECT status, context_refs_json AS contextRefsJson FROM agent_tasks WHERE id=?').get(taskId) as
    { status: string; contextRefsJson: string } | undefined;
  const context = task ? JSON.parse(task.contextRefsJson) as Record<string, unknown> : {};
  if (!task || task.status !== 'running' || context.workspaceId !== identity.workspaceId) {
    throw grantError('EXECUTION_GRANT_STALE', 'Precise execution grant 引用的 task 不再处于当前运行状态。');
  }
}

function parseExecutionGrant(row: ExecutionGrantRow, now: Date, identity?: RuntimeIdentity): PreciseExecutionGrant {
  const status = identity && (row.workspace_id !== identity.workspaceId || row.runtime_epoch !== identity.runtimeEpoch)
    ? 'stale' : row.status === 'active' && Date.parse(row.expires_at) <= now.getTime() ? 'expired' : row.status;
  return Object.freeze({
    version: 'PreciseExecutionGrantV1' as const,
    id: row.id,
    workspaceId: row.workspace_id,
    runtimeEpoch: row.runtime_epoch,
    taskId: row.task_id,
    taskGrantId: row.task_grant_id,
    command: row.command,
    inputHash: row.input_hash,
    boundIdentity: Object.freeze(JSON.parse(row.bound_identity_json) as Record<string, unknown>),
    targetActor: Object.freeze({ type: row.target_actor_type, id: row.target_actor_id }),
    browserProfileId: row.browser_profile_id,
    bindingRevision: row.binding_revision,
    expectedAccount: row.expected_account,
    allowedTransition: row.allowed_transition,
    requiredReadback: Object.freeze(JSON.parse(row.required_readback_json) as Record<string, unknown>),
    status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    revision: row.revision
  });
}

function requireTargetCommand(command: string): typeof PRECISE_EXECUTION_COMMANDS[number] {
  if (!PRECISE_EXECUTION_COMMANDS.includes(command as typeof PRECISE_EXECUTION_COMMANDS[number])) {
    throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', '命令不属于 precise execution grant 固定目标范围。');
  }
  return command as typeof PRECISE_EXECUTION_COMMANDS[number];
}

function requireOwnerTarget(actor: CommandActorV1): CommandActorV1 {
  if (actor.type !== 'owner_ui' || actor.id !== 'renderer') {
    throw grantError('EXECUTION_GRANT_IDENTITY_MISMATCH', '当前只允许精确授权 owner_ui:renderer。');
  }
  return Object.freeze({ type: 'owner_ui', id: 'renderer' });
}

function requireInputHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', '目标 inputHash 无效。');
  return value;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', `${field} 不能为空。`);
  return normalized;
}

function optionalText(value?: string): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function optionalRevision(value?: number): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', 'bindingRevision 无效。');
  return value;
}

function requireFutureTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw grantError('EXECUTION_GRANT_EXPIRED', 'Precise execution grant 到期时间必须是未来时间。');
  }
  return new Date(timestamp).toISOString();
}

function normalizeRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', `${field} 必须是 JSON object。`);
  }
  return Object.freeze(normalizeJson(value) as Record<string, unknown>);
}

function optionalIdentityText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalIdentityRevision(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function requiredIdentityText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw grantError('EXECUTION_GRANT_SCOPE_MISMATCH', `${name} 身份字段缺失。`);
  return value.trim();
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizeJson(entry)]));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function databaseIdentity(runtime: ActiveWorkspaceRuntime): RuntimeIdentity {
  return { workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch };
}

function ownerUiActor(): CommandActorV1 {
  return Object.freeze({ type: 'owner_ui', id: 'renderer', label: 'Owner UI' });
}

function grantError(code: string, message: string): CommandDispatchError {
  return new CommandDispatchError(code, message);
}
