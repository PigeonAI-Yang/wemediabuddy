import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(400);

const info = await page.evaluate(() => {
  const b = document.querySelector('.pi-dock-toggle');
  const r = b.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  // elements from point at several x positions along the toggle's vertical center
  const pts = [r.x + 1, r.x + 4, r.x + 8, r.x + 12, r.x + 15, r.x + 17];
  const stack = pts.map((x) => ({
    x: Math.round(x),
    els: document.elementsFromPoint(x, r.y + r.height / 2).slice(0, 4).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}` + (el === b ? ' <<TOGGLE' : ''))
  }));
  const shell = document.querySelector('.app-shell');
  const ws = document.querySelector('.workspace');
  const wsRect = ws.getBoundingClientRect();
  return {
    vw, vh,
    toggleRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'),
    stack,
    wsRect: { x: Math.round(wsRect.x), right: Math.round(wsRect.right), w: Math.round(wsRect.width) },
    // is there any fixed/absolute overlay near right edge?
    overlays: [...document.querySelectorAll('body *')].filter((el) => {
      const cs = getComputedStyle(el);
      const er = el.getBoundingClientRect();
      return (cs.position === 'fixed' || cs.position === 'absolute') && er.left >= vw - 60 && er.right <= vw + 1 && er.height > 40 && cs.pointerEvents !== 'none';
    }).slice(0, 8).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} [${cs => cs.position}(l:${Math.round(el.getBoundingClientRect().left)})]`),
  };
});
console.log(JSON.stringify(info, null, 1));

// Try programmatic click to see if the React handler works at all
const afterJs = await page.evaluate(() => {
  const before = document.querySelector('.app-shell').className;
  document.querySelector('.pi-dock-toggle').click();
  return { before };
});
await page.waitForTimeout(400);
console.log('after js click:', await page.evaluate(() => document.querySelector('.app-shell').className));

// Try keyboard activation (focus + Enter)
await page.evaluate(() => document.querySelector('.pi-dock-toggle').focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
console.log('after Enter:', await page.evaluate(() => document.querySelector('.app-shell').className));
browser.close();
