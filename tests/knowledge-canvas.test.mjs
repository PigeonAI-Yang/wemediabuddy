import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('knowledge canvas persists references, relations and exact static packages', async () => {
  await promisify(execFile)(process.execPath, ['tests/knowledge-canvas-child.mjs'], { cwd: process.cwd() });
});
