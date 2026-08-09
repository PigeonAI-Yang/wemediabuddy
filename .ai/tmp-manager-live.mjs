
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = context.pages()[0];
for (const p of context.pages()) {
  const t = await p.title().catch(()=> '');
  if (/WeMediaBuddy/i.test(t) || p.url().includes('27391')) { page = p; break; }
}
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.startDailyIntelligence), null, { timeout: 30000 });

// go today
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '今日' || /今日/.test(x.title||''));
  b?.click();
});
await new Promise(r => setTimeout(r, 1200));

const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
console.log('DATE', businessDate);

const r1 = await page.evaluate(async (businessDate) => {
  try {
    const result = await window.wmb.startDailyIntelligence({ businessDate });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}, businessDate);
console.log('R1', JSON.stringify(r1, null, 2).slice(0, 2500));

await new Promise(r => setTimeout(r, 3000));
const ui1 = await page.evaluate(() => ({
  text: document.body.innerText.replace(/\s+/g,' ').slice(0, 900),
  hasCard: /【主管任务】/.test(document.body.innerText),
  hasManager: /主管/.test(document.body.innerText),
  className: document.querySelector('main')?.className || ''
}));
console.log('UI1', JSON.stringify(ui1).slice(0, 1500));

const r2 = await page.evaluate(async (businessDate) => {
  try {
    const result = await window.wmb.startDailyIntelligence({ businessDate });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}, businessDate);
console.log('R2', JSON.stringify(r2, null, 2).slice(0, 2000));

const mgr = await page.evaluate(async (businessDate) => {
  return window.wmb.getManagerTask ? await window.wmb.getManagerTask({ businessDate }) : null;
}, businessDate);
console.log('MGR', JSON.stringify(mgr, null, 2).slice(0, 2000));

const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-p1-live.png', await page.screenshot({ fullPage: false }));
await browser.close().catch(()=>{});
