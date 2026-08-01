// WMB-1510 验收:学习闭环驾驶舱 — 种子多平台多形式发布+快照+复盘+backlink,真实 Electron 回读
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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1510-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
const database = migrateDatabase(path.join(root, 'wmb.db'));
const accounts = {
  x: saveAccount(database, { platform: 'x', accountKey: '@pigeonyang', displayName: 'PigeonYang', loginState: 'authenticated' }),
  xiaohongshu: saveAccount(database, { platform: 'xiaohongshu', accountKey: '羊毛团Ymtuan', displayName: '羊毛团', loginState: 'authenticated' }),
  wechat: saveAccount(database, { platform: 'wechat', accountKey: '鸽子杨的雾灯会', displayName: '雾灯会', loginState: 'authenticated' })
};
const NOW = Date.now();
let seq = 0;
const publishOne = ({ platform, format, title, daysAgo, hour, views, withSnaps = true, windows = [1, 6, 24, 72] }) => {
  seq += 1;
  const project = createContentProjectWithVersion(database, { title, body: `${title} 正文。` });
  const cv = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id);
  const version = savePlatformVersion(database, { projectId: project.id, contentVersionId: cv.id, platform, format, title, body: `${title} 正文。` });
  const publication = createPublication(database, { platformVersionId: version.data.id, accountId: accounts[platform].id });
  const prepared = preparePublication(database, { publicationId: publication.data.id, expectedRevision: publication.data.revision, editorTitle: title, editorBody: `${title} 正文。`, editorAssetIds: [], editorEvidenceUrl: 'https://example.com' });
  if (!prepared.ok) throw new Error(prepared.error?.message);
  const published = transitionPublication(database, publication.data.id, 'published', { expectedRevision: prepared.data.publication.revision, reason: 'human published', externalUrl: `https://example.com/${platform}/${seq}`, externalId: String(seq) });
  if (!published.ok) throw new Error(published.error?.message);
  const publishedMs = NOW - daysAgo * 86_400_000 - (new Date(NOW).getHours() - hour) * 3_600_000;
  const publishedAt = new Date(publishedMs).toISOString();
  database.prepare('UPDATE publications SET published_at = ? WHERE id = ?').run(publishedAt, publication.data.id);
  if (withSnaps) {
    for (const h of windows) {
      const v = views * (h === 1 ? 1 : h === 6 ? 2.4 : h === 24 ? 5 : 6.4);
      const normalized = {
        views: { status: 'value', value: Math.round(v), rawLabel: String(Math.round(v)) },
        likes: { status: 'value', value: Math.round(v * 0.06), rawLabel: '' },
        bookmarks: h === 1 && seq % 5 === 0 ? { status: 'unavailable', rawLabel: '收藏' } : { status: 'value', value: Math.round(v * 0.02), rawLabel: '' }
      };
      const snap = savePublicationMetricSnapshot(database, {
        publicationId: publication.data.id,
        scheduledFor: new Date(publishedMs + h * 3_600_000).toISOString(),
        capturedAt: new Date(publishedMs + h * 3_600_000 + 300_000).toISOString(),
        sourceUrl: `https://example.com/${platform}/${seq}`,
        normalized, raw: normalized
      });
      if (!snap.ok) throw new Error(snap.error?.message);
    }
  }
  return { id: publication.data.id, publishedAt };
};
const T = [
  ['AI 工具实测盘点', 'xiaohongshu', 'image', 1, 21, 900], ['MCP 检索困境', 'x', 'text', 2, 14, 300],
  ['Skill 蒸馏工作流', 'wechat', 'article', 4, 20, 700], ['视频前 3 秒结论', 'xiaohongshu', 'video', 5, 22, 1400],
  ['Agent 产品的 SaaS 错觉', 'x', 'text', 6, 10, 260], ['真实截图封面实验', 'xiaohongshu', 'image', 8, 21, 1100],
  ['副业报价的五个坑', 'wechat', 'article', 9, 9, 520], ['AI 接管每日情报', 'x', 'video', 11, 21, 800],
  ['知识画布第 30 天', 'x', 'image', 13, 16, 430], ['爆款标题的错觉', 'xiaohongshu', 'image', 16, 23, 980],
  ['接单交付清单', 'wechat', 'article', 20, 20, 640], ['争议:AI 副业教程', 'x', 'text', 25, 2, 210]
];
const pubs = T.map(([title, platform, format, daysAgo, hour, views]) => ({ title, ...publishOne({ platform, format, title, daysAgo, hour, views }) }));
// 待复盘候选:老帖无复盘(默认全部无复盘,下面给部分帖补复盘)
const finalized = [];
const reviewSeeds = [
  { i: 0, keep: ['首图用真实截图而非设计图'], stop: ['封面堆大段文字'], change: ['发布时间改到 21:00 前后'], finding: '盘点类内容要用真实截图' },
  { i: 3, keep: ['首图用真实截图而非设计图', '视频前 3 秒直接抛结论'], stop: ['封面堆大段文字'], change: ['工具类改为「1 主角 + 2 配角」结构'], finding: '视频前 3 秒先给结论' },
  { i: 5, keep: ['首图用真实截图而非设计图'], stop: ['深夜 0 点后发布'], change: ['发布时间改到 21:00 前后'], finding: null },
  { i: 7, keep: ['视频前 3 秒直接抛结论'], stop: ['深夜 0 点后发布'], change: ['发布时间改到 21:00 前后'], finding: null }
];
for (const seed of reviewSeeds) {
  const pub = pubs[seed.i];
  const snapIds = database.prepare('SELECT id FROM publication_metric_snapshots WHERE publication_id = ?').all(pub.id).map((r) => r.id);
  const review = saveReview(database, {
    publicationId: pub.id, metricSnapshotIds: [snapIds[0]],
    keep: seed.keep, stop: seed.stop, change: seed.change,
    summary: '本期有效组合,继续。', status: 'final',
    findings: seed.finding ? [{ title: seed.finding, body: `${seed.finding}的方法阐述。` }] : []
  });
  if (!review.ok) throw new Error(review.error?.message);
  finalized.push(review.data);
}
// 一条草稿复盘(计入已复盘但结论未定稿)
{
  const pub = pubs[1];
  const snapIds = database.prepare('SELECT id FROM publication_metric_snapshots WHERE publication_id = ?').all(pub.id).map((r) => r.id);
  const draft = saveReview(database, { publicationId: pub.id, metricSnapshotIds: [snapIds[0]], keep: ['标题先给结论'], stop: ['标题党'], change: ['拆小红书版'], status: 'draft', findings: [] });
  if (!draft.ok) throw new Error(draft.error?.message);
}
// backlink:后续方案引用第一个 final 复盘及其 finding
const source = upsertSource(database, { title: 'backlink source', originalUrl: 'https://example.com/s', summary: 's', categories: [], keywords: [], credibility: 'medium', fetchedAt: new Date().toISOString() });
saveCurrentPlan(database, {
  planDate: '2026-07-30', timezone: 'Asia/Shanghai', summary: 'backlink plan',
  items: [{ title: '用真实截图重做工具盘点', priority: 1, whyNow: 'w', timeliness: 't', targetAudience: 'a', angle: 'ang', pointOfView: 'p', platforms: ['x'], formats: ['text'], titleGuidance: 'tg', openingGuidance: 'og', structureGuidance: 'sg', effortEstimate: 'low', sourceIds: [source.id], reviewIds: [finalized[0].id], methodFindingIds: [finalized[0].findings[0].id] }]
});
saveCurrentPlan(database, {
  planDate: '2026-07-29', timezone: 'Asia/Shanghai', summary: 'backlink plan 2',
  items: [{ title: '盘点系列第二篇', priority: 1, whyNow: 'w', timeliness: 't', targetAudience: 'a', angle: 'ang', pointOfView: 'p', platforms: ['x'], formats: ['text'], titleGuidance: 'tg', openingGuidance: 'og', structureGuidance: 'sg', effortEstimate: 'low', sourceIds: [source.id], reviewIds: [finalized[0].id], methodFindingIds: [finalized[0].findings[0].id] }]
});
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9357;
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
await page.waitForSelector('.rl-stats', { state: 'attached', timeout: 20000 });
await page.waitForSelector('.rc-dot', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);

const main = await page.evaluate(() => ({
  stats: [...document.querySelectorAll('.rl-stat b')].map((el) => el.textContent),
  dots: document.querySelectorAll('.rc-dot').length,
  heroPoints: document.querySelectorAll('.rl-pt').length,
  noRail: !document.querySelector('.rl-side') && !document.querySelector('.rl-pattern') && !document.querySelector('.rl-finding'),
  actionCols: [...document.querySelectorAll('.rl-action-col h4')].map((el) => el.textContent?.trim()),
  keepFirst: document.querySelector('.rl-action-col.keep .rl-action-item .txt')?.textContent ?? '',
  keepAdopted: document.querySelector('.rl-action-col.keep .loop-ok')?.textContent ?? '',
  pendingRows: document.querySelectorAll('.rl-pending-row').length,
  chips: [...document.querySelectorAll('.rl-filters .chip.on')].map((el) => el.textContent)
}));
console.log('main:', JSON.stringify(main, null, 1));
const session = await page.context().newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(700);
writeFileSync('.ai/wmb-1510-dash-1920.png', await page.screenshot());
// 散点吸附 + 原位钻取
const hz = await page.evaluate(() => { const r = document.querySelector('.rc-hitzone').getBoundingClientRect(); return { x: r.left + r.width * 0.4, y: r.top + r.height * 0.45 }; });
await page.mouse.move(hz.x, hz.y);
await page.waitForTimeout(400);
const hoverOn = await page.evaluate(() => !!document.querySelector('.rc-tooltip'));
await page.mouse.click(hz.x, hz.y);
await page.waitForTimeout(800);
const drill = await page.evaluate(() => ({
  inChart: !!document.querySelector('.rl-drill-head'),
  title: document.querySelector('.rl-drill-head b')?.textContent ?? '',
  snapRows: document.querySelectorAll('.rc-table tbody tr').length,
  kscRows: document.querySelectorAll('.rl-ksc .row').length,
  hasBandsBg: document.querySelectorAll('.rc-band75.faint').length,
  noDrawer: !document.querySelector('.drawer')
}));
console.log('drill:', JSON.stringify(drill, null, 1));
writeFileSync('.ai/wmb-1510-drill.png', await page.screenshot());
await page.evaluate(() => { const b = [...document.querySelectorAll('.mini-btn')].find((x) => x.textContent.includes('返回总览')); b?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await page.waitForTimeout(500);
// 增长形态 tab
await page.evaluate(() => { const b = [...document.querySelectorAll('.rl-tabs button')].find((x) => x.textContent === '增长形态'); b?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await page.waitForTimeout(700);
const bands = await page.evaluate(() => ({
  bandPaths: document.querySelectorAll('.rc-band75:not(.faint)').length,
  topLines: document.querySelectorAll('.rc-chart polyline').length,
  medline: !!document.querySelector('.rc-medline.strong')
}));
console.log('bands:', JSON.stringify(bands, null, 1));
writeFileSync('.ai/wmb-1510-bands.png', await page.screenshot());
// 热图 tab + 单元格点击筛选
await page.evaluate(() => { const b = [...document.querySelectorAll('.rl-tabs button')].find((x) => x.textContent.includes('热图')); b?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await page.waitForTimeout(700);
const heat = await page.evaluate(() => ({ cells: document.querySelectorAll('.rc-hm-cell').length }));
await page.evaluate(() => { const c = document.querySelector('.rc-hm-cell:not(.rc-hm-none)'); c?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await page.waitForTimeout(700);
const afterCell = await page.evaluate(() => ({
  dots: document.querySelectorAll('.rc-dot').length,
  onChips: [...document.querySelectorAll('.rl-filters .chip.on')].map((el) => el.textContent)
}));
console.log('heat:', JSON.stringify({ ...heat, afterCell }, null, 1));
writeFileSync('.ai/wmb-1510-heat.png', await page.screenshot());
// 1100 溢出
await session.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(700);
const overflow1100 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
writeFileSync('.ai/wmb-1510-dash-1100.png', await page.screenshot());
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const pass =
  main.stats[0] === '12' && main.stats[2] === '2' && main.stats[4] === '7' &&
  main.dots === 12 && main.heroPoints === 3 && main.noRail &&
  main.keepFirst === '首图用真实截图而非设计图' && main.keepAdopted.includes('已被 2 个后续方案采用') &&
  main.pendingRows === 6 &&
  hoverOn && drill.inChart && drill.snapRows === 4 && drill.hasBandsBg >= 1 && drill.noDrawer &&
  bands.bandPaths >= 1 && bands.topLines === 3 && bands.medline &&
  heat.cells > 0 && afterCell.dots > 0 && afterCell.dots < 12 && afterCell.onChips.length >= 3 &&
  overflow1100 === false;
console.log(pass ? 'WMB-1510 READBACK PASS' : 'WMB-1510 READBACK FAIL');
process.exit(pass ? 0 : 1);
