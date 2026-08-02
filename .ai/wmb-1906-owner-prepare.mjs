import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const cdpPort = Number(process.env.WMB_ACCEPTANCE_CDP_PORT ?? 29416);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  const settings = await page.evaluate(() => window.wmb.getSettings());
  assert.equal(settings.paths.dataRoot, 'J:\\PigeonYang\\WeMediaBuddyData');
  const initialized = await request(settings.mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-1906-owner-prepare', version: '1' } });
  const prepared = payload(await request(settings.mcp.url, 'tools/call', { name: 'workspaces.proposals.prepare', arguments: {
    request_id: 'wmb-1906-owner-game-news', target: 'new', purpose: 'self_media', display_name: '游戏资讯', audience: '关注 PC、主机和热门跨平台游戏的中文玩家',
    content_goal: '持续发现并创作有官方来源、能帮助玩家判断购买更新与参与时机的游戏资讯', editorial_brief: '先回到平台、开发商或发行商原文核对游戏、版本、日期和平台，再用简洁中文说明玩家影响；传闻与事实分开。',
    intelligence_pack_id: 'game-news-radar', intelligence_pack_version: 1, creation_pack_id: 'wmb-core-creation', creation_pack_version: 1, platforms: ['x']
  } }, initialized.sessionId));
  assert.equal(prepared.ok, true);
  const receipt = { preparedAt: new Date().toISOString(), activeDataRoot: settings.paths.dataRoot, proposalId: prepared.data.id, displayName: prepared.data.profile.displayName, intelligencePack: `${prepared.data.profile.intelligencePackId}@${prepared.data.profile.intelligencePackVersion}`, confirmationPerformed: false };
  await writeFile(path.join(process.cwd(), '.ai', 'wmb-1906-owner-prepared.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...receipt, mcpUrl: settings.mcp.url }));
} finally {
  await browser.close();
}

function payload(result) { return JSON.parse(result.data.content[0].text); }
async function request(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true); const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (message.error) throw new Error(message.error.message); return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
