import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);
const fs = await import('node:fs');

const s = await page.evaluate(() => document.querySelector('.app-shell').className);
if (s.includes('collapsed')) {
  await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
  await page.waitForTimeout(600);
}
console.log('state now:', await page.evaluate(() => document.querySelector('.app-shell').className));

const dump = () => page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return { opacity: cs.opacity, transform: cs.transform, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
});

await page.mouse.move(80, 200);
await page.waitForTimeout(400);
console.log('away:', JSON.stringify(await dump()));
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-exp-away2.png', await page.screenshot({ type: 'png' }));

const d = await dump();
await page.mouse.move(d.rect.x + 9, d.rect.y + 22);
await page.waitForTimeout(400);
console.log('hover:', JSON.stringify(await dump()));
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-exp-hover2.png', await page.screenshot({ type: 'png' }));

// hover right at the dock boundary x = dockLeft-2 (just outside dock, over main column edge)
const dl = await page.evaluate(() => Math.round(document.querySelector('.pi-dock').getBoundingClientRect().x));
await page.mouse.move(dl - 2, d.rect.y + 22);
await page.waitForTimeout(400);
console.log('hover boundary:', JSON.stringify(await dump()));

// scroll today-main to bottom to show scrollbar, hover over it
await page.evaluate(() => { const el = document.querySelector('.today-main'); if (el) el.scrollTop = el.scrollHeight; });
await page.mouse.move(dl - 8, 400);
await page.waitForTimeout(300);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-scrollbar.png', await page.screenshot({ type: 'png' }));
console.log('done dl=', dl);
browser.close();
