import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import test from 'node:test';
test('publication state machine rejects invalid transitions and preserves unknown evidence', async () => {
  await promisify(execFile)(process.execPath, ['tests/publishing-child.mjs'], { cwd: process.cwd() });
});
