
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const listId='2082177169078251627';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=(browser.contexts()[0].pages()[0]) || await browser.contexts()[0].newPage();
let payload=null;
page.on('response', async (r)=>{
  if(!r.url().includes('ListLatestTweetsTimeline')) return;
  try { payload = await r.json(); } catch {}
});
await page.goto(`https://x.com/i/lists/${listId}`, {waitUntil:'domcontentloaded', timeout:30000});
await page.waitForTimeout(3500);
function firstTweet(node){
  if(!node||typeof node!=='object') return null;
  if(Array.isArray(node)){ for(const x of node){ const f=firstTweet(x); if(f) return f; } return null; }
  if(typeof node.rest_id==='string' && node.legacy?.full_text) return node;
  for(const v of Object.values(node)){ const f=firstTweet(v); if(f) return f; }
  return null;
}
const t=firstTweet(payload);
const u=t?.core?.user_results?.result;
console.log(JSON.stringify({
  core:u?.core,
  avatar:u?.avatar,
  rest_id:u?.rest_id
}, null, 2));
await browser.close();
