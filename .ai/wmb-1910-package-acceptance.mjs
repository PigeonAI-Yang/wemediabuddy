import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { createPublication } from '../src/main/publishing.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { createOfficialWorkspace, createProposedWorkspace, enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1910-package-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const runs = [];
try {
  await mkdir(userData, { recursive: true });
  const aiRoot = await openDataRoot(path.join(temp, 'ai')); migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path });
  const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), templateId: 'official.uk' });
  const game = await createProposedWorkspace({ registryPath, rootPath: path.join(temp, 'game'), profile: {
    profileId: 'profile.game.wmb-1910', revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName: '游戏资讯', audience: '中文玩家', contentGoal: '游戏资讯', editorialBrief: '官方优先',
    intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
  } });
  const registry = await readWorkspaceRegistry(registryPath);
  const fixtures = new Map([[ai.id, seed(ai.rootPath, '@ai', '1910101', false)], [uk.id, seed(uk.rootPath, '@uk', '1910102', true)], [game.id, seed(game.rootPath, '@game', '1910103', true)]]);
  for (const [index, workspace] of [ai, uk, game].entries()) {
    const fixture = fixtures.get(workspace.id);
    await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
    await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
    const cdpPort = 29540 + index;
    const launched = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
    try {
      const browser = await waitForBrowser(cdpPort); const page = browser.contexts()[0].pages()[0];
      await page.waitForSelector('#root', { timeout: 30_000 });
      const settings = await page.evaluate(() => window.wmb.getSettings());
      const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1910', version: '1' } });
      const denied = workspace === ai ? [] : workspace === uk ? ['wechat'] : ['xiaohongshu', 'wechat'];
      const db = migrateDatabase(path.join(workspace.rootPath, 'wmb.db'));
      const before = projection(db);
      for (const platform of denied) {
        const response = await request(settings.mcp.url, 'tools/call', { name: 'plans.save', arguments: planInput(fixture.sourceId, platform) }, initialized.sessionId);
        assert.match(JSON.stringify(response.data), new RegExp(`未启用发布平台：${platform}`));
      }
      assert.deepEqual(projection(db), before);
      const allowedPlan = await request(settings.mcp.url, 'tools/call', { name: 'plans.save', arguments: { ...planInput(fixture.sourceId, 'x'), request_id: `allowed-${workspace.id}`, items: [planItem(fixture.sourceId, settings.workspace.capabilities.publishingPlatforms)] } }, initialized.sessionId);
      assert.equal(JSON.parse(allowedPlan.data.content[0].text).ok, true);
      const allowedVersion = await request(settings.mcp.url, 'tools/call', { name: 'content.save_version', arguments: { request_id: `allowed-version-${workspace.id}`, project_id: fixture.projectId, content_version_id: fixture.contentVersionId, platform: 'x', format: 'text', body: 'allowed X' } }, initialized.sessionId);
      assert.equal(JSON.parse(allowedVersion.data.content[0].text).ok, true);
      db.close();
      let publishDenied = null; let xhsDenied = null;
      if (workspace !== ai) {
        publishDenied = await page.evaluate((id) => window.wmb.prepareWechatArticlePublication(id).then(() => null).catch((error) => error.message), fixture.wechatVersionId);
        assert.match(publishDenied, /未启用发布平台：wechat/);
      }
      if (workspace === game) {
        xhsDenied = await page.evaluate(() => window.wmb.ensureXhs().then(() => null).catch((error) => error.message));
        assert.match(xhsDenied, /未启用发布平台：xiaohongshu/);
      }
      await page.evaluate(() => { localStorage.setItem('wmb.view', 'studio'); localStorage.removeItem('wmb.studioSelectedId'); }); await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('select[aria-label="平台筛选"]', { timeout: 15_000 });
      const platformOptions = await page.locator('select[aria-label="平台筛选"] option').allTextContents();
      assert.deepEqual(platformOptions, ['全部平台', ...settings.workspace.capabilities.publishingPlatforms.map((platform) => ({ x: 'X', xiaohongshu: '小红书', wechat: '公众号' })[platform])]);
      let historicalReadOnly = null;
      if (fixture.publicationId) {
        await page.evaluate(() => localStorage.setItem('wmb.view', 'publish')); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.publish-page', { timeout: 15_000 });
        historicalReadOnly = await page.evaluate(() => ({ notice: document.body.textContent.includes('当前工作空间未启用该发布平台，仅保留历史记录。'), action: [...document.querySelectorAll('.pub-foot button,.readback-form button')].some((button) => /发布|接管|核对文章/.test(button.textContent || '')) }));
        assert.deepEqual(historicalReadOnly, { notice: true, action: false });
      }
      const prerequisites = await page.evaluate(async ({ projectId, publicationId }) => {
        const daily1 = await window.wmb.startDailyIntelligence('2026-08-02'); const daily2 = await window.wmb.startDailyIntelligence('2026-08-02');
        const studio1 = await window.wmb.startStudioDraft({ businessDate: '2026-08-02', projectId }); const studio2 = await window.wmb.startStudioDraft({ businessDate: '2026-08-02', projectId });
        const review1 = await window.wmb.startResultsReview({ businessDate: '2026-08-02', publicationId: publicationId || 'historical-publication' }); const review2 = await window.wmb.startResultsReview({ businessDate: '2026-08-02', publicationId: publicationId || 'historical-publication' });
        return [daily1, daily2, studio1, studio2, review1, review2].map((item) => item.data);
      }, { projectId: fixture.projectId, publicationId: fixture.publicationId });
      for (const pair of [[0, 1], [2, 3], [4, 5]]) { assert.equal(prerequisites[pair[0]].task.status, 'needs_user'); assert.equal(prerequisites[pair[0]].task.id, prerequisites[pair[1]].task.id); assert.equal(prerequisites[pair[1]].reused, true); }
      if (workspace === game) assert.equal(await exists(path.join(workspace.rootPath, 'xiaohongshu-mcp')), false);
      runs.push({ displayName: workspace.displayName, platforms: settings.workspace.capabilities.publishingPlatforms, denied, platformOptions, publishDenied: Boolean(publishDenied), xhsDenied: Boolean(xhsDenied), historicalReadOnly, needsUserTaskIds: [prerequisites[0].task.id, prerequisites[2].task.id, prerequisites[4].task.id], listSourceChain: fixture.sourceId });
      await browser.close();
    } finally { await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); }
  }
  const receipt = { runs }; await writeFile(path.join(process.cwd(), '.ai', 'wmb-1910-package-acceptance.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8'); console.log(JSON.stringify(receipt));
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }

function seed(root, accountKey, listId, historicalWechat) {
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    const binding = bindXList(db, { accountKey, list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: accountKey, name: `${accountKey} List`, kind: 'owned' }, observation: { source: 'acceptance' } }); assert.equal(binding.ok, true);
    const source = upsertSource(db, { feedId: binding.data.sourceFeedId, originalUrl: `https://x.com/${accountKey.slice(1)}/status/${listId}`, title: `${accountKey} List post`, summary: 'root-local List source' });
    const plan = saveCurrentPlan(db, { planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: 'X chain', items: [planItem(source.id, ['x'])] }); const planItemId = db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(plan.id).id;
    const project = createContentProjectWithVersion(db, { title: `${accountKey} content`, body: 'core', planItemId, sourceIds: [source.id] }); savePlatformVersion(db, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: 'X body' });
    const wechat = savePlatformVersion(db, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'wechat', format: 'article', title: 'Historical', body: 'Historical body' });
    let publicationId = null;
    if (historicalWechat) { const account = saveAccount(db, { platform: 'wechat', accountKey: `${accountKey}-wechat`, displayName: accountKey, loginState: 'authenticated' }); const publication = createPublication(db, { platformVersionId: wechat.data.id, accountId: account.id }); assert.equal(publication.ok, true); publicationId = publication.data.id; }
    return { sourceId: source.id, projectId: project.id, contentVersionId: project.contentVersionId, wechatVersionId: wechat.data.id, publicationId };
  } finally { db.close(); }
}
function planItem(sourceId, platforms) { return { title: '选题', priority: 1, whyNow: '当前更新', timeliness: '今天', targetAudience: '受众', angle: '角度', pointOfView: '判断', platforms, formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30 分钟', sourceIds: [sourceId] }; }
function planInput(sourceId, platform) { return { request_id: `deny-${platform}`, plan_date: '2026-08-03', summary: 'denied', items: [planItem(sourceId, [platform])] }; }
function projection(db) { return { plans: db.prepare('SELECT COUNT(*) count FROM plans').get().count, receipts: db.prepare('SELECT COUNT(*) count FROM mcp_request_results').get().count }; }
async function exists(target) { return import('node:fs/promises').then(({ access }) => access(target).then(() => true).catch(() => false)); }
async function waitForBrowser(port) { for (let attempt = 0; attempt < 120; attempt += 1) { try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) return browser; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`CDP ${port} did not start`); }
async function request(url, method, params, sessionId) { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) }); assert.equal(response.ok, true); const body = await response.text(); const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body); return { data: payload.result ?? payload.error, sessionId: response.headers.get('mcp-session-id') ?? sessionId }; }
