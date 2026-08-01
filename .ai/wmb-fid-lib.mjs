// 高保真验收:种子资料(不同核验/管理状态+主题) + 领域,真实 Electron 截图资料库行与领域卡片
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createKnowledgeDomain } from '../src/main/knowledge.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-fidlib-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

const database = migrateDatabase(path.join(root, 'wmb.db'));
const now = new Date().toISOString();
const sources = [
  { id: 's1', title: 'Anthropic 官方博客:Claude Code Hooks 完整指南', summary: 'Hooks 允许开发者在 Agent 执行循环的确定节点注入自己的命令,把「提示词约束」升级为「工程约束」。官方给出 6 种 hook 事件与完整 JSON Schema……', verification: 'verified', management: 'active' },
  { id: 's2', title: '少数派:我用 AI Agent 接单的 90 天账本', summary: '作者公开了 12 单真实收入与工具成本,净利 2.1 万。其中报价章节与你的方法论冲突:他主张按时计费而非按交付物计费……', verification: 'pending', management: 'watching' },
  { id: 's3', title: '@levelsio:AI 独立开发者的分发仍然比产品难 10 倍', summary: '单条帖子,4.2k 赞。观点:AI 降低了生产成本,却抬高了注意力竞争的门槛。……', verification: 'pending', management: 'active' }
];
for (const [index, s] of sources.entries()) {
  database.prepare(`INSERT INTO source_items (id, original_url, canonical_url, title, author, published_at, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, priority, verification_status, management_status, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, 'demo', ?, ?, ?, '["官方信源"]', '[]', '["x"]', '["text"]', ?, ?, ?, ?, ?, 1)`)
    .run(s.id, `https://example.com/${s.id}`, `https://example.com/${s.id}`, s.title, now, now, s.summary, index, s.verification, s.management, now, now);
}
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('t1', 'Agent 工作流', now, now);
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('t2', 'Claude Code', now, now);
database.prepare('INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t1', 's1', 'primary', now, now);
database.prepare('INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t2', 's1', 'supporting', now, now);
createKnowledgeDomain(database, { title: 'Agent、Skill 与工作流', description: 'AI Agent 工具链、MCP 生态、个人工作流搭建与实测,当前内容主线。', status: 'active', topicIds: ['t1', 't2'] });
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9348;
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
await nav('资料库');
await page.waitForSelector('.library-sections button', { state: 'attached', timeout: 20000 });
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.library-sections button')).find((b) => b.textContent?.includes('入库资料'));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.lib-row', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1000);
const session = await page.context().newCDPSession(page);
await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
await page.waitForTimeout(600);
writeFileSync('.ai/wmb-fid-library-1920.png', await page.screenshot());
const libReadback = await page.evaluate(() => ({
  rows: document.querySelectorAll('.lib-row').length,
  pills: [...document.querySelectorAll('.lib-row .pill-status')].map((el) => el.textContent?.trim()),
  tags: [...document.querySelectorAll('.lib-row .lib-tags .tag')].map((el) => el.textContent).slice(0, 6),
  firstRowFirstChild: document.querySelector('.lib-row .lib-main')?.firstElementChild?.className
}));
await nav('知识系统');
await page.waitForSelector('.domain-card', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1000);
writeFileSync('.ai/wmb-fid-knowledge-1920.png', await page.screenshot());
const domainReadback = await page.evaluate(() => ({
  cards: document.querySelectorAll('.domain-card').length,
  pill: document.querySelector('.domain-card .pill-status')?.textContent?.trim(),
  stats: document.querySelector('.domain-card .domain-stats')?.textContent?.trim(),
  accent: getComputedStyle(document.querySelector('.domain-card'), '::before').height,
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify({ ...libReadback, ...domainReadback }, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(libReadback.rows === 3 && domainReadback.cards >= 1 && !domainReadback.overflow ? 0 : 1);
