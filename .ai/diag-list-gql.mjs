
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const listId = '2082177169078251627';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();
/** @type {any[]} */
const hits = [];
page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes('ListLatestTweetsTimeline')) return;
  try {
    const json = await response.json();
    hits.push({ url: url.slice(0, 300), json });
  } catch {}
});
await page.goto(`https://x.com/i/lists/${listId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3500);
await page.mouse.wheel(0, 3200);
await page.waitForTimeout(1500);
await page.mouse.wheel(0, 3200);
await page.waitForTimeout(1500);

function walk(node, path=[], acc=[]) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach((v,i)=>walk(v, path.concat(String(i)), acc)); return acc; }
  const rec = node;
  if (typeof rec.rest_id === 'string' && rec.legacy && typeof rec.legacy.full_text === 'string') {
    acc.push({
      path: path.join('.').slice(0,120),
      rest_id: rec.rest_id,
      full_text: String(rec.legacy.full_text).slice(0,80),
      user: rec.core?.user_results?.result?.legacy?.screen_name || rec.legacy?.user_id_str || null,
      created_at: rec.legacy.created_at || null,
      favorite_count: rec.legacy.favorite_count ?? null,
      retweet_count: rec.legacy.retweet_count ?? null,
      reply_count: rec.legacy.reply_count ?? null,
      quote_count: rec.legacy.quote_count ?? null,
      bookmark_count: rec.legacy.bookmark_count ?? null,
      views: rec.views?.count ?? null,
      hasCursor: false
    });
  }
  if (rec.cursorType && rec.value) {
    acc.push({ path: path.join('.').slice(0,120), cursorType: rec.cursorType, value: rec.value, hasCursor: true });
  }
  for (const [k,v] of Object.entries(rec)) walk(v, path.concat(k), acc);
  return acc;
}

const summary = hits.map((hit, idx) => {
  const found = walk(hit.json);
  const tweets = found.filter(x => x.rest_id);
  const cursors = found.filter(x => x.hasCursor);
  return {
    idx,
    tweetCount: tweets.length,
    tweets: tweets.slice(0,5),
    lastTweets: tweets.slice(-3),
    cursors,
    urlHasCursor: /cursor/.test(hit.url)
  };
});
console.log(JSON.stringify({ hitCount: hits.length, summary }, null, 2));
// dump one raw instructions path snippet
if (hits[0]) {
  const s = JSON.stringify(hits[0].json);
  const m = s.match(/ListLatestTweetsTimeline.{0,200}/);
  console.log('RAW_HINT', m?.[0] || s.slice(0,200));
}
await browser.close();
