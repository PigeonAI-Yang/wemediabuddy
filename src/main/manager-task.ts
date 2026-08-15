import type { DatabaseSync } from 'node:sqlite';
import { getActiveAgentTask, getAgentTask, type AgentTask } from './agent-tasks.ts';

/** Owner locks 2026-08-08: dock pinned to manager; serial one ManagerTask; approve on Today. */
export const MANAGER_TASK_INTENT = 'page_agents' as const;

export type ManagerTaskStatus =
  | 'accepted'
  | 'running'
  | 'waiting_human'
  | 'reporting'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type ManagerTaskPhase =
  | 'accepted'
  | 'dispatch_reporter'
  | 'monitor_reporter'
  | 'dispatch_planner'
  | 'monitor_planner'
  | 'report'
  | 'done';

export type ManagerChildRef = {
  roleId: 'reporter' | 'planner' | 'writer' | 'librarian';
  brief: string;
  intent?: string | null;
  jobId?: string | null;
  taskId?: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type ManagerTaskCheckpoint = {
  version: 1;
  kind: 'manager_task';
  goal: 'daily_intelligence';
  businessDate: string;
  status: ManagerTaskStatus;
  phase: ManagerTaskPhase;
  acceptance: string;
  summary: string;
  children: ManagerChildRef[];
  legacyPipeline: boolean;
  updatedAt: string;
};

export type ManagerTaskView = {
  id: string;
  intent: typeof MANAGER_TASK_INTENT;
  businessDate: string;
  status: string;
  phase: string;
  progress: AgentTask['progress'];
  checkpoint: ManagerTaskCheckpoint;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
  createdAt: string;
};

export function isManagerTaskCheckpoint(value: unknown): value is ManagerTaskCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ManagerTaskCheckpoint>;
  return row.version === 1 && row.kind === 'manager_task' && row.goal === 'daily_intelligence' && typeof row.businessDate === 'string';
}

export function defaultDailyIntelligenceAcceptance(): string {
  return '可信渠道回执 + 当日可批方案';
}

export function createManagerTaskCheckpoint(input: {
  businessDate: string;
  summary?: string;
  phase?: ManagerTaskPhase;
  status?: ManagerTaskStatus;
  children?: ManagerChildRef[];
  legacyPipeline?: boolean;
}): ManagerTaskCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: 'manager_task',
    goal: 'daily_intelligence',
    businessDate: input.businessDate,
    status: input.status ?? 'accepted',
    phase: input.phase ?? 'accepted',
    acceptance: defaultDailyIntelligenceAcceptance(),
    summary: input.summary ?? '主管已接单：今日情报',
    children: input.children ?? [],
    legacyPipeline: input.legacyPipeline ?? true,
    updatedAt: now
  };
}

export function managerTaskFromAgent(task: AgentTask | null | undefined): ManagerTaskView | null {
  if (!task || task.intent !== MANAGER_TASK_INTENT) return null;
  const checkpoint = isManagerTaskCheckpoint(task.checkpoint) ? task.checkpoint : null;
  if (!checkpoint) return null;
  return {
    id: task.id,
    intent: MANAGER_TASK_INTENT,
    businessDate: task.businessDate,
    status: task.status,
    phase: task.phase,
    progress: task.progress,
    checkpoint,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt
  };
}

export function getActiveManagerTask(database: DatabaseSync, businessDate: string): ManagerTaskView | null {
  const task = getActiveAgentTask(database, MANAGER_TASK_INTENT, businessDate);
  return managerTaskFromAgent(task);
}

export function getManagerTaskById(database: DatabaseSync, id: string): ManagerTaskView | null {
  return managerTaskFromAgent(getAgentTask(database, id));
}

/** Serial gate: one active manager task per business date (Owner lock #2). */
export function managerTaskSerialDecision(active: ManagerTaskView | null): {
  action: 'create' | 'focus_existing';
  active: ManagerTaskView | null;
} {
  if (active && (active.status === 'running' || active.checkpoint.status === 'running' || active.checkpoint.status === 'accepted' || active.checkpoint.status === 'waiting_human' || active.checkpoint.status === 'reporting')) {
    // agent_tasks.status may still be running while checkpoint carries finer status
    if (active.status === 'running' || ['accepted', 'running', 'waiting_human', 'reporting'].includes(active.checkpoint.status)) {
      return { action: 'focus_existing', active };
    }
  }
  return { action: 'create', active: null };
}

export function patchManagerCheckpoint(
  current: ManagerTaskCheckpoint,
  patch: Partial<Pick<ManagerTaskCheckpoint, 'status' | 'phase' | 'summary' | 'children' | 'legacyPipeline'>>
): ManagerTaskCheckpoint {
  return {
    ...current,
    ...patch,
    children: patch.children ?? current.children,
    updatedAt: new Date().toISOString()
  };
}

export function managerSummaryFromChildProgress(input: {
  phase: string;
  childLabel: string;
  processed?: number;
  planned?: number;
  message?: string | null;
}): string {
  const frac =
    typeof input.processed === 'number' && typeof input.planned === 'number' && input.planned > 0
      ? ` ${input.processed}/${input.planned}`
      : '';
  const msg = input.message?.trim();
  if (msg) return `今日情报 · ${input.childLabel}${frac} · ${msg.slice(0, 80)}`;
  return `今日情报 · ${input.childLabel}${frac}`.trim();
}

const ROLE_ZH: Record<string, string> = {
  reporter: '记者',
  planner: '策划',
  writer: '写手',
  librarian: '资料员'
};

function childStatusZh(status: string): string {
  if (status === 'running') return '进行中';
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'blocked') return '受阻';
  if (status === 'queued') return '排队中';
  return status;
}

/** 对话里给人看的进度卡：像 main→subagent 叙事，不甩内部 phase/id。 */
export function buildManagerTaskCardText(view: ManagerTaskView): string {
  const c = view.checkpoint;
  const lines = ['主管正在处理：今日情报', ''];
  if (c.children.length === 0) {
    lines.push('· 已接单，准备分派');
  } else {
    for (const child of c.children) {
      const name = ROLE_ZH[child.roleId] || child.roleId;
      lines.push(`· ${name} ${childStatusZh(child.status)}${child.brief ? ` — ${child.brief}` : ''}`);
    }
  }
  lines.push('');
  lines.push(c.summary || '进度更新中…');
  if (c.status === 'waiting_human') {
    lines.push('');
    lines.push('需要你确认：请回今日页查看/批准方案。');
  }
  return lines.join('\n');
}

export function buildManagerEventText(event: string): string {
  return event;
}
