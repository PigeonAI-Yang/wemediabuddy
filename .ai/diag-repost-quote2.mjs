
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
function walk(node, fn){ if(!node||typeof node!=='object') return; if(Array.isArray(node)){ for(const x of node) walk(x,fn); return;} fn(node); for(const v of Object.values(node)) walk(v,fn);} 
const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=browser.contexts()[0].pages()[0]||await browser.contexts()[0].newPage();
const payloads=[];
const onResp=async(r)=>{ if(!r.url().includes('ListLatestTweetsTimeline')) return; try{payloads.push(await r.json());}catch{} };
page.on('response', onResp);
await page.goto('https://x.com/i/lists/2082177169078251627',{waitUntil:'domcontentloaded',timeout:30000});
for(let i=0;i<8 && !payloads.length;i++){ await page.mouse.wheel(0,1200+i*200); await page.waitForTimeout(500); }
await page.waitForTimeout(1500);
// DOM social context / quote cards
const dom = await page.evaluate(()=>{
  return Array.from(document.querySelectorAll('main article')).slice(0,25).map((art,i)=>{
    const text=(art.innerText||'').split('\n').slice(0,12);
    const social = art.querySelector('[data-testid="socialContext"]')?.textContent?.trim() || null;
    const quote = art.querySelector('[data-testid="quoteTweet"], [role="blockquote"], div[aria-labelledby*="quote"]');
    const quoteText = quote ? (quote.innerText||'').split('\n').slice(0,8) : null;
    const status = Array.from(art.querySelectorAll('a[href*="/status/"]')).map(a=>a.getAttribute('href')).filter(Boolean).slice(0,5);
    return {i, social, hasQuote:Boolean(quote), quoteText, status, text};
  });
});
let total=0,rt=0,qt=0; const samples=[];
for(const p of payloads){
  walk(p,(node)=>{
    if(typeof node.rest_id!=='string'||!node.legacy||typeof node.legacy.full_text!=='string') return;
    total++;
    const legacy=node.legacy;
    const user=node.core?.user_results?.result;
    const screen=user?.core?.screen_name||null;
    // unwrap tweet with nested result for TweetWithVisibilityResults
    const unwrap=t=>{
      if(!t) return null;
      if(t.legacy) return t;
      if(t.tweet?.legacy) return t.tweet;
      if(t.result?.legacy) return unwrap(t.result);
      return t;
    };
    const rtNode=unwrap(legacy.retweeted_status_result?.result || node.retweeted_status_result?.result);
    const qtNode=unwrap(legacy.quoted_status_result?.result || node.quoted_status_result?.result);
    if(rtNode) rt++; if(qtNode || legacy.is_quote_status) qt++;
    if((rtNode||qtNode||legacy.is_quote_status) && samples.length<10){
      const rtUser=rtNode?.core?.user_results?.result;
      const qtUser=qtNode?.core?.user_results?.result;
      samples.push({
        rest_id:node.rest_id, screen, text:String(legacy.full_text).slice(0,100),
        typename:node.__typename||null,
        is_quote_status:legacy.is_quote_status??null,
        rt: rtNode?{rest_id:rtNode.rest_id, screen:rtUser?.core?.screen_name||null, name:rtUser?.core?.name||null, text:String(rtNode.legacy?.full_text||'').slice(0,100), avatar:rtUser?.avatar?.image_url||null}:null,
        qt: qtNode?{rest_id:qtNode.rest_id, screen:qtUser?.core?.screen_name||null, name:qtUser?.core?.name||null, text:String(qtNode.legacy?.full_text||'').slice(0,100), avatar:qtUser?.avatar?.image_url||null}:null
      });
    }
  });
}
console.log(JSON.stringify({payloads:payloads.length,total,rt,qt,samples,dom:dom.filter(d=>d.social||d.hasQuote).slice(0,10),domSample:dom.slice(0,5)},null,2));
page.off('response', onResp);
await browser.close();
