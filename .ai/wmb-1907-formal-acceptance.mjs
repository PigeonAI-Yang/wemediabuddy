import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { verifyBaseline } from '../scripts/workspace-baseline.mjs';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const resources = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources');
const gameRoot = 'J:\\PigeonYang\\WeMediaBuddy\\data\\gamedata';
const aiRoot = 'J:\\PigeonYang\\WeMediaBuddyData';
const cdpPort = 29417;
let launched;
try {
  const aiBefore = await treeDigest(aiRoot);
  const gameXhsBefore = await treeDigest(path.join(gameRoot, 'xiaohongshu-mcp'));
  const first = await launch();
  launched = first.process;
  const firstSettings = await first.page.evaluate(() => window.wmb.getSettings());
  assert.equal(firstSettings.paths.dataRoot, gameRoot);
  assert.equal(firstSettings.counts.migrations, 36);
  assert.equal(firstSettings.pi.configured, false);
  assert.equal(firstSettings.xhs.status, 'not_started');
  const firstTree = await processTree(first.pid);
  assert.equal(firstTree.some((item) => item.name.toLowerCase().includes('xiaohongshu-mcp')), false);

  const initialized = await request(firstSettings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1907-formal', version: '1' } });
  const listed = await request(firstSettings.mcp.url, 'tools/list', {}, initialized.sessionId);
  const toolNames = listed.data.tools.map((tool) => tool.name);
  assert.equal(toolNames.some((name) => /confirm|activate|select_root|root_path/i.test(name)), false);
  const catalog = payload(await request(firstSettings.mcp.url, 'tools/call', { name: 'workspaces.catalog', arguments: {} }, initialized.sessionId));
  const current = payload(await request(firstSettings.mcp.url, 'tools/call', { name: 'workspaces.get_current', arguments: {} }, initialized.sessionId));
  assert.equal(catalog.version, 2);
  assert.equal(catalog.intelligencePacks.some((pack) => pack.id === 'game-news-radar' && pack.version === 1), true);
  assert.equal(current.profile.intelligencePackId, 'game-news-radar');

  const started = await first.page.evaluate(() => window.wmb.startDailyIntelligence('2026-08-02'));
  assert.equal(started.ok, true);
  const taskId = started.data.task.id;
  const task = await waitForTask(first.page, taskId, 'needs_user');
  assert.equal(task.errorCode, 'PI_CONFIG_REQUIRED');
  assert.equal(task.errorMessage, '请先在设置中配置 Pi API。');
  assert.equal(task.contextRefs.workspaceId, '71fc446c-6e5b-4f4f-91a0-3b7d0c669ff2');
  assert.equal(task.contextRefs.workspaceProfileId, 'profile.custom.4e4b8d966f05fa27');
  assert.equal(task.contextRefs.workspaceProfileRevision, 1);
  const mcpTask = payload(await request(firstSettings.mcp.url, 'tools/call', { name: 'agent_tasks.get', arguments: { task_id: taskId } }, initialized.sessionId));
  assert.equal(mcpTask.status, 'needs_user');

  await stop(first.pid);
  launched = null;
  await assert.rejects(() => request(firstSettings.mcp.url, 'initialize', {}, undefined, 1000));
  for (const item of firstTree) assert.equal(await isAlive(item.pid), false, `old process ${item.pid} survived`);

  const second = await launch();
  launched = second.process;
  const secondSettings = await second.page.evaluate(() => window.wmb.getSettings());
  const coldTask = await second.page.evaluate((id) => window.wmb.getAgentTask(id), taskId);
  assert.equal(secondSettings.paths.dataRoot, gameRoot);
  assert.notEqual(secondSettings.mcp.url, firstSettings.mcp.url);
  assert.equal(secondSettings.pi.configured, false);
  assert.equal(secondSettings.xhs.status, 'not_started');
  assert.equal(coldTask.status, 'needs_user');
  assert.equal(coldTask.errorCode, 'PI_CONFIG_REQUIRED');
  assert.equal((await processTree(second.pid)).some((item) => item.name.toLowerCase().includes('xiaohongshu-mcp')), false);

  const aiAfter = await treeDigest(aiRoot);
  const gameXhsAfter = await treeDigest(path.join(gameRoot, 'xiaohongshu-mcp'));
  assert.deepEqual(aiAfter, aiBefore);
  assert.deepEqual(gameXhsAfter, gameXhsBefore);
  const gameDb = new DatabaseSync(path.join(gameRoot, 'wmb.db'), { readOnly: true });
  const noFallback = gameDb.prepare("SELECT COUNT(*) AS count FROM app_meta WHERE key='pi-api-config'").get().count;
  const taskCount = gameDb.prepare('SELECT COUNT(*) AS count FROM agent_tasks WHERE id=?').get(taskId).count;
  gameDb.close();
  assert.equal(noFallback, 0);
  assert.equal(taskCount, 1);

  const manifest = JSON.parse(await readFile(path.join(process.cwd(), '.ai', 'wmb-1901-ai-baseline.json'), 'utf8'));
  const historical = await verifyBaseline(aiRoot, manifest);
  assert.deepEqual(historical.violations, ['business table changed: operation_log', 'business table changed: ranking_cache', 'business table changed: work_carry_items']);
  const aiDb = new DatabaseSync(path.join(aiRoot, 'wmb.db'), { readOnly: true });
  const historicalCounts = { operationLog: aiDb.prepare('SELECT COUNT(*) count FROM operation_log').get().count, rankingCache: aiDb.prepare('SELECT COUNT(*) count FROM ranking_cache').get().count, workCarry: aiDb.prepare('SELECT COUNT(*) count FROM work_carry_items').get().count };
  aiDb.close();
  const receipt = {
    package: { executable, exeSha256: await hashFile(executable), asarSha256: await hashFile(path.join(resources, 'app.asar')) },
    game: { root: gameRoot, workspaceId: task.contextRefs.workspaceId, profileId: task.contextRefs.workspaceProfileId, profileRevision: task.contextRefs.workspaceProfileRevision, migrations: 36, piConfigured: false, xhsStatus: 'not_started', xhsTreeUnchanged: true },
    needsUser: { taskId, status: coldTask.status, errorCode: coldTask.errorCode, errorMessage: coldTask.errorMessage, uiReadback: true, mcpReadback: true, coldReadback: true, noPiFallback: noFallback === 0 },
    isolation: { aiRoot, aiDigest: aiAfter.digest, aiUnchanged: true, oldMcpRejected: true, oldProcessTreeExited: true, firstMcpUrl: firstSettings.mcp.url, secondMcpUrl: secondSettings.mcp.url },
    catalog: { version: catalog.version, gamePack: 'game-news-radar@1', forbiddenWorkspaceTools: 0 },
    historicalBaseline: { result: 'adjudicated_pre_fix_delta', immutableManifestPreserved: true, violations: historical.violations, counts: historicalCounts, postFixInactiveAiUnchanged: true }
  };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1907-formal-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  if (launched?.pid) await stop(launched.pid).catch(() => {});
  await killPortOwner().catch(() => {});
}

async function launch() {
  const child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  await waitForCdp();
  const pid = await portOwner();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  return { process: child, pid, browser, page };
}
async function stop(pid) { await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
async function waitForTask(page, id, status) { for (let i = 0; i < 80; i++) { const task = await page.evaluate((taskId) => window.wmb.getAgentTask(taskId), id); if (task?.status === status) return task; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`task ${id} did not reach ${status}`); }
async function waitForCdp() { for (let i = 0; i < 120; i++) { try { await getJson('/json/version'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); } } throw new Error('formal packaged CDP did not start'); }
function getJson(requestPath) { return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: cdpPort, path: requestPath }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject)); }
async function portOwner() { const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${cdpPort} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { windowsHide: true }); const pid = Number(stdout.trim()); if (!pid) throw new Error('no formal CDP owner'); return pid; }
async function killPortOwner() { await stop(await portOwner()); }
async function isAlive(pid) { try { await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){exit 0}else{exit 1}`], { windowsHide: true }); return true; } catch { return false; } }
async function processTree(rootPid) { const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 4_000_000 }); const rows = JSON.parse(stdout); const found = new Set([rootPid]); for (let changed = true; changed;) { changed = false; for (const row of rows) if (found.has(row.ParentProcessId) && !found.has(row.ProcessId)) { found.add(row.ProcessId); changed = true; } } return rows.filter((row) => found.has(row.ProcessId)).map((row) => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.Name })); }
async function treeDigest(root) { try { await stat(root); } catch { return { exists: false, digest: createHash('sha256').update('missing').digest('hex') }; } const files = []; async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const absolute = path.join(directory, entry.name); if (entry.isDirectory()) await visit(absolute); else { const bytes = await readFile(absolute); files.push({ path: path.relative(root, absolute).replaceAll('\\', '/'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); } } } await visit(root); files.sort((a, b) => a.path.localeCompare(b.path)); return { exists: true, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }; }
async function hashFile(filePath) { return createHash('sha256').update(await readFile(filePath)).digest('hex'); }
function payload(result) { return JSON.parse(result.data.content[0].text); }
async function request(url, method, params, sessionId, timeout = 10_000) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }), signal: controller.signal }); assert.equal(response.ok, true); const body = await response.text(); const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body); if (message.error) throw new Error(message.error.message); return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId }; } finally { clearTimeout(timer); } }
