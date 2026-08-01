// WMB-1504 证据:真实数据根 + CDP 回读结果视图指标卡/采集窗口表/评审列着色
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';

const CDP = 9340;
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
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '结果');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.metric-card', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
writeFileSync('.ai/wmb-1504-results-cards.png', await page.screenshot());
await page.evaluate(() => document.querySelector('.review-grid, .review-cols')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(600);
writeFileSync('.ai/wmb-1504-results-review.png', await page.screenshot());
const readback = await page.evaluate(() => ({
  metricCards: [...document.querySelectorAll('.metric-card .metric-value')].map((el) => el.textContent),
  sparkBars: document.querySelectorAll('.metric-card .spark i').length,
  hotBars: document.querySelectorAll('.metric-card .spark i.hot').length,
  snapRows: document.querySelectorAll('.snap-table tbody tr').length,
  snapPills: [...document.querySelectorAll('.snap-table .pill-status')].map((el) => el.textContent?.trim()),
  reviewLabelColors: [...document.querySelectorAll('.review-grid.editable label > span, .review-col h4')].map((el) => getComputedStyle(el).color),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify(readback, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(readback.metricCards.length > 0 && readback.snapRows > 0 && !readback.overflow ? 0 : 1);
