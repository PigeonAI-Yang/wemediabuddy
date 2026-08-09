
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
await page.waitForTimeout(400);

const dump = async (label) => page.evaluate((label) => {
  const btn = document.querySelector('.pi-dock-toggle');
  const shell = document.querySelector('.app-shell');
  if (!btn) return { label, error: 'no btn', shell: shell?.className };
  const cs = getComputedStyle(btn);
  const r = btn.getBoundingClientRect();
  let hit = null;
  if (Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0) {
    const el = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    hit = el ? `${el.tagName}.${String(el.className).slice(0,80)}` : null;
  }
  return {
    label,
    shell: shell?.className,
    dock: document.querySelector('.pi-dock')?.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    filter: cs.filter,
    transform: cs.transform,
    z: cs.zIndex,
    display: cs.display,
    visibility: cs.visibility,
    rect: { x:r.x, y:r.y, w:r.width, h:r.height, right:r.right, left:r.left },
    hit,
  };
}, label);

const forceToggle = async () => page.evaluate(() => {
  const btn = document.querySelector('.pi-dock-toggle');
  const key = Object.keys(btn||{}).find(k => k.startsWith('__reactProps$'));
  if (key && btn[key].onClick) {
    btn[key].onClick({ preventDefault(){}, stopPropagation(){}, detail: 1, currentTarget: btn, target: btn });
    return 'react';
  }
  btn?.click();
  return 'dom';
});

let s0 = await dump('start');
if ((s0.shell||'').includes('pi-collapsed')) { await forceToggle(); await page.waitForTimeout(500); }
// expanded away
await page.mouse.move(80, 100); await page.waitForTimeout(200);
const expAway = await dump('expanded-away');
// expanded hover btn
const er = expAway.rect;
if (er && er.w > 0) {
  await page.mouse.move(er.x + er.w/2, er.y + er.h/2);
  await page.waitForTimeout(200);
}
const expHover = await dump('expanded-hover');
// click collapse via react (reliable)
await forceToggle(); await page.waitForTimeout(500);
const collapsed = await dump('collapsed');
await page.mouse.move(100,100); await page.waitForTimeout(200);
const colAway = await dump('collapsed-away');
const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
await page.mouse.move(vw.w - 3, Math.floor(vw.h/2));
await page.waitForTimeout(250);
const colEdge = await dump('collapsed-edge-hover');
// real mouse click on button center if valid
const cr = colEdge.rect;
let clickHit = null;
if (cr && Number.isFinite(cr.x) && cr.w > 0) {
  // first hover edge then click button
  await page.mouse.move(vw.w - 3, Math.floor(vw.h/2));
  await page.waitForTimeout(100);
  await page.mouse.move(cr.x + cr.w/2, cr.y + cr.h/2);
  await page.waitForTimeout(100);
  clickHit = await page.evaluate(({x,y}) => {
    const el = document.elementFromPoint(x,y);
    return el ? `${el.tagName}.${String(el.className).slice(0,100)}` : null;
  }, {x: cr.x + cr.w/2, y: cr.y + cr.h/2});
  await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await page.waitForTimeout(500);
}
const afterClick = await dump('after-real-click');
// if still collapsed try react
if ((afterClick.shell||'').includes('pi-collapsed')) {
  await forceToggle(); await page.waitForTimeout(400);
}
const final = await dump('final');
console.log(JSON.stringify({ s0, expAway, expHover, collapsed, colAway, colEdge, clickHit, afterClick, final, vw }, null, 2));
await browser.close().catch(()=>{});
