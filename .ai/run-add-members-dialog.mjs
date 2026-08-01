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
const OUT = path.resolve('.ai/run-add-members-dialog-result.json');

async function openMembersDialog(active) {
  await active.page.goto(xListUrl(LIST_ID), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await active.page.waitForTimeout(2500);
  await active.dismissBlockingOverlays();
  const edit = active.page.getByText('编辑列表', { exact: true }).first();
  await edit.waitFor({ state: 'visible', timeout: 15000 });
  await edit.click({ force: true });
  await active.page.waitForTimeout(1200);
  const manage = active.page.getByText('管理成员', { exact: false }).first();
  await manage.waitFor({ state: 'visible', timeout: 15000 });
  await manage.click({ force: true });
  await active.page.locator('[role="dialog"] [data-testid="UserCell"], [role="dialog"] button:has-text("移除")').first().waitFor({ state: 'visible', timeout: 20000 });
}

async function openSuggested(active) {
  const suggested = active.page.getByText('已推荐', { exact: true }).first();
  if (await suggested.isVisible().catch(() => false)) {
    await suggested.click({ force: true });
    await active.page.waitForTimeout(1000);
  }
}

async function dialogSearch(active) {
  // Strictly inside members dialog. Never use global sidebar search.
  const dialog = active.page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).first();
  const input = dialog.locator('input').first();
  const visible = await input.isVisible().catch(() => false);
  if (!visible) {
    // dump dialog inputs for debug
    const info = await dialog.evaluate((el) => ({
      text: (el.innerText || '').slice(0, 200),
      inputs: [...el.querySelectorAll('input')].map((i) => ({
        testid: i.getAttribute('data-testid'),
        placeholder: i.getAttribute('placeholder'),
        aria: i.getAttribute('aria-label'),
        type: i.getAttribute('type'),
        visible: !!(i.offsetWidth || i.offsetHeight)
      }))
    }));
    throw new Error(`dialog search missing: ${JSON.stringify(info)}`);
  }
  return input;
}

async function addOne(active, handle) {
  const bare = handle.replace(/^@/, '');
  await openSuggested(active);
  const input = await dialogSearch(active);
  await input.click({ force: true });
  await active.page.keyboard.press('Control+A');
  await active.page.keyboard.type(bare, { delay: 35 });
  await active.page.waitForTimeout(2000);

  const dialog = active.page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).first();
  const row = dialog.locator(`[data-testid="UserCell"]:has(a[href="/${bare}"])`).first();
  await row.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  if (!await row.isVisible().catch(() => false)) {
    // try broader text match
    const row2 = dialog.locator('[data-testid="UserCell"]').filter({ hasText: bare }).first();
    if (!await row2.isVisible().catch(() => false)) {
      const cells = await dialog.locator('[data-testid="UserCell"]').allInnerTexts().catch(() => []);
      throw new Error(`user not found for ${handle}; cells=${JSON.stringify(cells.slice(0, 8))}`);
    }
    const addBtn = row2.locator('button[aria-label="添加"], button:has-text("添加"), button[aria-label="Add"], button:has-text("Add")').first();
    if (!await addBtn.isVisible().catch(() => false)) throw new Error(`add button missing for ${handle}`);
    await addBtn.click({ force: true });
    await active.page.waitForTimeout(1200);
    return 'added';
  }
  const addBtn = row.locator('button[aria-label="添加"], button:has-text("添加"), button[aria-label="Add"], button:has-text("Add")').first();
  if (!await addBtn.isVisible().catch(() => false)) {
    // already added might show 移除
    if (await row.locator('button[aria-label="移除"], button:has-text("移除")').first().isVisible().catch(() => false)) return 'already_present';
    throw new Error(`add button missing for ${handle}`);
  }
  await addBtn.click({ force: true });
  await active.page.waitForTimeout(1200);
  return 'added';
}

async function readMembers(active) {
  // ensure members tab
  const membersTab = active.page.getByText(/成员\s*\(/).first();
  if (await membersTab.isVisible().catch(() => false)) {
    await membersTab.click({ force: true });
    await active.page.waitForTimeout(1000);
  }
  const dialog = active.page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).first();
  const cells = dialog.locator('[data-testid="UserCell"]');
  const count = await cells.count();
  const handles = [];
  for (let i = 0; i < count; i += 1) {
    const text = await cells.nth(i).innerText().catch(() => '');
    if (!/移除|Remove/i.test(text)) continue;
    const m = text.match(/@([A-Za-z0-9_]+)/);
    if (m) handles.push(`@${m[1]}`);
  }
  return handles;
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
      await openMembersDialog(active);
      for (const handle of HANDLES) {
        console.log('adding', handle);
        try {
          const outcome = await addOne(active, handle);
          results.push({ handle, ok: true, outcome });
          console.log('ok', handle, outcome);
        } catch (error) {
          results.push({ handle, ok: false, error: error instanceof Error ? error.message : String(error) });
          console.error('fail', handle, error instanceof Error ? error.message : error);
          // recover dialog if needed
          try {
            if (!await active.page.locator('[role="dialog"]').filter({ hasText: '管理成员' }).first().isVisible()) {
              await openMembersDialog(active);
            }
          } catch {}
        }
      }
      const members = await readMembers(active);
      const all = ['@deepseek_ai', '@OpenAI', ...HANDLES];
      const present = new Set(members.map((h) => h.toLowerCase()));
      const payload = {
        ok: results.every((r) => r.ok),
        results,
        members,
        presentAfter: all.map((h) => ({ handle: h, present: present.has(h.toLowerCase()) })),
        finishedAt: new Date().toISOString()
      };
      await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
      console.log(JSON.stringify(payload, null, 2));
      if (!payload.ok) process.exitCode = 2;
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
