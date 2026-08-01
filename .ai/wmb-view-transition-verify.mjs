// 视图过渡 + 滚动记忆验证(live DB 副本)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-vt-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
for (const suffix of ['wmb.db', 'wmb.db-wal', 'wmb.db-shm']) {
  const from = path.join('J:\\PigeonYang\\WeMediaBuddyData', suffix);
  if (existsSync(from)) copyFileSync(from, path.join(root, suffix));
}
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9351;
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
const nav = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === t);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, title);

// A:切换后内容区元素带有 view-in 动画
await nav('发布');
await page.waitForTimeout(300);
const anim = await page.evaluate(() => {
  const el = document.querySelector('.workspace > *');
  const cs = getComputedStyle(el);
  return { name: cs.animationName, duration: cs.animationDuration };
});

// B:发布页滚到底 → 切今日 → 切回发布 → 滚动位置恢复
await page.waitForTimeout(1200);
const scrollInfo = await page.evaluate(() => {
  const candidates = [document.querySelector('.workspace'), ...document.querySelectorAll('.workspace *')];
  const scroller = candidates.find((el) => el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  if (!scroller) return { found: false };
  scroller.scrollTop = scroller.scrollHeight;
  return { found: true, top: scroller.scrollTop, cls: scroller.className };
});
await page.waitForTimeout(300);
await nav('今日');
await page.waitForTimeout(800);
await nav('发布');
await page.waitForTimeout(1200);
const restored = await page.evaluate((cls) => {
  const el = document.getElementsByClassName(cls)[0];
  return el ? el.scrollTop : -1;
}, scrollInfo.cls ?? '');
console.log(JSON.stringify({ anim, scrollInfo, restored }));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const aOk = anim.name === 'view-in' && parseFloat(anim.duration) <= 0.2;
const bOk = scrollInfo.found && scrollInfo.top > 200 && Math.abs(restored - scrollInfo.top) <= 4;
console.log(JSON.stringify({ aOk, bOk }));
process.exit(aOk && bOk ? 0 : 1);
