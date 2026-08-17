import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeLease } from './workspace-runtime.ts';
import {
  DEFAULT_MAX_WORKERS,
  JobPool,
  type JobInput,
  type JobRecord,
  type JobStatus
} from './job-pool.ts';
import {
  dispatchFailAgentTask,
  dispatchReportAgentTaskProgress
} from './agent-task-commands.ts';
import { shanghaiDate } from './ferment.ts';
import { getAgentTask, type AgentIntent } from './agent-tasks.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  createStoppableRegistrar,
  disposeHandles,
  ownerJobsActor,
  parkDeferred,
  runCancellationSequence,
  type Stoppable
} from './job-control.ts';
import {
  buildRoleJobReport,
  deriveIntentForRole,
  deriveRoleJobSpec,
  JOB_ERROR_CODES,
  mapOutcomeToTerminal,
  parseRoleJobRequest,
  type JobExecutionOutcome,
  type RoleJobReportV1,
  type RoleJobRequest,
  type JobTerminalStatus
} from './role-job-registry.ts';
import { readProjectInvestigation } from './project-investigation.ts';

/**
 * 外部派工请求 = roleId 判别联合（WMB-5116 §5.1）：**无 intent、无 planDate**；
 * intent / 锁键 / 策略 / 读回规则由 role-job-registry 唯一派生。
 */
export type SpawnJobRequest = RoleJobRequest;

export type JobRuntimeHandle = {
  jobId: string;
  taskId: string | null;
  leaseId: string | null;
  grantId: string | null;
  sessionFile: string | null;
};

export type JobMessage = Readonly<{
  id: string;
  jobId: string;
  from: 'desk' | 'system';
  body: string;
  at: string;
}>;

export type JobExecuteContext = {
  runtime: ActiveWorkspaceRuntime;
  job: JobRecord;
  /** 工单池（本工单所属）；WMB-5142 生命周期「处理」关闭旧卡用。 */
  pool: JobPool;
  lease: WorkspaceRuntimeLease;
  taskId: string | null;
  grantId: string | null;
  sessionFile: string;
  signal: AbortSignal;
  request: RoleJobRequest | null;
  /** 单一 stoppable 注册协议（§6.3）：执行器在 Pi runtime 就绪时注册 stop，取消序列强停。 */
  registerStoppable?: (stop: Stoppable) => void;
  /** 当前已注册的 stop（null = 未注册；getter 实时反映注册结果）。 */
  stopResource: Stoppable | null;
  /** 执行器自建权威 task 后回写 handle，供取消/推送/roster 使用 */
  onTaskBound?: (taskId: string, grantId: string | null) => void;
};

export type JobSpawnerOptions = {
  maxWorkers?: number;
  /** Default fails with JOB_EXECUTE_NOT_CONFIGURED — inject GenericEmployeeRunner in production. */
  execute?: (ctx: JobExecuteContext) => Promise<JobExecutionOutcome>;
  onEvent?: (event: Record<string, unknown>) => void;
};

type InternalHandle = Omit<JobRuntimeHandle, 'taskId' | 'grantId'> & {
  taskId: string | null;
  grantId: string | null;
  abort: AbortController;
  lease: WorkspaceRuntimeLease | null;
  stopResource: Stoppable | null;
};

const TERMINAL_EVENT: Readonly<Record<JobTerminalStatus, string>> = Object.freeze({
  succeeded: 'job.finished', failed: 'job.failed', cancelled: 'job.cancelled', partial: 'job.partial', needs_user: 'job.needs_user'
});

function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'partial' || status === 'needs_user';
}

function cancelledOutcome(): JobExecutionOutcome {
  return Object.freeze({ status: 'cancelled', code: JOB_ERROR_CODES.JOB_CANCELLED, message: null, readback: null });
}

function failedOutcome(code: string, message: string | null): JobExecutionOutcome {
  return Object.freeze({ status: 'failed', code, message, readback: null });
}

/**
 * Desk 经理派工：JobPool 排队/泊车 + employee lease + 授权由执行器完成。
 * 资源竞争（锁冲突 / lease 忙）进入 waiting_resource，不落失败；终态由 outcome 唯一映射。
 */
export class JobSpawner {
  readonly pool: JobPool;
  private readonly runtime: ActiveWorkspaceRuntime;
  readonly workspaceKey: string;
  private readonly handles = new Map<string, InternalHandle>();
  private readonly messages = new Map<string, JobMessage[]>();
  private readonly jobRequests = new Map<string, RoleJobRequest>();
  private readonly execute: NonNullable<JobSpawnerOptions['execute']>;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  private readonly watchdog: ReturnType<typeof setInterval> | null;
  private enabled = true;
  private unsub: (() => void) | null = null;
  private starting = new Set<string>();
  readonly hasCustomExecute: boolean;

  constructor(runtime: ActiveWorkspaceRuntime, options: JobSpawnerOptions = {}) {
    this.runtime = runtime;
    this.workspaceKey = `${runtime.identity.workspaceId}:${runtime.identity.runtimeEpoch ?? ''}:${runtime.identity.rootPath}`;
    this.pool = new JobPool(options.maxWorkers ?? DEFAULT_MAX_WORKERS);
    this.onEvent = options.onEvent ?? (() => {});
    this.hasCustomExecute = typeof options.execute === 'function';
    this.execute = options.execute ?? (async () => { throw Object.assign(new Error('JOB_EXECUTE_NOT_CONFIGURED: 未注入员工执行器'), { code: 'JOB_EXECUTE_NOT_CONFIGURED' }); });
    this.unsub = this.pool.onSlotFree((job) => {
      if (job && job.status === 'running') void this.runJob(job.id);
    });
    // 60s 看门狗：资源释放事件丢失时兜底重扫 parked 车道，杜绝永久泊车（§8.2）。
    this.watchdog = setInterval(() => {
      try { this.pool.rescan(); } catch { /* 看门狗尽力而为 */ }
    }, 60_000);
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.pool.setMaxWorkers(0);
  }

  setMaxWorkers(max: number): void {
    this.enabled = max > 0;
    this.pool.setMaxWorkers(max);
  }

  getMaxWorkers(): number {
    return this.pool.getMaxWorkers();
  }

  list(): JobRecord[] {
    return this.pool.list();
  }

  get(jobId: string): JobRecord | null {
    return this.pool.get(jobId);
  }
  getHandle(jobId: string): JobRuntimeHandle | null {
    const h = this.handles.get(jobId);
    if (!h) return null;
    return { jobId: h.jobId, taskId: h.taskId, leaseId: h.leaseId, grantId: h.grantId, sessionFile: h.sessionFile };
  }
  spawn(input: SpawnJobRequest, jobId: string | null = null): JobRecord {
    if (jobId !== null && !jobId.trim()) throw Object.assign(new Error('JOB_ID_REQUIRED'), { code: 'JOB_ID_REQUIRED' });
    if (!this.enabled) {
      throw Object.assign(new Error('JOB_SPAWN_DISABLED: 员工派出已关闭（maxWorkers=0）。'), { code: 'JOB_SPAWN_DISABLED' });
    }
    // strict-key 校验 + 运行时拒 intent；writer 缺 projectId 抛 JOB_PROJECT_REQUIRED。
    const request = parseRoleJobRequest(input);
    // WMB-5290 写手服务端门：项目存在专项调查且状态未达可写 → 拒绝派写手（fail-closed，
    // 在池提交前抛错，不产生工单行）。legacy 项目（无调查行）保持既有行为放行；
    // ready_to_write 允许首派；writing 允许已批准方向的续跑/重试（同一批准方向不重复审批）。
    if (request.roleId === 'writer') {
      const investigation = readProjectInvestigation(this.runtime.database, request.projectId);
      if (investigation && investigation.status !== 'ready_to_write' && investigation.status !== 'writing') {
        throw Object.assign(
          new Error(`JOB_INVESTIGATION_NOT_READY: 项目调查状态（${investigation.status}）未达可写（ready_to_write），禁止派写手。`),
          { code: JOB_ERROR_CODES.JOB_INVESTIGATION_NOT_READY }
        );
      }
    }
    const spec = deriveRoleJobSpec(request, this.runtime.identity.workspaceId);
    const jobInput: JobInput = {
      roleId: spec.roleId,
      brief: request.brief,
      intent: spec.intent,
      businessDate: spec.businessDate,
      planDate: spec.businessDate,
      projectId: spec.projectId,
      writerTask: spec.writerTask,
      resourceLocks: spec.resourceLocks
    };

    // 锁冲突不再在 spawn 预检抛错：资源竞争统一进 waiting_resource，由池内晋升。
    const existing = jobId ? this.pool.get(jobId) : null;
    if (existing) return existing;
    const job = jobId ? this.pool.submitWithId(jobId, jobInput) : this.pool.submit(jobInput);
    this.jobRequests.set(job.id, request);
    this.emit('job.queued', job);
    // job.started 只在 runJob 真正启动执行时单点发出（避免与微任务内 runJob 双发）。
    broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.spawn' });
    return this.pool.get(job.id)!;
  }

  async await(jobId: string, timeoutMs = 120_000): Promise<JobRecord> {
    const start = Date.now();
    for (;;) {
      const job = this.pool.get(jobId);
      if (!job) throw Object.assign(new Error('工单不存在。'), { code: 'JOB_NOT_FOUND' });
      if (isTerminal(job.status)) return job;
      if (Date.now() - start > timeoutMs) throw Object.assign(new Error('等待工单超时。'), { code: 'JOB_AWAIT_TIMEOUT' });
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  listMessages(jobId: string): JobMessage[] {
    return [...(this.messages.get(jobId) ?? [])];
  }

  /**
   * 主管给工单留言。queued/waiting_resource/running 可写；终态仍可留审计附言。
   * running 且已绑定 task 时，同步写一条 task progress（前缀 [主管]）。
   */
  async postMessage(jobId: string, body: string, from: 'desk' | 'system' = 'desk'): Promise<JobMessage> {
    const job = this.pool.get(jobId);
    if (!job) throw Object.assign(new Error('工单不存在。'), { code: 'JOB_NOT_FOUND' });
    const text = String(body || '').trim();
    if (!text) throw Object.assign(new Error('留言不能为空。'), { code: 'JOB_MESSAGE_REQUIRED' });
    if (text.length > 2000) throw Object.assign(new Error('留言过长（≤2000）。'), { code: 'JOB_MESSAGE_TOO_LONG' });

    const msg: JobMessage = Object.freeze({
      id: randomUUID(),
      jobId,
      from,
      body: text,
      at: new Date().toISOString()
    });
    const bucket = this.messages.get(jobId) ?? []; bucket.push(msg); this.messages.set(jobId, bucket);

    const handle = this.handles.get(jobId);
    if (job.status === 'running' && handle?.taskId) {
      try {
        await dispatchReportAgentTaskProgress(this.runtime, handle.taskId, {
          message: `[主管] ${text}`,
          level: 'info'
        }, {
          actor: ownerJobsActor(),
          requestId: randomUUID(),
          workerLeaseId: handle.leaseId ?? undefined,
          taskId: handle.taskId
        });
      } catch {
        /* progress best-effort */
      }
    }

    this.onEvent({ type: 'job.message', jobId, messageId: msg.id, from, body: text });
    broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.message' });
    return msg;
  }

  /** 取消：queued / waiting_resource / running 三态均落 cancelled（§9.1），资源全部释放（薄委托 job-control §6.2）。 */
  async cancel(jobId: string): Promise<JobRecord | null> {
    return runCancellationSequence(jobId, this.handles.get(jobId) ?? null, {
      runtime: this.runtime,
      pool: this.pool,
      onCancelled: (cancelled) => {
        this.emit('job.cancelled', cancelled);
        broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.cancel' });
      },
      onCleanup: (id) => {
        this.handles.delete(id);
        this.starting.delete(id);
        this.jobRequests.delete(id);
      }
    });
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.watchdog) clearInterval(this.watchdog);
    disposeHandles(this.handles.values(), this.runtime);
    this.handles.clear();
    this.starting.clear();
    this.messages.clear();
    this.jobRequests.clear();
  }

  private emit(type: string, job: JobRecord): void {
    this.onEvent({
      type,
      jobId: job.id,
      roleId: job.roleId,
      status: job.status,
      intent: job.intent,
      error: job.error,
      brief: job.brief,
      waitReason: job.waitReason,
      waitingSince: job.waitingSince,
      report: job.report
    });
  }

  private buildReport(job: JobRecord, outcome: JobExecutionOutcome, status: JobTerminalStatus, taskId: string | null, finishedAt: string): RoleJobReportV1 {
    const phase = taskId ? getAgentTask(this.runtime.database, taskId)?.phase ?? null : null;
    return buildRoleJobReport({
      jobId: job.id,
      roleId: job.roleId,
      intent: (job.intent ?? deriveIntentForRole(job.roleId)) as AgentIntent,
      status,
      code: status === 'cancelled' ? JOB_ERROR_CODES.JOB_CANCELLED : outcome.code,
      businessDate: job.businessDate ?? shanghaiDate(),
      projectId: job.projectId,
      taskId,
      phase,
      readback: outcome.readback,
      startedAt: job.startedAt,
      finishedAt,
      errorMessage: outcome.message
    });
  }

  private async runJob(jobId: string): Promise<void> {
    if (this.handles.has(jobId) || this.starting.has(jobId)) return;
    const job = this.pool.get(jobId);
    if (!job || job.status !== 'running') return;
    this.starting.add(jobId);

    const abort = new AbortController();
    const runtime = this.runtime;
    let lease: WorkspaceRuntimeLease | null = null;
    let taskId: string | null = null;
    let grantId: string | null = null;
    let sessionFile: string | null = null;

    const handle: InternalHandle = {
      jobId,
      taskId: null,
      leaseId: null,
      grantId: null,
      sessionFile: null,
      abort,
      lease: null,
      stopResource: null
    };
    this.handles.set(jobId, handle);

    try {
      // 实体锁冲突 → waiting_resource(RESOURCE_LOCK_CONFLICT)，不落失败、不抛 spawn 异常。
      const lock = this.pool.acquireEntityLocks(jobId);
      if (!lock.ok) {
        if (lock.code === 'JOB_LOCK_CONFLICT') {
          this.pool.park(jobId, 'RESOURCE_LOCK_CONFLICT', `${lock.key} (held by ${lock.heldBy})`);
          const parked = this.pool.get(jobId);
          if (parked) this.emit('job.waiting_resource', parked);
          this.handles.delete(jobId);
          this.starting.delete(jobId);
          return;
        }
        this.pool.fail(jobId, lock.code);
        const failed = this.pool.get(jobId);
        if (failed) this.emit('job.failed', failed);
        this.handles.delete(jobId);
        this.starting.delete(jobId);
        return;
      }

      // lease 软帽忙 → waiting_resource(RESOURCE_LEASE_BUSY)，不再退队延时重试。
      try {
        lease = runtime.acquireWorkerLease(null, job.roleId, 'employee');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
        if (code === 'WORKSPACE_BUSY' || /软上限|尚未释放|WORKSPACE_BUSY/.test(message)) {
          this.pool.park(jobId, 'RESOURCE_LEASE_BUSY', message);
          const parked = this.pool.get(jobId);
          if (parked) this.emit('job.waiting_resource', parked);
          this.handles.delete(jobId);
          this.starting.delete(jobId);
          return;
        }
        throw error;
      }
      runtime.bindWorker(lease, { stop: async () => {} });

      const sessionsDir = path.join(runtime.identity.rootPath, 'agent', 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      sessionFile = path.join(sessionsDir, `job-${jobId}.jsonl`);
      handle.leaseId = lease.leaseId;
      handle.lease = lease;
      handle.sessionFile = sessionFile;
      // 单一 stoppable 注册协议（§6.3）：last registration wins；abort 后注册同步立即 stop。
      const { registerStoppable } = createStoppableRegistrar(abort.signal, (stop) => { handle.stopResource = stop; });
      this.emit('job.started', this.pool.get(jobId)!);

      if (abort.signal.aborted) throw Object.assign(new Error('JOB_CANCELLED'), { code: 'JOB_CANCELLED' });

      const outcome = await this.execute({
        runtime,
        job: this.pool.get(jobId)!,
        pool: this.pool,
        lease,
        taskId,
        grantId,
        sessionFile,
        signal: abort.signal,
        request: this.jobRequests.get(jobId) ?? null,
        registerStoppable,
        get stopResource() { return handle.stopResource; },
        onTaskBound: (boundTaskId, boundGrantId) => {
          taskId = boundTaskId;
          grantId = boundGrantId;
          handle.taskId = boundTaskId;
          handle.grantId = boundGrantId;
        }
      });

      // WMB-5118 §5.2：deferred 瞬时 outcome → 释放 lease/锁并泊车 RESOURCE_JUDGE_IN_FLIGHT（不写终态、不进五态）。
      if (outcome.status === 'deferred') { await parkDeferred(jobId, lease, { runtime, pool: this.pool, onParked: (parked) => this.emit('job.waiting_resource', parked) }); return; }
      // Release employee lease BEFORE pool terminal transition（避免下一工单晋升时撞软帽）。
      try { runtime.releaseWorker(lease); } catch { /* */ }
      lease = null;

      // §5.3：取消信号优先于一切 outcome；同一映射产出 pool 终态与报告。
      const mapping = mapOutcomeToTerminal(outcome, abort.signal.aborted);
      const report = this.buildReport(this.pool.get(jobId)!, outcome, mapping.pool, taskId, new Date().toISOString());
      const before = this.pool.get(jobId);
      const settled = this.pool.settle(jobId, mapping.pool, mapping.code, report);
      // 评审 MINOR 3：工单已被 cancel 等先行终态化（settle 未实际转换）→ 终态事件已发，不再重复 emit。
      if (before?.status === 'running' && settled) this.emit(TERMINAL_EVENT[mapping.pool], settled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'JOB_FAILED';
      if (lease) { try { runtime.releaseWorker(lease); } catch { /* */ } lease = null; }
      if (taskId && getAgentTask(runtime.database, taskId)?.status === 'running') {
        try {
          await dispatchFailAgentTask(runtime, taskId, code, message, {
            actor: ownerJobsActor(), requestId: randomUUID(), workerLeaseId: undefined, taskId
          });
        } catch { /* already terminal */ }
      }
      const aborted = abort.signal.aborted;
      const outcome = aborted ? cancelledOutcome() : failedOutcome(code, message);
      const mapping = mapOutcomeToTerminal(outcome, aborted);
      const report = this.buildReport(this.pool.get(jobId) ?? job, outcome, mapping.pool, taskId, new Date().toISOString());
      const before = this.pool.get(jobId);
      const settled = this.pool.settle(jobId, mapping.pool, mapping.code, report);
      // 同上：先行终态化（如用户 cancel）则终态事件已由 cancel 发出，不再重复。
      if (before?.status === 'running' && settled) this.emit(TERMINAL_EVENT[mapping.pool], settled);
    } finally {
      if (lease) { try { runtime.releaseWorker(lease); } catch { /* */ } }
      this.handles.delete(jobId);
      this.starting.delete(jobId);
      const settled = this.pool.get(jobId); if (!settled || isTerminal(settled.status)) this.jobRequests.delete(jobId);
      broadcastDataChanged({ scopes: ['agent'], reason: 'jobs.terminal' });
    }
  }
}

let activeSpawner: JobSpawner | null = null;

export function getActiveJobSpawner(): JobSpawner | null {
  return activeSpawner;
}

export function setActiveJobSpawner(spawner: JobSpawner | null): void {
  if (activeSpawner && activeSpawner !== spawner) activeSpawner.dispose();
  activeSpawner = spawner;
}

export function ensureJobSpawner(runtime: ActiveWorkspaceRuntime, options?: JobSpawnerOptions): JobSpawner {
  const key = `${runtime.identity.workspaceId}:${runtime.identity.runtimeEpoch ?? ''}:${runtime.identity.rootPath}`;
  if (activeSpawner) {
    const needsRebuild =
      activeSpawner.workspaceKey !== key
      || (Boolean(options?.execute) && !activeSpawner.hasCustomExecute);
    if (needsRebuild) {
      activeSpawner.dispose();
      activeSpawner = null;
    } else {
      return activeSpawner;
    }
  }
  activeSpawner = new JobSpawner(runtime, options);
  return activeSpawner;
}
