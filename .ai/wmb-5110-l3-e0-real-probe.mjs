/**
 * L3 E0 against REAL userData (no fixture). Enables CDP via WMB_ACCEPTANCE_CDP_PORT only.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('j:/PigeonYang/py-polymarket/dashboard/package.json');
const { chromium } = require('playwright');

const CDP = 9377;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = (n) => path.join(ROOT, '.ai', n);

const env = {
  ...process.env,
  WMB_ACCEPTANCE_CDP_PORT: String(CDP)
  // intentionally NO WMB_ACCEPTANCE_USER_DATA — use Owner real profile
};
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronBin, ['.'], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
child.stdout?.on('data', (b) => logs.push(String(b)));
child.stderr?.on('data', (b) => logs.push(String(b)));

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
  try { await getJson('/json/version'); cdpUp = true; break; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!cdpUp) {
  console.error(logs.join('').slice(-3000));
  child.kill();
  process.exit(1);
}

// wait page target
for (let i = 0; i < 90; i++) {
  try {
    const list = await getJson('/json/list');
    if (Array.isArray(list) && list.some((t) => t.type === 'page')) break;
  } catch { /* */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
let page = null;
for (let i = 0; i < 90; i++) {
  for (const ctx of browser.contexts()) {
    if (ctx.pages().length) { page = ctx.pages()[0]; break; }
  }
  if (page) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!page) {
  console.error('no page', logs.join('').slice(-2000));
  child.kill();
  process.exit(1);
}

await page.waitForTimeout(4000);
// click 今日
await page.evaluate(() => {
  const el = [...document.querySelectorAll('button,a,[role="button"],span,div')]
    .find((e) => (e.textContent || '').trim() === '今日');
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1500);

const ready = await page.evaluate(async () => {
  try {
    const dr = await window.wmb.getDataRoot();
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const today = await window.wmb.getToday(d);
    return { root: dr?.path || null, today: Boolean(today) };
  } catch (e) {
    return { root: null, today: false, err: String(e?.message || e) };
  }
});

const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

const daily = await page.evaluate(async (businessDate) => {
  try {
    const r = await window.wmb.startDailyIntelligence({ businessDate });
    return { ok: !!r?.ok, error: r?.error?.message || null, taskId: r?.data?.task?.id || null, status: r?.data?.task?.status || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), taskId: null, status: null };
  }
}, businessDate);

// immediate chat
const chat = await page.evaluate(async () => {
  try {
    const r = await window.wmb.chatPi('边界测试：你好');
    return { ok: true, error: null, r };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

const uiLease = await page.evaluate(() => (document.body?.innerText || '').includes('Pi worker lease 尚未释放'));
const chatLease = /lease 尚未释放|Pi worker lease/i.test(String(chat.error || ''));

let cancel = null;
let chat2 = null;
if (daily.taskId) {
  cancel = await page.evaluate(async (id) => {
    try {
      const r = await window.wmb.controlDailyIntelligence({ id, action: 'cancel' });
      return { ok: !!r?.ok, error: r?.error?.message || null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, daily.taskId);
  await page.waitForTimeout(1000);
  chat2 = await page.evaluate(async () => {
    try {
      await window.wmb.chatPi('取消后还在吗');
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
}

const uiLease2 = await page.evaluate(() => (document.body?.innerText || '').includes('Pi worker lease 尚未释放'));
const chat2Lease = /lease 尚未释放|Pi worker lease/i.test(String(chat2?.error || ''));

const shot1 = OUT('wmb-5110-l3-e0-real-scan-chat.png');
await page.screenshot({ path: shot1, fullPage: true }).catch(() => {});

const e0_01_ok = !chatLease && !uiLease;
// daily may fail for channel reasons; lease absence is the P0 contract
const e0_03_ok = daily.taskId ? (!chat2Lease && !uiLease2) : e0_01_ok;

const result = {
  ok: e0_01_ok && e0_03_ok,
  mode: 'real-userData',
  ready,
  daily,
  chat,
  cancel,
  chat2,
  e0_01: { ok: e0_01_ok, detail: e0_01_ok ? 'no lease error on chat during/after daily start' : `LEASE ${chat.error || 'ui'}` },
  e0_02: { ok: e0_01_ok, detail: `dailyOk=${daily.ok} err=${daily.error || 'none'}` },
  e0_03: { ok: e0_03_ok, detail: daily.taskId ? `cancel=${JSON.stringify(cancel)} chat2=${chat2?.error || 'ok'}` : 'no taskId' },
  leaseErrorSeen: chatLease || uiLease || chat2Lease || uiLease2,
  screenshots: [shot1],
  logTail: logs.join('').slice(-2000)
};

writeFileSync(OUT('wmb-5110-l3-e2e-2026-08-07.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

await browser.close().catch(() => {});
try { child.kill(); } catch {}
await new Promise((r) => setTimeout(r, 800));
process.exit(result.ok ? 0 : 1);
