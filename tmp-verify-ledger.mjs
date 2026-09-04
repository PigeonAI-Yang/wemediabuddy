import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DEBUG_PORT = 9334;
const NEW_TITLES = [
  '没有开发经验也能做出产品，但第一版上线只是起点：GoMovie 这次迭代最值得学的不是代码',
  'AI 产品能做出来，不等于订阅能留下：OpenDesign Go 停售退款暴露了最贵的一步',
  '静态商品图变成 AI 视频，先别谈规模：用 1 个 SKU 跑完一次可验收交付',
  'MiMo V2.5 限时免费，真正值得做的不是薅额度：先用同一任务测出它能不能替代你的工作流'
];

console.log('Spawning diagnostic');
const child = spawn(INSTALLED_EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached:true, stdio:'ignore', cwd:'J:/PigeonYang/WeMediaBuddy'});
child.unref();
console.log('pid', child.pid);
await new Promise(r=>setTimeout(r,7000));
let browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
let page = browser.contexts()[0].pages()[0];
console.log('url', page.url());
const consoleErrors=[]; const pageErrors=[];
page.on('console', m=>{ if(m.type()==='error') consoleErrors.push(m.text());});
page.on('pageerror', e=> pageErrors.push(String(e)));
await page.waitForTimeout(2000);

// Ensure Today
await page.waitForSelector('.app-shell', {timeout:10000});
await page.waitForSelector('.today-layout', {timeout:10000});
console.log('on today');

let domBefore = await page.evaluate(()=> document.body.innerText.slice(0,5000));
console.log('before snippet', domBefore.slice(0,1000));

// Find CTA button
const ctaFound = await page.evaluate(()=> {
  const btn = Array.from(document.querySelectorAll('button')).find(b=> (b.textContent||'').trim()==='查看待确认选题');
  return { found: !!btn, text: btn?.textContent, disabled: btn?.disabled, rect: btn?.getBoundingClientRect() };
});
console.log('ctaFound', ctaFound);
if(ctaFound.found){
  await page.evaluate(()=> {
    const btn = Array.from(document.querySelectorAll('button')).find(b=> (b.textContent||'').trim()==='查看待确认选题');
    btn.click();
  });
  await page.waitForTimeout(2000);
  console.log('clicked CTA');
  // Now we are likely on proposal/topic view, check for ledger
  await page.waitForTimeout(2000);
  const afterClick = await page.evaluate((titles)=> {
    const bodyText = document.body.innerText || '';
    // check each title presence (full or prefix)
    const found = titles.map(t=> ({ title: t.slice(0,30), found: bodyText.includes(t) || bodyText.includes(t.slice(0,20)) }));
    // also list all visible proposal rows if any
    const proposalRows = Array.from(document.querySelectorAll('[data-testid="proposal-row"], .proposal-ledger-row, .proposal-item, .topic-proposal-row')).map(el=> el.innerText.slice(0,200));
    // alternative: check for any element containing "草稿/待审批" etc
    const has4Draft = bodyText.includes('4 条草稿') || bodyText.includes('4条草稿');
    const hasLedger = bodyText.includes('选题') || bodyText.includes('提案');
    return { bodySnippet: bodyText.slice(0,6000), found, proposalRows: proposalRows.slice(0,10), has4Draft, hasLedger, bodyLen: bodyText.length, allButtons: Array.from(document.querySelectorAll('button')).map(b=> (b.textContent||'').trim()).filter(t=>t).slice(0,30) };
  }, NEW_TITLES);
  console.log('afterClick', JSON.stringify(afterClick,null,2));
  // also check DB ledger proxy via UI? Try to find plan_items via window.wmb?
  const wmbCheck = await page.evaluate(async ()=> {
    try{
      const res = await window.wmb.listPlans?.() || await window.wmb.getToday?.() || null;
      return { hasWmb: !!window.wmb, res: JSON.stringify(res).slice(0,2000)};
    }catch(e){ return { error: String(e) } }
  });
  console.log('wmbCheck', wmbCheck);
  await page.screenshot({ path: 'J:/PigeonYang/WeMediaBuddy/.ai/verify-ledger-after-click.png', fullPage:true });
  console.log('screenshot ledger', fs.statSync('J:/PigeonYang/WeMediaBuddy/.ai/verify-ledger-after-click.png').size);
  // evaluate ledger correspondence via DOM after click: check titles again
  const ledgerAfter = await page.evaluate(()=> {
    return document.body.innerHTML.slice(0,10000);
  });
  fs.writeFileSync('J:/PigeonYang/WeMediaBuddy/.ai/ledger-html.html', ledgerAfter);
  console.log('ledger html written');
}

console.log('consoleErrors', consoleErrors);
console.log('pageErrors', pageErrors);

await browser.close();
console.log('browser closed');
try{
  const {execSync}= await import('node:child_process');
  execSync(`taskkill /PID ${child.pid} /T /F`, {stdio:'inherit'});
  await new Promise(r=>setTimeout(r,2000));
}catch(e){ console.log(e); }
console.log('diagnostic killed');
