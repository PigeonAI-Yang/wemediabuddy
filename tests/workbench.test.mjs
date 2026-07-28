import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('Today readback shows stored source and current plan', async () => {
  await promisify(execFile)(process.execPath, ['tests/workbench-child.mjs'], { cwd: process.cwd() });
});
