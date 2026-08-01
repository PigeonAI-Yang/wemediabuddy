// WMB-1508 全链路溢出审计:8 个默认视图 + 改版子状态(入库资料/创作编辑器/组合台/设置分区) × 1100×700 与 1920×900
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';

// 复制 live 数据根 DB 到临时根,避免与运行中的 dev 实例争 MCP 端口
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1508-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
const liveRoot = 'J:\\PigeonYang\\WeMediaBuddyData';
for (const suffix of ['wmb.db', 'wmb.db-wal', 'wmb.db-shm']) {
  const from = path.join(liveRoot, suffix);
  if (existsSync(from)) copyFileSync(from, path.join(root, suffix));
}
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9344;
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
await page.waitForTimeout(1500);
const session = await page.context().newCDPSession(page);

const overflow = () => page.evaluate(() => {
  const worst = { doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, body: document.body.scrollWidth > document.body.clientWidth + 1, offenders: [] };
  if (worst.doc || worst.body) {
    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && (rect.right > document.documentElement.clientWidth + 2 || rect.left < -2)) {
        worst.offenders.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(rect.right)}`);
        if (worst.offenders.length >= 5) break;
      }
    }
  }
  return worst;
});
const clickSidebar = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === t);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, title);
const clickText = (selector, text) => page.evaluate(([sel, t]) => {
  const btn = Array.from(document.querySelectorAll(sel)).find((b) => b.textContent?.includes(t));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, [selector, text]);

const states = [
  { id: 'today', go: () => clickSidebar('今日') },
  { id: 'discover', go: () => clickSidebar('发现') },
  { id: 'studio', go: () => clickSidebar('创作') },
  { id: 'studio-editor', go: async () => { await clickSidebar('创作'); await page.waitForTimeout(400); await page.evaluate(() => document.querySelector('button.studio-project-row')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await page.waitForSelector('.studio-document', { timeout: 10000 }).catch(() => {}); } },
  { id: 'publish', go: () => clickSidebar('发布') },
  { id: 'results', go: () => clickSidebar('结果') },
  { id: 'knowledge', go: () => clickSidebar('知识系统') },
  { id: 'library', go: () => clickSidebar('资料库') },
  { id: 'library-saved', go: async () => { await clickSidebar('资料库'); await page.waitForTimeout(400); await clickText('.library-sections button', '入库资料'); await page.waitForSelector('.knowledge-toolbar .chip', { timeout: 10000 }).catch(() => {}); } },
  { id: 'canvas', go: () => clickSidebar('关系画布') },
  { id: 'settings-data', go: async () => { await clickSidebar('设置'); await page.waitForTimeout(500); await clickText('.settings-nav nav button', '数据与存储'); } },
  { id: 'settings-diag', go: async () => { await clickSidebar('设置'); await page.waitForTimeout(500); await clickText('.settings-nav nav button', '系统诊断'); } },
  { id: 'settings-ai', go: async () => { await clickSidebar('设置'); await page.waitForTimeout(500); await clickText('.settings-nav nav button', 'AI 与模型'); } }
];

const report = {};
for (const size of [{ w: 1100, h: 700 }, { w: 1920, h: 900 }]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(400);
  for (const state of states) {
    await state.go();
    await page.waitForTimeout(900);
    const result = await overflow();
    report[`${state.id}@${size.w}`] = result;
    writeFileSync(`.ai/wmb-1508-${state.id}-${size.w}.png`, await page.screenshot());
  }
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const bad = Object.entries(report).filter(([, value]) => value.doc || value.body);
console.log(bad.length ? `OVERFLOW FOUND: ${bad.map(([key]) => key).join(', ')}` : 'ALL CLEAR');
process.exit(bad.length ? 1 : 0);
