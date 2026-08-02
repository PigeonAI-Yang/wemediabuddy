import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { enrollAiWorkspace } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const cdpPort = 29405;
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1905-package-'));
const userData = path.join(temp, 'user-data');
let launched;
try {
  await mkdir(userData, { recursive: true });
  const root = await openDataRoot(path.join(temp, 'ai'));
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  await enrollAiWorkspace({ registryPath: path.join(userData, 'workspace-registry.json'), rootPath: root.path });
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: root.path }), 'utf8');
  launched = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  await waitForCdp(cdpPort);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  const settings = await page.evaluate(() => window.wmb.getSettings());
  const workspaces = await page.evaluate(() => window.wmb.listWorkspaces());
  const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1905-acceptance', version: '1' } });
  const listed = await request(settings.mcp.url, 'tools/list', {}, initialized.sessionId);
  const names = listed.data.tools.map((tool) => tool.name);
  const expected = ['workspaces.list', 'workspaces.get_current', 'workspaces.catalog', 'workspaces.proposals.prepare'];
  for (const name of expected) assert.equal(names.includes(name), true);
  assert.equal(names.some((name) => name.startsWith('workspaces.') && /confirm|activate|delete|relink|path/i.test(name)), false);
  const current = payload(await request(settings.mcp.url, 'tools/call', { name: 'workspaces.get_current', arguments: {} }, initialized.sessionId));
  const catalog = payload(await request(settings.mcp.url, 'tools/call', { name: 'workspaces.catalog', arguments: {} }, initialized.sessionId));
  assert.equal(current.id, workspaces.activeWorkspaceId);
  assert.deepEqual(catalog.templates.map((item) => item.officialTemplateId), ['official.ai', 'official.uk']);
  const prepared = payload(await request(settings.mcp.url, 'tools/call', { name: 'workspaces.proposals.prepare', arguments: {
    request_id: 'wmb-1905-packaged', target: 'new', purpose: 'self_media', display_name: '开发者效率', audience: '使用 AI 编程工具的中文开发者',
    content_goal: '持续创作有实测证据的自媒体内容', editorial_brief: '先复现问题，再写可执行结论。',
    intelligence_pack_id: 'wemedia-intelligence-engine', intelligence_pack_version: 1, creation_pack_id: 'wmb-core-creation', creation_pack_version: 1,
    platforms: ['x', 'xiaohongshu']
  } }, initialized.sessionId));
  assert.equal(prepared.ok, true);
  const piSource = await readFile(path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources', 'extensions', 'wmb-mcp', 'wmb-mcp-tools-workspaces.ts'), 'utf8');
  assert.match(piSource, /wmb_prepare_workspace_profile/);
  assert.doesNotMatch(piSource, /wmb_(?:confirm|activate)_workspace/);
  const receipt = {
    executable, activeWorkspaceId: current.id, profileId: current.profile.profileId, catalogVersion: catalog.version,
    tools: expected, forbiddenWorkspaceTools: 0, proposal: { id: prepared.data.id, hash: prepared.data.normalizedHash, target: prepared.data.target },
    package: { exeSha256: await sha256(executable), asarSha256: await sha256(path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources', 'app.asar')) }
  };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1905-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  if (launched?.pid) await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

function payload(result) { return JSON.parse(result.data.content[0].text); }
async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function waitForCdp(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/json/version' }, (response) => { response.resume(); response.on('end', resolve); }).on('error', reject)); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error('packaged CDP did not start');
}
async function request(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true);
  const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (message.error) throw new Error(message.error.message);
  return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
