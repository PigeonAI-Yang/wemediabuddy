import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outShot = path.join(root, '.ai', 'today-pool-after.png');
const cdpPort = 9360;

function killWmb() {
  const out = execSync('wmic process get ProcessId,CommandLine /FORMAT:CSV', {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const kill = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/WeMediaBuddy/i.test(line)) continue;
    if (!/electron|node|esbuild/i.test(line)) continue;
    const pid = Number(line.split(',').at(-1));
    if (pid) kill.add(pid);
  }
  for (const pid of kill) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  return [...kill];
}

async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function waitHttp(url, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {}
    await wait(400);
  }
  return false;
}

const killed = killWmb();
console.log('killed', killed);
await wait(800);

const outLog = path.join(root, '.wmb-dev.out.log');
const errLog = path.join(root, '.wmb-dev.err.log');
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'start', '--', '--', `--remote-debugging-port=${cdpPort}`], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', fs.openSync(outLog, 'w'), fs.openSync(errLog, 'w')],
  detached: true,
});
child.unref();
console.log('spawned', child.pid);

const rendererReady = await waitHttp('http://127.0.0.1:27391/');
const cdpReady = await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`);
console.log({ rendererReady, cdpReady });
if (!cdpReady) process.exit(2);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  const context = browser.contexts()[0];
  page = context?.pages().find((p) => !p.url().startsWith('devtools://')) || null;
  if (!page) await wait(500);
}
if (!page) process.exit(4);
const errors = [];
page.on('pageerror', (err) => errors.push(`PAGEERROR ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`CONSOLE ${msg.text()}`); });

await wait(3000);
await page.setViewportSize({ width: 1600, height: 960 });
await wait(1500);

const info = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-opportunity-card]')].map((el) => ({
    title: (el.querySelector('.opp-title, h2')?.textContent || '').trim().slice(0, 60),
    pills: [...el.querySelectorAll('.pill')].map((pill) => pill.textContent?.trim() ?? ''),
    dismiss: Boolean(el.querySelector('.opp-dismiss'))
  }));
  return {
    title: document.title,
    cardCount: cards.length,
    cards: cards.slice(0, 8),
    absentBanner: document.querySelector('.pool-absent-banner')?.textContent?.trim() ?? null,
    newPills: document.querySelectorAll('.pill.pool-new').length,
    breakingPills: document.querySelectorAll('.pill.pool-breaking').length,
    hotPills: document.querySelectorAll('.pill.pool-hot').length,
    evergreenPills: document.querySelectorAll('.pill.pool-evergreen').length,
    demotionPills: document.querySelectorAll('.pill.pool-demotion').length,
    dismissButtons: document.querySelectorAll('.opp-dismiss').length,
    bodySnippet: (document.body?.innerText || '').slice(0, 400)
  };
});
await page.screenshot({ path: outShot });
console.log(JSON.stringify({ info, errors, outShot }, null, 2));
await browser.close();
