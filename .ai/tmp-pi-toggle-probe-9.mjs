import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);
const s = await page.evaluate(() => document.querySelector('.app-shell').className);
if (s.includes('collapsed')) {
  await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
  await page.waitForTimeout(600);
}
// ensure mouse away first, wait for fade
await page.mouse.move(60, 100);
await page.waitForTimeout(500);

const btn = await page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const r = b.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log('btn rect', JSON.stringify(btn));

// sweep x across the region, at button center y
const y = btn.y + btn.h / 2;
const rows = [];
for (let x = btn.x - 30; x <= btn.x + 40; x += 5) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  const st = await page.evaluate(() => {
    const b = document.querySelector('.pi-dock-toggle');
    return { hover: b.matches(':hover'), opacity: getComputedStyle(b).opacity, top: document.elementFromPoint(b.getBoundingClientRect().x + 9, b.getBoundingClientRect().y + 22)?.className?.toString?.().slice(0, 30) ?? null };
  });
  rows.push({ x, ...st });
}
console.log(JSON.stringify(rows, null, 1));
browser.close();
