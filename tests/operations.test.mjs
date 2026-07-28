import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { failure, success } from '../src/main/result.ts';

const execFileAsync = promisify(execFile);

test('command result envelope and operation log preserve stable facts', async () => {
  assert.deepEqual(success({ id: 'source-1' }), { ok: true, data: { id: 'source-1' }, error: null });
  assert.equal(failure('VALIDATION_ERROR', 'title required').error.code, 'VALIDATION_ERROR');
  await execFileAsync(process.execPath, ['tests/operation-log-child.mjs'], { cwd: process.cwd() });
});
