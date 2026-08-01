import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';
import { xListUrl } from '../src/main/platforms/x-list-primitives.ts';

const LIST_ID = '2082851520417255750';
const HANDLES = ['@AnthropicAI', '@GoogleDeepMind', '@xai', '@BytePlusGlobal', '@ByteDanceOSS', '@CapCutApp'];
const OUT = path.resolve('.ai/add-frontier-now-result.json');

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function openManageSheet(page) {
  await page.goto(xListUrl(LIST_ID), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);

  // Exact proven control from earlier probe.
  const edit = page.locator(`a[href="/i/lists/${LIST_ID}/info"]`).first();
  await edit.waitFor({ state: 'visible', timeout: 15000 });
  await edit.click({ force: true });
  await sleep(1500);

  // Manage members may be link/button text inside info dialog/page.
  const manage = page.locator('a,button,div[role="button"],span').filter({ hasText: /^\s*管理成员\s*$|^\s*Manage members\s*$/i }).first();
  if (await manage.isVisible().catch(() => false)) {
    await manage.click({ force: true });
  } else {
    // fallback: members count link then look for manage UI chrome
    const members = page.locator(`a[href="/i/lists/${LIST_ID}/members"]`).first();
    await members.click({ force: true });
  }
  await sleep(1500);

  // Wait for member rows or suggested tab.
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
      return dialogs.some((d) => d.querySelector('[data-testid="UserCell"]') || /已推荐|Suggested|管理成员|列表成员/i.test(d.innerText || ''));
    });
    if (ok) return;
    await sleep(400);
  }
  throw new Error('manage sheet not open');
}

async function ensureSuggested(page) {
  const tab = page.locator('[role="dialog"],[aria-modal="true"]').getByText(/^\s*已推荐\s*$|^\s*Suggested\s*$/i).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ force: true });
    await sleep(800);
  }
}

async function dialog() {
  // filled later with page
}

async function addOne(page, handle) {
  const bare = handle.replace(/^@/, '');
  await ensureSuggested(page);

  // Search only inside dialogs that look like member management.
  const input = page.locator('[role="dialog"] input, [aria-modal="true"] input').filter({ hasNot: page.locator('[type="hidden"]') }).first();
  if (!await input.isVisible().catch(() => false)) {
    // Some builds put search only after suggested tab; try clicking suggested again via evaluate.
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('a,button,div,span')];
      const hit = nodes.find((n) => /^\s*(已推荐|Suggested)\s*$/i.test((n.innerText || '').trim()));
      if (hit) hit.click();
    });
    await sleep(1000);
  }
  if (!await input.isVisible().catch(() => false)) {
    const dump = await page.evaluate(() => ({
      url: location.href,
      dialogs: [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].map((d) => ({
        text: (d.innerText || '').slice(0, 180),
        inputs: d.querySelectorAll('input').length,
        cells: d.querySelectorAll('[data-testid="UserCell"]').length
      }))
    }));
    throw new Error(`no search input: ${JSON.stringify(dump)}`);
  }

  await input.click({ force: true });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(bare, { delay: 25 });
  await sleep(2200);

  const row = page.locator(`[role="dialog"] [data-testid="UserCell"]:has(a[href="/${bare}"]), [aria-modal="true"] [data-testid="UserCell"]:has(a[href="/${bare}"])`).first();
  const rowAlt = page.locator('[role="dialog"] [data-testid="UserCell"], [aria-modal="true"] [data-testid="UserCell"]').filter({ hasText: new RegExp(bare, 'i') }).first();
  const target = (await row.isVisible().catch(() => false)) ? row : rowAlt;
  if (!await target.isVisible().catch(() => false)) {
    const cells = await page.locator('[role="dialog"] [data-testid="UserCell"], [aria-modal="true"] [data-testid="UserCell"]').allInnerTexts().catch(() => []);
    throw new Error(`not found ${handle}: ${JSON.stringify(cells.slice(0, 8).map((t) => t.slice(0, 60)))}`);
  }
  if (await target.locator('button[aria-label="移除"], button:has-text("移除")').first().isVisible().catch(() => false)) return 'already_present';
  const addBtn = target.locator('button[aria-label="添加"], button:has-text("添加"), button[aria-label="Add"], button:has-text("Add")').first();
  if (!await addBtn.isVisible().catch(() => false)) throw new Error(`no add button ${handle}`);
  await addBtn.click({ force: true });
  await sleep(1000);
  return 'added';
}

async function readMembers(page) {
  // switch to members tab if present
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('a,button,div,span')];
    const hit = nodes.find((n) => /成员\s*\(|Members\s*\(|列表成员/i.test((n.innerText || '').trim()));
    if (hit) hit.click();
  });
  await sleep(800);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 700);
    await sleep(300);
  }
  return page.evaluate(() => {
    const root = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find((d) => d.querySelector('[data-testid="UserCell"]')) || document;
    const out = [];
    for (const cell of root.querySelectorAll('[data-testid="UserCell"]')) {
      const text = cell.innerText || '';
      if (!/移除|Remove/i.test(text)) continue;
      const m = text.match(/@([A-Za-z0-9_]+)/);
      if (m) out.push('@' + m[1]);
    }
    return [...new Set(out)];
  });
}

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
const results = [];
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const session = await XListSession.open({ id: browserCfg.id, cdpUrl: runtime.cdpUrl });
  try {
    await session.run(async (active) => {
      // Bypass heavy humanization navigation where possible by using page directly after lease acquired.
      await openManageSheet(active.page);
      for (const handle of HANDLES) {
        console.log('ADD', handle);
        try {
          // reopen if sheet closed
          const open = await active.page.locator('[role="dialog"] [data-testid="UserCell"], [aria-modal="true"] [data-testid="UserCell"]').first().isVisible().catch(() => false);
          if (!open) await openManageSheet(active.page);
          const outcome = await addOne(active.page, handle);
          results.push({ handle, ok: true, outcome });
          console.log('OK', handle, outcome);
        } catch (e) {
          results.push({ handle, ok: false, error: String(e?.message || e) });
          console.log('FAIL', handle, String(e?.message || e));
          try { await openManageSheet(active.page); } catch {}
        }
      }
      const members = await readMembers(active.page);
      const present = new Set(members.map((h) => h.toLowerCase()));
      const all = ['@deepseek_ai', '@OpenAI', ...HANDLES];
      const payload = {
        ok: results.every((r) => r.ok),
        results,
        members,
        presentAfter: all.map((h) => ({ handle: h, present: present.has(h.toLowerCase()) })),
        finishedAt: new Date().toISOString()
      };
      await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = payload.ok ? 0 : 2;
    }, { timeoutMs: 600000 });
  } finally {
    await session.close();
  }
} catch (e) {
  const payload = { ok: false, error: String(e?.message || e), stack: e?.stack, results };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
