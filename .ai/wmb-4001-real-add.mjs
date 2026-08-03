import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const listId = '2084093837790843218';
const expectedAccount = '@KimbomArtist';
const requested = ['@ukhomeoffice', '@UKVIgovuk', '@HM_Passport', '@HMRCgovuk', '@HMRCpressoffice', '@DWPgovuk', '@mhclg', '@ofgem', '@EnergyOmbudsman', '@SF_England', '@SLC_Repayment', '@ucas_online', '@nationalrailenq', '@networkrail', '@TfL', '@CitizensAdvice', '@WhichUK', '@TheFCA', '@CMAgovUK', '@metpoliceuk'];
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-4001-real-add.json');
const receipt = { startedAt: new Date().toISOString(), listId, expectedAccount, requested };
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

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
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-4001-real-add', version: '1' } });
  console.log('READ_INDEX');
  const index = data(await request('tools/call', { name: 'x_lists.read_index', arguments: {} }, initialized.sessionId));
  const list = index.lists.find((item) => item.listId === listId);
  receipt.index = { accountKey: index.accountKey, list };
  save();
  if (index.accountKey.toLowerCase() !== expectedAccount.toLowerCase() || !list || list.name !== '英国资讯' || list.kind !== 'owned') throw new Error('当前账号或目标 List 身份不符合授权范围。');

  console.log('READ_MEMBERS_BEFORE');
  const before = data(await request('tools/call', { name: 'x_lists.read_members', arguments: { list_id: listId } }, initialized.sessionId));
  receipt.before = { accountKey: before.accountKey, detail: before.detail, handles: before.members.map((item) => item.handle) };
  save();
  if (before.accountKey.toLowerCase() !== expectedAccount.toLowerCase() || before.detail.listId !== listId || before.detail.name !== '英国资讯' || before.detail.ownerHandle?.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('成员读取没有返回已授权的账号/List 身份。');
  if (Number.isInteger(before.detail.memberCount) && before.members.length < before.detail.memberCount) throw new Error('当前成员读取不完整，停止写入。');
  const present = new Set(before.members.map((item) => item.handle.toLowerCase()));
  const missing = requested.filter((handle) => !present.has(handle.toLowerCase()));
  receipt.missingBefore = missing;
  save();
  console.log(`MISSING=${missing.length}`);
  if (!missing.length) {
    receipt.result = 'already_complete'; receipt.finishedAt = new Date().toISOString(); save(); process.exit(0);
  }

  const requestId = `xlist-uk-add-owner-acceptance-${Date.now()}`;
  receipt.requestId = requestId;
  save();
  console.log(`ADD_START requestId=${requestId}`);
  const operation = data(await request('tools/call', { name: 'x_lists.members_add', arguments: { request_id: requestId, account_key: expectedAccount, list_id: listId, handles: missing } }, initialized.sessionId));
  receipt.operation = operation;
  save();
  console.log(`ADD_END state=${operation.state} id=${operation.id}`);

  console.log('READ_MEMBERS_AFTER');
  const after = data(await request('tools/call', { name: 'x_lists.read_members', arguments: { list_id: listId } }, initialized.sessionId));
  const afterSet = new Set(after.members.map((item) => item.handle.toLowerCase()));
  const stillMissing = requested.filter((handle) => !afterSet.has(handle.toLowerCase()));
  receipt.after = { accountKey: after.accountKey, detail: after.detail, handles: after.members.map((item) => item.handle) };
  receipt.stillMissing = stillMissing;
  receipt.finishedAt = new Date().toISOString();
  save();
  console.log(`VERIFY state=${operation.state} members=${after.members.length} stillMissing=${stillMissing.length}`);
  if (operation.state !== 'succeeded' || stillMissing.length) process.exitCode = 1;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  receipt.finishedAt = new Date().toISOString();
  save();
  console.error(receipt.error);
  process.exitCode = 1;
}
