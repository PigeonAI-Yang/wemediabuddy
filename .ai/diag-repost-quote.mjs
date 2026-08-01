
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

function walk(node, fn, path='') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x,i)=>walk(x,fn,`${path}[${i}]`)); return; }
  fn(node, path);
  for (const [k,v] of Object.entries(node)) walk(v, fn, path ? `${path}.${k}` : k);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
const payloads = [];
page.on('response', async (r) => {
  if (!r.url().includes('ListLatestTweetsTimeline')) return;
  try { payloads.push(await r.json()); } catch {}
});
const listId = '2082177169078251627';
await page.goto(`https://x.com/i/lists/${listId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);
if (!payloads.length) { await page.mouse.wheel(0,1400); await page.waitForTimeout(1000); }

const samples = [];
for (const payload of payloads) {
  walk(payload, (node) => {
    if (typeof node.rest_id !== 'string' || !node.legacy || typeof node.legacy.full_text !== 'string') return;
    const legacy = node.legacy;
    const user = node.core?.user_results?.result;
    const screen = user?.core?.screen_name || null;
    const hasRT = Boolean(legacy.retweeted_status_result || node.retweeted_status_result);
    const hasQT = Boolean(legacy.quoted_status_result || node.quoted_status_result || legacy.is_quote_status);
    if (!hasRT && !hasQT) return;
    if (samples.length >= 8) return;
    const rt = legacy.retweeted_status_result?.result || node.retweeted_status_result?.result || null;
    const qt = legacy.quoted_status_result?.result || node.quoted_status_result?.result || null;
    const rtUser = rt?.core?.user_results?.result;
    const qtUser = qt?.core?.user_results?.result;
    samples.push({
      rest_id: node.rest_id,
      screen,
      text: String(legacy.full_text).slice(0, 80),
      is_quote_status: legacy.is_quote_status ?? null,
      retweeted: Boolean(rt),
      quoted: Boolean(qt),
      rt: rt ? {
        rest_id: rt.rest_id,
        text: String(rt.legacy?.full_text || '').slice(0,80),
        screen: rtUser?.core?.screen_name || null,
        name: rtUser?.core?.name || null,
        avatar: rtUser?.avatar?.image_url || null,
        keys: Object.keys(rt).slice(0,20),
        legacyKeys: rt.legacy ? Object.keys(rt.legacy).slice(0,20) : null
      } : null,
      qt: qt ? {
        rest_id: qt.rest_id,
        text: String(qt.legacy?.full_text || '').slice(0,80),
        screen: qtUser?.core?.screen_name || null,
        name: qtUser?.core?.name || null,
        avatar: qtUser?.avatar?.image_url || null,
        mediaType: qt.legacy?.entities?.media?.[0]?.type || qt.legacy?.extended_entities?.media?.[0]?.type || null
      } : null
    });
  });
}

// also count
let total=0, rtCount=0, qtCount=0;
for (const payload of payloads) {
  walk(payload, (node) => {
    if (typeof node.rest_id !== 'string' || !node.legacy || typeof node.legacy.full_text !== 'string') return;
    total += 1;
    if (node.legacy.retweeted_status_result || node.retweeted_status_result) rtCount += 1;
    if (node.legacy.quoted_status_result || node.quoted_status_result || node.legacy.is_quote_status) qtCount += 1;
  });
}

console.log(JSON.stringify({ payloads: payloads.length, total, rtCount, qtCount, samples }, null, 2));
await browser.close();
