import type { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import * as z from 'zod';
import { CommandDispatchError } from './command-dispatcher.ts';
import type { AgentIntent, AgentTask, AgentTaskStatus } from './agent-tasks.ts';
import { getAgentTask } from './agent-tasks.ts';
import { getContentProject } from './content.ts';
import type { EmployeeRole } from './job-pool.ts';
import { shanghaiDate } from './ferment.ts';
import { AUTOMATIC_TASK_GRANT_SCOPES } from './task-grants.ts';

/**
 * WMB-5116 角色工单注册表（唯一真相源）。
 *
 * - `RoleJobRequest`：外部 spawn 输入，按 roleId 判别的联合，**不含 intent / planDate**；
 *   intent 只能由本注册表派生（§5.2 派生表）。
 * - `deriveRoleJobSpec`：spawn 期一次性派生 intent / 业务日期 / 专属锁键 / 策略 / 读回规则。
 * - `mapOutcomeToTerminal`：pool 与 agent_task 五终态的唯一映射（§5.3，取消优先）。
 * - 读回规则（§7）：四角色各自的可证伪业务读回；无读回不得 succeeded。
 */

export type RoleJobRequest =
  | Readonly<{ roleId: 'reporter'; brief: string; businessDate?: string | null; channelIds?: readonly string[] | null; sourceFeedIds?: readonly string[] | null }>
  | Readonly<{ roleId: 'planner'; brief: string; businessDate?: string | null }>
  | Readonly<{ roleId: 'writer'; brief: string; projectId: string; businessDate?: string | null }>
  | Readonly<{ roleId: 'librarian'; brief: string; sourceIds?: readonly string[] | null; scope?: 'workspace' | null }>;

export type RoleJobPolicy = 'scan' | 'judge' | 'draft' | 'organize';
export type RoleJobReadbackKind = 'scan_phase' | 'plans_revision' | 'content_version' | 'library_mutation';

export type RoleJobSpec = Readonly<{
  roleId: EmployeeRole;
  intent: AgentIntent;
  businessDate: string;
  projectId: string | null;
  /** WMB-5141 持久边界：标准化（去重 + 字典序）sourceIds（reporter=channelIds；librarian=sourceIds）。 */
  sourceIds: readonly string[];
  /** WMB-5141 持久边界：librarian 的写权范围（workspace=整个工作空间资料库；null=仅限 sourceIds）。 */
  scope: 'workspace' | null;
  resourceLocks: readonly string[];
  policy: RoleJobPolicy;
  readback: RoleJobReadbackKind;
}>;

/**
 * WMB-5141 工单对象边界（设计 §8.1：锁键是什么，写权对象就是什么）。
 * businessDate/projectId/sourceIds/scope 四维；scope='workspace' 时 sourceIds 不受约束。
 */
export type JobObjectBoundary = Readonly<{
  businessDate: string | null;
  projectId: string | null;
  sourceIds: readonly string[];
  scope: 'workspace' | null;
}>;

/**
 * WMB-5141 持久续派合同（设计 §7.3/§12.2.1）：从 agent_tasks.context_refs_json 读回。
 * jobId 存在 = 该任务携带 spawn 合同，dispatcher 必须对其执行对象级硬隔离。
 */
export type JobContract = Readonly<{
  jobId: string;
  roleId: string;
  brief: string;
  boundary: JobObjectBoundary;
}>;

export type JobTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'partial' | 'needs_user';

/**
 * §5.2 半 1 瞬时让路信号：daily 通道守卫命中 running judge 时打标，
 * 随 `EmployeePolicyRun.deferred` 透传到 runner → 瞬时 deferred outcome
 * （不写 agent_task 终态、不进五态映射；runJob 前置泊车 RESOURCE_JUDGE_IN_FLIGHT）。
 */
export type DeferredSignal = Readonly<{ reason: 'JUDGE_IN_FLIGHT'; taskId: string }>;

/**
 * 结构化执行结果（§5.3）。readback 是 succeeded/partial 的业务证据。
 * status 含瞬时 `'deferred'`（§5.2：running judge 让 reporter 让路——不写 agent_task 终态、
 * 不进五态映射）；deferred 不属于 `JobTerminalStatus`，任何终态映射必须先行拦截（§5.3）。
 */
export type JobExecutionOutcome = Readonly<{
  status: JobTerminalStatus | 'deferred';
  code: string;
  message: string | null;
  readback: RoleJobReadbackV1 | null;
}>;

export type RoleJobReadbackV1 =
  | { kind: 'plans_revision'; planDate: string; revision: number }
  | { kind: 'content_version'; projectId: string; versionId: string }
  | { kind: 'sources_mutated'; count: number }
  | { kind: 'scan_phase_reached'; phase: string }
  | { kind: 'noop_confirmed'; scope: string };

export type RoleJobReportV1 = Readonly<{
  jobId: string;
  roleId: EmployeeRole;
  intent: AgentIntent;
  status: JobTerminalStatus;
  code: string;
  businessDate: string;
  projectId: string | null;
  taskId: string | null;
  phase: string | null;
  readback: RoleJobReadbackV1 | null;
  startedAt: string | null;
  finishedAt: string;
  errorMessage: string | null;
}>;

/** 稳定错误码（§9.2）。 */
export const JOB_ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  JOB_BRIEF_REQUIRED: 'JOB_BRIEF_REQUIRED',
  JOB_PROJECT_REQUIRED: 'JOB_PROJECT_REQUIRED',
  ROLE_NOT_SPAWNABLE: 'ROLE_NOT_SPAWNABLE',
  JOB_CANCELLED: 'JOB_CANCELLED',
  RESOURCE_LOCK_CONFLICT: 'RESOURCE_LOCK_CONFLICT',
  RESOURCE_LEASE_BUSY: 'RESOURCE_LEASE_BUSY',
  JOB_READBACK_MISSING: 'JOB_READBACK_MISSING',
  SCAN_JUDGE_IN_FLIGHT: 'SCAN_JUDGE_IN_FLIGHT',
  MCP_UNAVAILABLE: 'MCP_UNAVAILABLE',
  PI_START_FAILED: 'PI_START_FAILED',
  LIBRARY_ORGANIZE_FAILED: 'LIBRARY_ORGANIZE_FAILED',
  // WMB-5137：无 code 异常的按角色域错误码（§9.2 稳定码表）。runner catch 不再把全角色
  // 兜底到 LIBRARY_ORGANIZE_FAILED——reporter/planner/writer 各有本角色域语义码。
  REPORTER_SCAN_FAILED: 'REPORTER_SCAN_FAILED',
  PLANNER_JUDGE_FAILED: 'PLANNER_JUDGE_FAILED',
  WRITER_DRAFT_FAILED: 'WRITER_DRAFT_FAILED'
} as const);

/** §5.2 派生表：roleId → intent（唯一真相源）。 */
export const ROLE_TO_INTENT: Readonly<Record<EmployeeRole, AgentIntent>> = Object.freeze({
  reporter: 'daily_scan',
  planner: 'daily_judge',
  writer: 'studio_draft',
  librarian: 'page_library'
});

const ROLE_TO_POLICY: Readonly<Record<EmployeeRole, RoleJobPolicy>> = Object.freeze({
  reporter: 'scan',
  planner: 'judge',
  writer: 'draft',
  librarian: 'organize'
});

/**
 * WMB-5137：无 code 异常的角色域兜底错误码（§9.2 稳定码表）。
 * 只按角色域借用本表；`LIBRARY_ORGANIZE_FAILED` 仅限 librarian（organize 域）。
 */
const ROLE_TO_FAILURE_CODE: Readonly<Record<EmployeeRole, string>> = Object.freeze({
  reporter: JOB_ERROR_CODES.REPORTER_SCAN_FAILED,
  planner: JOB_ERROR_CODES.PLANNER_JUDGE_FAILED,
  writer: JOB_ERROR_CODES.WRITER_DRAFT_FAILED,
  librarian: JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED
});

const ROLE_TO_READBACK: Readonly<Record<EmployeeRole, RoleJobReadbackKind>> = Object.freeze({
  reporter: 'scan_phase',
  planner: 'plans_revision',
  writer: 'content_version',
  librarian: 'library_mutation'
});

export function deriveIntentForRole(roleId: EmployeeRole): AgentIntent {
  return ROLE_TO_INTENT[roleId];
}

export function roleToPolicy(roleId: EmployeeRole): RoleJobPolicy {
  return ROLE_TO_POLICY[roleId];
}

/** WMB-5137：无 code 异常的角色域兜底错误码（runner catch 使用；跨域借用被类型化表排除）。 */
export function roleFailureCode(roleId: EmployeeRole): string {
  return ROLE_TO_FAILURE_CODE[roleId];
}

export function roleToReadbackKind(roleId: EmployeeRole): RoleJobReadbackKind {
  return ROLE_TO_READBACK[roleId];
}

/**
 * §8.1 资源锁矩阵（合同 §3 锁键固定）：
 * reporter=`scan:<workspaceId>:<businessDate>:<channel>`（无 channel 时 `all`，多 channel 按批合并）
 * planner=`plan:<workspaceId>:<businessDate>`
 * writer=`project:<workspaceId>:<projectId>`
 * librarian=`library-maintenance:<workspaceId>`
 */
export function deriveResourceLocks(input: {
  roleId: EmployeeRole;
  workspaceId: string;
  businessDate: string;
  projectId?: string | null;
  channelIds?: readonly string[] | null;
}): readonly string[] {
  const ws = input.workspaceId;
  if (input.roleId === 'reporter') {
    const channels = Array.isArray(input.channelIds) && input.channelIds.length
      ? [...input.channelIds].sort().join('+')
      : 'all';
    return Object.freeze([`scan:${ws}:${input.businessDate}:${channels}`]);
  }
  if (input.roleId === 'planner') return Object.freeze([`plan:${ws}:${input.businessDate}`]);
  if (input.roleId === 'writer') return Object.freeze([`project:${ws}:${input.projectId ?? ''}`]);
  return Object.freeze([`library-maintenance:${ws}`]);
}

const ROLE_ALLOWED_KEYS: Readonly<Record<EmployeeRole, readonly string[]>> = Object.freeze({
  reporter: Object.freeze(['roleId', 'brief', 'businessDate', 'channelIds', 'sourceFeedIds']),
  planner: Object.freeze(['roleId', 'brief', 'businessDate']),
  writer: Object.freeze(['roleId', 'brief', 'projectId', 'businessDate']),
  librarian: Object.freeze(['roleId', 'brief', 'sourceIds', 'scope'])
});

export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return value === 'reporter' || value === 'planner' || value === 'writer' || value === 'librarian';
}

function validationError(message: string): Error {
  return Object.assign(new Error(message), { code: JOB_ERROR_CODES.VALIDATION_ERROR });
}

function optionalStringArray(value: unknown, label: string): readonly string[] | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !String(item).trim())) {
    throw validationError(`${label} 必须是字符串数组或 null。`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * 运行时 strict-key 校验（合同 §1）：roleId 判别 + 公共 brief；**任何 `intent` 输入必须
 * VALIDATION_ERROR 拒绝**（类型面删除不足以挡 JS 调用方）；未知键同样拒绝；writer 缺
 * projectId 抛 JOB_PROJECT_REQUIRED；desk/未知角色抛 ROLE_NOT_SPAWNABLE。
 */
export function parseRoleJobRequest(input: unknown): RoleJobRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('工单必须是对象。');
  }
  const record = input as Record<string, unknown>;
  if ('intent' in record) {
    throw validationError('外部 intent 已移除：intent 由角色注册表按 roleId 唯一派生。');
  }
  if ('planDate' in record) {
    throw validationError('planDate 已移除：请使用 businessDate。');
  }
  const roleId = record.roleId;
  if (!isEmployeeRole(roleId)) {
    throw Object.assign(new Error('ROLE_NOT_SPAWNABLE: 只能向员工角色派单（记者/策划/写手/资料员）。'), {
      code: JOB_ERROR_CODES.ROLE_NOT_SPAWNABLE
    });
  }
  const allowed = ROLE_ALLOWED_KEYS[roleId];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw validationError(`未知字段 ${key}（角色 ${roleId} 只接受 ${allowed.join('/')}）。`);
  }
  const brief = typeof record.brief === 'string' ? String(record.brief).trim() : '';
  if (!brief) throw Object.assign(new Error('工单 brief 不能为空。'), { code: JOB_ERROR_CODES.JOB_BRIEF_REQUIRED });
  const businessDate = record.businessDate === undefined || record.businessDate === null || record.businessDate === ''
    ? null
    : typeof record.businessDate === 'string' ? record.businessDate : (() => { throw validationError('businessDate 必须是 YYYY-MM-DD 字符串或 null。'); })();

  if (roleId === 'writer') {
    const projectId = typeof record.projectId === 'string' ? String(record.projectId).trim() : '';
    if (!projectId) {
      throw Object.assign(new Error('JOB_PROJECT_REQUIRED: 派写手必须带 projectId（创作项目）。'), {
        code: JOB_ERROR_CODES.JOB_PROJECT_REQUIRED
      });
    }
    return Object.freeze({ roleId, brief, projectId, businessDate });
  }
  if (roleId === 'reporter') {
    return Object.freeze({
      roleId,
      brief,
      businessDate,
      channelIds: optionalStringArray(record.channelIds, 'channelIds'),
      sourceFeedIds: optionalStringArray(record.sourceFeedIds, 'sourceFeedIds')
    });
  }
  if (roleId === 'librarian') {
    const scope = record.scope === undefined || record.scope === null ? null : record.scope;
    if (scope !== null && scope !== 'workspace') throw validationError('scope 只允许 "workspace" 或 null。');
    return Object.freeze({
      roleId,
      brief,
      sourceIds: optionalStringArray(record.sourceIds, 'sourceIds'),
      scope
    });
  }
  return Object.freeze({ roleId, brief, businessDate });
}

/** spawn 期派生（§5.2）：intent 派生后不可再被调用方改写；businessDate 缺省今日。 */
export function deriveRoleJobSpec(request: RoleJobRequest, workspaceId: string): RoleJobSpec {
  const roleId = request.roleId;
  // librarian 联合成员无 businessDate（合同 §5.1）：缺省今日，仅作任务上下文。
  const businessDate = (roleId === 'librarian' ? null : request.businessDate) ?? shanghaiDate();
  const projectId = roleId === 'writer' ? request.projectId : null;
  const boundary = buildJobObjectBoundary(request, businessDate);
  return Object.freeze({
    roleId,
    intent: ROLE_TO_INTENT[roleId],
    businessDate,
    projectId,
    sourceIds: boundary.sourceIds,
    scope: boundary.scope,
    resourceLocks: deriveResourceLocks({
      roleId,
      workspaceId,
      businessDate,
      projectId,
      channelIds: roleId === 'reporter' ? request.channelIds : null
    }),
    policy: ROLE_TO_POLICY[roleId],
    readback: ROLE_TO_READBACK[roleId]
  });
}

/** 标准化 sourceIds：trim、去重、字典序（WMB-5141 合同 §Scope.1）。 */
export function normalizeSourceIds(ids: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const value = id.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  result.sort();
  return Object.freeze(result);
}

const EMPTY_SOURCE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_BOUNDARY: JobObjectBoundary = Object.freeze({ businessDate: null, projectId: null, sourceIds: EMPTY_SOURCE_IDS, scope: null });

/**
 * WMB-5141：从 spawn 请求派生工单对象边界。
 * reporter 边界 = businessDate + channelIds（锁键 scan:<ws>:<date>:<channel> 的对象面）；
 * planner = businessDate；writer = projectId；librarian = sourceIds/scope
 * （无 sourceIds 且未显式限定 scope → 整个工作空间资料库，即锁键 library-maintenance:<ws>）。
 */
export function buildJobObjectBoundary(request: RoleJobRequest, businessDate?: string | null): JobObjectBoundary {
  const date = businessDate ?? null;
  if (request.roleId === 'reporter') {
    return Object.freeze({ businessDate: date, projectId: null, sourceIds: normalizeSourceIds(request.channelIds ?? []), scope: null });
  }
  if (request.roleId === 'planner') {
    return Object.freeze({ businessDate: date, projectId: null, sourceIds: EMPTY_SOURCE_IDS, scope: null });
  }
  if (request.roleId === 'writer') {
    return Object.freeze({ businessDate: date, projectId: request.projectId ?? null, sourceIds: EMPTY_SOURCE_IDS, scope: null });
  }
  const sourceIds = normalizeSourceIds(request.sourceIds ?? []);
  return Object.freeze({
    businessDate: date,
    projectId: null,
    sourceIds,
    scope: request.scope === 'workspace' ? 'workspace' : sourceIds.length ? null : 'workspace'
  });
}

/**
 * WMB-5141 持久续派合同 refs：jobId/roleId/brief + 边界参数（businessDate/projectId/sourceIds/scope）。
 * reporter 的 sourceFeedIds 单独保留（重建原 RoleJobRequest 需要）。
 */
export function buildJobContextRefs(input: { jobId: string; request: RoleJobRequest; boundary: JobObjectBoundary }): Record<string, unknown> {
  const refs: Record<string, unknown> = {
    jobId: input.jobId,
    roleId: input.request.roleId,
    brief: input.request.brief
  };
  if (input.boundary.businessDate) refs.businessDate = input.boundary.businessDate;
  if (input.boundary.projectId) refs.projectId = input.boundary.projectId;
  if (input.boundary.sourceIds.length) refs.sourceIds = [...input.boundary.sourceIds];
  if (input.boundary.scope) refs.scope = input.boundary.scope;
  if (input.request.roleId === 'reporter' && Array.isArray(input.request.sourceFeedIds) && input.request.sourceFeedIds.length) {
    refs.sourceFeedIds = [...normalizeSourceIds(input.request.sourceFeedIds)];
  }
  return refs;
}

/** WMB-5141：从 context_refs 读回持久续派合同（无 jobId = 无 spawn 合同，返回 null）。 */
export function readJobContractFromRefs(refs: Record<string, unknown>): JobContract | null {
  const jobId = refs.jobId;
  if (typeof jobId !== 'string' || !jobId.trim()) return null;
  return Object.freeze({
    jobId,
    roleId: typeof refs.roleId === 'string' ? refs.roleId : '',
    brief: typeof refs.brief === 'string' ? refs.brief : '',
    boundary: Object.freeze({
      businessDate: typeof refs.businessDate === 'string' && refs.businessDate ? refs.businessDate : null,
      projectId: typeof refs.projectId === 'string' && refs.projectId ? refs.projectId : null,
      sourceIds: normalizeSourceIds(Array.isArray(refs.sourceIds) ? refs.sourceIds : []),
      scope: refs.scope === 'workspace' ? 'workspace' : null
    })
  });
}

/** WMB-5141：按 taskId 读持久续派合同（agent_tasks.context_refs_json 单列读）。 */
export function readJobContract(database: DatabaseSync, taskId: string): JobContract | null {
  const row = database.prepare('SELECT context_refs_json AS refsJson FROM agent_tasks WHERE id=?').get(taskId) as { refsJson?: string } | undefined;
  if (!row || typeof row.refsJson !== 'string') return null;
  return readJobContractFromRefs(JSON.parse(row.refsJson) as Record<string, unknown>);
}

/**
 * WMB-5141 一键续派：从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）。
 * 字段缺失（如 writer 无 projectId）返回 null——续派方须重新提供输入。
 */
export function rebuildRoleJobRequest(refs: Record<string, unknown>): RoleJobRequest | null {
  const contract = readJobContractFromRefs(refs);
  if (!contract || !isEmployeeRole(contract.roleId) || !contract.brief) return null;
  const brief = contract.brief;
  const businessDate = contract.boundary.businessDate;
  if (contract.roleId === 'writer') {
    if (!contract.boundary.projectId) return null;
    return Object.freeze({ roleId: 'writer', brief, projectId: contract.boundary.projectId, businessDate });
  }
  if (contract.roleId === 'reporter') {
    const sourceFeedIds = Array.isArray(refs.sourceFeedIds)
      ? refs.sourceFeedIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : [];
    return Object.freeze({
      roleId: 'reporter',
      brief,
      businessDate,
      channelIds: contract.boundary.sourceIds.length ? [...contract.boundary.sourceIds] : null,
      sourceFeedIds: sourceFeedIds.length ? [...sourceFeedIds] : null
    });
  }
  if (contract.roleId === 'librarian') {
    return Object.freeze({
      roleId: 'librarian',
      brief,
      sourceIds: contract.boundary.sourceIds.length ? [...contract.boundary.sourceIds] : null,
      scope: contract.boundary.scope
    });
  }
  return Object.freeze({ roleId: 'planner', brief, businessDate });
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceIdsFromRows(rows: unknown, key: string): readonly string[] {
  if (!Array.isArray(rows)) return EMPTY_SOURCE_IDS;
  return normalizeSourceIds(rows.map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : null)));
}

/** 命令 → 对象边界提取器（WMB-5141 §12.2.7）：只登记可兑现边界语义的命令，其余不约束。 */
const COMMAND_BOUNDARY_EXTRACTORS: Readonly<Record<string, (input: Record<string, unknown>) => JobObjectBoundary>> = Object.freeze({
  'plans.save': (input) => Object.freeze({ businessDate: stringField(input, 'planDate'), projectId: null, sourceIds: EMPTY_SOURCE_IDS, scope: null }),
  'content.save_version': (input) => Object.freeze({ businessDate: null, projectId: stringField(input, 'projectId'), sourceIds: EMPTY_SOURCE_IDS, scope: null }),
  'content.create': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceIdsFromRows(input.sourceIds, 'sourceId'), scope: null }),
  'knowledge.record_batch': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceIdsFromRows(input.items, 'sourceId'), scope: null }),
  'sources.lane_gate': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceIdsFromRows(input.judgments, 'sourceId'), scope: null }),
  'sources.lane_restore': (input) => {
    const sourceId = stringField(input, 'sourceId');
    return Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceId ? normalizeSourceIds([sourceId]) : EMPTY_SOURCE_IDS, scope: null });
  },
  'sources.update_status': (input) => {
    const id = stringField(input, 'id');
    return Object.freeze({ businessDate: null, projectId: null, sourceIds: id ? normalizeSourceIds([id]) : EMPTY_SOURCE_IDS, scope: null });
  }
});

/** WMB-5141：解析命令输入携带的对象边界（未登记的命令 → 空边界，不约束）。 */
export function resolveCommandObjectBoundary(command: string, input: unknown): JobObjectBoundary {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const extract = COMMAND_BOUNDARY_EXTRACTORS[command];
  return extract ? extract(record) : EMPTY_BOUNDARY;
}

/**
 * WMB-5141：从相关上下文（grant issue 的 relevantContext）读取对象边界主张。
 * 显式 jobBoundary 对象（自动授权 = 任务自身边界）优先；否则回落顶层业务键
 * （手动授权声明的 projectId/sourceIds/scope/businessDate 简写）。
 */
export function boundaryClaimFromContext(context: Readonly<Record<string, unknown>>): JobObjectBoundary {
  const embedded = context.jobBoundary;
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    const record = embedded as Record<string, unknown>;
    return Object.freeze({
      businessDate: stringField(record, 'businessDate'),
      projectId: stringField(record, 'projectId'),
      sourceIds: normalizeSourceIds(Array.isArray(record.sourceIds) ? record.sourceIds : []),
      scope: record.scope === 'workspace' ? 'workspace' : null
    });
  }
  return Object.freeze({
    businessDate: stringField(context, 'businessDate'),
    projectId: stringField(context, 'projectId'),
    sourceIds: normalizeSourceIds(Array.isArray(context.sourceIds) ? context.sourceIds : []),
    scope: context.scope === 'workspace' ? 'workspace' : null
  });
}

/** 边界主张是否携带任一维度（全空 = 未主张，不做覆盖校验）。 */
export function hasBoundaryClaim(boundary: JobObjectBoundary): boolean {
  return boundary.businessDate !== null || boundary.projectId !== null || boundary.sourceIds.length > 0 || boundary.scope !== null;
}

export const OBJECT_SCOPE_MISMATCH = 'OBJECT_SCOPE_MISMATCH';

/**
 * 各角色边界合同的强制维度（§8.1 锁键语义）：只有属于该角色对象键的维度才参与
 * 对象级硬隔离——planner 的 knowledge.record_batch 携带 sourceIds，但 planner 对象是
 * businessDate，source 维度不属于其合同，不得拦截合法同界写。
 */
const ROLE_BOUNDARY_DIMENSIONS: Readonly<Record<EmployeeRole, readonly ('businessDate' | 'projectId' | 'sourceIds' | 'scope')[]>> = Object.freeze({
  reporter: Object.freeze(['businessDate', 'sourceIds']),
  planner: Object.freeze(['businessDate']),
  writer: Object.freeze(['businessDate', 'projectId']),
  librarian: Object.freeze(['sourceIds', 'scope'])
});

/** WMB-5141：把命令主张掩码到角色合同维度（非角色维度视为未主张，不做覆盖校验）。 */
export function maskBoundaryToRole(boundary: JobObjectBoundary, roleId: EmployeeRole): JobObjectBoundary {
  const dims = ROLE_BOUNDARY_DIMENSIONS[roleId];
  return Object.freeze({
    businessDate: dims.includes('businessDate') ? boundary.businessDate : null,
    projectId: dims.includes('projectId') ? boundary.projectId : null,
    sourceIds: dims.includes('sourceIds') ? boundary.sourceIds : EMPTY_SOURCE_IDS,
    scope: dims.includes('scope') ? boundary.scope : null
  });
}

function boundaryMismatch(dimension: string, expected: unknown, got: unknown): CommandDispatchError {
  return new CommandDispatchError(
    'TASK_SCOPE_BROADENED',
    `${OBJECT_SCOPE_MISMATCH}: 命令对象超出工单边界（${dimension}）。`,
    { reason: OBJECT_SCOPE_MISMATCH, dimension, expected, got }
  );
}

/**
 * WMB-5141 纯对象边界校验器（§12.2.7，签发与执行两处硬门复用）：
 * 命令主张的每一非空维度必须被任务边界覆盖，缺失或越界 fail closed（TASK_SCOPE_BROADENED + OBJECT_SCOPE_MISMATCH）。
 */
export function assertBoundaryCovers(task: JobObjectBoundary, claim: JobObjectBoundary): void {
  if (claim.businessDate !== null) {
    if (task.businessDate === null) throw boundaryMismatch('businessDate', null, claim.businessDate);
    if (task.businessDate !== claim.businessDate) throw boundaryMismatch('businessDate', task.businessDate, claim.businessDate);
  }
  if (claim.projectId !== null) {
    if (task.projectId === null) throw boundaryMismatch('projectId', null, claim.projectId);
    if (task.projectId !== claim.projectId) throw boundaryMismatch('projectId', task.projectId, claim.projectId);
  }
  if (claim.sourceIds.length > 0) {
    if (task.scope !== 'workspace') {
      if (task.sourceIds.length === 0) throw boundaryMismatch('sourceIds', [], claim.sourceIds);
      for (const id of claim.sourceIds) {
        if (!task.sourceIds.includes(id)) throw boundaryMismatch('sourceIds', task.sourceIds, claim.sourceIds);
      }
    }
  }
  if (claim.scope !== null) {
    if (task.scope !== claim.scope) throw boundaryMismatch('scope', task.scope, claim.scope);
  }
}

/** WMB-5141 签发期完整性：spawn 合同角色的关键边界维度缺失 → fail closed。 */
export function assertJobBoundaryComplete(boundary: JobObjectBoundary, roleId: EmployeeRole): void {
  if (roleId === 'writer' && boundary.projectId === null) throw boundaryMismatch('projectId', null, 'missing');
  if ((roleId === 'reporter' || roleId === 'planner') && boundary.businessDate === null) throw boundaryMismatch('businessDate', null, 'missing');
  if (roleId === 'librarian' && boundary.scope !== 'workspace' && boundary.sourceIds.length === 0) throw boundaryMismatch('scope', 'workspace', 'missing');
}

/**
 * §5.3 终态唯一映射：同一 outcome（+ 取消信号）产出 pool 与 agent_task 终态，不可分叉。
 * 取消信号（signal.aborted）恒优先于一切 outcome 判定。
 */
export function mapOutcomeToTerminal(outcome: JobExecutionOutcome, aborted: boolean): {
  pool: JobTerminalStatus;
  agentTask: AgentTaskStatus;
  code: string;
} {
  if (aborted) return { pool: 'cancelled', agentTask: 'cancelled', code: JOB_ERROR_CODES.JOB_CANCELLED };
  switch (outcome.status) {
    case 'succeeded':
      return { pool: 'succeeded', agentTask: 'succeeded', code: outcome.code };
    case 'partial':
      return { pool: 'partial', agentTask: 'partial', code: outcome.code };
    case 'needs_user':
      return { pool: 'needs_user', agentTask: 'needs_user', code: outcome.code };
    case 'cancelled':
      return { pool: 'cancelled', agentTask: 'cancelled', code: outcome.code };
    case 'deferred':
      // §5.3 不变量：deferred 是瞬时 outcome，绝不允许进入终态映射（5118 在 runJob 前置拦截
      // 泊车；此处运行期兜底抛错，避免静默落 failed / 污染 agent_task 终态）。
      throw Object.assign(new Error('JOB_DEFERRED_NOT_MAPPABLE: deferred 是瞬时 outcome，不得映射终态。'), {
        code: 'JOB_DEFERRED_NOT_MAPPABLE'
      });
    default:
      return { pool: 'failed', agentTask: 'failed', code: outcome.code };
  }
}

export function buildRoleJobReport(input: {
  jobId: string;
  roleId: EmployeeRole;
  intent: AgentIntent;
  status: JobTerminalStatus;
  code: string;
  businessDate: string;
  projectId: string | null;
  taskId: string | null;
  phase: string | null;
  readback: RoleJobReadbackV1 | null;
  startedAt: string | null;
  finishedAt: string;
  errorMessage: string | null;
}): RoleJobReportV1 {
  return Object.freeze({
    jobId: input.jobId,
    roleId: input.roleId,
    intent: input.intent,
    status: input.status,
    code: input.code,
    businessDate: input.businessDate,
    projectId: input.projectId,
    taskId: input.taskId,
    phase: input.phase,
    readback: input.readback,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    errorMessage: input.errorMessage
  });
}

/**
 * §5.2 半 2：按「返回瞬间」的任务状态派生不可变扫描读回快照（与 readbackScanPhase 同条件）。
 * 快照一次性捕获并 Object.freeze——judge 后续 rebind 推进 phase 也无法改写；
 * runner 对 scan 读回优先快照（`run.readback ?? readbackScanPhase`），缺快照才回落重读。
 */
export function snapshotScanReadback(task: Pick<AgentTask, 'status' | 'phase'>): RoleJobReadbackV1 | null {
  if (task.phase === 'channel_scanned') return Object.freeze({ kind: 'scan_phase_reached', phase: task.phase });
  // 零增量成功收尾：workspace-intelligence 以 succeeded+completed 落终态（评审 MAJOR 1）——
  // 只认 channel_scanned 会把真实成功判成 JOB_READBACK_MISSING（pool failed / agent_task succeeded 分叉）。
  if (task.status === 'succeeded' && task.phase === 'completed') return Object.freeze({ kind: 'scan_phase_reached', phase: task.phase });
  return null;
}

/** §7 reporter 读回（兜底重读）：任务 phase 到达 `channel_scanned`（扫描边界完成，不要求非零增量）。 */
export function readbackScanPhase(database: DatabaseSync, taskId: string): RoleJobReadbackV1 | null {
  const task = getAgentTask(database, taskId);
  if (!task) return null;
  return snapshotScanReadback(task);
}

/** §7 planner 读回：当日 is_current plan 存在（空 items 也成行）→ plans_revision；否则 plans.save 收据 → noop_confirmed。 */
export function readbackPlansRevision(database: DatabaseSync, businessDate: string, taskId: string): RoleJobReadbackV1 | null {
  const plan = database.prepare('SELECT revision FROM plans WHERE plan_date = ? AND is_current = 1').get(businessDate) as { revision: number } | undefined;
  if (plan) return { kind: 'plans_revision', planDate: businessDate, revision: plan.revision };
  const receipt = database.prepare(`SELECT 1 AS ok FROM command_receipts WHERE command='plans.save' AND task_id=? AND status='ok' LIMIT 1`).get(taskId)
    ?? database.prepare(`SELECT 1 AS ok FROM mcp_request_results WHERE tool='plans.save' AND request_id LIKE ? LIMIT 1`).get(`${taskId}:%`);
  if (receipt) return { kind: 'noop_confirmed', scope: `plan:${businessDate}` };
  return null;
}

/** §7 writer 读回：projectId 对应项目存在且已有核心版本（保存态）。 */
export function readbackContentVersion(database: DatabaseSync, projectId: string): RoleJobReadbackV1 | null {
  const project = getContentProject(database, projectId);
  if (!project || !project.latestVersion) return null;
  return { kind: 'content_version', projectId, versionId: project.latestVersion.id };
}

/** 会话 JSONL 最后一条 assistant 文本（评审 MINOR 4：no-op 必须 agent 明确声明，防假成功）。 */
function lastAssistantText(raw: string): string | null {
  let last: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
      for (const segment of entry.message.content) {
        if (segment && typeof segment === 'object' && (segment as { type?: unknown }).type === 'text') {
          const text = (segment as { text?: unknown }).text;
          if (typeof text === 'string' && text.trim()) last = text;
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }
  return last;
}

/**
 * WMB-5121 结构化 no-op 声明（§8.2）：严格 `{"wmb_noop": true}`（z.literal(true) 校验），
 * 允许附加键（如 scope）；`wmb_noop:false`、键错、JSON 非法一律拒绝（保守失败）。
 */
const noopDeclarationSchema = z.object({
  wmb_noop: z.literal(true)
});

/**
 * 解析末条 assistant 文本的**最后一个** ```json 围栏块（与 parseDailyPlanOutput 同惯例）。
 * 无围栏 / JSON 非法 / `wmb_noop` 非 true / 键错 / 声明不在末条（围栏在更早块）→ false，
 * 由调用方落 JOB_READBACK_MISSING（保守失败，绝不放宽为假成功）。
 */
export function parseNoopDeclaration(lastText: string): boolean {
  const fences = [...lastText.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) return false;
  const last = fences[fences.length - 1][1];
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return false;
  }
  return noopDeclarationSchema.safeParse(value).success;
}

/**
 * §7 librarian 读回：本任务 page_library 写命令成功收据 ≥1 → sources_mutated
 * （mutation 永远优先，围栏被忽略——agent 又写又声明 noop 时 mutation 赢）；
 * 零收据时仅认末条 assistant **最后一个 ```json 围栏块**声明 `{"wmb_noop":true}` → noop_confirmed；
 * 无围栏/围栏非法/静默完成 → null（由 runner 落 JOB_READBACK_MISSING，不得假成功）。
 * `finalText` 为策略捕获的内存末条文本（免读文件）；未捕获时才读会话文件兜底。
 */
export async function readbackLibraryMutation(
  database: DatabaseSync,
  taskId: string,
  sinceIso: string,
  sessionFile: string,
  finalText?: string | null
): Promise<RoleJobReadbackV1 | null> {
  const scope = AUTOMATIC_TASK_GRANT_SCOPES.page_library;
  const commands = scope.filter((command) => command !== 'agent_tasks.report_progress');
  const placeholders = commands.map(() => '?').join(',');
  const row = database.prepare(
    `SELECT COUNT(*) AS count FROM command_receipts
      WHERE task_id = ? AND status = 'ok' AND created_at >= ? AND command IN (${placeholders})`
  ).get(taskId, sinceIso, ...commands) as { count: number };
  const count = Number(row?.count ?? 0);
  if (count >= 1) return { kind: 'sources_mutated', count };
  // 零收据：优先内存 finalText（免读文件）；未捕获（null/undefined）才读会话文件末条 assistant 文本兜底。
  let last = finalText ?? null;
  if (last === null) {
    try {
      last = lastAssistantText(await readFile(sessionFile, 'utf8'));
    } catch {
      return null; // 会话文件缺失/不可读 → 无证据，不得 noop_confirmed
    }
  }
  if (last && parseNoopDeclaration(last)) return { kind: 'noop_confirmed', scope: 'workspace' };
  return null;
}
