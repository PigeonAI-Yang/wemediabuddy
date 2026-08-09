
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const context=browser.contexts()[0];
let page=context.pages()[0];
for (const p of context.pages()) {
  const ok=await p.evaluate(()=>/今日|DeepSeek/.test(document.body?.innerText||'')).catch(()=>false);
  if(ok){page=p;break;}
}
await page.bringToFront();
await page.reload({waitUntil:'domcontentloaded'});
await new Promise(r=>setTimeout(r,2200));
await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));b?.click();});
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(()=>document.querySelector('.today-main')?.scrollTo({top:0}));
const m=await page.evaluate(()=>{
  const b=el=>{const r=el.getBoundingClientRect();return {h:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom)};};
  const primary=document.querySelector('.opportunity-primary');
  const rows=[...document.querySelectorAll('.today-opps .opp-list .opp-row')];
  const opps=document.querySelector('.today-opps');
  const rail=document.querySelector('.today-rail');
  const list=document.querySelector('.today-opps .opp-list');
  const feed=document.querySelector('.feed-list');
  const last=rows[rows.length-1];
  return {
    primary:{h:b(primary).h, min:getComputedStyle(primary).minHeight},
    rows:rows.map(r=>({h:Math.round(r.getBoundingClientRect().height),min:getComputedStyle(r).minHeight})),
    allRowsOk:rows.every(r=>r.getBoundingClientRect().height>=109.5),
    list:{h:b(list).h, ov:getComputedStyle(list).overflowY, min:getComputedStyle(list).minHeight},
    opps:b(opps),
    rail:b(rail),
    feed:b(feed),
    bottomDiff:b(opps).bottom-b(rail).bottom,
    lastToRailBottom: last ? b(rail).bottom-b(last).bottom : null,
    sane: b(opps).h<2500 && b(rail).h<2500,
    mainScrollH: document.querySelector('.today-main').scrollHeight,
  };
});
console.log(JSON.stringify(m,null,2));
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-today-card-minh.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
