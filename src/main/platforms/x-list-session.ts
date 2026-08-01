import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { connectXBrowser } from './x.ts';
import {
  X_BROWSER_VIEWPORT,
  X_HUMANIZATION,
  chooseLongPauseEvery,
  chooseReadPlan,
  chooseSettleDelayMs,
  computeCooldownMs,
  nextActionDelayMs,
  randomFloat,
  randomInt
} from './x-humanization.ts';
import { cubicBezier, isPyaireaderXProfile, isXHomeUrl, type XListBrowserConfig } from './x-list-primitives.ts';
import { ensureQuietXBrowserWindow } from '../browser.ts';

const execFileAsync = promisify(execFile);
const SESSION_IDLE_MS = 3 * 60_000;

export class XListNeedsUserError extends Error {}
export class XListCooldownError extends Error {}
export class XListDataError extends XListCooldownError {}
export class XListSupersededError extends Error {
  constructor(message = '已切换到更新的 X 操作，旧请求已取消。') {
    super(message);
    this.name = 'XListSupersededError';
  }
}

type NavMode = 'full' | 'browse' | 'fast';

type PooledSession = {
  session: XListSession;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const sessionPool = new Map<string, PooledSession>();

export class XListSession {
  readonly guard = new SharedXRequestGuard();
  private actionCount = 0;
  private nextLongPause = chooseLongPauseEvery();
  private readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  private previousForegroundHwnd: string | null;
  private readonly poolKey: string;
  private disposed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private opSerial = 0;
  private currentOp = 0;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    previousForegroundHwnd: string | null,
    poolKey: string
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.previousForegroundHwnd = previousForegroundHwnd;
    this.poolKey = poolKey;
  }

  /** Cancel any in-flight/queued op so a newer user action can take the page immediately. */
  preempt(): void {
    this.currentOp += 1;
    void this.page.evaluate(() => {
      try { window.stop(); } catch {}
    }).catch(() => {});
  }

  private assertCurrent(opId: number): void {
    if (opId !== this.currentOp) throw new XListSupersededError();
  }

  async run<T>(action: (session: XListSession) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    // Latest-wins: a new run immediately supersedes older queued/in-flight runs.
    const opId = ++this.opSerial;
    this.currentOp = opId;
    void this.page.evaluate(() => {
      try { window.stop(); } catch {}
    }).catch(() => {});

    const timeoutMs = Math.max(3_000, options.timeoutMs ?? 20_000);
    const execute = async () => {
      this.assertCurrent(opId);
      this.previousForegroundHwnd = await captureForegroundWindowHwnd();
      this.assertCurrent(opId);
      const lease = await XInteractionLease.acquire();
      try {
        this.assertCurrent(opId);
        await ensureQuietXBrowserWindow(this.poolKey).catch(() => {});
        this.assertCurrent(opId);
        let timedOut = false;
        const timeoutError = sleep(timeoutMs).then(() => {
          timedOut = true;
          // Invalidate this op so a hung action stops touching the shared page ASAP.
          if (this.currentOp === opId) this.preempt();
          throw new Error(`X 操作超时（${Math.round(timeoutMs / 1000)}s）。请重试。`);
        });
        try {
          return await Promise.race([action(this), timeoutError]);
        } finally {
          // If we timed out, keep the supersede signal; otherwise leave latest-wins alone.
          if (timedOut) {
            void this.page.evaluate(() => {
              try { window.stop(); } catch {}
            }).catch(() => {});
          }
        }
      } finally {
        // Lease release is unconditional. A hung action must never pin the global lock.
        await lease.release();
        await this.restoreUserForeground();
      }
    };

    const result = this.chain.then(execute, execute);
    // Keep the chain healthy even if this op fails/times out.
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  static async open(config: XListBrowserConfig): Promise<XListSession> {
    if (!isPyaireaderXProfile(config) || !config.cdpUrl) {
      throw new XListNeedsUserError('X List 只能使用已选择的 Pyaireader 专用 X 登录态。');
    }
    const poolKey = config.cdpUrl.replace(/\/$/, '');
    const existing = sessionPool.get(poolKey);
    if (existing && !existing.session.disposed && existing.session.pageIsAlive()) {
      clearTimeout(existing.idleTimer ?? undefined);
      existing.idleTimer = null;
      existing.refs += 1;
      return existing.session;
    }
    if (existing) {
      await existing.session.dispose().catch(() => {});
      sessionPool.delete(poolKey);
    }

    const previousForegroundHwnd = await captureForegroundWindowHwnd();
    let browser: Browser | null = null;
    try {
      browser = await connectXBrowser(config.cdpUrl);
      const context = browser.contexts()[0];
      if (!context) throw new XListNeedsUserError('专用 X 浏览器没有可用上下文。');
      let xPages = context.pages().filter((candidate) => /^https?:\/\/(?:www\.)?x\.com\b/i.test(candidate.url()));
      if (xPages.length > 1 && xPages.every((candidate) => isXHomeUrl(candidate.url()))) {
        for (const duplicate of xPages.slice(1)) await duplicate.close({ runBeforeUnload: false });
        xPages = context.pages().filter((candidate) => /^https?:\/\/(?:www\.)?x\.com\b/i.test(candidate.url()));
      }
      if (xPages.length > 1) throw new XListNeedsUserError('请先在专用 X 浏览器只保留一个 X 标签页，再继续。');
      const page = xPages[0] ?? context.pages().find((candidate) => candidate.url() === 'about:blank') ?? await context.newPage();
      await applyHumanViewport(page).catch(() => {});
      const session = new XListSession(browser, context, page, previousForegroundHwnd, poolKey);
      sessionPool.set(poolKey, { session, refs: 1, idleTimer: null });
      await ensureQuietXBrowserWindow(poolKey).catch(() => {});
      await session.restoreUserForeground();
      return session;
    } catch (error) {
      await browser?.close().catch(() => {});
      await restoreForegroundWindowHwnd(previousForegroundHwnd);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.release();
  }

  async release(): Promise<void> {
    if (this.disposed) return;
    const pooled = sessionPool.get(this.poolKey);
    if (!pooled || pooled.session !== this) {
      await this.dispose();
      return;
    }
    pooled.refs = Math.max(0, pooled.refs - 1);
    if (pooled.refs > 0) return;
    clearTimeout(pooled.idleTimer ?? undefined);
    pooled.idleTimer = setTimeout(() => {
      void this.dispose();
    }, SESSION_IDLE_MS);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pooled = sessionPool.get(this.poolKey);
    clearTimeout(pooled?.idleTimer ?? undefined);
    sessionPool.delete(this.poolKey);
    try {
      // Keep the real browser profile running; only detach the CDP client.
      await this.browser.close().catch(() => {});
    } finally {
      await this.restoreUserForeground();
    }
  }

  pageIsAlive(): boolean {
    return !this.disposed && !this.page.isClosed();
  }

  private async restoreUserForeground(): Promise<void> {
    void ensureQuietXBrowserWindow(this.poolKey).catch(() => {});
    await restoreForegroundWindowHwnd(this.previousForegroundHwnd);
  }

  async navigateInitially(url: string, options: { mode?: NavMode } = {}): Promise<void> {
    await this.navigate(url, options);
  }

  async navigateWithinOperation(url: string, options: { mode?: NavMode } = {}): Promise<void> {
    await this.navigate(url, options);
  }

  async navigate(url: string, options: { mode?: NavMode } = {}): Promise<void> {
    const mode = options.mode ?? 'full';
    const opId = this.currentOp;
    try {
      this.assertCurrent(opId);
      const current = this.page.url().replace(/[?#].*$/, '').replace(/\/$/, '');
      const target = url.replace(/[?#].*$/, '').replace(/\/$/, '');
      if (current === target && (mode === 'fast' || mode === 'browse')) {
        await sleep(randomInt(
          mode === 'fast' ? X_HUMANIZATION.detailSettleMinMs : X_HUMANIZATION.browseSettleMinMs,
          mode === 'fast' ? X_HUMANIZATION.detailSettleMaxMs : X_HUMANIZATION.browseSettleMaxMs
        ));
        this.assertCurrent(opId);
        return;
      }
      await this.guard.wait(mode);
      this.assertCurrent(opId);
      await Promise.race([
        this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: mode === 'full' ? 30_000 : 15_000
        }),
        this.waitUntilSuperseded(opId)
      ]);
      this.assertCurrent(opId);
      if (mode === 'fast') {
        await sleep(randomInt(X_HUMANIZATION.detailPostNavMinMs, X_HUMANIZATION.detailPostNavMaxMs));
      } else if (mode === 'browse') {
        await sleep(randomInt(X_HUMANIZATION.browsePostNavMinMs, X_HUMANIZATION.browsePostNavMaxMs));
      } else {
        await this.humanBrowseAfterNavigation();
      }
      this.assertCurrent(opId);
      await this.dismissBlockingOverlays();
      await this.assertUsablePage();
      await this.guard.recordSuccess();
    } catch (error) {
      if (error instanceof XListSupersededError) throw error;
      if (!(error instanceof XListNeedsUserError) && !(error instanceof XListDataError)) await this.guard.recordFailure();
      throw error;
    } finally {
      void ensureQuietXBrowserWindow(this.poolKey).catch(() => {});
    }
  }

  private async waitUntilSuperseded(opId: number): Promise<never> {
    for (;;) {
      if (opId !== this.currentOp) throw new XListSupersededError();
      await sleep(120);
    }
  }

  async findFirstVisible(selectors: readonly string[]): Promise<Locator> {
    for (const selector of selectors) {
      const candidates = this.page.locator(selector);
      const count = await candidates.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false) && await candidate.boundingBox()) return candidate;
      }
    }
    throw new XListNeedsUserError('X 当前页面未出现可安全操作的 List 控件；请接管浏览器后重试。');
  }

  async click(locator: Locator, options: { force?: boolean; preserveOverlay?: boolean } = {}): Promise<void> {
    try {
      // Modal/member workflows need many clicks; full/night penalties make a single add exceed timeouts.
      await this.guard.wait(options.preserveOverlay ? 'browse' : 'browse');
      // Never Escape away a useful List sheet just before clicking inside it.
      if (!options.preserveOverlay) await this.dismissBlockingOverlays();
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const box = await locator.boundingBox();
      if (!box) throw new XListNeedsUserError('X List 控件不可见，无法安全点击。');
      if (options.force) {
        await locator.click({ force: true, timeout: 8_000 });
      } else {
        const targetX = box.x + box.width * randomFloat(0.35, 0.65);
        const targetY = box.y + box.height * randomFloat(0.35, 0.65);
        const startX = Math.max(8, targetX - randomInt(100, 220));
        const startY = Math.max(8, targetY + randomInt(-120, 120));
        try {
          await humanPointerClick(this.page, { x: startX, y: startY }, { x: targetX, y: targetY });
        } catch {
          // Modal masks and layered sheets frequently intercept pointer paths on X.
          if (!options.preserveOverlay) await this.dismissBlockingOverlays();
          await locator.click({ force: true, timeout: 8_000 });
        }
      }
      await this.settle('browse');
      await this.guard.recordSuccess();
    } catch (error) {
      if (!(error instanceof XListNeedsUserError) && !(error instanceof XListDataError)) await this.guard.recordFailure();
      throw error;
    } finally {
      await this.restoreUserForeground();
    }
  }

  async typeInto(locator: Locator, value: string): Promise<void> {
    try {
      // Typing into members/search sheets must not Escape the sheet first.
      await this.click(locator, { force: true, preserveOverlay: true });
      await this.page.keyboard.press('Control+A');
      await typeHumanly(this.page, value);
      await this.settle('full');
    } finally {
      await this.restoreUserForeground();
    }
  }

  async dismissBlockingOverlays(): Promise<void> {
    // If a useful List dialog/sheet is open, Escape would destroy the workflow.
    const usefulOpen = await this.page.locator('[role="dialog"], [aria-modal="true"]').evaluateAll((nodes) => {
      return nodes.some((node) => {
        const el = node as HTMLElement;
        if (!(el.offsetWidth || el.offsetHeight)) return false;
        const text = (el.innerText || '').slice(0, 500);
        return /管理成员|编辑列表|已推荐|列表成员|Manage members|Edit List|Suggested|Members|搜索用户|Search people/.test(text);
      });
    }).catch(() => false);

    if (!usefulOpen) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const blocked = await this.page.locator('[data-testid="mask"]').first().isVisible().catch(() => false);
        if (!blocked) break;
        await this.page.keyboard.press('Escape').catch(() => {});
        await sleep(250);
      }
    }

    // Drop inert masks that still swallow pointer events. Keep masks tied to open sheets.
    await this.page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-testid="mask"]'))) {
        const parent = el.parentElement;
        const useful = parent?.querySelector?.(
          '[data-testid="UserCell"], input[data-testid="SearchBox_Search_Input"], input[placeholder*="搜索用户"], input[placeholder*="Search"], [role="dialog"], [aria-modal="true"]'
        );
        if (useful) continue;
        // If any visible dialog exists, keep masks; they often belong to the sheet stack.
        const dialogOpen = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
          .some((node) => {
            const item = node as HTMLElement;
            return !!(item.offsetWidth || item.offsetHeight);
          });
        if (dialogOpen) continue;
        el.remove();
      }
    }).catch(() => {});
  }

  async visibleText(): Promise<string> {
    return this.page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  }

  private async assertUsablePage(): Promise<void> {
    const text = (await this.visibleText()).toLowerCase();
    const hasAccount = await this.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count() > 0;
    if (!hasAccount && (/(log in|sign up)/.test(text) || /(?:^|\n)\s*(?:登录|注册)\s*(?:\n|$)/.test(text))) {
      throw new XListNeedsUserError('专用 X 浏览器需要登录后才能管理 List。请用“前台接管”打开浏览器完成登录。');
    }
    if (/(captcha|验证你是真人|challenge|unusual activity|异常活动)/.test(text)) {
      throw new XListNeedsUserError('X 需要人工处理验证码或安全挑战。请用“前台接管”打开专用浏览器。');
    }
    if (/(rate limit|try again later|请求过于频繁|请稍后再试)/.test(text)) {
      await this.guard.recordFailure(true);
      throw new XListDataError('X 返回频率限制页面，已进入冷却。');
    }
  }

  private async humanBrowseAfterNavigation(): Promise<void> {
    const plan = chooseReadPlan();
    await sleep(plan.initialPauseMs);
    for (let index = 0; index < plan.scrolls; index += 1) {
      await this.page.mouse.wheel(0, plan.distances[index]!);
      await sleep(plan.pauses[index]!);
    }
    if (plan.scrolls > 0) {
      await this.page.mouse.wheel(0, -randomInt(80, 220));
      await sleep(randomInt(250, 700));
    }
    await this.settle('full');
  }

  private async settle(mode: NavMode): Promise<void> {
    if (mode === 'fast') {
      await sleep(randomInt(X_HUMANIZATION.detailSettleMinMs, X_HUMANIZATION.detailSettleMaxMs));
      return;
    }
    if (mode === 'browse') {
      await sleep(randomInt(X_HUMANIZATION.browseSettleMinMs, X_HUMANIZATION.browseSettleMaxMs));
      return;
    }
    this.actionCount += 1;
    const longPause = this.actionCount >= this.nextLongPause;
    if (longPause) {
      this.actionCount = 0;
      this.nextLongPause = chooseLongPauseEvery();
    }
    await sleep(chooseSettleDelayMs(longPause));
  }
}

async function applyHumanViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: X_BROWSER_VIEWPORT.width, height: X_BROWSER_VIEWPORT.height }).catch(() => {});
}

async function captureForegroundWindowHwnd(): Promise<string | null> {
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

async function restoreForegroundWindowHwnd(hwnd: string | null): Promise<void> {
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

class SharedXRequestGuard {
  private readonly stateDir = path.join(homedir(), '.pyaireader', 'guards');
  private readonly statePath = path.join(this.stateDir, 'x-request-guard.json');
  private readonly lockPath = path.join(this.stateDir, 'x-request-guard.lock');

  async wait(mode: NavMode = 'full'): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await withDirectoryLock(this.lockPath, 60_000, async () => {
      const state = await this.readState();
      const now = Date.now();
      if (state.cooldownUntil > now) throw new XListCooldownError(`X 正在冷却，${Math.ceil((state.cooldownUntil - now) / 1_000)} 秒后再试。`);
      const recentHour = state.requests.filter((item) => item > now - 3_600_000);
      if (recentHour.length >= X_HUMANIZATION.hourlyActionBudget) {
        throw new XListCooldownError(`X 一小时自动化预算已用尽，${Math.ceil((recentHour[0]! + 3_600_000 - now) / 1_000)} 秒后再试。`);
      }
      const recentDay = state.requests.filter((item) => item > now - 86_400_000);
      if (recentDay.length >= X_HUMANIZATION.dailyActionBudget) {
        throw new XListDataError('X 今日自动化预算已用尽，请明天再试或改用缓存。');
      }
      const delay = nextActionDelayMs(now, state.lastRequestAt, { mode });
      if (delay) await sleep(delay);
      const requestAt = Date.now();
      await this.writeState({
        ...state,
        lastRequestAt: requestAt,
        requests: [...recentDay, requestAt]
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

  private async readState(): Promise<{ lastRequestAt: number; requests: number[]; cooldownUntil: number; consecutiveFailures: number }> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as {
        last_request_at?: number;
        requests?: number[];
        cooldown_until?: number;
        consecutive_failures?: number;
      };
      return {
        lastRequestAt: Number(parsed.last_request_at ?? 0) * 1_000,
        requests: Array.isArray(parsed.requests) ? parsed.requests.filter(Number.isFinite).map((item) => item * 1_000) : [],
        cooldownUntil: Number(parsed.cooldown_until ?? 0) * 1_000,
        consecutiveFailures: Number(parsed.consecutive_failures ?? 0)
      };
    } catch {
      return { lastRequestAt: 0, requests: [], cooldownUntil: 0, consecutiveFailures: 0 };
    }
  }

  private async writeState(state: { lastRequestAt: number; requests: number[]; cooldownUntil: number; consecutiveFailures: number }): Promise<void> {
    await writeFile(`${this.statePath}.tmp`, JSON.stringify({
      last_request_at: state.lastRequestAt / 1_000,
      requests: state.requests.map((item) => item / 1_000),
      cooldown_until: state.cooldownUntil / 1_000,
      consecutive_failures: state.consecutiveFailures
    }) + '\n', 'utf8');
    await rename(`${this.statePath}.tmp`, this.statePath);
  }
}

class XInteractionLease {
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

async function humanPointerClick(page: Page, start: { x: number; y: number }, target: { x: number; y: number }): Promise<void> {
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

async function typeHumanly(page: Page, value: string): Promise<void> {
  for (const character of value) {
    await page.keyboard.type(character);
    await sleep(randomInt(X_HUMANIZATION.typeDelayMinMs, X_HUMANIZATION.typeDelayMaxMs));
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
