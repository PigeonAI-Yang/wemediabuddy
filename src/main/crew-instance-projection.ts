import type { DatabaseSync } from 'node:sqlite';
import { getAgentTask, type AgentIntent, type AgentTask, type AgentTaskProgress, type AgentTaskStatus } from './agent-tasks.ts';
import { isEmployeeRole, readJobContractFromRefs, type JobContract } from './job-object-boundary.ts';
import { EMPLOYEE_ROLES, type EmployeeRole, type JobPool, type JobRecord, type JobStatus } from './job-pool.ts';
import { readCrewResearchSummary, type CrewResearchSummary } from './research-successor-projection.ts';

/**
 * WMB-5142 班组实例运行投影（设计 §5/§6.4/§7、CAP-027）。
 *
 * 单一 CrewInstanceProjection DTO/read API：
 * - 实例一等身份 = `jobId`（池内唯一，跨面指认锚）；`roleId` 派生后不可变（§7.1）。
 * - 活动期显示编号（「记者 #N」）= 每角色活动期序数，**仅投影期计算**，不进入任何
 *   契约/存储；重启后新活动期重新计数（§7.2 / Owner lock #11）。
 * - 活动视图（active）= 池内 queued / waiting_resource / running + 终态 needs_user
 *   （卡留「等你批」直至用户处理/关闭；零 slot/lease/grant/锁，不自动重试；重启后从
 *   持久面恢复保留；续派 reuse 同任务时重复卡按任务（report.taskId）去重退出、被 rebind 接替的
 *   旧卡退出，同任务至多一个活动实例，不双计）。
 * - 历史视图（history）只从持久面重建（agent_tasks.context_refs_json 为锚 + 任务行 +
 *   会话 ref），**不依赖 JobPool**（§7.3）；scan→judge 共享同一 agent_task 时按
 *   context_refs_json.jobId 归属当前活动实例，同一任务同一时刻只归属一个活动实例，
 *   活动视图不双计（§5 规则 3 / §7.1）。
 */

export type CrewInstanceStatus = JobStatus;

export type CrewInstance = Readonly<{
  /** 一等身份：池内唯一；跨面指认以 jobId 为锚。 */
  jobId: string;
  /** 不可变角色（派生后不可改写）。 */
  roleId: EmployeeRole;
  brief: string;
  intent: string | null;
  status: CrewInstanceStatus;
  /** 活动期显示编号（每角色活动期序数，纯显示；历史实例恒 0；重启后重新计数）。 */
  displayNumber: number;
  waitReason: string | null;
  waitingSince: string | null;
  progressLabel: string | null;
  progressRatio: number | null;
  phase: string | null;
  taskId: string | null;
  /** 会话文件：内存实例为绝对路径（运行句柄）；持久实例为 `agent/sessions/job-<jobId>.jsonl` 相对 ref。 */
  sessionFile: string | null;
  piSessionId: string | null;
  businessDate: string | null;
  projectId: string | null;
  writerTask: 'core_draft' | 'xiaohongshu_platform_version' | 'video_script' | null;
  researchMode: 'auto' | 'required' | 'prohibited' | null;
  error: string | null;
  /** 终态稳定 code（failed/needs_user 取自 agent_task.errorCode；succeeded 无持久 code）。 */
  code: string | null;
  /** WMB-5174 记者卡研究摘要：intent='research' 的任务非 null（预算计数 + claim 判定计数）；其余 null。 */
  research: CrewResearchSummary | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 记录来源：memory=JobPool（活动实例）；persistent=持久面重建（history / 持久 needs_user）。 */
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

export type CrewInstanceProjection = Readonly<{
  active: readonly CrewInstance[];
  history: readonly CrewInstance[];
  summary: CrewInstanceSummary;
  byRole: Readonly<Record<EmployeeRole, Readonly<{ active: readonly CrewInstance[]; history: readonly CrewInstance[] }>>>;
}>;

export type CrewProjectionSource = Readonly<{
  database: DatabaseSync;
  /** 内存池（活动实例唯一来源）；无 spawner 时传 null（活动视图只剩持久 needs_user）。 */
  pool: JobPool | null;
  /** 运行句柄（taskId/sessionFile 绑定）；缺省时从任务 refs 反查。 */
  getHandle?: ((jobId: string) => Readonly<{ taskId?: string | null; sessionFile?: string | null }> | null) | null;
}>;

/** 内部构建类型：displayNumber 在排序后回填（冻结前），对外只暴露只读 CrewInstance。 */
type MutableCrewInstance = { -readonly [K in keyof CrewInstance]: CrewInstance[K] };

const ACTIVE_STATUSES: Readonly<Record<string, true>> = Object.freeze({
  queued: true,
  waiting_resource: true,
  running: true,
  needs_user: true
});
const TERMINAL_TASK_STATUSES: Readonly<Record<string, true>> = Object.freeze({
  succeeded: true,
  partial: true,
  failed: true,
  cancelled: true
});

export function instanceProgressLabel(task: AgentTask | null): string | null {
  if (!task) return null;
  const p = task.progress || {};
  if (task.intent === 'research') {
    // WMB-5174：research 预算进度（候选 processed/planned + 有效来源 verified）；缺字段不伪造。
    if (typeof p.planned === 'number' && typeof p.processed === 'number') {
      return `候选 ${p.processed}/${p.planned}` + (typeof p.verified === 'number' ? ` · 有效 ${p.verified}` : '');
    }
    return p.message || task.phase || null;
  }
  if (typeof p.planned === 'number' && typeof p.processed === 'number') {
    return `渠道 ${p.processed}/${p.planned}` + (p.currentSource ? ` · ${p.currentSource}` : '');
  }
  if (p.opportunityCount != null) return `机会 ${p.opportunityCount}`;
  if (p.saved != null) return `已保存 ${p.saved}`;
  return task.phase || null;
}

export function instanceProgressRatio(task: AgentTask | null): number | null {
  if (!task || task.status !== 'running') return null;
  const p = task.progress || {};
  const planned = Number(p.planned ?? 0);
  if (!(planned > 0)) return null; // 无真实计划量：不确定态（空轨），不得凭阶段猜比例
  const processed = Number(p.processed ?? 0);
  return Math.max(0, Math.min(1, processed / planned));
}

/** 会话文件命名约定（设计 §7.4）：`job-<jobId>.jsonl`，多实例天然隔离、续跑 baseline。 */
export function jobSessionFileRef(jobId: string): string {
  return `agent/sessions/job-${jobId}.jsonl`;
}

/**
 * 持久面锚点索引：单次有界 SQL 读必要列 + 内存构建（WMB-5142 评审 P3）。
 * 消除每次投影的 `context_refs_json LIKE '%jobId%'` 前导通配符全表扫描、逐行 getAgentTask
 * 二次查询（N+1）与大 JSON 列（result_refs/checkpoint/events）重复解析；不新增 schema。
 * 全量读取保持历史完整性（重启后 needs_user/终态历史完整重建，不牺牲语义）——只做一次
 * 行级 parse（context_refs + progress），跳过投影不消费的大列。rebind 后 jobId 归属接续实例。
 */
function loadTasksByJobId(database: DatabaseSync): Map<string, AgentTask> {
  const map = new Map<string, AgentTask>();
  const rows = database.prepare(
    `SELECT id, intent, business_date, status, phase, pi_session_id, context_refs_json, progress_json,
            error_code, error_message, created_at, updated_at, finished_at
     FROM agent_tasks`
  ).all() as unknown as Array<{
    id: string;
    intent: string;
    business_date: string;
    status: string;
    phase: string;
    pi_session_id: string | null;
    context_refs_json: string;
    progress_json: string;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    finished_at: string | null;
  }>;
  for (const row of rows) {
    let contextRefs: Record<string, unknown>;
    try {
      contextRefs = JSON.parse(row.context_refs_json) as Record<string, unknown>;
    } catch {
      continue; // 损坏 refs 的行跳过（原逐行 getAgentTask 路径会整体抛错，此处防御性容错）。
    }
    const contract = readJobContractFromRefs(contextRefs);
    if (!contract || !isEmployeeRole(contract.roleId)) continue;
    let progress: AgentTaskProgress;
    try {
      progress = JSON.parse(row.progress_json) as AgentTaskProgress;
    } catch {
      progress = {};
    }
    // 投影只消费上述必要列；resultRefs/checkpoint/events/controlAction/heartbeatAt 非投影面，以默认值占位。
    map.set(contract.jobId, {
      id: row.id,
      intent: row.intent as AgentIntent,
      businessDate: row.business_date,
      status: row.status as AgentTaskStatus,
      phase: row.phase,
      piSessionId: row.pi_session_id,
      contextRefs,
      resultRefs: {},
      progress,
      checkpoint: {},
      events: [],
      controlAction: null,
      heartbeatAt: null,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at
    });
  }
  return map;
}

function instanceFromPool(
  rec: JobRecord,
  task: AgentTask | null,
  handle: Readonly<{ taskId?: string | null; sessionFile?: string | null }> | null,
  research: CrewResearchSummary | null
): MutableCrewInstance {
  return {
    jobId: rec.id,
    roleId: rec.roleId,
    brief: rec.brief,
    intent: rec.intent,
    status: rec.status,
    displayNumber: 0,
    waitReason: rec.waitReason,
    waitingSince: rec.waitingSince,
    progressLabel: task ? instanceProgressLabel(task) : null,
    progressRatio: task ? instanceProgressRatio(task) : null,
    phase: task?.phase ?? null,
    // WMB-5142 生命周期：终态卡（句柄已清）回落报告任务引用——续派 reuse 卡（无合同 jobId 锚点）仍可指认任务。
    taskId: task?.id ?? handle?.taskId ?? rec.report?.taskId ?? null,
    sessionFile: handle?.sessionFile ?? null,
    piSessionId: task?.piSessionId ?? null,
    businessDate: rec.businessDate,
    projectId: rec.projectId,
    writerTask: rec.writerTask,
    researchMode: task?.contextRefs.researchMode === 'required' || task?.contextRefs.researchMode === 'prohibited'
      ? task.contextRefs.researchMode
      : rec.roleId === 'writer' ? 'auto' : null,
    error: rec.error,
    code: rec.report?.code ?? null,
    research,
    queuedAt: rec.queuedAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    source: 'memory'
  };
}

function instanceFromTask(task: AgentTask, contract: JobContract, status: CrewInstanceStatus, research: CrewResearchSummary | null): MutableCrewInstance {
  return {
    jobId: contract.jobId,
    roleId: contract.roleId as EmployeeRole,
    brief: contract.brief,
    intent: task.intent,
    status,
    displayNumber: 0,
    waitReason: null,
    waitingSince: null,
    progressLabel: instanceProgressLabel(task),
    progressRatio: instanceProgressRatio(task),
    phase: task.phase,
    taskId: task.id,
    sessionFile: jobSessionFileRef(contract.jobId),
    piSessionId: task.piSessionId,
    businessDate: contract.boundary.businessDate ?? task.businessDate ?? null,
    projectId: contract.boundary.projectId,
    writerTask: task.contextRefs.writerTask === 'xiaohongshu_platform_version' ? 'xiaohongshu_platform_version' : contract.roleId === 'writer' ? 'core_draft' : null,
    researchMode: task.contextRefs.researchMode === 'required' || task.contextRefs.researchMode === 'prohibited'
      ? task.contextRefs.researchMode
      : contract.roleId === 'writer' ? 'auto' : null,
    error: task.errorMessage,
    code: task.errorCode,
    research,
    queuedAt: task.createdAt,
    startedAt: task.createdAt,
    finishedAt: task.finishedAt,
    source: 'persistent'
  };
}

export function readCrewInstanceProjection(source: CrewProjectionSource): CrewInstanceProjection {
  const { database, pool, getHandle } = source;
  const tasksByJobId = loadTasksByJobId(database);

  // 活动实例：池内 queued / waiting_resource / running / needs_user（§3.1 活动视图）。
  const active: MutableCrewInstance[] = [];
  /** 已入视图的 needs_user 卡引用的任务（report.taskId）：续派 reuse 同任务的重复卡去重。 */
  const needsUserTaskIds = new Set<string>();
  for (const rec of pool?.list() ?? []) {
    if (!ACTIVE_STATUSES[rec.status]) continue;
    const handle = getHandle?.(rec.id) ?? null;
    if (rec.status === 'needs_user') {
      const taskRef = rec.report?.taskId ?? null;
      if (taskRef) {
        // WMB-5142 生命周期：卡引用的任务已被关闭/终态（cancelled/failed/…）→「等你批」作废，卡退出。
        // 覆盖用户关闭的重复卡（同任务另一池记录）与补配置续派被接替的旧卡，不依赖单卡迁移。
        const refTask = tasksByJobId.get(rec.id) ?? (taskRef ? getAgentTask(database, taskRef) : null);
        if (refTask && refTask.status !== 'needs_user' && TERMINAL_TASK_STATUSES[refTask.status]) continue;
        // WMB-5142 评审 P1：新 settle 与旧卡引用同一任务（续派 reuse 同任务，含配置缺失前置卡）
        // → 重复卡退出，只留最早一张；配置缺失单卡（唯一 taskRef）正常保留。
        if (needsUserTaskIds.has(taskRef)) continue;
        needsUserTaskIds.add(taskRef);
      } else if (!tasksByJobId.has(rec.id) && !handle) {
        // 无任务引用且失去锚点/句柄：被接替的旧卡（rebind 覆写 refs.jobId 后锚点移走），退出。
        continue;
      }
    }
    // 共享任务归属（§7.1）：refs.jobId 锚点优先（rebind 后接续实例持有），handle 回落。
    const task = tasksByJobId.get(rec.id) ?? (handle?.taskId ? getAgentTask(database, handle.taskId) : null);
    active.push(instanceFromPool(rec, task, handle, readCrewResearchSummary(database, task)));
  }
  // 持久 needs_user：池清空（重启）后卡留活动视图「等你批」，按 jobId 与任务双重去重。
  const activeJobIds = new Set(active.map((i) => i.jobId));
  const activeTaskIds = new Set(active.map((i) => i.taskId).filter((id): id is string => Boolean(id)));
  for (const [jobId, task] of tasksByJobId) {
    if (activeJobIds.has(jobId)) continue;
    // WMB-5142 生命周期：任务已被池卡代表（续派 reuse，池卡 jobId ≠ 任务合同 jobId）→ 不重建重复卡。
    if (activeTaskIds.has(task.id)) continue;
    if (task.status !== 'needs_user') continue;
    const contract = readJobContractFromRefs(task.contextRefs);
    if (!contract) continue;
    active.push(instanceFromTask(task, contract, 'needs_user', readCrewResearchSummary(database, task)));
  }

  // 活动期显示编号：每角色按 queuedAt 序 1..N（纯显示；不持久化；重启后重新计数）。
  active.sort((a, b) => (a.queuedAt === b.queuedAt ? (a.jobId < b.jobId ? -1 : 1) : a.queuedAt < b.queuedAt ? -1 : 1));
  const counters = new Map<EmployeeRole, number>();
  for (const instance of active) {
    const n = (counters.get(instance.roleId) ?? 0) + 1;
    counters.set(instance.roleId, n);
    instance.displayNumber = n;
  }

  // 历史：只从持久面重建终态实例（succeeded/partial/failed/cancelled），不依赖 JobPool。
  const activeIds = new Set(active.map((i) => i.jobId));
  const history: CrewInstance[] = [];
  for (const [jobId, task] of tasksByJobId) {
    if (activeIds.has(jobId)) continue;
    if (!TERMINAL_TASK_STATUSES[task.status]) continue;
    const contract = readJobContractFromRefs(task.contextRefs);
    if (!contract) continue;
    history.push(instanceFromTask(task, contract, task.status as CrewInstanceStatus, readCrewResearchSummary(database, task)));
  }
  history.sort((a, b) => String(b.finishedAt ?? b.queuedAt).localeCompare(String(a.finishedAt ?? a.queuedAt)));

  const countBy = (status: JobStatus): number => active.reduce((sum, i) => (i.status === status ? sum + 1 : sum), 0);
  const summary: CrewInstanceSummary = {
    active: active.length,
    queued: countBy('queued'),
    waitingResource: countBy('waiting_resource'),
    running: countBy('running'),
    needsUser: countBy('needs_user'),
    history: history.length
  };

  const frozenActive = Object.freeze(active.map((i) => Object.freeze(i)));
  const frozenHistory = Object.freeze(history.map((i) => Object.freeze(i)));
  const frozenByRole = {} as Record<EmployeeRole, Readonly<{ active: readonly CrewInstance[]; history: readonly CrewInstance[] }>>;
  for (const role of EMPLOYEE_ROLES) {
    frozenByRole[role] = Object.freeze({
      active: frozenActive.filter((i) => i.roleId === role),
      history: frozenHistory.filter((i) => i.roleId === role)
    });
  }
  return Object.freeze({
    active: frozenActive,
    history: frozenHistory,
    summary: Object.freeze(summary),
    byRole: Object.freeze(frozenByRole)
  });
}
