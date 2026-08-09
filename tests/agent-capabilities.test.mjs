import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterCommandsForRole,
  roleWriteCommands,
  ROLE_CATALOG
} from '../src/shared/agent-capabilities.ts';

test('five fixed roles exist', () => {
  assert.deepEqual(Object.keys(ROLE_CATALOG).sort(), ['desk', 'librarian', 'planner', 'reporter', 'writer']);
});

test('writer cannot organize library or save plans', () => {
  const cmds = roleWriteCommands('writer');
  assert.ok(cmds.includes('content.save_version'));
  assert.equal(cmds.includes('sources.lane_restore'), false);
  assert.equal(cmds.includes('plans.save'), false);
});

test('librarian organizes but does not draft or decide topics', () => {
  const cmds = roleWriteCommands('librarian');
  assert.ok(cmds.includes('sources.lane_restore'));
  assert.equal(cmds.includes('content.create'), false);
  assert.equal(cmds.includes('plans.save'), false);
});

test('filterCommandsForRole desk pass-through keeps page scope', () => {
  const page = ['plans.save', 'sources.upsert_batch', 'content.save_version'];
  assert.deepEqual(filterCommandsForRole('desk', page), page);
  assert.deepEqual(filterCommandsForRole(null, page), page);
});

test('filterCommandsForRole writer intersects page scope', () => {
  const page = ['plans.save', 'sources.lane_restore', 'content.save_version', 'agent_tasks.report_progress'];
  assert.deepEqual(filterCommandsForRole('writer', page).sort(), [
    'agent_tasks.report_progress',
    'content.save_version'
  ]);
});
