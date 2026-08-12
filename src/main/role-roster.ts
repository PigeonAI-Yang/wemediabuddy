import type { DatabaseSync } from 'node:sqlite';
import {
  ROLE_CATALOG,
  roleWriteCommands,
  type RoleId
} from '../shared/agent-capabilities.ts';
import { getAgentTask, getLatestAgentTask, type AgentTask } from './agent-tasks.ts';
import type { EmployeeRole } from './job-pool.ts';
import { getActiveJobSpawner } from './job-spawner.ts';
import { deriveIntentForRole } from './role-job-registry.ts';
import {
  instanceProgressLabel,
  instanceProgressRatio,
  readCrewInstanceProjection,
  type CrewInstance
} from './crew-instance-projection.ts';

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
  /** WMB-5142 实例投影：该角色活动期实例（含 needs_user），按 queuedAt 序；同角色多实例显式可见。 */
  instances: readonly CrewInstance[];
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

function statusOf(task: AgentTask | null): RoleRosterStatus {
  if (!task) return 'idle';
  if (task.status === 'needs_user') return 'blocked';
  if (task.status === 'running') return 'running';
  return 'idle';
}

function runningSummary(task: AgentTask | null, fallback: string): string {
  if (task?.events?.length) return String(task.events[task.events.length - 1]?.message || task.phase || fallback);
  return task?.phase || fallback;
}

function rowFromInstance(
  roleId: RoleId,
  meta: { labelZh: string; roomZh: string },
  instance: CrewInstance,
  instances: readonly CrewInstance[],
  database: DatabaseSync
): RoleRosterRow {
  const running = instance.status === 'running';
  const blocked = instance.status === 'needs_user';
  // WMB-5142 评审 P2：活动实例四态 + 历史全分支覆盖，无「待命」虚构待命态默认值。
  let summary: string;
  if (running) summary = runningSummary(instance.taskId ? getAgentTask(database, instance.taskId) : null, '工作中');
  else if (blocked) summary = instance.error || '需要你处理';
  else if (instance.status === 'waiting_resource') summary = `等资源 · ${instance.waitReason ?? ''}`;
  else if (instance.status === 'queued') summary = `排队中 · ${instance.brief}`;
  else summary = `最近：${instance.phase || instance.status}`;
  return {
    roleId,
    labelZh: meta.labelZh,
    roomZh: meta.roomZh,
    status: running ? 'running' : blocked ? 'blocked' : 'idle',
    summary,
    taskId: instance.taskId,
    intent: instance.intent ?? deriveIntentForRole(roleId as EmployeeRole),
    phase: instance.phase,
    progressLabel: instance.progressLabel,
    progressRatio: instance.progressRatio,
    createdAt: instance.queuedAt,
    updatedAt: instance.startedAt ?? instance.queuedAt,
    finishedAt: instance.finishedAt,
    writeCommandCount: roleWriteCommands(roleId).length,
    instances
  };
}

/** 遗留任务行（无投影实例时回落，保持既有字段语义；daily 编排/页任务不经 JobPool）。 */
function rowFromLegacy(
  roleId: RoleId,
  meta: { labelZh: string; roomZh: string },
  task: AgentTask | null,
  database: DatabaseSync
): RoleRosterRow {
  const running = task?.status === 'running';
  const blocked = task?.status === 'needs_user';
  // WMB-5142 评审 P2：空角色无虚构「待命」态，输出中性文案「当前无任务」（§14 A4 / EVAL-CAP-027.5）。
  let summary = '当前无任务';
  if (running) summary = runningSummary(task, '工作中');
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
    progressLabel: task ? instanceProgressLabel(task) : null,
    progressRatio: instanceProgressRatio(task),
    createdAt: task?.createdAt ?? null,
    updatedAt: task?.updatedAt ?? null,
    finishedAt: task?.finishedAt ?? null,
    writeCommandCount: roleWriteCommands(roleId).length,
    instances: []
  };
}

/**
 * 角色班组投影（WMB-5142）：实例驱动，单一投影 API 同时驱动强制与显示（§12.2.4 干净切换）。
 * 每角色取活动期代表实例（queuedAt 序首个）渲染粗粒度行，`instances` 携带该角色全部
 * 活动实例（同角色多实例显式可见）；无活动实例时回落遗留任务（daily 编排不经 JobPool），
 * 再无则取最近历史实例；空角色显示「当前无任务」（不预设空槽、无虚构待命态，§3.2 不变量 4 / §14 A4）。
 */
export function buildRoleRoster(
  database: DatabaseSync,
  input: {
    businessDate?: string;
    worker?: { taskId: string | null; roleId: string | null; purpose?: 'desk' | 'employee' } | null;
    workers?: Array<{ taskId: string | null; roleId: string | null; purpose?: 'desk' | 'employee' }>;
  } = {}
): RoleRosterRow[] {
  const businessDate = input.businessDate;
  const spawner = getActiveJobSpawner();
  const projection = readCrewInstanceProjection({
    database,
    pool: spawner?.pool ?? null,
    getHandle: spawner ? (jobId) => spawner.getHandle(jobId) : null
  });

  // 遗留面：intent 最近任务 + worker lease 提示（daily 编排/页任务不经 JobPool 的可见性）。
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

  const dateMatches = (instance: CrewInstance): boolean => !businessDate || instance.businessDate === businessDate;

  return ORDER.map((roleId) => {
    // WMB-5182/5184：desk 行投影直接用 ROLE_CATALOG.desk（主管/主编席），展示层无覆盖。
    const meta = ROLE_CATALOG[roleId];
    if (roleId === 'desk') return rowFromLegacy(roleId, meta, latestByRole.get('desk') ?? null, database);
    const role = roleId as EmployeeRole;
    const instances = projection.byRole[role].active.filter(dateMatches);
    if (instances.length) return rowFromInstance(roleId, meta, instances[0], instances, database);
    const legacy = latestByRole.get(roleId) ?? null;
    if (legacy) return rowFromLegacy(roleId, meta, legacy, database);
    const history = projection.byRole[role].history.filter(dateMatches);
    if (history.length) return rowFromInstance(roleId, meta, history[0], [], database);
    return rowFromLegacy(roleId, meta, null, database);
  });
}
