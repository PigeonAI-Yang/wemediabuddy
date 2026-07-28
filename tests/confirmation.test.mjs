import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import test from 'node:test';
test('prepared editor readback binds version account and asset hashes before one-time confirmation', async () => {
  await promisify(execFile)(process.execPath, ['tests/confirmation-child.mjs'], { cwd: process.cwd() });
});
