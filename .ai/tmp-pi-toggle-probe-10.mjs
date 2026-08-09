import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);

// collapse
const s = await page.evaluate(() => document.querySelector('.app-shell').className);
if (!s.includes('collapsed')) {
  await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
  await page.waitForTimeout(600);
}
const r = await page.evaluate(() => { const b = document.querySelector('.pi-dock-toggle'); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
console.log('collapsed toggle rect', JSON.stringify(r));

// Where exactly does today-main's scrollbar live? clientWidth vs offsetWidth and scrollbar rect
const sb = await page.evaluate(() => {
  const el = document.querySelector('.today-main');
  const cs = getComputedStyle(el);
  const cr = el.getBoundingClientRect();
  // webkit scrollbar is on the right: the area between clientLeft+clientWidth and offsetWidth
  const vertical = cs.overflowY;
  return { right: cr.right, cw: el.clientWidth, ow: el.offsetWidth, vertical, scrollbarFrom: cr.right - (el.offsetWidth - el.clientWidth) };
});

// instrument events, then click at x = toggle.x + 16 (1808, inside scrollbar region) with trace
await page.evaluate(() => {
  window.__evts = [];
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(t, (e) => {
      window.__evts.push({ t, x: Math.round(e.clientX), y: Math.round(e.clientY), target: `${e.target.tagName}.${String(e.target.className).slice(0, 30)}` });
    }, true);
  }
});
for (const off of [6, 12, 16, 17]) {
  await page.evaluate(() => { window.__evts = []; });
  const x = r.x + off;
  await page.mouse.click(x, r.y + r.h / 2);
  await page.waitForTimeout(400);
  const evts = await page.evaluate(() => window.__evts.slice());
  const st = await page.evaluate(() => document.querySelector('.app-shell').className);
  console.log(`click x+${off} (x=${x}):`, JSON.stringify(evts.map(e => e.t + '@' + e.target)), 'state:', st);
  // if it expanded, collapse again for next iteration
  if (!st.includes('collapsed')) {
    await page.evaluate(() => document.querySelector('.pi-dock-toggle').click());
    await page.waitForTimeout(400);
  }
}
console.log('scrollbar info', JSON.stringify(sb));
browser.close();
