import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOrphanChannelScannedTask,
  orphanChannelScannedHandoffMs,
  dailyControlWatchdogDecision
} from '../src/main/daily-control-policy.ts';

test('orphan handoff ms default is 3 minutes', () => {
  assert.equal(orphanChannelScannedHandoffMs(), 3 * 60_000);
});

test('channel_scanned with stale activity is orphan', () => {
  const now = Date.parse('2026-08-07T13:00:00.000Z');
  const task = {
    status: 'running',
    phase: 'channel_scanned',
    intent: 'daily_scan',
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:01:00.000Z',
    progress: { lastActivityAt: '2026-08-07T12:01:00.000Z', planned: 5, processed: 5 }
  };
  assert.equal(isOrphanChannelScannedTask(task, now), true);
});

test('channel_scanned fresh activity is not orphan', () => {
  const now = Date.parse('2026-08-07T12:02:00.000Z');
  const task = {
    status: 'running',
    phase: 'channel_scanned',
    intent: 'daily_scan',
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:01:50.000Z',
    progress: { lastActivityAt: '2026-08-07T12:01:50.000Z' }
  };
  assert.equal(isOrphanChannelScannedTask(task, now), false);
});

test('fresh scanning is not orphan; stale starting/scanning is orphan', () => {
  const now = Date.parse('2026-08-07T13:00:00.000Z');
  const fresh = {
    status: 'running',
    phase: 'scanning_sources',
    intent: 'daily_scan',
    createdAt: '2026-08-07T12:58:00.000Z',
    updatedAt: '2026-08-07T12:59:00.000Z',
    progress: { lastActivityAt: '2026-08-07T12:59:00.000Z' }
  };
  assert.equal(isOrphanChannelScannedTask(fresh, now), false);
  const staleStart = {
    status: 'running',
    phase: 'starting',
    intent: 'daily_scan',
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
    progress: {}
  };
  assert.equal(isOrphanChannelScannedTask(staleStart, now), true);
});

test('watchdog still flags long stall including channel_scanned', () => {
  const now = Date.parse('2026-08-07T12:20:00.000Z');
  const task = {
    status: 'running',
    phase: 'channel_scanned',
    createdAt: '2026-08-07T12:00:00.000Z',
    progress: { lastActivityAt: '2026-08-07T12:01:00.000Z' }
  };
  const d = dailyControlWatchdogDecision(task, now);
  assert.ok(d);
  assert.equal(d.code, 'DAILY_STALL');
});
