
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { readXListIndex } = await import('../src/main/platforms/x-list-browser.ts');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { readXListIndexCache, writeXListIndexCache } = await import('../src/main/x-list-cache.ts');

const config = { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334' };
const dbPath = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';

async function setStart(kind) {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  try {
    const page = browser.contexts()[0].pages().find(p => /x\.com/i.test(p.url())) || browser.contexts()[0].pages()[0];
    const url = kind === 'detail' ? 'https://x.com/i/lists/2082177169078251627'
      : kind === 'home' ? 'https://x.com/home'
      : 'https://x.com/KimbomArtist/lists';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(500);
    return page.url();
  } finally { await browser.close().catch(()=>{}); }
}

function getCached() {
  const database = migrateDatabase(dbPath);
  try { return readXListIndexCache(database); }
  finally { database.close(); }
}

async function uiMountOnce(label, startKind) {
  const startUrl = await setStart(startKind);
  const t0 = performance.now();
  const cached = getCached();
  const hasCache = Boolean(cached?.lists?.length);
  try {
    const next = await readXListIndex(config);
    // write cache like IPC
    const database = migrateDatabase(dbPath);
    try { writeXListIndexCache(database, next); } finally { database.close(); }
    const ms = Math.round(performance.now() - t0);
    const row = {
      label, ok: true, ms, startUrl, hasCache,
      cacheCount: cached?.lists?.length ?? 0,
      liveCount: next.lists.length,
      note: `已更新 ${next.accountKey} 的 ${next.lists.length} 个可见 List。`
    };
    console.log(JSON.stringify(row));
    return row;
  } catch (error) {
    const ms = Math.round(performance.now() - t0);
    const message = error instanceof Error ? error.message : String(error);
    const short = /超时/.test(message) ? '后台刷新超时' : (/占用|冷却/.test(message) ? '后台繁忙' : '后台刷新失败');
    const note = hasCache
      ? `${short}，继续显示缓存 · ${cached.lists.length} 个 List。`
      : message;
    const row = { label, ok: false, ms, startUrl, hasCache, note, error: message };
    console.log(JSON.stringify(row));
    return row;
  }
}

const rows = [];
// UI-like mounts from common entry states
for (const kind of ['detail', 'management', 'home']) {
  rows.push(await uiMountOnce(`mount:from-${kind}`, kind));
}
// spam refresh 3 times like user clicking refresh
await setStart('detail');
for (let i=1;i<=3;i++) {
  rows.push(await uiMountOnce(`refresh#${i}`, 'detail'));
  await new Promise(r => setTimeout(r, 200));
}

const failed = rows.filter(r => !r.ok);
const report = {
  total: rows.length,
  passed: rows.length - failed.length,
  failed: failed.length,
  failNotes: failed.map(r => r.note),
  maxMs: Math.max(...rows.map(r => r.ms)),
  allUpdatedNote: rows.every(r => r.ok && /已更新/.test(r.note)),
  ok: failed.length === 0 && rows.every(r => r.ok && r.liveCount >= 1 && r.ms < 45000)
};
console.log('REPORT ' + JSON.stringify(report, null, 2));
if (!report.ok) process.exit(2);
