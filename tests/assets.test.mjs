import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import test from 'node:test';
test('asset import atomically stores one hash and reuses it', async () => { await promisify(execFile)(process.execPath, ['tests/assets-child.mjs'], { cwd: process.cwd() }); });
