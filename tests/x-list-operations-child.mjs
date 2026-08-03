import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { armXListOperation, beginXListOperation, bindXList, finishXListOperation, getXListOperation, prepareXListOperation, recordXListConfirmationFailure, recoverOrphanedXListOperations, setXListBindingEnabled } from '../src/main/x-lists.ts';
import { acceptXListOperation, addXListMembersWithReplay, beginDirectXListMemberAdd, confirmAndRunXListOperation, removeXListMembersWithReplay } from '../src/main/x-list-execution.ts';

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

  const retryPrepared = prepareXListOperation(db, { requestId: 'x-list-members-confirm-retry', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice'] });
  const retryArmed = retryPrepared.ok && armXListOperation(db, { operationId: retryPrepared.data.operation.id, expectedRevision: retryPrepared.data.operation.revision, snapshot: { ...snapshot, members: [{ handle: '@Alice', present: false }] } });
  if (!retryArmed || !retryArmed.ok) throw new Error('retry fixture did not arm');
  const blocked = recordXListConfirmationFailure(db, { operationId: retryArmed.data.id, expectedRevision: retryArmed.data.revision, code: 'BROWSER_NEEDS_USER', message: '旧请求已取消' });
  if (blocked?.state !== 'awaiting_confirmation' || blocked.phase !== 'confirmation_blocked' || blocked.errorMessage !== '旧请求已取消') throw new Error('confirmation failure was not persisted');
  const retried = beginXListOperation(db, { operationId: blocked.id, expectedRevision: blocked.revision, currentSnapshot: { ...snapshot, members: [{ handle: '@Alice', present: false }] } });
  if (!retried.ok || retried.data.state !== 'running' || retried.data.errorMessage) throw new Error('confirmation retry did not clear the persisted failure');

  const queuedPrepared = prepareXListOperation(db, { requestId: 'x-list-members-background', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice'] });
  const queuedArmed = queuedPrepared.ok && armXListOperation(db, { operationId: queuedPrepared.data.operation.id, expectedRevision: queuedPrepared.data.operation.revision, snapshot: { ...snapshot, members: [{ handle: '@Alice', present: false }] } });
  if (!queuedArmed || !queuedArmed.ok) throw new Error('background fixture did not arm');
  const accepted = acceptXListOperation(db, { operationId: queuedArmed.data.id, expectedRevision: queuedArmed.data.revision });
  if (!accepted.ok || accepted.data.state !== 'running' || !accepted.data.confirmedAt || !accepted.data.startedAt) throw new Error('one UI confirmation was not persisted before browser execution');
  if (recoverOrphanedXListOperations(db, new Set([retried.data.id])) !== 1 || getXListOperation(db, accepted.data.id)?.state !== 'needs_user') throw new Error('orphaned background operation still pretended to run');

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
  const terminalPrepared = prepareXListOperation(db, { requestId: 'x-list-terminal-replay', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice'] });
  if (!terminalPrepared.ok) throw new Error('terminal replay fixture was not prepared');
  const terminal = finishXListOperation(db, terminalPrepared.data.operation.id, { state: 'partial', phase: 'partial_member_readbacks' });
  const replay = await addXListMembersWithReplay(db, { requestId: 'x-list-terminal-replay', accountKey: '@Owner', listId: '1234567890', handles: ['@Alice'] }, async () => { throw new Error('terminal replay touched browser preflight'); });
  if (!replay.ok || !replay.data.replayed || replay.data.attemptedNow || replay.data.id !== terminal.id) throw new Error('terminal member-add replay was not explicit');
  const removePrepared = prepareXListOperation(db, { requestId: 'x-list-remove-terminal-replay', accountKey: '@Owner', kind: 'members_remove', listId: '1234567890', handles: ['@Alice'] });
  if (!removePrepared.ok) throw new Error('terminal remove replay fixture was not prepared');
  const removeTerminal = finishXListOperation(db, removePrepared.data.operation.id, { state: 'succeeded', phase: 'completed' });
  const removeReplay = await removeXListMembersWithReplay(db, { requestId: 'x-list-remove-terminal-replay', accountKey: '@Owner', listId: '1234567890', handles: ['@Alice'] }, async () => { throw new Error('terminal remove replay touched browser preflight'); });
  if (!removeReplay.ok || !removeReplay.data.replayed || removeReplay.data.attemptedNow || removeReplay.data.id !== removeTerminal.id || removeReplay.data.kind !== 'members_remove') throw new Error('terminal member-remove replay was not explicit');
  const directPrepared = prepareXListOperation(db, { requestId: 'x-list-direct-one-snapshot', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice'] });
  const directArmed = directPrepared.ok && armXListOperation(db, { operationId: directPrepared.data.operation.id, expectedRevision: directPrepared.data.operation.revision, snapshot: { ...snapshot, list: { ...snapshot.list, name: 'List 1234567890', memberCount: null }, members: [{ handle: '@Alice', present: false }] } });
  if (!directArmed || !directArmed.ok) throw new Error('direct member-add fixture did not arm');
  const directStarted = beginDirectXListMemberAdd(db, directArmed.data);
  if (!directStarted.ok || directStarted.data.state !== 'running') throw new Error('direct member-add recaptured its progressively rendered snapshot');
  db.close();

  mcp = await startMcp(directory);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?test=${Date.now()}`)).default;
  extension({ registerTool(tool) { tools.set(tool.name, tool); } });
  if (!tools.has('wmb_prepare_x_list_operation') || !tools.has('wmb_add_x_list_members') || !tools.has('wmb_remove_x_list_members') || !tools.has('wmb_collect_x_list_timeline') || tools.has('wmb_confirm_x_list_operation') || !tools.has('wmb_read_x_list_index') || !tools.has('wmb_read_x_list_detail') || !tools.has('wmb_read_x_list_members') || !tools.has('wmb_read_x_list_timeline')) throw new Error('Pi List tool boundary mismatch');
  const mcpSource = await readFile(new URL('../src/main/mcp.ts', import.meta.url), 'utf8');
  if (mcpSource.includes("x_lists.confirm") || mcpSource.includes('confirmAndRunXListOperation') || !mcpSource.includes("x_lists.members_add") || !mcpSource.includes('return await addXListMembersWithReplay') || !mcpSource.includes("x_lists.members_remove") || !mcpSource.includes('return await removeXListMembersWithReplay') || !mcpSource.includes("x_lists.collect_timeline") || !mcpSource.includes('return await collectBoundXListTimeline') || !mcpSource.includes("x_lists.read_index") || !mcpSource.includes("x_lists.read_detail") || !mcpSource.includes("x_lists.read_members") || !mcpSource.includes("x_lists.read_timeline")) throw new Error('MCP List tool boundary mismatch');
  const addTool = tools.get('wmb_add_x_list_members');
  if (!addTool.description.includes('明确 SOP') || !addTool.description.includes('禁止读源码猜用法') || !addTool.parameters.properties.requestId.description || !addTool.parameters.properties.handles.items.description) throw new Error('small-model member-add contract is incomplete');
  const removeTool = tools.get('wmb_remove_x_list_members');
  if (!removeTool.description.includes('明确 SOP') || !removeTool.description.includes('禁止读源码猜用法') || !removeTool.parameters.properties.requestId.description || !removeTool.parameters.properties.handles.items.description) throw new Error('small-model member-remove contract is incomplete');
  if (tools.get('wmb_prepare_x_list_operation').parameters.properties.kind.enum.includes('members_remove')) throw new Error('member removal still exposed through the obsolete prepare path');
} finally {
  await mcp?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
