
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
function walk(n,fn){ if(!n||typeof n!=='object')return; if(Array.isArray(n)){for(const x of n)walk(x,fn);return;} fn(n); for(const [k,v] of Object.entries(n)){ if(k==='quoted_status_result') continue; walk(v,fn);} }
const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=browser.contexts()[0].pages()[0];
const payloads=[]; page.on('response',async r=>{ if(r.url().includes('ListLatestTweetsTimeline')){ try{payloads.push(await r.json());}catch{}}});
await page.goto('https://x.com/i/lists/2082177169078251627',{waitUntil:'domcontentloaded',timeout:30000});
for(let i=0;i<6;i++){ await page.mouse.wheel(0,1600); await page.waitForTimeout(400);} 
const rts=[];
for(const p of payloads){
  walk(p,(node)=>{
    if(typeof node.rest_id!=='string'||!node.legacy) return;
    const rt=node.legacy.retweeted_status_result?.result || node.retweeted_status_result?.result;
    if(!rt) return;
    const unwrap=t=>t?.legacy?t:t?.tweet?.legacy?t.tweet:t?.result?unwrap(t.result):t;
    const inner=unwrap(rt);
    const outerUser=node.core?.user_results?.result;
    const innerUser=inner?.core?.user_results?.result;
    rts.push({
      outer:{rest_id:node.rest_id, screen:outerUser?.core?.screen_name, name:outerUser?.core?.name, text:String(node.legacy.full_text||'').slice(0,80)},
      inner:{rest_id:inner?.rest_id, screen:innerUser?.core?.screen_name, name:innerUser?.core?.name, text:String(inner?.legacy?.full_text||'').slice(0,80), avatar:innerUser?.avatar?.image_url||null}
    });
  });
}
console.log(JSON.stringify({payloads:payloads.length, rtCount:rts.length, samples:rts.slice(0,5)},null,2));
await browser.close();
