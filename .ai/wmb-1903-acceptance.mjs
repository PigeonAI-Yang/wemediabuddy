import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { enrollAiWorkspace } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1903-live-'));
const userData = path.join(temp, 'user-data');
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-1903-acceptance.json');
const cdpPort = 29403;
let launched;
try {
  await mkdir(userData, { recursive: true });
  const aiRoot = await createRoot(path.join(temp, 'ai'));
  const ukRoot = await createRoot(path.join(temp, 'uk'));
  const registryPath = path.join(userData, 'workspace-registry.json');
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path, displayName: 'AI' });
  const uk = await enrollAiWorkspace({ registryPath: path.join(temp, 'uk-registry.json'), rootPath: ukRoot.path, displayName: 'UK' });
  await writeFile(registryPath, JSON.stringify({ version: 1, activeWorkspaceId: ai.id, workspaces: [ai, uk], switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: aiRoot.path }), 'utf8');
  const dueAt = new Date(Date.now() + 1_500).toISOString();
  const db = new DatabaseSync(path.join(aiRoot.path, 'wmb.db'));
  db.prepare('INSERT INTO jobs (id, kind, status, due_at, dedupe_key, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('inactive-due-sentinel', 'metric_capture', 'pending', dueAt, 'inactive-due-sentinel', '{}', dueAt, dueAt);
  db.close();

  const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
  launched = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  await waitForCdp(cdpPort);
  const firstMainPid = await portOwner(cdpPort);
  const oldTree = await processTree(firstMainPid);
  const firstBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const firstPage = firstBrowser.contexts()[0].pages()[0];
  await firstPage.waitForSelector('#root', { timeout: 30_000 });
  const firstSettings = await firstPage.evaluate(() => window.wmb.getSettings());
  const firstWorkspaces = await firstPage.evaluate(() => window.wmb.listWorkspaces());
  assert.equal(firstWorkspaces.activeWorkspaceId, ai.id);
  assert.deepEqual(firstWorkspaces.workspaces.map((item) => item.displayName), ['AI', 'UK']);
  await firstPage.getByTitle('设置').click();
  await firstPage.getByRole('button', { name: '数据与存储' }).click();
  await firstPage.waitForFunction((id) => document.body.innerText.includes(id), ai.id);
  const uiText = await firstPage.locator('.settings-content').innerText();
  assert.match(uiText, /AI/); assert.match(uiText, /UK/); assert.match(uiText, new RegExp(ai.id));
  await firstPage.evaluate((targetId) => window.wmb.switchWorkspace(targetId).catch(() => null), uk.id).catch(() => {});

  const second = await waitForWorkspace(cdpPort, uk.id);
  const secondSettings = await second.page.evaluate(() => window.wmb.getSettings());
  const secondWorkspaces = await second.page.evaluate(() => window.wmb.listWorkspaces());
  const secondMainPid = await portOwner(cdpPort);
  assert.equal(secondWorkspaces.activeWorkspaceId, uk.id);
  assert.equal(secondSettings.paths.dataRoot, ukRoot.path);
  assert.notEqual(secondMainPid, firstMainPid);
  assert.notEqual(secondSettings.mcp.url, firstSettings.mcp.url);
  await assert.rejects(() => request(firstSettings.mcp.url, 1_000));
  for (const pid of oldTree) assert.equal(await isAlive(pid), false, `old process ${pid} survived`);

  const inactiveBefore = await treeDigest(aiRoot.path);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const inactiveAfter = await treeDigest(aiRoot.path);
  assert.deepEqual(inactiveAfter, inactiveBefore);
  const inactiveDb = new DatabaseSync(path.join(aiRoot.path, 'wmb.db'), { readOnly: true });
  const dueJobStatus = inactiveDb.prepare("SELECT status FROM jobs WHERE id = 'inactive-due-sentinel'").get().status;
  inactiveDb.close();
  assert.equal(dueJobStatus, 'pending');

  const receipt = {
    packagedExe: executable,
    roots: { ai: aiRoot.path, uk: ukRoot.path },
    workspaceIds: { ai: ai.id, uk: uk.id },
    first: { pid: firstMainPid, mcpUrl: firstSettings.mcp.url, oldTree },
    second: { pid: secondMainPid, mcpUrl: secondSettings.mcp.url, activeWorkspaceId: secondWorkspaces.activeWorkspaceId },
    ui: { listed: ['AI', 'UK'], showedWorkspaceId: true },
    inactiveDueWindow: { dueAt, observedMs: 2_500, digest: inactiveAfter.digest, jobStatus: dueJobStatus },
    oldMcpRejected: true,
    oldProcessTreeExited: true
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  await killPortOwner(cdpPort).catch(() => {});
  if (launched?.pid) await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

async function createRoot(rootPath) {
  const root = await openDataRoot(rootPath);
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  return root;
}

async function waitForCdp(port) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await getJson(port, '/json/version'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error('packaged CDP did not start');
}

async function waitForWorkspace(port, workspaceId) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForSelector('#root', { timeout: 1_000 });
      const workspaces = await page.evaluate(() => window.wmb.listWorkspaces());
      if (workspaces.activeWorkspaceId === workspaceId) return { browser, page };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('restarted workspace did not become active');
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
    let body = ''; response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

function request(url, timeoutMs) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get(target, resolve); req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

async function processTree(rootPid) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 4_000_000 });
  const rows = JSON.parse(stdout); const found = new Set([rootPid]);
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (found.has(row.ParentProcessId) && !found.has(row.ProcessId)) { found.add(row.ProcessId); changed = true; } }
  return [...found];
}

async function portOwner(port) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { windowsHide: true });
  const pid = Number(stdout.trim()); if (!pid) throw new Error(`no owner for ${port}`); return pid;
}

async function isAlive(pid) {
  try { await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){exit 0}else{exit 1}`], { windowsHide: true }); return true; } catch { return false; }
}

async function killPortOwner(port) {
  const pid = await portOwner(port); await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

async function treeDigest(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else { const bytes = await readFile(absolute); const info = await stat(absolute); files.push({ path: path.relative(root, absolute), size: info.size, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    }
  }
  await visit(root); files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
