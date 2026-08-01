import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser, revealXBrowserWindow } from '../src/main/browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';
import { xListUrl } from '../src/main/platforms/x-list-primitives.ts';

const LIST_ID = '2082851520417255750';
const OUT = path.resolve('.ai/probe-list-controls.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  await revealXBrowserWindow(runtime.cdpUrl).catch(() => {});
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };
  const session = await XListSession.open(config);
  try {
    const result = await session.run(async (active) => {
      // hard reload list
      await active.page.goto(xListUrl(LIST_ID), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await active.page.waitForTimeout(4000);
      await active.dismissBlockingOverlays();
      // scroll top of primary column
      await active.page.mouse.wheel(0, -2000);
      await active.page.waitForTimeout(1000);

      const dumpControls = async (label) => active.page.evaluate((label) => {
        const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const items = [...document.querySelectorAll('a,button,[role="button"],[role="link"],[data-testid]')].map((el) => {
          const rect = el.getBoundingClientRect?.();
          return {
            tag: el.tagName,
            text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 100),
            href: el.getAttribute('href'),
            role: el.getAttribute('role'),
            testid: el.getAttribute('data-testid'),
            aria: el.getAttribute('aria-label'),
            visible: isVisible(el),
            x: rect ? Math.round(rect.x) : null,
            y: rect ? Math.round(rect.y) : null,
            w: rect ? Math.round(rect.width) : null,
            h: rect ? Math.round(rect.height) : null
          };
        }).filter((x) => x.visible && (x.text || x.aria || x.testid || x.href));
        return {
          label,
          url: location.href,
          title: document.title,
          count: items.length,
          items: items.slice(0, 200),
          primaryHtml: (document.querySelector('[data-testid="primaryColumn"]')?.innerText || '').slice(0, 1500)
        };
      }, label);

      const initial = await dumpControls('initial');

      // click every more/caret in primary column top area
      const moreButtons = active.page.locator('[data-testid="primaryColumn"] button[aria-label="More"], [data-testid="primaryColumn"] button[aria-label="更多"], [data-testid="primaryColumn"] button[data-testid="caret"], button[aria-label="More"], button[aria-label="更多"]');
      const moreCount = await moreButtons.count();
      const moreClicks = [];
      for (let i = 0; i < Math.min(moreCount, 5); i += 1) {
        const btn = moreButtons.nth(i);
        const box = await btn.boundingBox().catch(() => null);
        if (!box || box.y > 400) continue;
        await active.click(btn, { force: true }).catch(async () => btn.click({ force: true }));
        await active.page.waitForTimeout(800);
        const menu = await active.page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="menu"] a, [role="menu"] button, [data-testid="Dropdown"] *')].map((el) => ({
          text: (el.innerText || '').trim().slice(0, 80),
          href: el.getAttribute('href'),
          testid: el.getAttribute('data-testid'),
          aria: el.getAttribute('aria-label')
        })).filter((x) => x.text || x.href || x.aria).slice(0, 40));
        moreClicks.push({ i, box, menu });
        // if menu has edit, click it
        const editItem = active.page.locator('[role="menuitem"]:has-text("Edit"), [role="menuitem"]:has-text("编辑"), a:has-text("Edit List"), a:has-text("编辑列表")').first();
        if (await editItem.isVisible().catch(() => false)) {
          await active.click(editItem, { force: true });
          await active.page.waitForTimeout(1500);
          moreClicks.push({ clickedEdit: true, after: await dumpControls('after_edit_menu') });
          break;
        }
        await active.page.keyboard.press('Escape').catch(() => {});
      }

      // members pin under list header?
      const membersLink = active.page.locator('a[href*="/members"], a:has-text("位成员"), a:has-text("members"), a:has-text("成员")').first();
      const membersLinkVisible = await membersLink.isVisible().catch(() => false);
      let afterMembersLink = null;
      if (membersLinkVisible) {
        const href = await membersLink.getAttribute('href');
        const text = await membersLink.innerText().catch(() => '');
        await active.click(membersLink, { force: true });
        await active.page.waitForTimeout(2000);
        afterMembersLink = { href, text, ...(await dumpControls('after_members_link')) };
      }

      return { initial, moreCount, moreClicks, membersLinkVisible, afterMembersLink };
    }, { timeoutMs: 180_000 });

    await writeFile(OUT, JSON.stringify({ ok: true, result }, null, 2), 'utf8');
    // print condensed
    console.log('url', result.initial.url, 'title', result.initial.title);
    console.log('primaryText\n', result.initial.primaryHtml.slice(0, 800));
    console.log('top controls:');
    for (const item of result.initial.items.filter((i) => (i.y ?? 9999) < 250).slice(0, 40)) {
      console.log('-', item.tag, item.testid || '', item.aria || '', item.text || '', item.href || '', `@${item.x},${item.y}`);
    }
    console.log('moreCount', result.moreCount, 'moreClicks', JSON.stringify(result.moreClicks, null, 2).slice(0, 3000));
    console.log('membersLinkVisible', result.membersLinkVisible);
    if (result.afterMembersLink) console.log('afterMembers', result.afterMembersLink.url, result.afterMembersLink.primaryHtml?.slice(0, 400));
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
