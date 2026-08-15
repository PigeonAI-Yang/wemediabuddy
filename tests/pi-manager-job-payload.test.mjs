import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpawnJobPayload } from '../.pi/extensions/wmb-mcp/wmb-mcp-tools-manager.ts';

const sharedNoise = {
  businessDate: '2026-08-15',
  channelIds: [],
  sourceFeedIds: [],
  projectId: 'project-1',
  writerTask: 'core_draft',
  sourceIds: [],
  scope: 'workspace'
};

test('wmb_spawn_job forwards only fields accepted by the selected role schema', () => {
  assert.deepEqual(buildSpawnJobPayload({
    ...sharedNoise,
    roleId: 'writer',
    brief: 'write the core draft'
  }), {
    role_id: 'writer',
    brief: 'write the core draft',
    business_date: '2026-08-15',
    project_id: 'project-1',
    writer_task: 'core_draft'
  });

  assert.deepEqual(buildSpawnJobPayload({
    ...sharedNoise,
    roleId: 'planner',
    brief: 'make a plan'
  }), {
    role_id: 'planner',
    brief: 'make a plan',
    business_date: '2026-08-15'
  });

  assert.deepEqual(buildSpawnJobPayload({
    ...sharedNoise,
    roleId: 'reporter',
    brief: 'scan sources',
    channelIds: ['x_lists'],
    sourceFeedIds: ['feed-1']
  }), {
    role_id: 'reporter',
    brief: 'scan sources',
    business_date: '2026-08-15',
    channel_ids: ['x_lists'],
    source_feed_ids: ['feed-1']
  });

  assert.deepEqual(buildSpawnJobPayload({
    ...sharedNoise,
    roleId: 'librarian',
    brief: 'organize sources',
    sourceIds: ['source-1']
  }), {
    role_id: 'librarian',
    brief: 'organize sources',
    source_ids: ['source-1'],
    scope: 'workspace'
  });
});

test('wmb_spawn_job rejects roles outside the employee registry', () => {
  assert.throws(
    () => buildSpawnJobPayload({ roleId: 'desk', brief: 'self dispatch' }),
    /Unsupported employee role: desk/
  );
});
