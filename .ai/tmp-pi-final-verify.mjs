
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('今日'));
  b?.click();
});
await page.waitForTimeout(500);

const dump = async (label) => page.evaluate((label) => {
  const btn = document.querySelector('.pi-dock-toggle');
  const shell = document.querySelector('.app-shell');
  if (!btn) return { label, error: 'no btn' };
  const cs = getComputedStyle(btn);
  const r = btn.getBoundingClientRect();
  // hit-test center
  const el = document.elementFromPoint(r.x + r.w/2, r.y + r.h/2);
  return {
    label,
    shell: shell?.className,
    dock: document.querySelector('.pi-dock')?.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    filter: cs.filter,
    transform: cs.transform,
    z: cs.zIndex,
    rect: { x:r.x, y:r.y, w:r.width, h:r.height, right:r.right },
    hit: el ? `${el.tagName}.${el.className}` : null,
  };
}, label);

const forceToggle = async () => page.evaluate(() => {
  const btn = document.querySelector('.pi-dock-toggle');
  const key = Object.keys(btn||{}).find(k => k.startsWith('__reactProps$'));
  if (key && btn[key].onClick) {
    btn[key].onClick({ preventDefault(){}, stopPropagation(){}, detail: 1, currentTarget: btn });
    return 'react';
  }
  btn?.click();
  return 'dom';
});

// ensure expanded
let s = await dump('start');
if ((s.shell||'').includes('pi-collapsed')) { await forceToggle(); await page.waitForTimeout(500); }

await page.mouse.move(100, 120);
await page.waitForTimeout(200);
const expAway = await dump('expanded-away');
let r = expAway.rect;
await page.mouse.move(r.x + r.w/2, r.y + r.h/2);
await page.waitForTimeout(200);
const expHover = await dump('expanded-hover');

// real mouse click to collapse
await page.mouse.down();
await page.waitForTimeout(30);
await page.mouse.up();
await page.waitForTimeout(500);
const collapsed = await dump('collapsed');

// move away then hover right edge
await page.mouse.move(200, 200);
await page.waitForTimeout(200);
const colAway = await dump('collapsed-away');
r = colAway.rect;
// hover near window right edge
const vw = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
await page.mouse.move(vw.w - 4, Math.floor(vw.h/2));
await page.waitForTimeout(250);
const colHoverEdge = await dump('collapsed-hover-edge');
await page.mouse.move(r.x + r.w/2, r.y + r.h/2);
await page.waitForTimeout(200);
const colHoverBtn = await dump('collapsed-hover-btn');

// real click expand from right edge
await page.mouse.move(vw.w - 4, Math.floor(vw.h/2));
await page.waitForTimeout(120);
await page.mouse.move(r.x + Math.max(2, r.w/2), r.y + r.h/2);
await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
await page.waitForTimeout(500);
const reopened = await dump('reopened');

const fs = await import('node:fs');
// screenshots
await page.mouse.move(100,120); await page.waitForTimeout(120);
const clip = { x: Math.max(0, (expAway.rect?.x||0)-30), y: 520, width: 100, height: 180 };
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-fix-exp-away.png', await page.screenshot({ clip, type:'png'}));
await page.mouse.move(expAway.rect.x+9, expAway.rect.y+20); await page.waitForTimeout(120);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-fix-exp-hover.png', await page.screenshot({ clip, type:'png'}));

console.log(JSON.stringify({ expAway, expHover, collapsed, colAway, colHoverEdge, colHoverBtn, reopened, vw }, null, 2));
await browser.close().catch(()=>{});
