import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const LIST_ID = '2082851520417255750';
const HANDLE = 'AnthropicAI';
const OUT = path.resolve('.ai/probe-ai-frontier-members-ui.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  if (!browserCfg) throw new Error('no browser config');
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const browser = await chromium.connectOverCDP(runtime.cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages().find((p) => !p.url().startsWith('devtools://')) || await context.newPage();

  const steps = [];
  async function snap(label, url) {
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
    }
    const data = await page.evaluate(() => {
      const textOf = (el) => (el?.innerText || el?.textContent || '').trim().slice(0, 240);
      const inputs = [...document.querySelectorAll('input')].slice(0, 40).map((el) => ({
        type: el.getAttribute('type'),
        testid: el.getAttribute('data-testid'),
        placeholder: el.getAttribute('placeholder'),
        aria: el.getAttribute('aria-label'),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      }));
      const buttons = [...document.querySelectorAll('button,[role="button"]')].slice(0, 80).map((el) => ({
        text: textOf(el).slice(0, 80),
        testid: el.getAttribute('data-testid'),
        aria: el.getAttribute('aria-label'),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      })).filter((b) => b.visible && (b.text || b.aria || b.testid));
      const links = [...document.querySelectorAll('a[href]')].slice(0, 120).map((el) => ({
        href: el.getAttribute('href'),
        text: textOf(el).slice(0, 80),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      })).filter((l) => l.visible && /list|member|info|suggested|编辑|管理|成员|Add|Remove|添加|移除/i.test(`${l.href} ${l.text}`));
      const cells = [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 20).map((el) => textOf(el).slice(0, 160));
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((el) => ({
        text: textOf(el).slice(0, 300),
        inputs: [...el.querySelectorAll('input')].map((i) => ({
          testid: i.getAttribute('data-testid'),
          placeholder: i.getAttribute('placeholder'),
          aria: i.getAttribute('aria-label')
        })),
        buttons: [...el.querySelectorAll('button')].map((b) => textOf(b).slice(0, 60)).filter(Boolean).slice(0, 20)
      }));
      const h1 = textOf(document.querySelector('h1,h2,[data-testid="primaryColumn"] h2'));
      return {
        url: location.href,
        title: document.title,
        h1,
        bodySample: textOf(document.body).slice(0, 500),
        inputs,
        buttons: buttons.slice(0, 40),
        links: links.slice(0, 40),
        userCells: cells,
        dialogs
      };
    });
    steps.push({ label, ...data });
    console.log(label, data.url, 'cells=', data.userCells.length, 'dialogs=', data.dialogs.length, 'inputs=', data.inputs.filter((i) => i.visible).length);
  }

  await snap('home', 'https://x.com/home');
  await snap('list_home', `https://x.com/i/lists/${LIST_ID}`);
  await snap('list_members', `https://x.com/i/lists/${LIST_ID}/members`);
  await snap('list_suggested', `https://x.com/i/lists/${LIST_ID}/members/suggested`);
  await snap('list_info', `https://x.com/i/lists/${LIST_ID}/info`);

  // Try UI path: list -> more/edit -> manage members
  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const clickTexts = ['编辑列表', 'Edit List', '管理成员', 'Manage members', '成员', 'Members'];
  for (const text of clickTexts) {
    const loc = page.locator(`a:has-text("${text}"), button:has-text("${text}"), [role="link"]:has-text("${text}"), [role="button"]:has-text("${text}")`).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await snap(`after_click_${text}`);
    }
  }

  // Try suggested page search for AnthropicAI
  await page.goto(`https://x.com/i/lists/${LIST_ID}/members/suggested`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const search = page.locator('input[data-testid="SearchBox_Search_Input"], input[placeholder*="Search"], input[placeholder*="搜索"], input[type="text"]').first();
  const searchVisible = await search.isVisible().catch(() => false);
  steps.push({ label: 'search_visibility', searchVisible, url: page.url() });
  if (searchVisible) {
    await search.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(HANDLE, { delay: 40 });
    await page.waitForTimeout(2500);
    await snap('after_search_type');
    const addBtn = page.locator('button:has-text("添加"), button:has-text("Add"), button[aria-label*="Add"], button[aria-label*="添加"]').first();
    steps.push({
      label: 'add_button',
      visible: await addBtn.isVisible().catch(() => false),
      text: await addBtn.innerText().catch(() => null),
      aria: await addBtn.getAttribute('aria-label').catch(() => null)
    });
  }

  await writeFile(OUT, JSON.stringify({ ok: true, steps }, null, 2), 'utf8');
  console.log('wrote', OUT);
} catch (error) {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
