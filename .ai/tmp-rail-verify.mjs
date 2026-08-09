
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('今日'));
  b?.click();
});
await page.waitForTimeout(500);
const dump = async (label) => page.evaluate((label) => {
  const rail = document.querySelector('.pi-dock-toggle-rail');
  const btn = document.querySelector('.pi-dock-toggle');
  const shell = document.querySelector('.app-shell');
  if (!btn || !rail) return {label, error:'missing', shell:shell?.className, rail:!!rail, btn:!!btn};
  const cs = getComputedStyle(btn);
  const rr = rail.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const cx = br.x + br.width/2, cy = br.y + br.height/2;
  let hit=null;
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    const el = document.elementFromPoint(cx, cy);
    hit = el ? `${el.tagName}.${String(el.className).slice(0,80)}` : null;
  }
  return {
    label,
    shell: shell?.className,
    dock: document.querySelector('.pi-dock')?.className,
    railClass: rail.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    transform: cs.transform,
    pointerEvents: cs.pointerEvents,
    bg: cs.backgroundColor,
    rail: {x:rr.x,y:rr.y,w:rr.width,h:rr.height,right:rr.right},
    btn: {x:br.x,y:br.y,w:br.width,h:br.height,right:br.right},
    hit,
  };
}, label);

const force = async () => page.evaluate(() => {
  const btn=document.querySelector('.pi-dock-toggle');
  const key=Object.keys(btn||{}).find(k=>k.startsWith('__reactProps$'));
  if(key) btn[key].onClick?.({preventDefault(){},stopPropagation(){},detail:1,currentTarget:btn,target:btn});
  else btn?.click();
});

let s=await dump('start');
if((s.shell||'').includes('pi-collapsed')) { await force(); await page.waitForTimeout(500); }

await page.mouse.move(100,120); await page.waitForTimeout(200);
const expAway = await dump('expanded-away');
// hover rail center
const rail = expAway.rail;
await page.mouse.move(rail.x + Math.max(2, rail.w/2), rail.y + rail.h/2);
await page.waitForTimeout(250);
const expHover = await dump('expanded-hover');
// click via real mouse on button after hover
const b = expHover.btn;
await page.mouse.move(b.x + b.w/2, b.y + b.h/2);
await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
await page.waitForTimeout(500);
const collapsed = await dump('collapsed');
await page.mouse.move(200,200); await page.waitForTimeout(200);
const colAway = await dump('collapsed-away');
// hover right edge rail
const vw = await page.evaluate(()=>({w:innerWidth,h:innerHeight}));
await page.mouse.move(vw.w-3, Math.floor(vw.h/2));
await page.waitForTimeout(250);
const colHover = await dump('collapsed-hover');
// click expand
const cb = colHover.btn;
await page.mouse.move(cb.x + Math.max(2,cb.w/2), cb.y + cb.h/2);
await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
await page.waitForTimeout(500);
const reopened = await dump('reopened');

// screenshot right edge strip full height small width
const fs = await import('node:fs');
const clip = { x: Math.max(0, vw.w-40), y: 80, width: 40, height: 400 };
await page.mouse.move(100,120); await page.waitForTimeout(120);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-edge-away.png', await page.screenshot({clip, type:'png'}));
await page.mouse.move(vw.w-3, Math.floor(vw.h/2)); await page.waitForTimeout(150);
// if expanded, hover left rail of dock instead
if (!(reopened.shell||'').includes('pi-collapsed')) {
  const r2 = reopened.rail;
  await page.mouse.move(r2.x+2, r2.y + r2.h/2);
  await page.waitForTimeout(150);
  const clip2 = { x: Math.max(0, r2.x-10), y: 500, width: 50, height: 160 };
  fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-rail-hover.png', await page.screenshot({clip:clip2, type:'png'}));
}
console.log(JSON.stringify({expAway, expHover, collapsed, colAway, colHover, reopened}, null, 2));
await browser.close().catch(()=>{});
