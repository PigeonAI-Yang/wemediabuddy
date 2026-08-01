import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';
import { xListUrl } from '../src/main/platforms/x-list-primitives.ts';

const LIST_ID = '2082851520417255750';
const OUT = path.resolve('.ai/probe-click-edit-list.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };
  const session = await XListSession.open(config);
  try {
    const result = await session.run(async (active) => {
      await active.page.goto(xListUrl(LIST_ID), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await active.page.waitForTimeout(3500);
      await active.dismissBlockingOverlays();

      const findByText = async (re) => active.page.evaluate((pattern) => {
        const rx = new RegExp(pattern, 'i');
        const all = [...document.querySelectorAll('a,button,span,div,[role="button"],[role="link"]')];
        const hits = [];
        for (const el of all) {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          if (!text || text.length > 80) continue;
          if (!rx.test(text)) continue;
          const rect = el.getBoundingClientRect();
          if (!(rect.width && rect.height)) continue;
          hits.push({
            tag: el.tagName,
            text,
            href: el.getAttribute('href'),
            role: el.getAttribute('role'),
            testid: el.getAttribute('data-testid'),
            aria: el.getAttribute('aria-label'),
            x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)
          });
        }
        return hits.slice(0, 30);
      }, re);

      const editHits = await findByText('编辑列表|Edit List');
      const memberHits = await findByText('成员|Members');
      console.log('editHits', editHits);
      console.log('memberHits', memberHits);

      // click edit via text locator
      const editLoc = active.page.getByText('编辑列表', { exact: true }).first();
      const editVisible = await editLoc.isVisible().catch(() => false);
      console.log('edit exact visible', editVisible);
      if (editVisible) {
        await editLoc.click({ force: true });
        await active.page.waitForTimeout(2000);
      }
      const afterEdit = await active.page.evaluate(() => ({
        url: location.href,
        text: (document.querySelector('[data-testid="primaryColumn"]')?.innerText || document.body.innerText || '').slice(0, 1200),
        dialogs: [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].map((d) => (d.innerText || '').slice(0, 300)),
        inputs: [...document.querySelectorAll('input')].map((i) => ({
          testid: i.getAttribute('data-testid'),
          placeholder: i.getAttribute('placeholder'),
          aria: i.getAttribute('aria-label'),
          visible: !!(i.offsetWidth || i.offsetHeight)
        }))
      }));
      console.log('afterEdit', afterEdit.url, afterEdit.dialogs.length, afterEdit.inputs);

      // if manage members visible
      const manageLoc = active.page.getByText('管理成员', { exact: false }).first();
      const manageVisible = await manageLoc.isVisible().catch(() => false);
      console.log('manage visible', manageVisible);
      if (manageVisible) {
        await manageLoc.click({ force: true });
        await active.page.waitForTimeout(2000);
      }
      const afterManage = await active.page.evaluate(() => ({
        url: location.href,
        text: (document.querySelector('[data-testid="primaryColumn"]')?.innerText || document.body.innerText || '').slice(0, 1200),
        dialogs: [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].map((d) => (d.innerText || '').slice(0, 400)),
        userCells: [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 15).map((c) => (c.innerText || '').slice(0, 120)),
        inputs: [...document.querySelectorAll('input')].map((i) => ({
          testid: i.getAttribute('data-testid'),
          placeholder: i.getAttribute('placeholder'),
          aria: i.getAttribute('aria-label'),
          visible: !!(i.offsetWidth || i.offsetHeight)
        })),
        buttons: [...document.querySelectorAll('button,div[role="button"]')].map((b) => ({
          text: (b.innerText || '').trim().slice(0, 40),
          aria: b.getAttribute('aria-label')
        })).filter((b) => /添加|移除|Add|Remove|推荐|Suggested|成员|Members|搜索|Search/.test(`${b.text} ${b.aria || ''}`)).slice(0, 40)
      }));
      console.log('afterManage', JSON.stringify(afterManage, null, 2).slice(0, 4000));

      // try suggested tab
      const suggestedLoc = active.page.getByText(/已推荐|Suggested/).first();
      if (await suggestedLoc.isVisible().catch(() => false)) {
        await suggestedLoc.click({ force: true });
        await active.page.waitForTimeout(1500);
      }
      // try search and add Anthropic
      const search = active.page.locator('[role="dialog"] input, [aria-modal="true"] input, [data-testid="primaryColumn"] input[data-testid="SearchBox_Search_Input"]').first();
      let addResult = { searchVisible: await search.isVisible().catch(() => false) };
      if (addResult.searchVisible) {
        await search.click({ force: true });
        await active.page.keyboard.press('Control+A');
        await active.page.keyboard.type('AnthropicAI', { delay: 40 });
        await active.page.waitForTimeout(2500);
        const row = active.page.locator('[data-testid="UserCell"]:has-text("AnthropicAI"), [data-testid="UserCell"]:has(a[href="/AnthropicAI"])').first();
        addResult.rowVisible = await row.isVisible().catch(() => false);
        addResult.rowText = await row.innerText().catch(() => null);
        const addBtn = row.locator('button, div[role="button"]').filter({ hasText: /添加|Add/ }).first();
        addResult.addVisible = await addBtn.isVisible().catch(() => false);
        if (addResult.addVisible) {
          await addBtn.click({ force: true });
          await active.page.waitForTimeout(2000);
          addResult.clicked = true;
        }
        addResult.after = await active.page.evaluate(() => ({
          url: location.href,
          cells: [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 20).map((c) => (c.innerText || '').slice(0, 100))
        }));
      }
      console.log('addResult', addResult);
      return { editHits, memberHits, afterEdit, manageVisible, afterManage, addResult };
    }, { timeoutMs: 240_000 });
    await writeFile(OUT, JSON.stringify({ ok: true, result }, null, 2), 'utf8');
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
