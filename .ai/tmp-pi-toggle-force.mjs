
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(800);
// hard reload styles
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=> (x.textContent||'').includes('今日'));
  b?.click();
});
await page.waitForTimeout(500);
// force expand via class/toggle handler
await page.evaluate(() => {
  const btn = document.querySelector('.pi-dock-toggle');
  btn?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
});
await page.waitForTimeout(700);
const state = await page.evaluate(() => ({
  shell: document.querySelector('.app-shell')?.className,
  dock: document.querySelector('.pi-dock')?.className,
}));
// if still collapsed, try localStorage/state API if any - click with force coordinates on right edge
if ((state.shell||'').includes('pi-collapsed')) {
  const r = await page.evaluate(() => {
    const b=document.querySelector('.pi-dock-toggle');
    const rect=b.getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2, w:rect.width,h:rect.height, left:rect.left, right:rect.right};
  });
  // use CDP input to click above intercepting elements? force via evaluate calling React props hard:
  await page.evaluate(() => {
    // find toggle button and call onClick via React fiber
    const btn=document.querySelector('.pi-dock-toggle');
    const key=Object.keys(btn).find(k=>k.startsWith('__reactProps$')||k.startsWith('__reactFiber$'));
    if (!key) return 'no fiber';
    if (key.startsWith('__reactProps$')) { btn[key].onClick?.({preventDefault(){},stopPropagation(){}}); return 'props'; }
    // fiber
    let fiber=btn[key];
    for (let i=0;i<20 && fiber;i++) {
      if (fiber.memoizedProps?.onClick) { fiber.memoizedProps.onClick({preventDefault(){},stopPropagation(){}}); return 'fiber'; }
      fiber=fiber.return;
    }
    return 'fail';
  });
  await page.waitForTimeout(700);
}
const dump = async (label) => page.evaluate((label) => {
  const btn=document.querySelector('.pi-dock-toggle');
  const shell=document.querySelector('.app-shell');
  const cs=getComputedStyle(btn);
  const r=btn.getBoundingClientRect();
  return {label, shell:shell?.className, dock:document.querySelector('.pi-dock')?.className, opacity:cs.opacity, boxShadow:cs.boxShadow, filter:cs.filter, bg:cs.backgroundColor, z:cs.zIndex, rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
}, label);
await page.mouse.move(100,100);
await page.waitForTimeout(200);
const away=await dump('away');
const r=away.rect;
await page.mouse.move(r.x+r.w/2, r.y+r.h/2);
await page.waitForTimeout(200);
const hover=await dump('hover');
const fs=await import('node:fs');
const clip={x:Math.max(0,r.x-60), y:Math.max(0,r.y-80), width:180, height:220};
await page.mouse.move(100,100); await page.waitForTimeout(150);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-toggle-exp-away.png', await page.screenshot({clip,type:'png'}));
await page.mouse.move(r.x+r.w/2,r.y+r.h/2); await page.waitForTimeout(150);
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-toggle-exp-hover.png', await page.screenshot({clip,type:'png'}));
console.log(JSON.stringify({away,hover},null,2));
await browser.close().catch(()=>{});
