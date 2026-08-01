import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessIdTree, WorkspaceRuntimeGate } from '../src/main/workspace-runtime.ts';

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
