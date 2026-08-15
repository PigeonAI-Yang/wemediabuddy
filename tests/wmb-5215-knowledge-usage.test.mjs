import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5215 M6 聚焦测试（父进程）：usage 血缘 store 全部在子进程真实 SQLite 上执行。
 * 覆盖：v56→v57 旧 fixture 幂等迁移；包不可变/无硬删；used/consulted 判别；
 * 无效版本/证据与跨 workspace/lane 拒绝；usage 失败零产物（transaction=false 可嵌入内容事务）；
 * 包与记录同事务；requestId 幂等/冲突；历史读回固定版本；过滤信封。
 */
test('WMB-5215 knowledge usage lineage store contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5215-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5215-knowledge-usage-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
