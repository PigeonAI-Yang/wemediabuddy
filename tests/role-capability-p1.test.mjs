import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { AUTOMATIC_TASK_GRANT_SCOPES } from '../src/main/task-grants.ts';
import { setCapabilityOverlay, roleWriteCommandsWithOverlays } from '../src/main/capability-overlays.ts';
import { buildRoleRoster } from '../src/main/role-roster.ts';
import { startAgentTask } from '../src/main/agent-tasks.ts';
import { filterCommandsForRole, roleWriteCommands } from '../src/shared/agent-capabilities.ts';

test('daily_scan and daily_judge scopes partition daily_intelligence', () => {
  const legacy = new Set(AUTOMATIC_TASK_GRANT_SCOPES.daily_intelligence);
  const scan = new Set(AUTOMATIC_TASK_GRANT_SCOPES.daily_scan);
  const judge = new Set(AUTOMATIC_TASK_GRANT_SCOPES.daily_judge);
  for (const command of legacy) {
    assert.ok(scan.has(command) || judge.has(command), `missing ${command}`);
  }
  assert.ok(scan.has('sources.upsert_batch'));
  assert.equal(scan.has('plans.save'), false);
  assert.ok(judge.has('plans.save'));
  assert.equal(judge.has('sources.upsert_batch'), false);
});

test('reporter filter keeps collect commands only from union', () => {
  const union = [...AUTOMATIC_TASK_GRANT_SCOPES.daily_intelligence];
  const filtered = filterCommandsForRole('reporter', union);
  assert.ok(filtered.includes('sources.upsert_batch'));
  assert.equal(filtered.includes('plans.save'), false);
  assert.equal(filtered.includes('sources.lane_gate'), false);
});

test('overlay can disable librarian organize write', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-overlay-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const before = roleWriteCommands('librarian');
    assert.ok(before.includes('sources.lane_restore'));
    setCapabilityOverlay(database, {
      workspaceId: 'ws-test',
      roleId: 'librarian',
      capabilityId: 'cap.library_organize',
      enabled: false
    });
    const after = roleWriteCommandsWithOverlays(database, 'ws-test', 'librarian');
    assert.equal(after.includes('sources.lane_restore'), false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('redline capability overlay rejected', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-overlay-red-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    assert.throws(() => setCapabilityOverlay(database, {
      workspaceId: 'ws-test',
      roleId: 'writer',
      capabilityId: 'cap.platform_mutation',
      enabled: true
    }), /红线|GRANTABLE|不可/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('roster maps daily_scan task to reporter', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-roster-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const started = startAgentTask(database, {
      intent: 'daily_scan',
      businessDate: '2026-08-07',
      contextRefs: { roleId: 'reporter', planDate: '2026-08-07' }
    });
    assert.equal(started.ok, true);
    const roster = buildRoleRoster(database, { businessDate: '2026-08-07' });
    const reporter = roster.find((row) => row.roleId === 'reporter');
    assert.ok(reporter);
    assert.equal(reporter.status, 'running');
    assert.ok(reporter.taskId);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
