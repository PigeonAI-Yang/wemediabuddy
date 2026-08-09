
import {chromium} from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=b.contexts()[0].pages()[0];await p.bringToFront();await p.waitForTimeout(400);
const state=async label=>p.evaluate(label=>{const e=document.querySelector('.pi-dock-toggle');const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {label,shell:document.querySelector('.app-shell')?.className,w:r.width,h:r.height,cssW:c.width,cssH:c.height,shadow:c.boxShadow,filter:c.filter,opacity:c.opacity}},label);
const start=await state('start');
const initialCollapsed=(start.shell||'').includes('pi-collapsed');
if(initialCollapsed) await p.locator('.pi-dock-toggle-rail').hover(); else await p.locator('.pi-dock-toggle-rail').hover();
await p.locator('.pi-dock-toggle').click();await p.waitForTimeout(300);const afterClick=await state('after-click');
await p.locator('.pi-dock-toggle-rail').hover();await p.locator('.pi-dock-toggle').click();await p.waitForTimeout(300);const reopened=await state('reopened');
console.log(JSON.stringify({start,afterClick,reopened,dimensionsEqual:afterClick.w===reopened.w&&afterClick.h===reopened.h&&afterClick.cssW===reopened.cssW&&afterClick.cssH===reopened.cssH,clickChanged:(start.shell!==afterClick.shell),reopenedChanged:(afterClick.shell!==reopened.shell)},null,2)); await b.close().catch(()=>{});
