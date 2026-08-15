import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import { X_BROWSER_VIEWPORT, X_HUMANIZATION, computeCooldownMs, nextActionDelayMs, randomFloat, randomInt } from './x-humanization.ts';
import { cubicBezier } from './x-list-primitives.ts';

const execFileAsync = promisify(execFile);

export class XListNeedsUserError extends Error {}
export class XListPlatformRejectedError extends XListNeedsUserError {}
export class XListCooldownError extends Error {}
export class XListDataError extends XListCooldownError {}
export class XListSupersededError extends Error {
  constructor(message = '已切换到更新的 X 操作，旧请求已取消。') {
    super(message);
    this.name = 'XListSupersededError';
  }
}

export type NavMode = 'full' | 'browse' | 'fast';

export function hasUsableDocumentText(text: string): boolean {
  return text.trim().length > 0;
}

export async function applyHumanViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: X_BROWSER_VIEWPORT.width, height: X_BROWSER_VIEWPORT.height }).catch(() => {});
}

export async function captureForegroundWindowHwnd(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Add-Type -Name W -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [UInt64][U.W]::GetForegroundWindow()'
    ], { windowsHide: true, timeout: 3_000 });
    const value = stdout.trim();
    return /^\d+$/.test(value) && value !== '0' ? value : null;
  } catch {
    return null;
  }
}

export async function restoreForegroundWindowHwnd(hwnd: string | null): Promise<void> {
  if (process.platform !== 'win32' || !hwnd) return;
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);'; $h=[IntPtr]${hwnd}; if([U.W]::IsWindow($h)){[void][U.W]::SetForegroundWindow($h)}`
    ], { windowsHide: true, timeout: 3_000 });
  } catch {
    // Best-effort only.
  }
}

export class SharedXRequestGuard {
  private readonly stateDir = path.join(homedir(), '.pyaireader', 'guards');
  private readonly statePath = path.join(this.stateDir, 'x-request-guard.json');
  private readonly lockPath = path.join(this.stateDir, 'x-request-guard.lock');

  async wait(mode: NavMode = 'full'): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await withDirectoryLock(this.lockPath, 60_000, async () => {
      const state = await this.readState();
      const now = Date.now();
      if (state.cooldownUntil > now) throw new XListCooldownError(`X 正在冷却，${Math.ceil((state.cooldownUntil - now) / 1_000)} 秒后再试。`);
      const delay = nextActionDelayMs(now, state.lastRequestAt, { mode });
      if (delay) await sleep(delay);
      const requestAt = Date.now();
      await this.writeState({
        ...state,
        lastRequestAt: requestAt
      });
    });
  }

  async recordSuccess(): Promise<void> {
    await withDirectoryLock(this.lockPath, 60_000, async () => {
      const state = await this.readState();
      await this.writeState({ ...state, consecutiveFailures: 0, cooldownUntil: 0 });
    });
  }

  async recordFailure(rateLimited = false): Promise<void> {
    await withDirectoryLock(this.lockPath, 60_000, async () => {
      const state = await this.readState();
      const consecutiveFailures = state.consecutiveFailures + 1;
      const cooldown = computeCooldownMs(consecutiveFailures, rateLimited);
      await this.writeState({ ...state, consecutiveFailures, cooldownUntil: Math.max(state.cooldownUntil, Date.now() + cooldown) });
    });
  }

  private async readState(): Promise<{ lastRequestAt: number; cooldownUntil: number; consecutiveFailures: number }> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as {
        last_request_at?: number;
        cooldown_until?: number;
        consecutive_failures?: number;
      };
      return {
        lastRequestAt: Number(parsed.last_request_at ?? 0) * 1_000,
        cooldownUntil: Number(parsed.cooldown_until ?? 0) * 1_000,
        consecutiveFailures: Number(parsed.consecutive_failures ?? 0)
      };
    } catch {
      return { lastRequestAt: 0, cooldownUntil: 0, consecutiveFailures: 0 };
    }
  }

  private async writeState(state: { lastRequestAt: number; cooldownUntil: number; consecutiveFailures: number }): Promise<void> {
    await writeFile(`${this.statePath}.tmp`, JSON.stringify({
      last_request_at: state.lastRequestAt / 1_000,
      cooldown_until: state.cooldownUntil / 1_000,
      consecutive_failures: state.consecutiveFailures
    }) + '\n', 'utf8');
    await rename(`${this.statePath}.tmp`, this.statePath);
  }
}

export class XInteractionLease {
  private readonly path = path.join(homedir(), '.pyaireader', 'guards', 'x-list-operation.lock');
  private readonly ownerPath = path.join(this.path, 'owner.json');

  static async acquire(): Promise<XInteractionLease> {
    const lease = new XInteractionLease();
    await mkdir(path.dirname(lease.path), { recursive: true });
    const deadline = Date.now() + 8_000;
    for (;;) {
      try {
        await mkdir(lease.path);
        await writeFile(lease.ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n', 'utf8');
        return lease;
      } catch {
        // Same process can reclaim its own stale lock (previous hung op failed to release).
        if (await reclaimStaleLockDir(lease.path, lease.ownerPath, 15_000, { allowSamePidAfterMs: 8_000 })) continue;
        if (Date.now() >= deadline) throw new XListCooldownError('X 操作正在被另一个会话占用。请稍后重试；若持续失败，重启应用。');
        await sleep(80);
      }
    }
  }

  async release(): Promise<void> {
    await rmdir(this.path, { recursive: true }).catch(async () => {
      await rmdir(this.path).catch(() => {});
    });
  }
}

async function withDirectoryLock(lockPath: string, staleAfterMs: number, action: () => Promise<void>): Promise<void> {
  const ownerPath = path.join(lockPath, 'owner.json');
  const deadline = Date.now() + 12_000;
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n', 'utf8').catch(() => {});
      break;
    } catch {
      if (await reclaimStaleLockDir(lockPath, ownerPath, staleAfterMs, { allowSamePidAfterMs: 5_000 })) continue;
      if (Date.now() >= deadline) throw new XListCooldownError('X 操作正在被另一个会话占用。');
      await sleep(80);
    }
  }
  try { await action(); }
  finally {
    await rmdir(lockPath, { recursive: true }).catch(async () => {
      await rmdir(lockPath).catch(() => {});
    });
  }
}

async function reclaimStaleLockDir(
  lockPath: string,
  ownerPath: string,
  staleAfterMs: number,
  options: { allowSamePidAfterMs?: number } = {}
): Promise<boolean> {
  const info = await stat(lockPath).catch(() => null);
  if (!info) return false;
  let ownerPid: number | null = null;
  let createdAt = info.mtimeMs;
  try {
    const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid?: number; createdAt?: number };
    if (Number.isFinite(Number(parsed.pid))) ownerPid = Number(parsed.pid);
    if (Number.isFinite(Number(parsed.createdAt))) createdAt = Number(parsed.createdAt);
  } catch {
    // Legacy empty lock dirs have no owner marker.
  }
  const age = Date.now() - createdAt;
  const ownerDead = ownerPid != null ? !isPidAlive(ownerPid) : false;
  const samePidStuck = ownerPid === process.pid && age >= (options.allowSamePidAfterMs ?? Number.POSITIVE_INFINITY);
  const staleByAge = age > staleAfterMs;
  if (!ownerDead && !samePidStuck && !staleByAge) return false;
  await rmdir(lockPath, { recursive: true }).catch(async () => {
    await rmdir(lockPath).catch(() => {});
  });
  return true;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM';
  }
}

export async function humanPointerClick(page: Page, start: { x: number; y: number }, target: { x: number; y: number }): Promise<void> {
  const steps = randomInt(X_HUMANIZATION.pointerStepsMin, X_HUMANIZATION.pointerStepsMax);
  const duration = randomInt(X_HUMANIZATION.pointerDurationMinMs, X_HUMANIZATION.pointerDurationMaxMs);
  const controlA = { x: start.x + (target.x - start.x) * randomFloat(0.2, 0.45) + randomInt(-90, 90), y: start.y + randomInt(-140, 140) };
  const controlB = { x: start.x + (target.x - start.x) * randomFloat(0.55, 0.85) + randomInt(-90, 90), y: target.y + randomInt(-140, 140) };
  for (let step = 1; step <= steps; step += 1) {
    const point = cubicBezier(start, controlA, controlB, target, step / steps);
    const jitter = step === steps ? 0 : randomInt(-3, 3);
    await page.mouse.move(point.x + jitter, point.y + jitter);
    await sleep(Math.max(1, Math.round(duration / steps)));
  }
  await sleep(randomInt(X_HUMANIZATION.pointerPreClickPauseMinMs, X_HUMANIZATION.pointerPreClickPauseMaxMs));
  await page.mouse.down();
  await sleep(randomInt(X_HUMANIZATION.pointerDownUpMinMs, X_HUMANIZATION.pointerDownUpMaxMs));
  await page.mouse.up();
}

export async function typeHumanly(page: Page, value: string): Promise<void> {
  for (const character of value) {
    await page.keyboard.type(character);
    await sleep(randomInt(X_HUMANIZATION.typeDelayMinMs, X_HUMANIZATION.typeDelayMaxMs));
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
