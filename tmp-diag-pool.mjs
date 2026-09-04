import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DEBUG_PORT = 9337;
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
  const t = await window.wmb.getToday(planDate);
  return {
    planDate,
    poolKeys: t.pool.length? Object.keys(t.pool[0]) : [],
    poolSample: t.pool[0] ? JSON.stringify(t.pool[0]).slice(0,2000) : null,
    planItemsKeys: t.plan?.items.length? Object.keys(t.plan.items[0]) : [],
    planSample: t.plan?.items[0] ? JSON.stringify(t.plan.items[0]).slice(0,2000) : null,
    poolCount: t.pool.length,
    planCount: t.plan?.items.length,
  };
});
console.log(JSON.stringify(result,null,2));
await browser.close();
console.log('done');
