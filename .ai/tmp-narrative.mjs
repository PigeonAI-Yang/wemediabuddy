
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
let r1;
try {
  r1 = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date }), date);
  console.log('R1', JSON.stringify({ action:r1?.data?.action, mgr:r1?.data?.managerTask?.id, err:r1?.error, ok:r1?.ok }).slice(0,500));
} catch (e) {
  console.log('R1_THROW', String(e));
}
await new Promise(r=>setTimeout(r,3000));
await page.evaluate(() => { window.dispatchEvent(new CustomEvent('wmb:focus-manager-dialog')); });
await new Promise(r=>setTimeout(r,1500));
const conv = await page.evaluate(async () => window.wmb.getPiConversation());
const managerMsgs = (conv.messages||[]).filter(m => /主管|记者|策划|已派|已接单/.test(m.text||''));
console.log('TITLE', conv.title);
console.log('LAST_MSGS');
for (const m of managerMsgs.slice(-8)) console.log('---\n'+(m.text||'').slice(0,300));
const ugly = managerMsgs.some(m => /状态：running|phase：|reporter:|taskId=|monitor_/.test(m.text||''));
const human = managerMsgs.some(m => /已接单|已派记者|主管正在处理|记者开始|记者完成/.test(m.text||''));
console.log('UGLY', ugly, 'HUMAN', human);
const ui = await page.evaluate(() => {
  const t=document.body.innerText;
  return { bar:/主管编排中/.test(t), human:/已派记者|主管正在处理|记者开始|记者完成/.test(t), tech:/monitor_reporter|reporter:running|taskId=/.test(t) };
});
console.log('UI', ui);
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-dialog-narrative.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
