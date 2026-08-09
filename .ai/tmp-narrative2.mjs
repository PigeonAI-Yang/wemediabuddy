
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.syncManagerTask), null, { timeout: 20000 });
await page.evaluate(async () => {
  await window.wmb.syncManagerTask({ businessDate: '2026-08-08' });
  window.dispatchEvent(new CustomEvent('wmb:focus-manager-dialog'));
});
await new Promise(r => setTimeout(r, 2000));
const conv = await page.evaluate(async () => window.wmb.getPiConversation());
const msgs = (conv.messages||[]).filter(m => /主管|记者|策划|已派|已接单/.test(m.text||''));
console.log('TITLE', conv.title);
for (const m of msgs.slice(-8)) console.log('---\n'+(m.text||'').slice(0,280));
const ugly = msgs.some(m => /状态：running|taskId=|reporter:|monitor_/.test(m.text||''));
const human = msgs.some(m => /主管正在处理|已派记者|已接单|记者开始|记者完成/.test(m.text||''));
console.log('UGLY', ugly, 'HUMAN', human);
const ui = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    visibleHuman: /主管正在处理|已派记者|已接单：今日情报|记者开始扫描/.test(t),
    visibleTech: /状态：running|taskId=|reporter:running|monitor_reporter/.test(t),
    bar: /主管编排中/.test(t)
  };
});
console.log('UI', ui);
const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-dialog-narrative.png', await page.screenshot({ fullPage:false }));
await browser.close().catch(()=>{});
