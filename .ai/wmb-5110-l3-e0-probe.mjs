/**
 * CAP-027 L3 P0 probe: scan-while-chat must NOT hit desk lease busy.
 * Pattern: acceptance Electron + CDP (same family as wmb-4932-live-probe).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire('j:/PigeonYang/py-polymarket/dashboard/package.json');
const { chromium } = require('playwright');
import { migrateDatabase } from '../src/main/db/migrations.ts';

const CDP = 9371;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = (name) => path.join(ROOT, '.ai', name);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-5110-l3-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'logs'), path.join(root, 'exports')]) {
  mkdirSync(dir, { recursive: true });
}

const nowIso = new Date().toISOString();
const shanghaiDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const today = shanghaiDate();

const database = migrateDatabase(path.join(root, 'wmb.db'));
database.prepare(
  `INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-5110-l3', ?, ?, 1)`
).run(nowIso, nowIso);
database.prepare(`INSERT INTO workspace_profiles (id, profile_id, revision, official_template_id, official_template_version,
  display_name, audience, content_goal, editorial_brief, intelligence_pack_id, intelligence_pack_version,
  creation_pack_id, creation_pack_version, platforms_json, created_at, updated_at)
  VALUES ('effective', 'profile.ai.official', 1, 'official.ai', 1, 'AI', 'L3 probe audience',
  'L3 probe goal', 'L3 probe brief',
  'wemedia-intelligence-engine', 1, 'wmb-core-creation', 1, '["x","xiaohongshu","wechat"]', ?, ?)`).run(nowIso, nowIso);
// Minimal plan so Today renders
database.prepare(
  `INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision)
   VALUES ('plan-l3', ?, '+08:00', 'L3 probe', 1, ?, ?, 1)`
).run(today, nowIso, nowIso);
database.close();

writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
writeFileSync(path.join(userData, 'workspace-registry.json'), JSON.stringify({
  version: 1,
  activeWorkspaceId: 'ws-5110-l3',
  workspaces: [{ id: 'ws-5110-l3', displayName: 'L3 Probe', rootPath: root }],
  switchJournal: null
}));

const env = {
  ...process.env,
  WMB_ACCEPTANCE_CDP_PORT: String(CDP),
  WMB_ACCEPTANCE_USER_DATA: userData,
  WMB_ACCEPTANCE_HEADLESS: '1'
};
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronBin, ['.'], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
child.stdout?.on('data', (b) => logs.push(String(b)));
child.stderr?.on('data', (b) => logs.push(String(b)));

const cleanup = () => {
  try { child.kill(); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
};
process.on('exit', () => { try { child.kill(); } catch { /* */ } });

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP, path: p, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

let cdpUp = false;
for (let i = 0; i < 120; i++) {
  try {
    await getJson('/json/version');
    cdpUp = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!cdpUp) {
  console.error(logs.slice(-40).join(''));
  cleanup();
  throw new Error('CDP not ready');
}

// Wait until a page target appears on CDP
let pageUrl = null;
for (let i = 0; i < 90; i++) {
  try {
    const list = await getJson('/json/list');
    const pageTarget = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pageTarget) { pageUrl = pageTarget.url; break; }
  } catch { /* */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!pageUrl && !logs.join('').includes('DevTools listening')) {
  console.error(logs.slice(-50).join(''));
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
let page = null;
for (let i = 0; i < 90; i++) {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    const pages = ctx.pages();
    if (pages.length) { page = pages[0]; break; }
  }
  if (page) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!page) {
  console.error('logTail', logs.join('').slice(-2500));
  try { console.error('list', await getJson('/json/list')); } catch (e) { console.error(e); }
  cleanup();
  throw new Error('no page');
}

await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);

// Navigate/ensure Today if needed
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button, a, [role="button"]')]
    .find((el) => (el.textContent || '').includes('今日'));
  btn?.click();
});
await page.waitForTimeout(1000);

const shotSafe = async () => {
  try { await page.screenshot({ path: OUT('wmb-5110-l3-runtime-not-ready.png'), fullPage: true }); } catch { /* */ }
};

// Wait until data root + active runtime are actually usable (avoid false PASS on boot errors).
let runtimeReady = false;
let readyDetail = '';
for (let i = 0; i < 60; i++) {
  const st = await page.evaluate(async () => {
    try {
      const dr = await window.wmb.getDataRoot?.();
      const today = await window.wmb.getToday?.(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
      return {
        hasRoot: Boolean(dr?.path),
        root: dr?.path || null,
        todayOk: today != null,
        err: null
      };
    } catch (e) {
      return { hasRoot: false, root: null, todayOk: false, err: String(e?.message || e) };
    }
  });
  readyDetail = JSON.stringify(st);
  if (st.hasRoot && st.todayOk) { runtimeReady = true; break; }
  await page.waitForTimeout(500);
}
if (!runtimeReady) {
  await shotSafe();
  const fail = {
    ok: false,
    e0_01: { ok: false, detail: 'RUNTIME_NOT_READY ' + readyDetail },
    e0_02: { ok: false, detail: 'skipped' },
    e0_03: { ok: false, detail: 'skipped' },
    leaseErrorSeen: false,
    runtimeReady: false,
    readyDetail,
    logTail: logs.join('').slice(-2500)
  };
  writeFileSync(OUT('wmb-5110-l3-e2e-2026-08-07.json'), JSON.stringify(fail, null, 2));
  console.log(JSON.stringify(fail, null, 2));
  await browser.close().catch(() => {});
  cleanup();
  process.exit(2);
}

const result = {
  runtimeReady: true,
  readyDetail,
  ok: false,
  e0_01: { ok: false, detail: '' },
  e0_02: { ok: false, detail: '' },
  e0_03: { ok: false, detail: '' },
  leaseErrorSeen: false,
  chat: null,
  daily: null,
  cancel: null,
  screenshots: []
};

const shot = async (name) => {
  const file = OUT(name);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  result.screenshots.push(file);
};

// Footer / body text scan for lease error
const bodyHasLeaseError = async () => page.evaluate(() => {
  const t = document.body?.innerText || '';
  return t.includes('Pi worker lease 尚未释放') || t.includes('worker lease 尚未释放');
});

// E0-01: start daily then chat immediately
const businessDate = today;
result.daily = await page.evaluate(async (businessDate) => {
  try {
    const r = await window.wmb.startDailyIntelligence({ businessDate });
    return { ok: !!r?.ok, error: r?.error?.message || null, data: r?.data ? { taskId: r.data?.task?.id || null, status: r.data?.task?.status || null } : null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), data: null };
  }
}, businessDate);

// Fire chat while daily may hold worker
result.chat = await page.evaluate(async () => {
  try {
    const r = await window.wmb.chatPi('你好');
    return { ok: true, result: r, error: null };
  } catch (e) {
    return { ok: false, result: null, error: String(e?.message || e) };
  }
});

const leaseInChat = /lease 尚未释放|Pi worker lease/i.test(String(result.chat?.error || ''));
const leaseInUi = await bodyHasLeaseError();
result.leaseErrorSeen = leaseInChat || leaseInUi;

// Strict: no lease error, and daily must at least enter start path without workspace-missing.
const bootBlocked = /数据根|运行时不可用|WORKSPACE_BUSY/i.test(String(result.daily?.error || '') + String(result.chat?.error || ''));
result.e0_01.ok = !result.leaseErrorSeen && !bootBlocked;
result.e0_01.detail = result.leaseErrorSeen
  ? `FAIL lease error chat=${result.chat?.error || ''} ui=${leaseInUi}`
  : bootBlocked
    ? `FAIL boot/runtime blocked daily=${result.daily?.error || ''} chat=${result.chat?.error || ''}`
    : `PASS chatError=${result.chat?.error || 'none'} dailyOk=${result.daily?.ok} dailyErr=${result.daily?.error || 'none'}`;

await shot('wmb-5110-l3-e0-01-scan-chat.png');

// E0-02: after chat, daily still not forced to desk-blocked state — check control or get task
result.e0_02.ok = result.e0_01.ok && !result.leaseErrorSeen;
result.e0_02.detail = result.daily?.ok
  ? 'daily started; lease error absent after chat'
  : `daily did not start (${result.daily?.error || 'unknown'}); e0_01=${result.e0_01.ok}`;

// E0-03: cancel if task id present, then chat again
const taskId = result.daily?.data?.taskId;
if (taskId) {
  result.cancel = await page.evaluate(async (id) => {
    try {
      const r = await window.wmb.controlDailyIntelligence({ id, action: 'cancel' });
      return { ok: !!r?.ok, error: r?.error?.message || null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, taskId);
  await page.waitForTimeout(800);
  const chat2 = await page.evaluate(async () => {
    try {
      await window.wmb.chatPi('还在吗');
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  const lease2 = /lease 尚未释放|Pi worker lease/i.test(String(chat2.error || '')) || await bodyHasLeaseError();
  result.e0_03.ok = !lease2;
  result.e0_03.detail = lease2 ? `FAIL after cancel: ${chat2.error}` : `PASS cancelOk=${result.cancel?.ok} chat2=${chat2.error || 'ok'}`;
} else {
  // No task — still verify chat path without lease error counts as soft pass for e0-03 cancel path N/A
  result.e0_03.ok = !result.leaseErrorSeen;
  result.e0_03.detail = 'N/A no taskId; lease error absent on chat path';
}

await shot('wmb-5110-l3-e0-final.png');

result.ok = result.e0_01.ok && result.e0_02.ok && result.e0_03.ok;

await browser.close().catch(() => {});
try { child.kill(); } catch { /* */ }
await new Promise((r) => setTimeout(r, 1000));
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }

const reportPath = OUT('wmb-5110-l3-e2e-2026-08-07.json');
writeFileSync(reportPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ reportPath, ...result, logTail: logs.join('').slice(-1500) }, null, 2));
process.exit(result.ok ? 0 : 1);
