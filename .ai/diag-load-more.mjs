
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const listId = '2082177169078251627';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

const networkHits = [];
page.on('response', async (response) => {
  const url = response.url();
  if (!/graphql|List|Timeline|HomeTimeline|ListLatest/i.test(url)) return;
  if (!/api\.x\.com|api\.twitter\.com|x\.com\/i\/api/i.test(url)) return;
  let status = response.status();
  let keys = [];
  try {
    const json = await response.json();
    const text = JSON.stringify(json);
    const ids = [...text.matchAll(/"rest_id":"(\d{6,})"/g)].map(m => m[1]);
    keys = [...new Set(ids)].slice(0, 8);
    networkHits.push({ url: url.slice(0, 180), status, idSample: keys, bytes: text.length });
  } catch {
    networkHits.push({ url: url.slice(0, 180), status, idSample: [], bytes: 0 });
  }
});

function collectUrls() {
  return page.evaluate(() => {
    const urls = Array.from(document.querySelectorAll('main article a[href*="/status/"]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((href) => /^\/[A-Za-z0-9_]+\/status\/\d+/.test(href.replace(/\/(?:photo|video)\/\d+$/, '')))
      .map((href) => {
        const clean = href.replace(/\/(?:photo|video)\/\d+$/, '').replace(/[?#].*$/, '');
        return clean.startsWith('http') ? clean : `https://x.com${clean}`;
      });
    return [...new Set(urls)];
  });
}

const out = { steps: [] };
const started = Date.now();
await page.goto(`https://x.com/i/lists/${listId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);
let urls = await collectUrls();
out.steps.push({ t: Date.now()-started, phase: 'initial', count: urls.length, sample: urls.slice(0,3), last: urls.slice(-2) });

// pretend first page known
const known = new Set(urls);
let unknownTotal = [];
for (let i=0;i<12;i++) {
  await page.mouse.wheel(0, 2800 + i*200);
  await page.waitForTimeout(400);
  urls = await collectUrls();
  const unknown = urls.filter(u => !known.has(u));
  unknownTotal.push(...unknown);
  out.steps.push({ t: Date.now()-started, phase: `scroll-${i+1}`, visible: urls.length, unknown: unknown.length, last: urls.slice(-2), unknownSample: unknown.slice(0,2) });
  if (unknown.length >= 5) break;
}
unknownTotal = [...new Set(unknownTotal)];
out.unknownTotal = unknownTotal.length;
out.unknownSample = unknownTotal.slice(0, 8);
out.networkHits = networkHits.slice(0, 20);
out.finalUrl = page.url();
out.title = await page.title();
console.log(JSON.stringify(out, null, 2));
await browser.close();
