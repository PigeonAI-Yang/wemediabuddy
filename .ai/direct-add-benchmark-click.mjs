import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';

const LIST_ID = '2083262800521224237';
const OUT = path.resolve('.ai/direct-add-benchmark-click-result.json');
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

async function ensureSuggested(page) {
  const url = page.url();
  if (!url.includes(`/i/lists/${LIST_ID}/members`)) {
    await page.goto(`https://x.com/i/lists/${LIST_ID}/members/suggested`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });
    await sleep(2000);
  }

  // Prefer suggested tab if visible.
  const suggested = page.locator(
    'a[href$="/members/suggested"], [role="tab"]:has-text("已推荐"), a:has-text("已推荐"), [role="tab"]:has-text("Suggested")'
  ).first();
  if (await suggested.isVisible().catch(() => false)) {
    await suggested.click({ force: true }).catch(() => {});
    await sleep(800);
  }

  // Search box may be placeholder 搜索用户 or SearchBox testid.
  let search = page.locator(
    '[role="dialog"] input[placeholder*="搜索用户"], [aria-modal="true"] input[placeholder*="搜索用户"], [role="dialog"] input[placeholder*="Search"], input[placeholder*="搜索用户"]'
  ).first();
  if (!(await search.isVisible().catch(() => false))) {
    // fallback path via edit list
    await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(1500);
    const edit = page.locator(`a[href="/i/lists/${LIST_ID}/info"]`).first();
    if (await edit.isVisible().catch(() => false)) {
      await edit.click({ force: true });
      await sleep(1000);
      const manage = page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).locator('a:has-text("管理成员"), [role="tab"]:has-text("管理成员")').first();
      if (await manage.isVisible().catch(() => false)) await manage.click({ force: true });
      await sleep(1000);
      const sug = page.locator('[role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐")').first();
      if (await sug.isVisible().catch(() => false)) await sug.click({ force: true });
      await sleep(800);
    }
    search = page.locator(
      '[role="dialog"] input[placeholder*="搜索用户"], [aria-modal="true"] input[placeholder*="搜索用户"], [role="dialog"] input[type="text"], input[placeholder*="搜索用户"]'
    ).first();
  }

  await search.waitFor({ state: 'visible', timeout: 15_000 });
  return search;
}

async function addHandle(page, handle) {
  const bare = handle.replace(/^@/, '');
  const search = await ensureSuggested(page);

  await search.click({ force: true });
  // clear
  await search.fill('');
  await sleep(150);
  await search.type(bare, { delay: 30 });
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(1600);

  // Find matching user cell in any visible dialog / page.
  const cells = page.locator('[data-testid="UserCell"]');
  const count = await cells.count();
  let row = null;
  for (let i = 0; i < count; i += 1) {
    const cell = cells.nth(i);
    if (!(await cell.isVisible().catch(() => false))) continue;
    const text = ((await cell.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    const hrefHit = await cell.locator(`a[href="/${bare}" i], a[href="/${bare}"]`).count();
    if (hrefHit > 0 || new RegExp(`@?${bare}`, 'i').test(text)) {
      row = cell;
      break;
    }
  }
  if (!row) return { handle, state: 'failed', reason: 'user_not_found', cellCount: count };

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
    const rowText = ((await row.innerText().catch(() => '')) || '').slice(0, 160);
    return { handle, state: 'failed', reason: 'add_button_missing', rowText };
  }

  await addBtn.scrollIntoViewIfNeeded().catch(() => {});
  await addBtn.click({ force: true, timeout: 10_000 });
  await sleep(1200);

  if (await removeBtn.isVisible().catch(() => false)) {
    return { handle, state: 'succeeded' };
  }
  const rowText = ((await row.innerText().catch(() => '')) || '');
  if (/移除|Remove/.test(rowText)) return { handle, state: 'succeeded' };
  return { handle, state: 'unknown', reason: 'clicked_unconfirmed', rowText: rowText.slice(0, 160) };
}

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
const results = [];
try {
  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('missing browser config');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'visible' });
  const c = await chromium.connectOverCDP(runtime.cdpUrl);
  const page = c.contexts()[0].pages()[0] || await c.contexts()[0].newPage();

  // Stay on current members/suggested page if already open.
  if (!page.url().includes(`/i/lists/${LIST_ID}`)) {
    await page.goto(`https://x.com/i/lists/${LIST_ID}/members/suggested`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });
    await sleep(2000);
  }

  for (const handle of HANDLES) {
    process.stdout.write(`ADD ${handle} ... `);
    try {
      const item = await addHandle(page, handle);
      results.push(item);
      console.log(item.state, item.reason || '');
    } catch (error) {
      const item = {
        handle,
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      };
      results.push(item);
      console.log('failed', item.reason);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
    await sleep(900);
  }

  // Readback member count text
  await page.goto(`https://x.com/i/lists/${LIST_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2000);
  const header = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    const m = t.match(/(\d+)\s*成员/);
    return { memberText: m ? m[0] : null, sample: t.slice(0, 400) };
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
    failed: payload.failed.map((f) => f.handle),
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
