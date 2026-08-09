
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(800);
// ensure expanded and mouse away so toggle hidden
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('今日'));
  b?.click();
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const shell=document.querySelector('.app-shell');
  if (shell?.classList.contains('pi-collapsed')) {
    const btn=document.querySelector('.pi-dock-toggle');
    const key=Object.keys(btn||{}).find(k=>k.startsWith('__reactProps$'));
    btn?.[key]?.onClick?.({preventDefault(){},stopPropagation(){},detail:1,currentTarget:btn,target:btn});
  }
});
await page.waitForTimeout(500);
await page.mouse.move(200,200);
await page.waitForTimeout(200);

const geo = await page.evaluate(() => {
  const w = window.innerWidth, h = window.innerHeight;
  const dock = document.querySelector('.pi-dock');
  const shell = document.querySelector('.app-shell');
  const workspace = document.querySelector('.workspace');
  const main = document.querySelector('.today-main, .workspace > section, main');
  const rail = document.querySelector('.pi-dock-toggle-rail');
  const btn = document.querySelector('.pi-dock-toggle');
  const pick = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, cls: el.className,
      rect: {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,left:r.left},
      bg: cs.backgroundColor,
      boxShadow: cs.boxShadow,
      borderLeft: cs.borderLeft,
      borderRight: cs.borderRight,
      filter: cs.filter,
      outline: cs.outline,
      z: cs.zIndex,
      overflow: cs.overflow,
    };
  };
  // sample elementFromPoint across last 30px of width at mid height
  const hits = [];
  const y = Math.floor(h/2);
  for (let dx = 0; dx < 40; dx++) {
    const x = w - 1 - dx;
    const el = document.elementFromPoint(x, y);
    hits.push({
      x, y, dx,
      tag: el?.tagName || null,
      cls: String(el?.className||'').slice(0,80),
      bg: el ? getComputedStyle(el).backgroundColor : null,
      shadow: el ? getComputedStyle(el).boxShadow : null,
    });
  }
  return {
    viewport: {w,h},
    shell: pick(shell),
    workspace: pick(workspace),
    dock: pick(dock),
    rail: pick(rail),
    btn: pick(btn),
    body: pick(document.body),
    html: pick(document.documentElement),
    hits,
  };
});

// full window screenshot + right strip
const full = await page.screenshot({type:'png', fullPage:false});
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-shadow-full.png', full);
const w = geo.viewport.w, h = geo.viewport.h;
const stripW = 80;
const clip = { x: Math.max(0, w - stripW), y: 0, width: stripW, height: h };
const strip = await page.screenshot({type:'png', clip});
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-shadow-strip.png', strip);
// also mid band
const mid = await page.screenshot({type:'png', clip: { x: Math.max(0,w-stripW), y: Math.floor(h*0.35), width: stripW, height: 220 }});
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-shadow-mid.png', mid);

fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-shadow-geo.json', JSON.stringify(geo, null, 2));
console.log(JSON.stringify({
  viewport: geo.viewport,
  dock: geo.dock,
  rail: geo.rail,
  btn: geo.btn,
  shell: geo.shell && {bg: geo.shell.bg, shadow: geo.shell.boxShadow, borderRight: geo.shell.borderRight},
  body: geo.body && {bg: geo.body.bg, shadow: geo.body.boxShadow},
  html: geo.html && {bg: geo.html.bg, shadow: geo.html.boxShadow},
  hits: geo.hits.slice(0, 25),
}, null, 2));
await browser.close().catch(()=>{});
