import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';
import { xListUrl } from '../src/main/platforms/x-list-primitives.ts';

const LIST_ID = '2082851520417255750';
const OUT = path.resolve('.ai/probe-session-members.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };
  const session = await XListSession.open(config);
  const steps = [];
  try {
    await session.run(async (active) => {
      for (const target of [
        xListUrl(LIST_ID),
        `${xListUrl(LIST_ID)}/members`,
        `${xListUrl(LIST_ID)}/members/suggested`,
        `${xListUrl(LIST_ID)}/info`
      ]) {
        await active.navigateInitially(target, { mode: 'browse' });
        await active.dismissBlockingOverlays();
        const snap = await active.page.evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 400);
          return {
            url: location.href,
            title: document.title,
            hasAccount: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'),
            userCells: document.querySelectorAll('[data-testid="UserCell"]').length,
            dialogs: document.querySelectorAll('[role="dialog"]').length,
            masks: document.querySelectorAll('[data-testid="mask"]').length,
            searchInputs: [...document.querySelectorAll('input')].map((i) => ({
              testid: i.getAttribute('data-testid'),
              placeholder: i.getAttribute('placeholder'),
              aria: i.getAttribute('aria-label'),
              visible: !!(i.offsetWidth || i.offsetHeight)
            })).filter((i) => i.visible).slice(0, 12),
            buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter((t) => /添加|移除|Add|Remove|管理|编辑|成员/.test(t)).slice(0, 20),
            textSample: text
          };
        });
        steps.push({ target, ...snap });
        console.log(target, '=>', snap.url, 'cells', snap.userCells, 'dialogs', snap.dialogs, 'masks', snap.masks);
      }

      // Try add Anthropic on suggested
      await active.navigateWithinOperation(`${xListUrl(LIST_ID)}/members/suggested`, { mode: 'browse' });
      await active.dismissBlockingOverlays();
      const search = active.page.locator('[role="dialog"] input[data-testid="SearchBox_Search_Input"], [aria-modal="true"] input[data-testid="SearchBox_Search_Input"], [data-testid="primaryColumn"] input[data-testid="SearchBox_Search_Input"]').first();
      const searchVisible = await search.isVisible().catch(() => false);
      let addStep = { searchVisible };
      if (searchVisible) {
        await active.typeInto(search, 'AnthropicAI');
        await active.page.keyboard.press('Enter').catch(() => {});
        await active.page.waitForTimeout(2500);
        const profile = active.page.locator('[data-testid="UserCell"] a[href="/AnthropicAI"], a[href="/AnthropicAI"]').first();
        addStep.profileVisible = await profile.isVisible().catch(() => false);
        const row = active.page.locator('[data-testid="UserCell"]:has(a[href="/AnthropicAI"])').first();
        const action = row.locator('button:has-text("添加"), button:has-text("Add"), button[aria-label*="添加"], button[aria-label*="Add"]').first();
        addStep.actionVisible = await action.isVisible().catch(() => false);
        addStep.actionText = await action.innerText().catch(() => null);
        addStep.actionAria = await action.getAttribute('aria-label').catch(() => null);
        if (addStep.actionVisible) {
          await active.click(action, { force: true });
          await active.page.waitForTimeout(2000);
          addStep.clicked = true;
        }
        addStep.after = await active.page.evaluate(() => ({
          url: location.href,
          cells: [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 10).map((c) => (c.innerText || '').slice(0, 100))
        }));
      }
      steps.push({ target: 'add_anthropic', ...addStep });
      console.log('add_anthropic', addStep);
    }, { timeoutMs: 240_000 });
  } finally {
    await session.close();
  }
  await writeFile(OUT, JSON.stringify({ ok: true, steps }, null, 2), 'utf8');
  console.log('wrote', OUT);
} catch (error) {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error?.stack };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
