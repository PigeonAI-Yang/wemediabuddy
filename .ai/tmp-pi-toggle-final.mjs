import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(500);
const fs = await import('node:fs');

const st = () => page.evaluate(() => document.querySelector('.app-shell').className);
const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark');

// capture current theme, then force dark for screenshots
const origTheme = await theme();
if (origTheme !== 'dark') {
  await page.evaluate(() => { document.querySelector('.status-theme')?.click(); });
  await page.waitForTimeout(500);
}
console.log('theme now:', await theme());

// collapsed dark shot
let s = await st();
if (!s.includes('collapsed')) { await page.evaluate(() => document.querySelector('.pi-dock-toggle').click()); await page.waitForTimeout(500); }
await page.mouse.move(60, 120);
await page.waitForTimeout(400);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-dark-collapsed.png', await page.screenshot({ type: 'png' }));

// expanded hover dark shot
await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
await page.waitForTimeout(500);
const r = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
await page.mouse.move(r.x + 9, r.y + r.h / 2);
await page.waitForTimeout(400);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-dark-exp-hover.png', await page.screenshot({ type: 'png' }));

// keyboard a11y: Tab to toggle while expanded, mouse away -> should be visible via focus-visible
await page.mouse.move(60, 120);
await page.waitForTimeout(400);
await page.evaluate(() => { document.querySelector('.pi-dock-toggle').focus(); });
const kb = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); return { opacity: getComputedStyle(b).opacity, focusVisible: b.matches(':focus-visible') }; });
console.log('keyboard focus (expanded, mouse away):', JSON.stringify(kb), ' <<< EXPECT opacity 1');
// keyboard Enter to collapse (detail 0 -> no blur)
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
console.log('after keyboard Enter ->', await st(), ' <<< EXPECT pi-collapsed');

// resize handle drag regression (expanded): drag handle 40px left -> width changes
await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
await page.waitForTimeout(500);
const dockLeftBefore = await page.evaluate(() => Math.round(document.querySelector('.pi-dock').getBoundingClientRect().x));
await page.mouse.move(dockLeftBefore - 1, 500);
await page.mouse.down();
await page.mouse.move(dockLeftBefore - 41, 500, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(400);
const dockLeftAfter = await page.evaluate(() => Math.round(document.querySelector('.pi-dock').getBoundingClientRect().x));
console.log('resize handle: dockLeft', dockLeftBefore, '->', dockLeftAfter, ' <<< EXPECT shifted left (dock widened)');

// restore original theme
if (origTheme !== 'dark') {
  await page.evaluate(() => { document.querySelector('.status-theme')?.click(); });
  await page.waitForTimeout(400);
}
console.log('theme restored:', await theme());
browser.close();
