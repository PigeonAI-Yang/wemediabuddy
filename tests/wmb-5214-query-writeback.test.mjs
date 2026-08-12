import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5214 Query 写回服务聚焦测试（父进程）：全部在子进程真实 SQLite 上执行。
 * 覆盖：纯复述零知识（仅 Artifact + Receipt）；新综合去重后 ChangeSet 创建/更新 Synthesis Wiki
 * 且追溯冻结读取版本（basedOn ⊆ read、derived_from 证据、回答本身不是证据）；同问幂等（同
 * requestId 零写）；同陈述跨轮零重复；用户经验先保存 FreeNote；失败零写（basedOn 不在读取集 /
 * 经验冒充回答 / 幽灵版本 / 复述零读取 / 非法分类）；manifest 严格解析与剥离；风险标记与
 * 每轮摘要；requestId 约定；主查询服务冻结版本读取面。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
test('WMB-5214 query writeback service contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5214-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5214-query-writeback-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
