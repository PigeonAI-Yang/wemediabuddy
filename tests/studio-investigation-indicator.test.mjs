import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { studioInvestigationIndicator } from '../src/renderer/studio-investigation-indicator.ts';

function investigation(status, reporter = null) {
  return { status, reporter };
}

function reporter(status, errorMessage = null) {
  return { status, errorMessage };
}

test('investigation indicator is green only while the reporter is actually running', () => {
  assert.deepEqual(
    studioInvestigationIndicator(investigation('researching', reporter('running'))),
    { state: 'active', label: '记者正在调查' }
  );
  assert.equal(studioInvestigationIndicator(investigation('researching', reporter('queued'))).state, 'idle');
  assert.equal(studioInvestigationIndicator(investigation('researching', reporter('waiting_resource'))).state, 'idle');
  assert.equal(studioInvestigationIndicator(investigation('research_review', reporter('running'))).state, 'idle');
});

test('investigation indicator is red for rejection and failures', () => {
  assert.deepEqual(
    studioInvestigationIndicator(investigation('outline_rejected')),
    { state: 'error', label: '调查提纲已驳回' }
  );
  assert.equal(studioInvestigationIndicator(investigation('failed')).state, 'error');
  assert.equal(studioInvestigationIndicator(investigation('researching', reporter('failed'))).state, 'error');
  assert.equal(studioInvestigationIndicator(investigation('researching', reporter('running', 'network failed'))).state, 'error');
});

test('investigation indicator is gray for every non-active, non-error state', () => {
  assert.deepEqual(studioInvestigationIndicator(null), { state: 'idle', label: '当前无记者调查' });
  for (const status of [
    'outline_pending_approval',
    'research_review',
    'needs_more_research',
    'needs_user',
    'direction_pending_approval',
    'ready_to_write',
    'writing',
    'completed',
    'abandoned'
  ]) {
    assert.equal(studioInvestigationIndicator(investigation(status)).state, 'idle', status);
  }
});

test('deferred supervisor review survives renderer normalization for Owner decision actions', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { wmb: {} };
  const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { normalizeInvestigationModel } = await vite.ssrLoadModule('/src/renderer/studio-investigation.ts');
    const normalized = normalizeInvestigationModel({
      projectId: 'project-deferred',
      status: 'needs_user',
      revision: 2,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:01:00.000Z',
      package: {
        pack: null,
        sourceIds: [],
        review: { decision: 'defer', summary: '资料不足', decidedAt: '2026-08-17T00:01:00.000Z', decidedBy: 'desk' },
        createdAt: '2026-08-17T00:00:30.000Z'
      },
      history: []
    });
    assert.equal(normalized?.package?.review?.decision, 'defer');
    assert.equal(normalized?.package?.review?.summary, '资料不足');
  } finally {
    await vite.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
