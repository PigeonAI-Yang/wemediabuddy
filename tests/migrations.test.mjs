import {execFile} from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

test('migrations apply once and survive reopening', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-db-'));
  try {
    await promisify(execFile)(process.execPath,['tests/migrations-child.mjs'],{cwd:process.cwd(),env:{...process.env,WMB_TEST_DIRECTORY:directory}});
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
