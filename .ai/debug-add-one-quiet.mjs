import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const LIST_ID = '2083262800521224237';
const HANDLE = (process.argv[2] || '@ArtificialAnlys');
const bare = HANDLE.replace(/^@/, '');
const OUT = path.resolve('.ai/debug-add-one-quiet.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browser = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'quiet' });
  const c = await chromium.connectOverCDP(runtime.cdpUrl);
  const page = c.contexts()[0].pages()[0] || await c.contexts()[0].newPage();

  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(120);
  }

  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2200);
  await page.locator(`a[href="/i/lists/${LIST_ID}/info"]`).first().click({ force: true });
  await sleep(1200);
  const manage = page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).locator('a:has-text("管理成员"), [role="tab"]:has-text("管理成员")').first();
  await manage.click({ force: true });
  await sleep(1200);
  const suggested = page.locator('[role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐")').first();
  if (await suggested.isVisible().catch(() => false)) await suggested.click({ force: true });
  await sleep(900);

  const dialog = page.locator('[role="dialog"]').filter({ hasText: '已推荐' }).last();
  const search = dialog.locator('input[placeholder*="搜索用户"], input[type="text"]').first();
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await search.click({ force: true });
  await search.fill('');
  await search.type(bare, { delay: 40 });
  await sleep(2200);

  const snapshot = await dialog.evaluate((root, bare) => {
    const cells = Array.from(root.querySelectorAll('[data-testid="UserCell"], [role="option"], li, div')).filter((el) => {
      const t = (el.innerText || '').replace(/\s+/g, ' ');
      return new RegExp(`@?${bare}`, 'i').test(t) && t.length < 500;
    }).slice(0, 12).map((el) => ({
      tag: el.tagName,
      testid: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      buttons: Array.from(el.querySelectorAll('button, div[role="button"], [role="button"]')).map((b) => ({
        tag: b.tagName,
        text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
        aria: b.getAttribute('aria-label'),
        disabled: b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true',
        cls: (b.className || '').toString().slice(0, 80)
      }))
    }));
    const allButtons = Array.from(root.querySelectorAll('button, div[role="button"]')).map((b) => ({
      text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
      aria: b.getAttribute('aria-label'),
      visible: !!(b.offsetWidth || b.offsetHeight)
    })).filter((b) => b.text || b.aria).slice(0, 40);
    return {
      dialogText: (root.innerText || '').slice(0, 500),
      cells,
      allButtons
    };
  }, bare);

  // Try clicking the first real Add button near matching handle
  const row = dialog.locator('[data-testid="UserCell"]').filter({ hasText: new RegExp(bare, 'i') }).first();
  let click = null;
  if (await row.isVisible().catch(() => false)) {
    const btn = row.locator('button, div[role="button"]').filter({ hasText: /添加|Add|移除|Remove/ }).first();
    const meta = await btn.evaluate((b) => ({
      text: (b.innerText || '').trim(),
      aria: b.getAttribute('aria-label'),
      disabled: b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true'
    })).catch(() => null);
    if (meta) {
      await btn.click({ force: true });
      await sleep(1500);
      const after = await row.innerText().catch(() => '');
      click = { meta, after: (after || '').replace(/\s+/g, ' ').slice(0, 180) };
    }
  }

  // members tab count check
  const membersTab = page.locator('[role="dialog"] a:has-text("成员"), [role="dialog"] [role="tab"]:has-text("成员")').first();
  if (await membersTab.isVisible().catch(() => false)) {
    await membersTab.click({ force: true });
    await sleep(1200);
  }
  const membersText = await page.locator('[role="dialog"]').filter({ hasText: '列表成员' }).last().innerText().catch(() => '');

  const payload = { handle: HANDLE, snapshot, click, membersText: (membersText || '').slice(0, 800) };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
  await c.close();
} finally {
  database.close();
}
