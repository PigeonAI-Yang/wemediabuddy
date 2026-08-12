import type { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import * as z from 'zod';
import type { AgentIntent, AgentTask, AgentTaskStatus } from './agent-tasks.ts';
import { getAgentTask } from './agent-tasks.ts';
import { getContentProject } from './content.ts';
import type { EmployeeRole } from './job-pool.ts';
import { shanghaiDate } from './ferment.ts';
import { AUTOMATIC_TASK_GRANT_SCOPES } from './task-grants.ts';
import { readLatestTopicMaintenanceProposalForTask, type TopicMaintenanceProposal } from './topic-maintenance.ts';
// WMB-5141 持久边界与纯对象边界校验器（§12.2.7，签发/执行两门复用）；本模块保持既有导出面。
export {
  OBJECT_SCOPE_MISMATCH,
  assertBoundaryCovers,
  assertJobBoundaryComplete,
  boundaryClaimFromContext,
  buildJobContextRefs,
  buildJobObjectBoundary,
  hasBoundaryClaim,
  isEmployeeRole,
  maskBoundaryToRole,
  normalizeSourceIds,
  readJobContract,
  readJobContractFromRefs,
  rebuildRoleJobRequest,
  resolveCommandObjectBoundary,
  type JobContract,
  type JobObjectBoundary
} from './job-object-boundary.ts';
import { buildJobObjectBoundary, isEmployeeRole } from './job-object-boundary.ts';
/**
 * WMB-5116 角色工单注册表（唯一真相源）。
 *
 * - `RoleJobRequest`：外部 spawn 输入，按 roleId 判别的联合，**不含 intent / planDate**；
 *   intent 只能由本注册表派生（§5.2 派生表）。
 * - `deriveRoleJobSpec`：spawn 期一次性派生 intent / 业务日期 / 专属锁键 / 策略 / 读回规则。
 * - `mapOutcomeToTerminal`：pool 与 agent_task 五终态的唯一映射（§5.3，取消优先）。
 * - 读回规则（§7）：四角色各自的可证伪业务读回；无读回不得 succeeded。
 */

/**
 * WMB-5170 §5.2 ResearchGap（研究缺口合同，值对象）。
 * parentRoleId ∈ {writer, planner, librarian}——禁止 reporter/research 作父（§8.2 硬止环派生层）。
 * budget = 深度档（本次唯一档位）：12 分钟 / 15 有效来源 / 40 候选 / 3 并行抓取 / 仅一轮。
 */
export type ResearchClaimType = 'fact' | 'price' | 'policy';
export type ResearchRequiredClaim = Readonly<{
  key: string;
  text: string;
  type: ResearchClaimType;
}>;
export type ResearchBudget = Readonly<{
  timeMinutes: number;
  minValidSources: number;
  maxCandidates: number;
  maxParallelFetches: number;
  maxRounds: number;
}>;
export type ResearchGap = Readonly<{
  gapId: string;
  parentJobId: string;
  parentTaskId: string;
  parentRoleId: 'writer' | 'planner' | 'librarian';
  requiredClaims: readonly ResearchRequiredClaim[];
  budget: ResearchBudget;
  channels: readonly ('web' | 'x' | 'xhs')[];
}>;

export type WriterTask = 'core_draft' | 'xiaohongshu_platform_version';

export type RoleJobRequest =
  | Readonly<{ roleId: 'reporter'; brief: string; businessDate?: string | null; channelIds?: readonly string[] | null; sourceFeedIds?: readonly string[] | null }>
  | Readonly<{ roleId: 'planner'; brief: string; businessDate?: string | null }>
  | Readonly<{ roleId: 'writer'; brief: string; projectId: string; writerTask: WriterTask; businessDate?: string | null }>
  | Readonly<{ roleId: 'librarian'; brief: string; sourceIds?: readonly string[] | null; scope?: 'workspace' | null }>
  | Readonly<{ roleId: 'reporter'; brief: string; businessDate?: string | null; projectId?: string | null; channelIds?: readonly string[] | null; sourceFeedIds?: readonly string[] | null; research: ResearchGap }>;

export type RoleJobPolicy = 'scan' | 'judge' | 'draft' | 'organize' | 'research';
export type RoleJobReadbackKind = 'scan_phase' | 'plans_revision' | 'content_version' | 'xiaohongshu_platform_version' | 'library_mutation' | 'research_evidence';
export type RoleJobSpec = Readonly<{
  roleId: EmployeeRole;
  intent: AgentIntent;
  businessDate: string;
  projectId: string | null;
  writerTask: WriterTask | null;
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
 * 类型与校验器见 ./job-object-boundary.ts（本模块顶部统一 re-export）。
 */
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
  | { kind: 'xiaohongshu_platform_version'; projectId: string; versionId: string; contentVersionId: string }
  | { kind: 'sources_mutated'; count: number }
  | { kind: 'topic_maintenance_proposed'; proposal: TopicMaintenanceProposal }
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
  REPORTER_SCAN_FAILED: 'REPORTER_SCAN_FAILED',
  PLANNER_JUDGE_FAILED: 'PLANNER_JUDGE_FAILED',
  WRITER_DRAFT_FAILED: 'WRITER_DRAFT_FAILED',
  RESEARCH_FAILED: 'RESEARCH_FAILED'
} as const);

/** §5.2 派生表：roleId → intent（唯一真相源）。 */
export const ROLE_TO_INTENT: Readonly<Record<EmployeeRole, AgentIntent>> = Object.freeze({
  reporter: 'daily_scan',
  planner: 'daily_judge',
  writer: 'studio_draft',
  librarian: 'page_library'
});

const ROLE_TO_POLICY: Readonly<Record<EmployeeRole | 'research', RoleJobPolicy>> = Object.freeze({
  reporter: 'scan',
  planner: 'judge',
  writer: 'draft',
  librarian: 'organize',
  research: 'research'
});

const ROLE_TO_FAILURE_CODE: Readonly<Record<EmployeeRole | 'research', string>> = Object.freeze({
  reporter: JOB_ERROR_CODES.REPORTER_SCAN_FAILED,
  planner: JOB_ERROR_CODES.PLANNER_JUDGE_FAILED,
  writer: JOB_ERROR_CODES.WRITER_DRAFT_FAILED,
  librarian: JOB_ERROR_CODES.LIBRARY_ORGANIZE_FAILED,
  research: JOB_ERROR_CODES.RESEARCH_FAILED
});

const ROLE_TO_READBACK: Readonly<Record<EmployeeRole | 'research', RoleJobReadbackKind>> = Object.freeze({
  reporter: 'scan_phase',
  planner: 'plans_revision',
  writer: 'content_version',
  librarian: 'library_mutation',
  research: 'research_evidence'
});

export function deriveIntentForRole(roleId: EmployeeRole): AgentIntent {
  return ROLE_TO_INTENT[roleId];
}

export function roleToPolicy(roleId: EmployeeRole): RoleJobPolicy {
  return ROLE_TO_POLICY[roleId];
}

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
  writer: Object.freeze(['roleId', 'brief', 'projectId', 'writerTask', 'businessDate']),
  librarian: Object.freeze(['roleId', 'brief', 'sourceIds', 'scope'])
});

/** WMB-5170 research 变体（roleId='reporter' + research 块）：不接收 reporter 渠道键（research.channels 自持读面）。 */
const RESEARCH_ALLOWED_KEYS = Object.freeze(['roleId', 'brief', 'businessDate', 'projectId', 'research'] as const);

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
 * WMB-5170 §5.2/§8.2：research 块 strict-key 校验（fail-closed）。
 * parentRoleId ∈ {writer, planner, librarian}——reporter/research 作父一律 VALIDATION_ERROR（硬止环派生层）。
 */
function parseResearchGap(value: unknown): ResearchGap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('research 必须是对象。');
  }
  const record = value as Record<string, unknown>;
  const allowed = ['gapId', 'parentJobId', 'parentTaskId', 'parentRoleId', 'requiredClaims', 'budget', 'channels'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw validationError(`research 未知字段 ${key}（只接受 ${allowed.join('/')}）。`);
  }
  const gapId = typeof record.gapId === 'string' ? record.gapId.trim() : '';
  if (!gapId) throw validationError('research.gapId 不能为空。');
  const parentJobId = typeof record.parentJobId === 'string' ? record.parentJobId.trim() : '';
  if (!parentJobId) throw validationError('research.parentJobId 不能为空。');
  const parentTaskId = typeof record.parentTaskId === 'string' ? record.parentTaskId.trim() : '';
  if (!parentTaskId) throw validationError('research.parentTaskId 不能为空。');
  if (record.parentRoleId !== 'writer' && record.parentRoleId !== 'planner' && record.parentRoleId !== 'librarian') {
    throw validationError('research.parentRoleId 只允许 writer/planner/librarian（禁止 reporter/research 作父）。');
  }
  if (!Array.isArray(record.requiredClaims) || record.requiredClaims.length === 0) {
    throw validationError('research.requiredClaims 必须是非空数组。');
  }
  const requiredClaims = record.requiredClaims.map((claim, index) => {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      throw validationError(`research.requiredClaims[${index}] 必须是对象。`);
    }
    const c = claim as Record<string, unknown>;
    const key = typeof c.key === 'string' ? c.key.trim() : '';
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!key || !text) throw validationError(`research.requiredClaims[${index}] 需要非空 key 与 text。`);
    if (c.type !== 'fact' && c.type !== 'price' && c.type !== 'policy') {
      throw validationError(`research.requiredClaims[${index}].type 只允许 fact/price/policy。`);
    }
    return Object.freeze({ key, text, type: c.type });
  });
  const budget = record.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    throw validationError('research.budget 必须是对象。');
  }
  const budgetRecord = budget as Record<string, unknown>;
  const budgetKeys = ['timeMinutes', 'minValidSources', 'maxCandidates', 'maxParallelFetches', 'maxRounds'] as const;
  // WMB-5170：逐键校验后把 unknown 收窄进数值形状（不直接赋值 unknown，杜绝 TS2322）。
  const budgetValues = {} as Record<(typeof budgetKeys)[number], number>;
  for (const key of budgetKeys) {
    const n = budgetRecord[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw validationError(`research.budget.${key} 必须是正数。`);
    }
    budgetValues[key] = n;
  }
  if (!Array.isArray(record.channels) || record.channels.length === 0) {
    throw validationError('research.channels 必须是非空数组。');
  }
  const channels = record.channels.map((channel, index) => {
    if (channel !== 'web' && channel !== 'x' && channel !== 'xhs') {
      throw validationError(`research.channels[${index}] 只允许 web/x/xhs。`);
    }
    return channel;
  });
  return Object.freeze({
    gapId,
    parentJobId,
    parentTaskId,
    parentRoleId: record.parentRoleId,
    requiredClaims: Object.freeze(requiredClaims),
    budget: Object.freeze({
      timeMinutes: budgetValues.timeMinutes,
      minValidSources: budgetValues.minValidSources,
      maxCandidates: budgetValues.maxCandidates,
      maxParallelFetches: budgetValues.maxParallelFetches,
      maxRounds: budgetValues.maxRounds
    }),
    channels: Object.freeze(channels)
  });
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
  const isResearch = roleId === 'reporter' && 'research' in record;
  const allowed = isResearch ? RESEARCH_ALLOWED_KEYS : ROLE_ALLOWED_KEYS[roleId];
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
    const writerTask = record.writerTask ?? 'core_draft';
    if (writerTask !== 'core_draft' && writerTask !== 'xiaohongshu_platform_version') {
      throw validationError('writerTask 只允许 core_draft 或 xiaohongshu_platform_version。');
    }
    return Object.freeze({ roleId, brief, projectId, writerTask, businessDate });
  }
  if (roleId === 'reporter') {
    if (isResearch) {
      const projectId = typeof record.projectId === 'string' ? record.projectId.trim() || null : null;
      return Object.freeze({
        roleId,
        brief,
        businessDate,
        projectId,
        research: parseResearchGap(record.research)
      });
    }
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
  // WMB-5170 §5.2：带 research 块的 reporter 请求派生 research intent（角色注册表是 intent 唯一真相源）。
  const isResearch = roleId === 'reporter' && 'research' in request;
  // librarian 联合成员无 businessDate（合同 §5.1）：缺省今日，仅作任务上下文。
  const businessDate = (roleId === 'librarian' ? null : request.businessDate) ?? shanghaiDate();
  const projectId = roleId === 'writer' ? request.projectId : isResearch ? (request.projectId ?? null) : null;
  const writerTask = roleId === 'writer' ? request.writerTask : null;
  const boundary = buildJobObjectBoundary(request, businessDate);
  const resourceLocks = isResearch
    ? Object.freeze([...deriveResourceLocks({
        roleId,
        workspaceId,
        businessDate,
        projectId,
        channelIds: roleId === 'reporter' ? request.channelIds : null
      }), `research:${request.research.parentJobId}`])
    : deriveResourceLocks({
        roleId,
        workspaceId,
        businessDate,
        projectId,
        channelIds: roleId === 'reporter' ? request.channelIds : null
      });
  return Object.freeze({
    roleId,
    intent: isResearch ? 'research' : ROLE_TO_INTENT[roleId],
    businessDate,
    projectId,
    writerTask,
    sourceIds: boundary.sourceIds,
    scope: boundary.scope,
    resourceLocks,
    policy: ROLE_TO_POLICY[isResearch ? 'research' : roleId],
    readback: writerTask === 'xiaohongshu_platform_version' ? 'xiaohongshu_platform_version' : ROLE_TO_READBACK[isResearch ? 'research' : roleId]
  });
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

/** 写手小红书任务读回：目标项目至少存在一个小红书平台版本。 */
export function readbackXiaohongshuPlatformVersion(database: DatabaseSync, projectId: string): RoleJobReadbackV1 | null {
  const row = database.prepare(`SELECT id, content_version_id AS contentVersionId
    FROM platform_versions WHERE project_id = ? AND platform = 'xiaohongshu'
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(projectId) as { id: string; contentVersionId: string } | undefined;
  if (!row) return null;
  return { kind: 'xiaohongshu_platform_version', projectId, versionId: row.id, contentVersionId: row.contentVersionId };
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
  const proposal = readLatestTopicMaintenanceProposalForTask(database, taskId, sinceIso);
  if (proposal) return { kind: 'topic_maintenance_proposed', proposal };
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
