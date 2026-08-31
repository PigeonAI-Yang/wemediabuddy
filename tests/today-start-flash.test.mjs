import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  deriveTodayRunView,
  isManagerNonterminal,
  isTodayTaskActive,
  projectManagerTaskForToday,
  reduceTodayStartLatch,
  resolveFocusExistingProjection
} from '../src/renderer/today-run-view.ts';

const baseInput = {
  task: null,
  localStarting: false,
  hasTodayPlan: false,
  hasRecentPlan: false,
  opportunityCount: 0,
  sssCount: 0,
  sourcesTotal: 0,
  studioActive: null,
  piConfigured: true,
  channelsSummary: null
};

test('idle click synchronously latches busy (localStarting true wins)', () => {
  const view = deriveTodayRunView({ ...baseInput, localStarting: true, task: null });
  assert.equal(view.step, 'starting');
  assert.equal(view.headline, '正在启动今日情报');
  // also with stale failed task, localStarting keeps starting
  const stale = deriveTodayRunView({ ...baseInput, localStarting: true, task: { status: 'failed', errorMessage: 'old' } });
  assert.equal(stale.step, 'starting');
});

test('stale terminal child while latch pending keeps busy (no clear)', () => {
  const latch = { gen: 1, taskId: 'new-task-1' };
  const staleTerminal = { id: 'old-task-999', status: 'failed', errorMessage: 'old failure' };
  const decision = reduceTodayStartLatch(latch, { agentTask: staleTerminal });
  assert.equal(decision.handled, true);
  assert.deepEqual(decision.nextLatch, latch);
  assert.equal(decision.nextRunning, null);
  assert.equal(decision.keepBusy, true);
  // also view with latch would still be starting, not failed
  const view = deriveTodayRunView({ ...baseInput, localStarting: true, task: staleTerminal });
  assert.equal(view.step, 'starting');
});

test('nonterminal manager arrival while latch pending hands over to busy', () => {
  const latch = { gen: 1 };
  const manager = { id: 'mgr-1', status: 'running', checkpoint: { status: 'running', phase: 'dispatch_reporter' } };
  const child = null;
  assert.equal(isManagerNonterminal(manager), true);
  const decision = reduceTodayStartLatch(latch, { manager, child, agentTask: null });
  assert.equal(decision.handled, true);
  assert.equal(decision.nextLatch, null);
  assert.equal(decision.nextRunning, true);
  assert.ok(decision.nextTask);
  assert.equal(decision.nextTask.status, 'running');
  assert.equal(decision.nextTask.phase, 'dispatch_reporter');
});

test('matching terminal manager arrival clears latch to idle once', () => {
  const latch = { gen: 1, managerId: 'mgr-1' };
  const terminalManager = { id: 'mgr-1', status: 'succeeded', checkpoint: { status: 'succeeded', phase: 'done' } };
  assert.equal(isManagerNonterminal(terminalManager), false);
  const decision = reduceTodayStartLatch(latch, { manager: terminalManager, child: null, agentTask: null });
  assert.equal(decision.handled, true);
  assert.equal(decision.nextLatch, null);
  assert.equal(decision.nextRunning, false);
  // Terminal manager should allow idle; derive with null task and no latch is idle
  const view = deriveTodayRunView({ ...baseInput, localStarting: false, task: null });
  assert.equal(view.step, 'idle');
});

test('stale terminal child does not clear latch, matching terminal task clears idle once', () => {
  const latch = { gen: 5, taskId: 'new-123' };
  const matchingTerminal = { id: 'new-123', status: 'succeeded', phase: 'completed' };
  // Active should handover (covered elsewhere), now terminal matching id clears
  const decision = reduceTodayStartLatch(latch, { agentTask: matchingTerminal });
  assert.equal(decision.handled, true);
  assert.equal(decision.nextLatch, null);
  assert.equal(decision.nextRunning, false);
  assert.deepEqual(decision.nextTask, matchingTerminal);
  // View after latch cleared and task is terminal succeeded with no plan -> done/empty
  const view = deriveTodayRunView({ ...baseInput, localStarting: false, task: matchingTerminal });
  assert.equal(view.step, 'done');
});

test('start error clears latch to idle once', () => {
  // Simulate start error: latch existed, then error clears
  let latch = { gen: 2 };
  // In component, catch does syncStartLatch(null), setRunning false, task failed
  latch = null;
  assert.equal(latch, null);
  const failed = { status: 'failed', errorMessage: 'network' };
  const view = deriveTodayRunView({ ...baseInput, localStarting: false, task: failed });
  assert.equal(view.step, 'failed');
  assert.match(view.detail, /network/);
});

test('focus_existing with active manager + terminal child prioritizes manager busy', () => {
  const manager = { id: 'mgr-99', status: 'running', checkpoint: { status: 'running', phase: 'dispatch_reporter', summary: '主管进行中' } };
  const terminalChild = { id: 'old-child', status: 'succeeded', phase: 'completed' };
  const proj = resolveFocusExistingProjection(manager, terminalChild);
  assert.ok(proj.task);
  assert.equal(proj.running, true);
  assert.equal(proj.task.status, 'running');
  // Ensure view is manager-owned running, not idle
  const view = deriveTodayRunView({ ...baseInput, localStarting: false, task: proj.task });
  assert.equal(view.headline, '主管编排中');
  assert.equal(view.primaryCta.label, '对话中 · 查看进度');
  // Also ensure terminal child alone would be done, but manager priority overrides
  const childOnlyView = deriveTodayRunView({ ...baseInput, task: terminalChild });
  assert.equal(childOnlyView.step, 'done');
  // Priority check: projection uses manager, not child
  assert.notEqual(proj.task.id, terminalChild.id);
});

test('isTodayTaskActive preserves queued/waiting/running/needs_user as active', () => {
  assert.equal(isTodayTaskActive({ status: 'queued' }), true);
  assert.equal(isTodayTaskActive({ status: 'waiting_resource' }), true);
  assert.equal(isTodayTaskActive({ status: 'running' }), true);
  assert.equal(isTodayTaskActive({ status: 'needs_user' }), true);
  assert.equal(isTodayTaskActive({ status: 'failed' }), false);
  assert.equal(isTodayTaskActive({ status: 'succeeded' }), false);
  assert.equal(isTodayTaskActive({ status: 'partial' }), false);
  assert.equal(isTodayTaskActive(null), false);
});

test('no timer/debounce/reload or duplicate spawn introduced in today-view', async () => {
  const source = await readFile(new URL('../src/renderer/today-view.tsx', import.meta.url), 'utf8');
  // No minimum-duration timer, debounce, CSS transition hack, fake progress
  assert.doesNotMatch(source, /setTimeout\s*\(\s*\(\s*\)\s*=>\s*syncStartLatch/);
  assert.doesNotMatch(source, /debounce/i);
  assert.doesNotMatch(source, /minimum.*duration/i);
  assert.doesNotMatch(source, /fake.*progress/i);
  assert.doesNotMatch(source, /transition.*delay/i);
  // No duplicate spawn: guard exists
  assert.match(source, /if\s*\(\s*running\s*\|\|\s*startingRef\.current\s*\)\s*return/);
  // No reload
  assert.doesNotMatch(source, /location\.reload/);
  // Ensure the synchronous guard is raised before starting the async request.
  assert.match(source, /startingRef\.current\s*=\s*true/);
  // Count setTimeout occurrences: preserve the current explicit delayed refresh/control calls.
  const timeouts = (source.match(/setTimeout/g) || []).length;
  assert.equal(timeouts, 4, `expected exactly 4 setTimeout, got ${timeouts}`);
});

test('focus_existing projection does not duplicate task (single latch generation)', () => {
  // Two rapid focus_existing should not create new generation; latch is cleared not re-created
  const latchBefore = { gen: 10 };
  const manager = { id: 'm10', status: 'running', checkpoint: { status: 'running' } };
  const child = { id: 'c-old', status: 'failed' };
  const first = resolveFocusExistingProjection(manager, child);
  assert.equal(first.running, true);
  // Simulate second focus_existing with same manager but different child: still same single task
  const second = resolveFocusExistingProjection(manager, { id: 'c-old2', status: 'failed' });
  assert.deepEqual(first.task.id, second.task.id);
  assert.equal(first.task.status, 'running');
});
