import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { connectXBrowser } from './x.ts';
import {
  X_BROWSER_VIEWPORT,
  X_HUMANIZATION,
  chooseLongPauseEvery,
  chooseReadPlan,
  chooseSettleDelayMs,
  randomFloat,
  randomInt
} from './x-humanization.ts';
import { isPyaireaderXProfile, isXHomeUrl, type XListBrowserConfig } from './x-list-primitives.ts';
import { ensureQuietXBrowserWindow } from '../browser.ts';
import {
  SharedXRequestGuard,
  XInteractionLease,
  XListCooldownError,
  XListDataError,
  XListNeedsUserError,
  XListSupersededError,
  applyHumanViewport,
  captureForegroundWindowHwnd,
  humanPointerClick,
  hasUsableDocumentText,
  restoreForegroundWindowHwnd,
  sleep,
  typeHumanly,
  type NavMode
} from './x-list-session-support.ts';
export { XListCooldownError, XListDataError, XListNeedsUserError, XListPlatformRejectedError, XListSupersededError } from './x-list-session-support.ts';

const SESSION_IDLE_MS = 3 * 60_000;


type PooledSession = {
  session: XListSession;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const sessionPool = new Map<string, PooledSession>();

export async function disposeXListSessions(): Promise<void> { await Promise.allSettled(
  [...new Set([...sessionPool.values()].map((entry) => entry.session))].map((session) => session.dispose())
); }

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

  /** Cancel the current op only for its own timeout/disposal path. */
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
    const opId = ++this.opSerial;
    const timeoutMs = Math.max(3_000, options.timeoutMs ?? 20_000);
    const execute = async () => {
      // One shared X page is a serial executor. A later read must never cancel a user-confirmed write.
      this.currentOp = opId;
      void this.page.evaluate(() => {
        try { window.stop(); } catch {}
      }).catch(() => {});
      this.assertCurrent(opId);
      this.previousForegroundHwnd = await captureForegroundWindowHwnd();
      this.assertCurrent(opId);
      const lease = await XInteractionLease.acquire();
      try {
        this.assertCurrent(opId);
        await ensureQuietXBrowserWindow(this.poolKey).catch(() => {});
        this.assertCurrent(opId);
        let timedOut = false, timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        const timeoutError = new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true; if (this.currentOp === opId) this.preempt();
            reject(new Error(`X 操作超时（${Math.round(timeoutMs / 1000)}s）。请重试。`));
          }, timeoutMs);
        });
        try {
          return await Promise.race([action(this), timeoutError]);
        } finally {
          clearTimeout(timeoutTimer ?? undefined);
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
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  static async open(config: XListBrowserConfig): Promise<XListSession> {
    if (!isPyaireaderXProfile(config) || !config.cdpUrl) {
      throw new XListNeedsUserError('X List 只能使用当前工作空间已选择的专用 X 登录态。');
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
    if (!process.versions.electron) return await this.dispose();
    clearTimeout(pooled.idleTimer ?? undefined);
    pooled.idleTimer = setTimeout(() => void this.dispose(), SESSION_IDLE_MS);
    pooled.idleTimer.unref();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pooled = sessionPool.get(this.poolKey);
    clearTimeout(pooled?.idleTimer ?? undefined);
    sessionPool.delete(this.poolKey);
    try {
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
      if (
        current === target
        && (mode === 'fast' || mode === 'browse')
        && hasUsableDocumentText(await this.visibleText())
      ) {
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
      if (!(error instanceof XListNeedsUserError) && !(error instanceof XListCooldownError)) await this.guard.recordFailure();
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
      if (options.force) {
        try {
          await locator.click({ force: true, timeout: 8_000 });
        } catch (error) {
          if (!/element is not visible/i.test(error instanceof Error ? error.message : String(error))) throw error;
          await locator.evaluate((element) => (element as HTMLElement).click());
        }
      } else {
        const box = await locator.boundingBox();
        if (!box) throw new XListNeedsUserError('X List 控件不可见，无法安全点击。');
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
      if (!(error instanceof XListNeedsUserError) && !(error instanceof XListCooldownError)) await this.guard.recordFailure();
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
