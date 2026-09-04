import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1568, height: 941 } });
await page.goto('http://127.0.0.1:27391/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
// navigate to 今日 if needed - check current route
await page.evaluate(() => {
  // try to find today route - click sidebar Today
  const links = [...document.querySelectorAll('a, button')].map(e => ({t:e.textContent?.trim(), cls:e.className})).slice(0,80);
  console.log(JSON.stringify(links));
});
const html = await page.evaluate(() => document.documentElement.outerHTML.slice(0,15000));
console.log(html.slice(0,8000));
await page.screenshot({ path: 'j:/PigeonYang/WeMediaBuddy/tmp-today-1568.png', fullPage: true });
console.log('screenshot done');
await browser.close();
