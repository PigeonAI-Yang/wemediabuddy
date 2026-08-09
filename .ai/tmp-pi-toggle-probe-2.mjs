import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(800);

const dump = async (label) => page.evaluate((label) => {
  const btn = document.querySelector('.pi-dock-toggle');
  const dock = document.querySelector('.pi-dock');
  const shell = document.querySelector('.app-shell');
  if (!btn) return { label, error: 'no btn', shell: shell?.className };
  const cs = getComputedStyle(btn);
  const r = btn.getBoundingClientRect();
  // find which element is at the toggle's left-center point (hit test)
  const x = r.x + 2, y = r.y + r.height / 2;
  const el = document.elementFromPoint(x, y);
  // also check what's under the right part of the toggle
  const elR = document.elementFromPoint(r.x + r.width - 3, y);
  // find the nearest scrollable ancestor of the workspace that owns a scrollbar at the right edge
  return {
    label,
    shell: shell?.className,
    dock: dock?.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    filter: cs.filter,
    transform: cs.transform,
    pointerEvents: cs.pointerEvents,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    hitLeft: el ? `${el.tagName}.${el.className}`.slice(0, 60) : null,
    hitRight: elR ? `${elR.tagName}.${elR.className}`.slice(0, 60) : null,
  };
}, label);

// Move mouse far away first
await page.mouse.move(60, 120);
await page.waitForTimeout(300);
const away = await dump('away');
console.log('AWAY', JSON.stringify(away, null, 1));

// screenshot full window
const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/probe-current-away.png', await page.screenshot({ type: 'png' }));

// Find scroll containers at the right edge: elements with scrollWidth > clientWidth inside workspace
const scrollers = await page.evaluate(() => {
  const ws = document.querySelector('.workspace');
  const out = [];
  if (!ws) return out;
  const walk = (el) => {
    for (const c of el.children) {
      if (c.scrollHeight > c.clientHeight || c.scrollWidth > c.clientWidth) {
        const cs = getComputedStyle(c);
        out.push({ cls: c.className?.toString().slice(0, 50), sw: c.scrollWidth, cw: c.clientWidth, sh: c.scrollHeight, ch: c.clientHeight, ox: cs.overflowX, oy: cs.overflowY, right: Math.round(c.getBoundingClientRect().right) });
      }
      walk(c);
    }
  };
  walk(ws);
  return out.slice(0, 20);
});
console.log('SCROLLERS', JSON.stringify(scrollers, null, 1));
browser.close();
