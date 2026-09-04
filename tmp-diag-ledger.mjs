import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DEBUG_PORT = 9338;
const child = spawn(INSTALLED_EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached: true, stdio: 'ignore', cwd: 'J:/PigeonYang/WeMediaBuddy' });
child.unref();
console.log('spawned', child.pid);
await new Promise(r=> setTimeout(r,8000));
let browser;
for(let i=0;i<15;i++){
  try{ browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`); console.log('connected'); break;} catch(e){ console.log('retry',i); await new Promise(r=>setTimeout(r,1000));}
}
let ctx=browser.contexts()[0];
let page=ctx.pages()[0];
for(let i=0;i<10 && !page;i++){ await new Promise(r=>setTimeout(r,1000)); ctx=browser.contexts()[0]; page=ctx.pages()[0];}
console.log('url',page.url());
await page.waitForTimeout(3000);
const result = await page.evaluate(async () => {
  const planDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  // Try different proposal ledger APIs
  // @ts-ignore
  try {
    const summary = await window.wmb.getProposalLedgerSummary(planDate);
    const ledgerToday = await window.wmb.getProposalLedger({ planDate, tab: 'today', limit: 50, offset: 0 });
    const ledgerPending = await window.wmb.getProposalLedger({ planDate, tab: 'scoring_pending', limit: 50, offset: 0 });
    return { summary, ledgerToday: {total: ledgerToday.total, items: ledgerToday.items.map(i=> ({id:i.planItemId.slice(0,8), s:i.planningStatus, score: i.scoreReasonsJson?.slice(0,200)}))}, ledgerPending: {total: ledgerPending.total, counts: ledgerPending.counts, items: ledgerPending.items.map(i=> ({id:i.planItemId.slice(0,8), s:i.planningStatus, score:i.scoreReasonsJson?.slice(0,200), buttons: []}))} };
  } catch(e){ return {error: String(e)}; }
});
console.log(JSON.stringify(result,null,2));
await browser.close();
console.log('done');
