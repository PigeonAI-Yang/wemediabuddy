import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ROSTER_CONFLICT_WAIT_CODES, resolveDeskConflict } from '../src/renderer/agents-roster-conflict.ts';

function job(overrides = {}) {
  return { status: 'running', waitReason: null, ...overrides };
}

test('normal orchestration: desk running + employee running is NOT a conflict (WMB-5137)', () => {
  // 2026-08-09 11:41 daily_scan 正常编排：desk 主管占用（lease）+ reporter 扫描 running。
  const jobs = [
    job({ status: 'running', waitReason: null }),
    job({ status: 'queued', waitReason: null })
  ];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), false);
});

test('desk blocked (needs_user / 权限 BLOCKED) stays a conflict', () => {
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'blocked', jobs: [] }), true);
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'blocked', jobs: [job({ status: 'running' })] }), true);
});

test('free desk is never a conflict even with blocked row or conflict-coded parks', () => {
  assert.equal(resolveDeskConflict({ deskOccupied: false, deskStatus: 'blocked', jobs: [] }), false);
  assert.equal(
    resolveDeskConflict({
      deskOccupied: false,
      deskStatus: 'running',
      jobs: [job({ status: 'waiting_resource', waitReason: 'RESOURCE_LOCK_CONFLICT: page_agents (held by job-9)' })]
    }),
    false
  );
});

test('real RESOURCE_LOCK_CONFLICT park shows conflict danger', () => {
  const jobs = [job({ status: 'waiting_resource', waitReason: 'RESOURCE_LOCK_CONFLICT: page_agents (held by job-9)' })];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), true);
});

test('real RESOURCE_LEASE_BUSY park shows conflict danger', () => {
  const jobs = [job({ status: 'waiting_resource', waitReason: 'RESOURCE_LEASE_BUSY: 软上限 1 已达' })];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), true);
});

test('orchestration waits (RESOURCE_JUDGE_IN_FLIGHT, plain queued) are NOT conflicts', () => {
  const jobs = [
    job({ status: 'waiting_resource', waitReason: 'RESOURCE_JUDGE_IN_FLIGHT: scan-judge 窗口' }),
    job({ status: 'queued', waitReason: null }),
    job({ status: 'running', waitReason: null })
  ];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), false);
});

test('absent job list never fabricates a conflict', () => {
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs: null }), false);
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs: undefined }), false);
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running' }), false);
});

test('conflict codes are exactly RESOURCE_LOCK_CONFLICT and RESOURCE_LEASE_BUSY', () => {
  assert.deepEqual(ROSTER_CONFLICT_WAIT_CODES, ['RESOURCE_LOCK_CONFLICT', 'RESOURCE_LEASE_BUSY']);
});

test('roster view DOM gates .seat-conflict danger and desk seat conflict class on deskConflict only', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');

  // 冲突判定已委托纯函数（行为在 agents-roster-conflict.ts）。
  assert.match(source, /const deskConflict = resolveDeskConflict\(\{/);

  // DOM 断言：desk 席位 conflict class、危险 callout、危险 StatusDot 全部仅由 deskConflict 驱动。
  assert.match(
    source,
    /className=\{`agents-seat-cell desk \$\{deskOccupied \? 'occupied' : 'free'\} \$\{deskConflict \? 'conflict' : ''\}`\}/,
    'desk seat cell must add .conflict only when deskConflict'
  );
  assert.match(
    source,
    /\{deskConflict \? \([\s\S]*?agents-callout danger seat-conflict/,
    'seat-conflict danger callout must render only when deskConflict'
  );
  assert.match(
    source,
    /<StatusDot status=\{deskOccupied \? \(deskConflict \? 'blocked' : 'running'\) : 'idle'}\s*\/>/,
    'desk status dot shows danger blocked only when deskConflict'
  );

  // 回归守卫：旧的错误判定（pool.running > 0 触发冲突）必须已删除。
  assert.doesNotMatch(source, /deskConflict = deskOccupied && \(deskRow\?\.status === 'blocked' \|\| pool\.running > 0\)/);
});
