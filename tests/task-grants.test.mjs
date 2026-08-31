import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dispatchCancelAgentTask, dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { dispatchSourceUpsertBatch } from '../src/main/source-commands.ts';
import { AUTOMATIC_TASK_GRANT_EXPIRY_MS, ensureAutomaticTaskGrant, dispatchIssueTaskGrant, dispatchRevokeTaskGrant, getTaskGrant, TASK_INTERNAL_COMMANDS } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const expiry = () => new Date(Date.now() + 60_000).toISOString();

test('task grants expose the canonical internal business command IDs', () => {
  assert.deepEqual([...TASK_INTERNAL_COMMANDS], [
    'agent_tasks.report_progress',
    'content.create',
    'content.save_version',
    'content_derivative.ensure',
    'content_derivative.save_version',
    'content_derivative.finalize_version',
    'daily_content_cycle.ensure',
    'daily_content_cycle.pause',
    'daily_content_cycle.resume',
    'daily_content_target.carry',
    'daily_content_target.replace',
    'daily_content_target.select',
    'daily_content_target.skip',
    'daily_content_target.transition',
    'daily_iteration.draft_ensure',
    'daily_iteration.published_ensure',
    'daily_iteration.projection',
    'daily_iteration.version_create',
    'intelligence.zhihu_hot.scan',
    'intelligence_channels.proposal_apply',
    'intelligence_channels.proposal_apply_safe',
    'investigation.direction_save',
    'investigation.outline_save',
    'investigation.review_research',
    'knowledge.creative_brief_create',
    'knowledge.creative_brief_create_project',
    'knowledge.creative_brief_update',
    'knowledge.domain_create',
    'knowledge.domain_update',
    'knowledge.lint',
    'knowledge.maintenance',
    'knowledge.record_batch',
    'knowledge.topic_maintenance_approve',
    'knowledge.topic_maintenance_propose',
    'knowledge.topic_maintenance_reject',
    'knowledge.topic_maintenance_reproposal_retry',
    'knowledge.suggestion_create',
    'knowledge_flywheel.change_set_apply',
    'media.recommendations_generate',
    'plan_item.advance',
    'plan_item.approve',
    'plan_item.reject',
    'plan_item.request_planning',
    'plan_item.rework',
    'plan_item.submit',
    'plans.save',
    'publication.snapshot_create',
    'reviews.save',
    'sources.lane_gate',
    'sources.lane_restore',
    'sources.update_status',
    'sources.upsert_batch',
    'x_lists.observation_start',
    'x_lists.observation_stop',
    'x_lists.operation_execute',
    'x_lists.prepare'
  ]);
});
test('ordinary Pi chat grants (page_today/page_studio) are legally issued and unregistered commands are still rejected', async () => {
  await withRuntime(async ({ runtime }) => {
    // Ordinary chat on Today page: desk role should get a legal grant (deskStanding now includes media)
    const todayTask = (await dispatchStartAgentTask(runtime, {
      intent: 'page_today',
      businessDate: '2026-08-23',
      contextRefs: { workspaceId: runtime.identity.workspaceId, page: 'today', roleId: 'desk' }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'ordinary-chat-today-task' })).task;
    assert.equal(todayTask.status, 'running');
    const todayGrantId = await ensureAutomaticTaskGrant(runtime, todayTask.id, new Date(), 'desk');
    const todayGrant = getTaskGrant(runtime.database, todayGrantId);
    assert.equal(todayGrant.status, 'active');
    // Today grant must be subset of TASK_INTERNAL and contain core page_today commands
    for (const cmd of todayGrant.allowedCommands) assert.ok(TASK_INTERNAL_COMMANDS.includes(cmd), `today grant contains unregistered ${cmd}`);
    assert.ok(todayGrant.allowedCommands.includes('sources.upsert_batch'));
    assert.ok(todayGrant.allowedCommands.includes('plans.save'));
    // Studio page grant should include media.recommendations_generate (now grantable via cap.write)
    const studioTask = (await dispatchStartAgentTask(runtime, {
      intent: 'page_studio',
      businessDate: '2026-08-23',
      contextRefs: { workspaceId: runtime.identity.workspaceId, page: 'studio', roleId: 'desk' }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'ordinary-chat-studio-task' })).task;
    const studioGrantId = await ensureAutomaticTaskGrant(runtime, studioTask.id, new Date(), 'desk');
    const studioGrant = getTaskGrant(runtime.database, studioGrantId);
    assert.equal(studioGrant.status, 'active');
    assert.ok(studioGrant.allowedCommands.includes('media.recommendations_generate'), 'studio desk grant must include media.recommendations_generate');
    assert.ok(studioGrant.allowedCommands.includes('content.save_version'));
    for (const cmd of studioGrant.allowedCommands) assert.ok(TASK_INTERNAL_COMMANDS.includes(cmd));
    // Unregistered commands must still be rejected (use fresh task to avoid TASK_GRANT_EXISTS masking)
    const probeTask = (await dispatchStartAgentTask(runtime, {
      intent: 'page_today',
      businessDate: '2026-08-23',
      contextRefs: { workspaceId: runtime.identity.workspaceId, page: 'today', roleId: 'desk' }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'ordinary-chat-probe-task' })).task;
    let threwBroadened = false;
    try {
      await dispatchIssueTaskGrant(runtime, {
        requestId: 'grant-unregistered',
        taskId: probeTask.id,
        ownerGoal: 'probe unregistered',
        allowedCommands: ['not.a.real.command'],
        workers: [{ type: 'pi', id: 'pi' }],
        relevantContext: {},
        expiresAt: expiry()
      });
    } catch (error) {
      threwBroadened = error?.code === 'TASK_SCOPE_BROADENED';
    }
    assert.equal(threwBroadened, true, 'unregistered command must be rejected with TASK_SCOPE_BROADENED');
    let threwMixed = false;
    try {
      await dispatchIssueTaskGrant(runtime, {
        requestId: 'grant-mixed',
        taskId: probeTask.id,
        ownerGoal: 'probe mixed',
        allowedCommands: ['sources.upsert_batch', 'fake.invalid_command'],
        workers: [{ type: 'pi', id: 'pi' }],
        relevantContext: {},
        expiresAt: expiry()
      });
    } catch (error) {
      threwMixed = error?.code === 'TASK_SCOPE_BROADENED';
    }
    assert.equal(threwMixed, true, 'mixed valid+fake must be rejected');
  });
});


test('Pi and an external Agent continue one task under a durable grant while stale authority writes zero', async () => {
  await withRuntime(async ({ root, runtime, database }) => {
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'daily_intelligence', businessDate: '2026-08-05',
      contextRefs: { workspaceId: runtime.identity.workspaceId, ownerGoal: '沉淀今日研究资料' }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'task-start-grant-continuation' })).task;
    assert.equal(task.status, 'running');
    const issued = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-issue', taskId: task.id, ownerGoal: '沉淀今日研究资料',
      allowedCommands: ['sources.upsert_batch'],
      workers: [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }],
      relevantContext: { businessDate: '2026-08-05', sourceRevision: 0 }, expiresAt: expiry()
    });
    assert.equal(issued.ok, true);
    assert.equal(issued.data.status, 'active');

    const lease = runtime.acquireWorkerLease(task.id);
    runtime.bindWorker(lease, { stop() {} });
    const piReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'pi-source', actor: { type: 'pi', id: 'pi' }, taskId: task.id,
      workerLeaseId: lease.leaseId, grantId: issued.data.id,
      items: [{ title: 'Pi persisted fact', originalUrl: 'https://example.com/pi-fact' }]
    });
    assert.equal(piReceipt.ok, true);
    assert.equal(piReceipt.actor.type, 'pi');

    const externalReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'external-source', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id,
      grantId: issued.data.id,
      items: [{ title: 'External continuation fact', originalUrl: 'https://example.com/external-fact' }]
    });
    assert.equal(externalReceipt.ok, true);
    assert.equal(externalReceipt.taskId, task.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 2);

    const revoked = await dispatchRevokeTaskGrant(runtime, {
      requestId: 'grant-revoke', grantId: issued.data.id, expectedRevision: 1
    });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.data.status, 'revoked');
    const replay = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'pi-source', actor: { type: 'pi', id: 'pi' }, taskId: task.id,
      workerLeaseId: lease.leaseId, grantId: issued.data.id,
      items: [{ title: 'Pi persisted fact', originalUrl: 'https://example.com/pi-fact' }]
    });
    assert.deepEqual(replay, piReceipt);
    await rejectsCode(() => dispatchSourceUpsertBatch(runtime, {
      requestId: 'pi-source', actor: { type: 'pi', id: 'pi' }, taskId: task.id,
      workerLeaseId: lease.leaseId, grantId: issued.data.id,
      items: [{ title: 'Changed after revoke', originalUrl: 'https://example.com/pi-fact' }]
    }), 'REQUEST_REPLAY_CONFLICT');
    const afterRevoke = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'after-revoke', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id,
      grantId: issued.data.id, items: [{ title: 'Rejected', originalUrl: 'https://example.com/rejected' }]
    });
    assertReceiptError(afterRevoke, 'TASK_GRANT_REVOKED');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 2);

    runtime.releaseWorker(lease);
    await runtime.stop({ drain: false });
    const reopened = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-restarted' });
    try {
      assert.deepEqual(reopened.database.prepare('SELECT title FROM source_items ORDER BY title').all().map((row) => row.title), ['External continuation fact', 'Pi persisted fact']);
      assert.equal(getTaskGrant(reopened.database, issued.data.id)?.status, 'revoked');
      const staleRuntime = await dispatchSourceUpsertBatch(reopened, {
        requestId: 'stale-runtime', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id,
        grantId: issued.data.id, items: [{ title: 'Stale', originalUrl: 'https://example.com/stale' }]
      });
      assertReceiptError(staleRuntime, 'TASK_GRANT_STALE');
      assert.equal(reopened.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 2);
    } finally { await reopened.stop({ drain: false }); }
    return false;
  });
});

test('missing, expired, broadened and stale-worker grants reject with zero domain write while Owner UI needs no task grant', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const ownerReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'owner-write', actor: { type: 'owner_ui', id: 'renderer' },
      items: [{ title: 'Owner fact', originalUrl: 'https://example.com/owner' }]
    });
    assert.equal(ownerReceipt.ok, true);
    const task = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-05', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'task-start-grant-rejections' })).task;
    assert.equal(task.status, 'running');
    const baseline = sourceCount(database);

    const missingGrant = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'missing-grant', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id,
      items: [{ title: 'Missing', originalUrl: 'https://example.com/missing' }]
    });
    assertReceiptError(missingGrant, 'TASK_GRANT_REQUIRED');

    const issued = await dispatchIssueTaskGrant(runtime, {
      requestId: 'expiring-grant', taskId: task.id, ownerGoal: '测试过期授权', allowedCommands: ['sources.upsert_batch'],
      workers: [{ type: 'external_agent', id: 'mcp' }, { type: 'pi', id: 'pi' }], expiresAt: expiry()
    });
    const expireEnvelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'test.task_grants.expire',
      requestId: 'expire-grant-fixture',
      input: { grantId: issued.data.id },
      boundIdentity: { grantId: issued.data.id },
      actor: { type: 'owner_ui', id: 'renderer' }
    });
    const expiredFixture = await runtime.dispatchCommand(expireEnvelope, () => {
      database.prepare("UPDATE task_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(issued.data.id);
      return { data: { grantId: issued.data.id }, entityType: 'task_grant', entityId: issued.data.id };
    });
    assert.equal(expiredFixture.ok, true);
    const expiredGrant = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'expired-grant', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id, grantId: issued.data.id,
      items: [{ title: 'Expired', originalUrl: 'https://example.com/expired' }]
    });
    assertReceiptError(expiredGrant, 'TASK_GRANT_EXPIRED');

    const piGrant = await dispatchIssueTaskGrant(runtime, {
      requestId: 'pi-grant', taskId: task.id, ownerGoal: '测试 Pi 租约', allowedCommands: ['sources.upsert_batch'],
      workers: [{ type: 'pi', id: 'pi' }], expiresAt: expiry()
    });
    const duplicateGrant = await dispatchIssueTaskGrant(runtime, {
      requestId: 'duplicate-grant', taskId: task.id, ownerGoal: '重复授权', allowedCommands: ['sources.upsert_batch'],
      workers: [{ type: 'external_agent', id: 'mcp' }], expiresAt: expiry()
    });
    assert.equal(duplicateGrant.ok, false);
    assert.equal(duplicateGrant.error.code, 'TASK_GRANT_EXISTS');
    const wrongWorker = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'wrong-worker', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id,
      grantId: piGrant.data.id, items: [{ title: 'Wrong worker', originalUrl: 'https://example.com/wrong-worker' }]
    });
    assertReceiptError(wrongWorker, 'TASK_WORKER_MISMATCH');
    const lease = runtime.acquireWorkerLease(task.id);
    runtime.bindWorker(lease, { stop() {} });
    const staleWorker = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'stale-worker', actor: { type: 'pi', id: 'pi' }, taskId: task.id,
      workerLeaseId: 'not-current', grantId: piGrant.data.id,
      items: [{ title: 'Stale worker', originalUrl: 'https://example.com/stale-worker' }]
    });
    assertReceiptError(staleWorker, 'WORKER_LEASE_STALE');
    runtime.releaseWorker(lease);

    const grantCount = database.prepare('SELECT COUNT(*) AS count FROM task_grants').get().count;
    await rejectsCode(() => dispatchIssueTaskGrant(runtime, {
      requestId: 'broadened-grant', taskId: task.id, ownerGoal: '越权', allowedCommands: ['x_lists.create'],
      workers: [{ type: 'external_agent', id: 'mcp' }], expiresAt: expiry()
    }), 'TASK_SCOPE_BROADENED');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_grants').get().count, grantCount);
    assert.equal(sourceCount(database), baseline);
  });
});

test('a grant from another root authorizes zero writes', async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'wmb-task-grant-a-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'wmb-task-grant-b-'));
  const first = openFreshRuntime(firstRoot, 'epoch-a');
  const second = openFreshRuntime(secondRoot, 'epoch-b');
  try {
    const task = (await dispatchStartAgentTask(first, { intent: 'daily_intelligence', businessDate: '2026-08-05', contextRefs: { workspaceId: first.identity.workspaceId } }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'task-start-cross-root' })).task;
    assert.equal(task.status, 'running');
    const grant = await dispatchIssueTaskGrant(first, {
      requestId: 'cross-root-grant', taskId: task.id, ownerGoal: '仅限 A root', allowedCommands: ['sources.upsert_batch'],
      workers: [{ type: 'external_agent', id: 'mcp' }], expiresAt: expiry()
    });
    assert.equal(getTaskGrant(first.database, grant.data.id, new Date(), second.identity)?.status, 'stale');
    const crossRoot = await dispatchSourceUpsertBatch(second, {
      requestId: 'cross-root-write', actor: { type: 'external_agent', id: 'mcp' }, taskId: task.id, grantId: grant.data.id,
      items: [{ title: 'Must stay out', originalUrl: 'https://example.com/cross-root' }]
    });
    assertReceiptError(crossRoot, 'TASK_GRANT_NOT_FOUND');
    assert.equal(sourceCount(second.database), 0);
  } finally {
    await first.stop({ drain: false });
    await second.stop({ drain: false });
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('ensureAutomaticTaskGrant issues exact least-privilege scope per intent for pi and external workers', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const expectedByIntent = {
      daily_intelligence: ['agent_tasks.report_progress', 'knowledge.record_batch', 'knowledge.suggestion_create', 'plan_item.request_planning', 'plan_item.submit', 'plans.save', 'sources.upsert_batch', 'sources.lane_gate'],
      studio_draft: ['agent_tasks.report_progress', 'content.save_version', 'content_derivative.ensure', 'content_derivative.save_version', 'content_derivative.finalize_version'],
      results_review: ['agent_tasks.report_progress', 'knowledge.record_batch', 'reviews.save']
    };
    for (const [intent, expected] of Object.entries(expectedByIntent)) {
      const task = (await dispatchStartAgentTask(runtime, {
        intent, businessDate: '2026-08-05', contextRefs: { workspaceId: runtime.identity.workspaceId }
      }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: `auto-scope-${intent}` })).task;
      assert.equal(task.status, 'running');
      const grantId = await ensureAutomaticTaskGrant(runtime, task.id);
      const grant = getTaskGrant(runtime.database, grantId);
      assert.equal(grant.status, 'active');
      assert.deepEqual([...grant.allowedCommands].sort(), [...expected].sort());
      assert.deepEqual([...grant.workers], [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }]);
      assert.equal(grant.relevantContext.automatic, true);
      assert.ok(grant.allowedCommands.every((command) => !command.startsWith('intelligence_channels.') && !command.startsWith('x_lists.')));
      assert.ok(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) >= AUTOMATIC_TASK_GRANT_EXPIRY_MS - 60_000);
    }
  });
});

test('ensureAutomaticTaskGrant reuses an active exact-scope grant and rejects inactive tasks', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'daily_intelligence', businessDate: '2026-08-05', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'auto-reuse-task' })).task;
    const first = await ensureAutomaticTaskGrant(runtime, task.id);
    const second = await ensureAutomaticTaskGrant(runtime, task.id);
    assert.equal(first, second);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_grants WHERE task_id=? AND status='active'").get(task.id).count, 1);

    await rejectsCode(() => ensureAutomaticTaskGrant(runtime, 'missing-task-id'), 'TASK_NOT_ACTIVE');
    await dispatchCancelAgentTask(runtime, task.id, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'auto-cancel-task' });
    await rejectsCode(() => ensureAutomaticTaskGrant(runtime, task.id), 'TASK_NOT_ACTIVE');
  });
});

test('ensureAutomaticTaskGrant revokes and replaces an active mismatched grant', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'results_review', businessDate: '2026-08-05', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'auto-replace-task' })).task;
    const mismatched = await dispatchIssueTaskGrant(runtime, {
      requestId: 'mismatched-grant', taskId: task.id, ownerGoal: '手动越权授权',
      allowedCommands: ['agent_tasks.report_progress', 'reviews.save', 'knowledge.record_batch', 'content.create'],
      workers: [{ type: 'pi', id: 'pi' }], expiresAt: expiry()
    });
    assert.equal(mismatched.ok, true);
    const grantId = await ensureAutomaticTaskGrant(runtime, task.id);
    assert.notEqual(grantId, mismatched.data.id);
    assert.equal(getTaskGrant(runtime.database, mismatched.data.id).status, 'revoked');
    const grant = getTaskGrant(runtime.database, grantId);
    assert.deepEqual([...grant.allowedCommands].sort(), ['agent_tasks.report_progress', 'knowledge.record_batch', 'reviews.save']);
    assert.deepEqual([...grant.workers], [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_grants WHERE task_id=? AND status='active'").get(task.id).count, 1);
  });
});

async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-task-grant-'));
  let runtime;
  try {
    runtime = openFreshRuntime(root, 'runtime-current');
    const shouldStop = await work({ root, runtime, database: runtime.database });
    if (shouldStop !== false) await runtime.stop({ drain: false });
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function openFreshRuntime(root, epoch) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  database.close();
  return ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => epoch });
}

async function rejectsCode(work, code) {
  await assert.rejects(Promise.resolve().then(work), (error) => error?.code === code);
}
function assertReceiptError(receipt, code) {
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, code);
  assert.equal(receipt.sideEffectState, 'not_started');
}


function sourceCount(database) {
  return database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count;
}
