
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

function norm(value) {
  try {
    const url = new URL(value, 'https://x.com');
    const m = url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    return m ? `https://x.com/${m[1]}/status/${m[2]}` : '';
  } catch { return ''; }
}
function extract(payload) {
  const posts = [];
  const seen = new Set();
  let bottom=null;
  const walk=(node)=>{
    if(!node||typeof node!=='object') return;
    if(Array.isArray(node)){ for(const x of node) walk(x); return; }
    if(node.cursorType==='Bottom' && typeof node.value==='string') bottom=node.value;
    if(typeof node.rest_id==='string' && node.legacy?.full_text){
      const screen=node.core?.user_results?.result?.core?.screen_name;
      if(screen){
        const url=norm(`https://x.com/${screen}/status/${node.rest_id}`);
        if(url && !seen.has(url)){ seen.add(url); posts.push({url, text:String(node.legacy.full_text).slice(0,40), author:'@'+screen}); }
      }
    }
    for(const v of Object.values(node)) walk(v);
  };
  walk(payload);
  return {posts,bottom};
}

const listId='2082177169078251627';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();

// Simulate UI first page from DOM/cache only (no memory).
await page.goto(`https://x.com/i/lists/${listId}`, {waitUntil:'domcontentloaded', timeout:30000});
await page.waitForTimeout(2500);
const firstDom = await page.evaluate(() => {
  const urls = Array.from(document.querySelectorAll('main article a[href*="/status/"]'))
    .map(a => a.getAttribute('href')||'')
    .filter(h => /\/status\/\d+/.test(h))
    .map(h => {
      const m = h.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      return m ? `https://x.com/${m[1]}/status/${m[2]}` : '';
    })
    .filter(Boolean);
  return [...new Set(urls)];
});
const known = firstDom.slice(0, 20);
const t0 = Date.now();

// Cold load-more path: attach listener, reload list, capture gql, filter known.
const payloads=[];
const onResp = async (r) => {
  if (!r.url().includes('ListLatestTweetsTimeline')) return;
  try { payloads.push(await r.json()); } catch {}
};
page.on('response', onResp);
await page.goto(`https://x.com/i/lists/${listId}`, {waitUntil:'domcontentloaded', timeout:30000});
await page.waitForTimeout(1200);
if (!payloads.length) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(800);
}
page.off('response', onResp);

let all=[]; let bottom=null;
for (const p of payloads) {
  const e=extract(p); all.push(...e.posts); if(e.bottom) bottom=e.bottom;
}
const uniq=[]; const seen=new Set();
for (const p of all) if(!seen.has(p.url)){ seen.add(p.url); uniq.push(p); }
const knownSet=new Set(known.map(norm));
const next=uniq.filter(p=>!knownSet.has(p.url)).slice(0,20);
const ms=Date.now()-t0;
const out={
  ms,
  known: known.length,
  captured: uniq.length,
  next: next.length,
  bottom: !!bottom,
  sample: next.slice(0,3),
  ok: next.length>=5 && ms<12000
};
console.log(JSON.stringify(out,null,2));
await browser.close();
if(!out.ok) process.exit(2);
