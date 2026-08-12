import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { getActiveManagerTask } from './manager-task.ts';
import { getActiveDailyIntelligenceTask } from './agent-tasks.ts';
import { shanghaiDate } from './ferment.ts';
import { startWorkspaceDailyIntelligence } from './workspace-intelligence.ts';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import { broadcastPiEvent } from './app-window.ts';
import { releaseDailyStageLock, tryAcquireDailyStageLock } from './daily-stage-lock.ts';
import { syncManagerTaskFromLegacyChild } from './manager-dispatch.ts';

export type DailyStage = 'scan' | 'judge' | 'full';

export function isManagerOrchestrating(runtime: ActiveWorkspaceRuntime, businessDate = shanghaiDate()): boolean {
  const manager = getActiveManagerTask(runtime.database, businessDate);
  return Boolean(manager && manager.status === 'running');
}

/** @deprecated 保留兼容；不再禁用后台能力。 */
export function shouldSuppressSilentJudge(_runtime: ActiveWorkspaceRuntime, _businessDate = shanghaiDate()): boolean {
  return false;
}

export async function runManagerDailyStage(input: {
  runtime: ActiveWorkspaceRuntime;
  dataRootPath: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  stage: DailyStage;
  businessDate?: string;
  modules?: Array<'official_web' | 'x_lists'>;
  workerLeaseId?: string;
}): Promise<{
  ok: boolean;
  stage: DailyStage;
  businessDate: string;
  task: { id: string; intent: string; status: string; phase: string } | null;
  message: string;
  errorCode?: string;
}> {
  const businessDate = input.businessDate?.trim() || shanghaiDate();
  const stage = input.stage;
  const roleId = stage === 'judge' ? 'planner' : 'reporter';
  const lockOwner = `manager-stage:${stage}:${Date.now()}`;
  const lock = tryAcquireDailyStageLock({ businessDate, kind: stage, owner: lockOwner });
  if (!lock.ok) {
    return {
      ok: false,
      stage,
      businessDate,
      task: null,
      message: `阶段锁占用中（${lock.heldBy.kind} by ${lock.heldBy.owner}）。请稍后或等当前扫/判结束。`,
      errorCode: 'STAGE_LOCK_BUSY'
    };
  }

  // A2: 阶段子任务使用独立 employee lease，不复用 desk lease，避免与主管回合抢绑。
  let lease: ReturnType<ActiveWorkspaceRuntime['acquireWorkerLease']> | null = null;
  try {
    lease = input.runtime.acquireWorkerLease(null, roleId, 'employee');
    input.runtime.bindWorker(lease, { stop: async () => {} });

    const result = await startWorkspaceDailyIntelligence({
      dataRootPath: input.dataRootPath,
      businessDate,
      mcpUrl: input.mcpUrl,
      xhsMcpUrl: input.xhsMcpUrl || '',
      activeRuntime: input.runtime,
      workerLeaseId: lease.leaseId,
      modules: input.modules,
      onTaskReady: async (taskId) => {
        input.runtime.bindWorkerTask(lease!, taskId);
        return ensureAutomaticTaskGrant(input.runtime, taskId, new Date(), roleId);
      },
      onEvent: (event) => broadcastPiEvent({ ...event, scope: 'task' }),
      ...(stage === 'scan' ? { scanOnly: true as const } : {}),
      ...(stage === 'judge' ? { judgeOnly: true as const } : {})
    });

    const task = result.task;
    try {
      await syncManagerTaskFromLegacyChild(input.runtime, businessDate, task);
    } catch (error) {
      console.error('[manager-orchestration] manager checkpoint sync failed', error);
    }
    const ok =
      task.status === 'succeeded'
      || task.status === 'needs_user'
      || (stage === 'scan' && (task.status === 'running' || task.phase === 'channel_scanned'));
    const message =
      stage === 'scan'
        ? (task.phase === 'channel_scanned'
          ? `记者阶段完成并停在 channel_scanned。若要出方案，请再调用 wmb_continue_after_scan 或 stage=judge。`
          : `记者阶段结束：status=${task.status} phase=${task.phase}。`)
        : stage === 'judge'
          ? `策划阶段结束：status=${task.status} phase=${task.phase}。`
          : `完整编排结束：status=${task.status} phase=${task.phase}。`;

    return {
      ok,
      stage,
      businessDate,
      task: { id: task.id, intent: task.intent, status: task.status, phase: task.phase },
      message,
      ...(ok ? {} : { errorCode: task.errorCode || task.status })
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stage,
      businessDate,
      task: null,
      message: `阶段失败：${msg}`,
      errorCode: 'STAGE_FAILED'
    };
  } finally {
    if (lease) {
      try { input.runtime.releaseWorker(lease); } catch { /* */ }
    }
    releaseDailyStageLock({ businessDate, kind: stage, owner: lockOwner });
  }
}

export async function continueAfterScan(input: {
  runtime: ActiveWorkspaceRuntime;
  dataRootPath: string;
  mcpUrl: string;
  xhsMcpUrl?: string | null;
  businessDate?: string;
}): Promise<{
  ok: boolean;
  businessDate: string;
  from: { id: string; intent: string; status: string; phase: string } | null;
  result: Awaited<ReturnType<typeof runManagerDailyStage>> | null;
  message: string;
}> {
  const businessDate = input.businessDate?.trim() || shanghaiDate();
  const daily = getActiveDailyIntelligenceTask(input.runtime.database, businessDate) ?? null;
  if (!daily) {
    return {
      ok: false,
      businessDate,
      from: null,
      result: null,
      message: '没有可续接的当日扫/判任务。可先 wmb_run_daily_stage(stage=scan) 或 wmb_spawn_job(reporter)。'
    };
  }
  const from = { id: daily.id, intent: daily.intent, status: daily.status, phase: daily.phase };
  const ready = daily.phase === 'channel_scanned' || /channel_scanned|ready_for_judge/i.test(daily.phase);
  if (!ready && daily.status === 'running') {
    return {
      ok: false,
      businessDate,
      from,
      result: null,
      message: `当前 ${daily.intent}/${daily.phase} 尚未到可续接节点（需要 channel_scanned）。`
    };
  }
  const result = await runManagerDailyStage({
    runtime: input.runtime,
    dataRootPath: input.dataRootPath,
    mcpUrl: input.mcpUrl,
    xhsMcpUrl: input.xhsMcpUrl,
    stage: 'judge',
    businessDate
  });
  return {
    ok: result.ok,
    businessDate,
    from,
    result,
    message: `已按主管指令续接策划（from ${from.intent}/${from.phase}）。${result.message}`
  };
}

export function describeDailyReadiness(runtime: ActiveWorkspaceRuntime, businessDate = shanghaiDate()): {
  businessDate: string;
  managerActive: boolean;
  daily: { id: string; intent: string; status: string; phase: string } | null;
  nextSuggestedStage: DailyStage | null;
  note: string;
} {
  const managerActive = isManagerOrchestrating(runtime, businessDate);
  const daily = getActiveDailyIntelligenceTask(runtime.database, businessDate);
  if (!daily) {
    return {
      businessDate,
      managerActive,
      daily: null,
      nextSuggestedStage: 'scan',
      note: '尚无当日扫/判任务。单项采集 stage=scan；一条龙 stage=full；采完再续 continue_after_scan。'
    };
  }
  const snapshot = { id: daily.id, intent: daily.intent, status: daily.status, phase: daily.phase };
  if (daily.status === 'running' && daily.phase === 'channel_scanned') {
    return {
      businessDate,
      managerActive,
      daily: snapshot,
      nextSuggestedStage: 'judge',
      note: '扫描停在 channel_scanned。要出方案：wmb_continue_after_scan 或 stage=judge 或 spawn planner。'
    };
  }
  if (daily.status === 'running') {
    return {
      businessDate,
      managerActive,
      daily: snapshot,
      nextSuggestedStage: null,
      note: `当日任务进行中：${daily.intent}/${daily.phase}。等 JOB_EVENT 或 wmb_get_job，勿空轮询。`
    };
  }
  return {
    businessDate,
    managerActive,
    daily: snapshot,
    nextSuggestedStage: daily.status === 'succeeded' ? null : 'scan',
    note: `当日最近任务 ${daily.status}/${daily.phase}。`
  };
}
