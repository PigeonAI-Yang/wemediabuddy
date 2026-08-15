import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { recordOperation } from './operations.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { getAgentTask, isPageAgentIntent, type AgentTask } from './agent-tasks.ts';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

/**
 * WMB-5186：page_* 心跳触碰与失活收尸。不变量：running page task 随活跃回合刷新
 * heartbeat_at/updated_at；失活超过保守阈值且无 live worker 绑定 → interrupted +
 * PAGE_TASK_ORPHANED + finished_at + operation_log 审计；条件更新保证与回合心跳并发
 * 零竞态、重复调用零二次写；不新增状态枚举、page_* 不入 JobPool、不隐藏 starting。
 * 裸 DB helpers 供纯逻辑测试；sweep 走 dispatchReapOrphanedPageTasks 经真实 dispatch
 * 进入写授权深度（WMB_WRITE_REQUIRES_COMMAND_DISPATCH），不新增命令/Capability。
 */

export const PAGE_TASK_ORPHANED_ERROR_CODE = 'PAGE_TASK_ORPHANED';

/** page_* 失活保守阈值：沿用 daily 族墙钟 stall 语义，默认 30min（远大于正常回合间隔），env 可测（下限 1s）。 */
export function pageTaskOrphanMs(): number {
  const raw = process.env.WMB_PAGE_TASK_ORPHAN_MS;
  if (raw == null || String(raw).trim() === '') return 30 * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30 * 60_000;
  return Math.max(1_000, n);
}

/** WMB-5186：活跃回合心跳触碰。仅刷新 heartbeat_at/updated_at，保留 phase/status；条件更新零竞态、重复调用零二次写。 */
export function touchAgentTaskHeartbeat(database: DatabaseSync, id: string): CommandResult<AgentTask> {
  const current = getAgentTask(database, id);
  if (!current) return failure('NOT_FOUND', 'Agent 任务不存在。');
  if (current.status !== 'running') return failure('INVALID_STATE', '只有运行中的任务可以刷新心跳。');
  const now = new Date().toISOString();
  database.prepare(`UPDATE agent_tasks SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(now, now, id);
  const refreshed = getAgentTask(database, id);
  return refreshed ? success(refreshed) : failure('NOT_FOUND', 'Agent 任务不存在。');
}

/** WMB-5186：候选 page_* 失活行——status=running + 心跳陈旧超过阈值 + isPageAgentIntent 精确过滤。 */
export function listOrphanedPageTasks(database: DatabaseSync, nowMs = Date.now()): AgentTask[] {
  const cutoff = new Date(nowMs - pageTaskOrphanMs()).toISOString();
  const ids = database.prepare(`SELECT id FROM agent_tasks
    WHERE status = 'running' AND intent LIKE 'page_%' AND updated_at <= ?`).all(cutoff) as Array<{ id: string }>;
  return ids.flatMap(({ id }) => {
    const task = getAgentTask(database, id);
    return task && isPageAgentIntent(task.intent) ? [task] : [];
  });
}

/** WMB-5186：单行 page_* 失活收尸。条件更新（status='running' AND updated_at<=截止线）原子判定——并发时最新心跳胜出、重复调用零二次写；转 interrupted + 明确 error_code + finished_at + 审计。live 守卫由调用方以真实运行时绑定判定。 */
export function interruptPageTaskOrphan(database: DatabaseSync, id: string, nowMs = Date.now()): CommandResult<AgentTask> & { transitioned: boolean } {
  if (!getAgentTask(database, id)) return { ...failure<AgentTask>('NOT_FOUND', 'Agent 任务不存在。'), transitioned: false };
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - pageTaskOrphanMs()).toISOString();
  const result = database.prepare(`UPDATE agent_tasks SET status = 'interrupted', phase = 'interrupted',
    error_code = ?, error_message = '页面任务长时间无活跃回合且无存活 Pi worker，已自动中断。',
    updated_at = ?, finished_at = COALESCE(finished_at, ?)
    WHERE id = ? AND status = 'running' AND updated_at <= ?`).run(PAGE_TASK_ORPHANED_ERROR_CODE, now, now, id, cutoff);
  const transitioned = Number(result.changes ?? 0) > 0;
  if (transitioned) {
    recordOperation(database, {
      actorType: 'scheduler',
      command: 'agent_tasks.interrupt_page_orphan',
      entityType: 'agent_task',
      entityId: id,
      result: 'error',
      errorCode: PAGE_TASK_ORPHANED_ERROR_CODE
    });
    broadcastDataChanged({ scopes: ['agent', 'today'], reason: 'agent.page_orphan_interrupted' });
  }
  const task = getAgentTask(database, id);
  return { ok: true, data: task!, error: null, transitioned };
}

/** WMB-5186：page_* 失活收尸编排。候选行逐一经 live-worker 守卫（真实运行时绑定，由调用方注入）过滤后条件收尸；返回本次实际转终态的任务，重复调用幂等。 */
export function reapOrphanedPageTasks(
  database: DatabaseSync,
  isLiveWorker: (taskId: string) => boolean,
  nowMs = Date.now()
): { reaped: AgentTask[] } {
  const reaped: AgentTask[] = [];
  for (const candidate of listOrphanedPageTasks(database, nowMs)) {
    if (isLiveWorker(candidate.id)) continue;
    const result = interruptPageTaskOrphan(database, candidate.id, nowMs);
    if (result.ok && result.transitioned) reaped.push(result.data);
  }
  return { reaped };
}

/**
 * WMB-5186：sweep 专用 runtime 调度包装。ActiveWorkspaceRuntime 已安装写守卫，裸 DB
 * 收尸写必抛 WMB_WRITE_REQUIRES_COMMAND_DISPATCH（实机 page_* 孤儿不收敛的根因）；
 * 本包装经 dispatchBusinessCommand → runtime.dispatchCommand 进入写授权深度后执行
 * reapOrphanedPageTasks，返回本轮真实转终态任务。dispatch 前先只读短路：无 eligible
 * 候选（零失活或全部被 live worker 绑定）直接返回空结果，避免空轮 no-op
 * command_receipt/operation audit 每 60s 无谓增长；真实 dispatch 内仍重新 list +
 * 条件更新，与回合心跳的竞态判定不变。复用既有 scheduler-only 生命周期命令标签
 * agent_tasks.recover_interrupted（不新增命令/Capability）；requestId 每轮唯一
 * （runtimeEpoch + randomUUID）且经 command_receipts 可审计；page 收尸审计仍由
 * interruptPageTaskOrphan 写 agent_tasks.interrupt_page_orphan。
 */
export async function dispatchReapOrphanedPageTasks(
  runtime: ActiveWorkspaceRuntime,
  isLiveWorker: (taskId: string) => boolean,
  nowMs = Date.now()
): Promise<{ reaped: AgentTask[] }> {
  const eligible = listOrphanedPageTasks(runtime.database, nowMs).some((candidate) => !isLiveWorker(candidate.id));
  if (!eligible) return { reaped: [] };
  const receipt = await dispatchBusinessCommand<{ nowMs: number }, { reaped: AgentTask[] }>(runtime, {
    command: 'agent_tasks.recover_interrupted',
    requestId: `${runtime.identity.runtimeEpoch}:page-orphan-reap:${randomUUID()}`,
    actor: { type: 'scheduler', id: 'page-orphan-sweeper', label: 'page-orphan-sweeper' },
    input: { nowMs },
    boundIdentity: runtime.identity,
    entityType: 'agent_task',
    execute: (database) => ({ data: reapOrphanedPageTasks(database, isLiveWorker, nowMs) })
  });
  return requireCommandResultData(receiptAsCommandResult<{ reaped: AgentTask[] }>(receipt));
}
