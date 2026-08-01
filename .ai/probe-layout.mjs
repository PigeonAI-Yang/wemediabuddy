import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function killWmb() {
  const out = execSync('wmic process get ProcessId,CommandLine /FORMAT:CSV', {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  const kill = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/WeMediaBuddy/i.test(line)) continue;
    if (!/electron|node|esbuild/i.test(line)) continue;
    const parts = line.split(',');
    const pid = Number(parts.at(-1));
    if (pid) kill.add(pid);
  }
  for (const pid of kill) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  return [...kill];
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {}
    await wait(500);
  }
  return false;
}

const killed = killWmb();
console.log('killed', killed);
await wait(1000);

const outLog = path.join(root, '.wmb-dev.out.log');
const errLog = path.join(root, '.wmb-dev.err.log');
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'start', '--', '--', '--remote-debugging-port=9222'], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', fs.openSync(outLog, 'w'), fs.openSync(errLog, 'w')],
  detached: true
});
child.unref();
console.log('spawned', child.pid);

const rendererReady = await waitHttp('http://127.0.0.1:27391/');
console.log('rendererReady', rendererReady);
const cdpReady = await waitHttp('http://127.0.0.1:9222/json/version');
console.log('cdpReady', cdpReady);

if (!cdpReady) {
  console.log('out', fs.readFileSync(outLog, 'utf8').slice(-800));
  console.log('err', fs.readFileSync(errLog, 'utf8').slice(-800));
  process.exit(2);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`PAGEERROR ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE ${msg.text()}`);
});

// ensure on app url
const url = page.url();
console.log('page.url', url);
if (!/27391|WeMediaBuddy|localhost|127\.0\.0\.1/.test(url)) {
  await page.goto('http://127.0.0.1:27391/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
}
await wait(2500);

const info = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      sel,
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      width: Math.round(r.width),
      height: Math.round(r.height),
      left: Math.round(r.left),
      className: el.className
    };
  };
  return {
    href: location.href,
    title: document.title,
    styleCount: document.querySelectorAll('style').length,
    styleLens: [...document.querySelectorAll('style')].map((s) => (s.textContent || '').length),
    appShell: pick('.app-shell'),
    workspace: pick('.workspace'),
    todayMain: pick('.today-main'),
    todayGrid: pick('.today-grid'),
    todayOpps: pick('.today-opps'),
    todayRail: pick('.today-rail'),
    statStrip: pick('.stat-strip'),
    primary: pick('.opportunity-primary'),
    bodySnippet: (document.body?.innerText || '').slice(0, 200)
  };
});

console.log(JSON.stringify({ info, errors }, null, 2));
await page.screenshot({ path: path.join(root, '.ai', 'layout-probe-electron.png') });
await browser.close();
