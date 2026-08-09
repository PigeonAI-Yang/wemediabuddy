
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const context=browser.contexts()[0];
let page=context.pages()[0];
for (const p of context.pages()) {
  const ok=await p.evaluate(()=>/今日|方案/.test(document.body?.innerText||'')).catch(()=>false);
  if(ok){page=p;break;}
}
await page.bringToFront();
await page.reload({waitUntil:'domcontentloaded'});
await new Promise(r=>setTimeout(r,2000));
await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));b?.click();});
await new Promise(r=>setTimeout(r,1200));
const text=await page.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,420));
console.log('UI', text);
console.log('READY', /今日运营方案已就绪/.test(text));
console.log('OPPS', (text.match(/今日内容机会\s*(\d+)/)||[])[1]);
console.log('NO_VAL', !/方案由当前任务写入/.test(text));
await browser.close().catch(()=>{});
