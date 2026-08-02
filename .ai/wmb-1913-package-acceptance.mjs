import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { createProposedWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1913-package-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
let child;
try {
  await mkdir(userData, { recursive: true });
  const workspace = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'game'), profile: { profileId: 'profile.game.wmb-1913', revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName: '游戏资讯', audience: '中文玩家', contentGoal: '游戏资讯', editorialBrief: '官方优先', intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] } });
  const registry = await readWorkspaceRegistry(registryPath);
  await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
  child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: '29580', WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  const browser = await waitForBrowser();
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  const runs = [];
  for (const viewport of [{ width: 1100, height: 700 }, { width: 1920, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => localStorage.setItem('wmb.view', 'today'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.getByLabel('全局搜索').count(), 0);
    assert.equal((await page.textContent('body')).includes('搜索主题或项目'), false);
    await page.waitForFunction(() => document.querySelector('.brand')?.textContent?.includes('游戏资讯'));
    assert.match(await page.locator('.brand').textContent(), /WeMediaBuddy.*游戏资讯/);
    await page.getByRole('button', { name: '创作', exact: true }).click();
    assert.equal(await page.getByLabel('搜索内容项目').count(), 1);
    runs.push({ ...viewport, globalSearch: 0, studioSearch: 1, brandVisible: true });
  }
  await browser.close();
  await writeFile(path.join('.ai', 'wmb-1913-package-acceptance.json'), `${JSON.stringify({ runs }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ runs }));
} finally {
  if (child) await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

async function waitForBrowser() { for (let attempt = 0; attempt < 120; attempt += 1) { try { const browser = await chromium.connectOverCDP('http://127.0.0.1:29580'); if (browser.contexts()[0]?.pages()[0]) return browser; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error('CDP 29580 did not start'); }
