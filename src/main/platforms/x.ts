import type { BrowserContext, Locator, Page } from 'playwright-core';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assertNoInternalMediaToken } from '../platform-body-compile.ts';
import { parseMetricValue } from './metric-value.ts';

export type XIdentity = { platform: 'x'; accountKey: string; displayName: string; loginState: 'authenticated'; evidenceUrl: string };
export type MetricField = { status: 'value' | 'unavailable' | 'parse_failed'; value?: number; rawLabel?: string };

export async function identifyXAccount(cdpUrl: string): Promise<XIdentity> {
  const browser = await connectXBrowser(cdpUrl);
  try {
    const page = await xPage(browser.contexts()[0]);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    const switcher = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
    await switcher.waitFor({ state: 'visible', timeout: 15_000 });
    const text = await switcher.innerText();
    const avatarTestId = await switcher.locator('[data-testid^="UserAvatar-Container-"]').getAttribute('data-testid');
    const handle = text.match(/@[A-Za-z0-9_]+/)?.[0] ?? (avatarTestId ? `@${avatarTestId.replace('UserAvatar-Container-', '')}` : undefined);
    if (!handle) throw new Error('无法从 X 账号区域读取 handle。');
    return { platform: 'x', accountKey: handle, displayName: text.split('\n').find((line) => line && !line.startsWith('@')) ?? handle, loginState: 'authenticated', evidenceUrl: page.url() };
  } finally { await browser.close(); }
}

export async function prepareXText(cdpUrl: string, body: string): Promise<{ title: null; body: string; assetIds: []; evidenceUrl: string }> {
  // 只消费已编译正文：发现内部 token 即拒绝。
  assertNoInternalMediaToken(body);
  const browser = await connectXBrowser(cdpUrl);
  try {
    const page = await xPage(browser.contexts()[0]);
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    const editor = await activeEditor(page);
    await editor.waitFor({ state: 'visible', timeout: 15_000 });
    await editor.fill(body);
    const readback = await editor.innerText();
    if (readback.trim() !== body.trim()) throw new Error('X 编辑器正文回读与平台版本不一致。');
    return { title: null, body: readback, assetIds: [], evidenceUrl: page.url() };
  } finally { await browser.close(); }
}

export async function prepareXImage(cdpUrl: string, body: string, assetPath: string, assetId: string): Promise<{ title: null; body: string; assetIds: [string]; evidenceUrl: string }> {
  return prepareXMedia(cdpUrl, body, assetPath, assetId, false);
}

export async function prepareXVideo(cdpUrl: string, body: string, assetPath: string, assetId: string): Promise<{ title: null; body: string; assetIds: [string]; evidenceUrl: string }> {
  return prepareXMedia(cdpUrl, body, assetPath, assetId, true);
}

async function prepareXMedia(cdpUrl: string, body: string, assetPath: string, assetId: string, waitsForProcessing: boolean): Promise<{ title: null; body: string; assetIds: [string]; evidenceUrl: string }> {
  // 只消费已编译正文：发现内部 token 即拒绝。
  assertNoInternalMediaToken(body);
  const browser = await connectXBrowser(cdpUrl);
  try {
    const page = await xPage(browser.contexts()[0]);
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    const editor = await activeEditor(page);
    await editor.fill(body);
    await page.locator('input[data-testid="fileInput"]').first().setInputFiles(assetPath);
    await page.locator('[data-testid="attachments"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    if (waitsForProcessing) await page.locator('[data-testid="tweetButton"]').waitFor({ state: 'visible', timeout: 30_000 });
    if (waitsForProcessing) await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-testid="tweetButton"]')?.disabled === false, undefined, { timeout: 30_000 });
    const readback = await editor.innerText();
    if (readback.trim() !== body.trim()) throw new Error('X 编辑器正文回读与平台版本不一致。');
    return { title: null, body: readback, assetIds: [assetId], evidenceUrl: page.url() };
  } finally { await browser.close(); }
}

export async function collectXMetrics(cdpUrl: string, statusUrl: string): Promise<{
  sourceUrl: string; capturedAt: string; normalized: Record<'views' | 'likes' | 'replies' | 'reposts', MetricField>; raw: Record<string, MetricField>;
}> {
  const browser = await connectXBrowser(cdpUrl);
  try {
    const page = await xPage(browser.contexts()[0]);
    await page.goto(statusUrl, { waitUntil: 'domcontentloaded' });
    const article = page.locator('article').first();
    await article.waitFor({ state: 'visible', timeout: 15_000 });
    const field = async (selector: string, attribute = 'aria-label'): Promise<MetricField> => {
      const locator = article.locator(selector).first();
      const rawLabel = await locator.getAttribute(attribute) ?? await locator.innerText().catch(() => '');
      if (!rawLabel) return { status: 'unavailable' };
      const value = parseMetricValue(rawLabel);
      return value === null ? { status: 'parse_failed', rawLabel } : { status: 'value', value, rawLabel };
    };
    return {
      sourceUrl: page.url(),
      capturedAt: new Date().toISOString(),
      normalized: {
        views: await field('a[href*="/analytics"]', 'textContent'),
        likes: await field('[data-testid="like"]'),
        replies: await field('[data-testid="reply"]'),
        reposts: await field('[data-testid="retweet"]')
      },
      raw: { bookmarks: await field('[data-testid="bookmark"]') }
    };
  } finally { await browser.close(); }
}

export async function collectXAccountMetrics(cdpUrl: string, accountKey: string): Promise<{
  sourceUrl: string;
  capturedAt: string;
  normalized: Record<'followers', MetricField>;
  raw: Record<string, MetricField>;
}> {
  const handle = accountKey.startsWith('@') ? accountKey.slice(1) : accountKey;
  const browser = await connectXBrowser(cdpUrl);
  try {
    const page = await xPage(browser.contexts()[0]);
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded' });
    const profile = page.locator('[data-testid="UserName"]').first();
    await profile.waitFor({ state: 'visible', timeout: 15_000 });
    const followersLink = page.locator(`a[href$="/${handle}/verified_followers"], a[href$="/${handle}/followers"]`).first();
    const rawLabel = await followersLink.getAttribute('aria-label')
      ?? await followersLink.innerText().catch(() => '');
    let followers: MetricField = { status: 'unavailable' };
    if (rawLabel) {
      const value = parseMetricValue(rawLabel);
      followers = value === null ? { status: 'parse_failed', rawLabel } : { status: 'value', value, rawLabel };
    }
    return {
      sourceUrl: page.url(),
      capturedAt: new Date().toISOString(),
      normalized: { followers },
      raw: { followers }
    };
  } finally {
    await browser.close();
  }
}

async function xPage(context: BrowserContext) {
  const page = context.pages().find((candidate) => candidate.url().includes('x.com')) ?? await context.newPage();
  return page;
}

async function activeEditor(page: Page): Promise<Locator> {
  const editors = page.locator('[data-testid="tweetTextarea_0"]');
  await editors.first().waitFor({ state: 'visible', timeout: 15_000 });
  for (let index = 0; index < await editors.count(); index += 1) {
    const editor = editors.nth(index);
    const box = await editor.boundingBox();
    if (box && box.y >= 0) return editor;
  }
  throw new Error('X 当前页面没有可操作的发帖编辑器。');
}

export async function connectXBrowser(cdpUrl: string) {
  const load = createRequire(import.meta.url);
  const isPackaged = process.versions.electron
    ? (load('electron') as typeof import('electron')).app.isPackaged
    : false;
  const { chromium } = load(isPackaged
    ? path.join(process.resourcesPath, 'playwright-core')
    : 'playwright-core') as typeof import('playwright-core');
  return chromium.connectOverCDP(cdpUrl);
}
