
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));b?.click();});
await new Promise(r=>setTimeout(r,1000));
// trigger load by noop
await page.evaluate(async()=>{
  await window.wmb.syncManagerTask?.({businessDate:'2026-08-08'});
});
await new Promise(r=>setTimeout(r,2500));
const ui=await page.evaluate(()=>{
  const t=document.body.innerText.replace(/\s+/g,' ');
  return {
    managerOwned: /主管编排中|对话中 · 查看进度|记者扫描/.test(t),
    viewProgress: t.includes('对话中 · 查看进度'),
    card: t.includes('【主管任务】'),
    snippet: t.slice(0,350)
  };
});
console.log(JSON.stringify(ui,null,2));
const fs=await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-manager-p1-live.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
