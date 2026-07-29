import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('project detail reads materials and explicitly copies one version to a new project', async () => {
  await promisify(execFile)(process.execPath, ['tests/content-version-project-child.mjs'], { cwd: process.cwd() });
});
