import { writeFileSync } from 'node:fs';
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
  const response = await fetch(mcpUrl, {
    method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  const envelope = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  return { result: envelope.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-3900-acceptance', version: '1' } });
const listed = await request('tools/list', {}, initialized.sessionId);
const started = performance.now();
const called = await request('tools/call', { name: 'x_lists.members_add', arguments: {
  request_id: 'xlist-uk-add-a-20260803-r2', account_key: '@KimbomArtist', list_id: '2084093837790843218',
  handles: ['ukhomeoffice', 'UKVIgovuk', 'HM_Passport', 'HMRCgovuk', 'HMRCpressoffice', 'DWPgovuk', 'mhclg', 'ofgem', 'EnergyOmbudsman', 'SF_England', 'SLC_Repayment', 'ucas_online', 'nationalrailenq', 'networkrail', 'TfL', 'CitizensAdvice', 'WhichUK', 'TheFCA', 'CMAgovUK', 'metpoliceuk']
} }, initialized.sessionId);
const elapsedMs = Math.round(performance.now() - started);
const payload = JSON.parse(called.result.content[0].text);
const description = listed.result.tools.find((tool) => tool.name === 'x_lists.members_add')?.description ?? '';
const result = { mcpUrl, elapsedMs, description, data: payload.data };
writeFileSync(path.join(process.cwd(), '.ai', 'wmb-3900-live-replay.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ elapsedMs, replayed: payload.data?.replayed, attemptedNow: payload.data?.attemptedNow, id: payload.data?.id, finishedAt: payload.data?.finishedAt, description }, null, 2));
if (!payload.ok || payload.data.replayed !== true || payload.data.attemptedNow !== false || payload.data.id !== 'fda119fb-ae0b-4131-b675-e2dc591c2c12' || !description.includes('replayed/attemptedNow')) process.exitCode = 1;
