import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import {
  beginXListOperation,
  getXListOperation,
  grantXListOperation,
  leaseXListOperation,
  listXListOperations,
  prepareXListOperation,
  armXListOperation,
  xListPayloadFingerprint,
  xListSnapshotFingerprint
} from '../src/main/x-lists.ts';
import { dispatchRecoverOrphanedXListOperations } from '../src/main/x-list-business-command.ts';

test('X List operation list stays pure-read while orphan recover writes once only when needed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-list-list-read-'));
  let runtime;
  try {
    const setup = migrateDatabase(path.join(directory, 'wmb.db'));
    const now = new Date().toISOString();
    setup.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
      .run('workspace-x-list-list-read', now, now);

    const prepared = prepareXListOperation(setup, {
      requestId: 'x-list-list-read-1',
      accountKey: '@Owner',
      kind: 'members_add',
      listId: '1234567890',
      handles: ['@Alice']
    });
    assert.equal(prepared.ok, true);
    const snapshot = {
      accountKey: '@Owner',
      list: {
        listId: '1234567890',
        canonicalUrl: 'https://x.com/i/lists/1234567890',
        ownerHandle: '@Owner',
        name: 'AI前沿',
        description: '前沿专家',
        isPrivate: false,
        memberCount: 0,
        kind: 'owned',
        evidenceFingerprint: 'page-a'
      },
      members: [{ handle: '@Alice', present: false }]
    };
    const armed = armXListOperation(setup, {
      operationId: prepared.data.operation.id,
      expectedRevision: prepared.data.operation.revision,
      snapshot
    });
    assert.equal(armed.ok, true);
    seedExecutionGrant(setup, 'grant-list-read');
    const granted = grantXListOperation(setup, {
      operationId: armed.data.id,
      expectedRevision: armed.data.revision,
      authority: {
        executionGrantId: 'grant-list-read',
        browserProfileId: 'profile-x',
        browserBindingRevision: 1,
        expectedAccount: armed.data.accountKey,
        operationInputHash: armed.data.inputHash,
        confirmationFingerprint: armed.data.confirmationFingerprint,
        snapshotFingerprint: xListSnapshotFingerprint(armed.data.snapshot),
        payloadFingerprint: xListPayloadFingerprint(armed.data.payload)
      }
    });
    assert.equal(granted.ok, true);
    const leased = leaseXListOperation(setup, {
      operationId: granted.data.id,
      expectedRevision: granted.data.revision,
      executionGrantId: 'grant-list-read'
    });
    assert.equal(leased.ok, true);
    const running = beginXListOperation(setup, {
      operationId: leased.data.id,
      expectedRevision: leased.data.revision,
      executionGrantId: 'grant-list-read'
    });
    assert.equal(running.ok, true);
    setup.close();

    runtime = ActiveWorkspaceRuntime.open(directory, {
      expectedWorkspaceId: 'workspace-x-list-list-read',
      createEpoch: () => 'runtime-x-list-list-read',
      openDatabase: migrateDatabase
    });

    const beforeList = countReceipts(runtime.database, 'x_lists.operation_recover');
    const listed = listXListOperations(runtime.database, { limit: 8 });
    assert.equal(listed.some((item) => item.id === running.data.id && item.state === 'running'), true);
    assert.equal(countReceipts(runtime.database, 'x_lists.operation_recover'), beforeList);

    // Empty-ops / no-orphan path must not write a recover receipt on every poll.
    assert.equal(await dispatchRecoverOrphanedXListOperations(runtime, new Set([running.data.id])), 0);
    assert.equal(countReceipts(runtime.database, 'x_lists.operation_recover'), beforeList);
    assert.equal(getXListOperation(runtime.database, running.data.id)?.state, 'running');

    // Real interrupted ops still recover once through the dispatcher.
    assert.equal(await dispatchRecoverOrphanedXListOperations(runtime, new Set()), 1);
    assert.equal(getXListOperation(runtime.database, running.data.id)?.state, 'needs_user');
    assert.equal(countReceipts(runtime.database, 'x_lists.operation_recover'), beforeList + 1);

    // Same runtime epoch recover is idempotent (exact replay) and does not flood.
    assert.equal(await dispatchRecoverOrphanedXListOperations(runtime, new Set()), 0);
    assert.equal(countReceipts(runtime.database, 'x_lists.operation_recover'), beforeList + 1);
    assert.equal(listXListOperations(runtime.database, { limit: 8 }).length >= 1, true);
    assert.equal(countReceipts(runtime.database, 'x_lists.operation_recover'), beforeList + 1);
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function countReceipts(database, command) {
  return database.prepare('SELECT COUNT(*) AS count FROM command_receipts WHERE command=?').get(command).count;
}

function seedExecutionGrant(database, id) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_grants
    (id, workspace_id, runtime_epoch, task_id, task_grant_id, command, input_hash, bound_identity_json,
     target_actor_type, target_actor_id, browser_profile_id, binding_revision, expected_account, allowed_transition,
     required_readback_json, status, issued_at, expires_at, revision)
    VALUES (?, 'workspace-x-list-list-read', 'runtime-x-list-list-read', NULL, NULL, 'x_lists.operation_execute', ?, '{}',
      'owner_ui', 'renderer', 'profile-x', 1, '@Owner', 'prepared->execution_granted', '{}', 'consumed', ?, ?, 2)`)
    .run(id, `hash-${id}`, now, new Date(Date.now() + 60_000).toISOString());
}
