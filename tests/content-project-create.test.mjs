import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('new articles create atomic independent projects while explicit continuation appends', async () => {
  await promisify(execFile)(process.execPath, ['tests/content-project-create-child.mjs'], { cwd: process.cwd() });
});
