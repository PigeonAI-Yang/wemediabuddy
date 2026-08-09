import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);

const fs = await import('node:fs');
// force expanded via JS click
const s = await page.evaluate(() => document.querySelector('.app-shell').className);
if (s.includes('collapsed')) {
  await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
  await page.waitForTimeout(500);
}
console.log('state:', await page.evaluate(() => document.querySelector('.app-shell').className));

const dump = async () => page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return { opacity: cs.opacity, boxShadow: cs.boxShadow, filter: cs.filter, transform: cs.transform, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
});

// mouse away
await page.mouse.move(80, 200);
await page.waitForTimeout(300);
console.log('expanded away:', await dump());
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-exp-away.png', await page.screenshot({ type: 'png' }));

// hover the dock left edge where toggle hot zone is (toggle at left:0 of dock; dock left edge x)
const dockLeft = await page.evaluate(() => Math.round(document.querySelector('.pi-dock').getBoundingClientRect().x));
await page.mouse.move(dockLeft + 4, 607);
await page.waitForTimeout(300);
console.log('expanded hover:', await dump());
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-exp-hover.png', await page.screenshot({ type: 'png' }));

// Also capture right edge region crop: dock boundary
await page.mouse.move(80, 200);
await page.waitForTimeout(200);
const clip = { x: Math.max(0, dockLeft - 40), y: 0, width: Math.min(220, 1810 - dockLeft + 40), height: 1236 };
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-exp-boundary.png', await page.screenshot({ clip, type: 'png' }));
console.log('dockLeft', dockLeft);
browser.close();
