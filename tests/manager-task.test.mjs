import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner, setActiveJobSpawner } from '../src/main/job-spawner.ts';
import { dispatchReportAgentTaskProgress, dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import { cancelManagerDailyIntelligence } from '../src/main/manager-dispatch.ts';
import {
  createManagerTaskCheckpoint,
  managerTaskSerialDecision,
  buildManagerTaskCardText,
  MANAGER_TASK_INTENT
} from '../src/main/manager-task.ts';

test('serial decision focuses existing running manager task', () => {
  const checkpoint = createManagerTaskCheckpoint({
    businessDate: '2026-08-08',
    status: 'running',
    phase: 'monitor_reporter',
    summary: '记者扫描中'
  });
  const active = {
    id: 'm1',
    intent: MANAGER_TASK_INTENT,
    businessDate: '2026-08-08',
    status: 'running',
    phase: 'monitor_reporter',
    progress: {},
    checkpoint,
    errorCode: null,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  const d = managerTaskSerialDecision(active);
  assert.equal(d.action, 'focus_existing');
  assert.equal(d.active?.id, 'm1');
});

test('serial decision creates when none', () => {
  const d = managerTaskSerialDecision(null);
  assert.equal(d.action, 'create');
});

test('manager card text includes approval hint', () => {
  const checkpoint = createManagerTaskCheckpoint({ businessDate: '2026-08-08', status: 'waiting_human', phase: 'report' });
  const text = buildManagerTaskCardText({
    id: 'abcdef12-xxxx',
    intent: MANAGER_TASK_INTENT,
    businessDate: '2026-08-08',
    status: 'waiting_human',
    phase: 'report',
    progress: {},
    checkpoint,

    errorCode: null,
    errorMessage: null,
    updatedAt: '',
    createdAt: ''
  });
  assert.match(text, /主管/);
  assert.match(text, /今日情报/);
  assert.match(text, /批准/);
});
const OWNER_ACTOR = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const SCHEDULER_ACTOR = { type: 'scheduler', id: 'manager-test', label: 'manager-test' };

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for manager cancellation fixture');
}

async function withRuntime(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-manager-task-'));
  const seed = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  seed.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', 'ws-manager-task', ?, ?, 1)`).run(now, now);
  seed.close();
  const runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'manager-task-test' });
  try {
    await run(runtime);
  } finally {
    setActiveJobSpawner(null);
    await runtime.stop({ drain: false }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('running manager cancel propagates to a live child before terminal transition', async () => {
  await withRuntime(async (runtime) => {
    const businessDate = '2026-08-08';
    const manager = (await dispatchStartAgentTask(runtime, {
      intent: MANAGER_TASK_INTENT,
      businessDate,
      contextRefs: { workspaceId: runtime.identity.workspaceId, managerDataRef: 'live-manager-1' }
    }, { actor: OWNER_ACTOR, requestId: 'manager-live-start' })).task;
    let childTaskId = null;
    const spawner = new JobSpawner(runtime, {
      maxWorkers: 1,
      execute: async ({ onTaskBound, signal }) => {
        const child = await dispatchStartAgentTask(runtime, {
          intent: 'page_topic',
          businessDate,
          contextRefs: { workspaceId: runtime.identity.workspaceId, childDataRef: 'live-child-1' }
        }, { actor: SCHEDULER_ACTOR, requestId: 'manager-live-child-start' });
        childTaskId = child.task.id;
        onTaskBound(child.task.id, null);
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
        return { status: 'succeeded', code: 'OK', message: null, readback: null };
      }
    });
    setActiveJobSpawner(spawner);
    const job = spawner.spawn({ roleId: 'reporter', brief: '重启后仍在运行的记者', businessDate });
    await waitFor(() => spawner.get(job.id)?.status === 'running' && childTaskId !== null);

    const checkpoint = createManagerTaskCheckpoint({
      businessDate,
      status: 'running',
      phase: 'monitor_reporter',
      summary: '记者扫描中',
      children: [{ roleId: 'reporter', brief: '重启后仍在运行的记者', jobId: job.id, taskId: childTaskId, status: 'running' }]
    });
    await dispatchReportAgentTaskProgress(runtime, manager.id, {
      phase: checkpoint.phase,
      checkpoint,
      progress: { message: checkpoint.summary }
    }, { actor: SCHEDULER_ACTOR, requestId: 'manager-live-progress', taskId: manager.id });

    const cancelled = await cancelManagerDailyIntelligence(runtime, manager.id, {
      actor: OWNER_ACTOR,
      requestId: 'manager-live-cancel',
      taskId: manager.id
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(spawner.get(job.id)?.status, 'cancelled');
    assert.equal(getAgentTask(runtime.database, childTaskId)?.status, 'cancelled');
    assert.equal(cancelled.checkpoint.status, 'cancelled');
    assert.equal(cancelled.checkpoint.phase, 'done');
    assert.equal(cancelled.checkpoint.children[0].status, 'cancelled');
    assert.equal(cancelled.contextRefs.managerDataRef, 'live-manager-1');
    assert.equal(getAgentTask(runtime.database, childTaskId)?.contextRefs.childDataRef, 'live-child-1');

    const again = await cancelManagerDailyIntelligence(runtime, manager.id, {
      actor: OWNER_ACTOR,
      requestId: 'manager-live-cancel-again',
      taskId: manager.id
    });
    assert.deepEqual(again, cancelled);
  });
});
