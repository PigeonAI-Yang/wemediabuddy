import { randomUUID } from 'node:crypto';
import type { RoleId } from '../shared/agent-capabilities.ts';
import { DEFAULT_MAX_WORKERS as DEFAULT_MAX_WORKERS_LIMIT, MAX_EMPLOYEE_LEASES, MIN_REPORTER_CONCURRENCY } from './worker-limits.ts';
import type { JobTerminalStatus, RoleJobReportV1 } from './role-job-registry.ts';

/**
 * 员工工单池（M-5110 / CAP-027 / WMB-5116）。
 *
 * - desk（主编席）不占员工槽，由 workspace-runtime 的 desk lease 单独管理。
 * - 池只负责 FIFO 排队、槽位晋升、`waiting_resource` 泊车与专属资源锁；不启动 Pi 进程
 *   （由 JobSpawner 通过 onSlotFree 接线）。
 * - 锁键由 role-job-registry 派生（reporter `scan:` / planner `plan:` / writer `project:` /
 *   librarian `library-maintenance:`），随工单存入 `resourceLocks`；不同键并发、冲突键
 *   走 `waiting_resource` 泊车，资源释放后按提交序 FIFO 晋升。
 */

export const DEFAULT_MAX_WORKERS = DEFAULT_MAX_WORKERS_LIMIT;
/** 与 runtime 软帽对齐：最多 MAX_EMPLOYEE_LEASES 路员工（预留 1 给 desk）。 */
export const MAX_EMPLOYEE_WORKERS = MAX_EMPLOYEE_LEASES;

export type EmployeeRole = Exclude<RoleId, 'desk'>;

export const EMPLOYEE_ROLES: readonly EmployeeRole[] = Object.freeze(['reporter', 'planner', 'writer', 'librarian']);

export type JobStatus = 'queued' | 'waiting_resource' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'partial' | 'needs_user';

export type JobRecord = Readonly<{
  id: string;
  roleId: EmployeeRole;
  intent: string | null;
  brief: string;
  businessDate: string | null;
  planDate: string | null;
  projectId: string | null;
  writerTask: 'core_draft' | 'xiaohongshu_platform_version' | 'video_script' | null;
  /** 角色专属资源锁键（§8.1），submit 时由注册表派生；池晋升时按此键做泊车重检。 */
  resourceLocks: readonly string[];
  status: JobStatus;
  /** waiting_resource 的原因（`RESOURCE_LOCK_CONFLICT: …` / `RESOURCE_LEASE_BUSY: …` / `RESOURCE_JUDGE_IN_FLIGHT: …`）。 */
  waitReason: string | null;
  waitingSince: string | null;
  /** 终态报告（§5.4），终态写入，内存态。 */
  report: RoleJobReportV1 | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}>;

export type JobInput = Readonly<{
  roleId: EmployeeRole;
  intent?: string | null;
  brief: string;
  businessDate?: string | null;
  planDate?: string | null;
  projectId?: string | null;
  writerTask?: 'core_draft' | 'xiaohongshu_platform_version' | 'video_script' | null;
  resourceLocks?: readonly string[];
}>;

export type EntityLockResult =
  | { ok: true; keys: string[] }
  | { ok: false; code: 'JOB_LOCK_CONFLICT' | 'JOB_NOT_RUNNING'; jobId: string; key?: string; heldBy?: string };

export const RESOURCE_WAIT_CODES = Object.freeze({
  RESOURCE_LOCK_CONFLICT: 'RESOURCE_LOCK_CONFLICT',
  RESOURCE_LEASE_BUSY: 'RESOURCE_LEASE_BUSY',
  RESOURCE_JUDGE_IN_FLIGHT: 'RESOURCE_JUDGE_IN_FLIGHT'
} as const);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeMaxWorkers(maxWorkers: number): number {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 0) {
    throw new Error(`maxWorkers 必须是 0..${MAX_EMPLOYEE_WORKERS} 的整数（0=停用派工）。`);
  }
  if (maxWorkers > MAX_EMPLOYEE_WORKERS) {
    throw new Error(`maxWorkers 不能超过员工软上限 ${MAX_EMPLOYEE_WORKERS}（runtime 总 lease ${MAX_EMPLOYEE_WORKERS + 1}，预留 desk）。`);
  }
  // 0 remains the explicit dispatch-disable sentinel; every positive setting keeps Reporter capacity >= 5.
  return maxWorkers === 0 ? 0 : Math.max(maxWorkers, MIN_REPORTER_CONCURRENCY);
}

export class JobPool {
  private maxWorkers: number;
  private readonly queue: JobRecord[] = [];
  /** waiting_resource 泊车车道：不占槽位，按提交序与 queued 公平竞争。 */
  private readonly parked: JobRecord[] = [];
  private readonly running = new Map<string, JobRecord>();
  private readonly terminal = new Map<string, JobRecord>();
  private readonly locks = new Map<string, string>();
  private readonly slotListeners = new Set<(job: JobRecord | null) => void>();
  /**
   * 单调提交序（真实 FIFO 源）。
   *
   * queuedAt 为 ISO 毫秒字符串：同毫秒提交的多单相等，字符串比较无法区分先后；
   * 这会令 `q <= p` 偏向 queued 车道、越过更早提交的 parked 工单（第三轮回归根因）。
   * submit 时分配自增序号，nextCandidate 以序号比较；parked/running 迁移不丢失序号，
   * 终态（recordTerminal）清理。仅池内部使用，不外泄。
   */
  private nextSubmitSeq = 0;
  private readonly submitSeq = new Map<string, number>();

  constructor(maxWorkers: number = DEFAULT_MAX_WORKERS) {
    this.maxWorkers = normalizeMaxWorkers(maxWorkers);
  }

  getMaxWorkers(): number {
    return this.maxWorkers;
  }

  /** 提交工单：有空位则立即晋升 running，否则进入 FIFO 队列。不启动 Pi。 */
  submit(input: JobInput): JobRecord {
    return this.submitWithId(randomUUID(), input);
  }

  /** 持久 outbox 的内部入口：同一 jobId 在当前进程只入池一次。 */
  submitWithId(jobId: string, input: JobInput): JobRecord {
    const existing = this.get(jobId);
    if (existing) return existing;
    // 运行期防呆：JS 侧可能传入 'desk' 或未知角色，一律拒收（desk 主编席不占员工槽）。
    if (!EMPLOYEE_ROLES.includes(input.roleId)) {
      throw new Error('JobPool 只接受员工角色，desk 主编席不占员工槽。');
    }
    if (!input.brief || !String(input.brief).trim()) throw new Error('工单 brief 不能为空。');
    // §9.1：maxWorkers=0 = 停用派工，容量零时任何提交拒收（与 spawner enabled 双保险）。
    if (this.maxWorkers === 0) {
      throw Object.assign(new Error('JOB_SPAWN_DISABLED: 员工派出已关闭（maxWorkers=0）。'), { code: 'JOB_SPAWN_DISABLED' });
    }
    const job: JobRecord = Object.freeze({
      id: jobId,
      roleId: input.roleId,
      intent: input.intent ?? null,
      brief: input.brief,
      businessDate: input.businessDate ?? null,
      planDate: input.planDate ?? null,
      projectId: input.projectId ?? null,
      writerTask: input.writerTask ?? null,
      resourceLocks: Object.freeze([...(input.resourceLocks ?? [])]),
      status: 'queued',
      waitReason: null,
      waitingSince: null,
      report: null,
      queuedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: null
    });
    this.queue.push(job);
    this.submitSeq.set(job.id, ++this.nextSubmitSeq);
    this.tryPromoteInternal(false);
    return this.get(job.id)!;
  }

  /** submit 的别名（兼容契约命名）。 */
  enqueue(input: JobInput): JobRecord {
    return this.submit(input);
  }

  /**
   * 槽位晋升：queued 与 waiting_resource 按单调提交序 FIFO 公平竞争（同毫秒也保序）。
   * parked 候选在锁仍被其他 running 工单持有时跳过（保持泊车，等资源释放事件）；
   * queued 候选正常晋升（锁冲突在 runJob 内转泊车）。
   * `skipResourceBusyParked` 仅用于「因资源未释放刚泊车的工单」（lease 忙 / judge in flight）
   * 防止原地再拉起空转——资源可用性由外部事件（其他工单收尾 / judge 终态 / 看门狗 rescan）驱动。
   */
  private tryPromoteInternal(skipResourceBusyParked: boolean): number {
    let promoted = 0;
    while (this.running.size < this.maxWorkers) {
      const candidate = this.nextCandidate(skipResourceBusyParked);
      if (!candidate) break;
      this.markRunning(candidate.id);
      promoted += 1;
    }
    return promoted;
  }

  private nextCandidate(skipResourceBusyParked: boolean): JobRecord | null {
    const seqOf = (id: string): number => this.submitSeq.get(id) ?? Number.POSITIVE_INFINITY;
    let qi = 0;
    let pi = 0;
    while (qi < this.queue.length || pi < this.parked.length) {
      const q = qi < this.queue.length ? this.queue[qi] : null;
      const p = pi < this.parked.length ? this.parked[pi] : null;
      let pick: JobRecord;
      if (q && p) pick = seqOf(q.id) <= seqOf(p.id) ? q : p;
      else if (q) pick = q;
      else if (p) pick = p;
      else break;
      if (pick === q) qi += 1;
      else pi += 1;
      if (pick.status === 'waiting_resource') {
        if (skipResourceBusyParked && this.isResourceBusyPark(pick)) continue;
        if (this.locksHeldByOthers(pick)) continue;
      }
      return pick;
    }
    return null;
  }

  /** 资源未释放的泊车（lease 忙 / judge in flight）：仅由外部事件驱动晋升，自身级联不拉起。 */
  private isResourceBusyPark(job: JobRecord): boolean {
    const reason = job.waitReason ?? '';
    return reason.startsWith(RESOURCE_WAIT_CODES.RESOURCE_LEASE_BUSY)
      || reason.startsWith(RESOURCE_WAIT_CODES.RESOURCE_JUDGE_IN_FLIGHT);
  }

  private locksHeldByOthers(job: JobRecord): boolean {
    for (const key of job.resourceLocks) {
      const holder = this.locks.get(key);
      if (holder !== undefined && holder !== job.id) return true;
    }
    return false;
  }

  /** 公开重扫入口（60s 看门狗兜底，杜绝永久泊车）。 */
  rescan(): number {
    return this.tryPromoteInternal(false);
  }

  /** 将指定 queued / waiting_resource 工单转为 running（无空位或不存在时返回 null）。 */
  markRunning(jobId: string): JobRecord | null {
    if (this.running.size >= this.maxWorkers) return null;
    const queuedIndex = this.queue.findIndex((job) => job.id === jobId);
    const parkedIndex = queuedIndex === -1 ? this.parked.findIndex((job) => job.id === jobId) : -1;
    if (queuedIndex === -1 && parkedIndex === -1) return null;
    const [job] = queuedIndex !== -1 ? this.queue.splice(queuedIndex, 1) : this.parked.splice(parkedIndex, 1);
    const running = Object.freeze<JobRecord>({ ...job, status: 'running', startedAt: nowIso(), waitReason: null, waitingSince: null });
    this.running.set(job.id, running);
    this.emitSlotFree(running);
    return running;
  }

  /**
   * 资源竞争泊车：running → waiting_resource，不占槽位；释放该工单锁并重扫晋升。
   * lease 忙 / judge in flight 泊车时跳过自身原地再拉起（避免同一工单立刻占槽空转），
   * 由外部事件（其他工单收尾 / judge 终态 / 看门狗 rescan）晋升。
   */
  park(jobId: string, code: 'RESOURCE_LOCK_CONFLICT' | 'RESOURCE_LEASE_BUSY' | 'RESOURCE_JUDGE_IN_FLIGHT', detail: string): JobRecord | null {
    const current = this.running.get(jobId);
    if (!current) return this.get(jobId);
    this.running.delete(jobId);
    this.clearLocks(jobId);
    const reason = `${code}: ${detail}`;
    const parked = Object.freeze<JobRecord>({
      ...current,
      status: 'waiting_resource',
      startedAt: null,
      waitReason: reason,
      waitingSince: nowIso(),
      error: null
    });
    this.parked.push(parked);
    this.emitSlotFree(null);
    const resourceBusy = code === RESOURCE_WAIT_CODES.RESOURCE_LEASE_BUSY
      || code === RESOURCE_WAIT_CODES.RESOURCE_JUDGE_IN_FLIGHT;
    if (this.tryPromoteInternal(resourceBusy) === 0) this.emitSlotFree(null);
    return parked;
  }

  /** 完成：running -> succeeded；释放锁并尝试晋升（含 parked 车道）。 */
  complete(jobId: string): JobRecord | null {
    return this.settle(jobId, 'succeeded', null, null);
  }

  /** 失败：running -> failed，带错误信息。 */
  fail(jobId: string, error: unknown): JobRecord | null {
    const message = error instanceof Error ? error.message : String(error ?? '工单执行失败。');
    return this.settle(jobId, 'failed', message, null);
  }

  /** 终态统一定点（§5.3 五态）：pool 终态只由 spawner 的 outcome 映射调用。 */
  settle(jobId: string, status: JobTerminalStatus, error: string | null, report: RoleJobReportV1 | null): JobRecord | null {
    const current = this.running.get(jobId);
    if (!current) return this.terminal.get(jobId) ?? null;
    const done = this.recordTerminal(current, status, error, report);
    if (this.tryPromoteInternal(false) === 0) this.emitSlotFree(null);
    return done;
  }

  /** 取消：queued / waiting_resource / running -> cancelled；running 释放槽位并晋升。 */
  cancel(jobId: string, report: RoleJobReportV1 | null = null): JobRecord | null {
    const queuedIndex = this.queue.findIndex((job) => job.id === jobId);
    if (queuedIndex !== -1) {
      const [job] = this.queue.splice(queuedIndex, 1);
      return this.recordTerminal(job, 'cancelled', null, report);
    }
    const parkedIndex = this.parked.findIndex((job) => job.id === jobId);
    if (parkedIndex !== -1) {
      const [job] = this.parked.splice(parkedIndex, 1);
      return this.recordTerminal(job, 'cancelled', null, report);
    }
    const settled = this.settle(jobId, 'cancelled', null, report);
    // WMB-5142 生命周期：needs_user 是池终态但属活动视图成员——用户关闭须真实迁移 cancelled 退出活动视图
    // （不再让记录永留 needs_user；其他终态 succeeded/failed 保持 no-op，cancel 返回原终态记录）。
    if (settled?.status === 'needs_user') {
      return this.recordTerminal(settled, 'cancelled', null, report ?? settled.report);
    }
    return settled;
  }

  /** 全部工单（queued、parked 按 FIFO、running、终态），供 jobs:list 投影。 */
  list(): JobRecord[] {
    return [...this.queue, ...this.parked, ...this.running.values(), ...this.terminal.values()];
  }

  get(jobId: string): JobRecord | null {
    return this.running.get(jobId)
      ?? this.queue.find((job) => job.id === jobId)
      ?? this.parked.find((job) => job.id === jobId)
      ?? this.terminal.get(jobId)
      ?? null;
  }

  activeEmployeeCount(): number {
    return this.running.size;
  }

  setMaxWorkers(maxWorkers: number): void {
    this.maxWorkers = normalizeMaxWorkers(maxWorkers);
    this.tryPromoteInternal(false);
  }

  /**
   * 槽位事件订阅：工单晋升 running 时回调该工单；槽位释放且无可晋升候选时回调 null
   * （供 JobSpawner 启动 Pi / 回收 worker）。返回退订函数。
   */
  onSlotFree(listener: (job: JobRecord | null) => void): () => void {
    this.slotListeners.add(listener);
    return () => { this.slotListeners.delete(listener); };
  }

  /**
   * 为 running 工单获取专属资源锁（默认取工单自带 resourceLocks）。
   * 任一锁已被其他 running 工单持有 -> JOB_LOCK_CONFLICT；工单不在 running -> JOB_NOT_RUNNING。
   */
  acquireEntityLocks(jobId: string, keys?: readonly string[]): EntityLockResult {
    const job = this.running.get(jobId);
    if (!job) return { ok: false, code: 'JOB_NOT_RUNNING', jobId };
    const target = keys ?? job.resourceLocks;
    for (const key of target) {
      const holder = this.locks.get(key);
      if (holder !== undefined && holder !== jobId) {
        return { ok: false, code: 'JOB_LOCK_CONFLICT', jobId, key, heldBy: holder };
      }
    }
    for (const key of target) this.locks.set(key, jobId);
    return { ok: true, keys: [...target] };
  }

  /** 释放工单持有的锁；keys 缺省时释放该工单的全部锁，并重扫 parked 车道。 */
  releaseEntityLocks(jobId: string, keys?: readonly string[]): void {
    if (keys) {
      for (const key of keys) {
        if (this.locks.get(key) === jobId) this.locks.delete(key);
      }
      this.tryPromoteInternal(false);
      return;
    }
    this.clearLocks(jobId);
    this.tryPromoteInternal(false);
  }

  private clearLocks(jobId: string): void {
    for (const [key, holder] of this.locks) {
      if (holder === jobId) this.locks.delete(key);
    }
  }

  private recordTerminal(job: JobRecord, status: JobTerminalStatus, error: string | null, report: RoleJobReportV1 | null): JobRecord {
    const done = Object.freeze<JobRecord>({ ...job, status, finishedAt: nowIso(), error, report });
    this.running.delete(job.id);
    this.terminal.set(job.id, done);
    this.clearLocks(job.id);
    this.submitSeq.delete(job.id);
    return done;
  }

  /**
   * 槽位事件通知（微任务异步派发）。
   *
   * WMB-5116 根因修复：事件**必须**异步（queueMicrotask）派发——`park → tryPromote →
   * markRunning → emit → spawner.runJob → park` 若同步链式触发，单次 submit/complete 会
   * 在池的晋升级联内同步重入 runJob（锁风暴时深度=队列长度），最终栈溢出/Map 爆满。
   * 微任务派发后每次晋升只驱动一轮 runJob，天然打破递归；状态（running/waiting_resource）
   * 仍同步落池，`pool.get` 立即可读。
   */
  private emitSlotFree(job: JobRecord | null): void {
    queueMicrotask(() => {
      for (const listener of this.slotListeners) listener(job);
    });
  }
}
