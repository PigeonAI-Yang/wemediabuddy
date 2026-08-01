
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const pages = context?.pages() || [];
const out = {
  pageCount: pages.length,
  pages: pages.map((p) => ({ url: p.url(), title: '' }))
};
for (const [i, page] of pages.entries()) {
  out.pages[i].title = await page.title().catch(() => '');
  if (/x\.com/i.test(page.url())) {
    out.active = {
      url: page.url(),
      title: out.pages[i].title,
      articles: await page.locator('main article').count().catch(() => -1),
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 350).replace(/\n+/g, ' | ')
    };
  }
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
