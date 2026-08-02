import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createOfficialWorkspace, createProposedWorkspace, enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1909-renderer-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const runs = [];
try {
  await mkdir(userData, { recursive: true });
  const aiRoot = await openDataRoot(path.join(temp, 'ai'));
  migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path });
  const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), templateId: 'official.uk' });
  const game = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'game'), profile: {
    profileId: 'profile.game.renderer-acceptance', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
    displayName: '游戏资讯', audience: '中文玩家', contentGoal: '核验并创作游戏资讯', editorialBrief: '先核验官方来源。',
    intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
  } });
  const registry = await readWorkspaceRegistry(registryPath);
  for (const [index, workspace] of [ai, uk, game].entries()) {
    seedSource(workspace.rootPath);
    await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
    await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
    const cdpPort = 29530 + index;
    let stderr = '';
    const launched = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    launched.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      const browser = await waitForBrowser(cdpPort);
      const page = browser.contexts()[0].pages()[0];
      await page.evaluate(() => { localStorage.setItem('wmb.view', 'discover'); localStorage.removeItem('wmb.discoverSection'); });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.discover-page', { timeout: 30_000 });
      await page.waitForTimeout(600);
      const discover = await page.evaluate(() => ({
        pack: document.querySelector('.discover-page')?.getAttribute('data-intelligence-pack'),
        tabs: [...document.querySelectorAll('.discover-categories button')].map((item) => item.textContent),
        text: document.querySelector('.discover-page')?.textContent ?? ''
      }));
      const aiLane = workspace === ai;
      assert.deepEqual(discover.tabs, aiLane ? ['榜单', 'X Lists'] : ['X Lists']);
      if (!aiLane) { assert.doesNotMatch(discover.text, /榜单|AI前沿/); assert.match(discover.text, /请先选择 Pyaireader 专用 X 登录态/); }
      await page.getByRole('button', { name: '资料库', exact: true }).click();
      await page.waitForSelector('.lib-row .source-mark', { timeout: 10_000 });
      const sourceFallback = await page.locator('.lib-row .source-mark').first().evaluate((node) => node.classList.contains('source-mark-fallback'));
      assert.equal(sourceFallback, !aiLane);
      const settings = await page.evaluate(() => window.wmb.getSettings());
      assert.equal(settings.workspace.id, workspace.id);
      assert.equal(settings.browserOptions[0].userDataDir, path.join(workspace.rootPath, 'browser-profile'));
      if (!aiLane) assert.doesNotMatch(stderr, /rankings:get|ai\.library\.rankings|sources:wire-health/);
      runs.push({ workspaceId: workspace.id, displayName: workspace.displayName, pack: discover.pack, tabs: discover.tabs, xLoginState: aiLane ? null : 'needs_user', aiSourcePresentation: !sourceFallback, browserProfile: settings.browserOptions[0].userDataDir, forbiddenAiIpcObserved: false });
      await browser.close();
    } finally { await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); }
  }
  const receipt = { runs };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1909-renderer-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

function seedSource(rootPath) {
  const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
  try { upsertSource(database, { title: 'OpenAI source presentation sentinel', originalUrl: 'https://openai.com/news/', categories: ['acceptance'] }); }
  finally { database.close(); }
}

async function waitForBrowser(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) return browser; }
    catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP ${port} did not start`);
}
