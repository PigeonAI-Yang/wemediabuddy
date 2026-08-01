import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const LIST_ID = '2083262800521224237';
const HANDLE = (process.argv[2] || '@ArtificialAnlys').replace(/^@/, '');
const OUT = path.resolve('.ai/probe-suggested-search-quiet.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browser = readBrowserConfig(database);
  // quiet = background, do not steal foreground focus
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'quiet' });
  const c = await chromium.connectOverCDP(runtime.cdpUrl);
  const page = c.contexts()[0].pages()[0] || await c.contexts()[0].newPage();

  await page.goto(`https://x.com/i/lists/${LIST_ID}/members/suggested`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  await sleep(2500);

  const before = await page.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 500),
    inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
      ph: i.placeholder,
      testid: i.getAttribute('data-testid'),
      aria: i.getAttribute('aria-label'),
      visible: !!(i.offsetWidth || i.offsetHeight)
    }))
  }));

  const search = page.locator(
    'input[placeholder*="搜索用户"], input[placeholder*="Search people"], input[placeholder*="Search"], input[data-testid="SearchBox_Search_Input"], input[type="text"]'
  ).first();
  await search.waitFor({ state: 'visible', timeout: 15_000 });
  await search.click({ force: true });
  await search.fill('');
  await search.type(HANDLE, { delay: 40 });
  await sleep(2500);

  const after = await page.evaluate((bare) => {
    const cells = Array.from(document.querySelectorAll('[data-testid="UserCell"]')).map((cell) => ({
      text: (cell.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      hrefs: Array.from(cell.querySelectorAll('a[href^="/"]')).map((a) => a.getAttribute('href')).slice(0, 6),
      buttons: Array.from(cell.querySelectorAll('button, div[role="button"]')).map((b) => ({
        text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
        aria: b.getAttribute('aria-label')
      }))
    }));
    const typeahead = Array.from(document.querySelectorAll('[data-testid="TypeaheadUser"], [role="listbox"] [role="option"], [data-testid="typeaheadResult"]')).map((el) => ({
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      hrefs: Array.from(el.querySelectorAll('a[href^="/"]')).map((a) => a.getAttribute('href')).slice(0, 6)
    }));
    const addButtons = Array.from(document.querySelectorAll('button, div[role="button"]'))
      .map((b) => ({
        text: (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        aria: b.getAttribute('aria-label'),
        visible: !!(b.offsetWidth || b.offsetHeight)
      }))
      .filter((b) => /添加|Add|移除|Remove/.test(`${b.text} ${b.aria || ''}`))
      .slice(0, 30);
    const links = Array.from(document.querySelectorAll(`a[href="/${bare}" i], a[href="/${bare}"]`)).map((a) => ({
      href: a.getAttribute('href'),
      text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      parentText: (a.closest('[data-testid="UserCell"], [role="option"], li, div')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    }));
    return {
      url: location.href,
      body: (document.body?.innerText || '').slice(0, 800),
      cells,
      typeahead,
      addButtons,
      links
    };
  }, HANDLE);

  const payload = { handle: `@${HANDLE}`, before, after };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify({
    url: after.url,
    cells: after.cells.length,
    typeahead: after.typeahead.length,
    addButtons: after.addButtons,
    links: after.links,
    bodySample: after.body.slice(0, 300)
  }, null, 2));
  await c.close();
} finally {
  database.close();
}
