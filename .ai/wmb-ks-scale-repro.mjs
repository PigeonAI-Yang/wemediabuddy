// 复现:切到知识系统时领域卡片的尺寸/变换时间线
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createKnowledgeDomain } from '../src/main/knowledge.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-ksrepro-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
const database = migrateDatabase(path.join(root, 'wmb.db'));
const now = new Date().toISOString();
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('t1', 'Agent 工作流', now, now);
createKnowledgeDomain(database, { title: 'Agent、Skill 与工作流', description: 'AI Agent 工具链、MCP 生态、个人工作流搭建与实测。', status: 'active', topicIds: ['t1'] });
createKnowledgeDomain(database, { title: 'AI 接单与商业化', description: '报价、交付、甲方沟通的真实记录与方法论沉淀。', status: 'watching' });
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9352;
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
const session = await page.context().newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
await page.goto('file:///J:/PigeonYang/WeMediaBuddy/.vite/renderer/main_window/index.html');
await page.waitForSelector('.sidebar button', { state: 'attached', timeout: 45000 });
await page.waitForTimeout(1500);

const cardRect = () => page.evaluate(() => {
  const el = document.querySelector('.domain-card');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const content = document.querySelector('.ks-domain-content');
  const scroller = document.querySelector('.ks-domains');
  const shell = document.querySelector('.app-shell');
  return {
    w: Math.round(r.width * 10) / 10,
    contentW: content?.clientWidth,
    workspaceW: document.querySelector('.workspace')?.clientWidth,
    piW: document.querySelector('.pi-dock')?.getBoundingClientRect().width,
    shellCols: shell ? getComputedStyle(shell).gridTemplateColumns : null,
    bodyVScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight
  };
});
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '知识系统');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
for (let i = 0; i < 14; i++) {
  const rect = await cardRect();
  console.log(`t=${i * 40}ms`, JSON.stringify(rect));
  await page.waitForTimeout(40);
}
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(0);
