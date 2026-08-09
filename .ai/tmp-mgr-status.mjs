
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const snap = await page.evaluate(() => {
  const tools=[...document.querySelectorAll('details.pi-tool-line, .pi-tool-line')].map(n=>(n.textContent||'').replace(/\s+/g,' ').trim());
  return {
    spawn: tools.filter(t=>/spawn|daily_scan|reporter|JOB_/.test(t)).slice(0,8),
    stop: !!document.querySelector('.pi-stop-button'),
    mode: document.querySelector('.today-command')?.getAttribute('data-mode'),
    tail: document.body.innerText.replace(/\s+/g,' ').slice(-500)
  };
});
console.log(JSON.stringify(snap,null,2));
await browser.close().catch(()=>{});
