
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.startDailyIntelligence), null, {timeout:30000});
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button,a')].find(x=>/今日/.test(x.textContent||x.title||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,1200));
const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const start = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date }), date);
console.log('START', JSON.stringify({ok:start?.ok, action:start?.data?.action, managerOwned:start?.data?.managerOwned}).slice(0,200));

let hit=false;
for (let i=0;i<30;i++) {
  await new Promise(r=>setTimeout(r,1000));
  const snap = await page.evaluate(() => {
    const tools=[...document.querySelectorAll('details.pi-tool-line, .pi-tool-line')].map(n=>(n.textContent||'').replace(/\s+/g,' ').trim());
    const fresh = tools.filter(t=>/wmb_spawn_job|wmb_list_jobs|wmb_list_agents|jobs\.spawn|spawn_job/.test(t));
    const text=document.body.innerText;
    const lastAssist=[...document.querySelectorAll('.pi-message, .pi-bubble, [class*=\"assistant\"]')].slice(-1)[0]?.textContent||'';
    return {
      mode: document.querySelector('.today-command')?.getAttribute('data-mode'),
      fresh,
      toolN: tools.length,
      hasOrder: /请执行今日情报编排/.test(text),
      interrupted: /生成被中断/.test(text) && !/请执行今日情报编排[\s\S]{0,200}生成被中断/.test(text) ? false : /生成被中断/.test(text),
      stopBtn: !!document.querySelector('.pi-stop-button'),
      streaming: !!document.querySelector('[data-status=\"streaming\"], .pi-message.streaming, .status-streaming')
    };
  });
  console.log('T'+i, JSON.stringify(snap));
  if (snap.fresh.length || (snap.stopBtn && snap.hasOrder && i>2)) { hit=true; if(snap.fresh.length) break; }
}
const conv=await page.evaluate(async()=>window.wmb.getPiConversation());
const last=(conv.messages||[]).slice(-3).map(m=>({role:m.role,status:m.status,text:(m.text||'').slice(0,120),tools:(m.segments||[]).filter(s=>s.kind==='tool').map(s=>s.toolName)}));
console.log('CONV', JSON.stringify(last,null,2));
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-real-manager-pi.png', await page.screenshot({fullPage:false}));
console.log('HIT', hit);
await browser.close().catch(()=>{});
