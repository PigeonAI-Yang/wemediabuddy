import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const cdp = await new Promise((resolve, reject) => http.get('http://127.0.0.1:9371/json/version', (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const browser = await chromium.connectOverCDP(cdp.webSocketDebuggerUrl);
let mcpUrl;
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root');
  mcpUrl = (await page.evaluate(() => window.wmb.getSettings())).mcp.url;
} finally { await browser.close(); }

async function request(method, params, sessionId) {
  const response = await fetch(mcpUrl, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  const body = await response.text();
  const envelope = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  return { result: envelope.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-4200-acceptance', version: '1' } });
const listed = await request('tools/list', {}, initialized.sessionId);
const tool = listed.result.tools.find((item) => item.name === 'x_lists.members_remove');
const installedExtension = readFileSync(path.join(process.cwd(), 'data', 'ukcontentdata', 'pi-agent', 'extensions', 'wmb-mcp', 'wmb-mcp-tools-x-lists.ts'), 'utf8');
const installedSkill = readFileSync(path.join(process.cwd(), 'data', 'ukcontentdata', 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'), 'utf8');
const result = {
  mcpTool: tool?.name ?? null,
  description: tool?.description ?? null,
  required: tool?.inputSchema?.required ?? [],
  parameterDescriptions: Object.fromEntries(Object.entries(tool?.inputSchema?.properties ?? {}).map(([key, value]) => [key, value.description])),
  installedPiTool: installedExtension.includes("name: 'wmb_remove_x_list_members'") && installedExtension.includes("callTool('x_lists.members_remove'"),
  installedSkillSop: installedSkill.includes('wmb_remove_x_list_members') && installedSkill.includes('不要求第二次 UI 确认')
};
writeFileSync(path.join(process.cwd(), '.ai', 'wmb-4200-package-contract.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.mcpTool !== 'x_lists.members_remove' || result.required.length !== 4 || Object.values(result.parameterDescriptions).some((value) => !value) || !result.installedPiTool || !result.installedSkillSop) process.exitCode = 1;
