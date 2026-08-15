/**
 * WMB-5249 知乎发布适配器（首期试点：专栏文章 + 单张封面）。
 *
 * 账号识别（identifyZhihuAccount）：在专用浏览器当前页面判定知乎登录态
 * （authenticated / unauthenticated / challenge / unknown），认证态必须给出
 * 稳定 accountKey（个人主页 url_token）+ displayName + evidenceUrl。
 *
 * 编辑器准备（prepareZhihuArticle）：打开官方专栏写作页
 * （https://zhuanlan.zhihu.com/write），编辑前先判定登录/挑战状态（未登录或
 * 验证码一律以 BROWSER_NEEDS_USER 停止），填充标题、正文与最多一张 JPEG/PNG
 * 封面并逐项回读，返回 {title, body, assetIds, evidenceUrl}。绝不点击发布/提交按钮。
 * 不支持的素材合同在连接浏览器前 fail-closed，绝不静默丢图。
 *
 * 选择器风险：知乎页面结构为闭源前端，以下选择器基于 2026-08 观察与
 * MultiPost-Extension（third_party，仅作参考）的编辑器结构；线上改版时
 * identify/prepare 会以 BROWSER_NEEDS_USER / 回读不一致显式失败，不会误发布。
 */
import type { BrowserContext, Page } from 'playwright-core';
import type * as PlaywrightCore from 'playwright-core';
import type { App } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assertNoInternalMediaToken } from '../platform-body-compile.ts';

export type ZhihuIdentity = { platform: 'zhihu'; accountKey: string; displayName: string; loginState: 'authenticated'; evidenceUrl: string };
export type ZhihuLoginState = 'authenticated' | 'unauthenticated' | 'challenge' | 'unknown';

export const ZHIHU_HOME_URL = 'https://www.zhihu.com/';
export const ZHIHU_WRITE_URL = 'https://zhuanlan.zhihu.com/write';
export const ZHIHU_TITLE_PLACEHOLDER = '请输入标题（最多 100 个字）';
const ZHIHU_LOGIN_TIMEOUT_MS = 3 * 60_000;

/** 从页面可观察事实判定知乎登录态（纯函数，可独立测试）。 */
export type ZhihuLoginFacts = {
  url: string;
  /** 顶栏是否可见「登录」入口（未登录态标志）。 */
  hasLoginEntry: boolean;
  /** 顶栏是否可见用户头像（已登录态标志）。 */
  hasUserAvatar: boolean;
  /** 页面是否出现验证码/安全验证元素。 */
  hasCaptcha: boolean;
};

export function isZhihuSigninUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'www.zhihu.com' && url.includes('/signin');
  } catch {
    return false;
  }
}

export function classifyZhihuLoginState(facts: ZhihuLoginFacts): ZhihuLoginState {
  if (facts.hasCaptcha) return 'challenge';
  if (facts.hasUserAvatar) return 'authenticated';
  if (facts.hasLoginEntry || isZhihuSigninUrl(facts.url)) return 'unauthenticated';
  return 'unknown';
}

/** 测试接缝：与 onboarding.ts 的 fetchImpl 同一模式，缺省走真实 CDP connect。 */
export type ZhihuAdapterDeps = Readonly<{
  connect?: (cdpUrl: string) => Promise<PlaywrightCore.Browser>;
}>;

export async function identifyZhihuAccount(cdpUrl: string, options: { loginTimeoutMs?: number } = {}, deps: ZhihuAdapterDeps = {}): Promise<ZhihuIdentity> {
  const browser = await (deps.connect ?? connect)(cdpUrl);
  try {
    const page = await ensureZhihuHome(browser.contexts()[0], options.loginTimeoutMs ?? ZHIHU_LOGIN_TIMEOUT_MS);
    const state = await readZhihuLoginState(page);
    if (state !== 'authenticated') {
      throw needsLogin(state === 'challenge'
        ? '知乎页面要求安全验证。请在打开的浏览器里完成验证后重试；超时请再点一次验证。'
        : '知乎尚未登录。请在打开的浏览器里登录知乎后重试；超时请再点一次验证。');
    }
    const identity = await readZhihuIdentity(page);
    return { platform: 'zhihu', ...identity, loginState: 'authenticated', evidenceUrl: page.url() };
  } finally {
    // CDP connect：close 只断开 Playwright，保留受管浏览器供登录/重试。
    await browser.close().catch(() => {});
  }
}

export type ZhihuPreparedArticle = { title: string; body: string; assetIds: string[]; evidenceUrl: string };
export type ZhihuAssetRef = Readonly<{ assetId: string; assetPath: string; mimeType: string }>;

function zhihuPlainTextHtml(value: string): string {
  const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
  return value.replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.length > 0 ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>')
    .join('');
}

export async function prepareZhihuArticle(
  cdpUrl: string,
  title: string,
  body: string,
  assets: readonly ZhihuAssetRef[] = [],
  deps: ZhihuAdapterDeps = {}
): Promise<ZhihuPreparedArticle> {
  if (assets.length > 1 || assets.some((asset) => !['image/jpeg', 'image/png'].includes(asset.mimeType) || !asset.assetPath)) {
    throw Object.assign(new Error('知乎首期试点仅支持一张 JPEG/PNG 封面：请调整平台版本素材后重试。'), {
      code: 'ZHIHU_COVER_UNSUPPORTED'
    });
  }
  // 只消费已编译正文：发现内部 token 即拒绝（绝不发布字面 token）。
  assertNoInternalMediaToken(body);
  const browser = await (deps.connect ?? connect)(cdpUrl);
  try {
    const page = await openZhihuWrite(browser.contexts()[0], 15_000);
    // 编辑前先判定登录/挑战：未登录或验证码一律停止，不触碰编辑器。
    const state = await readZhihuLoginState(page);
    if (state !== 'authenticated') {
      throw needsLogin(state === 'challenge'
        ? '知乎页面要求安全验证。请先在打开的浏览器里完成验证，再重新授权编辑。'
        : '知乎尚未登录。请先在打开的浏览器里登录知乎，再重新授权编辑。');
    }
    const titleEditor = page.locator(`textarea[placeholder="${ZHIHU_TITLE_PLACEHOLDER}"]`);
    await titleEditor.waitFor({ state: 'visible', timeout: 15_000 });
    const editor = page.locator('[contenteditable="true"]:has(div[data-contents="true"]), [contenteditable="true"][role="textbox"]').first();
    await editor.waitFor({ state: 'visible', timeout: 15_000 });
    // 等待知乎 React/Draft.js hydration 完成，避免受控状态在写入后覆盖内容。
    await page.waitForTimeout(750);
    // 知乎正文使用 Draft.js。Playwright `fill()` 会直接改 contenteditable DOM，
    // 在线上编辑器中会丢失中文段首并压平段落；走 Draft.js 原生 paste 事件。
    const pastePayload = { text: body, html: zhihuPlainTextHtml(body) };
    await editor.evaluate((root, value) => {
      const target = (root.querySelector<HTMLElement>('div[data-contents="true"]') ?? root) as HTMLElement;
      target.focus();
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', value.text);
      clipboard.setData('text/html', value.html);
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }, pastePayload);
    // Draft.js 正文和标题分两次串行落草稿；并发触发会让后一次保存覆盖前一次字段。
    await page.waitForTimeout(5_000);
    await titleEditor.fill(title);
    // 上游参考同样等待 5 秒；返回前让标题保存完成并保持正文不被覆盖。
    await page.waitForTimeout(5_000);
    const cover = assets[0];
    if (cover) {
      const coverInput = page.locator('input[type="file"].UploadPicture-input').first();
      await coverInput.waitFor({ state: 'attached', timeout: 15_000 });
      await coverInput.setInputFiles(cover.assetPath);
      const coverImage = page.locator('img[alt="封面图"]').first();
      await coverImage.waitFor({ state: 'visible', timeout: 30_000 });
      const coverUrl = await coverImage.getAttribute('src');
      if (!coverUrl) throw new Error('知乎封面上传后未能回读图片，已停止准备（未点击发布）。请重试或改为人工发布。');
      // 封面上传与文章正文/标题分别持久化；返回前等待封面草稿保存完成。
      await page.waitForTimeout(5_000);
    }
    const readTitle = (await titleEditor.inputValue()).trim();
    const readBody = (await editor.evaluate((root) => {
      const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-block="true"]'));
      return blocks.length > 0 ? blocks.map((block) => block.textContent ?? '').join('\n') : (root.textContent ?? '');
    })).trim();
    if (readTitle !== title.trim() || readBody !== body.trim()) {
      throw new Error('知乎编辑器回读与平台版本不一致，已停止准备（未点击发布）。请重试或改为人工发布。');
    }
    return { title: readTitle, body: readBody, assetIds: assets.map((asset) => asset.assetId), evidenceUrl: page.url() };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function ensureZhihuHome(context: BrowserContext, loginTimeoutMs: number): Promise<Page> {
  const page = context.pages().find((candidate) => candidate.url().includes('zhihu.com')) ?? await context.newPage();
  await page.goto(ZHIHU_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.locator('.AppHeader-profileEntry, .AppHeader-login, #captchaContainer').first().waitFor({ state: 'visible', timeout: loginTimeoutMs });
    return page;
  } catch {
    throw needsLogin('知乎首页没有出现可识别的登录状态。请在打开的浏览器里登录知乎后重试。');
  }
}

async function openZhihuWrite(context: BrowserContext, loginTimeoutMs: number): Promise<Page> {
  // 每次准备都开新页：不得复用/覆盖 Owner 已打开的知乎草稿。
  const page = await context.newPage();
  await page.goto(ZHIHU_WRITE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!isZhihuSigninUrl(page.url()) && !page.url().includes('zhuanlan.zhihu.com/write')) {
    // 登录页之外的落地页（如安全验证）也交给 readZhihuLoginState 判定。
    return page;
  }
  try {
    await page.waitForURL((target) => {
      const url = target.toString();
      return url.includes('zhuanlan.zhihu.com/write') && !isZhihuSigninUrl(url);
    }, { timeout: loginTimeoutMs });
    await page.waitForLoadState('domcontentloaded');
    return page;
  } catch {
    throw needsLogin('知乎写作页尚未就绪：需要登录或安全验证。请在打开的浏览器里完成后重试；超时请再点一次验证。');
  }
}

async function readZhihuLoginState(page: Page): Promise<ZhihuLoginState> {
  const facts = await page.evaluate(() => {
    const url = window.location.href;
    const hasLoginEntry = Boolean(document.querySelector('.AppHeader-login, a[href*="/signin"]'));
    const hasUserAvatar = Boolean(document.querySelector('.AppHeader-profileEntry .Avatar, .AppHeader-profileAvatar.Avatar'));
    const hasCaptcha = Boolean(document.querySelector('#captchaContainer, [class*="captcha"], [class*="Captcha"], [class*="verify"]'))
      || /captcha|security-verification/i.test(url);
    return { url, hasLoginEntry, hasUserAvatar, hasCaptcha };
  });
  return classifyZhihuLoginState(facts);
}

async function readZhihuIdentity(page: Page): Promise<{ accountKey: string; displayName: string }> {
  const profileEntry = page.locator('.AppHeader-profileEntry').first();
  const avatar = profileEntry.locator('img.Avatar[alt]').first();
  const rawAlt = ((await avatar.getAttribute('alt').catch(() => null)) ?? '').trim();
  const displayName = rawAlt.match(/^点击打开(.+)的主页$/)?.[1]?.trim() || rawAlt;
  const profileLink = page.locator('a.AppHeader-profileAvatar[href*="/people/"]').first();
  let profileHref = ((await profileLink.getAttribute('href').catch(() => null)) ?? '').trim();
  if (!profileHref) {
    await profileEntry.click();
    await profileLink.waitFor({ state: 'visible', timeout: 5_000 });
    profileHref = ((await profileLink.getAttribute('href').catch(() => null)) ?? '').trim();
  }
  const urlToken = profileHref.match(/\/people\/([^/?#]+)/)?.[1] ?? '';
  const accountKey = urlToken || displayName;
  if (!accountKey) throw needsLogin('无法读取知乎账号身份。请确认已在专用浏览器中登录知乎。');
  return { accountKey, displayName: displayName || accountKey };
}

function needsLogin(message: string): Error {
  return Object.assign(new Error(message), { code: 'BROWSER_NEEDS_USER' });
}

async function connect(cdpUrl: string) {
  const load = createRequire(__filename);
  // 打包判断与 x/wechat 适配器同一模式：运行时加载 electron 模块读取 isPackaged。
  const electronModule = load('electron') as { app: App };
  const isPackaged = process.versions.electron ? electronModule.app.isPackaged : false;
  const { chromium } = load(isPackaged
    ? path.join(process.resourcesPath, 'playwright-core')
    : 'playwright-core') as typeof PlaywrightCore;
  return chromium.connectOverCDP(cdpUrl);
}
