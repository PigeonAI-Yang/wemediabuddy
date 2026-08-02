import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { enrollAiWorkspace } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1906-ui-'));
const userData = path.join(temp, 'user-data');
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const cdpPort = 29406;
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
  const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1906-ui', version: '1' } });
  const prepared = payload(await request(settings.mcp.url, 'tools/call', { name: 'workspaces.proposals.prepare', arguments: {
    request_id: 'wmb-1906-ui-ready', target: 'new', purpose: 'self_media', display_name: '游戏资讯', audience: '关注 PC、主机和热门跨平台游戏的中文玩家',
    content_goal: '持续发现并创作有官方来源、能帮助玩家判断购买更新与参与时机的游戏资讯', editorial_brief: '先回到平台、开发商或发行商原文核对游戏、版本、日期和平台，再用简洁中文说明玩家影响；传闻与事实分开。',
    intelligence_pack_id: 'game-news-radar', intelligence_pack_version: 1, creation_pack_id: 'wmb-core-creation', creation_pack_version: 1, platforms: ['x']
  } }, initialized.sessionId));
  assert.equal(prepared.ok, true);
  await page.getByTitle('设置').click();
  await page.getByRole('button', { name: '数据与存储' }).click();
  await page.getByText('待确认：游戏资讯').waitFor();
  const content = await page.locator('.settings-content').innerText();
  for (const expected of ['关注 PC、主机和热门跨平台游戏的中文玩家', '帮助玩家判断购买更新与参与时机', 'game-news-radar@1', 'wmb-core-creation@1', '新工作空间目录：尚未选择', '完整差异：']) assert.match(content, new RegExp(expected));
  assert.equal(await page.getByRole('button', { name: '选择数据目录' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '确认创建' }).isDisabled(), true);
  assert.equal(await page.locator('.settings-content input').count(), 0);
  const screenshot = path.join(process.cwd(), '.ai', 'wmb-1906-ui-ready.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const receipt = { proposalId: prepared.data.id, fullResultShown: true, fullDiffShown: true, selectedRootShown: '尚未选择', chooseButtonVisible: true, confirmDisabledBeforeSelection: true, arbitraryPathInputCount: 0, screenshot };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1906-ui-ready.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  if (launched?.pid) await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

function payload(result) { return JSON.parse(result.data.content[0].text); }
async function waitForCdp(port) { for (let i = 0; i < 100; i++) { try { await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/json/version' }, (response) => { response.resume(); response.on('end', resolve); }).on('error', reject)); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); } } throw new Error('packaged CDP did not start'); }
async function request(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true); const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (message.error) throw new Error(message.error.message); return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
