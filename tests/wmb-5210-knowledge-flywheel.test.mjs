import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5210 M1 聚焦测试（父进程）：真实旧 schema fixture 幂等迁移 + ChangeSet 事务/
 * 幂等/并发/恢复/循环/data-root 隔离，全部在子进程真实 SQLite 上执行。
 */
test('WMB-5210 knowledge flywheel storage contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5210-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5210-knowledge-flywheel-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
