import assert from 'node:assert/strict';
import test from 'node:test';

test('watchdog fires wall clock and stall with env overrides', async () => {
  process.env.WMB_DAILY_WALL_MS = '10000';
  process.env.WMB_DAILY_STALL_MS = '5000';
  process.env.WMB_DAILY_AUTO_PARTIAL = '1';
  const mod = await import(`../src/main/daily-control-policy.ts?wall=${Date.now()}`);
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const wall = mod.dailyControlWatchdogDecision({
    status: 'running',
    phase: 'synthesizing',
    createdAt: '2026-08-07T11:59:00.000Z',
    progress: { lastActivityAt: '2026-08-07T11:59:50.000Z' }
  }, now);
  assert.equal(wall?.code, 'DAILY_WALL_CLOCK');

  const stall = mod.dailyControlWatchdogDecision({
    status: 'running',
    phase: 'synthesizing',
    createdAt: '2026-08-07T11:59:55.000Z',
    progress: { lastActivityAt: '2026-08-07T11:59:50.000Z' }
  }, now);
  assert.equal(stall?.code, 'DAILY_STALL');

  const ok = mod.dailyControlWatchdogDecision({
    status: 'running',
    phase: 'synthesizing',
    createdAt: '2026-08-07T11:59:55.000Z',
    progress: { lastActivityAt: '2026-08-07T11:59:58.000Z' }
  }, now);
  assert.equal(ok, null);
});

test('auto partial can be disabled', async () => {
  process.env.WMB_DAILY_WALL_MS = '1';
  process.env.WMB_DAILY_AUTO_PARTIAL = '0';
  const mod = await import(`../src/main/daily-control-policy.ts?off=${Date.now()}`);
  const decision = mod.dailyControlWatchdogDecision({
    status: 'running',
    phase: 'scanning_sources',
    createdAt: '2020-01-01T00:00:00.000Z',
    progress: {}
  }, Date.now());
  assert.equal(decision, null);
});
