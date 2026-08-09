import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(800);
const fs = await import('node:fs');

const st = () => page.evaluate(() => document.querySelector('.app-shell').className);
const toggleRect = () => page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

// ---- Test 1: collapsed -> real mouse click expands ----
// force collapsed first
let s = await st();
if (!s.includes('collapsed')) { await page.evaluate(() => document.querySelector('.pi-dock-toggle').click()); await page.waitForTimeout(500); }
s = await st();
console.log('T1 start state:', s);

await page.mouse.move(60, 120);
await page.waitForTimeout(300);
const r1 = await toggleRect();
console.log('T1 collapsed toggle rect:', JSON.stringify(r1));

// instrument
await page.evaluate(() => {
  window.__evts = [];
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(t, (e) => { window.__evts.push({ t, x: Math.round(e.clientX), y: Math.round(e.clientY), target: `${e.target.tagName}.${String(e.target.className).slice(0, 25)}` }); }, true);
  }
});

// real mouse click at toggle center
await page.mouse.click(r1.x + 9, r1.y + r1.h / 2);
await page.waitForTimeout(600);
s = await st();
const evts1 = await page.evaluate(() => window.__evts.slice());
console.log('T1 click events:', JSON.stringify(evts1));
console.log('T1 after real click ->', s, '  <<< EXPECT pi-open');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-1-after-click.png', await page.screenshot({ type: 'png' }));

// ---- Test 2: expanded, mouse away -> toggle hidden ----
await page.mouse.move(80, 200);
await page.waitForTimeout(400);
const expAway = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); return { opacity: getComputedStyle(b).opacity, rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() }; });
console.log('T2 expanded away:', JSON.stringify(expAway), ' <<< EXPECT opacity 0');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-2-exp-away.png', await page.screenshot({ type: 'png' }));

// ---- Test 3: expanded, hover toggle -> shows ----
const r2 = expAway.rect;
await page.mouse.move(r2.x + 9, r2.y + r2.h / 2);
await page.waitForTimeout(400);
const expHover = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const cs = getComputedStyle(b); return { opacity: cs.opacity, background: cs.backgroundColor, boxShadow: cs.boxShadow, filter: cs.filter, hover: b.matches(':hover') }; });
console.log('T3 expanded hover:', JSON.stringify(expHover), ' <<< EXPECT opacity 1, boxShadow none, filter none');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/verify-3-exp-hover.png', await page.screenshot({ type: 'png' }));

// ---- Test 4: expanded -> real mouse click collapses ----
await page.evaluate(() => { window.__evts = []; });
await page.mouse.click(r2.x + 9, r2.y + r2.h / 2);
await page.waitForTimeout(600);
s = await st();
const evts4 = await page.evaluate(() => window.__evts.slice());
console.log('T4 click events:', JSON.stringify(evts4));
console.log('T4 after real click ->', s, ' <<< EXPECT pi-collapsed');

// ---- Test 5: collapsed, click near right edge (scrollbar zone) ----
const r5 = await toggleRect();
await page.evaluate(() => { window.__evts = []; });
await page.mouse.click(r5.x + r5.w - 2, r5.y + r5.h / 2); // x+16 of 18 = over scrollbar area
await page.waitForTimeout(600);
s = await st();
const evts5 = await page.evaluate(() => window.__evts.slice());
console.log('T5 edge click events:', JSON.stringify(evts5));
console.log('T5 after right-edge click ->', s, ' <<< EXPECT pi-open');

// ---- Test 6: expanded after click: toggle hidden (no stuck focus-visible) ----
await page.mouse.move(80, 200);
await page.waitForTimeout(500);
const stuck = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); return { opacity: getComputedStyle(b).opacity, focusVisible: b.matches(':focus-visible') }; });
console.log('T6 expanded away after click:', JSON.stringify(stuck), ' <<< EXPECT opacity 0');

browser.close();
