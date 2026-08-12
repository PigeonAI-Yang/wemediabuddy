import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5211 知识编译服务聚焦测试（父进程）：全部在子进程真实 SQLite 上执行。
 * 覆盖：Entity 零重复（canonicalKey 命中复用）；新 Claim（带原文 locator）；旧 Method 限域
 * （qualified 追加版本）；真实争议（contradicted → disputed，kept_disputed 保留双方）；
 * locator EvidenceLink；唯一 Topic Wiki 重编译；Receipt；同 source revision/request 幂等重放；
 * 低价值零知识（零 Note/Wiki 仍持久 receipt）；失败零写（陈旧 revision / 无效候选 /
 * 未解析 Entity key / kind 冲突 / 幽灵 Source / Topic / 重复候选）。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
test('WMB-5211 knowledge compiler service contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5211-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5211-knowledge-compiler-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
