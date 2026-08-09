
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = context.pages()[0];
for (const p of context.pages()) {
  const ok = await p.evaluate(() => /今日|方案/.test(document.body?.innerText || '')).catch(() => false);
  if (ok) { page = p; break; }
}
await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 1800));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /今日/.test(x.title || x.textContent || ''));
  b?.click();
});
await new Promise(r => setTimeout(r, 800));
const before = await page.evaluate(() => {
  const el = document.querySelector('.today-command');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { pos: cs.position, top: cs.top, z: cs.zIndex, y: Math.round(r.top) };
});
await page.evaluate(() => document.querySelector('.today-main')?.scrollTo({ top: 420 }));
await new Promise(r => setTimeout(r, 200));
const after = await page.evaluate(() => {
  const el = document.querySelector('.today-command');
  const r = el.getBoundingClientRect();
  return { y: Math.round(r.top), visible: r.bottom > 56 && r.top < window.innerHeight };
});
console.log(JSON.stringify({ before, after, scrolledAway: after.y < 0 || after.y < 56 }, null, 2));
await browser.close().catch(() => {});
