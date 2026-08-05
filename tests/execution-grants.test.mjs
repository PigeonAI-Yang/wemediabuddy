import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  dispatchIssueExecutionGrant,
  dispatchRevokeExecutionGrant,
  getExecutionGrant
} from '../src/main/execution-grants.ts';
import { dispatchConfirmIntelligenceChannelProposal } from '../src/main/intelligence-channel-command.ts';
import { readChannelProposalContext } from '../src/main/intelligence-channel-confirmation.ts';
import { channelProposalBinding, IntelligenceChannelProposalStore } from '../src/main/intelligence-channel-proposals.ts';
import { registerExecutionGrantIpc } from '../src/main/ipc-execution-grants.ts';
import { registerExecutionGrantMcp } from '../src/main/mcp-execution-grants.ts';
import { dispatchIssueTaskGrant } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { dispatchAcceptXListOperation } from '../src/main/x-list-command.ts';
import { createXListOperationPersistence, dispatchBeginXListOperation, dispatchLeaseXListOperation } from '../src/main/x-list-business-command.ts';
import { armXListOperation, prepareXListOperation } from '../src/main/x-lists.ts';
import { initializeWorkspaceBrowserBinding } from '../src/main/workspace-browser-binding.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const future = () => new Date(Date.now() + 60_000).toISOString();
const owner = Object.freeze({ type: 'owner_ui', id: 'renderer', label: 'Owner UI' });
const websiteIdentity = Object.freeze({
  proposalId: 'proposal-1', bindingId: 'binding-1', bindingRevision: 3,
  browserProfileId: 'profile-1', browserBindingRevision: 7, expectedAccount: '@owner',
  allowedTransition: 'prepared_to_applied', requiredReadback: { proposalStatus: 'applied', expectedRevision: 4 }
});

const websiteInput = Object.freeze({ proposalId: 'proposal-1', action: 'apply', expectedRevision: 3 });

test('a matching precise grant is consumed atomically and exact replay does not consume or write twice', async () => {
  await withRuntime('wmb-execution-success-', 'epoch-current', async ({ runtime, database, taskId }) => {
    const authority = await createAuthority(runtime, taskId);
    const target = targetEnvelope(runtime, authority, { requestId: 'target-success' });
    const issued = await issueForTarget(runtime, target, authority, { requestId: 'issue-success' });
    assert.equal(issued.ok, true);
    assert.equal(issued.data.status, 'active');
    assert.deepEqual(issued.data.boundIdentity, websiteIdentity);
    assert.deepEqual(issued.data.requiredReadback, { proposalStatus: 'applied', expectedRevision: 4 });

    const authorized = targetEnvelope(runtime, authority, {
      requestId: 'target-success', executionGrantId: issued.data.id
    });
    const receipt = await runtime.dispatchCommand(authorized, () => syntheticWrite(database, 'success'));
    assert.equal(receipt.ok, true);
    assert.equal(receipt.executionGrantId, issued.data.id);
    assert.equal(authorized.inputHash, target.inputHash);
    assert.equal(writeCount(database), 1);
    const consumed = getExecutionGrant(database, issued.data.id, new Date(), runtime.identity);
    assert.equal(consumed.status, 'consumed');
    assert.equal(consumed.revision, 2);
    assert.ok(consumed.consumedAt);

    const replay = await runtime.dispatchCommand(authorized, () => syntheticWrite(database, 'must-not-replay'));
    assert.deepEqual(replay, receipt);
    assert.equal(writeCount(database), 1);
    assert.equal(getExecutionGrant(database, issued.data.id).revision, 2);
    const receiptRow = database.prepare(`SELECT execution_grant_id AS executionGrantId, receipt_json AS receiptJson
      FROM command_receipts WHERE request_id=?`).get('target-success');
    assert.equal(receiptRow.executionGrantId, issued.data.id);
    assert.equal(JSON.parse(receiptRow.receiptJson).executionGrantId, issued.data.id);
  });
});

test('Owner X confirmation issues and consumes one exact prepared-operation grant', async () => {
  await withRuntime('wmb-execution-x-list-', 'epoch-x-list', async ({ runtime, database, root, xOperation }) => {
    const operation = xOperation;
    const receipt = await dispatchAcceptXListOperation(runtime, {
      root: { path: root }, workspaceId: runtime.identity.workspaceId, browserId: 'profile-x', accountKey: '@owner',
      config: { profileDir: path.join(root, 'profile') }, selectedXListBrowser() { throw new Error('not used before browser execution'); }
    }, {
      operationId: operation.id, expectedRevision: operation.revision
    });
    assert.equal(receipt.ok, true);
    assert.ok(receipt.executionGrantId);
    assert.equal(receipt.data.state, 'execution_granted');
    assert.equal(receipt.data.executionGrantId, receipt.executionGrantId);
    assert.equal(getExecutionGrant(database, receipt.executionGrantId).status, 'consumed');
    const replay = await dispatchAcceptXListOperation(runtime, {
      root: { path: root }, workspaceId: runtime.identity.workspaceId, browserId: 'profile-x', accountKey: '@owner',
      config: { profileDir: path.join(root, 'profile') }, selectedXListBrowser() { throw new Error('exact replay touched browser execution'); }
    }, { operationId: operation.id, expectedRevision: operation.revision });
    assert.deepEqual(replay, receipt);
    assert.equal(getExecutionGrant(database, receipt.executionGrantId).revision, 2);
    const leased = await dispatchLeaseXListOperation(runtime, operation.id, receipt.executionGrantId);
    assert.equal(leased.state, 'browser_leased');
    const running = await dispatchBeginXListOperation(runtime, operation.id, receipt.executionGrantId);
    assert.equal(running.state, 'running');
    assert.equal(running.phase, 'executing');
    const persistence = createXListOperationPersistence(runtime, operation.id, receipt.executionGrantId);
    await persistence.recordIntent('member_add', '@alice');
    await persistence.updateItem({ handle: '@alice', state: 'succeeded', evidence: { outcome: 'added' } });
    const persistedCommands = database.prepare(`SELECT command FROM command_receipts
      WHERE command IN ('x_lists.operation_browser_lease', 'x_lists.operation_begin_execution', 'x_lists.operation_intent', 'x_lists.operation_item_write')`).all();
    assert.deepEqual(persistedCommands.map(({ command }) => command).sort(), [
      'x_lists.operation_begin_execution', 'x_lists.operation_browser_lease', 'x_lists.operation_intent', 'x_lists.operation_item_write'
    ]);
  }, {
    seed({ database }) {
      initializeWorkspaceBrowserBinding(database, 'profile-x', {
        x: {
          platform: 'x', accountKey: '@owner', displayName: 'Owner', loginState: 'authenticated',
          accountRevision: 1, browserProfileId: 'profile-x', browserBindingRevision: 1, verifiedAt: '2026-08-05T00:00:00.000Z'
        }
      });
      const prepared = prepareXListOperation(database, {
        requestId: 'x-prepare', accountKey: '@owner', kind: 'members_add', listId: '123', handles: ['@alice'],
        preparedActor: owner
      });
      assert.equal(prepared.ok, true);
      const armed = armXListOperation(database, {
        operationId: prepared.data.operation.id,
        expectedRevision: prepared.data.operation.revision,
        snapshot: {
          accountKey: '@owner',
          list: { listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@owner', name: 'Research', description: '', isPrivate: false, memberCount: 0, kind: 'owned', evidenceFingerprint: 'list-proof' },
          members: [{ handle: '@alice', present: false }]
        }
      });
      assert.equal(armed.ok, true);
      return { xOperation: armed.data };
    }
  });
});
test('Owner website confirmation applies through one consumed exact grant', async () => {
  await withRuntime('wmb-execution-website-', 'epoch-website', async ({ runtime, database }) => {
    const candidate = { inputText: 'Example', name: 'Example', url: 'https://example.com/', canonicalUrl: 'https://example.com/', origin: 'direct' };
    const trial = { title: 'Example', url: 'https://example.com/', requestedUrl: 'https://example.com/', readable: true, itemCount: 0 };
    const store = new IntelligenceChannelProposalStore();
    const proposal = store.prepare({
      requestId: 'website-prepare',
      changes: [{ action: 'add', module: 'official_web', inputText: 'Example', candidate, trialRead: trial }]
    }, readChannelProposalContext(database));
    const receipt = await dispatchConfirmIntelligenceChannelProposal(runtime, {
      store,
      binding: channelProposalBinding(proposal),
      trialWebsite: async () => trial
    });
    assert.equal(receipt.ok, true);
    assert.ok(receipt.executionGrantId);
    assert.equal(receipt.data.applied, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM website_sources').get().count, 1);
    assert.equal(getExecutionGrant(database, receipt.executionGrantId).status, 'consumed');
  });
});


test('missing, stale, cross-root, scope, identity, expiry, revocation and prior consumption reject before domain writes', async () => {
  const first = await openRuntime('wmb-execution-invalid-a-', 'epoch-a', {
    seed({ database, workspaceId, epoch }) {
      seedExecutionGrant(database, {
        id: 'grant-stale', workspaceId, runtimeEpoch: 'old-epoch', hashEpoch: epoch,
        expiresAt: '2099-01-01T00:00:00.000Z'
      });
      seedExecutionGrant(database, {
        id: 'grant-expired', workspaceId, runtimeEpoch: epoch, hashEpoch: epoch,
        expiresAt: '2000-01-01T00:00:00.000Z'
      });
    }
  });
  const second = await openRuntime('wmb-execution-invalid-b-', 'epoch-b');
  try {
    const firstAuthority = await createAuthority(first.runtime, first.taskId);
    const baseline = writeCount(first.database);

    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, { requestId: 'missing' }),
      'EXECUTION_GRANT_REQUIRED', baseline);

    assert.equal(getExecutionGrant(first.database, 'grant-stale', new Date(), first.runtime.identity).status, 'stale');
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, null, { requestId: 'stale', executionGrantId: 'grant-stale' }),
      'EXECUTION_GRANT_STALE', baseline);

    const crossTarget = targetEnvelope(first.runtime, firstAuthority, { requestId: 'cross-source' });
    const crossGrant = await issueForTarget(first.runtime, crossTarget, firstAuthority, { requestId: 'issue-cross' });
    const crossEnvelope = createCommandEnvelope({
      workspaceId: second.runtime.identity.workspaceId,
      runtimeEpoch: second.runtime.identity.runtimeEpoch,
      command: 'intelligence_channels.proposal_apply',
      requestId: 'cross-root',
      input: websiteInput,
      boundIdentity: websiteIdentity,
      actor: owner,
      executionGrantId: crossGrant.data.id
    });
    await assertRejectedWrite(second.runtime, second.database, crossEnvelope, 'EXECUTION_GRANT_NOT_FOUND', 0);

    const wrongCommandTarget = targetEnvelope(first.runtime, firstAuthority, { requestId: 'wrong-command' });
    const wrongCommandGrant = await issueForTarget(first.runtime, wrongCommandTarget, firstAuthority, {
      requestId: 'issue-wrong-command', command: 'x_lists.operation_execute'
    });
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, { requestId: 'wrong-command', executionGrantId: wrongCommandGrant.data.id }),
      'EXECUTION_GRANT_SCOPE_MISMATCH', baseline);

    const originalHashTarget = targetEnvelope(first.runtime, firstAuthority, { requestId: 'wrong-hash-base' });
    const wrongHashGrant = await issueForTarget(first.runtime, originalHashTarget, firstAuthority, { requestId: 'issue-wrong-hash' });
    const changedInput = targetEnvelope(first.runtime, firstAuthority, {
      requestId: 'wrong-hash', executionGrantId: wrongHashGrant.data.id,
      input: { ...websiteInput, expectedRevision: 4 }
    });
    await assertRejectedWrite(first.runtime, first.database, changedInput, 'EXECUTION_GRANT_SCOPE_MISMATCH', baseline);

    const changedIdentity = { ...websiteIdentity, bindingRevision: 4 };
    const changedIdentityTarget = targetEnvelope(first.runtime, firstAuthority, {
      requestId: 'wrong-identity', boundIdentity: changedIdentity
    });
    const identityGrant = await issueForTarget(first.runtime, changedIdentityTarget, firstAuthority, {
      requestId: 'issue-wrong-identity', boundIdentity: websiteIdentity
    });
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, {
        requestId: 'wrong-identity', executionGrantId: identityGrant.data.id, boundIdentity: changedIdentity
      }),
      'EXECUTION_GRANT_IDENTITY_MISMATCH', baseline);

    const frozenFieldTarget = targetEnvelope(first.runtime, firstAuthority, { requestId: 'wrong-frozen-field' });
    const frozenFieldGrant = await issueForTarget(first.runtime, frozenFieldTarget, firstAuthority, {
      requestId: 'issue-wrong-frozen-field', bindingRevision: 8
    });
    assert.equal(frozenFieldGrant.ok, true);
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, {
        requestId: 'wrong-frozen-field', executionGrantId: frozenFieldGrant.data.id
      }),
      'EXECUTION_GRANT_SCOPE_MISMATCH', baseline);

    const schedulerTarget = targetEnvelope(first.runtime, firstAuthority, {
      requestId: 'wrong-actor', actor: { type: 'scheduler', id: 'daily' }
    });
    const actorGrant = await issueForTarget(first.runtime, schedulerTarget, firstAuthority, { requestId: 'issue-wrong-actor' });
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, {
        requestId: 'wrong-actor', executionGrantId: actorGrant.data.id, actor: { type: 'scheduler', id: 'daily' }
      }),
      'EXECUTION_GRANT_IDENTITY_MISMATCH', baseline);

    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, null, { requestId: 'expired', executionGrantId: 'grant-expired' }),
      'EXECUTION_GRANT_EXPIRED', baseline);

    const revokedTarget = targetEnvelope(first.runtime, firstAuthority, { requestId: 'revoked' });
    const revokedGrant = await issueForTarget(first.runtime, revokedTarget, firstAuthority, { requestId: 'issue-revoked' });
    const revoked = await dispatchRevokeExecutionGrant(first.runtime, {
      requestId: 'revoke-grant', executionGrantId: revokedGrant.data.id, expectedRevision: 1
    });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.data.status, 'revoked');
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, { requestId: 'revoked', executionGrantId: revokedGrant.data.id }),
      'EXECUTION_GRANT_REVOKED', baseline);

    const consumedTarget = targetEnvelope(first.runtime, firstAuthority, { requestId: 'consume-first' });
    const consumedGrant = await issueForTarget(first.runtime, consumedTarget, firstAuthority, { requestId: 'issue-consumed' });
    const consumeReceipt = await first.runtime.dispatchCommand(
      targetEnvelope(first.runtime, firstAuthority, { requestId: 'consume-first', executionGrantId: consumedGrant.data.id }),
      () => syntheticWrite(first.database, 'consume-once')
    );
    assert.equal(consumeReceipt.ok, true);
    const afterConsume = writeCount(first.database);
    await assertRejectedWrite(first.runtime, first.database,
      targetEnvelope(first.runtime, firstAuthority, { requestId: 'consume-again', executionGrantId: consumedGrant.data.id }),
      'EXECUTION_GRANT_CONSUMED', afterConsume);
  } finally {
    await closeRuntime(first);
    await closeRuntime(second);
  }
});

test('handler failure rolls grant consumption and domain writes back while persisting an error receipt', async () => {
  await withRuntime('wmb-execution-handler-', 'epoch-handler', async ({ runtime, database, taskId }) => {
    const authority = await createAuthority(runtime, taskId);
    const target = targetEnvelope(runtime, authority, { requestId: 'handler-failure' });
    const grant = await issueForTarget(runtime, target, authority, { requestId: 'issue-handler-failure' });
    const envelope = targetEnvelope(runtime, authority, {
      requestId: 'handler-failure', executionGrantId: grant.data.id
    });
    const receipt = await runtime.dispatchCommand(envelope, () => {
      database.prepare('INSERT INTO synthetic_execution_writes(label) VALUES (?)').run('rolled-back');
      throw new Error('synthetic handler failure');
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, 'COMMAND_FAILED');
    assert.equal(receipt.executionGrantId, grant.data.id);
    assert.equal(writeCount(database), 0);
    const active = getExecutionGrant(database, grant.data.id, new Date(), runtime.identity);
    assert.equal(active.status, 'active');
    assert.equal(active.revision, 1);
    assert.equal(active.consumedAt, null);
    const stored = database.prepare(`SELECT status, execution_grant_id AS executionGrantId
      FROM command_receipts WHERE request_id=?`).get('handler-failure');
    assert.equal(stored.status, 'error');
    assert.equal(stored.executionGrantId, grant.data.id);
  });
});

test('IPC exposes owner lifecycle while MCP registers only read surfaces', () => {
  const ipcChannels = [];
  registerExecutionGrantIpc({ handle(channel) { ipcChannels.push(channel); } }, () => null);
  assert.deepEqual(ipcChannels.sort(), [
    'execution-grants:get',
    'execution-grants:issue',
    'execution-grants:list',
    'execution-grants:revoke'
  ]);

  const mcpTools = [];
  registerExecutionGrantMcp({ registerTool(name) { mcpTools.push(name); } }, () => {
    throw new Error('registration must not open the database');
  });
  assert.deepEqual(mcpTools.sort(), ['execution_grants.get', 'execution_grants.list']);
});

async function createAuthority(runtime, taskId) {
  const taskGrant = await dispatchIssueTaskGrant(runtime, {
    requestId: `task-grant-${taskId}`,
    taskId,
    ownerGoal: '执行已确认操作',
    allowedCommands: ['intelligence_channels.proposal_apply', 'x_lists.operation_execute'],
    workers: [{ type: 'external_agent', id: 'mcp' }],
    relevantContext: { proposalId: 'proposal-1' },
    expiresAt: future()
  });
  assert.equal(taskGrant.ok, true);
  return { taskId, taskGrantId: taskGrant.data.id };
}

function targetEnvelope(runtime, authority, overrides = {}) {
  return createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: overrides.command ?? 'intelligence_channels.proposal_apply',
    requestId: overrides.requestId ?? randomUUID(),
    input: overrides.input ?? websiteInput,
    boundIdentity: overrides.boundIdentity ?? websiteIdentity,
    actor: overrides.actor ?? owner,
    taskId: authority?.taskId,
    grantId: authority?.taskGrantId,
    ...(overrides.executionGrantId ? { executionGrantId: overrides.executionGrantId } : {})
  });
}

function issueForTarget(runtime, target, authority, overrides = {}) {
  return dispatchIssueExecutionGrant(runtime, {
    requestId: overrides.requestId ?? randomUUID(),
    taskId: authority?.taskId,
    taskGrantId: authority?.taskGrantId,
    command: overrides.command ?? target.command,
    inputHash: target.inputHash,
    boundIdentity: overrides.boundIdentity ?? target.boundIdentity,
    targetActor: owner,
    browserProfileId: overrides.browserProfileId ?? 'profile-1',
    bindingRevision: overrides.bindingRevision ?? 7,
    expectedAccount: overrides.expectedAccount ?? '@owner',
    allowedTransition: overrides.allowedTransition ?? 'prepared_to_applied',
    requiredReadback: overrides.requiredReadback ?? { proposalStatus: 'applied', expectedRevision: 4 },
    expiresAt: overrides.expiresAt ?? future()
  });
}

function syntheticWrite(database, label) {
  const result = database.prepare('INSERT INTO synthetic_execution_writes(label) VALUES (?)').run(label);
  return {
    data: { id: Number(result.lastInsertRowid), label },
    entityType: 'synthetic_execution_write',
    entityId: String(result.lastInsertRowid),
    afterRevision: 1,
    readback: { label }
  };
}

async function assertRejectedWrite(runtime, database, envelope, code, expectedCount) {
  const receipt = await runtime.dispatchCommand(envelope, () => syntheticWrite(database, `forbidden-${code}`));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, code);
  assert.equal(receipt.sideEffectState, 'not_started');
  assert.equal(writeCount(database), expectedCount);
}

function writeCount(database) {
  return database.prepare('SELECT COUNT(*) AS count FROM synthetic_execution_writes').get().count;
}

async function withRuntime(prefix, epoch, work, options = {}) {
  const opened = await openRuntime(prefix, epoch, options);
  try { await work(opened); }
  finally { await closeRuntime(opened); }
}

async function openRuntime(prefix, epoch, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const fixtureId = prefix.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const workspaceId = `workspace-${fixtureId}`;
  const taskId = `task-${fixtureId}`;
  const now = '2026-08-05T00:00:00.000Z';
  database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(workspaceId, now, now);
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  database.exec('CREATE TABLE synthetic_execution_writes (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  seedAgentTask(database, { taskId, workspaceId, now });
  const seeded = options.seed?.({ database, root, workspaceId, taskId, epoch }) ?? {};
  database.close();
  const runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => epoch });
  return { root, runtime, database: runtime.database, taskId, ...seeded };
}

function seedAgentTask(database, { taskId, workspaceId, now }) {
  database.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at, error_code, error_message,
    created_at, updated_at, finished_at
  ) VALUES (?, 'daily_intelligence', '2026-08-05', 'running', 'starting', ?, ?, '{}', '{}', '{}', '[]', ?, NULL, NULL, ?, ?, NULL)`)
    .run(taskId, `daily-2026-08-05-${taskId}`, JSON.stringify({ workspaceId, ownerGoal: '执行已确认操作' }), now, now, now);
}

function seedExecutionGrant(database, input) {
  const target = createCommandEnvelope({
    workspaceId: input.workspaceId,
    runtimeEpoch: input.hashEpoch,
    command: 'intelligence_channels.proposal_apply',
    requestId: `seed-${input.id}`,
    input: websiteInput,
    boundIdentity: websiteIdentity,
    actor: owner
  });
  database.prepare(`INSERT INTO execution_grants (
    id, workspace_id, runtime_epoch, task_id, task_grant_id, command, input_hash,
    bound_identity_json, target_actor_type, target_actor_id, browser_profile_id,
    binding_revision, expected_account, allowed_transition, required_readback_json,
    status, issued_at, expires_at, consumed_at, revoked_at, revision
  ) VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,NULL,NULL,1)`)
    .run(input.id, input.workspaceId, input.runtimeEpoch, target.command, target.inputHash,
      JSON.stringify(websiteIdentity), owner.type, owner.id, 'profile-1', 7, '@owner',
      'prepared_to_applied', JSON.stringify({ proposalStatus: 'applied', expectedRevision: 4 }),
      '2026-08-05T00:00:00.000Z', input.expiresAt);
}

async function closeRuntime(opened) {
  if (opened.runtime?.isActive) await opened.runtime.stop({ drain: false }).catch(() => {});
  await rm(opened.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
