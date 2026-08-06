import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outShot = path.join(root, '.ai', 'browser-settings-after.png');
const outAiShot = path.join(root, '.ai', 'ai-settings-after.png');
const cdpPort = 9337;

function killWmb() {
  const out = execSync('wmic process get ProcessId,CommandLine /FORMAT:CSV', {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
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
if (!cdpReady) {
  console.log('out', fs.readFileSync(outLog, 'utf8').slice(-1200));
  console.log('err', fs.readFileSync(errLog, 'utf8').slice(-1200));
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  const context = browser.contexts()[0];
  page = context?.pages().find((p) => !p.url().startsWith('devtools://')) || null;
  if (!page) await wait(500);
}
if (!page) {
  console.log('no page yet', browser.contexts().map((c) => c.pages().map((p) => p.url())));
  process.exit(4);
}
const errors = [];
page.on('pageerror', (err) => errors.push(`PAGEERROR ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE ${msg.text()}`);
});

await wait(2500);
if (!/27391|WeMediaBuddy|localhost|127\.0\.0\.1/.test(page.url())) {
  await page.goto('http://127.0.0.1:27391/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await wait(2000);
}

await page.waitForSelector('.app-shell, .settings-workspace, button', { timeout: 20000 });

const clickByText = async (re) => {
  const handle = await page.evaluateHandle((patternSource) => {
    const pattern = new RegExp(patternSource, 'i');
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], .nav-item, .settings-nav button'));
    return nodes.find((el) => pattern.test((el.textContent || '').replace(/\s+/g, ' ').trim())) || null;
  }, re.source);
  const el = handle.asElement();
  if (!el) throw new Error(`control not found: ${re}`);
  await el.click();
};

// Open settings if needed.
const alreadySettings = await page.$('.settings-workspace');
if (!alreadySettings) {
  await clickByText(/设置/);
  await page.waitForSelector('.settings-workspace', { timeout: 15000 });
}

// AI page reference shot
await clickByText(/AI\s*与模型|AI/);
await page.waitForSelector('.settings-profile-list, .settings-form', { timeout: 10000 });
await wait(400);
await page.screenshot({ path: outAiShot, fullPage: false });

// Browser page target shot
await clickByText(/浏览器与账号/);
await page.waitForSelector('.settings-status-card, .settings-form-actions', { timeout: 10000 });
await wait(500);
await page.screenshot({ path: outShot, fullPage: false });

const info = await page.evaluate(() => {
  const text = (document.body?.innerText || '');
  const buttons = Array.from(document.querySelectorAll('.settings-content button')).map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '));
  return {
    title: document.title,
    href: location.href,
    hasStatusCard: Boolean(document.querySelector('.settings-status-card')),
    hasMetaGrid: Boolean(document.querySelector('.settings-meta-grid')),
    sectionHeadings: Array.from(document.querySelectorAll('.settings-section-heading h3')).map((el) => el.textContent || ''),
    formActionGroups: document.querySelectorAll('.settings-form-actions').length,
    browserControlsLegacy: Boolean(document.querySelector('.settings-browser-controls')),
    buttons,
    snippet: text.slice(0, 1200),
  };
});

console.log(JSON.stringify({ info, errors, outShot, outAiShot }, null, 2));
await browser.close();
if (!info.hasStatusCard || info.browserControlsLegacy || info.formActionGroups < 2) {
  process.exit(3);
}
