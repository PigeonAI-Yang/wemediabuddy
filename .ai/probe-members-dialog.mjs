import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const LIST_ID = '2082851520417255750';
const OUT = path.resolve('.ai/probe-members-dialog.json');

async function dismissOverlays(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
  // remove inert masks that block pointer events if still present after Esc
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid="mask"], [data-testid="sheetDialog"], [aria-modal="true"]')) {
      // don't remove sheet that is the members sheet itself if it contains UserCell
      if (el.querySelector?.('[data-testid="UserCell"], input[data-testid="SearchBox_Search_Input"]')) continue;
      if (el.getAttribute('data-testid') === 'mask') el.remove();
    }
  }).catch(() => {});
}

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const browser = await chromium.connectOverCDP(runtime.cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith('devtools://')) || await context.newPage();

  await dismissOverlays(page);
  await page.goto(`https://x.com/i/lists/${LIST_ID}/members`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await dismissOverlays(page);

  // If members sheet not open, click members tab / manage
  const maybeMembers = page.locator('a[href$="/members"], a:has-text("成员"), a:has-text("Members")').first();
  if (await maybeMembers.isVisible().catch(() => false)) {
    await maybeMembers.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const dump = await page.evaluate(() => {
    const textOf = (el) => (el?.innerText || '').trim().slice(0, 400);
    const layers = [...document.querySelectorAll('#layers > div, [data-testid="mask"], [role="dialog"], [aria-modal="true"]')].map((el) => ({
      tag: el.tagName,
      testid: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      ariaModal: el.getAttribute('aria-modal'),
      className: String(el.className || '').slice(0, 120),
      text: textOf(el).slice(0, 200),
      hasUserCell: !!el.querySelector?.('[data-testid="UserCell"]'),
      hasSearch: !!el.querySelector?.('input[data-testid="SearchBox_Search_Input"], input[type="text"]'),
      rect: el.getBoundingClientRect?.() ? {
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height)
      } : null
    }));
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((d, idx) => ({
      idx,
      text: textOf(d).slice(0, 300),
      inputs: [...d.querySelectorAll('input')].map((i) => ({
        testid: i.getAttribute('data-testid'),
        placeholder: i.getAttribute('placeholder'),
        aria: i.getAttribute('aria-label'),
        value: i.value
      })),
      buttons: [...d.querySelectorAll('button')].map((b) => ({
        text: textOf(b).slice(0, 40),
        aria: b.getAttribute('aria-label'),
        testid: b.getAttribute('data-testid')
      })).filter((b) => b.text || b.aria).slice(0, 30),
      userCells: [...d.querySelectorAll('[data-testid="UserCell"]')].slice(0, 8).map((c) => textOf(c).slice(0, 120))
    }));
    return { url: location.href, layers, dialogs };
  });

  // Try force-focus search inside dialog and type AnthropicAI
  const search = page.locator('[role="dialog"] input[data-testid="SearchBox_Search_Input"], [role="dialog"] input[type="text"], input[data-testid="SearchBox_Search_Input"]').last();
  const searchCount = await page.locator('input[data-testid="SearchBox_Search_Input"]').count();
  let afterSearch = null;
  if (searchCount > 0) {
    await search.click({ force: true, timeout: 5000 }).catch(async () => {
      await search.focus().catch(() => {});
    });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('AnthropicAI', { delay: 30 });
    await page.waitForTimeout(2500);
    afterSearch = await page.evaluate(() => {
      const textOf = (el) => (el?.innerText || '').trim().slice(0, 200);
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input')) || document.body;
      return {
        url: location.href,
        inputValue: document.querySelector('input[data-testid="SearchBox_Search_Input"]')?.value || null,
        cells: [...dialog.querySelectorAll('[data-testid="UserCell"]')].slice(0, 10).map((c) => textOf(c)),
        buttons: [...dialog.querySelectorAll('button')].map((b) => ({
          text: textOf(b).slice(0, 40),
          aria: b.getAttribute('aria-label')
        })).filter((b) => /add|添加|remove|移除/i.test(`${b.text} ${b.aria || ''}`)).slice(0, 20)
      };
    });

    // try click Add on first matching cell
    const add = page.locator('[role="dialog"] button:has-text("添加"), [role="dialog"] button:has-text("Add"), button[aria-label*="Add"], button[aria-label*="添加"]').first();
    afterSearch.addVisible = await add.isVisible().catch(() => false);
    if (afterSearch.addVisible) {
      await add.click({ force: true, timeout: 5000 }).catch((e) => { afterSearch.addError = e.message; });
      await page.waitForTimeout(2000);
      afterSearch.afterAdd = await page.evaluate(() => ({
        url: location.href,
        toast: document.body.innerText.includes('已添加') || document.body.innerText.includes('Added'),
        cells: [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 15).map((c) => (c.innerText || '').slice(0, 80))
      }));
    }
  }

  const payload = { ok: true, dump, searchCount, afterSearch };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2).slice(0, 5000));
} catch (error) {
  const payload = { ok: false, error: String(error?.message || error), stack: error?.stack };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
