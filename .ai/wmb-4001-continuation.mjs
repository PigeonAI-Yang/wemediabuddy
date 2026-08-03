import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const listId = '2084093837790843218';
const accountKey = '@KimbomArtist';
const requested = ['@ukhomeoffice', '@UKVIgovuk', '@HM_Passport', '@HMRCgovuk', '@HMRCpressoffice', '@DWPgovuk', '@mhclg', '@ofgem', '@EnergyOmbudsman', '@SF_England', '@SLC_Repayment', '@ucas_online', '@nationalrailenq', '@networkrail', '@TfL', '@CitizensAdvice', '@WhichUK', '@TheFCA', '@CMAgovUK', '@metpoliceuk'];
const remaining = ['@SLC_Repayment', '@CMAgovUK', '@metpoliceuk'];
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-4001-continuation.json');
const receipt = { startedAt: new Date().toISOString(), listId, accountKey, remaining };
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

const get = (pathname) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:9371${pathname}`, (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
async function request(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  const envelope = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (envelope.error) throw new Error(envelope.error.message);
  return { result: envelope.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
function data(call) {
  const payload = JSON.parse(call.result.content[0].text);
  if (payload.ok === false) throw new Error(`${payload.error?.code ?? 'ERROR'}: ${payload.error?.message ?? 'WMB tool failed'}`);
  return payload.ok === true ? payload.data : payload;
}

try {
  const cdp = await get('/json/version');
  const browser = await chromium.connectOverCDP(cdp.webSocketDebuggerUrl);
  let mcpUrl;
  try {
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('#root');
    mcpUrl = (await page.evaluate(() => window.wmb.getSettings())).mcp.url;
  } finally { await browser.close(); }
  const initialized = await request(mcpUrl, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-4001-continuation', version: '1' } });
  const requestId = `xlist-uk-add-owner-continuation-${Date.now()}`;
  receipt.requestId = requestId; save();
  const operation = data(await request(mcpUrl, 'tools/call', { name: 'x_lists.members_add', arguments: { request_id: requestId, account_key: accountKey, list_id: listId, handles: remaining } }, initialized.sessionId));
  receipt.operation = operation; save();
  const after = data(await request(mcpUrl, 'tools/call', { name: 'x_lists.read_members', arguments: { list_id: listId } }, initialized.sessionId));
  const actual = after.members.map((item) => item.handle);
  const actualSet = new Set(actual.map((handle) => handle.toLowerCase()));
  receipt.after = { accountKey: after.accountKey, detail: after.detail, handles: actual };
  receipt.stillMissing = requested.filter((handle) => !actualSet.has(handle.toLowerCase()));
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ operationId: operation.id, state: operation.state, counts: operation.items.reduce((out, item) => ({ ...out, [item.state]: (out[item.state] ?? 0) + 1 }), {}), memberCount: after.detail.memberCount, actualCount: actual.length, stillMissing: receipt.stillMissing }, null, 2));
  if (operation.state !== 'succeeded' || receipt.stillMissing.length) process.exitCode = 1;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  receipt.finishedAt = new Date().toISOString(); save();
  console.error(receipt.error);
  process.exitCode = 1;
}
