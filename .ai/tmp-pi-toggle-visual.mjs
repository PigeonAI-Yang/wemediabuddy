import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(600);
const fs = await import('node:fs');
const s = await page.evaluate(() => document.querySelector('.app-shell').className);
// collapsed screenshot
if (!s.includes('collapsed')) { await page.evaluate(() => document.querySelector('.pi-dock-toggle').click()); await page.waitForTimeout(500); }
await page.mouse.move(60, 120);
await page.waitForTimeout(400);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-collapsed.png', await page.screenshot({ type: 'png' }));
// also crop the right edge
const r = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-collapsed-crop.png', await page.screenshot({ clip: { x: r.x - 40, y: 0, width: 80, height: 1236 }, type: 'png' }));
// scroll today-main to force scrollbar visible, screenshot for overlap check
await page.evaluate(() => { const el = document.querySelector('.today-main'); if (el) el.scrollTop = el.scrollHeight; });
await page.mouse.move(r.x - 20, 300);
await page.waitForTimeout(300);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-collapsed-scrollbar.png', await page.screenshot({ type: 'png' }));
console.log('done', JSON.stringify(r));
browser.close();
