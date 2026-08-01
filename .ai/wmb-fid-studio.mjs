// 高保真验收:种子创作项目 + 真实 Electron 截图创作编辑器(双分辨率)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, savePlatformVersion, deleteContentProject } from '../src/main/content.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-fid-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

const database = migrateDatabase(path.join(root, 'wmb.db'));
const seeded = createContentProjectWithVersion(database, {
  title: 'Agent 个人知识库:从收藏到可调用资产',
  body: '个人知识库只有进入 Agent 的检索与调用链路,才真正从收藏升级为可复用资产。\n\n## 为什么现在\n\n多平台内容持续碎片化,而 Agent 已能通过本地索引和 MCP 使用个人资料。\n\n## 内容结构\n\n1. 收藏为什么不等于知识资产\n2. 内容如何统一沉淀\n3. Agent 如何精确调用\n4. 边界与验证方法'
});
// 删除守卫单元验证:有平台版本的项目必须拒绝删除
const guarded = createContentProjectWithVersion(database, { title: '守卫项目', body: '守卫正文' });
const guardedCv = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(guarded.id);
savePlatformVersion(database, { projectId: guarded.id, contentVersionId: guardedCv.id, platform: 'x', format: 'text', body: '守卫正文' });
const guardResult = deleteContentProject(database, { projectId: guarded.id, expectedRevision: 1 });
if (guardResult.ok || guardResult.error?.code !== 'HAS_PLATFORM_VERSIONS') throw new Error('delete guard failed');
database.prepare('DELETE FROM platform_versions WHERE project_id = ?').run(guarded.id);
const unblocked = deleteContentProject(database, { projectId: guarded.id, expectedRevision: 1 });
if (!unblocked.ok) throw new Error('delete after removing platform version failed');
if (database.prepare('SELECT COUNT(*) AS c FROM content_versions WHERE project_id = ?').get(guarded.id).c !== 0) throw new Error('version cascade failed');
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9345;
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
page.on('dialog', (dialog) => void dialog.accept());
await page.goto('file:///J:/PigeonYang/WeMediaBuddy/.vite/renderer/main_window/index.html');
await page.waitForSelector('.sidebar button', { state: 'attached', timeout: 45000 });
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '创作');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.studio-project-row[role="row"]:not(.head)', { state: 'attached', timeout: 20000 });
await page.evaluate(() => document.querySelector('.studio-project-row[role="row"]:not(.head)')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.studio-document .studio-rich-editor', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
const session = await page.context().newCDPSession(page);
for (const size of [{ w: 1920, h: 900 }, { w: 1100, h: 700 }]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(700);
  writeFileSync(`.ai/wmb-fid-studio-${size.w}.png`, await page.screenshot());
}
const readback = await page.evaluate(() => ({
  docState: document.querySelector('.studio-doc-state')?.textContent?.trim(),
  pfTags: [...document.querySelectorAll('.studio-outline .pf-tag')].map((el) => el.textContent?.trim()),
  stDots: [...document.querySelectorAll('.studio-outline .st-dot')].map((el) => el.getAttribute('data-state')),
  framed: getComputedStyle(document.querySelector('.studio-editor-grid')).borderRadius,
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify(readback, null, 1));
// 归档/恢复功能验证:返回项目库 → 行尾归档 → 已归档筛选可见 → 恢复
await page.evaluate(() => {
  const btn = document.querySelector('.studio-top-back');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('button.studio-project-row, .studio-project-row[role="row"]', { state: 'attached', timeout: 10000 });
await page.waitForTimeout(800);
const rowsBefore = await page.evaluate(() => document.querySelectorAll('.studio-project-row[role="row"]:not(.head)').length);
await page.evaluate(() => {
  const btn = document.querySelector('.studio-row-action');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
const rowsAfterArchive = await page.evaluate(() => document.querySelectorAll('.studio-project-row[role="row"]:not(.head)').length);
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.studio-library-summary button')).find((b) => b.textContent?.includes('已归档'));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
const archivedState = await page.evaluate(() => ({
  rows: document.querySelectorAll('.studio-project-row[role="row"]:not(.head)').length,
  action: document.querySelector('.studio-row-action')?.textContent?.trim()
}));
writeFileSync('.ai/wmb-fid-studio-archive.png', await page.screenshot());
await page.evaluate(() => document.querySelector('.studio-row-action')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(1200);
const rowsAfterRestore = await page.evaluate(() => document.querySelectorAll('.studio-project-row[role="row"]:not(.head)').length);
// UI 级删除:回到全部 → 点删除(confirm 自动接受)→ 列表为空
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.studio-library-summary button')).find((b) => b.textContent?.includes('全部项目'));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
const deleteVisible = await page.evaluate(() => !!document.querySelector('.studio-row-action.danger'));
await page.evaluate(() => document.querySelector('.studio-row-action.danger')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(1200);
const rowsAfterDelete = await page.evaluate(() => document.querySelectorAll('.studio-project-row[role="row"]:not(.head)').length);
console.log(JSON.stringify({ rowsBefore, rowsAfterArchive, archivedState, rowsAfterRestore, deleteVisible, rowsAfterDelete }));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const archiveOk = rowsBefore === 1 && rowsAfterArchive === 0 && archivedState.rows === 1 && archivedState.action === '恢复' && rowsAfterRestore === 0;
const deleteOk = deleteVisible && rowsAfterDelete === 0;
process.exit(readback.pfTags.length === 3 && !readback.overflow && archiveOk && deleteOk ? 0 : 1);
