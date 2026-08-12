import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5212 主题与资料库后端读模型聚焦测试（父进程）：全部在子进程真实 SQLite 上执行。
 * 覆盖：Topic Wiki 详情（current/version/change/evidence/creation impact/questions/dossier）、
 * Source 详情（Raw 关联/Evidence/receipt）、Inbox 与 Health 列表、准确 topic/source 深链、
 * stale/failed/disputed/inference 读回、有界分页、过滤扩展。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
test('WMB-5212 topic/library backend read models contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5212-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5212-topic-library-read-models-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
