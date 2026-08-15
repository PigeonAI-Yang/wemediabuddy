import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { handleSquirrelLifecycle } from '../src/main/squirrel-lifecycle.ts';

function harness(event, childEvent = 'spawn') {
  const child = new EventEmitter();
  let unrefCount = 0;
  let quitCount = 0;
  const calls = [];
  child.unref = () => { unrefCount += 1; };
  const handled = handleSquirrelLifecycle({
    argv: ['WeMediaBuddy.exe', event].filter(Boolean),
    execPath: 'C:\\Users\\owner\\AppData\\Local\\WeMediaBuddy\\app-0.2.0\\WeMediaBuddy.exe',
    quit: () => { quitCount += 1; },
    spawnProcess: (...args) => { calls.push(args); return child; }
  });
  if (handled && event !== '--squirrel-obsolete') child.emit(childEvent, childEvent === 'error' ? new Error('spawn failed') : undefined);
  return { calls, handled, quitCount, unrefCount };
}

test('ordinary launches do not enter Squirrel lifecycle handling', () => {
  assert.deepEqual(harness(undefined), { calls: [], handled: false, quitCount: 0, unrefCount: 0 });
});

test('install and update events create the executable shortcut then quit', () => {
  for (const event of ['--squirrel-install', '--squirrel-updated']) {
    const result = harness(event);
    assert.equal(result.handled, true);
    assert.equal(result.quitCount, 1);
    assert.equal(result.unrefCount, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0][0], path.resolve('C:\\Users\\owner\\AppData\\Local\\WeMediaBuddy\\app-0.2.0', '..', 'Update.exe'));
    assert.deepEqual(result.calls[0][1], ['--createShortcut', 'WeMediaBuddy.exe']);
    assert.deepEqual(result.calls[0][2], { detached: true, stdio: 'ignore', windowsHide: true });
  }
});

test('uninstall removes the executable shortcut then quits', () => {
  const result = harness('--squirrel-uninstall');
  assert.deepEqual(result.calls[0][1], ['--removeShortcut', 'WeMediaBuddy.exe']);
  assert.equal(result.quitCount, 1);
});

test('obsolete versions quit without spawning Update.exe', () => {
  assert.deepEqual(harness('--squirrel-obsolete'), { calls: [], handled: true, quitCount: 1, unrefCount: 0 });
});

test('Update.exe spawn failure still quits the lifecycle process', () => {
  const result = harness('--squirrel-install', 'error');
  assert.equal(result.quitCount, 1);
  assert.equal(result.unrefCount, 0);
});
