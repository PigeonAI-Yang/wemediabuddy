
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
if (!context) throw new Error('no context');
let page = context.pages().find((p) => /x\.com/i.test(p.url())) || context.pages()[0] || await context.newPage();
const ids = ['2082851520417255750', '2082851456571588923'];
const out = { currentUrl: page.url(), pages: context.pages().map((p) => p.url()) };
for (const id of ids) {
  const url = `https://x.com/i/lists/${id}`;
  const item = { id, url };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    item.finalUrl = page.url();
    item.title = await page.title();
    const articles = page.locator('main article');
    item.articleCount = await articles.count();
    const sample = [];
    for (let i = 0; i < Math.min(item.articleCount, 3); i += 1) {
      const t = await articles.nth(i).locator('[data-testid="tweetText"]').first().innerText().catch(() => '');
      const href = await articles.nth(i).locator('a[href*="/status/"]').first().getAttribute('href').catch(() => null);
      sample.push({ href, text: (t || '').slice(0, 100) });
    }
    item.sample = sample;
    item.bodySnippet = (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | ');
  } catch (error) {
    item.error = String(error?.message || error);
  }
  out[id] = item;
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
