import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagerTaskCheckpoint,
  managerTaskSerialDecision,
  buildManagerTaskCardText,
  MANAGER_TASK_INTENT
} from '../src/main/manager-task.ts';

test('serial decision focuses existing running manager task', () => {
  const checkpoint = createManagerTaskCheckpoint({
    businessDate: '2026-08-08',
    status: 'running',
    phase: 'monitor_reporter',
    summary: '记者扫描中'
  });
  const active = {
    id: 'm1',
    intent: MANAGER_TASK_INTENT,
    businessDate: '2026-08-08',
    status: 'running',
    phase: 'monitor_reporter',
    progress: {},
    checkpoint,
    errorCode: null,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  const d = managerTaskSerialDecision(active);
  assert.equal(d.action, 'focus_existing');
  assert.equal(d.active?.id, 'm1');
});

test('serial decision creates when none', () => {
  const d = managerTaskSerialDecision(null);
  assert.equal(d.action, 'create');
});

test('manager card text includes approval hint', () => {
  const checkpoint = createManagerTaskCheckpoint({ businessDate: '2026-08-08', status: 'waiting_human', phase: 'report' });
  const text = buildManagerTaskCardText({
    id: 'abcdef12-xxxx',
    intent: MANAGER_TASK_INTENT,
    businessDate: '2026-08-08',
    status: 'waiting_human',
    phase: 'report',
    progress: {},
    checkpoint,
    errorCode: null,
    errorMessage: null,
    updatedAt: '',
    createdAt: ''
  });
  assert.match(text, /主管/);
  assert.match(text, /今日情报/);
  assert.match(text, /批准/);
});
