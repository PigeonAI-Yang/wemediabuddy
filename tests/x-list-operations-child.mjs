import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { armXListOperation, beginXListOperation, bindXList, getXListOperation, prepareXListOperation, setXListBindingEnabled } from '../src/main/x-lists.ts';
import { confirmAndRunXListOperation } from '../src/main/x-list-execution.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-lists-'));
let mcp;
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const prepared = prepareXListOperation(db, {
    requestId: 'x-list-members-1', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice', 'bob']
  });
  if (!prepared.ok || prepared.data.operation.state !== 'prepared' || prepared.data.operation.items.length !== 2) throw new Error('proposal was not persisted');
  const replayed = prepareXListOperation(db, {
    requestId: 'x-list-members-1', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice', 'bob']
  });
  const collision = prepareXListOperation(db, {
    requestId: 'x-list-members-1', accountKey: '@Owner', kind: 'members_remove', listId: '1234567890', handles: ['@Alice']
  });
  if (!replayed.ok || !replayed.data.replayed || replayed.data.operation.id !== prepared.data.operation.id || collision.ok || collision.error.code !== 'VALIDATION_ERROR') throw new Error('request idempotency mismatch');

  const snapshot = {
    accountKey: '@Owner',
    list: { listId: '1234567890', canonicalUrl: 'https://x.com/i/lists/1234567890', ownerHandle: '@Owner', name: 'AI前沿', description: '前沿专家', isPrivate: false, memberCount: 0, kind: 'owned', evidenceFingerprint: 'page-a' },
    members: [{ handle: '@Alice', present: false }, { handle: '@bob', present: false }]
  };
  const wrongOwner = armXListOperation(db, { operationId: prepared.data.operation.id, expectedRevision: prepared.data.operation.revision, snapshot: { ...snapshot, list: { ...snapshot.list, ownerHandle: '@Other' } } });
  if (wrongOwner.ok || wrongOwner.error.code !== 'BROWSER_NEEDS_USER') throw new Error('non-owned List was armed');
  const armed = armXListOperation(db, { operationId: prepared.data.operation.id, expectedRevision: prepared.data.operation.revision, snapshot });
  if (!armed.ok || armed.data.state !== 'awaiting_confirmation' || !armed.data.confirmationFingerprint) throw new Error('UI arm did not freeze snapshot');
  const stale = beginXListOperation(db, {
    operationId: armed.data.id, expectedRevision: armed.data.revision,
    currentSnapshot: { ...snapshot, list: { ...snapshot.list, description: '已变化' } }
  });
  const staleRecord = getXListOperation(db, armed.data.id);
  if (stale.ok || stale.error.code !== 'CONFIRMATION_STALE' || staleRecord?.state !== 'prepared') throw new Error('stale snapshot was accepted');

  const deletion = prepareXListOperation(db, { requestId: 'x-list-delete-1', accountKey: '@Owner', kind: 'delete', listId: '1234567890' });
  const deleteArmed = deletion.ok && armXListOperation(db, { operationId: deletion.data.operation.id, expectedRevision: deletion.data.operation.revision, snapshot: { ...snapshot, members: undefined } });
  const deleteDenied = deleteArmed && deleteArmed.ok && await confirmAndRunXListOperation(db, { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334' }, { operationId: deleteArmed.data.id, expectedRevision: deleteArmed.data.revision, typedListName: '错误名称' });
  if (!deleteDenied || deleteDenied.ok || deleteDenied.error.code !== 'VALIDATION_ERROR') throw new Error('delete name confirmation was bypassed');

  const binding = bindXList(db, {
    accountKey: '@Owner', list: { listId: '2222222222', canonicalUrl: 'https://x.com/i/lists/2222222222', ownerHandle: '@Author', name: 'AI资讯', kind: 'following' }, observation: { source: 'test' }
  });
  if (!binding.ok || !binding.data.enabled) throw new Error('binding was not created');
  const disabled = setXListBindingEnabled(db, { accountKey: binding.data.accountKey, listId: binding.data.listId, expectedRevision: binding.data.revision, enabled: false });
  const feedCount = db.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count;
  if (!disabled.ok || disabled.data.enabled || feedCount !== 1) throw new Error('unbind deleted the source feed');
  db.close();

  mcp = await startMcp(directory);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?test=${Date.now()}`)).default;
  extension({ registerTool(tool) { tools.set(tool.name, tool); } });
  if (!tools.has('wmb_prepare_x_list_operation') || !tools.has('wmb_collect_x_list_timeline') || tools.has('wmb_confirm_x_list_operation') || !tools.has('wmb_read_x_list_index') || !tools.has('wmb_read_x_list_detail') || !tools.has('wmb_read_x_list_members') || !tools.has('wmb_read_x_list_timeline')) throw new Error('Pi List tool boundary mismatch');
  const mcpSource = await readFile(new URL('../src/main/mcp.ts', import.meta.url), 'utf8');
  if (mcpSource.includes("x_lists.confirm") || mcpSource.includes('confirmAndRunXListOperation') || !mcpSource.includes("x_lists.collect_timeline") || !mcpSource.includes("x_lists.read_index") || !mcpSource.includes("x_lists.read_detail") || !mcpSource.includes("x_lists.read_members") || !mcpSource.includes("x_lists.read_timeline")) throw new Error('MCP List tool boundary mismatch');
} finally {
  await mcp?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
