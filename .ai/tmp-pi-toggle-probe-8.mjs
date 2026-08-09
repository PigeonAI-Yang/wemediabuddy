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
const out = await page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const r = b.getBoundingClientRect();
  const pts = [
    ['btn-2', r.x - 2, r.y + 22], ['btn+2', r.x + 2, r.y + 22], ['btn+9', r.x + 9, r.y + 22], ['btn+16', r.x + 16, r.y + 22], ['btn+20', r.x + 20, r.y + 22],
    ['btn+9y+10', r.x + 9, r.y + 10], ['btn+9y-10', r.x + 9, r.y - 10],
  ];
  const rows = pts.map(([name, x, y]) => {
    const els = document.elementsFromPoint(x, y).slice(0, 5).map((el) => `${el.tagName}.${String(el.className).slice(0, 46)}`);
    const hoverOnBtn = b.matches(':hover');
    return { name, x: Math.round(x), y: Math.round(y), hoverOnBtn, els };
  });
  // z-index of dock children
  const kids = [...document.querySelector('.pi-dock').children].map((c) => {
    const cs = getComputedStyle(c);
    return { cls: String(c.className).slice(0, 40), pos: cs.position, z: cs.zIndex, pe: cs.pointerEvents };
  });
  return { btnRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, rows, kids };
});
console.log(JSON.stringify(out, null, 1));
browser.close();
