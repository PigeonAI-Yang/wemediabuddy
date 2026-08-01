
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { readXListIndex } = await import('../src/main/platforms/x-list-browser.ts');
const { XListSession } = await import('../src/main/platforms/x-list-session.ts');

const config = { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334' };
const results = [];

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

async function setStartPage(kind) {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  try {
    const page = browser.contexts()[0].pages().find(p => /x\.com/i.test(p.url())) || browser.contexts()[0].pages()[0];
    if (!page) throw new Error('no page');
    if (kind === 'management') {
      await page.goto('https://x.com/KimbomArtist/lists', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else if (kind === 'list-detail') {
      await page.goto('https://x.com/i/lists/2082177169078251627', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else if (kind === 'home') {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else if (kind === 'explore') {
      await page.goto('https://x.com/explore', { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    await page.waitForTimeout(800);
    return page.url();
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runCase(name, fn) {
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = Math.round(performance.now() - t0);
    const row = { name, ok: true, ms, detail: value };
    results.push(row);
    console.log(JSON.stringify(row));
    return row;
  } catch (error) {
    const ms = Math.round(performance.now() - t0);
    const row = { name, ok: false, ms, error: error instanceof Error ? error.message : String(error) };
    results.push(row);
    console.log(JSON.stringify(row));
    return row;
  }
}

// Boundary matrix: different starting pages
for (const kind of ['management', 'list-detail', 'home', 'explore']) {
  const startUrl = await setStartPage(kind);
  await runCase(`boundary:start=${kind}`, async () => {
    const result = await readXListIndex(config);
    if (!result.lists?.length) throw new Error('empty lists');
    if (!/^@/.test(result.accountKey)) throw new Error('bad accountKey');
    return { startUrl, accountKey: result.accountKey, count: result.lists.length, names: result.lists.map(x => x.name) };
  });
}

// Pressure: repeated refresh from management page (user spam-click style)
await setStartPage('management');
const latencies = [];
for (let i = 1; i <= 5; i += 1) {
  const row = await runCase(`pressure:repeat#${i}`, async () => {
    const result = await readXListIndex(config);
    if (result.lists.length < 1) throw new Error('empty');
    return { count: result.lists.length };
  });
  if (row.ok) latencies.push(row.ms);
  // small gap like human double-check, not full cooldown bypass
  await new Promise(r => setTimeout(r, 300));
}

// Concurrency: second call while first in-flight (latest-wins / no hard hang)
await setStartPage('list-detail');
await runCase('pressure:concurrent-double', async () => {
  const a = readXListIndex(config);
  await new Promise(r => setTimeout(r, 200));
  const b = readXListIndex(config);
  const settled = await Promise.allSettled([a, b]);
  const summary = settled.map((item, idx) => {
    if (item.status === 'fulfilled') {
      return { idx, ok: true, count: item.value.lists.length, accountKey: item.value.accountKey };
    }
    return { idx, ok: false, error: item.reason instanceof Error ? item.reason.message : String(item.reason) };
  });
  // At least one must succeed with lists. The other may be superseded/timeout; must not hang forever.
  if (!summary.some(item => item.ok && item.count > 0)) {
    throw new Error(`no successful concurrent result: ${JSON.stringify(summary)}`);
  }
  return summary;
});

// Final health from cold-ish list detail again
await setStartPage('list-detail');
await runCase('final:from-list-detail', async () => {
  const result = await readXListIndex(config);
  return { count: result.lists.length, sample: result.lists.slice(0, 3) };
});

const ok = results.filter(r => r.ok);
const fail = results.filter(r => !r.ok);
const sorted = [...latencies].sort((a,b)=>a-b);
const report = {
  total: results.length,
  passed: ok.length,
  failed: fail.length,
  failNames: fail.map(r => r.name),
  pressure: {
    n: latencies.length,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? null,
    allMs: latencies
  },
  hardGate: {
    allBoundaryPass: results.filter(r => r.name.startsWith('boundary:')).every(r => r.ok),
    pressurePass: latencies.length >= 4 && (sorted[sorted.length - 1] ?? 1e9) < 45_000,
    concurrentPass: results.find(r => r.name === 'pressure:concurrent-double')?.ok === true,
    finalPass: results.find(r => r.name === 'final:from-list-detail')?.ok === true
  }
};
report.ok = report.hardGate.allBoundaryPass && report.hardGate.pressurePass && report.hardGate.concurrentPass && report.hardGate.finalPass && fail.length === 0;
console.log('REPORT ' + JSON.stringify(report, null, 2));
if (!report.ok) process.exit(2);
