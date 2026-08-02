import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject } from '../src/main/content.ts';
import { createTopic } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { createProposedWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1911-package-'));
const userData = path.join(temp, 'user-data'); const registryPath = path.join(userData, 'workspace-registry.json');
const duplicate = { project: 'duplicate-project', topic: 'duplicate-topic', source: 'duplicate-source', list: '1911001' };
let registry;
try {
  await mkdir(userData, { recursive: true });
  const a = await workspace('A', path.join(temp, 'a')); const b = await workspace('B', path.join(temp, 'b')); const empty = await workspace('Empty', path.join(temp, 'empty'));
  seedDuplicates(a.rootPath, 'A'); seedDuplicates(b.rootPath, 'B'); registry = await readWorkspaceRegistry(registryPath);

  const first = await launch(a, 29561);
  try {
    await first.page.evaluate(({ workspaceId, duplicate }) => {
      localStorage.setItem('wmb.view', 'studio');
      localStorage.setItem('wmb.studioSelectedId', duplicate.project); localStorage.setItem('wmb.libraryTopicId', duplicate.topic); localStorage.setItem('wmb.libraryFocusSourceId', duplicate.source); localStorage.setItem('wmb.xListSelectedId', duplicate.list); localStorage.setItem('wmb.discoverSection', 'rankings');
      for (const [key, value] of Object.entries({ studioSelectedId: duplicate.project, libraryTopicId: duplicate.topic, libraryFocusSourceId: duplicate.source, xListSelectedId: duplicate.list, discoverSection: 'rankings' })) localStorage.setItem(`wmb.workspace.${workspaceId}.${key}`, value);
    }, { workspaceId: a.id, duplicate });
    await first.page.reload({ waitUntil: 'domcontentloaded' }); await first.page.waitForSelector('.studio-editor-view', { timeout: 15_000 }); assert.match(await first.page.textContent('body'), /A project/);
  } finally { await first.close(); }

  const second = await launch(b, 29562);
  let bReadback;
  try {
    const scopedBefore = await second.page.evaluate(({ workspaceId }) => Object.fromEntries(['studioSelectedId', 'libraryTopicId', 'libraryFocusSourceId', 'xListSelectedId', 'discoverSection'].map((key) => [key, localStorage.getItem(`wmb.workspace.${workspaceId}.${key}`)])), { workspaceId: b.id });
    assert.deepEqual(scopedBefore, { studioSelectedId: null, libraryTopicId: null, libraryFocusSourceId: null, xListSelectedId: null, discoverSection: null });
    await second.page.evaluate(() => localStorage.setItem('wmb.view', 'studio')); await second.page.reload({ waitUntil: 'domcontentloaded' });
    await second.page.waitForSelector('.studio-project-row', { timeout: 15_000 });
    assert.equal(await second.page.locator('.studio-editor-view').count(), 0); assert.match(await second.page.textContent('body'), /B project/); assert.doesNotMatch(await second.page.textContent('body'), /A project/);
    await second.page.getByRole('button', { name: '主题', exact: true }).click(); await second.page.waitForTimeout(500); assert.match(await second.page.textContent('body'), /B topic/); assert.doesNotMatch(await second.page.textContent('body'), /A topic/);
    await second.page.getByRole('button', { name: '资料库', exact: true }).click(); await second.page.waitForTimeout(500); assert.match(await second.page.textContent('body'), /B source/); assert.doesNotMatch(await second.page.textContent('body'), /A source/);
    await second.page.getByRole('button', { name: '发现', exact: true }).click(); await second.page.waitForTimeout(500); assert.deepEqual(await second.page.locator('.discover-categories button').allTextContents(), ['X Lists']);
    const beforeCanvas = tableCount(b.rootPath, 'knowledge_canvases'); await second.page.getByRole('button', { name: '关系画布', exact: true }).click(); await second.page.waitForTimeout(5500); const afterCanvas = tableCount(b.rootPath, 'knowledge_canvases');
    assert.equal(beforeCanvas, 0); assert.equal(afterCanvas, 0); assert.match(await second.page.textContent('body'), /创建第一张画布/);
    bReadback = { scopedBefore, currentLabels: ['B project', 'B topic', 'B source'], discoverTabs: ['X Lists'], canvasCount: afterCanvas };
  } finally { await second.close(); }

  const third = await launch(empty, 29563);
  let emptyReadback;
  try {
    const before = projection(empty.rootPath);
    for (const label of ['今日', '发现', '创作', '发布', '结果', '主题', '资料库', '关系画布']) { await third.page.getByRole('button', { name: label, exact: true }).click(); await third.page.waitForTimeout(label === '关系画布' ? 5500 : 250); }
    const after = projection(empty.rootPath); assert.deepEqual(after, before); assert.match(await third.page.textContent('body'), /创建第一张画布/);
    emptyReadback = { projection: after, views: 8, explicitCanvasAction: true };
  } finally { await third.close(); }
  const receipt = { duplicateIds: duplicate, rootB: bReadback, emptyRoot: emptyReadback };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1911-package-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8'); console.log(JSON.stringify(receipt));
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }

async function workspace(displayName, rootPath) { return createProposedWorkspace({ registryPath, rootPath, profile: { profileId: `profile.game.${displayName}`, revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName, audience: '玩家', contentGoal: '游戏资讯', editorialBrief: '官方优先', intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] } }); }
function seedDuplicates(rootPath, label) { const db = migrateDatabase(path.join(rootPath, 'wmb.db')); try { const project = createContentProject(db, { title: `${label} project`, sourceIds: [] }); db.prepare('UPDATE content_projects SET id=? WHERE id=?').run(duplicate.project, project.id); const topic = createTopic(db, `${label} topic`); db.prepare('UPDATE topics SET id=? WHERE id=?').run(duplicate.topic, topic.id); const source = upsertSource(db, { title: `${label} source`, originalUrl: `https://example.com/${label}` }); db.prepare('UPDATE source_items SET id=? WHERE id=?').run(duplicate.source, source.id); const binding = bindXList(db, { accountKey: '@duplicate', list: { listId: duplicate.list, canonicalUrl: `https://x.com/i/lists/${duplicate.list}`, ownerHandle: '@duplicate', name: `${label} List`, kind: 'owned' }, observation: { source: 'acceptance' } }); assert.equal(binding.ok, true); } finally { db.close(); } }
async function launch(workspace, port) { await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8'); await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8'); const child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' }); let browser; for (let attempt = 0; attempt < 120; attempt += 1) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } if (!browser) throw new Error(`CDP ${port} did not start`); const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#root', { timeout: 30_000 }); return { page, close: async () => { await browser.close().catch(() => {}); await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); } }; }
function tableCount(root, table) { const db = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count; } finally { db.close(); } }
function projection(root) { const db = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true }); try { const excluded = new Set(['app_meta', 'schema_migrations', 'workspace_profiles']); const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name).filter((name) => !excluded.has(name)); const hashes = Object.fromEntries(tables.map((name) => [name, createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM \"${name}\" ORDER BY rowid`).all())).digest('hex')])); return { digest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), tables: hashes }; } finally { db.close(); } }
