import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);

// Ensure collapsed
const cur = await page.evaluate(() => document.querySelector('.app-shell').className);
if (!cur.includes('collapsed')) {
  await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
  await page.waitForTimeout(300);
}

// Instrument: capture events at document level with coordinates
await page.evaluate(() => {
  window.__evts = [];
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(t, (e) => {
      window.__evts.push({ t, x: Math.round(e.clientX), y: Math.round(e.clientY), target: `${e.target.tagName}.${String(e.target.className).slice(0, 30)}`, path: e.composedPath().slice(0, 4).map((n) => n.tagName || 'doc').join('>') });
    }, true);
  }
});

const r = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
console.log('toggle rect', JSON.stringify(r));

// Real mouse click at x+5 (away from scrollbar)
await page.mouse.click(r.x + 5, r.y + r.h / 2);
await page.waitForTimeout(300);
let evts = await page.evaluate(() => window.__evts.slice());
console.log('click x+5 events:', JSON.stringify(evts));
console.log('state after:', await page.evaluate(() => document.querySelector('.app-shell').className));

// Try again at x+2
await page.evaluate(() => { window.__evts = []; });
await page.mouse.click(r.x + 2, r.y + r.h / 2);
await page.waitForTimeout(300);
evts = await page.evaluate(() => window.__evts.slice());
console.log('click x+2 events:', JSON.stringify(evts));
console.log('state after:', await page.evaluate(() => document.querySelector('.app-shell').className));

// Try clicking somewhere on the left side of the window to sanity-check mouse works
await page.evaluate(() => { window.__evts = []; });
await page.mouse.click(400, 300);
await page.waitForTimeout(300);
evts = await page.evaluate(() => window.__evts.slice());
console.log('click (400,300) events:', JSON.stringify(evts.slice(0, 4)));

browser.close();
