import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5216 知识健康服务聚焦测试（父进程）：全部在子进程真实 SQLite 上执行。
 * 覆盖：局部 Lint 去重；broken reference 自动 ChangeSet 原子修复 + 失败零部分写；
 * final Review 未回流 Issue 与回流后自动解决；可信冲突恒 open 不自动裁决；
 * 周期 Lint checkpoint 可恢复续跑、崩溃后重试零写、重复扫描不重复 Issue；
 * 同一 Issue 在 Topic/Library/Canvas/Results 读模型身份一致；workspace/lane/data-root 隔离；
 * 受影响范围上限拒绝。退出码 0 = 全部通过。
 */
test('WMB-5216 knowledge health service contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5216-health-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5216-knowledge-health-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
