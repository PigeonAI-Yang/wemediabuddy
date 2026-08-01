import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';
import { xListUrl } from '../src/main/platforms/x-list-primitives.ts';

const LIST_ID = '2082851520417255750';
const OUT = path.resolve('.ai/probe-manage-members-sheet.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };
  const session = await XListSession.open(config);
  try {
    const result = await session.run(async (active) => {
      await active.navigateInitially(xListUrl(LIST_ID), { mode: 'browse' });
      await active.dismissBlockingOverlays();
      const before = await dump(active.page, 'list_home');

      const edit = active.page.locator(`a[href="/i/lists/${LIST_ID}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`).first();
      const editVisible = await edit.isVisible().catch(() => false);
      if (editVisible) await active.click(edit, { force: true });
      const afterEdit = await dump(active.page, 'after_edit');

      const manage = active.page.locator(`a:has-text("管理成员"), a:has-text("Manage members"), button:has-text("管理成员"), button:has-text("Manage members"), a[href*="/members"]`).first();
      const manageVisible = await manage.isVisible().catch(() => false);
      const manageText = manageVisible ? await manage.innerText().catch(() => null) : null;
      const manageHref = manageVisible ? await manage.getAttribute('href').catch(() => null) : null;
      if (manageVisible) await active.click(manage, { force: true });
      await active.page.waitForTimeout(2000);
      const afterManage = await dump(active.page, 'after_manage');

      // try click suggested tab texts
      const tabCandidates = await active.page.evaluate(() => {
        return [...document.querySelectorAll('a,button,[role="tab"],[role="link"]')].map((el) => ({
          tag: el.tagName,
          text: (el.innerText || '').trim().slice(0, 80),
          href: el.getAttribute('href'),
          role: el.getAttribute('role'),
          testid: el.getAttribute('data-testid')
        })).filter((x) => /成员|推荐|Suggested|Members|Search|搜索|添加|Add|Remove|移除|Manage|管理|Edit|编辑/.test(`${x.text} ${x.href || ''}`)).slice(0, 60);
      });

      // click any suggested-like control
      const suggested = active.page.locator('a:has-text("已推荐"), a:has-text("Suggested"), button:has-text("已推荐"), button:has-text("Suggested"), [role="tab"]:has-text("Suggested"), [role="tab"]:has-text("已推荐")').first();
      const suggestedVisible = await suggested.isVisible().catch(() => false);
      if (suggestedVisible) {
        await active.click(suggested, { force: true });
        await active.page.waitForTimeout(1500);
      }
      const afterSuggested = await dump(active.page, 'after_suggested');

      // dump all inputs including hidden
      const allInputs = await active.page.evaluate(() => [...document.querySelectorAll('input,textarea')].map((i) => ({
        tag: i.tagName,
        type: i.getAttribute('type'),
        testid: i.getAttribute('data-testid'),
        placeholder: i.getAttribute('placeholder'),
        aria: i.getAttribute('aria-label'),
        role: i.getAttribute('role'),
        visible: !!(i.offsetWidth || i.offsetHeight || i.getClientRects().length),
        disabled: !!i.disabled,
        rect: i.getBoundingClientRect ? { x: Math.round(i.getBoundingClientRect().x), y: Math.round(i.getBoundingClientRect().y), w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height) } : null
      })));

      // Try searching on members page if any search exists
      const search = active.page.locator('input').filter({ hasNot: active.page.locator('[type="checkbox"], [type="radio"], [type="hidden"]') });
      const searchCount = await search.count();
      let searchTry = { searchCount };
      for (let i = 0; i < searchCount; i += 1) {
        const input = search.nth(i);
        const visible = await input.isVisible().catch(() => false);
        const meta = {
          i,
          visible,
          testid: await input.getAttribute('data-testid'),
          placeholder: await input.getAttribute('placeholder'),
          aria: await input.getAttribute('aria-label')
        };
        if (!visible) { searchTry[`input_${i}`] = meta; continue; }
        try {
          await active.typeInto(input, 'AnthropicAI');
          await active.page.waitForTimeout(2000);
          const afterType = await active.page.evaluate(() => ({
            url: location.href,
            cells: [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 12).map((c) => (c.innerText || '').slice(0, 120)),
            addButtons: [...document.querySelectorAll('button,div[role="button"]')].map((b) => ({
              text: (b.innerText || '').trim().slice(0, 40),
              aria: b.getAttribute('aria-label')
            })).filter((b) => /添加|Add|移除|Remove/.test(`${b.text} ${b.aria || ''}`)).slice(0, 20)
          }));
          searchTry[`input_${i}`] = { ...meta, afterType };
          break;
        } catch (error) {
          searchTry[`input_${i}`] = { ...meta, error: String(error?.message || error) };
        }
      }

      return { before, editVisible, afterEdit, manageVisible, manageText, manageHref, afterManage, tabCandidates, suggestedVisible, afterSuggested, allInputs, searchTry };
    }, { timeoutMs: 240_000 });
    await writeFile(OUT, JSON.stringify({ ok: true, result }, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2).slice(0, 8000));
  } finally {
    await session.close();
  }
} catch (error) {
  const payload = { ok: false, error: String(error?.message || error), stack: error?.stack };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}

async function dump(page, label) {
  return page.evaluate((label) => {
    const textOf = (el) => (el?.innerText || '').trim().slice(0, 300);
    return {
      label,
      url: location.href,
      title: document.title,
      h1: textOf(document.querySelector('h1,h2')),
      userCells: document.querySelectorAll('[data-testid="UserCell"]').length,
      dialogs: [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].map((d) => ({
        text: textOf(d).slice(0, 200),
        inputs: d.querySelectorAll('input').length,
        buttons: [...d.querySelectorAll('button')].map((b) => textOf(b).slice(0, 40)).filter(Boolean).slice(0, 15)
      })),
      bodySample: textOf(document.body).slice(0, 400)
    };
  }, label);
}
