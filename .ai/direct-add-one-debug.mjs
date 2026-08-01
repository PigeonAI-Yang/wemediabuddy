import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const LIST_ID = '2083262800521224237';
const HANDLE = process.argv[2] || '@ArtificialAnlys';
const bare = HANDLE.replace(/^@/, '');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function dump(page, label) {
  const data = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).map((d, idx) => {
      const style = getComputedStyle(d);
      const rect = d.getBoundingClientRect();
      return {
        idx,
        text: (d.innerText || '').slice(0, 200).replace(/\n/g, ' | '),
        visible: !!(d.offsetWidth || d.offsetHeight || rect.width || rect.height),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        inputs: Array.from(d.querySelectorAll('input')).map((i) => ({
          ph: i.placeholder,
          testid: i.getAttribute('data-testid'),
          visible: !!(i.offsetWidth || i.offsetHeight)
        }))
      };
    });
    return {
      url: location.href,
      title: document.title,
      body: (document.body?.innerText || '').slice(0, 300).replace(/\n/g, ' | '),
      dialogs
    };
  });
  console.log(label, JSON.stringify(data, null, 2));
  return data;
}

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browser = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'visible' });
  const c = await chromium.connectOverCDP(runtime.cdpUrl);
  const page = c.contexts()[0].pages()[0] || await c.contexts()[0].newPage();

  // hard reset overlays
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  }

  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(3000);
  await dump(page, 'list-home');

  // click edit list by href
  const edit = page.locator(`a[href="/i/lists/${LIST_ID}/info"]`).first();
  console.log('edit visible', await edit.isVisible().catch(() => false));
  await edit.click({ force: true, timeout: 10_000 });
  await sleep(2500);
  await dump(page, 'after-edit-click');

  // find visible dialog containing 管理成员
  const manage = page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).locator('a:has-text("管理成员"), [role="tab"]:has-text("管理成员")').first();
  console.log('manage count/visible', await page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).count(), await manage.isVisible().catch(() => false));
  if (await manage.isVisible().catch(() => false)) {
    await manage.click({ force: true });
  } else {
    // fallback: direct members via header count, then try suggested
    await page.goto(`https://x.com/i/lists/${LIST_ID}/members`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  await sleep(2500);
  await dump(page, 'after-manage');

  // suggested tab
  const suggested = page.locator('[role="dialog"]').filter({ hasText: '已推荐' }).locator('a:has-text("已推荐"), [role="tab"]:has-text("已推荐")').first();
  console.log('suggested visible', await suggested.isVisible().catch(() => false));
  if (await suggested.isVisible().catch(() => false)) {
    await suggested.click({ force: true });
    await sleep(1500);
  } else {
    // try any suggested text
    const s2 = page.getByText('已推荐', { exact: true }).first();
    console.log('s2 visible', await s2.isVisible().catch(() => false));
    if (await s2.isVisible().catch(() => false)) await s2.click({ force: true });
    await sleep(1500);
  }
  await dump(page, 'after-suggested');

  // search input visible in dialog
  const search = page.locator('[role="dialog"] input[placeholder*="搜索用户"], [role="dialog"] input[placeholder*="Search"], [role="dialog"] input[type="text"]').first();
  console.log('search visible', await search.isVisible().catch(() => false), 'count', await page.locator('[role="dialog"] input').count());
  if (!(await search.isVisible().catch(() => false))) {
    // try all visible inputs
    const all = page.locator('input');
    const n = await all.count();
    for (let i = 0; i < n; i += 1) {
      const el = all.nth(i);
      const meta = await el.evaluate((node) => ({
        ph: node.getAttribute('placeholder'),
        testid: node.getAttribute('data-testid'),
        visible: !!(node.offsetWidth || node.offsetHeight)
      }));
      console.log('input', i, meta);
    }
    throw new Error('no search input');
  }

  await search.click({ force: true });
  await search.fill('');
  await search.type(bare, { delay: 40 });
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(2000);
  await dump(page, 'after-search');

  const row = page.locator('[role="dialog"] [data-testid="UserCell"]').filter({ hasText: new RegExp(bare, 'i') }).first();
  console.log('row visible', await row.isVisible().catch(() => false));
  if (!(await row.isVisible().catch(() => false))) throw new Error('row missing');
  const addBtn = row.locator('button:has-text("添加"), button:has-text("Add")').first();
  const removeBtn = row.locator('button:has-text("移除"), button:has-text("Remove")').first();
  if (await removeBtn.isVisible().catch(() => false)) {
    console.log('already present');
  } else if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click({ force: true });
    await sleep(1500);
    console.log('clicked add; remove now?', await removeBtn.isVisible().catch(() => false));
  } else {
    console.log('row text', (await row.innerText()).slice(0, 200));
    throw new Error('no add/remove');
  }

  await c.close();
} catch (error) {
  console.error('FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  database.close();
}
