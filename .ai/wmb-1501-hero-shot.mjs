// WMB-1501 证据:种子数据(今日计划 + 资料) + 真实 Electron 截图今日视图 hero/等级徽章/统计条/行动卡
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1501-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

const database = migrateDatabase(path.join(root, 'wmb.db'));
const now = new Date().toISOString();
const sourceIds = ['s1', 's2', 's3'];
for (const [index, id] of sourceIds.entries()) {
  database.prepare(`INSERT INTO source_items (id, canonical_url, title, author, published_at, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, priority, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, `https://example.com/post-${id}`, `证据资料 ${index + 1}:Agent 工作流实践`, 'demo-author', now, now, '摘要', '["官方信源"]', '[]', '["x"]', '["text"]', index, now, now);
}
const planDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const item = (title, priority, sourceIds) => ({
  title, priority, whyNow: '为什么现在:窗口期 48 小时,中文圈尚无系统解读。', timeliness: '48h', targetAudience: 'AI 工具实践者',
  angle: '以真实工作流复盘切入', pointOfView: '个人开发者第一次能编程自己的 AI 工作流', platforms: ['x', 'xiaohongshu'], formats: ['text', 'image'],
  titleGuidance: '标题建议', openingGuidance: '开头建议', structureGuidance: '结构建议', effortEstimate: '≈ 2.5h', sourceIds
});
saveCurrentPlan(database, {
  planDate, timezone: 'Asia/Shanghai', summary: '演示计划',
  items: [
    item('Claude Code 开放 Hooks 生态:个人开发者第一次能「编程自己的 AI 工作流」', 0, ['s1', 's2']),
    item('OpenAI 定价再降 40%:AI 接单成本结构被重写', 2, ['s2']),
    item('「AI 副业月入过万」争议再起:三个被忽略的成本项', 4, ['s3'])
  ]
});
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9338;
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
await page.waitForSelector('.opportunity-primary', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1500);
const session = await page.context().newCDPSession(page);
for (const size of [{ w: 1920, h: 900 }, { w: 1100, h: 700 }]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(700);
  writeFileSync(`.ai/wmb-1501-today-hero-${size.w}.png`, await page.screenshot());
}
const readback = await page.evaluate(() => ({
  hero: !!document.querySelector('.opportunity-primary'),
  grades: [...document.querySelectorAll('.opportunity-tags strong, .opp-grade')].map((el) => el.getAttribute('data-grade')),
  stats: [...document.querySelectorAll('.stat-cell .stat-value')].map((el) => el.textContent),
  eyebrows: [...document.querySelectorAll('.eyebrow')].map((el) => el.textContent),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify(readback, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(readback.hero && readback.grades.includes('SSS') && !readback.overflow ? 0 : 1);
