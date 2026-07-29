import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('knowledge library paginates, rejects stale state and compounds a topic idempotently', async () => {
  await promisify(execFile)(process.execPath, ['tests/knowledge-child.mjs'], { cwd: process.cwd() });
});
