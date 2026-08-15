import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5217 M8 历史初始化聚焦测试（父进程）：全部在子进程真实 SQLite 上执行。
 * 覆盖（TASKS WMB-5217 Acceptance）：active/inactive Topic、重复运行、弱证据零 Note、
 * ID/chain/count 不变、无伪造历史、一 Topic 一 Wiki、可中断恢复/定点重跑、
 * 无 workspace 跳过、v58 迁移本身（receipt 表重建 + trigger_type 扩展 + state 表）。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
test('WMB-5217 legacy knowledge init contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5217-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5217-legacy-init-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
