
import {chromium} from 'playwright-core'; import fs from 'node:fs';
const b=await chromium.connectOverCDP('http://127.0.0.1:9222'); const p=b.contexts()[0].pages()[0]; await p.bringToFront(); await p.waitForTimeout(300);
console.log(await p.evaluate(()=>({innerWidth,innerHeight,body:getComputedStyle(document.body).backgroundColor,html:getComputedStyle(document.documentElement).backgroundColor,shell:getComputedStyle(document.querySelector('.app-shell')).backgroundColor,dock:getComputedStyle(document.querySelector('.pi-dock')).backgroundColor}))); 
const vp=await p.evaluate(()=>({w:innerWidth,h:innerHeight})); fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/post-round-renderer-right.png',await p.screenshot({type:'png',clip:{x:vp.w-75,y:0,width:75,height:vp.h}})); await b.close().catch(()=>{});
