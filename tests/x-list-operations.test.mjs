import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('X List proposals freeze only in UI and preserve idempotent binding state', async () => {
  await promisify(execFile)(process.execPath, ['tests/x-list-operations-child.mjs'], { cwd: process.cwd() });
});
