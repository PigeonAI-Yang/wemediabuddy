import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-2001-package-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
try {
  await mkdir(userData, { recursive: true });
  const aiRoot = path.join(temp, 'ai');
  const openedAiRoot = await openDataRoot(aiRoot); migrateDatabase(path.join(openedAiRoot.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot });
  const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), templateId: 'official.uk' });
  const game = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'game'), profile: { profileId: 'profile.game.wmb-2001', revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName: '游戏资讯', audience: '中文玩家', contentGoal: '游戏资讯', editorialBrief: '官方优先', intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] } });
  const aiDb = migrateDatabase(path.join(ai.rootPath, 'wmb.db'));
  const now = new Date().toISOString();
  aiDb.prepare('INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES (?,?,?,?,1)').run('pi-api-config', JSON.stringify({ activeId: 'one', profiles: [{ id: 'one', name: '共享主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', encryptedApiKey: 'cipher-one' }, { id: 'two', name: '共享备用接口', baseUrl: 'https://two.test/v1', model: 'model-two', api: 'openai-completions', encryptedApiKey: 'cipher-two' }] }), now, now);
  aiDb.close();
  const registry = await readWorkspaceRegistry(registryPath);

  const first = await launch({ ...registry, activeWorkspaceId: uk.id }, uk.rootPath, 29591);
  let ukReadback;
  try {
    const settings = await first.page.evaluate(() => window.wmb.getSettings());
    assert.equal(settings.workspace.id, uk.id);
    assert.deepEqual(settings.pi.profiles.map((profile) => ({ id: profile.id, model: profile.model, active: profile.active })), [{ id: 'one', model: 'model-one', active: true }, { id: 'two', model: 'model-two', active: false }]);
    await first.page.evaluate(() => localStorage.setItem('wmb.view', 'settings')); await first.page.reload({ waitUntil: 'domcontentloaded' });
    await first.page.waitForSelector('.settings-workspace');
    await first.page.locator('.settings-nav button[title="AI 与模型"]').click();
    assert.match(await first.page.textContent('body'), /本机共享/);
    const activated = await first.page.evaluate(() => window.wmb.activatePiConfig('two'));
    assert.equal(activated.activeId, 'two');
    ukReadback = { workspaceId: settings.workspace.id, activeId: settings.pi.activeId, models: settings.pi.profiles.map((profile) => profile.model) };
  } finally { await first.close(); }

  const second = await launch({ ...registry, activeWorkspaceId: game.id }, game.rootPath, 29592);
  let gameReadback;
  try {
    const settings = await second.page.evaluate(() => window.wmb.getSettings());
    assert.equal(settings.workspace.id, game.id);
    assert.equal(settings.pi.activeId, 'two');
    assert.equal(settings.pi.model, 'model-two');
    gameReadback = { workspaceId: settings.workspace.id, activeId: settings.pi.activeId, model: settings.pi.model };
  } finally { await second.close(); }

  assert.equal(rootConfigCount(uk.rootPath), 0);
  assert.equal(rootConfigCount(game.rootPath), 0);
  assert.equal(rootConfigCount(ai.rootPath), 1);
  const global = JSON.parse(await readFile(path.join(userData, 'pi-api-config.json'), 'utf8'));
  assert.equal(global.state.activeId, 'two');
  const receipt = { uk: ukReadback, game: gameReadback, global: { activeId: global.state.activeId, profileCount: global.state.profiles.length }, rootConfigCounts: { ai: 1, uk: 0, game: 0 } };
  await writeFile(path.join('.ai', 'wmb-2001-package-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }

async function launch(registry, rootPath, port) {
  await writeFile(registryPath, JSON.stringify({ ...registry, switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: rootPath }), 'utf8');
  const child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  let browser;
  for (let attempt = 0; attempt < 120; attempt += 1) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
  if (!browser) throw new Error(`CDP ${port} did not start`);
  const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#root', { timeout: 30_000 });
  return { page, close: async () => { await browser.close().catch(() => {}); await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); } };
}
function rootConfigCount(rootPath) { const database = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true }); try { return database.prepare("SELECT COUNT(*) count FROM app_meta WHERE key='pi-api-config'").get().count; } finally { database.close(); } }
