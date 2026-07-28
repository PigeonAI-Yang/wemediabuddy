import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import test from 'node:test';
test('Studio readback groups immutable versions and platform tabs', async () => { await promisify(execFile)(process.execPath, ['tests/studio-child.mjs'], { cwd: process.cwd() }); });
