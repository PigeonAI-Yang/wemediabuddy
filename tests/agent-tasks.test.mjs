import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { createContentProject, saveCoreVersion } from '../src/main/content.ts';
import {
  agentRequestId,
  cancelAgentTask,
  completeAgentTask,
  failAgentTask,
  getActiveAgentTask,
  recoverInterruptedAgentTasks,
  reportAgentTaskProgress,
  startAgentTask,
  updateAgentTaskPhase
} from '../src/main/agent-tasks.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-agent-tasks-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('agent tasks reuse one running intent/date and mint stable request ids', async () => {
  await withDb((database) => {
    const first = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-07-28' });
    assert.equal(first.ok, true);
    const second = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-07-28' });
    assert.equal(second.ok, true);
    assert.equal(second.data.id, first.data.id);
    assert.equal(getActiveAgentTask(database, 'daily_intelligence', '2026-07-28')?.id, first.data.id);
    assert.equal(agentRequestId(first.data.id, 'sources'), `${first.data.id}:sources`);
    assert.equal(agentRequestId(first.data.id, 'plan'), `${first.data.id}:plan`);
  });
});

test('agent task completion requires business object readback', async () => {
  await withDb((database) => {
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
      VALUES ('workspace_id', 'workspace-agent-task', ?, ?, 1)`).run(now, now);
    const website = createWebsiteSource(database, {
      inputText: 'https://example.com/agent-task', name: 'Agent task website', canonicalUrl: 'https://example.com/agent-task', resolutionStatus: 'ready',
      trialRead: { title: 'Agent task website', url: 'https://example.com/agent-task', readable: true, summary: 'Readable source for the task completion receipt.' }
    });
    const started = startAgentTask(database, {
      intent: 'daily_intelligence', businessDate: '2026-07-28', contextRefs: {
        workspaceId: 'workspace-agent-task',
        intelligenceChannels: { sources: [{ module: 'official_web', sourceId: website.id, sourceFeedId: website.sourceFeedId, revision: website.revision }] }
      }
    });
    assert.equal(started.ok, true);
    const rejected = completeAgentTask(database, started.data.id);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'VALIDATION_ERROR');
    assert.equal(getActiveAgentTask(database, 'daily_intelligence', '2026-07-28')?.status, 'running');

    const source = upsertSource(database, {
      feedId: website.sourceFeedId,
      title: 'Agent task source',
      originalUrl: 'https://example.com/agent-task-source',
      summary: 'for completion gate',
      categories: ['test'],
      keywords: ['agent'],
      priority: 1,
      clientLabel: 'test'
    });
    saveCurrentPlan(database, {
      planDate: '2026-07-28',
      timezone: 'Asia/Shanghai',
      summary: 'one opportunity',
      items: Array.from({ length: 8 }, (_, priority) => ({
        title: `Opportunity ${priority}`,
        priority,
        whyNow: 'now',
        timeliness: 'today',
        targetAudience: 'builders',
        angle: 'angle',
        pointOfView: 'point',
        platforms: ['x'],
        formats: ['text'],
        titleGuidance: 'title',
        openingGuidance: 'opening',
        structureGuidance: 'structure',
        effortEstimate: '30m',
        sourceIds: [source.id]
      }))
    });
    database.prepare(`INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)`)
      .run('sources.upsert_batch', `${started.data.id}:source:0:0`, JSON.stringify({ data: { id: source.id } }), new Date().toISOString());
    recordSourceScanReceipt(database, {
      taskId: started.data.id, workspaceId: 'workspace-agent-task', module: 'official_web', sourceId: website.id, sourceFeedId: website.sourceFeedId,
      status: 'succeeded', candidateCount: 1, savedCount: 1
    });
    database.prepare(`INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)`)
      .run('plans.save', `${started.data.id}:plan`, '{}', new Date().toISOString());

    updateAgentTaskPhase(database, started.data.id, 'writing_plan');
    const completed = completeAgentTask(database, started.data.id);
    assert.equal(completed.ok, true);
    assert.equal(completed.data.status, 'succeeded');
    assert.equal(Boolean(completed.data.resultRefs.planId), true);
    assert.equal(completed.data.resultRefs.opportunityCount, 8);
    assert.equal(getActiveAgentTask(database, 'daily_intelligence', '2026-07-28'), null);
  });
});

test('running agent tasks become interrupted on recovery and can be cancelled', async () => {
  await withDb((database) => {
    const started = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: '2026-07-28',
      contextRefs: { projectId: 'missing' }
    });
    assert.equal(started.ok, true);
    assert.equal(recoverInterruptedAgentTasks(database), 1);
    const next = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: '2026-07-28',
      contextRefs: { projectId: 'missing' }
    });
    assert.equal(next.ok, true);
    assert.notEqual(next.data.id, started.data.id);

    const project = createContentProject(database, { title: 'Draft project', sourceIds: [] });
    saveCoreVersion(database, { projectId: project.id, body: 'first draft body', expectedRevision: 1 });

    const cancelledStart = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: '2026-07-28',
      contextRefs: { projectId: project.id }
    });
    const cancelled = cancelAgentTask(database, cancelledStart.data.id);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.data.status, 'cancelled');

    const failedStart = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: '2026-07-28',
      contextRefs: { projectId: project.id }
    });
    const failed = failAgentTask(database, failedStart.data.id, 'PI_EXIT', 'Pi exited');
    assert.equal(failed.ok, true);
    assert.equal(failed.data.status, 'failed');

    const ready = startAgentTask(database, {
      intent: 'studio_draft',
      businessDate: '2026-07-28',
      contextRefs: { projectId: project.id }
    });
    const done = completeAgentTask(database, ready.data.id);
    assert.equal(done.ok, true);
    assert.equal(done.data.status, 'succeeded');
    assert.equal(done.data.resultRefs.projectId, project.id);
  });
});

test('daily task persists bounded progress and resumes the same checkpoint', async () => {
  await withDb((database) => {
    const started = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-07-29' });
    const progress = reportAgentTaskProgress(database, started.data.id, {
      phase: 'scanning_sources',
      progress: { planned: 6, processed: 1, failed: 1, currentSource: 'slow source' },
      checkpoint: { completedRoutes: ['slow source'] },
      message: '来源超时，已继续',
      level: 'warning'
    });
    assert.equal(progress.ok, true);
    assert.equal(progress.data.events.length, 1);
    recoverInterruptedAgentTasks(database);
    const resumed = getActiveAgentTask(database, 'daily_intelligence', '2026-07-29');
    assert.equal(resumed.id, started.data.id);
    assert.equal(resumed.phase, 'resume_pending');
    assert.deepEqual(resumed.checkpoint.completedRoutes, ['slow source']);
  });
});
