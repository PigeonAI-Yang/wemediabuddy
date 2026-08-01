import path from 'node:path';
import { execFile, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { IpcMain } from 'electron';

function busy(message: string): Error {
  return Object.assign(new Error(message), { code: 'WORKSPACE_BUSY' });
}

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

export function installWorkspaceIpcGate(ipcMain: Pick<IpcMain, 'handle'>, gate: WorkspaceRuntimeGate, exemptChannels = ['workspaces:switch']): void {
  const handle = ipcMain.handle.bind(ipcMain);
  const exempt = new Set(exemptChannels);
  ipcMain.handle = ((channel, listener) => handle(channel, (event, ...args) => exempt.has(channel)
    ? listener(event, ...args)
    : gate.run(() => listener(event, ...args)))) as IpcMain['handle'];
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
