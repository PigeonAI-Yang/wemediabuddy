import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { IpcMain } from 'electron';
import { CommandDispatcher, type CommandEnvelopeV1, type CommandHandlerResult, type CommandReceiptV1 } from './command-dispatcher.ts';
import { assertTaskGrantForEnvelope } from './task-grants.ts';
import { assertExecutionGrantForEnvelope } from './execution-grants.ts';
import { installWorkspaceWriteGuard } from './db/write-guard.ts';

function busy(message: string): Error {
  return Object.assign(new Error(message), { code: 'WORKSPACE_BUSY' });
}
export type WorkspaceRuntimeIdentity = Readonly<{
  workspaceId: string;
  rootPath: string;
  runtimeEpoch: string;
}>;


export type WorkspaceRuntimeLease = Readonly<WorkspaceRuntimeIdentity & {
  kind: 'pi-worker' | 'browser';
  leaseId: string;
  taskId: string | null;
}>;

type Stoppable = { stop: () => void | Promise<void> };
type Closable = { close: () => void | Promise<void> };
type RuntimeResource = Stoppable | Closable;

export type ActiveWorkspaceRuntimeOptions = {
  expectedWorkspaceId?: string;
  createEpoch?: () => string;
  openDatabase?: (databasePath: string) => DatabaseSync;
  gate?: WorkspaceRuntimeGate;
};
export const RUNTIME_MANAGING_IPC_CHANNELS = [
  'workspaces:switch',
  'workspaces:proposal-confirm',
  'browser-profiles:create',
  'workspace-browser:rebind',
  'workspace-browser:verify',
  'workspace-browser:migrate-legacy'
] as const;

export class WorkspaceRuntimeGate {
  private open = true;
  private active = 0;
  private readonly drained = new Set<() => void>();

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    if (!this.open) throw busy('工作空间正在切换，暂不接受新操作。');
    this.active += 1;
    try { return await work(); }
    finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.drained) resolve();
        this.drained.clear();
      }
    }
  }

  async closeAndDrain(timeoutMs = 5_000): Promise<void> {
    this.open = false;
    if (this.active === 0) return;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrain = resolve; this.drained.add(resolve); });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(busy('当前操作无法在时限内安全排空。')), timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.drained.delete(resolveDrain);
    }
  }

  reopen(): void { this.open = true; }
}

export class ActiveWorkspaceRuntime {
  readonly identity: WorkspaceRuntimeIdentity;
  readonly gate: WorkspaceRuntimeGate;
  readonly database: DatabaseSync;
  private readonly dispatcher: CommandDispatcher;
  private writeAuthorizationDepth = 0;
  private readonly isWriteAuthorized = (): boolean => this.writeAuthorizationDepth > 0;
  private state: 'active' | 'draining' | 'stopping' | 'stopped' = 'active';
  private worker: { lease: WorkspaceRuntimeLease; resource: Stoppable | null } | null = null;
  private browser: { lease: WorkspaceRuntimeLease; resource: object; closer: Stoppable } | null = null;
  private scheduler: Stoppable | null = null;
  private mcp: Closable | null = null;
  private xhs: Stoppable | null = null;
  private unsafeBrowserClaims = 0;
  private stopPromise: Promise<void> | null = null;
  private piSessionFile: string | null = null;

  static open(rootPath: string, options: ActiveWorkspaceRuntimeOptions = {}): ActiveWorkspaceRuntime {
    const resolvedRootPath = path.resolve(rootPath);
    const database = (options.openDatabase ?? ((databasePath) => new DatabaseSync(databasePath)))(path.join(resolvedRootPath, 'wmb.db'));
    try {
      const workspaceId = (database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
      if (!workspaceId || (options.expectedWorkspaceId && workspaceId !== options.expectedWorkspaceId)) throw new Error('活动工作空间身份不一致。');
      const identity = Object.freeze({ workspaceId, rootPath: resolvedRootPath, runtimeEpoch: (options.createEpoch ?? randomUUID)() });
      return new ActiveWorkspaceRuntime(database, identity, options.gate ?? new WorkspaceRuntimeGate());
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private constructor(database: DatabaseSync, identity: WorkspaceRuntimeIdentity, gate: WorkspaceRuntimeGate) {
    this.database = database;
    this.identity = Object.freeze(identity);
    this.gate = gate;
    installWorkspaceWriteGuard(database, this.isWriteAuthorized);
    this.dispatcher = new CommandDispatcher(database, identity, undefined, undefined, (envelope) => {
      assertTaskGrantForEnvelope(database, envelope, new Date(), (leaseId, taskId) => this.isCurrentWorkerLease(leaseId, taskId));
      assertExecutionGrantForEnvelope(database, envelope, new Date());
    });
  }

  get isActive(): boolean { return this.state === 'active'; }
  getWorker<T extends Stoppable>(): T | null { return this.worker?.resource as T ?? null; }
  getBrowser<T extends object>(): T | null { return this.browser?.resource as T ?? null; }
  getMcp<T extends Closable>(): T | null { return this.mcp as T ?? null; }
  getXhs<T extends Stoppable>(): T | null { return this.xhs as T ?? null; }
  getPiSessionFile(): string | null { return this.piSessionFile; }
  setPiSessionFile(sessionFile: string | null): void { this.assertActive(); this.piSessionFile = sessionFile; }
  getScheduler<T extends Stoppable>(): T | null { return this.scheduler as T ?? null; }

  isCurrentWorkerLease(leaseId: string, taskId: string): boolean {
    return this.state === 'active' && this.worker?.lease.leaseId === leaseId && this.worker.lease.taskId === taskId;
  }
  runAtomic<T>(work: () => T | Promise<T>): Promise<T> {
    this.assertActive();
    return this.gate.run(work);
  }

  dispatchCommand<T>(envelope: CommandEnvelopeV1, handler: () => CommandHandlerResult<T>): Promise<CommandReceiptV1<T>> {
    return this.runAtomic(() => {
      this.writeAuthorizationDepth += 1;
      try {
        return this.dispatcher.dispatch(envelope, handler);
      } finally {
        try { installWorkspaceWriteGuard(this.database, this.isWriteAuthorized); }
        finally { this.writeAuthorizationDepth -= 1; }
      }
    });
  }

  async closeClaimsAndDrain(timeoutMs = 5_000): Promise<void> {
    this.assertActive();
    if (this.unsafeBrowserClaims > 0) throw busy('当前存在无法安全排空的浏览器外部操作。');
    this.state = 'draining';
    try { await this.gate.closeAndDrain(timeoutMs); }
    catch (error) { this.state = 'active'; this.gate.reopen(); throw error; }
  }

  reopenClaims(): void {
    if (this.state !== 'draining') return;
    this.gate.reopen();
    this.state = 'active';
  }

  acquireWorkerLease(taskId: string | null = null): WorkspaceRuntimeLease {
    this.assertActive();
    if (this.worker) throw busy('当前 Pi worker lease 尚未释放。');
    const lease = Object.freeze({ ...this.identity, kind: 'pi-worker' as const, leaseId: randomUUID(), taskId });
    this.worker = { lease, resource: null };
    return lease;
  }

  bindWorker(lease: WorkspaceRuntimeLease, resource: Stoppable): void {
    this.assertActive();
    this.assertCurrentLease(lease, 'pi-worker');
    if (!this.worker || this.worker.resource) throw busy('当前 Pi worker lease 尚未释放。');
    this.worker.resource = resource;
  }

  bindWorkerTask(lease: WorkspaceRuntimeLease, taskId: string): void {
    this.assertActive();
    this.assertCurrentLease(lease, 'pi-worker');
    if (!this.worker || !taskId.trim() || (this.worker.lease.taskId && this.worker.lease.taskId !== taskId)) throw busy('Pi worker lease 不能改绑到其他任务。');
    this.worker.lease = Object.freeze({ ...this.worker.lease, taskId });
  }

  releaseWorker(lease: WorkspaceRuntimeLease): void {
    if (this.worker?.lease.leaseId === lease.leaseId) this.worker = null;
  }

  async stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    await worker?.resource?.stop();
  }

  bindBrowser(resource: object, closer?: Stoppable): WorkspaceRuntimeLease {
    this.assertActive();
    if (this.browser) {
      if (this.browser.resource !== resource) throw busy('当前浏览器 lease 已绑定到其他资源。');
      return this.browser.lease;
    }
    const lease = Object.freeze({ ...this.identity, kind: 'browser' as const, leaseId: randomUUID(), taskId: null });
    this.browser = { lease, resource, closer: closer ?? resource as Stoppable };
    return lease;
  }

  releaseBrowser(lease?: WorkspaceRuntimeLease): void {
    if (!lease || this.browser?.lease.leaseId === lease.leaseId) this.browser = null;
  }

  async runExternalBrowserWork<T>(lease: WorkspaceRuntimeLease, work: () => T | Promise<T>): Promise<T> {
    this.assertCurrentLease(lease, 'browser');
    this.unsafeBrowserClaims += 1;
    try { return await this.gate.run(async () => { this.assertCurrentLease(lease, 'browser'); return work(); }); }
    finally { this.unsafeBrowserClaims -= 1; }
  }

  guardLease(lease: WorkspaceRuntimeLease, callback: () => void): boolean {
    if (!this.isCurrentLease(lease)) return false;
    callback();
    return true;
  }

  isCurrentLease(lease: WorkspaceRuntimeLease): boolean {
    if (this.state === 'stopping' || this.state === 'stopped' || !this.matchesIdentity(lease)) return false;
    const current = lease.kind === 'pi-worker' ? this.worker?.lease : this.browser?.lease;
    return current?.leaseId === lease.leaseId;
  }

  matchesIdentity(identity: WorkspaceRuntimeIdentity): boolean {
    return this.identity.workspaceId === identity.workspaceId
      && this.identity.rootPath === path.resolve(identity.rootPath)
      && this.identity.runtimeEpoch === identity.runtimeEpoch;
  }

  setScheduler(resource: Stoppable): void { this.assertActive(); this.scheduler = resource; }
  setMcp(resource: Closable): void { this.assertActive(); this.mcp = resource; }
  setXhs(resource: Stoppable | null): void { this.assertActive(); this.xhs = resource; }

  stop(options: { drain?: boolean; timeoutMs?: number } = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const attempt = this.stopOwnedResources(options);
    this.stopPromise = attempt;
    void attempt.catch(() => {
      if (this.state === 'active' && this.stopPromise === attempt) this.stopPromise = null;
    });
    return attempt;
  }

  private async stopOwnedResources({ drain = true, timeoutMs = 5_000 }: { drain?: boolean; timeoutMs?: number }): Promise<void> {
    if (drain && this.state === 'active') await this.closeClaimsAndDrain(timeoutMs);
    this.state = 'stopping';
    const scheduler = this.scheduler; const worker = this.worker; const browser = this.browser; const mcp = this.mcp; const xhs = this.xhs;
    this.scheduler = null; this.worker = null; this.browser = null; this.mcp = null; this.xhs = null;
    const errors: unknown[] = [];
    for (const resource of [scheduler, worker?.resource, browser?.closer, mcp, xhs]) {
      if (!resource) continue;
      try {
        if ('stop' in resource) await resource.stop();
        else await resource.close();
      } catch (error) { errors.push(error); }
    }
    try { this.database.close(); } catch (error) { errors.push(error); }
    this.state = 'stopped';
    if (errors.length) throw errors[0];
  }

  private assertActive(): void {
    if (this.state !== 'active') throw busy('工作空间正在切换，暂不接受新操作。');
  }

  private assertLease(lease: WorkspaceRuntimeLease, kind: WorkspaceRuntimeLease['kind']): void {
    this.assertActive();
    if (lease.kind !== kind || !this.matchesIdentity(lease)) throw busy('运行时 lease 已失效。');
  }

  private assertCurrentLease(lease: WorkspaceRuntimeLease, kind: WorkspaceRuntimeLease['kind']): void {
    if (lease.kind !== kind || !this.isCurrentLease(lease)) throw busy('运行时 lease 已失效。');
  }
}

export function installWorkspaceIpcGate(ipcMain: Pick<IpcMain, 'handle'>, gate: WorkspaceRuntimeGate, exemptChannels = ['workspaces:switch']): void {
  const handle = ipcMain.handle.bind(ipcMain);
  const exempt = new Set(exemptChannels);
  ipcMain.handle = ((channel, listener) => handle(channel, (event, ...args) => exempt.has(channel)
    ? listener(event, ...args)
    : gate.run(() => listener(event, ...args)))) as IpcMain['handle'];
}

export function installActiveWorkspaceIpcGate(
  ipcMain: Pick<IpcMain, 'handle'>,
  getRuntime: () => ActiveWorkspaceRuntime | null,
  exemptChannels = ['workspaces:switch']
): void {
  const handle = ipcMain.handle.bind(ipcMain);
  const exempt = new Set(exemptChannels);
  ipcMain.handle = ((channel, listener) => handle(channel, (event, ...args) => {
    const runtime = getRuntime();
    return exempt.has(channel) || !runtime
      ? listener(event, ...args)
      : runtime.runAtomic(() => listener(event, ...args));
  })) as IpcMain['handle'];
}

export async function stopProcessTree(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  let didExit = false;
  const exited = new Promise<void>((resolve) => child.once('exit', () => { didExit = true; resolve(); }));
  if (process.platform === 'win32') {
    await stopProcessIdTree(child.pid);
  } else {
    child.kill();
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => { timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, timeoutMs); })
  ]);
  if (timer) clearTimeout(timer);
  if (!didExit) throw Object.assign(new Error(`进程树 ${child.pid} 未在时限内退出。`), { code: 'WORKSPACE_SWITCH_FAILED' });
}

export async function stopProcessIdTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await new Promise<void>((resolve, reject) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => error ? reject(error) : resolve()));
}

export function assertWorkspaceSwitchable(rootPath: string, input: { piActive: boolean; dailyRunCount: number }): void {
  if (input.piActive || input.dailyRunCount > 0) throw busy('当前 Pi 或每日任务仍在运行。');
  const database = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
  try {
    const agent = database.prepare("SELECT id FROM agent_tasks WHERE status = 'running' LIMIT 1").get();
    const publication = database.prepare("SELECT id FROM publications WHERE status = 'publishing' LIMIT 1").get();
    const xList = database.prepare("SELECT id FROM x_list_operations WHERE state = 'running' LIMIT 1").get();
    const job = database.prepare("SELECT id FROM jobs WHERE status = 'running' LIMIT 1").get();
    if (agent || publication || xList || job) throw busy('当前存在未安全结束的工作或外部写入。');
  } finally {
    database.close();
  }
}
