import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ActiveWorkspaceRuntime, installWorkspaceIpcGate, RUNTIME_MANAGING_IPC_CHANNELS, stopProcessIdTree, WorkspaceRuntimeGate } from '../src/main/workspace-runtime.ts';

test('workspace gate drains accepted work and rejects later work', async () => {
  const gate = new WorkspaceRuntimeGate();
  let release;
  const active = gate.run(() => new Promise((resolve) => { release = resolve; }));
  await delay(10);
  const draining = gate.closeAndDrain();
  await assert.rejects(() => gate.run(() => 'late'), { code: 'WORKSPACE_BUSY' });
  release('done');
  assert.equal(await active, 'done');
  await draining;
  gate.reopen();
  assert.equal(await gate.run(() => 'next'), 'next');
});

test('channel confirmation drains before a workspace switch and rejects late writes', async () => {
  const handlers = new Map();
  const ipcMain = { handle(channel, listener) { handlers.set(channel, listener); } };
  const gate = new WorkspaceRuntimeGate();
  installWorkspaceIpcGate(ipcMain, gate, ['workspaces:switch', 'workspaces:proposal-confirm']);
  let release;
  let writes = 0;
  const hold = new Promise((resolve) => { release = resolve; });
  ipcMain.handle('intelligence-channels:proposal-confirm', async () => {
    await hold;
    writes += 1;
    return 'confirmed';
  });

  const accepted = handlers.get('intelligence-channels:proposal-confirm')({}, {});
  await delay(10);
  const draining = gate.closeAndDrain();
  let drained = false;
  void draining.then(() => { drained = true; });
  await delay(10);
  assert.equal(drained, false);
  await assert.rejects(() => handlers.get('intelligence-channels:proposal-confirm')({}, {}), { code: 'WORKSPACE_BUSY' });
  assert.equal(writes, 0);

  release();
  assert.equal(await accepted, 'confirmed');
  await draining;
  assert.equal(writes, 1);
});

test('every explicit runtime-managing Owner IPC stays outside the gate it drains', async () => {
  const ownerChannels = [
    'browser-profiles:create',
    'workspace-browser:rebind',
    'workspace-browser:verify',
    'workspace-browser:migrate-legacy'
  ];
  for (const channel of ownerChannels) assert.equal(RUNTIME_MANAGING_IPC_CHANNELS.includes(channel), true);
  for (const channel of ownerChannels) {
    const handlers = new Map();
    const ipcMain = { handle(name, listener) { handlers.set(name, listener); } };
    const gate = new WorkspaceRuntimeGate();
    installWorkspaceIpcGate(ipcMain, gate, [...RUNTIME_MANAGING_IPC_CHANNELS]);
    ipcMain.handle(channel, async () => { await gate.closeAndDrain(50); return channel; });
    const result = await Promise.race([
      handlers.get(channel)({}, {}),
      delay(100).then(() => { throw new Error(`${channel} deadlocked while draining`); })
    ]);
    assert.equal(result, channel);
  }
});

test('active runtimes keep exact root identity and receive a fresh epoch', async () => {
  const first = openRuntime('epoch-a', 'relative-workspace');
  const second = openRuntime('epoch-b', 'relative-workspace');
  assert.deepEqual(first.runtime.identity, {
    workspaceId: 'workspace-1',
    rootPath: path.resolve('relative-workspace'),
    runtimeEpoch: 'epoch-a'
  });
  assert.equal(first.runtime.matchesIdentity(second.runtime.identity), false);
  await first.runtime.stop({ drain: false });
  await second.runtime.stop({ drain: false });
});

test('worker reservation is atomic and closing claims rejects every new lease', async () => {
  const { runtime } = openRuntime('epoch-atomic');
  const workerLease = runtime.acquireWorkerLease();
  assert.throws(() => runtime.acquireWorkerLease('task-2'), { code: 'WORKSPACE_BUSY' });
  runtime.bindWorker(workerLease, { stop() {} });
  runtime.bindWorkerTask(workerLease, 'task-1');
  assert.equal(runtime.isCurrentWorkerLease(workerLease.leaseId, 'task-1'), true);
  assert.throws(() => runtime.bindWorkerTask(workerLease, 'task-2'), { code: 'WORKSPACE_BUSY' });
  runtime.bindBrowser({}, { stop() {} });

  const hold = deferred();
  const accepted = runtime.runAtomic(() => hold.promise);
  const draining = runtime.closeClaimsAndDrain();
  assert.throws(() => runtime.acquireWorkerLease('late'), { code: 'WORKSPACE_BUSY' });
  assert.throws(() => runtime.bindBrowser({}), { code: 'WORKSPACE_BUSY' });
  hold.resolve('complete');
  assert.equal(await accepted, 'complete');
  await draining;
  await runtime.stop({ drain: false });
});

test('failed drain and unsafe browser rejection reopen the current runtime without invalidating claims', async () => {
  const { runtime } = openRuntime('epoch-reopen');
  const browserLease = runtime.bindBrowser({}, { stop() {} });
  const atomicHold = deferred();
  const accepted = runtime.runAtomic(() => atomicHold.promise);
  await assert.rejects(() => runtime.closeClaimsAndDrain(0), { code: 'WORKSPACE_BUSY' });
  let callbacks = 0;
  assert.equal(runtime.guardLease(browserLease, () => { callbacks += 1; }), true);
  assert.equal(await runtime.runAtomic(() => 'reopened'), 'reopened');
  atomicHold.resolve();
  await accepted;

  const browserHold = deferred();
  const external = runtime.runExternalBrowserWork(browserLease, () => browserHold.promise);
  await assert.rejects(() => runtime.closeClaimsAndDrain(), { code: 'WORKSPACE_BUSY' });
  assert.equal(await runtime.runAtomic(() => 'still-open'), 'still-open');
  assert.equal(runtime.guardLease(browserLease, () => { callbacks += 1; }), true);
  assert.equal(callbacks, 2);
  browserHold.resolve();
  await external;
  await runtime.stop({ drain: false });
});

test('released and stopped leases execute zero stale callbacks', async () => {
  const { runtime } = openRuntime('epoch-stale');
  const workerLease = runtime.acquireWorkerLease('task-stale');
  runtime.bindWorker(workerLease, { stop() {} });
  const browserLease = runtime.bindBrowser({}, { stop() {} });
  runtime.releaseWorker(workerLease);
  runtime.releaseBrowser(browserLease);
  let callbacks = 0;
  assert.equal(runtime.guardLease(workerLease, () => { callbacks += 1; }), false);
  assert.equal(runtime.guardLease(browserLease, () => { callbacks += 1; }), false);
  await runtime.stop({ drain: false });
  assert.equal(runtime.guardLease(workerLease, () => { callbacks += 1; }), false);
  assert.equal(runtime.guardLease(browserLease, () => { callbacks += 1; }), false);
  assert.equal(callbacks, 0);
});

test('shutdown invalidates leases first and attempts scheduler, Pi, browser, MCP, XHS, and DB in order', async () => {
  const order = [];
  const { runtime } = openRuntime('epoch-stop', 'runtime-root', () => { order.push('db'); });
  const workerLease = runtime.acquireWorkerLease('task-stop');
  let browserLease;
  browserLease = runtime.bindBrowser({}, {
    stop() {
      order.push('browser');
      assert.equal(runtime.guardLease(workerLease, () => assert.fail()), false);
      assert.equal(runtime.guardLease(browserLease, () => assert.fail()), false);
    }
  });
  runtime.bindWorker(workerLease, stoppable('pi', order, runtime, workerLease, browserLease));
  runtime.setScheduler(stoppable('scheduler', order, runtime, workerLease, browserLease, new Error('scheduler failed')));
  runtime.setMcp({ close: () => { order.push('mcp'); assert.equal(runtime.guardLease(workerLease, () => assert.fail()), false); } });
  runtime.setXhs(stoppable('xhs', order, runtime, workerLease, browserLease));
  const firstStop = runtime.stop({ drain: false });
  assert.equal(runtime.stop({ drain: false }), firstStop);
  await assert.rejects(firstStop, /scheduler failed/);
  assert.deepEqual(order, ['scheduler', 'pi', 'browser', 'mcp', 'xhs', 'db']);
  assert.equal(runtime.stop({ drain: false }), firstStop);
});

test('quit-style forced cleanup does not wait for unsafe external browser work', async () => {
  const order = [];
  const { runtime } = openRuntime('epoch-quit', 'runtime-root', () => { order.push('db'); });
  const browserLease = runtime.bindBrowser({}, { stop() { order.push('browser'); } });
  const hold = deferred();
  const external = runtime.runExternalBrowserWork(browserLease, () => hold.promise);
  await assert.rejects(() => runtime.stop(), { code: 'WORKSPACE_BUSY' });
  assert.equal(runtime.guardLease(browserLease, () => {}), true);
  await runtime.stop({ drain: false });
  assert.deepEqual(order, ['browser', 'db']);
  assert.equal(runtime.guardLease(browserLease, () => assert.fail()), false);
  hold.resolve();
  await external;
});

test('workspace shutdown terminates the owned Windows process tree', { skip: process.platform !== 'win32' }, async () => {
  const script = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({childPid:c.pid}));setInterval(()=>{},1000)";
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
  });
  const childPid = JSON.parse(line).childPid;
  await stopProcessIdTree(parent.pid);
  for (let attempt = 0; attempt < 20 && isAlive(childPid); attempt++) await delay(50);
  assert.equal(isAlive(parent.pid), false);
  assert.equal(isAlive(childPid), false);
});

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function openRuntime(epoch, rootPath = 'runtime-root', onClose = () => {}) {
  const database = {
    prepare() { return { get() { return { value: 'workspace-1' }; } }; },
    close() { onClose(); }
  };
  const runtime = ActiveWorkspaceRuntime.open(rootPath, {
    expectedWorkspaceId: 'workspace-1',
    createEpoch: () => epoch,
    openDatabase: () => database
  });
  return { runtime, database };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function stoppable(name, order, runtime, workerLease, browserLease, error) {
  return {
    stop() {
      order.push(name);
      assert.equal(runtime.guardLease(workerLease, () => assert.fail()), false);
      assert.equal(runtime.guardLease(browserLease, () => assert.fail()), false);
      if (error) throw error;
    }
  };
}
