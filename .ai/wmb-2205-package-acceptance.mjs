import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { recordKnowledgeBatch } from '../src/main/knowledge.ts';
import { xMetricEvidenceMap } from '../src/main/platforms/metric-value.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createProposedWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { scheduleXObservationCapture } from '../src/main/x-observation-jobs.ts';
import { saveXPostMetricSnapshot } from '../src/main/x-post-metrics.ts';

const execFileAsync = promisify(execFile); const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-2205-package-')); const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json'); const receiptPath = path.join(process.cwd(), '.ai', 'wmb-2205-package-acceptance.json');
const receipt = { taskId: 'WMB-2205', startedAt: new Date().toISOString(), package: {}, viewports: [], lifecycle: {}, lineage: {} }; let running;
try {
  await mkdir(userData, { recursive: true });
  const ai = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'ai'), profile: profile('profile.ai.acceptance', 'AI') });
  const uk = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), profile: profile('profile.uk.acceptance', '英国生活') });
  const aiFixture = fixture(ai.rootPath, 'ai'); const ukFixture = fixture(uk.rootPath, 'uk');
  const exe = await readFile(executable); const asar = await readFile(path.join(path.dirname(executable), 'resources', 'app.asar'));
  receipt.package = { executable, exeSha256: sha(exe), asarSha256: sha(asar) };

  running = await launch(ai, 29721); const page = running.page;
  const oldMcp = (await page.evaluate(() => window.wmb.getSettings())).mcp.url;
  for (const viewport of [{ width: 1100, height: 700 }, { width: 1366, height: 768 }, { width: 1920, height: 900 }]) {
    await page.setViewportSize(viewport); await go(page, 'today');
    await page.getByText('浏览 +320/小时 · 加速 80', { exact: true }).waitFor();
    const today = await layout(page, '.today-layout', 'button[title="今日"]');
    today.primaryActionHit = await hit(page.locator('.create-action.primary'));
    const todayShot = path.join(process.cwd(), '.ai', `wmb-2205-today-${viewport.width}x${viewport.height}.png`); await page.screenshot({ path: todayShot });
    await page.getByRole('button', { name: '发现', exact: true }).click(); await page.locator('.intelligence-channels').waitFor();
    await page.getByText(/浏览 \+320\/小时 · 3 个快照证据/).waitFor();
    const discover = await layout(page, '.intelligence-channels', 'button[title="发现"]');
    const observe = page.getByRole('button', { name: '观察趋势', exact: true }); assert.equal(await observe.count(), 1); assert.equal(await observe.isEnabled(), true);
    discover.observationActionHit = await hit(observe);
    const discoverShot = path.join(process.cwd(), '.ai', `wmb-2205-discover-${viewport.width}x${viewport.height}.png`); await page.screenshot({ path: discoverShot });
    receipt.viewports.push({ ...viewport, today, discover, trend: '320 views/hour; acceleration 80; 3 snapshot ids', screenshots: [todayShot, discoverShot] });
  }

  const mcp = await initialize(oldMcp); const created = await mcpCall(oldMcp, mcp.sessionId, 'content.create', {
    request_id: 'wmb-2205-lineage', title: 'MCP trend content', body: 'body', plan_item_id: aiFixture.planItemId
  });
  assert.equal(created.ok, true); const check = migrateDatabase(path.join(ai.rootPath, 'wmb.db'));
  const project = check.prepare('SELECT topic_id AS topicId,plan_item_id AS planItemId FROM content_projects WHERE id=?').get(created.data.id);
  const sourceIds = check.prepare('SELECT source_id AS id FROM content_project_sources WHERE project_id=? ORDER BY source_id').all(created.data.id).map((row) => row.id);
  check.close(); assert.equal(project.topicId, aiFixture.topicId); assert.equal(project.planItemId, aiFixture.planItemId);
  assert.deepEqual(sourceIds, [...aiFixture.sourceIds].sort()); receipt.lineage = { projectId: created.data.id, ...project, sourceIds };
  await running.close(); running = null; await assertClosed(oldMcp);

  const aiDb = migrateDatabase(path.join(ai.rootPath, 'wmb.db')); const dueJob = aiDb.prepare("SELECT id FROM jobs WHERE kind='x_list_observation' AND status='pending' ORDER BY due_at LIMIT 1").get();
  aiDb.prepare("UPDATE jobs SET due_at='2026-08-03T00:00:00.000Z' WHERE id=?").run(dueJob.id); aiDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); aiDb.close();
  const inactiveBefore = await fileState(ai.rootPath); running = await launch(uk, 29722);
  await running.page.waitForFunction((id) => window.wmb.getSettings().then((value) => value.workspace.id === id), uk.id);
  await new Promise((resolve) => setTimeout(resolve, 1500)); const inactiveAfter = await fileState(ai.rootPath);
  assert.deepEqual(inactiveAfter, inactiveBefore); assert.notDeepEqual(aiFixture.sourceIds, ukFixture.sourceIds);
  await running.close(); running = null;

  running = await launch(ai, 29723); await waitForJob(ai.rootPath, dueJob.id, 'needs_user');
  const resumed = new DatabaseSync(path.join(ai.rootPath, 'wmb.db'), { readOnly: true });
  const job = resumed.prepare('SELECT status,last_error AS lastError FROM jobs WHERE id=?').get(dueJob.id);
  const snapshotCount = resumed.prepare('SELECT COUNT(*) AS count FROM x_post_metric_snapshots').get().count; resumed.close();
  assert.equal(snapshotCount, 3); receipt.lifecycle = { oldMcpClosed: true, inactiveRootUnchanged: true, dueJob: { id: dueJob.id, ...job }, snapshotCount };
} catch (error) { receipt.error = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null }; }
finally {
  if (running) await running.close().catch(() => {}); receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8'); console.log(JSON.stringify(receipt));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
if (receipt.error) process.exitCode = 1;

function profile(profileId, displayName) { return { profileId, revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName,
  audience: 'acceptance', contentGoal: 'acceptance', editorialBrief: 'acceptance', intelligencePackId: displayName === 'AI' ? 'wemedia-intelligence-engine' : 'uk-life-content-radar',
  intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] }; }
function fixture(root, suffix) {
  const db = migrateDatabase(path.join(root, 'wmb.db')); const bound = bindXList(db, { accountKey: '@owner', list: {
    listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@owner', name: `Trend ${suffix}`, kind: 'owned'
  } }); assert.equal(bound.ok, true);
  const x = upsertSource(db, { feedId: bound.data.sourceFeedId, originalUrl: `https://x.com/author/status/${suffix}`, title: `X ${suffix}` });
  const web = upsertSource(db, { originalUrl: `https://example.com/${suffix}`, title: `Web ${suffix}` });
  const links = recordKnowledgeBatch(db, { items: [x.id, web.id].map((sourceId) => ({ sourceId, topic: { canonicalKey: `event-${suffix}`, title: `Event ${suffix}`, kind: 'event' }, relation: 'primary' })) });
  const snapshots = [['a', '2026-08-02T00:00:00.000Z', 100], ['b', '2026-08-02T00:15:00.000Z', 160], ['c', '2026-08-02T01:00:00.000Z', 400]].map(([key, capturedAt, views]) => saveXPostMetricSnapshot(db, {
    sourceItemId: x.id, accountKey: '@owner', listId: '123', bindingId: bound.data.id, bindingRevision: bound.data.revision,
    observationKey: `${suffix}-${key}`, capturedAt, metrics: xMetricEvidenceMap({ views }, 'graphql', { views: 'views.count' }), evidence: { pageUrl: 'https://x.com/i/lists/123' }
  }));
  const plan = saveCurrentPlan(db, { planDate: '2026-08-03', timezone: 'Asia/Shanghai', summary: 'trend', items: [{ topicId: links[0].topicId,
    title: `Trend ${suffix}`, priority: 1, whyNow: 'accelerating', timeliness: 'today', targetAudience: 'audience', angle: 'angle', pointOfView: 'evidence',
    platforms: ['x'], formats: ['text'], titleGuidance: 'title', openingGuidance: 'opening', structureGuidance: 'structure', effortEstimate: '30m', sourceIds: [x.id, web.id]
  }] }); const planItemId = db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(plan.id).id;
  scheduleXObservationCapture(db, { id: 'edge:acceptance', workspaceId: db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get().value, accountKey: '@owner' }, {
    requestId: `package-${suffix}`, selectedBindingIds: [bound.data.id], binding: bound.data, capturedAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(), sourceIds: [x.id], snapshotIds: [snapshots[2].id]
  }); db.close(); return { topicId: links[0].topicId, planItemId, sourceIds: [x.id, web.id] };
}
async function launch(workspace, port) {
  const registry = await readWorkspaceRegistry(registryPath); await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
  const child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  let browser; for (let i = 0; i < 120; i += 1) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
  assert.ok(browser); const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#root', { timeout: 30_000 });
  return { page, close: async () => { await browser.close().catch(() => {}); await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); } };
}
async function go(page, view) { await page.evaluate((next) => localStorage.setItem('wmb.view', next), view); await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator(`.${view === 'today' ? 'today-layout' : 'intelligence-channels'}`).waitFor(); }
async function layout(page, selector, navSelector) { return page.evaluate(({ selector, navSelector }) => {
  const target = document.querySelector(selector); const nav = document.querySelector(navSelector); const rect = nav?.getBoundingClientRect(); const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
  return { viewport: [innerWidth, innerHeight], horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    targetVisible: Boolean(target && target.getBoundingClientRect().width > 0), navHit: Boolean(nav && hit && (nav === hit || nav.contains(hit))) };
}, { selector, navSelector }).then((value) => { assert.ok(value.horizontalOverflow <= 0); assert.equal(value.targetVisible, true); assert.equal(value.navHit, true); return value; }); }
async function hit(locator) { await locator.scrollIntoViewIfNeeded(); const value = await locator.evaluate((element) => { const rect = element.getBoundingClientRect(); const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return Boolean(target && (target === element || element.contains(target))); }); assert.equal(value, true); return value; }
async function initialize(url) { return mcpRequest(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-2205', version: '1' } }); }
async function mcpCall(url, sessionId, name, args) { const result = await mcpRequest(url, 'tools/call', { name, arguments: args }, sessionId); return JSON.parse(result.data.content[0].text); }
async function mcpRequest(url, method, params, sessionId) { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) }); assert.equal(response.ok, true); const body = await response.text(); const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body); return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId }; }
async function assertClosed(url) { let closed = false; try { await fetch(url, { method: 'POST' }); } catch { closed = true; } assert.equal(closed, true); }
async function fileState(root) { const files = ['wmb.db', 'wmb.db-wal', 'wmb.db-shm']; const out = {}; for (const name of files) { try { const value = await readFile(path.join(root, name)); const info = await stat(path.join(root, name)); out[name] = { size: info.size, hash: sha(value) }; } catch { out[name] = null; } } return out; }
async function waitForJob(root, id, status) { for (let i = 0; i < 120; i += 1) { const db = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true }); const row = db.prepare('SELECT status FROM jobs WHERE id=?').get(id); db.close(); if (row?.status === status) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`job ${id} did not become ${status}`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
