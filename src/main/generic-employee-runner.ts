import { randomUUID } from 'node:crypto';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { JobExecuteContext } from './job-spawner.ts';
import type { JobPool } from './job-pool.ts';
import type { EmployeeRole } from './job-pool.ts';
import { getAgentTask, type AgentTask } from './agent-tasks.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { broadcastPiEvent } from './app-window.ts';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import {
  dispatchBindNeedsUserJobContract,
  dispatchCancelAgentTask,
  dispatchCompleteAgentTask,
  dispatchFailAgentTask,
  dispatchNeedsUserAgentTask,
  dispatchPartialAgentTask,
  dispatchUpdateAgentTaskPhase
} from './agent-task-commands.ts';
import { readJobContractFromRefs } from './job-object-boundary.ts';
import { parseResearchEvidencePack } from './research-task-state.ts';
import {
  buildJobContextRefs,
  buildJobObjectBoundary,
  deriveRoleJobSpec,
  JOB_ERROR_CODES,
  mapOutcomeToTerminal,
  normalizeSourceIds,
  readbackContentVersion,
  readbackLibraryMutation,
  readbackPlansRevision,
  readbackScanPhase,
  readbackXiaohongshuPlatformVersion,
  roleFailureCode,
  type JobExecutionOutcome,
  type JobObjectBoundary,
  type RoleJobReadbackV1,
  type RoleJobRequest,
  type RoleJobSpec
} from './role-job-registry.ts';
import { runRolePolicy, type EmployeePolicyContext, type EmployeePolicyRun } from './role-job-policies.ts';

export type DailyJobMcpUrls = {
  mcpUrl: string;
  xhsMcpUrl?: string | null;
};

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

function cancelledOutcome(): JobExecutionOutcome {
  return Object.freeze({ status: 'cancelled', code: JOB_ERROR_CODES.JOB_CANCELLED, message: null, readback: null });
}

function failedOutcome(code: string, message: string | null): JobExecutionOutcome {
  return Object.freeze({ status: 'failed', code, message, readback: null });
}

/** 成功路径的稳定 code（§5.3 / §9.2），按读回证据种类区分。 */
function successCodeFor(readback: RoleJobReadbackV1): string {
  switch (readback.kind) {
    case 'scan_phase_reached': return 'SCAN_CHANNEL_SCANNED';
    case 'plans_revision': return 'PLANS_REVISION';
    case 'content_version': return 'CONTENT_VERSION';
    case 'xiaohongshu_platform_version': return 'XIAOHONGSHU_PLATFORM_VERSION';
    case 'sources_mutated': return 'SOURCES_MUTATED';
    case 'topic_maintenance_proposed': return 'TOPIC_MAINTENANCE_PROPOSED';
    case 'noop_confirmed': return 'NOOP_CONFIRMED';
    case 'research_evidence': return 'RESEARCH_EVIDENCE';
  }
}

/**
 * WMB-5116 四角色统一员工执行器（§6 统一生命周期，角色差异收敛为策略 + 读回）。
 * - task/lease 绑定与自动 grant 经 onTaskReady 统一接线（A1 不变量）；
 * - reporter/planner 复用 daily 原语，writer 复用 studio 原语，librarian 走真实 Pi 会话；
 * - 成功必须有业务读回（§7），无读回落 JOB_READBACK_MISSING；
 * - agent_task 终态（librarian 由本 runner 写；其余由领域原语写）与 pool 终态
 *   由同一 mapOutcomeToTerminal 产出；abort 永远胜出（§5.3）。
 */
export function createGenericEmployeeRunner(
  getRuntime: () => ActiveWorkspaceRuntime | null,
  getMcpUrls: () => DailyJobMcpUrls | null
): (ctx: JobExecuteContext) => Promise<JobExecutionOutcome> {
  return async (ctx) => {
    const runtime = getRuntime() ?? ctx.runtime;
    const urls = getMcpUrls();
    if (!urls?.mcpUrl) {
      console.error('[generic-employee-runner] MCP unavailable');
      return failedOutcome(JOB_ERROR_CODES.MCP_UNAVAILABLE, 'MCP 不可用');
    }
    if (aborted(ctx.signal)) return cancelledOutcome();

    const roleId = ctx.job.roleId;
    // WMB-5141：优先使用 spawn 原始请求（保留 channelIds/sourceFeedIds/sourceIds/scope），
    // 无合同任务（测试直连 ctx）回落 JobRecord 重建。
    const request: RoleJobRequest = ctx.request ?? (roleId === 'writer'
      ? { roleId, brief: ctx.job.brief, projectId: ctx.job.projectId ?? '', writerTask: ctx.job.writerTask ?? 'core_draft', businessDate: ctx.job.businessDate }
      : roleId === 'librarian'
        ? { roleId, brief: ctx.job.brief }
        : roleId === 'reporter'
          ? { roleId, brief: ctx.job.brief, businessDate: ctx.job.businessDate }
          : { roleId, brief: ctx.job.brief, businessDate: ctx.job.businessDate });
    const spec = deriveRoleJobSpec(request, runtime.identity.workspaceId);
    const sessionStartedAt = new Date().toISOString();

    const onEvent = (event: Record<string, unknown>) => {
      broadcastPiEvent({ ...event, scope: 'task' });
    };
    // 评审 MAJOR 2：跟踪已建任务，abort 后尽力取消（不留 running 孤儿）。
    let createdTaskId: string | null = null;
    const onTaskReady = async (taskId: string) => {
      createdTaskId = taskId;
      // WMB-5119 §6.2：pre-bind abort 门——任务已建但取消已到（onTaskReady 门挂起窗口）：
      // 拒绝 bind/grant，抛 JOB_CANCELLED 由 catch 链 bestEffortCancelTask（全角色）收尾，
      // 杜绝 pre-bind 窗口 pool/task 双终态与取消后 mutation。
      if (aborted(ctx.signal)) {
        throw Object.assign(new Error(JOB_ERROR_CODES.JOB_CANCELLED), { code: JOB_ERROR_CODES.JOB_CANCELLED });
      }
      // A1：lease 必须绑到子任务，grant 校验才过。
      runtime.bindWorkerTask(ctx.lease, taskId);
      // WMB-5141 持久续派合同：jobId/roleId/brief/边界参数原子写入既有 context_refs_json
      // （不丢既有 refs；缺失边界由 grant issue fail closed 兜底，两者同一硬门链）。
      if (ctx.request) {
        await writeJobContractRefs(runtime, taskId, {
          jobId: ctx.job.id,
          request,
          boundary: boundaryForTask(request, spec, runtime, getAgentTask(runtime.database, taskId))
        }, ctx.lease.leaseId);
      }
      const grantId = await ensureAutomaticTaskGrant(runtime, taskId, new Date(), roleId);
      ctx.onTaskBound?.(taskId, grantId);
      return grantId;
    };

    const policyContext: EmployeePolicyContext = {
      runtime,
      spec,
      businessDate: spec.businessDate,
      mcpUrl: urls.mcpUrl,
      xhsMcpUrl: urls.xhsMcpUrl ?? '',
      workerLeaseId: ctx.lease.leaseId,
      sessionFile: ctx.sessionFile,
      signal: ctx.signal,
      jobId: ctx.job.id,
      brief: ctx.job.brief,
      onTaskReady,
      onEvent,
      registerStoppable: ctx.registerStoppable ?? (() => {})
    };

    // WMB-5119 §6.4 abort 门（全角色）：取消一触发即尽力取消已建任务——终态 cancelled 先于 Pi 强停
    // 落盘，域 abort 异常路径（daily forcePartial / studio forceFail / organize forceFail）见任务已
    // 终态即跳过，杜绝 pool/task 双终态；取消后 mutation（扫描回执/业务写）被 TASK_NOT_ACTIVE 门拦截。
    const onAbortCancel = () => {
      if (createdTaskId) void bestEffortCancelTask(ctx, createdTaskId);
    };
    if (!ctx.signal.aborted) ctx.signal.addEventListener('abort', onAbortCancel, { once: true });
    try {
      const run = await runRolePolicy(spec.policy, policyContext);
      if (aborted(ctx.signal)) {
        // WMB-5119 §6.3：bestEffortCancelTask 全角色（reporter/planner/writer/librarian）；
        // cancelAgentTask INVALID_STATE 守卫保无双终态，已终态任务跳过。
        if (createdTaskId) await bestEffortCancelTask(ctx, createdTaskId);
        return cancelledOutcome();
      }
      // WMB-5142 生命周期「处理」：配置已补齐（真实任务已建）的续派，关闭与本工单同逻辑键的遗留
      // needs_user 前置卡（旧任务 cancelled → 历史可追；旧池卡 cancelled → 退出活动视图），新实例唯一。
      if (createdTaskId) {
        await closeStaleNeedsUserCards(runtime, ctx.pool ?? null, {
          roleId,
          businessDate: spec.businessDate,
          projectId: spec.projectId,
          workerLeaseId: ctx.lease.leaseId
        });
      }
      // WMB-5142 评审 P1 + 生命周期：复用/前置未绑定任务（onTaskReady 未触发，createdTaskId 未置）——
      // 新建前置卡绑定工单合同（重启后按 jobId 重建「等你批」卡，修复配置缺失卡重启即丢）并回写
      // handle 任务引用（settle 报告携带 taskId，投影按任务去重：续派 reuse 同任务不产生第二张卡）。
      if (!createdTaskId && run.task) {
        await bindWaitingTaskContract(ctx, runtime, request, spec, run.task.id);
        ctx.onTaskBound?.(run.task.id, null);
      }
      const outcome = await assembleOutcome(ctx, spec, run, sessionStartedAt);
      // librarian 的 agent_task 终态由 runner 在 lease 仍绑定 task 时统一写入（§6 step 7）；
      // reporter/planner/writer 的 agent_task 终态已由领域原语写入。
      if (spec.policy === 'organize') {
        await writeAgentTaskTerminal(ctx, outcome, run.task.id);
      }
      return outcome;
    } catch (error) {
      if (aborted(ctx.signal)) {
        // WMB-5119 §6.3：全角色 bestEffortCancelTask（pre-bind 门抛 JOB_CANCELLED 等取消路径的收尾）。
        if (createdTaskId) await bestEffortCancelTask(ctx, createdTaskId);
        return cancelledOutcome();
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : roleFailureCode(roleId);
      const outcome = failedOutcome(code, message);
      if (createdTaskId) {
        const current = getAgentTask(ctx.runtime.database, createdTaskId);
        if (current?.status === 'running') {
          await writeAgentTaskTerminal(ctx, outcome, createdTaskId);
        }
      }
      console.error('[generic-employee-runner]', roleId, error);
      return outcome;
    } finally {
      ctx.signal.removeEventListener('abort', onAbortCancel);
    }
  };
}

/** 尽力取消仍 running 的任务（取消优先；已终态则忽略）。 */
async function bestEffortCancelTask(ctx: JobExecuteContext, taskId: string): Promise<void> {
  try {
    const current = getAgentTask(ctx.runtime.database, taskId);
    if (current?.status !== 'running') return;
    await dispatchCancelAgentTask(ctx.runtime, taskId, {
      actor: { type: 'scheduler' as const, id: 'generic-employee-runner', label: 'GenericEmployeeRunner' },
      requestId: `${taskId}:cancel:abort:${randomUUID()}`,
      workerLeaseId: ctx.lease.leaseId,
      taskId
    });
  } catch { /* 已终态则忽略 */ }
}

/**
 * WMB-5141 持久续派合同写入（设计 §7.3/§12.2.1）：
 * 把 jobId/roleId/brief/边界参数合并进既有 context_refs_json（原子单命令、不丢既有 refs，
 * 走 agent_tasks.update_phase 命令面 → receipt + operation_log 审计）。任务非 running 时跳过
 * （已终态由 grant issue 缺边界 fail closed 兜底，不在此处静默污染）。
 */
export async function writeJobContractRefs(
  runtime: ActiveWorkspaceRuntime,
  taskId: string,
  input: { jobId: string; request: RoleJobRequest; boundary: JobObjectBoundary },
  workerLeaseId?: string
): Promise<void> {
  const current = getAgentTask(runtime.database, taskId);
  if (!current || current.status !== 'running') return;
  await dispatchUpdateAgentTaskPhase(runtime, taskId, current.phase, {
    contextRefs: { ...current.contextRefs, ...buildJobContextRefs({ jobId: input.jobId, request: input.request, boundary: input.boundary }) }
  }, {
    actor: { type: 'scheduler' as const, id: 'generic-employee-runner', label: 'GenericEmployeeRunner' },
    requestId: `${taskId}:job-contract:${input.jobId}`,
    workerLeaseId,
    taskId
  });
}

/** 工单对象边界（reporter 冻结渠道 feed 派生；与 onTaskReady 同款，消除双份逻辑漂移）。 */
function boundaryForTask(request: RoleJobRequest, spec: RoleJobSpec, runtime: ActiveWorkspaceRuntime, task: AgentTask | null): JobObjectBoundary {
  let boundary = buildJobObjectBoundary(request, spec.businessDate);
  // reporter 派单未显式给 sourceFeedIds 时，从冻结渠道推导 feed 边界（upsert_batch 以 feedId 写渠道对象）。
  if (request.roleId === 'reporter' && boundary.feedIds.length === 0) {
    const frozen = task?.contextRefs?.intelligenceChannels as { sources?: Array<{ sourceFeedId?: unknown }> } | undefined;
    const feedIds = Array.isArray(frozen?.sources)
      ? frozen.sources.map((source) => source?.sourceFeedId).filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [];
    if (feedIds.length) boundary = Object.freeze({ ...boundary, feedIds: normalizeSourceIds(feedIds) });
  }
  return boundary;
}

/**
 * WMB-5142 生命周期：为 needs_user 等待卡绑定工单合同 refs（jobId/roleId/brief/边界合并不丢既有 refs）。
 * 仅当任务仍 needs_user 且尚无可指认合同（新建前置卡 / 旧版无合同卡修复；reuse 旧卡已带合同不覆写 jobId，
 * 续派卡仍归属最早 job，跨面指认稳定）。命令面 → receipt + operation_log 审计。
 */
async function bindWaitingTaskContract(
  ctx: JobExecuteContext,
  runtime: ActiveWorkspaceRuntime,
  request: RoleJobRequest,
  spec: RoleJobSpec,
  taskId: string
): Promise<void> {
  if (!ctx.request) return;
  const current = getAgentTask(runtime.database, taskId);
  if (!current || current.status !== 'needs_user') return;
  if (readJobContractFromRefs(current.contextRefs)) return;
  try {
    await dispatchBindNeedsUserJobContract(runtime, taskId, {
      ...current.contextRefs,
      ...buildJobContextRefs({ jobId: ctx.job.id, request, boundary: boundaryForTask(request, spec, runtime, current) })
    }, {
      actor: { type: 'scheduler' as const, id: 'generic-employee-runner', label: 'GenericEmployeeRunner' },
      requestId: `${taskId}:job-contract:${ctx.job.id}`,
      workerLeaseId: ctx.lease.leaseId,
      taskId
    });
  } catch { /* 任务已终态则跳过（grant issue 缺边界 fail closed 兜底不变） */ }
}

/** 角色前置 needs_user 任务 intent 集（补配置续派关闭匹配键；reporter scanOnly 无前置，daily_scan 兜底）。 */
const PREREQUISITE_INTENTS: Readonly<Record<EmployeeRole, readonly string[]>> = Object.freeze({
  reporter: ['daily_intelligence', 'daily_scan'],
  planner: ['daily_judge'],
  writer: ['studio_draft'],
  librarian: ['page_library']
});

/**
 * WMB-5142 生命周期「处理」：关闭与本工单同逻辑键的遗留 needs_user 前置卡（PI_CONFIG_REQUIRED）。
 * 匹配键 = 角色前置 intent 集 + businessDate；writer 再按 projectId 精确匹配（不同项目互不关闭）。
 * 任务侧 needs_user → cancelled（历史可追、不再被复用）；池卡（凡引用该任务者，含无合同旧卡）
 * needs_user → cancelled（退出活动视图，jobs:list 不再残留）。配置补齐后由 runner 在真实任务
 * 已建（createdTaskId）后调用；测试可直接调用同一函数验证生命周期。
 */
export async function closeStaleNeedsUserCards(
  runtime: ActiveWorkspaceRuntime,
  pool: JobPool | null,
  input: { roleId: EmployeeRole; businessDate: string; projectId: string | null; workerLeaseId?: string | null }
): Promise<void> {
  const intents = PREREQUISITE_INTENTS[input.roleId] ?? [];
  if (!intents.length) return;
  const rows = runtime.database.prepare(
    `SELECT id FROM agent_tasks WHERE intent IN (${intents.map(() => '?').join(',')}) AND business_date = ?
       AND status = 'needs_user' AND error_code = 'PI_CONFIG_REQUIRED' ORDER BY updated_at DESC`
  ).all(...intents, input.businessDate) as Array<{ id: string }>;
  for (const row of rows) {
    const task = getAgentTask(runtime.database, row.id);
    if (!task || task.status !== 'needs_user') continue;
    if (input.roleId === 'writer' && String(task.contextRefs.projectId ?? '') !== String(input.projectId ?? '')) continue;
    try {
      await dispatchCancelAgentTask(runtime, task.id, {
        actor: { type: 'scheduler' as const, id: 'generic-employee-runner', label: 'GenericEmployeeRunner' },
        requestId: `${task.id}:handle-close:${randomUUID()}`,
        workerLeaseId: input.workerLeaseId ?? undefined,
        taskId: task.id
      });
    } catch { /* 已终态则忽略 */ }
    for (const rec of pool?.list() ?? []) {
      if (rec.status === 'needs_user' && rec.report?.taskId === task.id) pool?.cancel(rec.id, null);
    }
  }
  if (rows.length) broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.handle-close' });
}

/** §7 读回：任务终态 + 业务产物证据 → 五态 outcome；无读回证据不得 succeeded。 */
async function assembleOutcome(
  ctx: JobExecuteContext,
  spec: RoleJobSpec,
  run: EmployeePolicyRun,
  sessionStartedAt: string
): Promise<JobExecutionOutcome> {
  // §5.2 半 1：守卫命中 → 瞬时 deferred outcome，先于任务终态检查（judge 任务仍 running，读它必伪失败）。
  if (run.deferred) {
    return Object.freeze({
      status: 'deferred',
      code: JOB_ERROR_CODES.SCAN_JUDGE_IN_FLIGHT,
      message: `判定任务进行中（task ${run.deferred.taskId}），扫描让路。`,
      readback: null
    });
  }
  const task = run.task;
  const code = task.errorCode ?? null;
  if (task.status === 'cancelled') return cancelledOutcome();
  if (task.status === 'needs_user') {
    return Object.freeze({ status: 'needs_user', code: code ?? 'NEEDS_USER', message: task.errorMessage ?? null, readback: null });
  }
  if (task.status === 'partial') {
    return Object.freeze({ status: 'partial', code: code ?? 'PARTIAL', message: task.errorMessage ?? null, readback: null });
  }
  if (task.status === 'failed') {
    return Object.freeze({ status: 'failed', code: code ?? 'JOB_FAILED', message: task.errorMessage ?? null, readback: null });
  }
  if (task.status !== 'succeeded' && task.status !== 'running') {
    return failedOutcome(code ?? 'JOB_FAILED', task.errorMessage ?? `任务终态异常：${task.status}`);
  }
  const readback = await readbackFor(ctx, spec, run, sessionStartedAt);
  if (readback) {
    return Object.freeze({ status: 'succeeded', code: successCodeFor(readback), message: null, readback });
  }
  return failedOutcome(JOB_ERROR_CODES.JOB_READBACK_MISSING, `缺少 ${spec.readback} 业务读回证据。`);
}

async function readbackFor(ctx: JobExecuteContext, spec: RoleJobSpec, run: EmployeePolicyRun, sessionStartedAt: string): Promise<RoleJobReadbackV1 | null> {
  const db = ctx.runtime.database;
  const task = run.task;
  switch (spec.readback) {
    case 'scan_phase':
      // §5.2 半 2：优先不可变快照（resolve 返回瞬间捕获）；缺快照才回落 readbackScanPhase 重读。
      return run.readback ?? readbackScanPhase(db, task.id);
    case 'plans_revision':
      return readbackPlansRevision(db, spec.businessDate, task.id);
    case 'content_version':
      return readbackContentVersion(db, spec.projectId ?? '');
    case 'xiaohongshu_platform_version':
      return readbackXiaohongshuPlatformVersion(db, spec.projectId ?? '');
    case 'library_mutation':
      // WMB-5121 §8.3：传策略捕获的内存末条文本（免读文件），未捕获时 readbackLibraryMutation 读会话文件兜底。
      return readbackLibraryMutation(db, task.id, sessionStartedAt, ctx.sessionFile, run.finalAssistantText);
    case 'research_evidence':
      // WMB-5173：research 读回 = EvidencePack 已落盘（WMB-5172 执行器写 result_refs_json）；
      // 无证据即 null，走既有 JOB_READBACK_MISSING 保守失败，不伪造成功。
      return researchEvidenceReadback(task);
  }
}

/** research 任务读回：result_refs_json 的 EvidencePack 是业务证据（缺 → null 保守失败）。 */
function researchEvidenceReadback(task: AgentTask): RoleJobReadbackV1 | null {
  const pack = parseResearchEvidencePack(task.resultRefs);
  if (!pack) return null;
  return Object.freeze({
    kind: 'research_evidence',
    jobId: pack.jobId,
    status: task.status === 'partial' ? 'partial' : 'succeeded'
  });
}

/** 写 agent_task 终态（§5.3 同一映射）；取消路径由 spawner.cancel 主导，这里尽力而为。 */
export async function writeAgentTaskTerminal(ctx: JobExecuteContext, outcome: JobExecutionOutcome, taskId: string): Promise<void> {
  const mapping = mapOutcomeToTerminal(outcome, ctx.signal.aborted);
  const context = {
    actor: { type: 'scheduler' as const, id: 'generic-employee-runner', label: 'GenericEmployeeRunner' },
    requestId: `${taskId}:terminal:${randomUUID()}`,
    workerLeaseId: ctx.lease.leaseId,
    taskId
  };
  try {
    switch (mapping.agentTask) {
      case 'succeeded':
        await dispatchCompleteAgentTask(ctx.runtime, taskId, context);
        break;
      case 'partial':
        await dispatchPartialAgentTask(ctx.runtime, taskId, context);
        break;
      case 'needs_user':
        await dispatchNeedsUserAgentTask(ctx.runtime, taskId, mapping.code, outcome.message ?? '需要主管介入', context);
        break;
      case 'failed':
        await dispatchFailAgentTask(ctx.runtime, taskId, mapping.code, outcome.message ?? '工单执行失败', context);
        break;
      case 'cancelled':
        await dispatchCancelAgentTask(ctx.runtime, taskId, context).catch(() => {});
        break;
    }
  } catch {
    /* 控制路径已写终态则忽略 */
  }
}
