
import { chromium } from 'playwright-core'; import fs from 'node:fs';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'); const page=browser.contexts()[0].pages()[0]; await page.bringToFront(); await page.waitForTimeout(500);
const out=await page.evaluate(()=>{
 const interesting=[]; const all=[...document.querySelectorAll('*')];
 for(const el of all){
  const r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) continue;
  const c=getComputedStyle(el); const before=getComputedStyle(el,'::before'); const after=getComputedStyle(el,'::after');
  const hit={tag:el.tagName, id:el.id, cls:String(el.className||'').slice(0,100), rect:{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}, bg:c.backgroundColor, shadow:c.boxShadow, filter:c.filter, borderLeft:c.borderLeft, borderRight:c.borderRight, opacity:c.opacity};
  if(c.boxShadow!=='none'||c.filter!=='none') interesting.push({...hit,pseudo:{before:{shadow:before.boxShadow,filter:before.filter,bg:before.backgroundColor,content:before.content},after:{shadow:after.boxShadow,filter:after.filter,bg:after.backgroundColor,content:after.content}}});
 }
 const points=[]; for(const y of [60,100,200,400,600,800,925]){for(const x of [1150,1170,1178,1179,1180,1185,1190,1200,1500,1580,1590,1599]){const el=document.elementFromPoint(x,y); if(el){const c=getComputedStyle(el);points.push({x,y,tag:el.tagName,cls:String(el.className||'').slice(0,70),bg:c.backgroundColor,shadow:c.boxShadow,borderLeft:c.borderLeft,borderRight:c.borderRight})}}}
 return {viewport:{w:innerWidth,h:innerHeight}, theme:document.documentElement.dataset.theme, interesting, points};
});
console.log(JSON.stringify(out,null,2));
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/shadow-dom-trace.json',JSON.stringify(out,null,2));
const vp=out.viewport; fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/shadow-trace-right.png',await page.screenshot({type:'png',clip:{x:Math.max(0,vp.w-500),y:0,width:500,height:vp.h}})); await browser.close().catch(()=>{});
