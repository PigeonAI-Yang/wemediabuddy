import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);

const state = () => page.evaluate(() => ({
  shell: document.querySelector('.app-shell')?.className,
  dock: document.querySelector('.pi-dock')?.className,
}));

// Ensure collapsed start
const s0 = await state();
console.log('start', s0);

// Screenshot current (collapsed) right edge
const fs = await import('node:fs');
await page.mouse.move(50, 100);
await page.waitForTimeout(200);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-collapsed.png', await page.screenshot({ type: 'png' }));

// Test click at toggle LEFT portion (x = rect.x + 3) — should expand
const r = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.click(r.x + 3, r.y + r.h / 2);
await page.waitForTimeout(500);
console.log('after click LEFT', await state());

// If still collapsed, try RIGHT portion (under scrollbar)
if ((await state()).dock.includes('collapsed')) {
  await page.mouse.click(r.x + r.w - 3, r.y + r.h / 2);
  await page.waitForTimeout(500);
  console.log('after click RIGHT', await state());
}

// Now expanded: screenshot away + hover
await page.mouse.move(60, 150);
await page.waitForTimeout(300);
const away = await page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return { opacity: cs.opacity, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
});
console.log('expanded away', away);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-expanded-away.png', await page.screenshot({ type: 'png' }));

// Hover over the toggle hot zone (dock left edge, toggle rect)
await page.mouse.move(away.rect.x + 4, away.rect.y + away.rect.h / 2);
await page.waitForTimeout(300);
const hover = await page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const cs = getComputedStyle(b);
  return { opacity: cs.opacity, background: cs.backgroundColor };
});
console.log('expanded hover', hover);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-expanded-hover.png', await page.screenshot({ type: 'png' }));

browser.close();
