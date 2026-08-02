import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { createOfficialWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-1907-uk-'));
const userData = path.join(temp, 'user-data');
const rootPath = path.join(temp, 'uk');
const cdpPort = 29418;
const sourceUrl = 'https://www.gov.uk/government/news/schools-out-free-bus-travel-for-kids-set-to-launch-in-summer-holiday-cost-of-living-boost';
const coreBody = '英国交通部确认，2026 年 8 月 1 日至 31 日，英格兰 5 至 15 岁儿童可在参与计划的本地巴士免费乘车。家长出行前应先核对运营商是否参与；成人单程巴士票价上限为 3 英镑，并延长至 2027 年 3 月。';
const xBody = '英格兰暑期儿童免费巴士已开始：8 月 1 日至 31 日，5—15 岁儿童可免费乘坐参与计划的本地巴士。出门前先向运营商确认线路是否参加；成人单程票价上限仍为 £3。来源：英国交通部 GOV.UK（7 月 10 日）。';
let launched;
try {
  await mkdir(userData, { recursive: true });
  const registryPath = path.join(userData, 'workspace-registry.json');
  const uk = await createOfficialWorkspace({ registryPath, rootPath, templateId: 'official.uk' });
  const registry = await readWorkspaceRegistry(registryPath);
  await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: uk.id }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: uk.rootPath }), 'utf8');
  const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
  launched = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore' });
  await waitForCdp();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  const settings = await page.evaluate(() => window.wmb.getSettings());
  assert.equal(settings.paths.dataRoot, uk.rootPath);
  assert.equal(settings.pi.configured, false);
  assert.equal(settings.xhs.status, 'not_started');
  process.env.WMB_MCP_URL = settings.mcp.url;
  const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1907-uk', version: '1' } });
  const list = await request(settings.mcp.url, 'tools/list', {}, initialized.sessionId);
  const toolNames = list.data.tools.map((tool) => tool.name);
  assert.equal(toolNames.some((name) => name.startsWith('x_lists.') || /confirm|activate|select_root|root_path/i.test(name)), false);
  const call = (name, args) => request(settings.mcp.url, 'tools/call', { name, arguments: args }, initialized.sessionId).then(payload);
  const current = await call('workspaces.get_current', {});
  assert.equal(current.profile.intelligencePackId, 'uk-life-content-radar');
  const sourceWrite = await call('sources.upsert_batch', { request_id: 'wmb-1907-uk-source', items: [{ title: 'School’s out: Free bus travel for kids', originalUrl: sourceUrl, author: 'Department for Transport', publishedAt: '2026-07-10T00:00:00.000Z', summary: '英格兰 5 至 15 岁儿童可在 2026 年 8 月免费乘坐参与计划的本地巴士。', categories: ['英国生活'], keywords: ['免费巴士', '儿童', '英格兰'], recommendedPlatforms: ['x'], recommendedFormats: ['text'], priority: 1, evidence: 'GOV.UK 2026-07-10 官方新闻稿。' }] });
  const sourceId = sourceWrite.data[0].id;
  await call('plans.save', { request_id: 'wmb-1907-uk-plan', plan_date: '2026-08-02', summary: '英国暑期家庭交通提醒', items: [{ title: '英格兰儿童 8 月免费坐巴士', priority: 1, whyNow: '免费期已于 8 月 1 日开始', timeliness: '8 月 31 日前', targetAudience: '在英华人家庭', angle: '说明资格、时段和出行前核对动作', pointOfView: '先给可执行结论，再说明适用边界', platforms: ['x'], formats: ['text'], titleGuidance: '点明儿童年龄和免费月份', openingGuidance: '先说已经开始', structureGuidance: '资格、时间、核对事项', effortEstimate: '15 分钟', sourceIds: [sourceId] }] });
  const plan = await call('plans.get', {});
  const planItem = plan.items.find((item) => item.sourceIds.includes(sourceId));
  const created = await call('content.create', { request_id: 'wmb-1907-uk-content', title: '英格兰儿童 8 月免费坐巴士：家长出门前核对这一步', body: coreBody, plan_item_id: planItem.id, source_ids: [sourceId] });
  const platform = await call('content.save_version', { request_id: 'wmb-1907-uk-x', project_id: created.data.id, content_version_id: created.data.contentVersionId, platform: 'x', format: 'text', body: xBody });
  const external = await call('content.get', { project_id: created.data.id });
  const piTools = new Map();
  const extensionPath = new URL(`file:///${path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources', 'extensions', 'wmb-mcp', 'index.ts').replaceAll('\\', '/')}?uk=${Date.now()}`);
  (await import(extensionPath)).default({ registerTool(tool) { piTools.set(tool.name, tool); } });
  const pi = JSON.parse((await piTools.get('wmb_get_content').execute('content', { projectId: created.data.id })).details.content[0].text);
  const ui = await page.evaluate(async ({ date, id }) => ({ today: await window.wmb.getToday(date), content: await window.wmb.getStudioProject(id) }), { date: '2026-08-02', id: created.data.id });
  for (const readback of [external, pi, ui.content]) {
    assert.equal(readback.planItemId, planItem.id);
    assert.equal(readback.sourceIds[0], sourceId);
    assert.equal(readback.revisions[0].body, coreBody);
    assert.equal(readback.platformVersions.x[0].body, xBody);
  }
  assert.equal(ui.today.plan.items.some((item) => item.id === planItem.id), true);
  const database = new DatabaseSync(path.join(uk.rootPath, 'wmb.db'), { readOnly: true });
  const aiOnlyWrites = { ranking: database.prepare('SELECT COUNT(*) count FROM ranking_cache').get().count, xLists: database.prepare('SELECT COUNT(*) count FROM x_list_bindings').get().count, registryFeeds: database.prepare('SELECT COUNT(*) count FROM source_feeds WHERE registry_id IS NOT NULL').get().count };
  database.close();
  assert.deepEqual(aiOnlyWrites, { ranking: 0, xLists: 0, registryFeeds: 0 });
  const receipt = { root: uk.rootPath, workspaceId: uk.id, profile: 'official.uk@1', intelligencePack: 'uk-life-content-radar@1', piConfigured: false, sourceId, planId: plan.id, planItemId: planItem.id, projectId: created.data.id, platformVersionId: platform.data.id, sourceUrl, uiReadback: true, packagedPiReadback: true, externalMcpReadback: true, aiOnlyWrites, forbiddenTools: 0 };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1907-uk-chain.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  if (launched?.pid) await execFileAsync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

async function waitForCdp() { for (let i = 0; i < 120; i++) { try { await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/version' }, (response) => { response.resume(); response.on('end', resolve); }).on('error', reject)); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); } } throw new Error('UK packaged CDP did not start'); }
function payload(result) { return JSON.parse(result.data.content[0].text); }
async function request(url, method, params, sessionId) { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) }); assert.equal(response.ok, true); const body = await response.text(); const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body); if (message.error) throw new Error(message.error.message); return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId }; }
