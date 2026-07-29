import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('project lifecycle updates are revision guarded and readable', async () => {
  await promisify(execFile)(process.execPath, ['tests/content-lifecycle-child.mjs'], { cwd: process.cwd() });
});
