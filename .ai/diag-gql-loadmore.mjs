
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

function normalizeStatusKey(value) {
  try {
    const url = new URL(value, 'https://x.com');
    const match = url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (!match) return '';
    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch { return ''; }
}

function extract(payload) {
  const posts = [];
  const seen = new Set();
  let bottomCursor = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (typeof node.cursorType === 'string' && typeof node.value === 'string' && node.cursorType === 'Bottom') bottomCursor = node.value;
    if (typeof node.rest_id === 'string' && node.legacy && typeof node.legacy.full_text === 'string') {
      const user = node.core?.user_results?.result;
      const screen = user?.core?.screen_name;
      if (screen) {
        const url = `https://x.com/${screen}/status/${node.rest_id}`;
        const key = normalizeStatusKey(url);
        if (key && !seen.has(key)) {
          seen.add(key);
          posts.push({ url: key, text: String(node.legacy.full_text).slice(0, 60), author: '@'+screen });
        }
      }
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(payload);
  return { posts, bottomCursor };
}

const listId = '2082177169078251627';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
const payloads = [];
page.on('response', async (r) => {
  if (!r.url().includes('ListLatestTweetsTimeline')) return;
  try { payloads.push(await r.json()); } catch {}
});
await page.goto(`https://x.com/i/lists/${listId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);
if (!payloads.length) { await page.mouse.wheel(0,1400); await page.waitForTimeout(1000); }

let all = [];
let bottom = null;
for (const p of payloads) {
  const e = extract(p);
  all.push(...e.posts);
  if (e.bottomCursor) bottom = e.bottomCursor;
}
// unique preserve order
const uniq = [];
const seen = new Set();
for (const p of all) if (!seen.has(p.url)) { seen.add(p.url); uniq.push(p); }

const firstPage = uniq.slice(0, 20);
const known = new Set(firstPage.map(p => p.url));

// continue scroll to get more gql if needed
for (let i=0;i<6;i++) {
  const unknown = uniq.filter(p => !known.has(p.url));
  if (unknown.length >= 15) break;
  await page.mouse.wheel(0, 2800);
  await page.waitForTimeout(500);
  // re-extract from all payloads accumulated
  all = [];
  for (const p of payloads) {
    const e = extract(p);
    all.push(...e.posts);
    if (e.bottomCursor) bottom = e.bottomCursor;
  }
  const seen2 = new Set(); uniq.length = 0;
  for (const p of all) if (!seen2.has(p.url)) { seen2.add(p.url); uniq.push(p); }
}
const page2 = uniq.filter(p => !known.has(p.url)).slice(0, 20);
const out = {
  totalCaptured: uniq.length,
  firstPage: firstPage.length,
  secondPage: page2.length,
  secondSample: page2.slice(0,5),
  bottomCursor: !!bottom,
  ok: page2.length >= 5
};
console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(2);
await browser.close();
