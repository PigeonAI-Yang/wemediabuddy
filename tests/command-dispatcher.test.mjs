import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- WMB-5122: test-local Node ESM resolution hook ----
// The src/main graph reachable from mcp.ts (WMB-5116 chain mcp-job-tools -> manager-job-notify ->
// manager-dispatch -> ipc-pi-dock) mixes extensionless relative imports (`./pi-conversation`, ...)
// with `electron` value imports. Bare Node ESM can resolve neither; production runs these sources only
// through the Vite bundler (moduleResolution: bundler, allowImportingTsExtensions) inside the Electron
// runtime, where both resolve natively. This inline hook mirrors exactly that production resolution for
// the bare-Node harness: it appends .ts to extensionless relative specifiers and maps `electron` to an
// inert stub (only satisfying linking; none of those call sites run in these tests). App-graph imports
// below are top-level-await dynamic imports so the hook is registered before any of them load. No
// assertion is skipped or weakened; the MCP adapter test below still starts the real startMcp HTTP
// server and executes JSON-RPC requests against it.
const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow {',
  '  static getAllWindows() { return []; }',
  '  loadURL() { return Promise.resolve(); }',
  '  loadFile() { return Promise.resolve(); }',
  '}',
  "const app = { getAppPath: () => '', whenReady: () => Promise.resolve(), on: noop };",
  'const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };',
  "const safeStorage = { encryptString: (s) => Buffer.from(String(s), 'utf8'), decryptString: (b) => String(b) };",
  'export { app, BrowserWindow, ipcMain, safeStorage };',
  'export default { app, safeStorage };',
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  '      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { createCommandEnvelope } = await import('../src/main/command-dispatcher.ts');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { startMcp } = await import('../src/main/mcp.ts');
const { dispatchSourceUpsertBatch } = await import('../src/main/source-commands.ts');
const { getSource, upsertSource } = await import('../src/main/sources.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { dispatchStartAgentTask } = await import('../src/main/agent-task-commands.ts');
const { dispatchIssueTaskGrant } = await import('../src/main/task-grants.ts');

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const external = { type: 'external_agent', id: 'mcp', label: 'External MCP Agent' };

test('source mutation atomically commits domain state, exact receipt, and minimal audit', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const receipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'source-atomic', actor: owner,
      items: [{ title: 'Atomic source', originalUrl: 'https://example.com/atomic' }]
    });
    assert.equal(receipt.version, 'CommandReceiptV1');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.data.items.length, 1);
    assert.equal(getSource(database, receipt.data.items[0].id).title, 'Atomic source');
    assert.equal(count(database, 'command_receipts'), 1);
    assert.equal(count(database, 'operation_log'), 1);
    assert.deepEqual(JSON.parse(database.prepare('SELECT receipt_json FROM command_receipts').get().receipt_json), receipt);
    assert.equal(count(database, 'mcp_request_results'), 0);
  });
});

test('same request and hash replays exactly while changed input or command conflicts with zero write', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const input = { requestId: 'source-replay', actor: owner, items: [{ title: 'Replay source', originalUrl: 'https://example.com/replay' }] };
    const first = await dispatchSourceUpsertBatch(runtime, input);
    const replay = await dispatchSourceUpsertBatch(runtime, input);
    assert.deepEqual(replay, first);
    assert.deepEqual(counts(database), { sources: 1, receipts: 1, operations: 1 });

    await assert.rejects(() => dispatchSourceUpsertBatch(runtime, { ...input, items: [{ ...input.items[0], title: 'Changed' }] }), { code: 'REQUEST_REPLAY_CONFLICT' });
    const other = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'sources.other', requestId: input.requestId, input: {}, boundIdentity: { entityType: 'source_item' }, actor: owner
    });
    await assert.rejects(() => runtime.dispatchCommand(other, () => ({ data: {}, entityType: 'source_item' })), { code: 'REQUEST_REPLAY_CONFLICT' });
    assert.deepEqual(counts(database), { sources: 1, receipts: 1, operations: 1 });
  });
});

test('stale runtime identity writes nothing and revision failure rolls back the source mutation', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const stale = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId, runtimeEpoch: 'stale-epoch', command: 'sources.upsert_batch',
      requestId: 'stale', input: { items: [] }, boundIdentity: { entityType: 'source_item' }, actor: external
    });
    await assert.rejects(() => runtime.dispatchCommand(stale, () => ({ data: {}, entityType: 'source_item' })), { code: 'WORKSPACE_STALE' });
    assert.deepEqual(counts(database), { sources: 0, receipts: 0, operations: 0 });

    const created = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'revision-create', actor: owner,
      items: [{ title: 'Revision one', originalUrl: 'https://example.com/revision' }]
    });
    const sourceId = created.data.items[0].id;
    const failed = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'revision-stale', actor: owner,
      items: [{ title: 'Must not land', originalUrl: 'https://example.com/revision', expectedRevision: 0 }]
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'REVISION_CONFLICT');
    assert.equal(getSource(database, sourceId).title, 'Revision one');
    assert.equal(getSource(database, sourceId).revision, 1);

    const rollback = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'sources.rollback_probe', requestId: 'rollback', input: {}, boundIdentity: { entityType: 'source_item' }, actor: owner
    });
    const rolledBack = await runtime.dispatchCommand(rollback, () => {
      upsertSource(database, { title: 'Rolled back', originalUrl: 'https://example.com/rolled-back' }, false);
      throw new Error('PROBE_FAILED');
    });
    assert.equal(rolledBack.ok, false);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM source_items WHERE canonical_url='https://example.com/rolled-back'").get().count, 0);
  });
});

test('production MCP and Owner UI adapters return the same receipt contract while legacy evidence stays readable', async () => {
  await withRuntime(async ({ root, runtime, database }) => {
    const uiReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'ui-source', actor: owner,
      items: [{ title: 'UI source', originalUrl: 'https://example.com/ui-source' }]
    });
    const task = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-05', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: owner, requestId: 'task-start-mcp-adapter' })).task;
    assert.equal(task.status, 'running');
    const grantReceipt = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-mcp-source', taskId: task.id, ownerGoal: '验证外部 Agent 资料写入',
      allowedCommands: ['sources.upsert_batch'], workers: [{ type: 'external_agent', id: 'mcp' }, { type: 'pi', id: 'pi' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(grantReceipt.ok, true);
    const piLease = runtime.acquireWorkerLease(task.id);
    runtime.bindWorker(piLease, { stop() {} });
    const mcp = await startMcp(root, runtime.gate, undefined, runtime);
    try {
      const initialized = await request(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'command-test', version: '1' } });
      const grantRead = await request(mcp.url, 'tools/call', {
        name: 'task_grants.get', arguments: { grant_id: grantReceipt.data.id }
      }, initialized.sessionId);
      const visibleGrant = JSON.parse(grantRead.result.content[0].text);
      assert.equal(visibleGrant.taskId, task.id);
      assert.deepEqual(visibleGrant.allowedCommands, ['sources.upsert_batch']);
      const called = await request(mcp.url, 'tools/call', {
        name: 'sources.upsert_batch', arguments: {
          request_id: 'mcp-source', task_id: task.id, grant_id: grantReceipt.data.id,
          items: [{ title: 'MCP source', originalUrl: 'https://example.com/mcp-source' }]
        }
      }, initialized.sessionId);
      const mcpReceipt = JSON.parse(called.result.content[0].text);
      assert.equal(mcpReceipt.version, uiReceipt.version);
      assert.deepEqual(Object.keys(mcpReceipt).sort(), Object.keys(uiReceipt).sort());
      assert.equal(mcpReceipt.actor.type, 'external_agent');
      assert.equal(uiReceipt.actor.type, 'owner_ui');
      assert.equal(mcpReceipt.data.sources[0].title, 'MCP source');
      const piCalled = await request(mcp.url, 'tools/call', {
        name: 'sources.upsert_batch', arguments: {
          request_id: 'mcp-pi-source', task_id: task.id,
          worker_lease_id: piLease.leaseId, grant_id: grantReceipt.data.id,
          items: [{ title: 'Pi MCP source', originalUrl: 'https://example.com/pi-mcp-source' }]
        }
      }, initialized.sessionId);
      const piMcpReceipt = JSON.parse(piCalled.result.content[0].text);
      assert.equal(piMcpReceipt.ok, true);
      assert.equal(piMcpReceipt.actor.id, 'pi');
      assert.equal(database.prepare('SELECT result_json FROM mcp_request_results WHERE tool=? AND request_id=?').get('legacy.tool', 'legacy-request').result_json, '{"ok":true}');
    } finally {
      await mcp.close();
      runtime.releaseWorker(piLease);
    }
  }, { seedLegacyEvidence: true });
});

async function withRuntime(work, { seedLegacyEvidence = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-command-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    if (seedLegacyEvidence) database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run('legacy.tool', 'legacy-request', '{"ok":true}', '2026-08-05T00:00:00.000Z');
    database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    await work({ root, runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
}

function counts(database) {
  return { sources: count(database, 'source_items'), receipts: count(database, 'command_receipts'), operations: count(database, 'operation_log') };
}
async function request(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { result: payload.result, sessionId: response.headers.get('mcp-session-id') || sessionId };
}
