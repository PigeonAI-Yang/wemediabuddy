import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5238 索引存储核心聚焦测试（父进程）：真实 SQLite 子进程执行 migration 63 +
 * 全链 1..70 迁移 + store 契约（fresh 迁移/重复迁移、业务表重建、版本锚不漂移、原子 upsert/remove、
 * hot cache 单行有界、write guard 对新表自动生效）。
 */
test('WMB-5238 wiki index store core contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5238-idx-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5238-index-store-core-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
