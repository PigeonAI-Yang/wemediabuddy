import { broadcastPiEvent } from './app-window.ts';
import { getAgentTask } from './agent-tasks.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import type { PiRpcSupervisor } from './pi-runtime.ts';
import { readPiConversation, writePiConversation } from './pi-conversation.ts';
import { syncManagerTaskFromJob } from './manager-dispatch.ts';
import type { RoleJobReportV1 } from './role-job-registry.ts';
import { buildJobEventEnvelope } from '../shared/job-event-envelope.ts';

let deskPiGetter: () => PiRpcSupervisor | null = () => null;
let runtimeGetter: () => ActiveWorkspaceRuntime | null = () => null;

export function setDeskJobNotifyBridges(input: {
  getPi: () => PiRpcSupervisor | null;
  getRuntime: () => ActiveWorkspaceRuntime | null;
}): void {
  deskPiGetter = input.getPi;
  runtimeGetter = input.getRuntime;
}

type JobLike = {
  id: string;
  roleId?: string;
  intent?: string | null;
  status?: string;
  brief?: string;
  projectId?: string | null;
  businessDate?: string | null;
  error?: string | null;
  report?: RoleJobReportV1 | null;
  waitReason?: string | null;
};

function summarizeTask(runtime: ActiveWorkspaceRuntime | null | undefined, taskId: string | null | undefined) {
  if (!runtime || !taskId) return null;
  try {
    const task = getAgentTask(runtime.database, taskId);
    if (!task) return null;
    const lastEvent = Array.isArray(task.events) && task.events.length ? task.events[task.events.length - 1] : null;
    return {
      id: task.id,
      intent: task.intent,
      status: task.status,
      phase: task.phase,
      progress: task.progress ?? null,
      lastEvent: lastEvent ? { message: lastEvent.message, at: lastEvent.at } : null,
      errorMessage: task.errorMessage
    };
  } catch {
    return null;
  }
}

function buildNotifyText(input: {
  type: string;
  job: JobLike;
  taskId?: string | null;
  task?: ReturnType<typeof summarizeTask>;
}): string {
  const job = input.job;
  const role = job.roleId || 'employee';
  const status = job.status || input.type.replace(/^job\./, '');
  const report = job.report ?? null;
  const lines = [
    `[JOB_EVENT] ${input.type}`,
    `jobId=${job.id}`,
    `role=${role}`,
    `intent=${job.intent || ''}`,
    `status=${status}`,
    report?.code ? `code=${report.code}` : '',
    report?.errorMessage || job.error || input.task?.errorMessage ? `error=${report?.errorMessage || job.error || input.task?.errorMessage}` : '',
    report?.readback ? `readback=${JSON.stringify(report.readback)}` : '',
    job.projectId ? `projectId=${job.projectId}` : '',
    job.businessDate ? `businessDate=${job.businessDate}` : '',
    input.taskId ? `taskId=${input.taskId}` : '',
    input.task?.phase ? `phase=${input.task.phase}` : '',
    input.task?.lastEvent?.message ? `lastEvent=${input.task.lastEvent.message}` : '',
    job.brief ? `brief=${String(job.brief).slice(0, 160)}` : '',
    '',
    status === 'succeeded'
      ? role === 'reporter'
        ? '记者扫描已完成（scan_phase_reached 读回）。若要出方案，请调用 wmb_continue_after_scan 或 wmb_run_daily_stage(stage=judge) 或派 planner。不要再 sleep 轮询。'
        : '员工工单已完成（读回已核验）。请立即向用户汇报结果；写手单用 wmb_get_content(projectId) 验收正文。不要再 sleep/轮询，也不要 bash 读 session。'
      : status === 'partial'
      ? '员工工单部分完成（partial，读回部分达成）。请向用户说明已达成部分，并决定续派补全。'
      : status === 'needs_user'
      ? '员工工单需要你介入（needs_user）。请按 code/message 处理：补充材料、改派或人工验收。'
      : status === 'waiting_resource'
      ? '员工工单等待资源（waiting_resource）。资源释放后会自动晋升；可先处理其他事项或取消该工单。'
      : status === 'failed' || status === 'cancelled'
        ? '员工工单未成功。请向用户说明原因，并决定重派、改 brief，或取消后续步骤。不要再无意义轮询。'
        : '员工工单状态更新。用 wmb_get_job 查看 monitor.task；不要 bash 翻文件。'
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 工单终态推送给主编席：UI 事件 + desk Pi steer/followUp/短回合。
 * 这是「做完通知一声」的通道；主管不应再靠 bash+sleep 轮询。
 */
export async function notifyDeskJobEvent(input: {
  type: string;
  job: JobLike;
  runtime?: ActiveWorkspaceRuntime | null;
  getPi?: () => PiRpcSupervisor | null;
  handle?: { taskId?: string | null; sessionFile?: string | null } | null;
}): Promise<void> {
  const type = String(input.type || '');
  // 只推关键节点，避免 started 刷屏；started 仍给 UI。waiting_resource 只推 UI，不推 Pi 短回合。
  const terminal = type === 'job.finished' || type === 'job.failed' || type === 'job.cancelled' || type === 'job.partial' || type === 'job.needs_user';
  const noteworthy = terminal || type === 'job.started' || type === 'job.waiting_resource';
  if (!noteworthy) return;

  const runtime = input.runtime ?? runtimeGetter();
  const taskId = input.handle?.taskId ?? null;
  const task = summarizeTask(runtime, taskId);
  const text = buildNotifyText({ type, job: input.job, taskId, task });

  broadcastPiEvent({
    type: 'job_event',
    scope: 'dock',
    action: type,
    jobId: input.job.id,
    roleId: input.job.roleId,
    status: input.job.status,
    intent: input.job.intent,
    projectId: input.job.projectId,
    taskId,
    task,
    code: input.job.report?.code ?? null,
    readback: input.job.report?.readback ?? null,
    report: input.job.report ?? null,
    waitReason: input.job.waitReason ?? null,
    text,
    terminal
  });

  if (runtime && type !== 'job.waiting_resource') {
    try {
      await syncManagerTaskFromJob(runtime, {
        businessDate: input.job.businessDate,
        jobId: input.job.id,
        roleId: input.job.roleId,
        intent: input.job.intent,
        status: input.job.status,
        taskId,
        brief: input.job.brief
      });
    } catch (error) {
      console.error('[manager-job-notify] checkpoint sync failed', error);
    }
  }

  if (!terminal) return;

  const pi = input.getPi?.() ?? deskPiGetter();
  const dataRootPath = runtime?.identity.rootPath;
  const wrapped = buildJobEventEnvelope({ objectId: input.job.id, text });

  try {
    if (pi?.isActive) {
      await pi.followUp(wrapped);
      broadcastPiEvent({ type: 'queued', delivery: 'followUp', scope: 'dock', reason: 'job_event' });
      return;
    }
    if (pi?.isRunning) {
      // desk 进程在、无活跃回合：开短回合叫醒主管
      broadcastPiEvent({ type: 'starting', scope: 'dock', reason: 'job_event' });
      const result = await pi.promptUntilSettled(wrapped, {});
      broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, thinking: result.thinking, scope: 'dock', reason: 'job_event' });
      return;
    }
  } catch (error) {
    console.error('[manager-job-notify] desk push failed', error);
  }

  // desk 未在线：至少写入会话，用户打开对话框能看见
  if (!dataRootPath) return;
  try {
    const current = await readPiConversation(dataRootPath);
    const createdAt = new Date().toISOString();
    await writePiConversation(dataRootPath, {
      id: current.id,
      title: current.title,
      sessionFile: current.sessionFile,
      sessionId: current.sessionId,
      messages: [
        ...current.messages,
        { role: 'user', text: visibleJobNotice(text), createdAt, kind: 'system_event' },
        {
          role: 'assistant',
          text: '（系统）员工工单已有终态。打开对话后我会据此汇报；也可让我立即验收。',
          createdAt,
          segments: [{ kind: 'text', text: '（系统）员工工单已有终态。打开对话后我会据此汇报；也可让我立即验收。' }]
        }
      ],
      createdAt: current.createdAt,
      makeActive: true
    });
  } catch (error) {
    console.error('[manager-job-notify] conversation write failed', error);
  }
}

function visibleJobNotice(text: string): string {
  return text.replace(/^\[WMB_CONTEXT\][\s\S]*?\[USER_MESSAGE\]\n?/m, '').trim() || text;
}
