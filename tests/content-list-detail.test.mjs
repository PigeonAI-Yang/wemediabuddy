import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('content list is bounded and body-free while detail returns one complete project', async () => {
  await promisify(execFile)(process.execPath, ['tests/content-list-detail-child.mjs'], { cwd: process.cwd() });
});
