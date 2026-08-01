// WMB-1507 证据:真实数据根 + CDP 回读设置视图数据行/服务行/健康丸
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';

const CDP = 9343;
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
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '设置');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.settings-nav nav button', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(800);
const gotoSection = async (label) => page.evaluate((text) => {
  const btn = Array.from(document.querySelectorAll('.settings-nav nav button')).find((b) => b.textContent?.includes(text));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, label);

await gotoSection('数据与存储');
await page.waitForTimeout(800);
writeFileSync('.ai/wmb-1507-data.png', await page.screenshot());
const dataReadback = await page.evaluate(() => ({
  pathChip: document.querySelector('.path-chip')?.textContent?.trim() ?? null,
  rows: [...document.querySelectorAll('.settings-row h3')].map((el) => el.textContent),
  pills: [...document.querySelectorAll('.settings-row .pill-status')].map((el) => el.textContent?.trim())
}));
await gotoSection('Agent 接入');
await page.waitForTimeout(800);
const agentReadback = await page.evaluate(() => ({
  servicePill: document.querySelector('.settings-row .pill-status')?.textContent?.trim() ?? null
}));
await gotoSection('系统诊断');
await page.waitForTimeout(800);
writeFileSync('.ai/wmb-1507-diagnostics.png', await page.screenshot());
const diagReadback = await page.evaluate(() => ({
  diagPills: [...document.querySelectorAll('.diagnostic-list .pill-status')].map((el) => el.textContent?.trim()),
  diagPillColors: [...document.querySelectorAll('.diagnostic-list .pill-status')].map((el) => getComputedStyle(el).color),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify({ ...dataReadback, ...agentReadback, ...diagReadback }, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(dataReadback.pathChip && agentReadback.servicePill && diagReadback.diagPills.length === 3 && !diagReadback.overflow ? 0 : 1);
