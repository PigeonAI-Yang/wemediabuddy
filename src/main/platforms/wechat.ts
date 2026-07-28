import type { BrowserContext, Page } from 'playwright-core';
import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { validateWechatArticleUrl } from './wechat-url';

export type WechatIdentity = { platform: 'wechat'; accountKey: string; displayName: string; loginState: 'authenticated'; evidenceUrl: string };

export async function identifyWechatAccount(cdpUrl: string): Promise<WechatIdentity> {
  const browser = await connect(cdpUrl);
  try {
    const page = await homePage(browser.contexts()[0]);
    const name = (await page.locator('.acount_box-nickname').first().innerText()).trim();
    if (!name) throw new Error('无法读取微信公众号账号身份。');
    return { platform: 'wechat', accountKey: name, displayName: name, loginState: 'authenticated', evidenceUrl: page.url() };
  } finally { await browser.close(); }
}

export async function prepareWechatArticle(cdpUrl: string, title: string, body: string) {
  const browser = await connect(cdpUrl);
  try {
    const context = browser.contexts()[0];
    const home = await homePage(context);
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
  } finally { await browser.close(); }
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
  } finally { await browser.close(); }
}

async function homePage(context: BrowserContext): Promise<Page> {
  const page = context.pages().find((candidate) => candidate.url().includes('mp.weixin.qq.com/cgi-bin/home')) ?? await context.newPage();
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('/cgi-bin/home')) throw new Error('微信公众号平台需要登录。');
  return page;
}

async function editorBody(editor: import('playwright-core').Locator): Promise<string> {
  return editor.evaluate((element) => Array.from(element.children).map((child) => child.textContent ?? '').join('\n'));
}

async function connect(cdpUrl: string) {
  const load = createRequire(__filename);
  const { chromium } = load(app.isPackaged ? path.join(process.resourcesPath, 'playwright-core') : 'playwright-core') as typeof import('playwright-core');
  return chromium.connectOverCDP(cdpUrl);
}
