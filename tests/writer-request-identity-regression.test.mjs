import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { dispatchStartAgentTask, dispatchCompleteAgentTask, dispatchReportAgentTaskProgress } from '../src/main/agent-task-commands.ts';
import { agentRequestId } from '../src/main/agent-tasks.ts';
import { dispatchBusinessCommand } from '../src/main/business-command.ts';
import { createContentProject, getContentProject, saveCoreVersion } from '../src/main/content.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureAutomaticTaskGrant } from '../src/main/task-grants.ts';
import { reportAgentTaskProgress } from '../src/main/agent-tasks.ts';

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)").run('workspace_id', 'ws-writer-replay', now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

const withRuntimeAndProject = async (title, fn) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-writer-replay-'));
  const setupDb = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  setupDb.prepare("INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)").run('workspace_id', 'ws-writer-replay', now, now);
  const project = createContentProject(setupDb, { title });
  setupDb.close();
  const runtime = openRuntime(directory);
  try { return await fn(runtime, project.id); } finally { await runtime.stop({ drain: false }).catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
};

test('WMB-5355 writer resumed save then complete must not REQUEST_REPLAY_CONFLICT (command-scoped ids)', async () => {
  await withRuntimeAndProject('regression project', async (runtime, projectId) => {
    const businessDate = '2026-08-23';
    const jobId = `b1aae4ad-0b35-4599-9492-52593b141f19`;
    const startRequestId = `${jobId}:studio-draft:start`;
    const lease = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const start = await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft',
      businessDate,
      contextRefs: { roleId: 'writer', projectId, writerTask: 'core_draft', researchGate: 'satisfied', researchMode: 'auto', workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId: startRequestId, workerLeaseId: lease.leaseId });
    const taskId = start.task.id;
    runtime.bindWorkerTask(lease, taskId);
    const grantId = await ensureAutomaticTaskGrant(runtime, taskId, new Date(), 'writer');
    const workerLeaseId = lease.leaseId;

    const coreRequestId = agentRequestId(taskId, 'core_version');
    const body = 'regression body for writer replay fix ' + taskId;
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId: coreRequestId,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId,
      workerLeaseId,
      grantId,
      input: { projectId, expectedRevision: 1, body, title: 'regression title' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const r = saveCoreVersion(db, { projectId, expectedRevision: 1, body, title: 'regression title' }, false);
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    });
    assert.equal(receipt.ok, true, 'core_version save must succeed');

    const replay = await dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId: coreRequestId,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId,
      workerLeaseId,
      grantId,
      input: { projectId, expectedRevision: 1, body, title: 'regression title' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const r = saveCoreVersion(db, { projectId, expectedRevision: 1, body, title: 'regression title' }, false);
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    });
    assert.equal(replay.ok, true, 'same-input replay must be idempotent');
    assert.equal(replay.receiptId, receipt.receiptId, 'replay must return same receipt');

    await assert.rejects(() => dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId: coreRequestId,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId,
      workerLeaseId,
      grantId,
      input: { projectId, expectedRevision: 1, body: 'DIFFERENT BODY to trigger conflict', title: 'different' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const r = saveCoreVersion(db, { projectId, expectedRevision: 1, body: 'DIFFERENT BODY to trigger conflict', title: 'different' }, false);
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    }), (e) => e.code === 'REQUEST_REPLAY_CONFLICT');

    const piReportId = `${taskId}:complete`;
    const piProgress = await dispatchReportAgentTaskProgress(runtime, taskId, { phase: 'completed', message: '已保存核心正文' }, { actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId: piReportId, taskId, workerLeaseId });
    assert.equal(piProgress.phase, 'completed', 'Pi report_progress :complete must succeed');

    const runnerCompleteId = `${taskId}:task:complete`;
    const completed = await dispatchCompleteAgentTask(runtime, taskId, { actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId: runnerCompleteId, taskId, workerLeaseId });
    assert.equal(completed.status, 'succeeded', 'Writer task must reach succeeded after save success without REQUEST_REPLAY_CONFLICT');

    const secondComplete = await dispatchCompleteAgentTask(runtime, taskId, { actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId: runnerCompleteId, taskId, workerLeaseId });
    assert.ok(secondComplete, 'replay of same task:complete should not throw conflict');

    const lease2 = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const secondTask = (await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft',
      businessDate,
      contextRefs: { roleId: 'writer', projectId, writerTask: 'core_draft', researchGate: 'satisfied', researchMode: 'auto', workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId: `second:${Date.now()}:start`, workerLeaseId: lease2.leaseId })).task;
    runtime.bindWorkerTask(lease2, secondTask.id);
    const grant2Id = await ensureAutomaticTaskGrant(runtime, secondTask.id, new Date(), 'writer');
    const conflictId = `${secondTask.id}:task:complete`;
    const cur = getContentProject(runtime.database, projectId);
    const rev = cur ? cur.revision : 1;
    await dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId: agentRequestId(secondTask.id, 'core_version'),
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId: secondTask.id,
      workerLeaseId: lease2.leaseId,
      grantId: grant2Id,
      input: { projectId, expectedRevision: rev, body: 'second task body ' + secondTask.id, title: 'second title' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const c = getContentProject(db, projectId);
        const r2 = saveCoreVersion(db, { projectId, expectedRevision: c ? c.revision : 1, body: 'second task body ' + secondTask.id, title: 'second title' }, false);
        if (!r2.ok) throw Object.assign(new Error(r2.error.message), { code: r2.error.code });
        return { data: r2.data, entityId: r2.data.id };
      }
    });
    // Verify command-scoped id is distinct from Pi's :complete – dispatcher will treat same id with different command as conflict only if already bound
    // Here we verify that the new :task:complete id is not yet bound, so a report_progress with same id would succeed (not conflict), proving ids are distinct per command
    const conflictCheck = await dispatchBusinessCommand(runtime, {
      command: 'agent_tasks.report_progress',
      requestId: conflictId,
      actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' },
      taskId: secondTask.id,
      workerLeaseId: lease2.leaseId,
      input: { phase: 'test' },
      boundIdentity: { taskId: secondTask.id },
      entityType: 'agent_task',
      execute: (db) => {
        const r = reportAgentTaskProgress(db, secondTask.id, { phase: 'test' });
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    });
    assert.equal(conflictCheck.ok, true, 'report_progress with fresh :task:complete id should succeed (proving no prior binding)');
    runtime.releaseWorker(lease);
    runtime.releaseWorker(lease2);
  });
});

test('writer core_version stable idempotent and conflicting-input rejected at dispatcher boundary', async () => {
  await withRuntimeAndProject('stable id test', async (runtime, projectId) => {
    const lease = runtime.acquireWorkerLease(null, 'writer', 'employee');
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft',
      businessDate: '2026-08-23',
      contextRefs: { roleId: 'writer', projectId, writerTask: 'core_draft', researchGate: 'satisfied', workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'scheduler', id: 'studio-draft', label: 'studio-draft' }, requestId: `stable-test:${Date.now()}`, workerLeaseId: lease.leaseId })).task;
    runtime.bindWorkerTask(lease, task.id);
    const grantId2 = await ensureAutomaticTaskGrant(runtime, task.id, new Date(), 'writer');
    const requestId = agentRequestId(task.id, 'core_version');
    const first = await dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId: task.id,
      workerLeaseId: lease.leaseId,
      grantId: grantId2,
      input: { projectId, expectedRevision: 1, body: 'stable body', title: 't' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const r = saveCoreVersion(db, { projectId, expectedRevision: 1, body: 'stable body', title: 't' }, false);
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    });
    assert.equal(first.ok, true);
    const second = await dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId: task.id,
      workerLeaseId: lease.leaseId,
      grantId: grantId2,
      input: { projectId, expectedRevision: 1, body: 'stable body', title: 't' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const r = saveCoreVersion(db, { projectId, expectedRevision: 1, body: 'stable body', title: 't' }, false);
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    });
    assert.equal(second.ok, true);
    assert.equal(second.receiptId, first.receiptId, 'same input must replay same receipt');
    await assert.rejects(() => dispatchBusinessCommand(runtime, {
      command: 'content.save_version',
      requestId,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId: task.id,
      workerLeaseId: lease.leaseId,
      grantId: grantId2,
      input: { projectId, expectedRevision: 1, body: 'different body', title: 't2' },
      boundIdentity: { projectId },
      entityType: 'content_version',
      execute: (db) => {
        const r = saveCoreVersion(db, { projectId, expectedRevision: 1, body: 'different body', title: 't2' }, false);
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return { data: r.data, entityId: r.data.id };
      }
    }), (e) => e.code === 'REQUEST_REPLAY_CONFLICT');
    runtime.releaseWorker(lease);
  });
});
