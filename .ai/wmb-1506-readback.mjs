// WMB-1506 证据:种子画布(源/主题/笔记节点 + 类型化边) + 真实 Electron 回读节点类型/边标签/选择条/创作组合台
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createKnowledgeCanvas, addKnowledgeCanvasNode, createKnowledgeRelation } from '../src/main/knowledge-canvas.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1506-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

const database = migrateDatabase(path.join(root, 'wmb.db'));
const now = new Date().toISOString();
database.prepare(`INSERT INTO source_items (id, canonical_url, title, author, published_at, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, priority, created_at, updated_at, revision)
  VALUES ('s1', 'https://example.com/p1', 'Chubby Skills:多平台内容沉淀工具', 'demo', ?, ?, 'GitHub · MIT 许可 · 579 stars', '["官方信源"]', '[]', '["x"]', '["text"]', 0, ?, ?, 1)`).run(now, now, now, now);
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('t1', 'Agent 个人知识库', now, now);
const canvas = createKnowledgeCanvas(database, { title: 'Agent 知识库工作台' });
const nodeSource = addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'source', objectId: 's1', x: 460, y: 60 });
const nodeTopic = addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'topic', objectId: 't1', x: 80, y: 80 });
const nodeNote = addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'note', noteTitle: '核心判断', noteText: '知识库只有进入 Agent 调用链路,才从收藏升级为资产', x: 120, y: 330 });
createKnowledgeRelation(database, { canvasId: canvas.id, fromNodeId: nodeSource.id, toNodeId: nodeTopic.id, relationType: 'supports' });
createKnowledgeRelation(database, { canvasId: canvas.id, fromNodeId: nodeNote.id, toNodeId: nodeTopic.id, relationType: 'derived_from', label: '沉淀自' });
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9342;
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
  const btn = Array.from(document.querySelectorAll('.sidebar button')).find((b) => b.getAttribute('title') === '关系画布');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.kc-node', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const node = document.querySelector('.kc-node');
  node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(800);
writeFileSync('.ai/wmb-1506-canvas.png', await page.screenshot());
const canvasReadback = await page.evaluate(() => ({
  nodeKinds: [...document.querySelectorAll('.kc-node')].map((el) => ({
    type: [...el.classList].find((c) => c.startsWith('type-')),
    kind: el.querySelector('small')?.textContent?.trim(),
    dotColor: getComputedStyle(el.querySelector('small i')).backgroundColor
  })),
  edgeLabels: [...document.querySelectorAll('.kc-edges text')].map((el) => el.textContent?.trim()),
  selectionBar: document.querySelector('.kc-selection-bar strong')?.textContent?.trim() ?? null,
  toolbarButtons: [...document.querySelectorAll('.kc-tools button')].map((el) => el.textContent?.trim())
}));
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.kc-selection-bar button, .kc-actions button')).find((b) => b.textContent?.includes('形成创作简报'));
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.composer-page .composer-slot', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1000);
writeFileSync('.ai/wmb-1506-composer.png', await page.screenshot());
const composerReadback = await page.evaluate(() => ({
  slots: [...document.querySelectorAll('.composer-slot label')].map((el) => el.textContent?.trim()),
  evidence: document.querySelectorAll('.composer-evidence').length,
  assets: document.querySelectorAll('.composer-assets article').length,
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}));
console.log(JSON.stringify({ ...canvasReadback, ...composerReadback }, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
process.exit(canvasReadback.edgeLabels.length >= 2 && canvasReadback.selectionBar && composerReadback.evidence >= 1 && !composerReadback.overflow ? 0 : 1);
