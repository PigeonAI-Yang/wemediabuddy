import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('source canonical URL and no-URL fingerprint dedupe update one identity', async () => {
  await promisify(execFile)(process.execPath, ['tests/sources-child.mjs'], { cwd: process.cwd() });
});
