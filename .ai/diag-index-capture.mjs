
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

function parseListCell(text, href) {
  const lines = String(text||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const handleLine = lines.find(l => l.startsWith('@'));
  const name = lines.find(l => l && l !== handleLine && !/成员|Members|Followers|关注|私有|Private|编辑|Edit/i.test(l)) || '';
  const idMatch = String(href||'').match(/\/lists\/(\d+)/);
  return { listId: idMatch?.[1] || null, name, ownerHandle: handleLine || null, href };
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
const t0 = Date.now();
const payloads = [];
page.on('response', async (r) => {
  if (!r.url().includes('ListsManagementPageTimeline')) return;
  try { payloads.push(await r.json()); } catch {}
});

// if already on lists page, reload to trigger gql
const url = page.url();
console.log('startUrl', url);
if (!/\/lists\/?$/.test(new URL(url).pathname)) {
  // try go home then lists
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
}
// discover handle
const handle = await page.evaluate(() => {
  const t = document.body?.innerText || '';
  const m = t.match(/@([A-Za-z0-9_]+)/);
  return m ? m[1] : 'KimbomArtist';
});
const listsUrl = `https://x.com/${handle}/lists`;
await page.goto(listsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2500);
if (!payloads.length) {
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1000);
}

// DOM cells
const cells = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[data-testid="listCell"]')).map(cell => {
    const a = cell.querySelector('a[href*="/lists/"]');
    return { text: cell.innerText||'', href: a?.getAttribute('href')||'' };
  });
});

function extractLists(payload) {
  const out=[]; const seen=new Set();
  const walk=(n)=>{
    if(!n||typeof n!=='object') return;
    if(Array.isArray(n)){ for(const x of n) walk(x); return; }
    const id = n.list_id || n.listId || n.id_str || n.rest_id;
    const name = n.name || n.list_name;
    if(id && name && String(id).match(/^\d+$/)){
      const key=String(id);
      if(!seen.has(key)){
        seen.add(key);
        out.push({listId:key, name:String(name), ownerHandle:n.user_results?.result?.core?.screen_name || n.owner?.screen_name || null});
      }
    }
    for(const v of Object.values(n)) walk(v);
  };
  walk(payload); return out;
}

let gqlLists=[];
for (const p of payloads) gqlLists.push(...extractLists(p));
// unique
const uniq=[]; const s=new Set();
for (const x of gqlLists) if(!s.has(x.listId)){ s.add(x.listId); uniq.push(x); }

const domLists = cells.map(c => parseListCell(c.text,c.href)).filter(x=>x.listId);
const ms=Date.now()-t0;
console.log(JSON.stringify({
  ms,
  handle,
  finalUrl: page.url(),
  gqlPayloads: payloads.length,
  gqlLists: uniq.length,
  gqlSample: uniq.slice(0,5),
  domCells: cells.length,
  domLists: domLists.length,
  domSample: domLists.slice(0,5)
}, null, 2));
await browser.close();
