
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(1500);
const force = async () => page.evaluate(() => {
  const btn=document.querySelector('.pi-dock-toggle');
  const key=Object.keys(btn||{}).find(k=>k.startsWith('__reactProps$'));
  if(key) btn[key].onClick?.({preventDefault(){},stopPropagation(){},detail:1,currentTarget:btn,target:btn});
});
const size = async (label) => page.evaluate((label) => {
  const btn=document.querySelector('.pi-dock-toggle');
  const rail=document.querySelector('.pi-dock-toggle-rail');
  const cs=getComputedStyle(btn);
  const r=btn.getBoundingClientRect();
  // force visible to measure paint box
  return {
    label,
    shell: document.querySelector('.app-shell')?.className,
    w: r.width, h: r.height,
    cssW: cs.width, cssH: cs.height,
    minW: cs.minWidth, minH: cs.minHeight,
    maxW: cs.maxWidth, maxH: cs.maxHeight,
    borderRadius: cs.borderRadius,
    railW: rail ? getComputedStyle(rail).width : null,
  };
}, label);
// ensure expanded
let s=await size('a');
if((s.shell||'').includes('pi-collapsed')) { await force(); await page.waitForTimeout(400); }
const exp = await size('expanded');
await force(); await page.waitForTimeout(400);
const col = await size('collapsed');
console.log(JSON.stringify({exp,col, same: exp.w===col.w && exp.h===col.h && exp.cssW===col.cssW && exp.cssH===col.cssH}, null, 2));
await browser.close().catch(()=>{});
