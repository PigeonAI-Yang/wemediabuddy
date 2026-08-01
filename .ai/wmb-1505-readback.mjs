// WMB-1505 证据:真实数据根 + CDP 回读资料库筛选芯片/行状态丸/分页 + 领域地图状态丸
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';

const CDP = 9341;
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP) };
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
const nav = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === t);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, title);

await nav('资料库');
await page.waitForSelector('.library-sections button', { state: 'attached', timeout: 20000 });
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.library-sections button')).find((b) => b.textContent?.includes('入库资料'));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.knowledge-toolbar .chip', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
writeFileSync('.ai/wmb-1505-library-saved.png', await page.screenshot());
const libReadback = await page.evaluate(() => ({
  chips: document.querySelectorAll('.knowledge-toolbar .chip').length,
  chipsOn: document.querySelectorAll('.knowledge-toolbar .chip.on').length,
  selectsInToolbar: document.querySelectorAll('.knowledge-toolbar select').length,
  rowPills: [...document.querySelectorAll('.lib-side .pill-status')].map((el) => el.textContent?.trim()).slice(0, 6),
  pager: document.querySelector('.knowledge-pager span')?.textContent?.trim() ?? null
}));

await nav('知识系统');
await page.waitForSelector('.ks-domain-row, .domain-card', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
writeFileSync('.ai/wmb-1505-domains.png', await page.screenshot());
const domainReadback = await page.evaluate(() => ({
  domainPills: [...document.querySelectorAll('.ks-domain-row aside .pill-status, .domain-card .pill-status')].map((el) => el.textContent?.trim()),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify({ ...libReadback, ...domainReadback }, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(libReadback.chips >= 8 && libReadback.selectsInToolbar === 0 && !domainReadback.overflow ? 0 : 1);
