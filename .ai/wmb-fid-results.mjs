// 高保真验收:种子已发布内容 + 3 个指标快照 + 已定稿复盘,真实 Electron 截图结果视图
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { createPublication, preparePublication, transitionPublication } from '../src/main/publishing.ts';
import { savePublicationMetricSnapshot } from '../src/main/metrics.ts';
import { saveReview } from '../src/main/reviews.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-fidres-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

const database = migrateDatabase(path.join(root, 'wmb.db'));
const account = saveAccount(database, { platform: 'x', accountKey: '@pigeonyang', displayName: 'PigeonYang', loginState: 'authenticated' });
const publishOne = (title, body, statusId) => {
  const project = createContentProjectWithVersion(database, { title, body });
  const cv = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id);
  const version = savePlatformVersion(database, { projectId: project.id, contentVersionId: cv.id, platform: 'x', format: 'image', title, body });
  const publication = createPublication(database, { platformVersionId: version.data.id, accountId: account.id });
  const prepared = preparePublication(database, { publicationId: publication.data.id, expectedRevision: publication.data.revision, editorTitle: title, editorBody: body, editorAssetIds: [], editorEvidenceUrl: 'https://x.com/pigeonyang' });
  if (!prepared.ok) throw new Error(prepared.error?.message);
  const published = transitionPublication(database, publication.data.id, 'published', { expectedRevision: prepared.data.publication.revision, reason: 'human published', externalUrl: `https://x.com/pigeonyang/status/${statusId}`, externalId: String(statusId) });
  if (!published.ok) throw new Error(published.error?.message);
  return published.data;
};
publishOne('AI 副业成本账:三个被忽略的成本项', '成本账正文。', 124);
publishOne('MCP Server 数量破万后的检索困境', '检索困境正文。', 125);
const body = '年中盘点:12 个真正留下来的 AI 工具。';
const publication = publishOne('《我的 AI 工具箱 2025 年中版》图文笔记', body, 123);
const publishedAt = Date.parse(publication.publishedAt);
const windows = [
  { h: 1, views: 312, likes: 18, bookmarks: 9, replies: 2 },
  { h: 6, views: 1024, likes: 76, bookmarks: 41, replies: 9 },
  { h: 24, views: 3008, likes: 216, bookmarks: 123, replies: 31 }
];
const snapshotIds = [];
for (const w of windows) {
  const normalized = Object.fromEntries(Object.entries({ views: w.views, likes: w.likes, bookmarks: w.bookmarks, replies: w.replies }).map(([key, value]) => [key, { status: 'value', value, rawLabel: String(value) }]));
  const snap = savePublicationMetricSnapshot(database, {
    publicationId: publication.id,
    scheduledFor: new Date(publishedAt + w.h * 3_600_000).toISOString(),
    capturedAt: new Date(publishedAt + w.h * 3_600_000 + 300_000).toISOString(),
    sourceUrl: 'https://x.com/pigeonyang/status/123',
    normalized, raw: normalized
  });
  if (!snap.ok) throw new Error(snap.error?.message);
  snapshotIds.push(snap.data.id);
}
const review = saveReview(database, {
  publicationId: publication.id, metricSnapshotIds: [snapshotIds[snapshotIds.length - 1]],
  keep: ['「年中盘点」类时间节点选题,收藏率显著高于平均(4.4% vs 1.8%)', '首图用真实截图而非设计图'],
  stop: ['不再在笔记正文堆 6 个以上工具名,评论显示「看不完」'],
  change: ['工具类内容改为「1 个主角 + 2 个配角」结构', '发布时间从深夜改到 21:00 前后'],
  summary: '时间节点盘点 + 真实截图是有效组合,继续。', status: 'final',
  findings: [{ title: '盘点类内容要用真实截图', body: '真实截图首图的收藏率显著高于设计图。' }]
});
if (!review.ok) throw new Error(review.error?.message);
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9347;
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
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '结果');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.metric-card', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
const session = await page.context().newCDPSession(page);
for (const size of [{ w: 1920, h: 900 }, { w: 1100, h: 700 }]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(700);
  writeFileSync(`.ai/wmb-fid-results-${size.w}.png`, await page.screenshot());
}
const readback = await page.evaluate(() => ({
  cardLabels: [...document.querySelectorAll('.metric-card .stat-label')].map((el) => el.textContent),
  reviewCols: [...document.querySelectorAll('.review-col h4')].map((el) => ({ text: el.textContent?.trim(), color: getComputedStyle(el).color })),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify(readback, null, 1));
// 内容切换器:打开 → 3 条 → 搜索收窄 → 选择
await page.evaluate(() => document.querySelector('.results-switcher')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.switcher-list button', { state: 'attached', timeout: 10000 });
const before = await page.evaluate(() => document.querySelectorAll('.switcher-list button').length);
await page.fill('.switcher-pop input', '检索困境');
await page.waitForTimeout(600);
const narrowed = await page.evaluate(() => document.querySelectorAll('.switcher-list button').length);
await page.evaluate(() => document.querySelector('.switcher-list button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(800);
const subAfter = await page.evaluate(() => document.querySelector('.today-heading p')?.textContent ?? '');
console.log(JSON.stringify({ before, narrowed, subAfter }));
writeFileSync('.ai/wmb-fid-results-switcher.png', await page.screenshot());
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(readback.cardLabels.includes('阅读') && readback.reviewCols.length === 3 && !readback.overflow && before === 3 && narrowed === 1 && subAfter.includes('检索困境') ? 0 : 1);
