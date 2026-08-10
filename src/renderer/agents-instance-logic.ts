/**
 * WMB-5143 智能体页实例驱动视图的纯逻辑（状态词/等待原因/过滤/续派输入/耗时）。
 * 与视图分离，便于 node:test 直接断言（无 jsdom），沿用 agents-roster-conflict 模式。
 * 一切显示只来自投影 API（UI 单源，设计 §12.2.6）：状态词与状态点双编码，
 * 禁止第二份手写标签；无虚构空闲态、无空槽语义。
 */

/** 实例状态（与 src/main/crew-instance-projection.ts CrewInstanceStatus 一致）。 */
export type CrewInstanceStatus =
  | 'queued'
  | 'waiting_resource'
  | 'running'
  | 'needs_user'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type EmployeeRole = 'reporter' | 'planner' | 'writer' | 'librarian';

/** 实例一等身份 = jobId；活动期编号 displayNumber 纯显示（历史实例恒 0）。 */
export type CrewInstance = Readonly<{
  jobId: string;
  roleId: EmployeeRole;
  brief: string;
  intent: string | null;
  status: CrewInstanceStatus;
  displayNumber: number;
  waitReason: string | null;
  waitingSince: string | null;
  progressLabel: string | null;
  progressRatio: number | null;
  phase: string | null;
  taskId: string | null;
  sessionFile: string | null;
  piSessionId: string | null;
  businessDate: string | null;
  projectId: string | null;
  error: string | null;
  code: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  source: 'memory' | 'persistent';
}>;

export type CrewInstanceSummary = Readonly<{
  active: number;
  queued: number;
  waitingResource: number;
  running: number;
  needsUser: number;
  history: number;
}>;

export type CrewProjection = Readonly<{
  active: readonly CrewInstance[];
  history: readonly CrewInstance[];
  summary: CrewInstanceSummary;
  byRole: Readonly<Record<EmployeeRole, Readonly<{ active: readonly CrewInstance[]; history: readonly CrewInstance[] }>>>;
}>;

/** 活动视图状态词（设计 §11.1，与状态点颜色双编码）。 */
export const STATUS_WORD: Readonly<Record<CrewInstanceStatus, string>> = Object.freeze({
  queued: '排队中',
  waiting_resource: '等资源',
  running: '工作中',
  needs_user: '等你批',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
});

export function statusWord(status: string): string {
  return STATUS_WORD[status as CrewInstanceStatus] ?? '未知';
}

/** 等待原因可读化（设计 §11.1：禁止裸「等资源」；已知锁码 → 人类可读，未知保留原文）。 */
const WAIT_REASON_READABLE: Readonly<Array<readonly [prefix: string, label: string]>> = Object.freeze([
  ['RESOURCE_LOCK_CONFLICT', '等资源释放：该任务对象正被占用'],
  ['RESOURCE_LEASE_BUSY', '等资源释放：执行租约忙'],
  ['RESOURCE_JUDGE_IN_FLIGHT', '等扫判交接完成'],
  ['PI_CONFIG_REQUIRED', '等你批：需先补齐配置再派']
]);

export function waitReasonLabel(instance: Pick<CrewInstance, 'status' | 'waitReason'>): string {
  if (instance.status === 'needs_user') return instance.waitReason || '需要你处理';
  if (instance.status === 'waiting_resource') {
    const raw = instance.waitReason ?? '';
    for (const [prefix, label] of WAIT_REASON_READABLE) {
      if (raw.startsWith(prefix)) return label;
    }
    return raw || '排队等容量';
  }
  if (instance.status === 'queued') return '排队等容量';
  return instance.waitReason ?? '';
}

/**
 * 实例卡正文一句话：谁 + 在干什么 + 卡在哪（设计 §11.2）。
 * running → 当前步骤；排队/等资源 → 可读等待原因；等你批/失败 → 稳定 code + 原因。
 */
export function instanceDetail(instance: CrewInstance): string | null {
  switch (instance.status) {
    case 'running':
      return instance.phase || instance.progressLabel || null;
    case 'queued':
    case 'waiting_resource':
      return waitReasonLabel(instance);
    case 'needs_user':
      return instance.error || (instance.code ? `等你批 · ${instance.code}` : '需要你处理');
    case 'failed':
      return instance.error || instance.code || null;
    default:
      return null;
  }
}

/** 耗时标签（纯显示，随渲染刷新）。 */
export function elapsedLabel(startedAt: string | null, finishedAt?: string | null): string {
  if (!startedAt) return '—';
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

/** 实例耗时文案（按状态选起点）：running → 已跑；排队/等资源 → 已等；needs_user → 停留。 */
export function instanceTiming(instance: CrewInstance): { prefix: string; label: string } {
  if (instance.status === 'running') return { prefix: '已跑', label: elapsedLabel(instance.startedAt) };
  if (instance.status === 'queued' || instance.status === 'waiting_resource') {
    return { prefix: '已等', label: elapsedLabel(instance.waitingSince ?? instance.queuedAt) };
  }
  return { prefix: '停留', label: elapsedLabel(instance.finishedAt ?? instance.queuedAt) };
}

/** 页头摘要（工作中/排队/等你批）——只来自投影 summary，无第二份标签。 */
export function headerCounts(summary: CrewInstanceSummary | null): { running: number; queued: number; needsUser: number } {
  if (!summary) return { running: 0, queued: 0, needsUser: 0 };
  return { running: summary.running, queued: summary.queued, needsUser: summary.needsUser };
}

export type StatusFilter = 'all' | 'running' | 'queued' | 'needs_user';

/** 状态过滤只作用于实例卡可见性（与页头摘要计数一致）；角色分组与空态文案始终渲染。 */
export function filterActiveInstances(instances: readonly CrewInstance[], filter: StatusFilter): CrewInstance[] {
  if (filter === 'all') return [...instances];
  return instances.filter((i) => i.status === filter);
}

/** 固定员工角色序（活动实例区/角色概览/历史/派单遍历共用；desk 由视图单独处理为协调入口）。 */
export const EMPLOYEE_ORDER: readonly EmployeeRole[] = Object.freeze(['reporter', 'planner', 'writer', 'librarian']);

/** 活动实例展示优先级：等你批最先（「等你批」主次明确），随后工作中/等资源/排队中；终态兜底。 */
const DISPLAY_PRIORITY: Readonly<Record<CrewInstanceStatus, number>> = Object.freeze({
  needs_user: 0,
  running: 1,
  waiting_resource: 2,
  queued: 3,
  succeeded: 4,
  partial: 4,
  failed: 4,
  cancelled: 4
});

/**
 * 活动实例展示排序（纯显示）：needs_user 卡排最前（等你批主次明确），其余按状态稳定排序，
 * displayNumber/jobId 兜底保证跨轮询排列稳定（不随刷新抖动）。
 */
export function sortInstancesForDisplay(instances: readonly CrewInstance[]): CrewInstance[] {
  return [...instances].sort((a, b) => {
    const pa = DISPLAY_PRIORITY[a.status] ?? 4;
    const pb = DISPLAY_PRIORITY[b.status] ?? 4;
    if (pa !== pb) return pa - pb;
    if (a.displayNumber !== b.displayNumber) return a.displayNumber - b.displayNumber;
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });
}

/** 活动实例区角色节：仅含当前 filter 下可见实例的角色；实例已按展示优先级排序。 */
export type ActiveRoleSection = Readonly<{
  roleId: EmployeeRole;
  visible: readonly CrewInstance[];
  /** 该角色全部活动实例数（不受 filter 影响，作计数徽标）。 */
  total: number;
}>;

/** 活动实例区（主工作区）：按固定员工角色序收集有可见实例的角色节，无实例角色不占区。 */
export function activeRoleSections(projection: Pick<CrewProjection, 'byRole'>, filter: StatusFilter): ActiveRoleSection[] {
  const sections: ActiveRoleSection[] = [];
  for (const roleId of EMPLOYEE_ORDER) {
    const active = projection.byRole[roleId].active;
    const visible = filterActiveInstances(active, filter);
    if (visible.length === 0) continue;
    sections.push({ roleId, visible: sortInstancesForDisplay(visible), total: active.length });
  }
  return sections;
}

/** 角色概览行状态：无活动实例 / 有实例但被当前 filter 隐藏 / 有可见实例（状态词取排序后首实例）。 */
export type RoleOverviewStatus =
  | { kind: 'empty' }
  | { kind: 'filtered' }
  | { kind: 'active'; leaderStatus: CrewInstanceStatus; total: number };

export function roleOverviewStatus(active: readonly CrewInstance[], filter: StatusFilter): RoleOverviewStatus {
  if (active.length === 0) return { kind: 'empty' };
  const visible = filterActiveInstances(active, filter);
  if (visible.length === 0) return { kind: 'filtered' };
  const sorted = sortInstancesForDisplay(visible);
  return { kind: 'active', leaderStatus: sorted[0].status, total: visible.length };
}

/**
 * 续派输入（按现有 jobsSpawn handler 落地）：从实例重建 RoleJobRequest 的 UI 侧参数
 * （roleId/brief/businessDate/projectId 取自投影，其余边界字段由系统按角色派生）。
 */
export function redispatchInput(instance: Pick<CrewInstance, 'roleId' | 'brief' | 'businessDate' | 'projectId'>): {
  roleId: EmployeeRole;
  brief: string;
  businessDate?: string | null;
  projectId?: string | null;
} {
  const input: { roleId: EmployeeRole; brief: string; businessDate?: string | null; projectId?: string | null } = {
    roleId: instance.roleId,
    brief: instance.brief
  };
  if (instance.businessDate) input.businessDate = instance.businessDate;
  if (instance.projectId) input.projectId = instance.projectId;
  return input;
}
