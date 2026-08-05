import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const execFileAsync = promisify(execFile);

export async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitForWorkspace(port, workspaceId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts().flatMap((context) => context.pages())[0];
      if (!page) throw new Error('renderer page unavailable');
      await page.waitForSelector('#root', { timeout: 1_000 });
      const workspaces = await page.evaluate(() => window.wmb.listWorkspaces());
      if (workspaces.activeWorkspaceId === workspaceId) return { browser, page };
    } catch {}
    await browser?.close().catch(() => {});
    await delay(250);
  }
  throw new Error(`packaged workspace ${workspaceId} did not become active`);
}

export async function openMcp(url) {
  const initialized = await mcpRequest(url, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-4809-package', version: '1' }
  });
  return {
    url,
    sessionId: initialized.sessionId,
    async call(name, args) {
      const called = await mcpRequest(url, 'tools/call', { name, arguments: args }, initialized.sessionId);
      const text = called.result.content?.find((item) => item.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error(`${name} returned no text result`);
      return JSON.parse(text);
    }
  };
}

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: ${response.status} ${body}`);
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { result: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

export function expectedAccount(rootKey, profileId) {
  return {
    x: {
      platform: 'x',
      accountKey: `@eval029_${rootKey}_expected`,
      displayName: `EVAL-029 ${rootKey.toUpperCase()} expected account`,
      loginState: 'authenticated',
      evidenceUrl: `https://example.com/eval-029/${rootKey}/expected-account`,
      accountRevision: 1,
      browserProfileId: profileId,
      browserBindingRevision: 1,
      verifiedAt: '2026-08-05T09:29:00.000Z'
    }
  };
}

export function readBinding(root) {
  const database = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
  try {
    const row = database.prepare("SELECT profile_id AS profileId,binding_revision AS bindingRevision,state,expected_account_snapshot_json AS expectedAccounts FROM workspace_browser_bindings WHERE id='effective'").get();
    return row ? { profileId: row.profileId, bindingRevision: row.bindingRevision, state: row.state, expectedAccounts: JSON.parse(row.expectedAccounts) } : null;
  } finally { database.close(); }
}

export function readLegacyDatabase(root, key) {
  const database = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
  try { return database.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value ?? null; }
  finally { database.close(); }
}

export function countRequestReceipt(root, requestId) {
  const database = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
  try { return database.prepare('SELECT COUNT(*) AS count FROM command_receipts WHERE request_id=?').get(requestId).count; }
  finally { database.close(); }
}

export async function legacyFiles(root, fixture) {
  const pointerPath = path.join(root, fixture.legacySentinels.conversationPointerRelativePath);
  const sessionPath = path.join(root, fixture.legacySentinels.conversationSessionRelativePath);
  const browserPath = path.join(root, fixture.legacySentinels.browserFileRelativePath);
  const [pointer, session, browser] = await Promise.all([readFile(pointerPath), readFile(sessionPath), readFile(browserPath)]);
  return {
    pointerPath,
    sessionPath,
    browserPath,
    pointer,
    session,
    browser,
    pointerSha256: sha256(pointer),
    sessionSha256: sha256(session),
    browserSha256: sha256(browser)
  };
}

export async function treeDigest(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        const info = await stat(absolute);
        files.push({ path: path.relative(root, absolute).split(path.sep).join('/'), size: info.size, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { digest: sha256(JSON.stringify(files)), files };
}

export async function assertEndpointRejected(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url, { signal: AbortSignal.timeout(500) }); }
    catch { return true; }
    await delay(100);
  }
  assert.fail(`endpoint remained reachable: ${url}`);
}

export async function assertCdpRejected(port, timeoutMs = 10_000) {
  const url = `http://127.0.0.1:${port}/json/version`;
  return assertEndpointRejected(url, timeoutMs);
}

export async function closeWindowAndWait(page, browser, port, mcpUrl) {
  await page.close({ runBeforeUnload: true }).catch(() => {});
  await browser.close().catch(() => {});
  await Promise.all([assertCdpRejected(port), assertEndpointRejected(mcpUrl)]);
}

export async function killPortOwner(port) {
  let pid;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { windowsHide: true, timeout: 10_000 });
    pid = Number(stdout.trim());
  } catch { return; }
  if (!pid) return;
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }).catch(() => {});
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
