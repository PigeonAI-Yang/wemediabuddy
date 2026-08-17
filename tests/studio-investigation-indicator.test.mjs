import assert from 'node:assert/strict';
import test from 'node:test';
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
