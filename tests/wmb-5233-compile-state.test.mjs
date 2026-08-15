import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5233 空壳健康三态聚焦测试（父进程）：全部在子进程真实 SQLite 上执行。
 * 覆盖：零知识 / legacy-init / 真实编译 三种工作区在 Topic / Library(列表) / Canvas
 * 读模型显示诚实三态（uncompiled / legacy_shell / compiled），空壳不得显示 current/已编译；
 * Lint 对合法空壳零伪造 issue、零写，对 stale/broken/disputed 保持既有检测与修复边界；
 * 三态判定只读（不写 schema/DB CHECK/compile_status）。退出码 0 = 全部通过。
 */
test('WMB-5233 compile state honest three-state contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5233-state-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5233-compile-state-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
