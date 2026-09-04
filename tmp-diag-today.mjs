import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DEBUG_PORT = 9336;
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
const today = await page.evaluate(async () => {
  const planDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  // @ts-ignore
  const t = await window.wmb.getToday(planDate);
  return { planDate, t: {
    plan: t.plan ? {id:t.plan.id, items: t.plan.items.map(i=> ({id:i.id.slice(0,8), s:i.planningStatus, score: i.scoreReasonsJson?.slice(0,200)}))} : null,
    pool: t.pool.map(p=> ({id:p.planItemId.slice(0,8), date:p.planDate, title:p.title.slice(0,30)})),
    sameDayTasks: t.sameDayTasks.map(x=> ({id:x.id?.slice(0,8), status:x.status, phase:x.phase})),
    exhaustion: t.exhaustion,
    sourcesTotal: t.sourcesTotal,
  }};
});
console.log(JSON.stringify(today,null,2));
const win = await page.evaluate(() => {
  return {
    body: document.body.innerText.slice(0,4000),
    hasScoring: document.body.innerText.includes('本轮评分未完成'),
    buttons: Array.from(document.querySelectorAll('button')).map(b=> (b.textContent||'').trim()).filter(t=>t).slice(0,20)
  };
});
console.log('win', JSON.stringify(win,null,2));
await browser.close();
console.log('close');
// keep app running?
try{ const {execSync}=await import('node:child_process'); execSync('tasklist /fi "imagename eq WeMediaBuddy.exe" | findstr WeMediaBuddy', {encoding:'utf8'}); }catch(e){ console.log(e.message); }
