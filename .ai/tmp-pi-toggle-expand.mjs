
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
// click today
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=> (x.textContent||'').trim()==='今日');
  b?.click();
});
await page.waitForTimeout(500);
// if collapsed, click toggle to expand
const collapsed = await page.evaluate(() => document.querySelector('.app-shell')?.classList.contains('pi-collapsed'));
if (collapsed) {
  await page.click('.pi-dock-toggle');
  await page.waitForTimeout(600);
}
// move away
await page.mouse.move(200, 300);
await page.waitForTimeout(250);
const dump = async (label) => page.evaluate((label) => {
  const btn=document.querySelector('.pi-dock-toggle');
  const shell=document.querySelector('.app-shell');
  const dock=document.querySelector('.pi-dock');
  const cs=getComputedStyle(btn);
  const r=btn.getBoundingClientRect();
  // sample pixels around button for "shadow"
  return {
    label,
    shell: shell?.className,
    dock: dock?.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    filter: cs.filter,
    background: cs.backgroundColor,
    borderTop: cs.borderTop,
    borderRight: cs.borderRight,
    borderBottom: cs.borderBottom,
    borderLeft: cs.borderLeft,
    rect: {x:r.x,y:r.y,w:r.width,h:r.height, right:r.right, left:r.left},
  };
}, label);
const away = await dump('away-expanded');
const r = away.rect;
// hover toggle
await page.mouse.move(r.x + r.w/2, r.y + r.h/2);
await page.waitForTimeout(200);
const hover = await dump('hover-expanded');
// screenshot region around toggle
const clip = {
  x: Math.max(0, r.x - 50),
  y: Math.max(0, r.y - 80),
  width: 160,
  height: 200
};
const fs = await import('node:fs');
await page.mouse.move(200,300);
await page.waitForTimeout(150);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-toggle-expanded-away.png', await page.screenshot({clip, type:'png'}));
await page.mouse.move(r.x + r.w/2, r.y + r.h/2);
await page.waitForTimeout(150);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-toggle-expanded-hover.png', await page.screenshot({clip, type:'png'}));
console.log(JSON.stringify({away, hover, clip}, null, 2));
await browser.close().catch(()=>{});
