
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
// reload renderer to pick hmr
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.wmb?.startDailyIntelligence), null, { timeout: 30000 });
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,1200));
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const r1 = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date }), date);
console.log('R1', r1?.ok, r1?.data?.action, r1?.data?.managerTask?.checkpoint?.summary);

for (let i=0;i<15;i++) {
  await page.evaluate(async (date) => { try { await window.wmb.syncManagerTask({businessDate:date}); } catch{} }, date);
  await new Promise(r=>setTimeout(r,800));
  const snap = await page.evaluate(() => {
    const tools=[...document.querySelectorAll('details.pi-tool-line, .pi-tool-line')].map(n=>(n.textContent||'').replace(/\s+/g,' ').trim());
    return {
      n: tools.length,
      tools: tools.filter(t=>/wmb_run_daily_child|subagent|reporter|planner|daily_child|记者|策划/.test(t)).slice(0,10),
      all: tools.slice(0,8),
      hasUser: /请执行今日情报编排/.test(document.body.innerText),
      bar: /主管编排中/.test(document.body.innerText)
    };
  });
  console.log('T'+i, JSON.stringify(snap));
  if (snap.tools.length>0) break;
}
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-native-tools.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
