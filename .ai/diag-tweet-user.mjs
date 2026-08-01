
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
await page.waitForTimeout(4000);
function firstTweet(node){
  if(!node||typeof node!=='object') return null;
  if(Array.isArray(node)){ for(const x of node){ const f=firstTweet(x); if(f) return f; } return null; }
  if(typeof node.rest_id==='string' && node.legacy?.full_text) return node;
  for(const v of Object.values(node)){ const f=firstTweet(v); if(f) return f; }
  return null;
}
const t=firstTweet(payload);
const userResult = t?.core?.user_results?.result;
console.log(JSON.stringify({
  userKeys: userResult ? Object.keys(userResult) : null,
  legacyKeys: userResult?.legacy ? Object.keys(userResult.legacy).slice(0,30) : null,
  screen: userResult?.legacy?.screen_name,
  name: userResult?.legacy?.name,
  avatar: userResult?.legacy?.profile_image_url_https,
  typename: userResult?.__typename,
  media: t?.legacy?.extended_entities?.media?.map(m=>({type:m.type, url:m.media_url_https, video:m.video_info?.variants?.slice?.(0,2)})) || null
}, null, 2));
await browser.close();
