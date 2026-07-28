import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import test from 'node:test';
test('core versions are immutable and platform handoffs preserve exact payloads', async () => { await promisify(execFile)(process.execPath, ['tests/content-child.mjs'], { cwd: process.cwd() }); });
