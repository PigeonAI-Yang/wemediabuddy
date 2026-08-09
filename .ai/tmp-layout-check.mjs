
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const context=browser.contexts()[0];
let page=context.pages()[0];
for (const p of context.pages()) {
  const ok=await p.evaluate(()=>/今日|方案/.test(document.body?.innerText||'')).catch(()=>false);
  if(ok){page=p;break;}
}
await page.bringToFront();
await page.reload({waitUntil:'domcontentloaded'});
await new Promise(r=>setTimeout(r,2000));
await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));b?.click();});
await new Promise(r=>setTimeout(r,1000));
const m=await page.evaluate(()=>{
  const rail=document.querySelector('.today-rail');
  const main=document.querySelector('.today-main');
  const primary=document.querySelector('.opportunity-primary');
  const opp=document.querySelector('.today-opps .opp-list');
  const rr=rail.getBoundingClientRect();
  const mr=main.getBoundingClientRect();
  return {
    vh: window.innerHeight,
    mainBottom: Math.round(mr.bottom),
    rail: {h:Math.round(rr.height), top:Math.round(rr.top), bottom:Math.round(rr.bottom), pos:getComputedStyle(rail).position},
    primaryH: Math.round(primary.getBoundingClientRect().height),
    oppListH: Math.round(opp.getBoundingClientRect().height),
    oppMin: getComputedStyle(opp).minHeight,
    railInsideMain: rr.bottom <= mr.bottom + 1,
    mainCanScroll: main.scrollHeight > main.clientHeight + 4,
  };
});
console.log(JSON.stringify(m,null,2));
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-today-layout-check.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
