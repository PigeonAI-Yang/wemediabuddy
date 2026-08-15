import { randomUUID } from 'node:crypto';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeLease } from './workspace-runtime.ts';
import { getAgentTask, type AgentIntent } from './agent-tasks.ts';
import { dispatchCancelAgentTask, dispatchRequestAgentTaskControl } from './agent-task-commands.ts';
import { abortDailyIntelligence } from './agent-runner.ts';
import { shanghaiDate } from './ferment.ts';
import type { JobPool, JobRecord } from './job-pool.ts';
import {
  buildRoleJobReport,
  deriveIntentForRole,
  JOB_ERROR_CODES,
  type RoleJobReportV1
} from './role-job-registry.ts';

/**
 * WMB-5117 工单运行期控制（§6.2/§6.3）。
 *
 * - `runCancellationSequence`：统一取消序列（自 JobSpawner.cancel 抽取，公共行为语义等价）；
 * - `createStoppableRegistrar`：单槽 stoppable 注册协议（last registration wins；
 *   abort 后注册同步立即 stop；5119 由四角色策略接线 runtime stop）。
 * - 5118 将在此增 `parkDeferred`（deferred 泊车路由）。
 *
 * 依赖经参数注入，不反向 import JobSpawner，保持无循环依赖。
 */

/** 单槽可停止资源（Pi runtime stop，内含 ≤2s 进程树强停）。 */
export type Stoppable = () => Promise<void>;

/** 取消序列所需的工单句柄视图（InternalHandle 的结构子集）。 */
export type CancellableHandle = Readonly<{
  abort: AbortController;
  lease: WorkspaceRuntimeLease | null;
  taskId: string | null;
  leaseId: string | null;
  stopResource: Stoppable | null;
}>;

export type CancellationDeps = {
  runtime: ActiveWorkspaceRuntime;
  pool: JobPool;
  /** pool.cancel 实际转换且 prior 非 cancelled 时回调（MINOR 3 去重由本序列保证）。 */
  onCancelled: (cancelled: JobRecord) => void;
  /** 序列收尾：移除内部句柄/启动标记。 */
  onCleanup: (jobId: string) => void;
};

/** stopResource 强停上限（Pi stopProcessTree 内部 ≤2s，此处 race 兜底有界）。 */
const STOP_TIMEOUT_MS = 2_000;

export function ownerJobsActor() {
  return { type: 'owner_ui' as const, id: 'jobs', label: 'JobSpawner' };
}

/** 一次性终止全部工单句柄（dispose / 池关闭）：abort + 释放 lease，异常吞并。 */
export function disposeHandles(handles: Iterable<CancellableHandle>, runtime: ActiveWorkspaceRuntime): void {
  for (const h of handles) {
    h.abort.abort();
    if (h.lease) {
      try { runtime.releaseWorker(h.lease); } catch { /* */ }
    }
  }
}

/**
 * 统一取消序列（§6.2）：abort → stopResource（≤2s 有界、异常吞并）→ lease 释放 →
 * daily 兜底 → agent_task cancel → pool.cancel（MINOR 3 去重）→ 句柄清理。
 * 与 WMB-5116 `JobSpawner.cancel` 公共行为等价；5117 无角色注册（stopResource=null）时行为不变。
 */
export async function runCancellationSequence(
  jobId: string,
  handle: CancellableHandle | null,
  deps: CancellationDeps
): Promise<JobRecord | null> {
  const initial = deps.pool.get(jobId);
  // WMB-5142 生命周期：已 settle 的 needs_user 卡（无运行句柄，句柄在 finally 已清）也可被用户关闭——
  // 从终态报告取任务引用，任务侧 needs_user → cancelled（历史可追；否则重启后持久卡复现）。
  const closingNeedsUser = Boolean(initial && initial.status === 'needs_user' && !handle && initial.report?.taskId);
  const closeTaskId = handle?.taskId ?? (closingNeedsUser ? initial!.report!.taskId : null);
  if (handle) {
    handle.abort.abort();
    // WMB-5119 §6.4 取消优先（planner/reporter 竞态根因）：Pi 强停前先置 controlAction='cancel'
    // 请求标记（非终态写，幂等）——daily 域 abort 异常路径（cancelIfRequested / stopScanIfControlled）
    // 据此转 cancelled 而非 forcePartial，杜绝「Pi 先死 → 域抢先 partial → 本序列 dispatchCancel
    // INVALID_STATE 无法覆盖」的 pool/task 双终态。终态 cancelled 仍由第 4 步（或域自身）落盘。
    if (handle.taskId) {
      try {
        await dispatchRequestAgentTaskControl(deps.runtime, handle.taskId, 'cancel', {
          actor: ownerJobsActor(),
          requestId: `${handle.taskId}:cancel:request:${randomUUID()}`,
          workerLeaseId: handle.leaseId ?? undefined,
          taskId: handle.taskId
        }).catch(() => { /* 任务已终态/不存在则忽略 */ });
      } catch { /* 同步异常吞并，不阻断取消序列 */ }
    }
    if (handle.stopResource) await stopResourceBounded(handle.stopResource);
    if (handle.lease) {
      try { deps.runtime.releaseWorker(handle.lease); } catch { /* */ }
    }
    if (handle.taskId) {
      try {
        await abortDailyIntelligence(handle.taskId).catch(() => {});
      } catch { /* */ }
      try {
        await dispatchCancelAgentTask(deps.runtime, handle.taskId, {
          actor: ownerJobsActor(),
          requestId: randomUUID(),
          workerLeaseId: handle.leaseId ?? undefined,
          taskId: handle.taskId
        });
      } catch { /* already terminal */ }
    }
  }
  if (closingNeedsUser && closeTaskId) {
    try {
      await dispatchCancelAgentTask(deps.runtime, closeTaskId, {
        actor: ownerJobsActor(),
        requestId: `${closeTaskId}:close:${randomUUID()}`,
        taskId: closeTaskId
      });
    } catch { /* already terminal */ }
  }
  // 评审 MINOR 3：before 在 await 之后重读——并发 runJob settle（取消竞态）先行终态化时，
  // 去重依据必须是最新池记录（否则 running 快照会误判「本次取消产出 cancelled」双发事件）。
  const before = deps.pool.get(jobId);
  const report = before ? cancelledReport(deps.runtime, before, closeTaskId) : null;
  const cancelled = deps.pool.cancel(jobId, report);
  // WMB-5142 评审 P3：关闭路径对称清扫——续派 reuse 同任务会 settle 出多张 needs_user 兄弟卡
  // （均带 report.taskId=closeTaskId）。任务已 cancelled 后兄弟卡若仍以 needs_user 残留 terminal map，
  // jobs:list 会显示「等你批」幽灵卡（处理路径 closeStaleNeedsUserCards 已按同一标准清扫，关闭路径此前不对称）。
  // 与 closeStaleNeedsUserCards 同款：以 closeTaskId 扫全池、仅命中 status=needs_user 且 report.taskId
  // 相同者逐张 pool.cancel——纯池侧终态迁移，不再 dispatch 任务（任务 cancel 只一次，上文已按 closeTaskId
  // 取消）；只触碰引用同一任务的兄弟卡，不误取消其他 task/job；已终态记录 pool.cancel 为 no-op，竞态安全。
  if (closeTaskId) {
    for (const rec of deps.pool.list()) {
      if (rec.status === 'needs_user' && rec.report?.taskId === closeTaskId) deps.pool.cancel(rec.id, null);
    }
  }
  // 评审 MINOR 3：仅当本次取消真正产出 cancelled 且 prior 非 cancelled 才发事件——
  // 对既有 succeeded/failed 终态工单调用 cancel 返回原终态，不得误发 job.cancelled。
  if (cancelled?.status === 'cancelled' && before?.status !== 'cancelled') deps.onCancelled(cancelled);
  deps.onCleanup(jobId);
  return cancelled;
}

/** 有界强停：异常吞并（stop 失败不阻断取消序列）；超过 2s 不再等待。 */
async function stopResourceBounded(stop: Stoppable): Promise<void> {
  let stopped: Promise<void>;
  try {
    // 内联 catch 吞掉 stop 的 rejection（含 2s 窗口之后才到达的迟到 rejection），防 unhandledRejection。
    stopped = stop().catch(() => {});
  } catch {
    return; // stop 同步抛错：吞并，继续取消
  }
  await Promise.race([
    stopped,
    new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))
  ]);
}

/** 取消报告（与原 spawner.cancel 内联 buildRoleJobReport 完全一致，保证语义等价）。 */
function cancelledReport(runtime: ActiveWorkspaceRuntime, job: JobRecord, taskId: string | null): RoleJobReportV1 {
  return buildRoleJobReport({
    jobId: job.id,
    roleId: job.roleId,
    intent: (job.intent ?? deriveIntentForRole(job.roleId)) as AgentIntent,
    status: 'cancelled',
    code: JOB_ERROR_CODES.JOB_CANCELLED,
    businessDate: job.businessDate ?? shanghaiDate(),
    projectId: job.projectId,
    taskId,
    phase: taskId ? getAgentTask(runtime.database, taskId)?.phase ?? null : null,
    readback: null,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString(),
    errorMessage: null
  });
}

export type StoppableRegistrar = {
  /** 单槽注册：last registration wins；signal 已 abort → 同步立即 stop（关 Pi 晚创建窗口）。 */
  registerStoppable: (stop: Stoppable) => void;
  /** 停止当前槽（无注册则 no-op；异常吞并）。 */
  stopCurrent: () => Promise<void>;
};

export type ParkDeferredDeps = {
  runtime: ActiveWorkspaceRuntime;
  pool: JobPool;
  /** 泊车成功（waiting_resource）后回调（JobSpawner 发 `job.waiting_resource` 事件）。 */
  onParked: (parked: JobRecord) => void;
};

/**
 * WMB-5118 §5.2/§5.5 deferred 泊车路由：释放 employee lease → 实体锁（pool.park 内释放）→
 * `pool.park(RESOURCE_JUDGE_IN_FLIGHT)` → 发 `job.waiting_resource` → 返回「已处理」标志。
 * 不写 agent_task 终态、不进五态映射（deferred 传 `mapOutcomeToTerminal` 为类型错误 + 运行期抛错兜底）。
 * 返回 false = 工单已被并发取消/终态化（pool.park 落到既有终态，不重复 emit）；调用方同样直接返回。
 */
export async function parkDeferred(
  jobId: string,
  lease: WorkspaceRuntimeLease | null,
  deps: ParkDeferredDeps
): Promise<boolean> {
  if (lease) {
    try { deps.runtime.releaseWorker(lease); } catch { /* 幂等：已释放则忽略 */ }
  }
  const parked = deps.pool.park(jobId, 'RESOURCE_JUDGE_IN_FLIGHT', '判定任务进行中（SCAN_JUDGE_IN_FLIGHT），扫描让路。');
  if (parked?.status === 'waiting_resource') deps.onParked(parked);
  return parked?.status === 'waiting_resource';
}

/**
 * 单一 stoppable 注册协议（§6.3）：每工单至多一个活动 Pi，重复注册覆盖旧槽；
 * 注册时 signal 已 abort → 同步立即调用 stop（不 await，不打断注册流程）。
 */
export function createStoppableRegistrar(
  signal: AbortSignal,
  setCurrent?: (stop: Stoppable | null) => void
): StoppableRegistrar {
  let current: Stoppable | null = null;
  return {
    registerStoppable: (stop: Stoppable) => {
      current = stop;
      setCurrent?.(stop);
      if (signal.aborted) {
        void stop().catch(() => {});
      }
    },
    stopCurrent: async () => {
      const stop = current;
      if (stop) await stop().catch(() => {});
    }
  };
}
