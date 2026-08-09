import type { DatabaseSync } from 'node:sqlite';
import {
  ROLE_CATALOG,
  roleWriteCommands,
  type RoleId
} from '../shared/agent-capabilities.ts';
import { getAgentTask, getLatestAgentTask, type AgentTask } from './agent-tasks.ts';
import type { EmployeeRole } from './job-pool.ts';
import { deriveIntentForRole } from './role-job-registry.ts';

export type RoleRosterStatus = 'idle' | 'running' | 'blocked' | 'unknown';

export type RoleRosterRow = {
  roleId: RoleId;
  labelZh: string;
  roomZh: string;
  status: RoleRosterStatus;
  summary: string;
  taskId: string | null;
  intent: string | null;
  phase: string | null;
  progressLabel: string | null;
  /** 0..1 when task has planned/processed */
  progressRatio: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  writeCommandCount: number;
};

const ORDER: RoleId[] = ['desk', 'reporter', 'planner', 'writer', 'librarian'];

function mapIntentToRole(intent: string | undefined | null): RoleId | null {
  if (!intent) return null;
  if (intent === 'daily_scan') return 'reporter';
  if (intent === 'daily_judge' || intent === 'results_review') return 'planner';
  if (intent === 'daily_intelligence') return 'planner';
  if (intent === 'studio_draft' || intent === 'page_studio') return 'writer';
  if (intent === 'page_library') return 'librarian';
  if (intent === 'page_discover') return 'reporter';
  if (intent.startsWith('page_')) return 'desk';
  return null;
}

function progressLabel(task: AgentTask): string | null {
  const p = task.progress || {};
  if (typeof p.planned === 'number' && typeof p.processed === 'number') {
    return `渠道 ${p.processed}/${p.planned}` + (p.currentSource ? ` · ${p.currentSource}` : '');
  }
  if (p.opportunityCount != null) return `机会 ${p.opportunityCount}`;
  if (p.saved != null) return `已保存 ${p.saved}`;
  return task.phase || null;
}

function progressRatio(task: AgentTask | null): number | null {
  if (!task || task.status !== 'running') return null;
  const p = task.progress || {};
  const planned = Number(p.planned ?? 0);
  const processed = Number(p.processed ?? 0);
  if (planned > 0) return Math.max(0, Math.min(1, processed / planned));
  // judging phases: indeterminate-ish mid pulse
  const phase = String(task.phase || '');
  if (/judg|synth|validat|running_pi/i.test(phase)) return 0.62;
  if (/scan|channel/i.test(phase)) return 0.28;
  return 0.15;
}

function statusOf(task: AgentTask | null): RoleRosterStatus {
  if (!task) return 'idle';
  if (task.status === 'needs_user') return 'blocked';
  if (task.status === 'running') return 'running';
  return 'idle';
}

export function buildRoleRoster(
  database: DatabaseSync,
  input: {
    businessDate?: string;
    worker?: { taskId: string | null; roleId: string | null; purpose?: 'desk' | 'employee' } | null;
    workers?: Array<{ taskId: string | null; roleId: string | null; purpose?: 'desk' | 'employee' }>;
  } = {}
): RoleRosterRow[] {
  const businessDate = input.businessDate;
  const latestByRole = new Map<RoleId, AgentTask>();

  const intents = [
    'daily_scan',
    'daily_judge',
    'daily_intelligence',
    'studio_draft',
    'results_review',
    'page_today',
    'page_agents',
    'page_discover',
    'page_library',
    'page_studio',
    'page_proposals',
    'page_topic',
    'page_results'
  ] as const;

  for (const intent of intents) {
    const task = businessDate
      ? getLatestAgentTask(database, intent, businessDate)
      : getLatestAgentTask(database, intent);
    if (!task) continue;
    const roleFromContext = typeof task.contextRefs?.roleId === 'string' ? task.contextRefs.roleId as RoleId : null;
    const role = roleFromContext && roleFromContext in ROLE_CATALOG
      ? roleFromContext
      : mapIntentToRole(task.intent);
    if (!role) continue;
    const prev = latestByRole.get(role);
    if (!prev || prev.updatedAt < task.updatedAt) latestByRole.set(role, task);
  }

  const workerHints = [
    ...(input.workers ?? []),
    ...(input.worker ? [input.worker] : [])
  ];
  for (const hint of workerHints) {
    // employee lease 绝不能冒充 desk。
    if (hint?.purpose === 'employee' && (!hint.roleId || hint.roleId === 'desk')) {
      // employee 无 role 或错标 desk：尝试用 task 意图归位
      if (!hint.taskId) continue;
      const task = getAgentTask(database, hint.taskId);
      if (!task || task.status !== 'running') continue;
      const role = (typeof task.contextRefs?.roleId === 'string' && task.contextRefs.roleId in ROLE_CATALOG)
        ? task.contextRefs.roleId as RoleId
        : mapIntentToRole(task.intent);
      if (role && role !== 'desk') latestByRole.set(role, task);
      continue;
    }
    if (hint?.purpose === 'desk') {
      if (!hint.taskId) continue;
      const task = getAgentTask(database, hint.taskId);
      if (task && task.status === 'running') latestByRole.set('desk', task);
      continue;
    }
    if (!hint?.roleId || !(hint.roleId in ROLE_CATALOG)) continue;
    if (hint.roleId === 'desk') continue; // 无 purpose 的 desk 提示不可信
    const role = hint.roleId as RoleId;
    if (!hint.taskId) continue;
    const task = getAgentTask(database, hint.taskId);
    if (task && task.status === 'running') {
      const bound = typeof task.contextRefs?.roleId === 'string' ? task.contextRefs.roleId : mapIntentToRole(task.intent);
      if (bound === role || !bound) latestByRole.set(role, task);
    }
  }

  return ORDER.map((roleId) => {
    const meta = ROLE_CATALOG[roleId];
    const task = latestByRole.get(roleId) ?? null;
    const running = task && task.status === 'running';
    const blocked = task && task.status === 'needs_user';
    let summary = '待命';
    if (running) summary = task!.events?.length ? String(task!.events[task!.events.length - 1]?.message || task!.phase) : (task!.phase || '工作中');
    else if (blocked) summary = task!.errorMessage || '需要你处理';
    else if (task?.finishedAt) summary = `最近：${task.phase || task.status}`;
    return {
      roleId,
      labelZh: meta.labelZh,
      roomZh: meta.roomZh,
      status: statusOf(task),
      summary,
      taskId: task?.id ?? null,
      intent: task?.intent ?? (roleId === 'desk' ? null : deriveIntentForRole(roleId as EmployeeRole)),
      phase: task?.phase ?? null,
      progressLabel: task ? progressLabel(task) : null,
      progressRatio: progressRatio(task),
      createdAt: task?.createdAt ?? null,
      updatedAt: task?.updatedAt ?? null,
      finishedAt: task?.finishedAt ?? null,
      writeCommandCount: roleWriteCommands(roleId).length
    };
  });
}
