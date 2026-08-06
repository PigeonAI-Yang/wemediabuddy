import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outShot = path.join(root, '.ai', 'wmb-4918-feed-stable.png');
const cdpPort = 9360;

function killWmb() {
  const out = execSync('wmic process get ProcessId,CommandLine /FORMAT:CSV', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const kill = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/WeMediaBuddy/i.test(line)) continue;
    if (!/electron|node|esbuild/i.test(line)) continue;
    const pid = Number(line.split(',').at(-1));
    if (pid) kill.add(pid);
  }
  for (const pid of kill) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {} }
  return [...kill];
}

async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }
async function waitHttp(url, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (res.ok) return true; } catch {}
    await wait(400);
  }
  return false;
}

killWmb();
await wait(800);
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'start', '--', '--', `--remote-debugging-port=${cdpPort}`], {
  cwd: root, env: { ...process.env }, stdio: ['ignore', fs.openSync(path.join(root, '.wmb-dev.out.log'), 'w'), fs.openSync(path.join(root, '.wmb-dev.err.log'), 'w')], detached: true,
});
child.unref();
if (!(await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`))) process.exit(2);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools://')) || null;
  if (!page) await wait(500);
}
await page.setViewportSize({ width: 1600, height: 960 });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(6000);

const readCount = () => page.evaluate(() => document.querySelectorAll('.feed-item').length);

// Sample stability: 16 samples over ~6.5s at the default size.
const samples = [];
for (let i = 0; i < 16; i++) { samples.push(await readCount()); await wait(400); }
const stableDefault = new Set(samples).size === 1 && samples[0] > 0;

// Trigger a recompute: shrink viewport, sample again, then restore.
await page.setViewportSize({ width: 1600, height: 700 });
await wait(1200);
const shrunk = [];
for (let i = 0; i < 10; i++) { shrunk.push(await readCount()); await wait(400); }
const stableShrunk = new Set(shrunk).size === 1;

await page.setViewportSize({ width: 1600, height: 960 });
await wait(1200);
const restored = [];
for (let i = 0; i < 10; i++) { restored.push(await readCount()); await wait(400); }
const stableRestored = new Set(restored).size === 1;

await page.screenshot({ path: outShot });
const result = {
  samples, shrunk, restored,
  stableDefault, stableShrunk, stableRestored,
  oscillationFree: stableDefault && stableShrunk && stableRestored,
  shrinkReduced: shrunk[0] <= samples[0]
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.oscillationFree ? 0 : 3);
