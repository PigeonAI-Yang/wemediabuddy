
import {chromium} from 'playwright-core';import fs from 'node:fs';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=b.contexts()[0].pages()[0];await p.bringToFront();await p.waitForTimeout(500);
const inspect=async label=>p.evaluate(label=>{const e=document.querySelector('.sources-panel');if(!e)return {label,missing:true};const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {label,className:e.className,rect:{x:r.x,w:r.width,right:r.right},transform:c.transform,shadow:c.boxShadow,visibility:c.visibility,opacity:c.opacity}},label);
const closed=await inspect('closed');
const toggle= p.locator('.sources-toggle'); const count=await toggle.count();
let open={missing:true}, closedAgain={missing:true};
if(count){await toggle.first().click();await p.waitForTimeout(350);open=await inspect('open');const close=p.locator('.close-sources');if(await close.count()) await close.first().click(); else await toggle.first().click();await p.waitForTimeout(350);closedAgain=await inspect('closed-again');}
const vp=await p.evaluate(()=>({w:innerWidth,h:innerHeight}));fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/shadow-after-fix-right.png',await p.screenshot({type:'png',clip:{x:vp.w-80,y:40,width:80,height:vp.h-80}}));
console.log(JSON.stringify({toggleCount:count,closed,open,closedAgain,closedNoShadow:closed.shadow==='none'&&closedAgain.shadow==='none',openKeepsShadow:open.shadow&&open.shadow!=='none'},null,2));await b.close().catch(()=>{});
