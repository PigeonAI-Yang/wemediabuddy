
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
const date='2026-08-08';
// force sync + focus
const mgr = await page.evaluate(async (date) => {
  await window.wmb.syncManagerTask?.({ businessDate: date });
  window.dispatchEvent(new CustomEvent('wmb:focus-manager-dialog', { detail: { action: 'focus_existing' } }));
  return window.wmb.getManagerTask({ businessDate: date });
}, date);
await new Promise(r=>setTimeout(r,1500));
const ui = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    hasCard: text.includes('【主管任务】'),
    hasSummary: /记者扫描|主管已接单|monitor_reporter|今日情报/.test(text),
    collapsed: document.querySelector('main')?.classList.contains('pi-collapsed') ?? null,
    snippet: text.replace(/\s+/g,' ').slice(0,600)
  };
});
const second = await page.evaluate(async (date) => window.wmb.startDailyIntelligence({ businessDate: date }), date);
console.log('MGR_STATUS', mgr?.managerTask?.checkpoint?.status, mgr?.managerTask?.checkpoint?.summary);
console.log('SECOND_ACTION', second?.data?.action, second?.data?.focusDialog);
console.log('UI', JSON.stringify(ui));
const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-p1-live.png', await page.screenshot({ fullPage:false }));
await browser.close().catch(()=>{});
