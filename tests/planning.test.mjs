import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('only one current plan per day and every item cites stored sources', async () => {
  await promisify(execFile)(process.execPath, ['tests/planning-child.mjs'], { cwd: process.cwd() });
});
