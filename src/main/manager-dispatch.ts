import { randomUUID } from 'node:crypto';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { dispatchFailAgentTask, dispatchReportAgentTaskProgress, dispatchStartAgentTask } from './agent-task-commands.ts';
import { readPiConversation, writePiConversation } from './pi-conversation.ts';
import {
  MANAGER_TASK_INTENT,
  buildManagerTaskCardText,
  buildManagerEventText,
  createManagerTaskCheckpoint,
  getActiveManagerTask,
  managerSummaryFromChildProgress,
  managerTaskSerialDecision,
  patchManagerCheckpoint,
  type ManagerChildRef,
  type ManagerTaskCheckpoint,
  type ManagerTaskView
} from './manager-task.ts';
import { getActiveDailyIntelligenceTask, getAgentTask, getLatestDailyIntelligenceTaskSince, type AgentTask } from './agent-tasks.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { shanghaiDate } from './ferment.ts';
import { runDockManagerPrompt, markDockOrchestrationFailed } from './ipc-pi-dock.ts';

export type DispatchManagerDailyInput = {
  businessDate: string;
  modules?: Array<'official_web' | 'x_lists'>;
  /** Escape hatch: skip manager and let caller run legacy only. */
  legacyPipeline?: boolean;
};

export type DispatchManagerDailyResult = {
  action: 'created' | 'focus_existing';
  focusDialog: true;
  managerTask: ManagerTaskView;
  /** When created, caller should start legacy pipeline and link child. */
  shouldStartLegacyPipeline: boolean;
  modules?: Array<'official_web' | 'x_lists'>;
};

function schedulerActor() {
  return { type: 'scheduler' as const, id: 'manager-dispatch', label: 'manager-dispatch' };
}

/**
 * WMB-5178 §5/§10.1：今日情报编排生产者（Owner 触发 + 应用代写 + 派发到 Dock）。
 * 返回完整安全字段（originLabel/title/goal/acceptance）供信封盖章；任一缺失由 builder 在派发前抛错。
 */
export function buildTodayIntelligenceDispatch(businessDate: string, managerTaskId: string): {
  dispatchId: string;
  message: string;
  orchestration: { dispatchId: string; delivery: 'direct'; safe: { originLabel: string; title: string; goal: string; acceptance: string } };
} {
  const dispatchId = randomUUID();
  const message = [
    `请执行今日情报编排（${businessDate}）。`,
    '验收：可信渠道回执 + 当日可批方案。',
    '你是主管，编排方式由你选：',
    '• 单项采集：wmb_run_daily_stage(stage=scan) 或 wmb_spawn_job(reporter)',
    '• 单项策划：wmb_run_daily_stage(stage=judge) 或 wmb_spawn_job(planner)',
    '• 一条龙：wmb_run_daily_stage(stage=full)',
    '• 采完后续接策划：wmb_continue_after_scan（该续就调）',
    '先 wmb_daily_readiness；工单终态等 JOB_EVENT 推送，不要 sleep/bash 轮询；必要时 wmb_get_job。',
    `managerTaskId=${managerTaskId}`
  ].join('\n');
  return {
    dispatchId,
    message,
    orchestration: {
      dispatchId,
      delivery: 'direct',
      safe: { originLabel: '今日情报', title: '今日情报编排', goal: '采集并判读当日情报，产出可批方案', acceptance: '可信渠道回执 + 当日可批方案' }
    }
  };
}

async function appendManagerCardToDialog(dataRootPath: string, view: ManagerTaskView): Promise<void> {
  try {
    const conversation = await readPiConversation(dataRootPath);
    // 同一目标+日期只保留一张活卡，避免刷屏
    const marker = `manager_task:daily_intelligence:${view.businessDate}`;
    const text = `${buildManagerTaskCardText(view)}\n<!-- ${marker} -->`;
    // 清掉旧版技术检查点卡 / 其它 taskId 残留，避免对话框像日志墙
    const cleaned = conversation.messages.filter((message) => {
      if (message.role !== 'assistant' || typeof message.text !== 'string') return true;
      const text = message.text;
      if (text.includes('【主管任务】') && (text.includes('状态：') || text.includes('taskId=') || text.includes('reporter:') || text.includes('phase'))) return false;
      if (text.includes('<!-- manager_task:daily_intelligence:') && !text.includes(marker)) return false;
      return true;
    });
    const messages = [...cleaned];
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'assistant' && typeof message.text === 'string' && message.text.includes(marker)) {
        idx = i;
        break;
      }
    }
    // 无变化不写，减少对话跳动
    if (idx >= 0 && messages[idx].text === text) return;

    const nextMessage = {
      role: 'assistant' as const,
      text,
      createdAt: idx >= 0 ? messages[idx].createdAt : new Date().toISOString(),
      segments: [{ kind: 'text' as const, text }]
    };
    if (idx >= 0) messages[idx] = nextMessage;
    else messages.push(nextMessage);

    await writePiConversation(dataRootPath, {
      id: conversation.id,
      sessionFile: conversation.sessionFile,
      sessionId: conversation.sessionId,
      title: conversation.title === '新会话' || conversation.title === 'Pi' || conversation.title === '这个是在说啥'
        ? '主管 · 今日情报'
        : conversation.title,
      messages,
      makeActive: true
    });
    broadcastDataChanged({ scopes: ['agent'], reason: 'manager.dialog_card' });
  } catch (error) {
    console.error('[manager-dispatch] append dialog card failed', error);
  }
}

async function appendManagerEvent(dataRootPath: string, line: string): Promise<void> {
  try {
    const conversation = await readPiConversation(dataRootPath);
    const text = buildManagerEventText(line);
    // 去重：最后一条相同事件不重复
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role === 'assistant' && last.text === text) return;
    const messages = [
      ...conversation.messages,
      {
        role: 'assistant' as const,
        text,
        createdAt: new Date().toISOString(),
        segments: [{ kind: 'text' as const, text }]
      }
    ];
    await writePiConversation(dataRootPath, {
      id: conversation.id,
      sessionFile: conversation.sessionFile,
      sessionId: conversation.sessionId,
      messages,
      makeActive: true
    });
    broadcastDataChanged({ scopes: ['agent'], reason: 'manager.dialog_event' });
  } catch (error) {
    console.error('[manager-dispatch] append event failed', error);
  }
}

export async function updateManagerTaskCheckpoint(
  runtime: ActiveWorkspaceRuntime,
  managerTaskId: string,
  patch: Partial<Pick<ManagerTaskCheckpoint, 'status' | 'phase' | 'summary' | 'children' | 'legacyPipeline'>>,
  message?: string
): Promise<ManagerTaskView | null> {
  const current = getAgentTask(runtime.database, managerTaskId);
  if (!current || current.intent !== MANAGER_TASK_INTENT || current.status !== 'running') return null;
  const base = createManagerTaskCheckpoint({ businessDate: current.businessDate });
  const existing = (current.checkpoint && typeof current.checkpoint === 'object' && (current.checkpoint as ManagerTaskCheckpoint).kind === 'manager_task')
    ? current.checkpoint as ManagerTaskCheckpoint
    : base;
  const next = patchManagerCheckpoint(existing, patch);
  const updated = await dispatchReportAgentTaskProgress(runtime, managerTaskId, {
    phase: next.phase,
    checkpoint: next as unknown as Record<string, unknown>,
    progress: {
      opportunityCount: next.children.filter((child) => child.status === 'succeeded').length,
      message: next.summary
    },
    message,
    level: 'info'
  }, {
    actor: schedulerActor(),
    requestId: randomUUID(),
    taskId: managerTaskId
  });
  return {
    id: updated.id,
    intent: MANAGER_TASK_INTENT,
    businessDate: updated.businessDate,
    status: updated.status,
    phase: updated.phase,
    progress: updated.progress,
    checkpoint: next,
    errorCode: updated.errorCode,
    errorMessage: updated.errorMessage,
    updatedAt: updated.updatedAt,
    createdAt: updated.createdAt
  };
}

/**
 * Owner lock path: Today intelligence button → manager task first (serial).
 * Returns focus_existing when a manager task is already active.
 */
export async function dispatchManagerDailyIntelligence(
  runtime: ActiveWorkspaceRuntime,
  dataRootPath: string,
  input: DispatchManagerDailyInput
): Promise<DispatchManagerDailyResult> {
  const businessDate = input.businessDate.trim();
  if (!businessDate) throw new Error('请选择今日情报日期。');

  const active = getActiveManagerTask(runtime.database, businessDate);
  const gate = managerTaskSerialDecision(active);
  if (gate.action === 'focus_existing' && gate.active) {
    return {
      action: 'focus_existing',
      focusDialog: true,
      managerTask: gate.active,
      shouldStartLegacyPipeline: false
    };
  }

  const started = await dispatchStartAgentTask(runtime, {
    intent: MANAGER_TASK_INTENT,
    businessDate,
    contextRefs: {
      page: 'agents',
      roleId: 'desk',
      goal: 'daily_intelligence',
      manager: true,
      workspaceId: runtime.identity.workspaceId
    }
  }, {
    actor: schedulerActor(),
    requestId: `manager-daily:${businessDate}:${randomUUID()}`
  });

  const checkpoint = createManagerTaskCheckpoint({
    businessDate,
    status: 'running',
    phase: 'dispatch_reporter',
    summary: '主管已接单：今日情报 · 准备派记者扫描',
    children: [{
      roleId: 'reporter',
      brief: '扫描今日情报渠道并回报',
      intent: 'daily_scan',
      status: 'queued'
    }],
    legacyPipeline: input.legacyPipeline !== false
  });

  const updated = await dispatchReportAgentTaskProgress(runtime, started.task.id, {
    phase: 'dispatch_reporter',
    checkpoint: checkpoint as unknown as Record<string, unknown>,
    progress: { message: checkpoint.summary },
    message: '主管已接单：今日情报',
    level: 'info'
  }, {
    actor: schedulerActor(),
    requestId: randomUUID(),
    taskId: started.task.id
  });

  const view: ManagerTaskView = {
    id: updated.id,
    intent: MANAGER_TASK_INTENT,
    businessDate: updated.businessDate,
    status: updated.status,
    phase: updated.phase,
    progress: updated.progress,
    checkpoint,
    errorCode: updated.errorCode,
    errorMessage: updated.errorMessage,
    updatedAt: updated.updatedAt,
    createdAt: updated.createdAt
  };

  broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'manager.task_created' });

  // 真主管 Pi 回合：与手动发消息同一通道，由主管自己 wmb_spawn_job 派工。
  // 不 await：按钮立刻返回；工具行/回复走 onPiEvent。WMB-5178：经 canonical 信封显式盖章 + 完整安全字段。
  const dispatch = buildTodayIntelligenceDispatch(businessDate, view.id);
  void runDockManagerPrompt({
    message: dispatch.message,
    page: 'agents',
    pageLabel: '班组 · 主管',
    objectType: 'manager_task',
    objectId: view.id,
    orchestration: dispatch.orchestration
  }).catch(async (error) => {
    console.error('[manager-dispatch] dock manager prompt failed', error);
    try {
      await dispatchFailAgentTask(runtime, view.id, 'MANAGER_DOCK_FAILED', error instanceof Error ? error.message : String(error), {
        actor: schedulerActor(),
        requestId: randomUUID(),
        taskId: view.id
      });
      // §8/§16-3 接受后失败：同 dispatchId 原地更新为「安排失败 + 人类可读错误」；接受前失败无行则 no-op。
      await markDockOrchestrationFailed(dataRootPath, dispatch.dispatchId, error instanceof Error ? error.message : String(error));
      broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'manager.dock_failed' });
    } catch (failError) {
      console.error('[manager-dispatch] fail manager after dock error', failError);
    }
  });

  return {
    action: 'created',
    focusDialog: true,
    managerTask: view,
    shouldStartLegacyPipeline: false,
    modules: input.modules
  };
}

/** Bridge legacy daily child task progress into manager checkpoint summary. */
export async function syncManagerTaskFromLegacyChild(
  runtime: ActiveWorkspaceRuntime,
  businessDate: string,
  child: AgentTask | null | undefined
): Promise<ManagerTaskView | null> {
  const manager = getActiveManagerTask(runtime.database, businessDate);
  if (!manager || !child) return manager;
  if (!(child.intent === 'daily_scan' || child.intent === 'daily_judge' || child.intent === 'daily_intelligence')) return manager;

  const plannerPhase = child.intent === 'daily_intelligence' && ['running_pi', 'judging_opportunities', 'synthesizing', 'validating', 'plan_ready', 'completed'].includes(child.phase);
  const roleId = child.intent === 'daily_judge' || plannerPhase ? 'planner' : 'reporter';
  const childStatus =
    child.status === 'running' ? 'running'
      : child.status === 'succeeded' ? 'succeeded'
        : child.status === 'cancelled' ? 'cancelled'
          : child.status === 'partial' ? 'succeeded'
            : child.status === 'failed' || child.status === 'interrupted' ? 'failed'
              : 'queued';

  const summary = managerSummaryFromChildProgress({
    phase: child.phase,
    childLabel: roleId === 'reporter' ? '记者扫描' : '策划生成方案',
    processed: typeof child.progress?.processed === 'number' ? child.progress.processed : undefined,
    planned: typeof child.progress?.planned === 'number' ? child.progress.planned : undefined,
    message: typeof child.progress?.message === 'string' ? child.progress.message : (child.events.at(-1)?.message ?? null)
  });

  const children = [...manager.checkpoint.children];
  const idx = children.findIndex((row) => row.roleId === roleId);
  const row: ManagerChildRef = {
    roleId,
    brief: roleId === 'reporter' ? '扫描今日情报渠道并回报' : '基于扫描生成今日方案',
    intent: child.intent,
    jobId: children[idx]?.jobId ?? null,
    taskId: child.id,
    status: childStatus as ManagerChildRefStatus,
    startedAt: children[idx]?.startedAt ?? child.createdAt,
    finishedAt: child.status === 'running' ? null : child.finishedAt
  };
  if (idx >= 0) children[idx] = row;
  else children.push(row);

  let phase = manager.checkpoint.phase;
  let status = manager.checkpoint.status;
  if (roleId === 'reporter' && child.status === 'running') {
    phase = 'monitor_reporter';
    status = 'running';
  } else if (roleId === 'reporter' && (child.status === 'succeeded' || child.status === 'partial')) {
    phase = 'dispatch_planner';
    status = 'running';
  } else if (roleId === 'planner' && child.status === 'running') {
    phase = 'monitor_planner';
    status = 'running';
  } else if (roleId === 'planner' && (child.status === 'succeeded' || child.status === 'partial' || child.status === 'needs_user')) {
    phase = 'report';
    status = 'waiting_human';
  } else if (child.status === 'failed' || child.status === 'interrupted') {
    status = 'failed';
  } else if (child.status === 'cancelled') {
    status = 'cancelled';
  }

  const prev = manager.checkpoint;
  const nextSummary = status === 'waiting_human' ? `${summary} · 需要你回今日批准` : summary;
  if (prev.status === status && prev.phase === phase && prev.summary === nextSummary && JSON.stringify(prev.children) === JSON.stringify(children)) return manager;
  const synced = await updateManagerTaskCheckpoint(runtime, manager.id, {
    status,
    phase,
    summary: nextSummary,
    children
  });
  // 进度由真 Pi 工具结果与 jobs/agent events 驱动；不再做假 tool 投影。
  return synced;
}


type ManagerChildRefStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';


/** F2: 工单事件回写 manager checkpoint.children（jobId↔taskId）。 */
export async function syncManagerTaskFromJob(
  runtime: ActiveWorkspaceRuntime,
  input: {
    businessDate?: string | null;
    jobId: string;
    roleId?: string | null;
    intent?: string | null;
    status?: string | null;
    taskId?: string | null;
    brief?: string | null;
  }
): Promise<ManagerTaskView | null> {
  const businessDate = (input.businessDate || '').trim() || shanghaiDate();
  const manager = getActiveManagerTask(runtime.database, businessDate);
  if (!manager) return null;

  const roleId = (
    input.roleId === 'reporter' || input.roleId === 'planner' || input.roleId === 'writer' || input.roleId === 'librarian'
      ? input.roleId
      : input.intent === 'daily_judge' ? 'planner'
        : input.intent === 'studio_draft' ? 'writer'
          : input.intent === 'daily_scan' || input.intent === 'daily_intelligence' ? 'reporter'
            : null
  ) as 'reporter' | 'planner' | 'writer' | 'librarian' | null;
  if (!roleId) return manager;

  const childStatus =
    input.status === 'running' || input.status === 'queued' ? (input.status as 'running' | 'queued')
      : input.status === 'succeeded' ? 'succeeded'
        : input.status === 'cancelled' ? 'cancelled'
          : input.status === 'failed' ? 'failed'
            : input.status === 'partial' ? 'succeeded'
              : 'running';

  const children = [...manager.checkpoint.children];
  let idx = children.findIndex((row) => row.jobId === input.jobId);
  if (idx < 0) idx = children.findIndex((row) => row.roleId === roleId && (!row.jobId || row.status === 'queued'));
  const prev = idx >= 0 ? children[idx] : null;
  const row = {
    roleId,
    brief: (input.brief || prev?.brief || `${roleId} 工单`).slice(0, 200),
    intent: input.intent ?? prev?.intent ?? null,
    jobId: input.jobId,
    taskId: input.taskId ?? prev?.taskId ?? null,
    status: childStatus as ManagerChildRefStatus,
    startedAt: prev?.startedAt ?? (childStatus === 'queued' ? null : new Date().toISOString()),
    finishedAt: childStatus === 'running' || childStatus === 'queued' ? null : new Date().toISOString()
  };
  if (idx >= 0) children[idx] = row;
  else children.push(row);

  let phase = manager.checkpoint.phase;
  let status = manager.checkpoint.status;
  if (roleId === 'reporter' && childStatus === 'running') { phase = 'monitor_reporter'; status = 'running'; }
  else if (roleId === 'reporter' && (childStatus === 'succeeded')) { phase = 'dispatch_planner'; status = 'running'; }
  else if (roleId === 'planner' && childStatus === 'running') { phase = 'monitor_planner'; status = 'running'; }
  else if (roleId === 'planner' && childStatus === 'succeeded') { phase = 'report'; status = 'waiting_human'; }
  else if (roleId === 'writer' && childStatus === 'running') { status = 'running'; }
  else if (childStatus === 'failed') { status = 'failed'; }
  else if (childStatus === 'cancelled') { status = 'cancelled'; }

  return updateManagerTaskCheckpoint(runtime, manager.id, {
    status,
    phase,
    summary: manager.checkpoint.summary,
    children
  });
}


export function readManagerProjection(runtime: ActiveWorkspaceRuntime, businessDate: string): {
  managerTask: ManagerTaskView | null;
  legacyChild: AgentTask | null;
} {
  const managerTask = getActiveManagerTask(runtime.database, businessDate);
  const legacyChild = managerTask
    ? getLatestDailyIntelligenceTaskSince(runtime.database, businessDate, managerTask.createdAt)
    : getActiveDailyIntelligenceTask(runtime.database, businessDate);
  return { managerTask, legacyChild };
}
