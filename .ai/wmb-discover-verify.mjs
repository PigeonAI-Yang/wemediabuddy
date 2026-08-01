// 发现页验证:榜单渲染 + 「入库」动作真实写入资料库(live DB 副本)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-discover-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
for (const suffix of ['wmb.db', 'wmb.db-wal', 'wmb.db-shm']) {
  const from = path.join('J:\\PigeonYang\\WeMediaBuddyData', suffix);
  if (existsSync(from)) copyFileSync(from, path.join(root, suffix));
}
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9353;
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
const nav = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === t);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, title);

await nav('发现');
await page.waitForSelector('.discover-sources .chip', { state: 'attached', timeout: 30000 });
await page.waitForTimeout(800);
// 两级导航回读:来源数、当前来源榜数、skills.sh 三档内容不同
const twoLevel = await page.evaluate(() => ({
  sources: [...document.querySelectorAll('.discover-sources .chip')].map((el) => el.textContent?.trim()),
  boardsOfGithub: [...document.querySelectorAll('.ranking-toolbar .filter')].map((el) => el.textContent?.trim())
}));
await page.evaluate(() => {
  const chip = Array.from(document.querySelectorAll('.discover-sources .chip')).find((b) => b.textContent?.includes('skills.sh'));
  chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
const skillsBoards = await page.evaluate(() => ({
  boards: [...document.querySelectorAll('.ranking-toolbar .filter')].map((el) => el.textContent?.trim()),
  firstAllTime: document.querySelector('.ranking-list h2')?.textContent ?? ''
}));
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll('.ranking-toolbar .filter')).find((b) => b.textContent?.includes('24h'));
  tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
const firstTrending = await page.evaluate(() => document.querySelector('.ranking-list h2')?.textContent ?? '');
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll('.ranking-toolbar .filter')).find((b) => b.textContent?.includes('Hot'));
  tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
const firstHot = await page.evaluate(() => document.querySelector('.ranking-list h2')?.textContent ?? '');
console.log(JSON.stringify({ twoLevel, skillsBoards, firstTrending, firstHot }));
// 回到 GitHub 今日做入库闭环验证
await page.evaluate(() => {
  const chip = Array.from(document.querySelectorAll('.discover-sources .chip')).find((b) => b.textContent?.includes('GitHub'));
  chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.ranking-list article', { state: 'attached', timeout: 30000 });
await page.waitForTimeout(800);
const firstName = await page.evaluate(() => document.querySelector('.ranking-list h2')?.textContent ?? '');
await page.evaluate(() => document.querySelector('.ranking-save')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(1200);
const afterSave = await page.evaluate(() => ({
  note: document.querySelector('.task-status')?.textContent ?? '',
  disabled: document.querySelector('.ranking-save')?.disabled ?? false
}));
writeFileSync('.ai/wmb-discover-page.png', await page.screenshot());

// 资料库应能看到刚入库的条目(排在最前,collected_at 最新)
await nav('资料库');
await page.waitForSelector('.library-sections button', { state: 'attached', timeout: 10000 });
await page.waitForTimeout(1500);
const libraryFirst = await page.evaluate(() => document.querySelector('.lib-title')?.textContent ?? '');
writeFileSync('.ai/wmb-discover-saved-library.png', await page.screenshot());
console.log(JSON.stringify({ firstName, afterSave, libraryFirst }));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const twoLevelOk = twoLevel.sources.length >= 8 && skillsBoards.boards.length === 3 && skillsBoards.boards.some((board) => board.includes('总榜')) && skillsBoards.firstAllTime && firstTrending && firstHot && new Set([skillsBoards.firstAllTime, firstTrending, firstHot]).size === 3;
process.exit(firstName && afterSave.disabled && /已收入资料库/.test(afterSave.note) && libraryFirst === firstName && twoLevelOk ? 0 : 1);
