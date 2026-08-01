// WMB-1503 证据:真实数据根 + CDP 回读发布时间线/琥珀待确认/平台身份标签
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';

const CDP = 9339;
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
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '发布');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.final-preview, .pub-card', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1000);
await page.evaluate(() => document.querySelector('.timeline')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(600);
writeFileSync('.ai/wmb-1503-publish-timeline.png', await page.screenshot());
const readback = await page.evaluate(() => ({
  awaitingCard: !!document.querySelector('.pub-card.awaiting, .final-preview.awaiting'),
  amberPill: document.querySelector('.pill-status.amber')?.textContent ?? null,
  pfTags: [...document.querySelectorAll('.pf-tag')].map((el) => el.textContent?.trim()),
  timelineDots: [...document.querySelectorAll('.tl-dot')].map((el) => el.className.replace('tl-dot ', '')),
  confirmPanelState: document.querySelector('.confirmation-panel')?.getAttribute('data-state'),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify(readback, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(readback.awaitingCard && readback.timelineDots.length > 0 && !readback.overflow ? 0 : 1);
