
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages()[0]; await page.bringToFront(); await page.waitForTimeout(500);
console.log(JSON.stringify(await page.evaluate(()=>{const b=document.querySelector('.pi-dock-toggle');const r=b?.getBoundingClientRect();const c=b?getComputedStyle(b):null;return {shell:document.querySelector('.app-shell')?.className,rect:r&&{w:r.width,h:r.height},css:c&&{w:c.width,h:c.height,shadow:c.boxShadow,filter:c.filter}}}),null,2));
await browser.close().catch(()=>{});
