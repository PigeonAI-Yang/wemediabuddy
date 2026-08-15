import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import test from 'node:test';
test('publication persistence regression suite remains covered', async () => {
  await promisify(execFile)(process.execPath, ['tests/publishing-child.mjs'], { cwd: process.cwd() });
});
test('publication exact-grant browser orchestration regression suite', async () => {
  await promisify(execFile)(process.execPath, ['tests/publishing-orchestration-child.mjs'], { cwd: process.cwd() });
});
