import { randomUUID } from 'node:crypto';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { JobExecuteContext } from './job-spawner.ts';
import { getAgentTask } from './agent-tasks.ts';
import { broadcastPiEvent } from './app-window.ts';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import {
  dispatchCancelAgentTask,
  dispatchCompleteAgentTask,
  dispatchFailAgentTask,
  dispatchNeedsUserAgentTask,
  dispatchPartialAgentTask
} from './agent-task-commands.ts';
import {
  deriveRoleJobSpec,
  JOB_ERROR_CODES,
  mapOutcomeToTerminal,
  readbackContentVersion,
  readbackLibraryMutation,
  readbackPlansRevision,
  readbackScanPhase,
  roleFailureCode,
  type JobExecutionOutcome,
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
    case 'sources_mutated': return 'SOURCES_MUTATED';
    case 'noop_confirmed': return 'NOOP_CONFIRMED';
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
    const request: RoleJobRequest = roleId === 'writer'
      ? { roleId, brief: ctx.job.brief, projectId: ctx.job.projectId ?? '', businessDate: ctx.job.businessDate }
      : roleId === 'librarian'
        ? { roleId, brief: ctx.job.brief }
        : { roleId, brief: ctx.job.brief, businessDate: ctx.job.businessDate };
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
    case 'library_mutation':
      // WMB-5121 §8.3：传策略捕获的内存末条文本（免读文件），未捕获时 readbackLibraryMutation 读会话文件兜底。
      return readbackLibraryMutation(db, task.id, sessionStartedAt, ctx.sessionFile, run.finalAssistantText);
  }
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
