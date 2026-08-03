import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const cdp = await new Promise((resolve, reject) => http.get('http://127.0.0.1:9371/json/version', (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const browser = await chromium.connectOverCDP(cdp.webSocketDebuggerUrl);
let mcpUrl;
let commandCount;
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root');
  commandCount = (await page.evaluate(() => window.wmb.listPiCommands())).length;
  mcpUrl = (await page.evaluate(() => window.wmb.getSettings())).mcp.url;
} finally { await browser.close(); }

async function request(method, params, sessionId) {
  const response = await fetch(mcpUrl, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  const envelope = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  return { result: envelope.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-4000-acceptance', version: '1' } });
const listed = await request('tools/list', {}, initialized.sessionId);
const tool = listed.result.tools.find((item) => item.name === 'x_lists.members_add');
const called = await request('tools/call', { name: 'x_lists.members_add', arguments: {
  request_id: 'xlist-uk-add-retry2-20260803', account_key: '@KimbomArtist', list_id: '2084093837790843218',
  handles: ['HM_Passport', 'SF_England', 'SLC_Repayment', 'ucas_online', 'nationalrailenq', 'networkrail', 'TfL', 'CitizensAdvice', 'WhichUK', 'TheFCA', 'CMAgovUK', 'metpoliceuk']
} }, initialized.sessionId);
const replay = JSON.parse(called.result.content[0].text).data;
const installedExtension = readFileSync(path.join(process.cwd(), 'data', 'ukcontentdata', 'pi-agent', 'extensions', 'wmb-mcp', 'wmb-mcp-tools-x-lists.ts'), 'utf8');
const installedSkill = readFileSync(path.join(process.cwd(), 'data', 'ukcontentdata', 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'), 'utf8');
const result = {
  commandCount, toolDescription: tool?.description, parameterDescriptions: Object.fromEntries(Object.entries(tool?.inputSchema?.properties ?? {}).map(([key, value]) => [key, value.description])),
  replay: { id: replay.id, replayed: replay.replayed, attemptedNow: replay.attemptedNow, finishedAt: replay.finishedAt },
  installedExtensionSop: installedExtension.includes('明确 SOP') && installedExtension.includes('禁止读源码猜用法'),
  installedSkillSop: installedSkill.includes('严格照以下步骤执行') && installedSkill.includes('不得用 bash、grep、读取仓库源码')
};
writeFileSync(path.join(process.cwd(), '.ai', 'wmb-4000-package-contract.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!tool?.description.includes('禁止通过 bash/源码猜参数') || Object.values(result.parameterDescriptions).some((value) => !value) || replay.replayed !== true || replay.attemptedNow !== false || !result.installedExtensionSop || !result.installedSkillSop) process.exitCode = 1;
