import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createOfficialWorkspace, createProposedWorkspace, enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1908-package-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const expectedXTools = ['x_lists.collect_timeline', 'x_lists.get_operation', 'x_lists.list_bindings', 'x_lists.prepare', 'x_lists.read_detail', 'x_lists.read_index', 'x_lists.read_members', 'x_lists.read_timeline'];
const runs = [];
let launched;
try {
  await mkdir(userData, { recursive: true });
  const aiRoot = await openDataRoot(path.join(temp, 'ai'));
  migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path });
  const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), templateId: 'official.uk' });
  const game = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'game'), profile: {
    profileId: `profile.game.${randomUUID()}`, revision: 1, officialTemplateId: null, officialTemplateVersion: null,
    displayName: '游戏资讯', audience: '中文玩家', contentGoal: '核验并创作游戏资讯', editorialBrief: '先核验官方来源。',
    intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
  } });
  const registry = await readWorkspaceRegistry(registryPath);
  for (const [index, workspace] of [ai, uk, game].entries()) {
    await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
    await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
    const cdpPort = 29510 + index;
    launched = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
    await waitForCdp(cdpPort);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('#root', { timeout: 30_000 });
    const settings = await page.evaluate(() => window.wmb.getSettings());
    assert.equal(settings.workspace.id, workspace.id);
    assert.equal(settings.workspace.dataRoot.path, workspace.rootPath);
    assert.equal(settings.browserOptions[0].userDataDir, path.join(workspace.rootPath, 'browser-profile'));
    const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1908', version: '1' } });
    const listed = await request(settings.mcp.url, 'tools/list', {}, initialized.sessionId);
    const names = listed.data.tools.map((tool) => tool.name);
    assert.deepEqual(names.filter((name) => name.startsWith('x_lists.')).sort(), expectedXTools);
    assert.equal(names.includes('x_lists.confirm'), false);
    assert.equal(names.includes('sources.wire_health_get'), index === 0);
    const current = payload(await request(settings.mcp.url, 'tools/call', { name: 'workspaces.get_current', arguments: {} }, initialized.sessionId));
    assert.equal(current.id, settings.workspace.id);
    assert.deepEqual(current.capabilities, settings.workspace.capabilities);
    const before = operationCount(workspace.rootPath);
    const missingLogin = payload(await request(settings.mcp.url, 'tools/call', { name: 'x_lists.prepare', arguments: { request_id: `missing-${index}`, account_key: '@wrong', kind: 'create', name: 'must-not-write' } }, initialized.sessionId));
    assert.equal(missingLogin.error.code, 'BROWSER_NEEDS_USER');
    assert.equal(missingLogin.error.details.state, 'needs_user');
    assert.equal(operationCount(workspace.rootPath), before);
    await page.waitForFunction((name) => document.body.innerText.includes(name), workspace.displayName);
    const oldUrl = settings.mcp.url;
    const pid = launched.pid;
    if (index === 0) {
      const prepared = payload(await request(oldUrl, 'tools/call', { name: 'workspaces.proposals.prepare', arguments: {
        request_id: 'active-ai-to-game', target: 'current', purpose: 'self_media', display_name: 'AI', audience: '中文玩家', content_goal: '核验并创作游戏资讯', editorial_brief: '先核验官方来源。',
        intelligence_pack_id: 'game-news-radar', intelligence_pack_version: 1, creation_pack_id: 'wmb-core-creation', creation_pack_version: 1, platforms: ['x']
      } }, initialized.sessionId));
      const binding = (await page.evaluate(() => window.wmb.listWorkspaceProposals())).find((item) => item.proposal.id === prepared.data.id).binding;
      await page.evaluate((value) => { void window.wmb.confirmWorkspaceProposal(value).catch(() => {}); }, binding);
      await waitForMcpRejection(oldUrl);
      await waitForExit(pid);
      await browser.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 750));
      await waitForCdp(cdpPort);
      const nextBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const nextPage = nextBrowser.contexts()[0].pages()[0];
      await nextPage.waitForSelector('#root', { timeout: 30_000 });
      const nextSettings = await nextPage.evaluate(() => window.wmb.getSettings());
      assert.notEqual(nextSettings.mcp.url, oldUrl);
      assert.equal(nextSettings.workspace.profile.intelligencePackId, 'game-news-radar');
      const nextInit = await request(nextSettings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1908-relaunched', version: '1' } });
      const nextNames = (await request(nextSettings.mcp.url, 'tools/list', {}, nextInit.sessionId)).data.tools.map((tool) => tool.name);
      assert.equal(nextNames.includes('sources.wire_health_get'), false);
      assert.deepEqual(nextNames.filter((name) => name.startsWith('x_lists.')).sort(), expectedXTools);
      const nextPid = await pidForPort(cdpPort);
      await nextBrowser.close();
      await stop(nextPid);
      launched = null;
      await assert.rejects(() => request(nextSettings.mcp.url, 'initialize', {}, undefined, 1_000));
      runs.push({ workspaceId: workspace.id, displayName: workspace.displayName, rootPath: workspace.rootPath, profileId: current.profile.profileId, mcpUrl: oldUrl, pid, genericXTools: expectedXTools, wireHealth: true, missingLoginZeroWrite: true, oldMcpRejected: true, activeProfileRelaunch: { revision: nextSettings.workspace.profile.revision, newIntelligencePack: nextSettings.workspace.profile.intelligencePackId, newMcpUrl: nextSettings.mcp.url, oldRuntimeClosed: true, newWireHealth: false } });
      continue;
    }
    await browser.close();
    await stop(pid);
    launched = null;
    await assert.rejects(() => request(oldUrl, 'initialize', {}, undefined, 1_000));
    runs.push({ workspaceId: workspace.id, displayName: workspace.displayName, rootPath: workspace.rootPath, profileId: current.profile.profileId, mcpUrl: oldUrl, pid, genericXTools: expectedXTools, wireHealth: names.includes('sources.wire_health_get'), missingLoginZeroWrite: true, oldMcpRejected: true });
  }
  const piSource = await readFile(path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources', 'extensions', 'wmb-mcp', 'wmb-mcp-tools-x-lists.ts'), 'utf8');
  assert.match(piSource, /wmb_collect_x_list_timeline/);
  assert.doesNotMatch(piSource, /wmb_confirm_x_list_operation|x_lists\.confirm/);
  const receipt = { runs, piConfirmTools: 0, package: { exeSha256: await sha256(executable), asarSha256: await sha256(path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources', 'app.asar')) } };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1908-packaged-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  if (launched?.pid) await stop(launched.pid).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

function payload(result) { return JSON.parse(result.data.content[0].text); }
function operationCount(rootPath) { const db = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true }); try { return db.prepare('SELECT COUNT(*) AS count FROM x_list_operations').get().count; } finally { db.close(); } }
async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function stop(pid) { await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitForExit(pid) { for (let attempt = 0; attempt < 50; attempt++) { if (!isAlive(pid)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`old process ${pid} stayed alive`); }
async function pidForPort(port) { const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port}).OwningProcess`], { windowsHide: true }); return Number(stdout.trim()); }
async function waitForMcpRejection(url) { for (let attempt = 0; attempt < 80; attempt++) { try { await request(url, 'initialize', {}, undefined, 500); } catch { return; } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('old MCP stayed reachable'); }
async function waitForCdp(port) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/json/version' }, (response) => { response.resume(); response.on('end', resolve); }).on('error', reject)); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error('packaged CDP did not start');
}
async function request(url, method, params, sessionId, timeout = 10_000) {
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  assert.equal(response.ok, true);
  const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (message.error) throw new Error(message.error.message);
  return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
