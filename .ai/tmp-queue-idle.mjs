
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(() => Boolean(window.wmb?.chatPi && window.wmb?.startDailyIntelligence), null, {timeout:30000});

// go today
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button,a,[role="button"]')].find(x=>/今日/.test(x.textContent||x.title||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,1200));

const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
// ensure manager/legacy running if possible
const before = await page.evaluate(async (date) => {
  const proj = await window.wmb.getManagerTask?.({businessDate:date});
  const leg = await window.wmb.getAgentTask?.({intent:'daily_intelligence', businessDate:date});
  return {
    mgr: proj?.managerTask?.status || null,
    child: leg?.status || null,
    mode: document.querySelector('.today-command')?.getAttribute('data-mode') || null,
    cmdText: (document.querySelector('.today-command')?.textContent||'').replace(/\s+/g,' ').slice(0,120)
  };
}, date);
console.log('BEFORE', JSON.stringify(before));

if (before.mode !== 'running') {
  const start = await page.evaluate(async (date) => {
    try { return await window.wmb.startDailyIntelligence({businessDate:date}); }
    catch(e){ return {ok:false,error:String(e)}; }
  }, date);
  console.log('START', JSON.stringify({ok:start?.ok, action:start?.data?.action, err:start?.error||start?.data}).slice(0,300));
  await new Promise(r=>setTimeout(r,1500));
}

// inject manager-like busy illusion check: send a message
const marker = '队列探测-' + Date.now().toString().slice(-6);
const sendRes = await page.evaluate(async (marker) => {
  // type into composer if present
  const ta = document.querySelector('.pi-composer textarea');
  if (ta) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(ta, marker);
    ta.dispatchEvent(new Event('input', {bubbles:true}));
  }
  // call chat path via UI send or direct
  try {
    const result = await window.wmb.chatPi(marker);
    return { via:'chatPi', queued: result?.queued, stopped: result?.stopped, text:(result?.text||'').slice(0,80), err:null };
  } catch (e) {
    return { via:'chatPi', err:String(e).slice(0,200) };
  }
}, marker);
console.log('SEND', JSON.stringify(sendRes));

await new Promise(r=>setTimeout(r,2500));
const afterSend = await page.evaluate((marker) => {
  const body = document.body.innerText;
  return {
    hasMarker: body.includes(marker),
    mode: document.querySelector('.today-command')?.getAttribute('data-mode') || null,
    queueVisible: !!document.querySelector('.pi-native-queue'),
    stopOrSend: !!document.querySelector('.pi-stop-button') || !!document.querySelector('.pi-send-button'),
    snippet: body.replace(/\s+/g,' ').includes(marker) ? 'marker-visible' : 'marker-missing'
  };
}, marker);
console.log('AFTER_SEND', JSON.stringify(afterSend));

// page switch flash test: leave today and come back
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button,a,[role="button"]')].find(x=>/发现|选题|创作/.test(x.textContent||''));
  b?.click();
});
await new Promise(r=>setTimeout(r,600));
const awayMode = await page.evaluate(() => document.querySelector('.today-command')?.getAttribute('data-mode') || 'unmounted');
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button,a,[role="button"]')].find(x=>/今日/.test(x.textContent||x.title||''));
  b?.click();
});
// sample mode ASAP then after settle
const flash = await page.evaluate(async () => {
  const samples=[];
  for (let i=0;i<8;i++) {
    samples.push(document.querySelector('.today-command')?.getAttribute('data-mode') || 'missing');
    await new Promise(r=>setTimeout(r,50));
  }
  await new Promise(r=>setTimeout(r,800));
  samples.push(document.querySelector('.today-command')?.getAttribute('data-mode') || 'missing');
  return {awayWas:null, samples, finalText:(document.querySelector('.today-command')?.textContent||'').replace(/\s+/g,' ').slice(0,100)};
});
console.log('AWAY', awayMode);
console.log('FLASH', JSON.stringify(flash));

const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-queue-idle-fix.png', await page.screenshot({fullPage:false}));
await browser.close().catch(()=>{});
