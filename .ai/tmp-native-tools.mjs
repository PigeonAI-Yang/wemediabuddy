
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.startDailyIntelligence), null, { timeout: 30000 });
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,800));
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const r1 = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date }), date);
console.log('R1', r1?.data?.action, r1?.data?.managerTask?.id?.slice(0,8));

// poll UI for tool lines
let found=false;
for (let i=0;i<20;i++) {
  await page.evaluate(async (date) => { await window.wmb.syncManagerTask?.({businessDate:date}); }, date);
  await new Promise(r=>setTimeout(r,1000));
  const snap = await page.evaluate(() => {
    const text = document.body.innerText;
    const toolNodes = [...document.querySelectorAll('.pi-tool-line, details.pi-tool-line, .pi-tool-label')];
    const toolText = toolNodes.map(n => (n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,12);
    return {
      toolCount: toolNodes.length,
      toolText,
      hasSubagent: /subagent|记者|策划|wmb_run_daily_child|run_daily_child/.test(text),
      hasTechCard: /状态：running|taskId=|reporter:running/.test(text),
      hasUserOrder: /请执行今日情报编排|执行今日情报/.test(text),
      bar: /主管编排中/.test(text),
      snippet: text.replace(/\s+/g,' ').slice(0,400)
    };
  });
  console.log('T'+i, JSON.stringify({toolCount:snap.toolCount, toolText:snap.toolText, hasSubagent:snap.hasSubagent, hasTechCard:snap.hasTechCard, hasUserOrder:snap.hasUserOrder, bar:snap.bar}));
  if (snap.toolCount > 0 || snap.hasSubagent) { found=true; break; }
}

const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-native-tools.png', await page.screenshot({fullPage:false}));
const conv = await page.evaluate(async()=>window.wmb.getPiConversation());
const last = (conv.messages||[]).slice(-6).map(m=>({role:m.role, status:m.status, text:(m.text||'').slice(0,120), segs:(m.segments||[]).map(s=>s.kind+':'+(s.toolName||'')+':'+(s.text||'').slice(0,60))}));
console.log('CONV', JSON.stringify(last,null,2));
console.log('FOUND_TOOLS', found);
await browser.close().catch(()=>{});
