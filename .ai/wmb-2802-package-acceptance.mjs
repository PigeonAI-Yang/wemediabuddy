import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { saveAccount } from '../src/main/accounts.ts';
import { createContentProjectWithVersion } from '../src/main/content.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createPublication, preparePublication } from '../src/main/publishing.ts';
import { createOfficialWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const extensionRoot = path.join(path.dirname(executable), 'resources', 'extensions', 'wmb-mcp');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-2802-package-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-2802-package-acceptance.json');
const receipt = { taskId: 'WMB-2802', startedAt: new Date().toISOString(), package: {}, pi: {}, readback: {}, ui: {}, publicationBoundary: {} };
let running;
try {
  await mkdir(userData, { recursive: true });
  const workspace = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'root'), templateId: 'official.ai' });
  const registry = await readWorkspaceRegistry(registryPath);
  await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
  const database = migrateDatabase(path.join(workspace.rootPath, 'wmb.db'));
  const project = createContentProjectWithVersion(database, { title: 'WMB-2802 三平台验收', body: '同一篇已经完成真实性核查的核心正文。' });
  database.close();

  const exe = await readFile(executable); const asar = await readFile(path.join(path.dirname(executable), 'resources', 'app.asar'));
  const packagedContentTool = await readFile(path.join(extensionRoot, 'wmb-mcp-tools-content.ts'), 'utf8');
  receipt.package = { executable, exeSha256: sha(exe), asarSha256: sha(asar), platformToolPackaged: packagedContentTool.includes('wmb_save_platform_version') };
  assert.equal(receipt.package.platformToolPackaged, true);

  running = await launch(29802); const page = running.page;
  await page.evaluate(() => window.wmb.savePiConfig({ name: 'WMB-2802 acceptance', baseUrl: 'https://example.invalid/v1', model: 'acceptance-only', api: 'openai-responses', apiKey: 'not-used' }));
  const piCommands = await page.evaluate(() => window.wmb.listPiCommands());
  assert.ok(piCommands.length > 0);
  const settings = await page.evaluate(() => window.wmb.getSettings());
  assert.equal(settings.workspace.id, workspace.id);
  process.env.WMB_MCP_URL = settings.mcp.url;
  const tools = new Map();
  const extensionUrl = `${pathToFileURL(path.join(extensionRoot, 'index.ts')).href}?acceptance=${Date.now()}`;
  const extension = (await import(extensionUrl)).default;
  extension({ registerTool(tool) { tools.set(tool.name, tool); } });
  const names = [...tools.keys()];
  assert.equal(names.includes('wmb_save_platform_version'), true);
  const forbiddenPiTools = names.filter((name) => /(?:confirm|final.*publish|publish.*confirm)/i.test(name));
  assert.deepEqual(forbiddenPiTools, []);
  receipt.pi = { registeredToolCount: names.length, platformTool: 'wmb_save_platform_version', forbiddenPiTools, supervisedCommandCount: piCommands.length };

  const versions = {};
  for (const platform of ['x', 'xiaohongshu', 'wechat']) {
    const result = await tools.get('wmb_save_platform_version').execute(`accept-${platform}`, {
      requestId: `wmb-2802-${platform}`, projectId: project.id, contentVersionId: project.contentVersionId,
      platform, format: 'text', title: `${platform} 验收标题`, body: `${platform} 验收正文`
    });
    const payload = JSON.parse(result.details.content[0].text);
    assert.equal(payload.ok, true); versions[platform] = payload.data.id;
  }
  const contentResult = await tools.get('wmb_get_content').execute('accept-readback', { projectId: project.id });
  const content = JSON.parse(contentResult.details.content[0].text);
  for (const platform of ['x', 'xiaohongshu', 'wechat']) {
    const version = content.platformVersions[platform][0];
    assert.equal(version.id, versions[platform]); assert.equal(version.contentVersionId, project.contentVersionId);
    assert.equal(version.title, `${platform} 验收标题`); assert.equal(version.body, `${platform} 验收正文`);
  }
  receipt.readback = { projectId: project.id, contentVersionId: project.contentVersionId, versions };
  await running.close(); running = null;

  const publishDb = migrateDatabase(path.join(workspace.rootPath, 'wmb.db'));
  for (const platform of ['x', 'xiaohongshu', 'wechat']) {
    const account = saveAccount(publishDb, { platform, accountKey: `acceptance-${platform}`, displayName: `${platform} acceptance`, loginState: 'authenticated', evidenceUrl: 'wmb://acceptance' });
    const created = createPublication(publishDb, { platformVersionId: versions[platform], accountId: account.id });
    assert.equal(created.ok, true);
    const version = content.platformVersions[platform][0];
    const prepared = preparePublication(publishDb, { publicationId: created.data.id, expectedRevision: created.data.revision, editorTitle: version.title, editorBody: version.body, editorAssetIds: [], editorEvidenceUrl: 'wmb://acceptance/editor-readback' });
    assert.equal(prepared.ok, true); assert.equal(prepared.data.publication.status, 'awaiting_confirmation');
  }
  publishDb.close();

  running = await launch(29803); const verifyPage = running.page;
  await verifyPage.evaluate(({ workspaceId, projectId }) => {
    localStorage.setItem('wmb.view', 'studio');
    localStorage.setItem(`wmb.workspace.${workspaceId}.studioSelectedId`, projectId);
  }, { workspaceId: workspace.id, projectId: project.id });
  await verifyPage.reload({ waitUntil: 'domcontentloaded' });
  await verifyPage.locator('.studio-editor-view').waitFor({ timeout: 30_000 });
  await verifyPage.locator('.studio-outline button').filter({ hasText: 'X' }).last().click();
  await verifyPage.locator('.studio-detail-list article').first().waitFor();
  const studio = await verifyPage.evaluate(() => ({
    platformButtons: [...document.querySelectorAll('.studio-outline button')].filter((node) => /1 个版本/.test(node.textContent ?? '')).map((node) => node.textContent?.trim()),
    titles: [...document.querySelectorAll('.studio-detail-list article h3')].map((node) => node.textContent?.trim()),
    bodies: [...document.querySelectorAll('.studio-detail-list article p')].map((node) => node.textContent?.trim())
  }));
  assert.equal(studio.platformButtons.length, 3);
  assert.deepEqual(new Set(studio.titles), new Set(['x 验收标题', 'xiaohongshu 验收标题', 'wechat 验收标题']));
  assert.deepEqual(new Set(studio.bodies), new Set(['x 验收正文', 'xiaohongshu 验收正文', 'wechat 验收正文']));

  await verifyPage.evaluate(() => localStorage.setItem('wmb.view', 'publish'));
  await verifyPage.reload({ waitUntil: 'domcontentloaded' });
  await verifyPage.locator('.publish-page').waitFor({ timeout: 30_000 });
  await verifyPage.getByText('等待人工发布').first().waitFor();
  const publish = await verifyPage.evaluate(() => ({
    cards: document.querySelectorAll('.pub-card').length,
    text: document.querySelector('.publish-page')?.textContent ?? '',
    published: [...document.querySelectorAll('.pill-status')].some((node) => node.textContent?.trim() === '已发布'),
    publishing: [...document.querySelectorAll('.pill-status')].some((node) => node.textContent?.trim() === '发布中')
  }));
  assert.equal(publish.cards, 3); assert.equal(publish.published, false); assert.equal(publish.publishing, false);
  for (const title of ['x 验收标题', 'xiaohongshu 验收标题', 'wechat 验收标题']) assert.match(publish.text, new RegExp(title));
  receipt.ui = { studio, publish: { cards: publish.cards, titlesVisible: true } };
  receipt.publicationBoundary = { allStatuses: ['awaiting_confirmation'], noPublishedOrPublishing: true, finalAuthority: 'WMB UI only' };
  receipt.installed = {
    extensionHasTool: (await readFile(path.join(workspace.rootPath, 'pi-agent', 'extensions', 'wmb-mcp', 'wmb-mcp-tools-content.ts'), 'utf8')).includes('wmb_save_platform_version'),
    operatorSkillHasTool: (await readFile(path.join(workspace.rootPath, 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'), 'utf8')).includes('wmb_save_platform_version')
  };
  assert.deepEqual(receipt.installed, { extensionHasTool: true, operatorSkillHasTool: true });
} catch (error) {
  receipt.error = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null };
} finally {
  if (running) await running.close().catch(() => {});
  receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
if (receipt.error) process.exitCode = 1;

async function launch(port) {
  const child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore', windowsHide: true });
  let browser;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(browser, `packaged CDP ${port} did not start`);
  const page = browser.contexts()[0].pages()[0]; await page.waitForSelector('#root', { timeout: 30_000 });
  return { page, close: async () => { await browser.close().catch(() => {}); await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); } };
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
