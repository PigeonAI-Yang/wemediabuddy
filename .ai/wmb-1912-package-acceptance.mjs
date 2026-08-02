import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createOfficialWorkspace, createProposedWorkspace, enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const expectedXTools = ['x_lists.collect_timeline', 'x_lists.get_operation', 'x_lists.list_bindings', 'x_lists.prepare', 'x_lists.read_detail', 'x_lists.read_index', 'x_lists.read_members', 'x_lists.read_timeline'];
const labels = { x: 'X', xiaohongshu: '小红书', wechat: '公众号' };
const viewports = [{ width: 1100, height: 700 }, { width: 1920, height: 900 }];
const receipts = Object.fromEntries(await Promise.all(['1908-packaged', '1909-renderer', '1910-package', '1911-package'].map(async (name) => [name, JSON.parse(await readFile(path.join('.ai', `wmb-${name}-acceptance.json`), 'utf8'))])));
const packageHash = { exeSha256: await sha256(executable), asarSha256: await sha256(path.join(path.dirname(executable), 'resources', 'app.asar')) };

assert.deepEqual(receipts['1908-packaged'].package, packageHash);
assert.equal(receipts['1908-packaged'].piConfirmTools, 0);
assert.equal(receipts['1908-packaged'].runs.every((run) => run.oldMcpRejected && JSON.stringify(run.genericXTools) === JSON.stringify(expectedXTools)), true);
assert.equal(receipts['1909-renderer'].runs.filter((run) => run.pack !== 'wemedia-intelligence-engine').every((run) => !run.aiSourcePresentation && !run.forbiddenAiIpcObserved), true);
assert.equal(new Set(receipts['1910-package'].runs.map((run) => run.listSourceChain)).size, 3);
assert.equal(receipts['1910-package'].runs.every((run) => run.needsUserTaskIds.length === 3), true);
assert.equal(receipts['1911-package'].emptyRoot.views, 8);
assert.equal(receipts['1911-package'].rootB.canvasCount, 0);

const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1912-package-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const runs = [];
try {
  await mkdir(userData, { recursive: true });
  const aiRoot = await openDataRoot(path.join(temp, 'ai'));
  migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path });
  const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), templateId: 'official.uk' });
  const game = await proposed('游戏资讯', path.join(temp, 'game'), ['x']);
  const noX = await proposed('无 X 发布能力', path.join(temp, 'no-x'), ['wechat']);
  const registry = await readWorkspaceRegistry(registryPath);

  for (const [index, workspace] of [ai, uk, game, noX].entries()) {
    await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
    await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
    const port = 29570 + index;
    const child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
    try {
      const browser = await waitForBrowser(port);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForSelector('#root', { timeout: 30_000 });
      const settings = await page.evaluate(() => window.wmb.getSettings());
      assert.equal(settings.workspace.id, workspace.id);
      const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1912', version: '1' } });
      const listed = await request(settings.mcp.url, 'tools/list', {}, initialized.sessionId);
      const names = listed.data.tools.map((tool) => tool.name);
      assert.deepEqual(names.filter((name) => name.startsWith('x_lists.')).sort(), expectedXTools);
      assert.equal(names.some((name) => name.includes('confirm')), false);
      const viewportReadback = [];
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => localStorage.setItem('wmb.view', 'discover'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.discover-categories', { timeout: 15_000 });
        const tabs = await page.locator('.discover-categories button').allTextContents();
        assert.deepEqual(tabs, index === 0 ? ['榜单', 'X Lists'] : ['X Lists']);
        assert.match(await page.textContent('body'), new RegExp(workspace.displayName));
        await page.getByRole('button', { name: '创作', exact: true }).click();
        await page.waitForSelector('select[aria-label="平台筛选"]', { timeout: 15_000 });
        const platformOptions = await page.locator('select[aria-label="平台筛选"] option').allTextContents();
        assert.deepEqual(platformOptions, ['全部平台', ...settings.workspace.capabilities.publishingPlatforms.map((platform) => labels[platform])]);
        viewportReadback.push({ ...viewport, tabs, platformOptions, rootVisible: true });
      }
      runs.push({ displayName: workspace.displayName, workspaceId: workspace.id, platforms: settings.workspace.capabilities.publishingPlatforms, genericXTools: expectedXTools, confirmTools: 0, viewportReadback });
      await browser.close();
    } finally {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
  }
  assert.equal(runs.at(-1).platforms.includes('x'), false);
  const receipt = { package: packageHash, runs, reusedCurrentPackageReceipts: ['wmb-1908-packaged-acceptance.json', 'wmb-1909-renderer-acceptance.json', 'wmb-1910-package-acceptance.json', 'wmb-1911-package-acceptance.json'] };
  await writeFile(path.join('.ai', 'wmb-1912-package-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

async function proposed(displayName, rootPath, platforms) {
  return createProposedWorkspace({ registryPath, rootPath, profile: { profileId: `profile.game.${randomUUID()}`, revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName, audience: '中文玩家', contentGoal: '核验并创作资讯', editorialBrief: '官方优先', intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms } });
}
async function sha256(target) { return createHash('sha256').update(await readFile(target)).digest('hex'); }
async function waitForBrowser(port) { for (let attempt = 0; attempt < 120; attempt += 1) { try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) return browser; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`CDP ${port} did not start`); }
async function request(url, method, params, sessionId) { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); assert.equal(response.ok, true); const body = await response.text(); const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body); return { data: payload.result ?? payload.error, sessionId: response.headers.get('mcp-session-id') ?? sessionId }; }
