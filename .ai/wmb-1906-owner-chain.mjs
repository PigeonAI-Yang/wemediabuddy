import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const planDate = '2026-08-02';
const sourceUrl = 'https://blog.playstation.com/2026/07/28/ball-x-pit-final-update-the-naturalist-arrives-august-6/';
const coreBody = 'PlayStation Blog 于 2026 年 7 月 28 日确认，《BALL x PIT》的最后一次免费内容更新 The Naturalist 将于 8 月 6 日向 PS5 玩家推出。更新包含 2 名可解锁角色、11 种新球与 5 个新被动道具。对现有玩家，重点是新的构筑组合；对观望玩家，可等更新上线后再判断内容量是否值得入手。';
const xBody = '《BALL x PIT》最后一次免费内容更新 The Naturalist 将于 8 月 6 日登陆 PS5。官方确认新增 2 名可解锁角色、11 种球和 5 个被动道具。已经在玩的玩家可以等更新回坑；尚未入手的玩家先看这次免费内容是否符合自己的构筑偏好。信息源：PlayStation Blog（7 月 28 日）。';
const browser = await chromium.connectOverCDP('http://127.0.0.1:29416');
try {
  const page = browser.contexts()[0].pages()[0];
  const settings = await page.evaluate(() => window.wmb.getSettings());
  assert.equal(settings.paths.dataRoot, 'J:\\PigeonYang\\WeMediaBuddy\\data\\gamedata');
  process.env.WMB_MCP_URL = settings.mcp.url;
  const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1906-external', version: '1' } });
  const call = (name, args) => request(settings.mcp.url, 'tools/call', { name, arguments: args }, initialized.sessionId).then(payload);
  const sourceWrite = await call('sources.upsert_batch', { request_id: 'wmb-1906-game-source', items: [{
    title: 'BALL x PIT final update The Naturalist arrives August 6', originalUrl: sourceUrl, author: 'Kenny Sun, Kenny Sun & Friends', publishedAt: '2026-07-28T00:00:00.000Z',
    summary: 'The Naturalist 是 BALL x PIT 最后一次免费内容更新，8 月 6 日登陆 PS5，新增 2 名角色、11 种球和 5 个被动道具。', categories: ['游戏更新'], keywords: ['BALL x PIT', 'The Naturalist', 'PS5'],
    valueJudgment: '临近上线且内容量明确，适合帮助中文玩家判断回坑或入手时机。', creationAngles: '免费最终更新包含什么，以及玩家是否值得回坑。', recommendedPlatforms: ['x'], recommendedFormats: ['text'], timeliness: '2026-08-06 前', priority: 1,
    evidence: 'PlayStation Blog 2026-07-28 原文第 58、63-80 行。', clientLabel: 'WMB-1906 external MCP'
  }] });
  const sourceId = sourceWrite.data[0].id;
  await call('plans.save', { request_id: 'wmb-1906-game-plan', plan_date: planDate, summary: '游戏资讯首条官方来源选题', items: [{
    title: 'BALL x PIT 最后一次免费更新值得回坑吗', priority: 1, whyNow: '官方已公布内容且 8 月 6 日上线临近', timeliness: '8 月 6 日前', targetAudience: '关注 PS5 独立游戏和构筑玩法的中文玩家',
    angle: '把新增内容量转成回坑与观望建议', pointOfView: '先列官方确认内容，再区分现有玩家与观望玩家', platforms: ['x'], formats: ['text'], titleGuidance: '点明最终免费更新和上线日', openingGuidance: '先说 8 月 6 日与三组新增数量', structureGuidance: '时间与平台、新增内容、玩家建议', effortEstimate: '20 分钟', sourceIds: [sourceId]
  }] });
  const plan = await call('plans.get', {});
  const planItem = plan.items.find((item) => item.sourceIds.includes(sourceId));
  assert.ok(planItem?.id);
  const created = await call('content.create', { request_id: 'wmb-1906-game-content', title: 'BALL x PIT 最后一次免费更新：PS5 玩家该知道什么', body: coreBody, plan_item_id: planItem.id, source_ids: [sourceId] });
  const platform = await call('content.save_version', { request_id: 'wmb-1906-game-x', project_id: created.data.id, content_version_id: created.data.contentVersionId, platform: 'x', format: 'text', body: xBody });
  assert.equal(platform.ok, true);
  const externalReadback = { source: await call('sources.get', { id: sourceId }), plan: await call('plans.get', {}), content: await call('content.get', { project_id: created.data.id }) };

  const piTools = new Map();
  const extensionPath = new URL(`file:///${path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'resources', 'extensions', 'wmb-mcp', 'index.ts').replaceAll('\\', '/')}?accept=${Date.now()}`);
  (await import(extensionPath)).default({ registerTool(tool) { piTools.set(tool.name, tool); } });
  const piReadback = {
    source: piPayload(await piTools.get('wmb_get_source').execute('source', { id: sourceId })),
    workbench: piPayload(await piTools.get('wmb_get_workbench').execute('workbench', {})),
    content: piPayload(await piTools.get('wmb_get_content').execute('content', { projectId: created.data.id }))
  };
  const uiReadback = await page.evaluate(async ({ planDate, projectId }) => ({ today: await window.wmb.getToday(planDate), content: await window.wmb.getStudioProject(projectId) }), { planDate, projectId: created.data.id });

  for (const readback of [externalReadback.content, piReadback.content, uiReadback.content]) {
    assert.equal(readback.id, created.data.id);
    assert.equal(readback.planItemId, planItem.id);
    assert.equal(readback.revisions[0].body, coreBody);
    assert.equal(readback.platformVersions.x[0].platform, 'x');
    assert.equal(readback.platformVersions.x[0].format, 'text');
    assert.equal(readback.platformVersions.x[0].body, xBody);
  }
  assert.equal(externalReadback.source.originalUrl, sourceUrl);
  assert.equal(piReadback.source.originalUrl, sourceUrl);
  assert.equal(uiReadback.today.plan.items.some((item) => item.id === planItem.id && item.sourceIds.includes(sourceId)), true);
  assert.equal(piReadback.workbench.plan.items.some((item) => item.id === planItem.id && item.sourceIds.includes(sourceId)), true);
  const receipt = { dataRoot: settings.paths.dataRoot, mcpUrl: settings.mcp.url, sourceId, planId: plan.id, planItemId: planItem.id, projectId: created.data.id, contentVersionId: created.data.contentVersionId, platformVersionId: platform.data.id, sourceUrl, uiReadback: true, piReadback: true, externalMcpReadback: true, coreBody, xBody };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1906-owner-chain.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
}

function piPayload(result) { return JSON.parse(result.details.content[0].text); }
function payload(result) { return JSON.parse(result.data.content[0].text); }
async function request(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true); const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (message.error) throw new Error(message.error.message); return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
