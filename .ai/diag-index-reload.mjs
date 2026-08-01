
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

function extract(payload){
  const out=[]; const seen=new Set();
  const walk=(n)=>{
    if(!n||typeof n!=='object') return;
    if(Array.isArray(n)){ for(const x of n) walk(x); return; }
    const listId = typeof n.id_str==='string'?n.id_str: (typeof n.rest_id==='string'&&/^\d+$/.test(n.rest_id)?n.rest_id:null);
    const name = typeof n.name==='string'?n.name.trim():'';
    if(listId && name && ('member_count' in n || 'mode' in n || 'user_results' in n) && !seen.has(listId)){
      seen.add(listId); out.push({listId,name});
    }
    for(const v of Object.values(n)) walk(v);
  };
  walk(payload); return out;
}

const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=browser.contexts()[0].pages()[0];
const map=new Map();
const onResp=async(r)=>{
  if(!r.url().includes('ListsManagementPageTimeline')) return;
  try{ for(const x of extract(await r.json())) map.set(x.listId,x); }catch{}
};
page.on('response', onResp);
const t0=Date.now();
// already on lists page path: force reload
const account='KimbomArtist';
const listsUrl=`https://x.com/${account}/lists`;
if(page.url().includes(`/${account}/lists`)){
  await page.reload({waitUntil:'domcontentloaded', timeout:15000});
} else {
  await page.goto(listsUrl,{waitUntil:'domcontentloaded', timeout:15000});
}
await page.locator('[data-testid="listCell"]').first().waitFor({state:'visible',timeout:10000}).catch(()=>{});
let n=0;
while(map.size===0 && Date.now()-t0<14000){
  await page.waitForTimeout(350);
  if(n<4){ await page.mouse.wheel(0,700+n*300); n++; }
}
page.off('response', onResp);
const ms=Date.now()-t0;
const lists=[...map.values()];
console.log(JSON.stringify({ms, count:lists.length, sample:lists.slice(0,6), ok:lists.length>=1 && ms<45000},null,2));
await browser.close();
if(lists.length<1) process.exit(2);
