
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
const date='2026-08-08';
const keys = await page.evaluate(() => Object.keys(window.wmb||{}).filter(k=>/manager|Manager|Daily|daily|Pi|Conversation/.test(k)));
console.log('KEYS', keys);
const mgr = await page.evaluate(async (date) => {
  try { return { ok:true, v: await window.wmb.getManagerTask({businessDate:date}) }; }
  catch(e){ return { ok:false, e:String(e) }; }
}, date);
console.log('MGR', JSON.stringify(mgr).slice(0,1500));
const r = await page.evaluate(async (date) => {
  try { return { ok:true, v: await window.wmb.startDailyIntelligence({businessDate:date}) }; }
  catch(e){ return { ok:false, e:String(e) }; }
}, date);
console.log('START', JSON.stringify(r).slice(0,1500));
const ui = await page.evaluate(() => {
  const t=document.body.innerText;
  const card = [...document.querySelectorAll('*')].map(el=>el.textContent||'').find(x=>x.includes('【主管任务】'));
  return {
    hasCard: t.includes('【主管任务】'),
    cardSnippet: (card||'').replace(/\s+/g,' ').slice(0,300),
    piOpen: !(document.querySelector('main')?.classList.contains('pi-collapsed'))
  };
});
console.log('UI', ui);
await browser.close().catch(()=>{});
