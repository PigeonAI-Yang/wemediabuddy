// WMB-1510 底边对齐验证:整页截图 + 两列底边坐标回读
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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1510align-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
const database = migrateDatabase(path.join(root, 'wmb.db'));
const account = saveAccount(database, { platform: 'x', accountKey: '@pigeonyang', displayName: 'PigeonYang', loginState: 'authenticated' });
const NOW = Date.now();
for (let i = 0; i < 8; i++) {
  const title = `内容 ${i + 1}`;
  const project = createContentProjectWithVersion(database, { title, body: '正文。' });
  const cv = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id);
  const version = savePlatformVersion(database, { projectId: project.id, contentVersionId: cv.id, platform: 'x', format: i % 2 ? 'text' : 'image', title, body: '正文。' });
  const publication = createPublication(database, { platformVersionId: version.data.id, accountId: account.id });
  const prepared = preparePublication(database, { publicationId: publication.data.id, expectedRevision: publication.data.revision, editorTitle: title, editorBody: '正文。', editorAssetIds: [], editorEvidenceUrl: 'https://example.com' });
  const published = transitionPublication(database, publication.data.id, 'published', { expectedRevision: prepared.data.publication.revision, reason: 'human', externalUrl: `https://example.com/${i}`, externalId: String(i) });
  const publishedMs = NOW - (i + 1) * 86_400_000;
  database.prepare('UPDATE publications SET published_at = ? WHERE id = ?').run(new Date(publishedMs).toISOString(), publication.data.id);
  for (const h of [1, 6, 24, 72]) {
    const v = (i + 2) * 200 * (h === 1 ? 1 : h === 6 ? 2 : h === 24 ? 4 : 5);
    savePublicationMetricSnapshot(database, { publicationId: publication.data.id, scheduledFor: new Date(publishedMs + h * 3_600_000).toISOString(), capturedAt: new Date(publishedMs + h * 3_600_000 + 60_000).toISOString(), sourceUrl: `https://example.com/${i}`, normalized: { views: { status: 'value', value: v, rawLabel: '' } }, raw: {} });
  }
}
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
const CDP = 9358;
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
await page.waitForSelector('.rc-dot', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
const session = await page.context().newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1100, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(700);
const metrics = await page.evaluate(() => {
  const grid = document.querySelector('.rl-grid');
  const chart = document.querySelector('.rl-chart-panel');
  const rail = document.querySelector('.rl-side');
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
  return { grid: r(grid), chart: r(chart), rail: r(rail) };
});
console.log(JSON.stringify(metrics));
writeFileSync('.ai/wmb-1510-align-full.png', await page.screenshot({ fullPage: true }));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1200));
process.exit(Math.abs(metrics.chart.bottom - metrics.rail.bottom) <= 2 ? 0 : 1);
