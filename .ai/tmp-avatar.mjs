
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForFunction(()=>Boolean(window.wmb?.setAgentAvatar), null, {timeout:30000});
const png = process.argv[1];
const res = await page.evaluate(async (png) => {
  try {
    const r = await window.wmb.setAgentAvatar({ roleId: 'desk', base64: png, mimeType: 'image/png', width: 1, height: 1 });
    return { ok:true, r };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}, png);
console.log(JSON.stringify(res,null,2));
const list = await page.evaluate(async()=>window.wmb.listAgentAvatars?.());
console.log('LIST', JSON.stringify(list));
await browser.close().catch(()=>{});
