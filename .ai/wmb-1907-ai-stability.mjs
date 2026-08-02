import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { verifyBaseline } from '../scripts/workspace-baseline.mjs';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const aiRoot = 'J:\\PigeonYang\\WeMediaBuddyData';
const gameRoot = 'J:\\PigeonYang\\WeMediaBuddy\\data\\gamedata';
const aiId = 'a755adf2-4e8d-4abd-b616-4d7934f730f1';
const gameId = '71fc446c-6e5b-4f4f-91a0-3b7d0c669ff2';
const cdpPort = 29419;
let launched;
try {
  launched = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  let current = await waitForAnyWorkspace();
  if (current.activeWorkspaceId !== gameId) {
    await current.page.evaluate((id) => window.wmb.switchWorkspace(id).catch(() => null), gameId).catch(() => {});
    current = await waitForWorkspace(gameId);
  }
  const gameMcp = (await current.page.evaluate(() => window.wmb.getSettings())).mcp.url;
  await current.page.evaluate((id) => window.wmb.switchWorkspace(id).catch(() => null), aiId).catch(() => {});
  current = await waitForWorkspace(aiId);
  const aiSettings = await current.page.evaluate(() => window.wmb.getSettings());
  assert.equal(aiSettings.paths.dataRoot, aiRoot);
  assert.equal(aiSettings.pi.configured, true);
  assert.notEqual(aiSettings.mcp.url, gameMcp);
  await assert.rejects(() => request(gameMcp, 1000));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const before = businessProjection(aiRoot);
  const logsBefore = await xhsLogs(aiRoot);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const during = businessProjection(aiRoot);
  assert.deepEqual(changedTables(before, during), []);
  await current.page.evaluate((id) => window.wmb.switchWorkspace(id).catch(() => null), gameId).catch(() => {});
  current = await waitForWorkspace(gameId);
  const gameSettings = await current.page.evaluate(() => window.wmb.getSettings());
  assert.equal(gameSettings.paths.dataRoot, gameRoot);
  assert.equal(gameSettings.pi.configured, false);
  assert.equal(gameSettings.xhs.status, 'not_started');
  const inactiveBefore = businessProjection(aiRoot);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const inactiveAfter = businessProjection(aiRoot);
  assert.deepEqual(changedTables(inactiveBefore, inactiveAfter), []);
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), '.ai', 'wmb-1901-ai-baseline.json'), 'utf8'));
  const baseline = await verifyBaseline(aiRoot, manifest);
  assert.deepEqual(baseline.violations, ['business table changed: operation_log', 'business table changed: ranking_cache', 'business table changed: work_carry_items']);
  const receipt = { aiRoot, gameRoot, activeAfter: gameId, aiMigrations: migrationCount(aiRoot), observedMs: 3000, activeBusinessProjection: before.digest, inactiveBusinessProjection: inactiveBefore.digest, activeAiUnchanged: true, inactiveAiUnchanged: true, drainedBeforeDeactivation: changedTables(before, inactiveBefore), aiPiConfigured: true, gamePiConfigured: false, gameXhsStatus: 'not_started', oldGameMcpRejected: true, baseline: { immutableManifestPreserved: true, historicalViolations: baseline.violations }, allowedRuntimeLogs: { before: logsBefore, after: await xhsLogs(aiRoot) } };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1907-ai-stability.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  await killPortOwner().catch(() => {});
  if (launched?.pid) await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
}

function businessProjection(root) { const db = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true }); try { const excluded = new Set(['app_meta', 'schema_migrations', 'workspace_profiles']); const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name).filter((name) => !excluded.has(name)); const rows = Object.fromEntries(tables.map((name) => { const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((row) => row.name); const order = columns.map((column) => `"${column}"`).join(','); return [name, db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).all()]; })); const hashes = Object.fromEntries(Object.entries(rows).map(([name, value]) => [name, createHash('sha256').update(JSON.stringify(value)).digest('hex')])); return { digest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), counts: Object.fromEntries(Object.entries(rows).map(([name, value]) => [name, value.length])), hashes }; } finally { db.close(); } }
function changedTables(before, after) { return Object.keys(before.hashes).filter((name) => before.hashes[name] !== after.hashes[name]); }
function migrationCount(root) { const db = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true }); try { return db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count; } finally { db.close(); } }
async function xhsLogs(root) { try { return (await readdir(path.join(root, 'xiaohongshu-mcp', 'logs'))).sort(); } catch { return []; } }
async function waitForWorkspace(id) { for (let i = 0; i < 160; i++) { try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#root', { timeout: 1000 }); const listed = await page.evaluate(() => window.wmb.listWorkspaces()); if (listed.activeWorkspaceId === id) return { browser, page }; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`workspace ${id} did not become active`); }
async function waitForAnyWorkspace() { for (let i = 0; i < 160; i++) { try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#root', { timeout: 1000 }); const listed = await page.evaluate(() => window.wmb.listWorkspaces()); if ([aiId, gameId].includes(listed.activeWorkspaceId)) return { browser, page, activeWorkspaceId: listed.activeWorkspaceId }; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error('known workspace did not become active'); }
async function request(url, timeout) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { const response = await fetch(url, { method: 'POST', signal: controller.signal }); if (!response.ok) throw new Error(String(response.status)); return response; } finally { clearTimeout(timer); } }
async function portOwner() { const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${cdpPort} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { windowsHide: true }); const pid = Number(stdout.trim()); if (!pid) throw new Error('no CDP owner'); return pid; }
async function killPortOwner() { await execFileAsync('taskkill.exe', ['/PID', String(await portOwner()), '/T', '/F'], { windowsHide: true }); }
