import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const LIST_ID = '2083262800521224237';
const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const OUT = path.resolve('.ai/direct-add-benchmark-members-result.json');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSuggested(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);
  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2500);

  const edit = page.locator(`a[href="/i/lists/${LIST_ID}/info"], a:has-text("编辑列表")`).first();
  await edit.waitFor({ state: 'visible', timeout: 15_000 });
  await edit.click({ force: true });
  await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 10_000 });
  await sleep(800);

  const manage = page.locator(
    `a[href="/i/lists/${LIST_ID}/members"], [role="tab"]:has-text("管理成员"), a:has-text("管理成员")`
  ).first();
  await manage.waitFor({ state: 'visible', timeout: 10_000 });
  await manage.click({ force: true });
  await sleep(1500);

  const suggested = page.locator(
    '[role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐"), a:has-text("已推荐"), [role="tab"]:has-text("已推荐")'
  ).first();
  await suggested.waitFor({ state: 'visible', timeout: 10_000 });
  await suggested.click({ force: true });
  await sleep(1200);

  const search = page.locator(
    '[role="dialog"] input[placeholder*="搜索用户"], [aria-modal="true"] input[placeholder*="搜索用户"], [role="dialog"] input[type="text"]'
  ).first();
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  return search;
}

async function addOne(page, handle) {
  const bare = handle.replace(/^@/, '');
  const search = await openSuggested(page);
  await search.click({ force: true });
  await search.fill('');
  await search.type(bare, { delay: 35 });
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(1800);

  const row = page
    .locator('[role="dialog"] [data-testid="UserCell"], [aria-modal="true"] [data-testid="UserCell"]')
    .filter({ hasText: new RegExp(`@?${bare}`, 'i') })
    .first();
  await row.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  if (!(await row.isVisible().catch(() => false))) {
    return { handle, state: 'failed', reason: 'user_not_found' };
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
    return { handle, state: 'failed', reason: 'add_button_missing' };
  }

  await addBtn.click({ force: true });
  await sleep(1200);

  if (await removeBtn.isVisible().catch(() => false)) {
    return { handle, state: 'succeeded' };
  }
  const rowText = (await row.innerText().catch(() => '')) || '';
  if (/移除|Remove/.test(rowText)) return { handle, state: 'succeeded' };
  return { handle, state: 'unknown', reason: 'clicked_but_unconfirmed', rowText: rowText.slice(0, 120) };
}

const database = migrateDatabase(DB);
const results = [];
try {
  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('请先在设置里选择 Pyaireader 专用 X 登录态。');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'visible' });
  const c = await chromium.connectOverCDP(runtime.cdpUrl);
  const context = c.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  for (const handle of HANDLES) {
    console.log('adding', handle);
    try {
      const item = await addOne(page, handle);
      results.push(item);
      console.log(JSON.stringify(item));
    } catch (error) {
      const item = {
        handle,
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      };
      results.push(item);
      console.log(JSON.stringify(item));
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(800);
    }
    await sleep(1200);
  }

  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2500);
  const header = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800));
  const payload = {
    ok: results.some((item) => item.state === 'succeeded' || item.state === 'already_present'),
    succeeded: results.filter((item) => item.state === 'succeeded').map((item) => item.handle),
    already: results.filter((item) => item.state === 'already_present').map((item) => item.handle),
    failed: results.filter((item) => item.state !== 'succeeded' && item.state !== 'already_present'),
    results,
    headerSample: header
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
  await c.close();
  if (!payload.ok) process.exitCode = 1;
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
