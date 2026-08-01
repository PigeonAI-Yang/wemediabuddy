// 高保真验收:种子待确认发布(账号+平台版本+payload+事件) + 真实 Electron 截图发布视图
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { createPublication, preparePublication } from '../src/main/publishing.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-fidpub-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

const database = migrateDatabase(path.join(root, 'wmb.db'));
const body = '过去 30 天我用一套固定的 Agent 工作流做了 12 篇内容,数据说清楚了三件事:\n\n① 有复盘的选题,平均阅读高 2.3 倍\n② 资料库调用次数和完读率正相关\n③ 「AI 写的」不是问题,「没有判断的」才是\n\n完整复盘长文本周发公众号。';
const project = createContentProjectWithVersion(database, { title: '《Agent 工作流复盘》图文帖子', body });
const cv = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id);
const version = savePlatformVersion(database, { projectId: project.id, contentVersionId: cv.id, platform: 'x', format: 'image', title: '《Agent 工作流复盘》图文帖子', body });
const account = saveAccount(database, { platform: 'x', accountKey: '@pigeonyang', displayName: 'PigeonYang', loginState: 'authenticated', evidenceUrl: 'https://x.com/pigeonyang' });
const publication = createPublication(database, { platformVersionId: version.data.id, accountId: account.id });
const prepared = preparePublication(database, { publicationId: publication.data.id, expectedRevision: publication.data.revision, editorTitle: '《Agent 工作流复盘》图文帖子', editorBody: body, editorAssetIds: [], editorEvidenceUrl: 'https://x.com/pigeonyang' });
if (!prepared.ok) throw new Error(`seed failed: ${prepared.error?.message}`);
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9346;
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
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '发布');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.pub-card', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
const session = await page.context().newCDPSession(page);
const rectDump = () => page.evaluate(() => Object.fromEntries(['.publish-layout', '.publish-preview', '.confirmation-panel', '.pub-card'].map((sel) => { const el = document.querySelector(sel); if (!el) return [sel, null]; const r = el.getBoundingClientRect(); return [sel, `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`]; })));
for (const size of [{ w: 1920, h: 900 }, { w: 1100, h: 700 }]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(700);
  writeFileSync(`.ai/wmb-fid-publish-${size.w}.png`, await page.screenshot());
  console.log(`rects@${size.w}:`, JSON.stringify(await rectDump()));
}
const readback = await page.evaluate(() => ({
  pubCard: !!document.querySelector('.pub-card.awaiting'),
  headPill: document.querySelector('.pub-head .pill-status')?.textContent?.trim(),
  account: document.querySelector('.pub-account')?.textContent?.trim(),
  footButtons: [...document.querySelectorAll('.pub-foot button')].map((el) => el.textContent?.trim()),
  dots: [...document.querySelectorAll('.tl-dot')].map((el) => el.className.replace('tl-dot ', '')),
  accountCard: document.querySelector('.account-card b')?.textContent?.trim(),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify(readback, null, 1));
// 功能验证:「继续编辑」跳转到创作页并选中对应项目
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.pub-foot button')).find((b) => b.textContent?.includes('继续编辑'));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.studio-document .studio-rich-editor', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(800);
const studioTitle = await page.evaluate(() => document.querySelector('.studio-title-input')?.value ?? null);
console.log('continue-edit → studio title:', studioTitle);
writeFileSync('.ai/wmb-fid-publish-edit.png', await page.screenshot());
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(readback.pubCard && readback.dots.length >= 2 && !readback.overflow && studioTitle?.includes('Agent 工作流复盘') ? 0 : 1);
