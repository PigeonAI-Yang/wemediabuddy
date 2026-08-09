
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.startDailyIntelligence), null, { timeout: 30000 });
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,1000));
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const r1 = await page.evaluate(async (date) => {
  try { return await window.wmb.startDailyIntelligence({ businessDate: date }); }
  catch(e){ return { ok:false, error:String(e) }; }
}, date);
console.log('R1', JSON.stringify({ok:r1?.ok, action:r1?.data?.action, mgr:r1?.data?.managerTask?.id, err:r1?.error||r1?.result?.error}).slice(0,400));

for (let i=0;i<12;i++) {
  await page.evaluate(async (date) => { try { await window.wmb.syncManagerTask({businessDate:date}); } catch{} }, date);
  await new Promise(r=>setTimeout(r,1000));
  const snap = await page.evaluate(() => {
    const tools=[...document.querySelectorAll('details.pi-tool-line, .pi-tool-line')].map(n=>(n.textContent||'').replace(/\s+/g,' ').trim());
    const t=document.body.innerText;
    return {
      tools: tools.slice(0,15),
      n: tools.length,
      hasRunChild: tools.some(x=>/wmb_run_daily_child|run_daily_child/.test(x)),
      hasSubagent: tools.some(x=>/subagent\.(reporter|planner)|subagent/.test(x)),
      hasUser: /请执行今日情报编排/.test(t),
      bar: /主管编排中/.test(t),
      techCard: /状态：running|taskId=/.test(t)
    };
  });
  console.log('T'+i, JSON.stringify(snap));
  if (snap.hasRunChild || snap.hasSubagent) break;
}
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-native-tools.png', await page.screenshot({fullPage:false}));
const conv=await page.evaluate(async()=>window.wmb.getPiConversation());
console.log('LAST_USER', [...(conv.messages||{})].reverse().find(m=>m.role==='user')?.text?.slice(0,120));
const segs=[...(conv.messages||[])].reverse().find(m=>m.role==='assistant')?.segments||[];
console.log('LAST_ASSIST_SEGS', segs.map(s=>({kind:s.kind, tool:s.toolName, text:(s.text||'').slice(0,80)})));
await browser.close().catch(()=>{});
