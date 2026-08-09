import assert from 'node:assert/strict';
import test from 'node:test';
import { decideDailyStartGate } from '../src/main/daily-start-gate.ts';

test('live coordinator returns active', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'starting', intent: 'daily_scan', savedCount: 0 },
    hasLiveCoordinator: true
  });
  assert.equal(d.action, 'return_active');
});

test('dead starting coordinator restarts full', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'starting', intent: 'daily_scan', savedCount: 0 },
    hasLiveCoordinator: false
  });
  assert.equal(d.action, 'start_full');
});

test('dead scanning coordinator restarts full', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'scanning_sources', intent: 'daily_scan', savedCount: 2 },
    hasLiveCoordinator: false
  });
  assert.equal(d.action, 'start_full');
});

test('channel_scanned without coordinator is judge only', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'channel_scanned', intent: 'daily_scan', savedCount: 3 },
    hasLiveCoordinator: false
  });
  assert.equal(d.action, 'start_judge_only');
});

test('dead synthesizing coordinator is judge only', () => {
  const d = decideDailyStartGate({
    active: { status: 'running', phase: 'synthesizing', intent: 'daily_judge', savedCount: 3 },
    hasLiveCoordinator: false
  });
  assert.equal(d.action, 'start_judge_only');
});

test('partial latest continues with judge only', () => {
  const d = decideDailyStartGate({
    active: null,
    latest: { status: 'partial', phase: 'partial', intent: 'daily_judge', savedCount: 5 },
    hasLiveCoordinator: false
  });
  assert.equal(d.action, 'start_judge_only');
});
