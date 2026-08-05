import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import {
  armXListOperation, beginXListOperation, bindXList, getXListOperation, grantXListOperation,
  leaseXListOperation, prepareXListOperation, recordXListOperationIntent, recoverOrphanedXListOperations,
  setXListBindingEnabled, xListPayloadFingerprint, xListSnapshotFingerprint
} from '../src/main/x-lists.ts';

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
  if (!armed.ok || armed.data.state !== 'prepared' || armed.data.phase !== 'awaiting_confirmation' || !armed.data.confirmationFingerprint) throw new Error('UI arm did not freeze snapshot in prepared state');
  const broadened = grantXListOperation(db, {
    operationId: armed.data.id, expectedRevision: armed.data.revision,
    authority: executionAuthority(armed.data, 'grant-broadened', { snapshotFingerprint: xListSnapshotFingerprint({ ...snapshot, list: { ...snapshot.list, description: '已变化' } }) })
  });
  if (broadened.ok || broadened.error.code !== 'EXECUTION_GRANT_SCOPE_MISMATCH') throw new Error('broadened grant was accepted');

  seedExecutionGrant(db, 'grant-exact');
  const granted = grantXListOperation(db, {
    operationId: armed.data.id, expectedRevision: armed.data.revision,
    authority: executionAuthority(armed.data, 'grant-exact')
  });
  if (!granted.ok || granted.data.state !== 'execution_granted' || granted.data.executionGrantId !== 'grant-exact' || granted.data.startedAt) throw new Error('exact grant was not committed first');
  const leased = leaseXListOperation(db, { operationId: granted.data.id, expectedRevision: granted.data.revision, executionGrantId: 'grant-exact' });
  if (!leased.ok || leased.data.state !== 'browser_leased') throw new Error('browser lease was not committed after grant');
  const running = beginXListOperation(db, { operationId: leased.data.id, expectedRevision: leased.data.revision, executionGrantId: 'grant-exact' });
  if (!running.ok || running.data.state !== 'running' || running.data.phase !== 'executing' || !running.data.startedAt) throw new Error('executing state was not committed after browser lease');
  recordXListOperationIntent(db, running.data.id, 'member_add', '@Alice');
  if (recoverOrphanedXListOperations(db, new Set()) !== 1 || getXListOperation(db, running.data.id)?.state !== 'unknown') throw new Error('post-intent crash was resumable or not marked unknown');

  const recoveryPrepared = prepareXListOperation(db, { requestId: 'x-list-recovery-before-action', accountKey: '@Owner', kind: 'members_add', listId: '1234567890', handles: ['@Alice'] });
  const recoveryArmed = recoveryPrepared.ok && armXListOperation(db, { operationId: recoveryPrepared.data.operation.id, expectedRevision: recoveryPrepared.data.operation.revision, snapshot: { ...snapshot, members: [{ handle: '@Alice', present: false }] } });
  seedExecutionGrant(db, 'grant-recovery');
  const recoveryGranted = recoveryArmed && recoveryArmed.ok && grantXListOperation(db, { operationId: recoveryArmed.data.id, expectedRevision: recoveryArmed.data.revision, authority: executionAuthority(recoveryArmed.data, 'grant-recovery') });
  if (!recoveryGranted || !recoveryGranted.ok) throw new Error('pre-action recovery fixture failed');
  if (recoverOrphanedXListOperations(db, new Set()) !== 1 || getXListOperation(db, recoveryGranted.data.id)?.state !== 'needs_user') throw new Error('pre-action crash was resumed');

  const legacyPrepared = prepareXListOperation(db, { requestId: 'x-list-legacy-awaiting', accountKey: '@Owner', kind: 'delete', listId: '1234567890' });
  if (!legacyPrepared.ok) throw new Error('legacy fixture failed');
  db.prepare("UPDATE x_list_operations SET state='awaiting_confirmation', phase='awaiting_confirmation' WHERE id=?").run(legacyPrepared.data.operation.id);
  if (getXListOperation(db, legacyPrepared.data.operation.id)?.state !== 'awaiting_confirmation') throw new Error('legacy awaiting_confirmation row became unreadable');

  const binding = bindXList(db, {
    accountKey: '@Owner', list: { listId: '2222222222', canonicalUrl: 'https://x.com/i/lists/2222222222', ownerHandle: '@Author', name: 'AI资讯', kind: 'following' }, observation: { source: 'test' }
  });
  if (!binding.ok || !binding.data.enabled) throw new Error('binding was not created');
  const disabled = setXListBindingEnabled(db, { accountKey: binding.data.accountKey, listId: binding.data.listId, expectedRevision: binding.data.revision, enabled: false });
  const feedCount = db.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count;
  if (!disabled.ok || disabled.data.enabled || feedCount !== 1) throw new Error('unbind deleted the source feed');
  const accountIndex = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='x_list_operations_account_updated'").get();
  const itemIndex = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='x_list_operation_items_operation'").get();
  if (!accountIndex || !itemIndex) throw new Error('v44 did not preserve X List operation indexes');
  db.close();

  mcp = await startMcp(directory);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?test=${Date.now()}`)).default;
  extension({ registerTool(tool) { tools.set(tool.name, tool); } });
  if (!tools.has('wmb_prepare_x_list_operation') || !tools.has('wmb_create_x_list') || !tools.has('wmb_add_x_list_members') || !tools.has('wmb_remove_x_list_members') || !tools.has('wmb_collect_x_list_timeline') || tools.has('wmb_confirm_x_list_operation') || !tools.has('wmb_read_x_list_index') || !tools.has('wmb_read_x_list_detail') || !tools.has('wmb_read_x_list_members') || !tools.has('wmb_read_x_list_timeline')) throw new Error('Pi List tool boundary mismatch');
  for (const name of ['wmb_prepare_x_list_operation', 'wmb_create_x_list', 'wmb_add_x_list_members', 'wmb_remove_x_list_members']) {
    const tool = tools.get(name);
    if (!tool.description.includes('准备') || !tool.description.includes('Owner') || !tool.description.includes('UI')) throw new Error(`${name} did not expose Owner-confirmed prepare semantics`);
    for (const authority of ['taskId', 'grantId', 'workerLeaseId']) {
      if (!tool.parameters.required.includes(authority)) throw new Error(`${name} did not require ${authority}`);
    }
  }
  const kinds = tools.get('wmb_prepare_x_list_operation').parameters.properties.kind.enum;
  for (const kind of ['create', 'update', 'delete', 'members_add', 'members_remove']) {
    if (!kinds.includes(kind)) throw new Error(`prepare tool omitted ${kind}`);
  }

function seedExecutionGrant(database, id) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_grants
    (id, workspace_id, runtime_epoch, task_id, task_grant_id, command, input_hash, bound_identity_json,
     target_actor_type, target_actor_id, browser_profile_id, binding_revision, expected_account, allowed_transition,
     required_readback_json, status, issued_at, expires_at, revision)
    VALUES (?, 'test-workspace', 'test-epoch', NULL, NULL, 'x_lists.operation_execute', ?, '{}',
      'owner_ui', 'renderer', 'profile-x', 1, '@Owner', 'prepared->execution_granted', '{}', 'consumed', ?, ?, 2)`)
    .run(id, `hash-${id}`, now, new Date(Date.now() + 60_000).toISOString());
}

function executionAuthority(operation, executionGrantId, overrides = {}) {
  return {
    executionGrantId,
    browserProfileId: 'profile-x',
    browserBindingRevision: 1,
    expectedAccount: operation.accountKey,
    operationInputHash: operation.inputHash,
    confirmationFingerprint: operation.confirmationFingerprint,
    snapshotFingerprint: xListSnapshotFingerprint(operation.snapshot),
    payloadFingerprint: xListPayloadFingerprint(operation.payload),
    ...overrides
  };
}
} finally {
  await mcp?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
