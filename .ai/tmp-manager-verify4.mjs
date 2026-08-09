
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages()[0];
const r=await page.evaluate(async()=>await window.wmb.startDailyIntelligence({businessDate:'2026-08-08'}));
console.log(JSON.stringify({
  action:r?.data?.action,
  focus:r?.data?.focusDialog,
  reused:r?.data?.reused,
  mgr:r?.data?.managerTask?.id,
  mgrStatus:r?.data?.managerTask?.checkpoint?.status,
  mgrSummary:r?.data?.managerTask?.checkpoint?.summary,
  child:r?.data?.task?.id,
  childIntent:r?.data?.task?.intent,
  childPhase:r?.data?.task?.phase
},null,2));
// find manager card text in DOM more carefully
const card = await page.evaluate(() => {
  const nodes=[...document.querySelectorAll('div,p,article,li,section')];
  const hit=nodes.map(n=>n.innerText||'').filter(t=>t.includes('【主管任务】') && t.includes('今日情报'));
  return hit.sort((a,b)=>a.length-b.length)[0]?.slice(0,400) || null;
});
console.log('CARD', card);
await browser.close().catch(()=>{});
