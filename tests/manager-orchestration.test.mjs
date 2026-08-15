import assert from 'node:assert/strict';
import test from 'node:test';
import { JobSpawner } from '../src/main/job-spawner.ts';
import { pageAuthoritySpec } from '../src/shared/page-authority.ts';

function fakeRuntime() {
  const workers = new Map();
  return {
    identity: { workspaceId: 'ws-test', rootPath: process.cwd() },
    acquireWorkerLease(taskId, roleId, purpose) {
      const lease = { leaseId: `lease-${roleId}-${workers.size}`, taskId, roleId, purpose };
      workers.set(lease.leaseId, lease);
      return lease;
    },
    bindWorker() {},
    bindWorkerTask(lease, taskId) { lease.taskId = taskId; },
    releaseWorker(lease) { workers.delete(lease.leaseId); },
    getWorkerSnapshots() {
      return [...workers.values()].map((w) => ({
        leaseId: w.leaseId, taskId: w.taskId ?? null, roleId: w.roleId ?? null, purpose: w.purpose
      }));
    },
    getWorkerSnapshot() {
      return [...workers.values()].find((w) => w.purpose === 'desk') ?? null;
    },
    // agent task commands need database path — spawner default execute may still call dispatch*
    database: null
  };
}

test('page_agents chip points at manager tools', () => {
  const spec = pageAuthoritySpec('agents');
  assert.equal(spec.intent, 'page_agents');
  assert.match(spec.chipLabel, /派工|主管/);
});

test('manager cannot spawn desk; can spawn employee and message', async () => {
  const runtime = fakeRuntime();
  // Minimal stub: avoid real DB agent task dispatch by custom execute that succeeds without tasks
  const spawner = new JobSpawner(runtime, {
    execute: async () => ({ status: 'succeeded', code: 'OK', message: null, readback: null })
  });

  assert.throws(() => spawner.spawn({ roleId: 'desk', brief: 'nope' }), /ROLE_NOT_SPAWNABLE|员工/);

  const job = spawner.spawn({ roleId: 'reporter', brief: '扫一下 AI 前沿列表并回报三条线索' });
  assert.equal(job.roleId, 'reporter');
  assert.ok(job.brief.includes('AI 前沿'));
  assert.ok(job.status === 'queued' || job.status === 'running' || job.status === 'succeeded' || job.status === 'failed');

  // Message should work even if execute path failed/succeeded quickly
  const msg = await spawner.postMessage(job.id, '优先看官方账号', 'desk');
  assert.equal(msg.from, 'desk');
  assert.equal(msg.body, '优先看官方账号');
  const listed = spawner.listMessages(job.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, msg.id);

  assert.throws(() => spawner.spawn({ roleId: 'reporter', brief: '   ' }), /brief/);
});
