
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
const start = await page.evaluate(async (date) => {
  try { return await window.wmb.startDailyIntelligence({ businessDate: date }); }
  catch(e){ return { ok:false, error:String(e) }; }
}, date);
console.log('START', JSON.stringify({ok:start?.ok, action:start?.data?.action, managerOwned:start?.data?.managerOwned, mgr:start?.data?.managerTask?.id, err:start?.error||start?.data?.error}).slice(0,400));

for (let i=0;i<20;i++) {
  await new Promise(r=>setTimeout(r,1000));
  const snap = await page.evaluate(() => {
    const tools=[...document.querySelectorAll('details.pi-tool-line, .pi-tool-line')].map(n=>(n.textContent||'').replace(/\s+/g,' ').trim());
    const text=document.body.innerText;
    return {
      mode: document.querySelector('.today-command')?.getAttribute('data-mode'),
      tools: tools.filter(t=>/wmb_|spawn|job|roster|subagent|reporter|planner|scan/.test(t)).slice(0,10),
      toolCount: tools.length,
      hasFake: tools.some(t=>/wmb_run_daily_child|source:manager|mgr_/.test(t)),
      hasUser: /请执行今日情报编排/.test(text),
      hasAuthBlock: /AUTHORITY_BLOCKED|unknown_page/.test(text),
      stopBtn: !!document.querySelector('.pi-stop-button'),
      assistant: (text.match(/Pi 进程|正在|已派|记者|策划|工具/)||[])[0] || null
    };
  });
  console.log('T'+i, JSON.stringify(snap));
  if (snap.tools.length>0 || snap.hasAuthBlock) break;
}
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-real-manager-pi.png', await page.screenshot({fullPage:false}));
const conv=await page.evaluate(async()=>window.wmb.getPiConversation());
const last=(conv.messages||[]).slice(-4).map(m=>({role:m.role,status:m.status,text:(m.text||'').slice(0,100),segs:(m.segments||[]).map(s=>s.kind+':'+(s.toolName||'')).slice(0,8)}));
console.log('CONV', JSON.stringify(last,null,2));
await browser.close().catch(()=>{});
