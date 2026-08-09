import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-4932-dbg-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const d of [root, userData]) mkdirSync(d, { recursive: true });
const db = migrateDatabase(path.join(root, 'wmb.db'));
const now = new Date().toISOString();
db.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id','ws-4932-fixture',?,?,1)`).run(now, now);
db.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9367;
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' };
const electronBin = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electronBin, ['.'], { env, cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[app] ' + d));
const cleanup = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const getJson = (p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: CDP, path: p }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
});
let up = false;
for (let i = 0; i < 240 && !up; i++) { try { await getJson('/json/version'); up = true; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
console.log('CDP up:', up);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
const context = browser.contexts()[0];
let page = context?.pages()[0] ?? null;
for (let i = 0; i < 60 && !page; i++) { await new Promise((r) => setTimeout(r, 500)); page = context?.pages()[0] ?? null; }
if (!page) { console.log('NO PAGE'); process.exit(1); }
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') console.log('[console]', msg.type(), msg.text().slice(0, 500)); });
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 800)));
page.on('crash', () => console.log('[crash] renderer crashed'));
page.on('requestfailed', (req) => console.log('[reqfail]', req.url().slice(0, 200), String(req.failure()?.errorText ?? '').slice(0, 200)));
page.on('response', (res) => { if (res.status() >= 400) console.log('[http]', res.status(), res.url().slice(0, 200)); });
console.log('URL:', page.url());
await new Promise((r) => setTimeout(r, 12000));
const info = await page.evaluate(() => ({
  title: document.title,
  readyState: document.readyState,
  html: document.documentElement?.outerHTML?.slice(0, 1200) ?? '(none)',
  resources: performance.getEntriesByType('resource').map((e) => e.name.slice(-80)).join('|'),
  bodyChildren: document.body?.children.length ?? -1,
  rootChildren: document.querySelector('#root')?.children.length ?? -1
}));
console.log(JSON.stringify(info, null, 1));
console.log('page closed?', page.isClosed());
try { await page.reload({ waitUntil: 'load' }); console.log('reload ok'); } catch (e) { console.log('reload err', String(e).slice(0, 200)); }
await new Promise((r) => setTimeout(r, 8000));
const after = await page.evaluate(() => ({ readyState: document.readyState, rootChildren: document.querySelector('#root')?.children.length ?? -1, bodyLen: document.body?.innerText?.length ?? -1 }));
console.log('after reload:', JSON.stringify(after));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(0);
