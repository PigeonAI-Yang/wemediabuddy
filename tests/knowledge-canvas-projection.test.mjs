import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// WMB-5213 M4：画布三模式投影验收（真实 SQLite 子进程）。
test('knowledge canvas projection: three-mode identity, delete safety, health IDs, event scopes, selected-only manifest', async () => {
  await promisify(execFile)(process.execPath, ['tests/knowledge-canvas-projection-child.mjs'], { cwd: process.cwd() });
});
