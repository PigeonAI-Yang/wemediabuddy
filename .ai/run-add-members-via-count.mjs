import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';
import { xListUrl } from '../src/main/platforms/x-list-primitives.ts';

const LIST_ID = '2082851520417255750';
const HANDLES = [
  '@AnthropicAI',
  '@GoogleDeepMind',
  '@xai',
  '@BytePlusGlobal',
  '@ByteDanceOSS',
  '@CapCutApp'
];
const OUT = path.resolve('.ai/run-add-members-via-count-result.json');

async function dumpDialog(active) {
  return active.page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
    return {
      url: location.href,
      dialogCount: dialogs.length,
      dialogs: dialogs.map((d) => ({
        text: (d.innerText || '').slice(0, 250),
        inputs: [...d.querySelectorAll('input')].map((i) => ({
          testid: i.getAttribute('data-testid'),
          placeholder: i.getAttribute('placeholder'),
          aria: i.getAttribute('aria-label'),
          visible: !!(i.offsetWidth || i.offsetHeight)
        })),
        buttons: [...d.querySelectorAll('button')].map((b) => ({
          text: (b.innerText || '').trim().slice(0, 40),
          aria: b.getAttribute('aria-label')
        })).filter((b) => b.text || b.aria).slice(0, 30),
        cells: [...d.querySelectorAll('[data-testid="UserCell"]')].slice(0, 8).map((c) => (c.innerText || '').slice(0, 80))
      }))
    };
  });
}

function sheetReady(state) {
  return state.dialogs.some((d) =>
    d.cells.length > 0
    || d.buttons.some((b) => /移除|Remove|添加|Add/i.test(`${b.text || ''} ${b.aria || ''}`))
    || /管理成员|列表成员|成员\s*\(|Members|已推荐|Suggested/i.test(d.text)
  );
}

async function openMembersSheet(active) {
  await active.page.goto(xListUrl(LIST_ID), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await active.page.waitForTimeout(3000);
  await active.dismissBlockingOverlays();

  const membersLink = active.page.locator(`a[href="/i/lists/${LIST_ID}/members"]`).first();
  if (await membersLink.isVisible().catch(() => false)) {
    await membersLink.click({ force: true });
  } else {
    await active.page.getByText('编辑列表', { exact: true }).click({ force: true });
    await active.page.waitForTimeout(1200);
    await active.page.getByText('管理成员', { exact: false }).click({ force: true });
  }

  for (let i = 0; i < 20; i += 1) {
    const state = await dumpDialog(active);
    if (sheetReady(state)) return state;
    if (i === 8) {
      const edit = active.page.getByText('编辑列表', { exact: true });
      if (await edit.isVisible().catch(() => false)) {
        await edit.click({ force: true });
        await active.page.waitForTimeout(1000);
        const manage = active.page.getByText('管理成员', { exact: false });
        if (await manage.isVisible().catch(() => false)) await manage.click({ force: true });
      }
    }
    await active.page.waitForTimeout(500);
  }
  throw new Error(`members sheet not ready: ${JSON.stringify(await dumpDialog(active))}`);
}

async function membersDialog(active) {
  const withCells = active.page.locator('[role="dialog"],[aria-modal="true"]').filter({ has: active.page.locator('[data-testid="UserCell"]') }).first();
  if (await withCells.isVisible().catch(() => false)) return withCells;
  return active.page.locator('[role="dialog"],[aria-modal="true"]').filter({ hasText: /管理成员|列表成员|成员\s*\(|Members|已推荐|Suggested/i }).first();
}

async function goSuggested(active) {
  const dialog = await membersDialog(active);
  const suggested = dialog.getByText('已推荐', { exact: true }).or(dialog.getByText('Suggested', { exact: true })).first();
  if (await suggested.isVisible().catch(() => false)) {
    await suggested.click({ force: true });
    await active.page.waitForTimeout(800);
  }
}

async function goMembersTab(active) {
  const dialog = await membersDialog(active);
  const tab = dialog.getByText(/成员\s*\(/).or(dialog.getByText(/Members\s*\(/)).or(dialog.getByText('列表成员', { exact: false })).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ force: true });
    await active.page.waitForTimeout(800);
  }
}

async function addOne(active, handle) {
  const bare = handle.replace(/^@/, '');
  await goSuggested(active);
  const dialog = await membersDialog(active);

  let input = dialog.locator('input[data-testid="SearchBox_Search_Input"], input[placeholder*="搜索"], input[placeholder*="Search"], input[type="text"]').first();
  if (!await input.isVisible().catch(() => false)) {
    const count = await dialog.locator('input').count();
    if (count === 0) {
      // suggested tab may expose search only after click; dump and fail clearly
      throw new Error(`no input in members dialog for ${handle}: ${JSON.stringify(await dumpDialog(active))}`);
    }
    input = dialog.locator('input').first();
  }

  await input.click({ force: true });
  await active.page.keyboard.press('Control+A');
  await active.page.keyboard.press('Backspace');
  await active.page.keyboard.type(bare, { delay: 30 });
  await active.page.waitForTimeout(2200);

  let row = dialog.locator(`[data-testid="UserCell"]:has(a[href="/${bare}"])`).first();
  if (!await row.isVisible().catch(() => false)) {
    row = dialog.locator('[data-testid="UserCell"]').filter({ hasText: new RegExp(`@?${bare}`, 'i') }).first();
  }
  if (!await row.isVisible().catch(() => false)) {
    const cells = await dialog.locator('[data-testid="UserCell"]').allInnerTexts().catch(() => []);
    throw new Error(`not found ${handle}; cells=${JSON.stringify(cells.slice(0, 10).map((t) => t.slice(0, 80)))}`);
  }

  if (await row.locator('button[aria-label="移除"], button:has-text("移除"), button[aria-label="Remove"], button:has-text("Remove")').first().isVisible().catch(() => false)) {
    return 'already_present';
  }
  const addBtn = row.locator('button[aria-label="添加"], button:has-text("添加"), button[aria-label="Add"], button:has-text("Add")').first();
  if (!await addBtn.isVisible().catch(() => false)) throw new Error(`no add button for ${handle}`);
  await addBtn.click({ force: true });
  await active.page.waitForTimeout(1200);
  return 'added';
}

async function readPresent(active) {
  await goMembersTab(active);
  const dialog = await membersDialog(active);
  for (let i = 0; i < 5; i += 1) {
    await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    await active.page.mouse.wheel(0, 600);
    await active.page.waitForTimeout(400);
  }
  const texts = await dialog.locator('[data-testid="UserCell"]').allInnerTexts().catch(() => []);
  const handles = [];
  for (const text of texts) {
    if (!/移除|Remove/i.test(text)) continue;
    const m = text.match(/@([A-Za-z0-9_]+)/);
    if (m) handles.push(`@${m[1]}`);
  }
  return [...new Set(handles)];
}

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
const results = [];
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };
  const session = await XListSession.open(config);
  try {
    await session.run(async (active) => {
      const opened = await openMembersSheet(active);
      console.log('opened', JSON.stringify(opened).slice(0, 500));

      for (const handle of HANDLES) {
        console.log('adding', handle);
        try {
          if (!await (await membersDialog(active)).isVisible().catch(() => false)) {
            await openMembersSheet(active);
          }
          const outcome = await addOne(active, handle);
          results.push({ handle, ok: true, outcome });
          console.log('ok', handle, outcome);
        } catch (error) {
          results.push({ handle, ok: false, error: error instanceof Error ? error.message : String(error) });
          console.error('fail', handle, error instanceof Error ? error.message : error);
          try { await openMembersSheet(active); } catch {}
        }
      }

      const members = await readPresent(active);
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
    }, { timeoutMs: 900_000 });
  } finally {
    await session.close();
  }
} catch (error) {
  const payload = { ok: false, error: String(error?.message || error), stack: error?.stack, results };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
