import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { approvedProjectId } from '../src/renderer/proposal-ledger.ts';

test('approval outcome resolves the created project from direct and command result shapes', () => {
  assert.equal(approvedProjectId({ advance: { projectId: 'project-123' } }), 'project-123');
  assert.equal(approvedProjectId({ ok: true, data: { advance: { projectId: 'project-456' } } }), 'project-456');
  assert.equal(approvedProjectId({ advance: null }), null);
  assert.equal(approvedProjectId({ advance: { projectId: '' } }), null);
  assert.equal(approvedProjectId(null), null);
});

test('approval consumes the project readback instead of reloading an empty ledger tab', async () => {
  const source = await readFile(new URL('../src/renderer/proposals-view.tsx', import.meta.url), 'utf8');
  const approve = source.match(/const approve = async[\s\S]*?\n  };/)?.[0] ?? '';
  assert.match(approve, /approvedProjectId\(result\)/);
  assert.match(approve, /onOpenProject\(projectId\)/);
  assert.match(approve, /else openToday\?\.\(\)/);
  assert.doesNotMatch(approve, /load\(tabRef\.current/);
});
