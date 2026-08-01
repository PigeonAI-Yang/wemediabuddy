// WMB-1509 验收:复盘可视化仪表盘 — 种子 final 复盘(含 backlink)/draft 候选/无快照空态,真实 Electron 截图
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
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1509-'));
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
// 无快照空态候选 + draft 候选(有快照无复盘)
publishOne('没有快照的已发布内容', '正文。', 900);
const draftPub = publishOne('只有快照还没复盘的内容', '正文。', 901);
const draftSnap = savePublicationMetricSnapshot(database, {
  publicationId: draftPub.id,
  scheduledFor: new Date(Date.parse(draftPub.publishedAt) + 3_600_000).toISOString(),
  capturedAt: new Date(Date.parse(draftPub.publishedAt) + 3_900_000).toISOString(),
  sourceUrl: 'https://x.com/pigeonyang/status/901',
  normalized: { views: { status: 'value', value: 88, rawLabel: '88' } },
  raw: { views: { status: 'value', value: 88, rawLabel: '88 次展示' }, bookmarks: { status: 'unavailable', rawLabel: '书签' } }
});
if (!draftSnap.ok) throw new Error(draftSnap.error?.message);
// 主角:3 快照 + final 复盘 + 方法结论 + 后续方案 backlink
const publication = publishOne('《我的 AI 工具箱 2025 年中版》图文笔记', '年中盘点:12 个真正留下来的 AI 工具。', 123);
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
const source = upsertSource(database, { title: 'backlink source', originalUrl: 'https://example.com/a', summary: 's', categories: [], keywords: [], credibility: 'medium', fetchedAt: new Date().toISOString() });
saveCurrentPlan(database, {
  planDate: '2026-07-30', timezone: 'Asia/Shanghai', summary: 'plan with review backlink',
  items: [{ title: '用真实截图重做工具盘点', priority: 1, whyNow: 'w', timeliness: 't', targetAudience: 'a', angle: 'ang', pointOfView: 'p', platforms: ['x'], formats: ['text'], titleGuidance: 'tg', openingGuidance: 'og', structureGuidance: 'sg', effortEstimate: 'low', sourceIds: [source.id], reviewIds: [review.data.id], methodFindingIds: [review.data.findings[0].id] }]
});
database.close();
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
const nav = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === t);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, title);
await nav('结果');
await page.waitForSelector('.kpi-item', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);

// final 复盘仪表盘回读
const main = await page.evaluate(() => ({
  kpis: [...document.querySelectorAll('.kpi-item .kpi-label')].map((el) => el.textContent),
  kpiValues: [...document.querySelectorAll('.kpi-item .kpi-value')].map((el) => el.textContent),
  cols: [...document.querySelectorAll('.ksc-board .review-col h4')].map((el) => ({ text: el.textContent?.trim(), color: getComputedStyle(el).color })),
  evidenceBadges: [...document.querySelectorAll('.evidence-badge')].map((el) => el.textContent),
  findingTitles: [...document.querySelectorAll('.finding-card b')].map((el) => el.textContent),
  backlinkBadges: [...document.querySelectorAll('.backlink-badge')].map((el) => el.textContent),
  drawerToggle: document.querySelector('.evidence-toggle')?.textContent ?? '',
  drawerTableBefore: document.querySelectorAll('.evidence-drawer .snap-table tr').length,
  summary: document.querySelector('.review-summary')?.textContent ?? ''
}));
console.log('main:', JSON.stringify(main, null, 1));
const session = await page.context().newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(700);
writeFileSync('.ai/wmb-1509-dash-1920.png', await page.screenshot());
// 展开证据抽屉
await page.evaluate(() => document.querySelector('.evidence-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.evidence-drawer .snap-table tbody tr', { state: 'attached', timeout: 10000 });
await page.waitForTimeout(500);
const drawer = await page.evaluate(() => ({
  rows: document.querySelectorAll('.evidence-drawer .snap-table tbody tr').length,
  headers: [...document.querySelectorAll('.evidence-drawer .snap-table th')].map((el) => el.textContent),
  src: document.querySelector('.evidence-src')?.textContent ?? '',
  rawChips: document.querySelectorAll('.raw-chip').length,
  statusPill: document.querySelector('.evidence-drawer .pill-status')?.textContent ?? ''
}));
console.log('drawer:', JSON.stringify(drawer, null, 1));
writeFileSync('.ai/wmb-1509-dash-evidence.png', await page.screenshot());
// 1100 溢出检查
await session.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(700);
const overflow1100 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
writeFileSync('.ai/wmb-1509-dash-1100.png', await page.screenshot());
// draft 候选:可编辑行动板 + 结论编辑
await page.evaluate(() => document.querySelector('.results-switcher')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.switcher-list button', { state: 'attached', timeout: 10000 });
await page.fill('.switcher-pop input', '还没复盘');
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('.switcher-list button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.ksc-board.editing textarea', { state: 'attached', timeout: 10000 });
await page.waitForTimeout(600);
const draft = await page.evaluate(() => ({
  editAreas: document.querySelectorAll('.ksc-board.editing textarea').length,
  findingEdit: !!document.querySelector('.finding-edit input'),
  saveButtons: [...document.querySelectorAll('.board-actions button')].map((el) => el.textContent),
  editKpi: document.querySelector('.kpi-item .kpi-value')?.textContent ?? ''
}));
console.log('draft:', JSON.stringify(draft, null, 1));
writeFileSync('.ai/wmb-1509-dash-draft.png', await page.screenshot());
// 无快照空态
await page.evaluate(() => document.querySelector('.results-switcher')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.switcher-list button', { state: 'attached', timeout: 10000 });
await page.fill('.switcher-pop input', '没有快照');
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('.switcher-list button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('.board-empty', { state: 'attached', timeout: 10000 });
const emptyState = await page.evaluate(() => ({
  emptyText: document.querySelector('.board-empty h3')?.textContent ?? '',
  noDrawer: !document.querySelector('.evidence-drawer'),
  piDisabled: [...document.querySelectorAll('.heading-actions button')].find((b) => b.textContent === '写复盘')?.disabled ?? null
}));
console.log('empty:', JSON.stringify(emptyState, null, 1));
writeFileSync('.ai/wmb-1509-dash-empty.png', await page.screenshot());
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const pass =
  main.kpis.includes('阅读') && main.kpiValues.includes('3,008') &&
  main.cols.length === 3 && main.cols[0].text.includes('2') && // keep 2 条计数
  main.evidenceBadges.some((t) => t.includes('+24h')) &&
  main.findingTitles.includes('盘点类内容要用真实截图') &&
  main.backlinkBadges.some((t) => t.includes('用真实截图重做工具盘点')) &&
  main.summary.includes('真实截图') && main.drawerTableBefore === 0 &&
  drawer.rows === 3 && drawer.headers.includes('字段状态') && drawer.src.includes('x.com/pigeonyang/status/123') &&
  drawer.rawChips >= 12 && drawer.statusPill.includes('全部有值') &&
  overflow1100 === false &&
  draft.editAreas === 3 && draft.findingEdit && draft.saveButtons.join().includes('定稿复盘') && draft.editKpi === '88' &&
  emptyState.emptyText.includes('先采集指标') && emptyState.noDrawer && emptyState.piDisabled === true;
console.log(pass ? 'WMB-1509 READBACK PASS' : 'WMB-1509 READBACK FAIL');
process.exit(pass ? 0 : 1);
