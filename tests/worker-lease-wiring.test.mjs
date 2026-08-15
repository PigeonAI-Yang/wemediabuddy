// CAP-027 L1 — 主进程接线契约（谁占 desk / employee）
//
// L1-S 静态：直接读 src/main/index.ts / job-spawner.ts 源码文本做契约断言，
//           不 import index.ts（它依赖 electron，本文件无 Electron 也可运行）。
// L1-D 动态：ActiveWorkspaceRuntime + 真 DB（migrate + workspace_id app_meta），
//           复刻 job-spawner.test.mjs 的 openRuntime 套路。
//
// 设计主张（防回退）：desk 只服务 Owner 对话；扫描/工单/studio 后台一律 employee。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { MAX_EMPLOYEE_LEASES, MAX_WORKER_LEASES } from '../src/main/worker-limits.ts';

// ---------------------------------------------------------------------------
// L1-S 静态接线契约
// ---------------------------------------------------------------------------

function sourceFile(relativePath) {
  return readFileSync(new URL(`../src/main/${relativePath}`, import.meta.url), 'utf8');
}

/** 按签名定位函数，跳过参数列表中的类型/默认值花括号，再括号配平取出函数体。 */
function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `source should contain signature: ${signature}`);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth -= 1;
    else if (ch === '{' && parenDepth === 0) {
      bodyStart = i;
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `signature should open a body: ${signature}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

function acquireCallsIn(body) {
  return [...body.matchAll(/acquireWorkerLease\s*\([^)]*\)/g)].map((m) => m[0]);
}

test('L1-S1 withRuntimeWorker 只能以 employee 获取 worker lease', () => {
  const indexSource = sourceFile('index.ts');
  const body = extractFunctionBody(indexSource, 'async function withRuntimeWorker');
  // 后台 runner（日报/studio/成果复核）必须走 employee，占座注释须保留（防回退）。
  assert.match(
    body,
    /acquireWorkerLease\s*\(\s*taskId,\s*options\.roleId \?\? null,\s*'employee'\s*\)/,
    'withRuntimeWorker must acquire the lease with purpose "employee"'
  );
  // 函数体内只允许出现这一处获取，且目的不能是 desk。
  const calls = acquireCallsIn(body);
  assert.equal(calls.length, 1, 'withRuntimeWorker should have exactly one acquireWorkerLease call');
  for (const call of calls) {
    assert.doesNotMatch(call, /,\s*'desk'\s*\)/, 'withRuntimeWorker must never acquire with purpose "desk"');
  }
});

test('L1-S2 ensurePi 以 desk 获取 lease（Owner 对话席）', () => {
  const indexSource = sourceFile('index.ts');
  const body = extractFunctionBody(indexSource, 'async function ensurePi');
  assert.match(
    body,
    /acquireWorkerLease\s*\(\s*null,\s*null,\s*'desk'\s*\)/,
    'ensurePi must acquire the desk lease'
  );
});

test('L1-S3 job-spawner 的员工工单只使用 employee', () => {
  const spawnerSource = sourceFile('job-spawner.ts');
  const calls = acquireCallsIn(spawnerSource);
  assert.ok(calls.length >= 1, 'job-spawner should acquire worker leases');
  for (const call of calls) {
    assert.match(call, /,\s*'employee'\s*\)/, `job-spawner lease must be employee: ${call}`);
  }
});

test('L1-S4 withRuntimeWorker 禁止任何 desk 获取（正则守卫）', () => {
  const indexSource = sourceFile('index.ts');
  const body = extractFunctionBody(indexSource, 'async function withRuntimeWorker');
  // 注意：函数体内存在 role === 'desk' 的任务授权映射（onTaskReady 的 roleId 归一），
  // 那属于 grant 角色而非 lease purpose，因此守卫只看 acquireWorkerLease 的第三参数。
  for (const call of acquireCallsIn(body)) {
    assert.doesNotMatch(call, /'desk'/, `withRuntimeWorker acquire call must not reference desk: ${call}`);
  }
});

// ---------------------------------------------------------------------------
// L1-D 动态接线契约（真 runtime，假 work）
// ---------------------------------------------------------------------------

function openRuntime(directory) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', 'ws-lease-wiring', now, now);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

function withRuntime(directoryPrefix, run) {
  const directory = mkdtempSync(path.join(tmpdir(), directoryPrefix));
  const runtime = openRuntime(directory);
  return (async () => {
    try {
      return await run(runtime);
    } finally {
      await runtime.stop({ drain: false }).catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  })();
}

test('L1-D1 后台占 employee 时 desk 仍可获取，snapshots 含双 purpose', async () => {
  await withRuntime('wmb-wiring-d1-', (runtime) => {
    const desk = runtime.acquireWorkerLease(null, null, 'desk');
    const employee = runtime.acquireWorkerLease('task-e', 'reporter', 'employee');
    assert.ok(desk.leaseId);
    assert.ok(employee.leaseId);
    assert.notEqual(employee.leaseId, desk.leaseId);

    const snapshots = runtime.getWorkerSnapshots();
    assert.equal(snapshots.length, 2);
    assert.deepEqual(
      new Set(snapshots.map((s) => s.purpose)),
      new Set(['desk', 'employee']),
      'snapshots must contain both desk and employee purposes'
    );
    const employeeSnap = snapshots.find((s) => s.purpose === 'employee');
    assert.equal(employeeSnap.leaseId, employee.leaseId);
    assert.equal(employeeSnap.taskId, 'task-e');
    const deskSnap = snapshots.find((s) => s.purpose === 'desk');
    assert.equal(deskSnap.leaseId, desk.leaseId);
    assert.equal(deskSnap.roleId, null);
  });
});

test('L1-D2 已持 desk 再取第二个 desk 必须拒绝（WORKSPACE_BUSY/尚未释放）', async () => {
  await withRuntime('wmb-wiring-d2-', (runtime) => {
    const desk = runtime.acquireWorkerLease(null, null, 'desk');
    assert.throws(
      () => runtime.acquireWorkerLease(null, null, 'desk'),
      (error) => {
        assert.equal(error.code, 'WORKSPACE_BUSY');
        assert.match(error.message, /尚未释放/);
        return true;
      },
      'second desk acquire must throw WORKSPACE_BUSY'
    );
    // 第一次 desk 完好，没被踢掉。
    assert.equal(runtime.isCurrentLease(desk), true);
  });
});

test('L1-D3 withRuntimeWorker 等价模式：employee 绑定后 desk 仍可获取', async () => {
  await withRuntime('wmb-wiring-d3-', (runtime) => {
    // 复刻 withRuntimeWorker 顺序：先取 employee，再 bindWorker。
    const employee = runtime.acquireWorkerLease('task-e', 'planner', 'employee');
    runtime.bindWorker(employee, { stop() {} });
    // 扫描进行中 Owner 来聊天：desk 必须能拿到。
    const desk = runtime.acquireWorkerLease(null, null, 'desk');
    assert.equal(runtime.getWorkerSnapshots().length, 2);
    assert.equal(runtime.isCurrentLease(employee), true);
    assert.equal(runtime.isCurrentLease(desk), true);
    const purposes = new Set(runtime.getWorkerSnapshots().map((s) => s.purpose));
    assert.deepEqual(purposes, new Set(['desk', 'employee']));
  });
});

test('L1-D4 释放 employee 后 desk 无残留，员工槽可再取', async () => {
  await withRuntime('wmb-wiring-d4-', (runtime) => {
    const desk = runtime.acquireWorkerLease(null, null, 'desk');
    const employee = runtime.acquireWorkerLease('task-e', 'writer', 'employee');
    runtime.releaseWorker(employee);

    // desk 对话路径无残留：desk 仍是当前 lease，员工归零。
    const snapshots = runtime.getWorkerSnapshots();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].purpose, 'desk');
    assert.equal(runtime.isCurrentLease(desk), true);
    assert.equal(runtime.isCurrentLease(employee), false);

    // 员工槽位已回收，可再次派发。
    const again = runtime.acquireWorkerLease('task-f', 'writer', 'employee');
    assert.equal(runtime.getWorkerSnapshots().length, 2);
    assert.equal(runtime.isCurrentLease(again), true);
  });
});

// 软上限契约引用（worker-limits 与 runtime 共用同一常量，防脱节）。
test('L1-S5 软上限常量：employee 上限为总上限减 1（desk 席预留）', () => {
  assert.equal(MAX_WORKER_LEASES, 8);
  assert.equal(MAX_EMPLOYEE_LEASES, MAX_WORKER_LEASES - 1);
});
