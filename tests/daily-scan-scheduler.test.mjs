import assert from 'node:assert/strict';
import test from 'node:test';
import { DailyScanScheduler } from '../src/main/daily-scan-scheduler.ts';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('scheduler fires first tick after delay, guards re-entry, and skips when not current', async (t) => {
  let current = true;
  const web = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const scheduler = new DailyScanScheduler({
    isCurrent: () => current,
    officialWebMs: 40,
    xListsMs: 10_000,
    firstDelayMs: 10,
    run: async (modules) => {
      if (modules[0] !== 'official_web') return;
      web.push(modules);
      if (web.length === 1) await gate;
    }
  });
  t.after(() => { releaseFirst(); scheduler.stop(); });
  scheduler.start();
  await wait(95);
  assert.equal(web.length, 1, 'slow first run blocks re-entry instead of piling up');
  releaseFirst();
  await wait(95);
  assert.ok(web.length >= 2, 'next tick fires after the in-flight run settles');

  current = false;
  const before = web.length;
  await wait(95);
  assert.equal(web.length, before, 'ticks are skipped while the runtime is not current');

  scheduler.stop();
  current = true;
  const stoppedAt = web.length;
  await wait(95);
  assert.equal(web.length, stoppedAt, 'stop prevents any further tick');
});

test('x list lane has its own independent timer', async (t) => {
  const xRuns = [];
  const scheduler = new DailyScanScheduler({
    isCurrent: () => true,
    officialWebMs: 10_000,
    xListsMs: 30,
    firstDelayMs: 5,
    run: async (modules) => { if (modules[0] === 'x_lists') xRuns.push(modules); }
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  await wait(80);
  scheduler.stop();
  assert.ok(xRuns.length >= 1, 'x list lane fires on its own schedule');
});


test('a throwing run surfaces through onError and does not kill future ticks', async (t) => {
  const errors = [];
  let runs = 0;
  const scheduler = new DailyScanScheduler({
    isCurrent: () => true,
    officialWebMs: 30,
    xListsMs: 10_000,
    firstDelayMs: 5,
    run: async () => { runs += 1; throw new Error('coordinator down'); },
    onError: (error) => errors.push(error)
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  await wait(100);
  scheduler.stop();
  assert.ok(runs >= 2, 'later ticks still run after a failure');
  assert.ok(errors.length >= 1);
  assert.equal(errors[0].message, 'coordinator down');
});
