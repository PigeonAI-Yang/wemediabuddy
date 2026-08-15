import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * WMB-5240 固定版本 Query/写回串联聚焦测试（父进程）。
 * 子进程（真实 SQLite + 真实 ActiveWorkspaceRuntime）覆盖：
 * 1. runFixedVersionQuery 按 ref/裸 id 读取真实冻结 Wiki/Note/Evidence 版本，内容与 DB 一致、
 *    versionRefs 幂等、workspace 绑定；
 * 2. 读回 id 直连既有 settle 写回：restatement 零知识（仅 Artifact+Receipt）、
 *    new_synthesis 基于读回 Note 版本写回（basedOn ⊆ read）、同问重放 duplicate 零增量；
 * 3. fail-closed：幽灵版本（删除）→ 读面 FIXED_VERSION_NOT_FOUND + 写回 QUERY_WRITEBACK_VERSION_NOT_FOUND 零写；
 *    引用漂移（versionId 不属于 objectId）→ FIXED_VERSION_DRIFT；语法非法 → FIXED_VERSION_REF_INVALID；
 *    跨 workspace id → FIXED_VERSION_NOT_FOUND（结构性隔离）；
 *    每类 >64 → 读面 FIXED_VERSION_LIMIT_EXCEEDED / 写回输入面 INVALID / manifest 超限零写；
 * 4. 回答与写回结果均用户可见：settle 正文原样返回（剥离协议块）、摘要投影 artifact+settle；
 *    无清单零写原因可见、未知 requestId settle null。
 * 退出码 0 = 全部通过。
 */
test('WMB-5240 fixed-version query/writeback bridge (real SQLite round-trip)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5240-fvq-parent-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/fixed-version-query-bridge-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
