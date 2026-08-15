import type { BrowserContext, Locator, Page } from 'playwright-core';
import type * as PlaywrightCore from 'playwright-core';
import type { App } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assertInlineAssetImageDeliverable, assertNoInternalMediaToken } from '../platform-body-compile.ts';
import { validateWechatArticleUrl } from './wechat-url.ts';

export type WechatIdentity = { platform: 'wechat'; accountKey: string; displayName: string; loginState: 'authenticated'; evidenceUrl: string };

const WECHAT_LOGIN_TIMEOUT_MS = 3 * 60_000;

export async function identifyWechatAccount(cdpUrl: string, options: { loginTimeoutMs?: number } = {}): Promise<WechatIdentity> {
  const browser = await connect(cdpUrl);
  try {
    const page = await ensureWechatHome(browser.contexts()[0], options.loginTimeoutMs ?? WECHAT_LOGIN_TIMEOUT_MS);
    const name = (await page.locator('.acount_box-nickname, .weui-desktop-account__info').first().innerText({ timeout: 15_000 })).trim();
    const displayName = name.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    if (!displayName) throw needsLogin('无法读取微信公众号账号身份。');
    return { platform: 'wechat', accountKey: displayName, displayName, loginState: 'authenticated', evidenceUrl: page.url() };
  } finally {
    // CDP connect: close disconnects Playwright only; keep the managed browser for login/retry.
    await browser.close().catch(() => {});
  }
}

export async function prepareWechatArticle(cdpUrl: string, title: string, body: string) {
  // 只消费已编译正文：内部 markdown token 一律拒绝；正文含真实图片表示但当前适配器
  // 仅支持纯文本编辑器时，发布前 fail-closed（绝不发布字面 token，也绝不静默删图）。
  assertNoInternalMediaToken(body);
  assertInlineAssetImageDeliverable(body);
  const browser = await connect(cdpUrl);
  try {
    const context = browser.contexts()[0];
    const home = await ensureWechatHome(context, 15_000);
    const editorPromise = context.waitForEvent('page');
    await home.locator('.new-creation__menu-item').filter({ hasText: '文章' }).first().click();
    const editor = await editorPromise;
    await editor.waitForLoadState('domcontentloaded');
    const titleEditor = editor.locator('.ProseMirror[data-placeholder="请在这里输入标题"]');
    const bodyEditor = editor.locator('.ProseMirror:not([data-placeholder])').last();
    await titleEditor.fill(title);
    await bodyEditor.fill(body);
    const readTitle = (await titleEditor.innerText()).trim();
    const readBody = (await editorBody(bodyEditor)).trim();
    if (readTitle !== title.trim() || readBody !== body.trim()) throw new Error('微信公众号编辑器回读与平台版本不一致。');
    return { title: readTitle, body: readBody, assetIds: [], evidenceUrl: editor.url() };
  } finally { await browser.close().catch(() => {}); }
}

export async function readBackWechatArticle(cdpUrl: string, articleUrl: string, expectedTitle: string) {
  const url = validateWechatArticleUrl(articleUrl);
  const browser = await connect(cdpUrl);
  try {
    const page = await browser.contexts()[0].newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    const title = (await page.locator('#activity-name').innerText()).trim();
    if (title !== expectedTitle.trim()) throw new Error('文章链接标题与当前平台版本不一致。');
    const canonicalUrl = await page.locator('meta[property="og:url"]').getAttribute('content') || page.url();
    return { title, externalUrl: canonicalUrl, externalId: new URL(canonicalUrl).pathname + new URL(canonicalUrl).search };
  } finally { await browser.close().catch(() => {}); }
}

async function ensureWechatHome(context: BrowserContext, loginTimeoutMs: number): Promise<Page> {
  const page = context.pages().find((candidate) => candidate.url().includes('mp.weixin.qq.com')) ?? await context.newPage();
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (isWechatHome(page.url())) return page;
  try {
    await page.waitForURL((target) => isWechatHome(target.toString()), { timeout: loginTimeoutMs });
    await page.waitForLoadState('domcontentloaded');
    return page;
  } catch {
    throw needsLogin('微信公众号尚未登录。请在打开的浏览器里扫码登录，登录成功后会自动完成验证；超时请再点一次验证。');
  }
}

function isWechatHome(url: string): boolean {
  return url.includes('mp.weixin.qq.com') && url.includes('/cgi-bin/home');
}

function needsLogin(message: string): Error {
  return Object.assign(new Error(message), { code: 'BROWSER_NEEDS_USER' });
}

async function editorBody(editor: Locator): Promise<string> {
  return editor.evaluate((element) => Array.from(element.children).map((child) => child.textContent ?? '').join('\n'));
}

async function connect(cdpUrl: string) {
  const load = createRequire(__filename);
  const isPackaged = process.versions.electron
    ? (load('electron') as { app: App }).app.isPackaged
    : false;
  const { chromium } = load(isPackaged
    ? path.join(process.resourcesPath, 'playwright-core')
    : 'playwright-core') as typeof PlaywrightCore;
  return chromium.connectOverCDP(cdpUrl);
}
