import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_CAPABILITIES,
  REDLINE_CATEGORIES,
  REDLINE_COMMANDS,
  deskStanding,
  deskStandingCommands,
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

test('WMB-5182 A1: desk standing write = grantable coverage ∪ infra, sorted, redline-free', () => {
  const desk = roleWriteCommands('desk');
  assert.ok(desk.length > 0, 'desk must hold full internal standing write power');
  assert.deepEqual([...desk].sort(), deskStandingCommands(), 'roleWriteCommands(desk) == deskStandingCommands()');
  assert.ok(desk.includes('agent_tasks.report_progress'), 'infra command included');
  assert.ok(desk.includes('sources.upsert_batch'), 'business command included');
  assert.ok(desk.includes('plans.save'), 'topic decision included');
  assert.ok(desk.includes('knowledge.topic_maintenance_approve'), 'internal topic approval is supervisor standing');
  for (const command of REDLINE_COMMANDS) {
    assert.equal(deskStanding.has(command), false, `redline ${command} must not enter deskStanding`);
    assert.equal(desk.includes(command), false, `redline ${command} must not enter desk standing`);
  }
});

test('WMB-5182 A1: redline is exactly three categories, never in deskStanding', () => {
  assert.deepEqual(REDLINE_CATEGORIES.map((c) => c.id), ['final_publish', 'hard_delete', 'external_platform_mutation']);
  const union = REDLINE_CATEGORIES.flatMap((c) => c.finalActCommands);
  assert.deepEqual([...new Set(union)].sort(), [...REDLINE_COMMANDS].sort(), 'REDLINE_COMMANDS = three-category union');
  for (const category of REDLINE_CATEGORIES) {
    for (const command of category.finalActCommands) {
      assert.equal(deskStanding.has(command), false, `${category.id} final act ${command} must be disjoint from deskStanding`);
    }
  }
});

test('WMB-5182 §5: topic_approval is supervisor-internal grantable with zero employee bindings', () => {
  const cap = AGENT_CAPABILITIES.find((c) => c.id === 'cap.topic_approval');
  assert.ok(cap, 'cap.topic_approval exists');
  assert.equal(cap.agentGrantable, true, 'must be grantable');
  assert.equal(cap.precise, false, 'must not be precise (internal, not redline)');
  assert.equal(cap.defaultRoleBindings.desk, true, 'must bind desk');
  for (const role of ['reporter', 'planner', 'writer', 'librarian']) {
    assert.equal(cap.defaultRoleBindings[role], undefined, `must not bind ${role}`);
  }
  for (const command of cap.commands) {
    assert.equal(roleWriteCommands('desk').includes(command), true, `desk standing includes ${command}`);
    for (const role of ['reporter', 'planner', 'writer', 'librarian']) {
      assert.equal(roleWriteCommands(role).includes(command), false, `${role} must not hold ${command}`);
    }
  }
});

test('WMB-5182: every grantable business capability binds desk (single registry truth)', () => {
  for (const cap of AGENT_CAPABILITIES) {
    if (!cap.agentGrantable) continue;
    assert.equal(cap.defaultRoleBindings.desk, true, `${cap.id} must bind desk`);
  }
});

test('WMB-5182: filterCommandsForRole desk intersects deskStanding (no page pass-through)', () => {
  const page = ['plans.save', 'sources.upsert_batch', 'content.save_version'];
  assert.deepEqual(filterCommandsForRole('desk', page), page, 'desk keeps every standing command from a page scope');
  const withRedline = [...page, 'x_lists.operation_execute', 'publication.editor_prepare_execute'];
  assert.deepEqual(filterCommandsForRole('desk', withRedline), page, 'redline final acts are filtered out for desk');
  assert.deepEqual(filterCommandsForRole(null, page), page, 'missing role stays legacy pass-through');
});

test('filterCommandsForRole writer intersects page scope', () => {
  const page = ['plans.save', 'sources.lane_restore', 'content.save_version', 'agent_tasks.report_progress'];
  assert.deepEqual(filterCommandsForRole('writer', page).sort(), [
    'agent_tasks.report_progress',
    'content.save_version'
  ]);
});
