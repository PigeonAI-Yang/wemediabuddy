
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page=null;
for (const p of context.pages()) {
  const ok=await p.evaluate(()=>/今日|智能体/.test(document.body?.innerText||'')).catch(()=>false);
  if(ok){page=p;break;}
}
if(!page) throw new Error('no page');
await page.bringToFront();
await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.title||x.textContent||''));b?.click();});
await new Promise(r=>setTimeout(r,1000));
const clicked=await page.evaluate(()=>{
  const labels=[/继续生成方案/,/重试今日情报/,/重新侦察/];
  for(const re of labels){
    const b=[...document.querySelectorAll('button')].find(x=>re.test((x.textContent||'').trim())&&!x.disabled);
    if(b){b.click();return b.textContent.trim();}
  }
  return null;
});
console.log('CLICKED', clicked);
await new Promise(r=>setTimeout(r,600));
await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/继续|确认|确定|替换/.test((x.textContent||'').trim()));b?.click();});
await browser.close().catch(()=>{});
