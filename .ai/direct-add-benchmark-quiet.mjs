import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const LIST_ID = '2083262800521224237';
const OUT = path.resolve('.ai/direct-add-benchmark-quiet-result.json');
const HANDLES = [
  '@ArtificialAnlys',
  '@lmsysorg',
  '@lmarena_ai',
  '@huggingface',
  '@OpenRouter',
  '@EpochAIResearch',
  '@arcprize',
  '@SWEbench',
  '@togethercompute',
  '@fireworks_ai',
  '@GroqInc',
  '@wandb',
  '@scale_AI',
  '@StanfordCRFM',
  '@haizelabs',
  '@vectara'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visibleDialog(page, textIncludes) {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const count = await dialogs.count();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = dialogs.nth(i);
    if (!(await d.isVisible().catch(() => false))) continue;
    const text = ((await d.innerText().catch(() => '')) || '');
    if (!textIncludes || text.includes(textIncludes)) return d;
  }
  return null;
}

async function openSuggestedSheet(page) {
  // Never deep-link /members/suggested — X redirects this session to /home.
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(150);
  }

  await page.goto(`https://x.com/i/lists/${LIST_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  await sleep(2200);
  if (page.url().includes('/home')) {
    throw new Error('list page redirected to home');
  }

  const edit = page.locator(`a[href="/i/lists/${LIST_ID}/info"]`).first();
  await edit.waitFor({ state: 'visible', timeout: 15_000 });
  await edit.click({ force: true });
  await sleep(1200);

  let dialog = await visibleDialog(page, '管理成员');
  if (!dialog) dialog = await visibleDialog(page, '编辑列表');
  if (!dialog) throw new Error('edit list dialog not visible');

  const manage = dialog.locator('a:has-text("管理成员"), [role="tab"]:has-text("管理成员"), a[href*="/members"]').first();
  await manage.waitFor({ state: 'visible', timeout: 10_000 });
  await manage.click({ force: true });
  await sleep(1200);

  dialog = (await visibleDialog(page, '已推荐')) || (await visibleDialog(page, '管理成员'));
  if (!dialog) throw new Error('members dialog not visible');

  const suggested = dialog.locator('a:has-text("已推荐"), [role="tab"]:has-text("已推荐"), a[href*="suggested"]').first();
  if (await suggested.isVisible().catch(() => false)) {
    await suggested.click({ force: true });
    await sleep(900);
  }

  dialog = (await visibleDialog(page, '已推荐')) || (await visibleDialog(page, '管理成员')) || (await visibleDialog(page));
  if (!dialog) throw new Error('suggested dialog missing');

  const search = dialog.locator(
    'input[placeholder*="搜索用户"], input[placeholder*="Search people"], input[placeholder*="Search"], input[type="text"]'
  ).first();
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  return { dialog, search };
}

async function addOne(page, handle) {
  const bare = handle.replace(/^@/, '');
  const { dialog, search } = await openSuggestedSheet(page);

  await search.click({ force: true });
  await search.fill('');
  await sleep(100);
  await search.type(bare, { delay: 35 });
  // Do NOT press Enter if it navigates away; wait for typeahead/results first.
  await sleep(1800);

  // Prefer rows inside the members dialog.
  let row = dialog.locator('[data-testid="UserCell"]').filter({ hasText: new RegExp(`@?${bare}`, 'i') }).first();
  if (!(await row.isVisible().catch(() => false))) {
    // typeahead option
    row = dialog.locator('[role="option"], [data-testid="TypeaheadUser"], li').filter({ hasText: new RegExp(`@?${bare}`, 'i') }).first();
  }
  if (!(await row.isVisible().catch(() => false))) {
    // broader page search inside any visible dialog
    const anyDialog = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible');
    row = anyDialog.locator('[data-testid="UserCell"], [role="option"]').filter({ hasText: new RegExp(`@?${bare}`, 'i') }).first();
  }
  if (!(await row.isVisible().catch(() => false))) {
    // last resort: Enter then wait
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(1500);
    row = page.locator('[data-testid="UserCell"]').filter({ hasText: new RegExp(`@?${bare}`, 'i') }).first();
  }
  if (!(await row.isVisible().catch(() => false))) {
    const sample = ((await dialog.innerText().catch(() => '')) || '').slice(0, 240);
    return { handle, state: 'failed', reason: 'user_not_found', sample };
  }

  const removeBtn = row.locator(
    'button:has-text("移除"), button:has-text("Remove"), button[aria-label*="移除"], button[aria-label*="Remove"]'
  ).first();
  if (await removeBtn.isVisible().catch(() => false)) {
    return { handle, state: 'already_present' };
  }

  const addBtn = row.locator(
    'button:has-text("添加"), button:has-text("Add"), button[aria-label*="添加"], button[aria-label*="Add"], div[role="button"]:has-text("添加"), div[role="button"]:has-text("Add")'
  ).first();
  if (!(await addBtn.isVisible().catch(() => false))) {
    // sometimes button is sibling outside cell text filter
    const parent = row.locator('xpath=ancestor-or-self::*[contains(@data-testid,"UserCell") or @role="option"][1]');
    const alt = parent.locator('button:has-text("添加"), button:has-text("Add"), button[aria-label*="添加"]').first();
    if (await alt.isVisible().catch(() => false)) {
      await alt.click({ force: true });
      await sleep(1000);
      return { handle, state: 'succeeded', via: 'parent-add' };
    }
    const rowText = ((await row.innerText().catch(() => '')) || '').slice(0, 160);
    return { handle, state: 'failed', reason: 'add_button_missing', rowText };
  }

  await addBtn.scrollIntoViewIfNeeded().catch(() => {});
  await addBtn.click({ force: true });
  await sleep(1100);

  if (await removeBtn.isVisible().catch(() => false)) return { handle, state: 'succeeded' };
  const rowText = ((await row.innerText().catch(() => '')) || '');
  if (/移除|Remove/.test(rowText)) return { handle, state: 'succeeded' };
  return { handle, state: 'unknown', reason: 'clicked_unconfirmed', rowText: rowText.slice(0, 160) };
}

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
const results = [];
try {
  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('missing browser config');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'quiet' });
  const c = await chromium.connectOverCDP(runtime.cdpUrl);
  const page = c.contexts()[0].pages()[0] || await c.contexts()[0].newPage();

  for (const handle of HANDLES) {
    process.stdout.write(`ADD ${handle} ... `);
    try {
      const item = await addOne(page, handle);
      results.push(item);
      console.log(item.state, item.reason || item.via || '');
    } catch (error) {
      const item = {
        handle,
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      };
      results.push(item);
      console.log('failed', item.reason);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(400);
    }
    await sleep(700);
  }

  // readback via list page (not members deep link)
  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2000);
  const header = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    const m = t.match(/(\d+)\s*成员/);
    return { memberText: m ? m[0] : null, sample: t.slice(0, 300) };
  });

  const payload = {
    ok: results.some((r) => r.state === 'succeeded' || r.state === 'already_present'),
    succeeded: results.filter((r) => r.state === 'succeeded').map((r) => r.handle),
    already: results.filter((r) => r.state === 'already_present').map((r) => r.handle),
    failed: results.filter((r) => r.state !== 'succeeded' && r.state !== 'already_present'),
    results,
    header
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: payload.ok,
    succeeded: payload.succeeded,
    already: payload.already,
    failedCount: payload.failed.length,
    failed: payload.failed.map((f) => ({ handle: f.handle, reason: f.reason })),
    header: payload.header
  }, null, 2));
  await c.close();
  if (!payload.succeeded.length && !payload.already.length) process.exitCode = 1;
} catch (error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    results
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
