
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.startDailyIntelligence), null, {timeout:30000});
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button,a')].find(x=>/今日/.test(x.textContent||x.title||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,1000));
const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const start = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date }), date);
console.log('START', start?.ok, start?.data?.action, start?.data?.managerOwned);

for (let i=0;i<25;i++) {
  await new Promise(r=>setTimeout(r,1000));
  const snap = await page.evaluate(() => {
    const tools=[...document.querySelectorAll('details.pi-tool-line,.pi-tool-line')].map(n=>(n.textContent||'').replace(/\s+/g,' ').trim());
    return {
      readiness: tools.filter(t=>/wmb_daily_readiness|daily\.readiness|run_daily_stage|wmb_run_daily_stage/.test(t)).slice(0,6),
      spawn: tools.filter(t=>/wmb_spawn_job|wmb_list_/.test(t)).slice(0,4),
      textHasRule: /不会|静默|显式|stage=judge|wmb_run_daily_stage|readiness/.test(document.body.innerText)
    };
  });
  console.log('T'+i, JSON.stringify(snap));
  if (snap.readiness.length || (snap.spawn.length && i>5)) break;
}
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-owned-orch.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
