// WMB-1511 边距修复后截图:发布/结果/今日/发现 @1920
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1511s-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
const liveRoot = 'J:\\PigeonYang\\WeMediaBuddyData';
for (const suffix of ['wmb.db', 'wmb.db-wal', 'wmb.db-shm']) {
  const from = path.join(liveRoot, suffix);
  if (existsSync(from)) copyFileSync(from, path.join(root, suffix));
}
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
const CDP = 9361;
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP), WMB_ACCEPTANCE_USER_DATA: userData };
delete env.WMB_ACCEPTANCE_HEADLESS;
const electronBin = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electronBin, ['.'], { env, cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', () => {});
const cleanup = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} };
process.on('exit', cleanup);
const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
});
for (let i = 0; i < 240; i++) { try { await getJson('/json/version'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
const page = browser.contexts()[0].pages()[0];
await page.goto('file:///J:/PigeonYang/WeMediaBuddy/.vite/renderer/main_window/index.html');
await page.waitForSelector('.sidebar button', { state: 'attached', timeout: 45000 });
await page.waitForTimeout(1200);
const session = await page.context().newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(400);
const clickSidebar = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === t);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, title);
for (const [title, id] of [['发布', 'publish'], ['结果', 'results'], ['今日', 'today'], ['发现', 'discover']]) {
  await clickSidebar(title);
  await page.waitForTimeout(1400);
  writeFileSync(`.ai/wmb-1511-${id}.png`, await page.screenshot());
}
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1200));
process.exit(0);
