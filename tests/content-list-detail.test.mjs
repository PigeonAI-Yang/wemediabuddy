import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

test('content list is bounded and body-free while detail returns one complete project', async () => {
  let stdout = '';
  try {
    ({ stdout } = await promisify(execFile)(process.execPath, ['tests/content-list-detail-child.mjs'], { cwd: process.cwd() }));
  } catch (error) {
    stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '';
    throw error;
  } finally {
    const directory = stdout.match(/^WMB_TEST_DIRECTORY=(.+)$/m)?.[1];
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
