
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(1500);
const dump = async (label) => page.evaluate((label) => {
  const btn=document.querySelector('.pi-dock-toggle');
  const shell=document.querySelector('.app-shell');
  const dock=document.querySelector('.pi-dock');
  if(!btn) return {label,error:'no btn'};
  const cs=getComputedStyle(btn);
  const r=btn.getBoundingClientRect();
  return {
    label,
    shell: shell?.className,
    dock: dock?.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    filter: cs.filter,
    transform: cs.transform,
    bg: cs.backgroundColor,
    z: cs.zIndex,
    rect: {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right},
  };
}, label);
let state = await dump('initial');
// ensure expanded
if ((state.shell||'').includes('pi-collapsed')) {
  await page.evaluate(() => {
    const btn=document.querySelector('.pi-dock-toggle');
    const key=Object.keys(btn||{}).find(k=>k.startsWith('__reactProps$'));
    if (key) btn[key].onClick?.({preventDefault(){}, stopPropagation(){}});
    else btn?.click();
  });
  await page.waitForTimeout(500);
}
await page.mouse.move(80,80);
await page.waitForTimeout(200);
const away = await dump('expanded-away');
const r = away.rect || {x:0,y:0,w:18,h:44};
await page.mouse.move(r.x + r.w/2, r.y + r.h/2);
await page.waitForTimeout(200);
const hover = await dump('expanded-hover');
// real mouse click collapse
await page.mouse.click(r.x + r.w/2, r.y + r.h/2);
await page.waitForTimeout(500);
const afterClick = await dump('after-click');
// if collapsed, try click near right edge (scrollbar zone)
if ((afterClick.shell||'').includes('pi-collapsed')) {
  const rr = afterClick.rect;
  // click center of toggle
  await page.mouse.click(rr.x + rr.w/2, rr.y + rr.h/2, {delay: 30});
  await page.waitForTimeout(500);
}
const final = await dump('final');
const fs = await import('node:fs');
await page.mouse.move(80,80); await page.waitForTimeout(120);
// screenshot right strip
const vw = await page.viewportSize();
const clip = { x: Math.max(0, (away.rect?.x||1400)-40), y: 500, width: 120, height: 200 };
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-toggle-verify.png', await page.screenshot({type:'png'}));
console.log(JSON.stringify({away, hover, afterClick, final}, null, 2));
await browser.close().catch(()=>{});
