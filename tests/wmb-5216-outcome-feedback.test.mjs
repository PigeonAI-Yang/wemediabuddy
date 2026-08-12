import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5216 M7 聚焦测试（父进程）：结果回流全部在子进程真实 SQLite 上执行。
 * 覆盖：final Review 恰好一次回流（case 观察 + 证据 + 回执）；重放幂等零增量；
 * 单次高表现不生成因果 Method；重复同向结果按平台/受众限域建/强化 pattern；
 * 发布时固定 Usage 血缘（不随后续知识更新）；失败零部分写回滚；
 * 稳定 requestId 同输入重放、异输入 REQUEST_REPLAY_CONFLICT。
 */
test('WMB-5216 outcome feedback knowledge contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5216-of-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5216-outcome-feedback-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
