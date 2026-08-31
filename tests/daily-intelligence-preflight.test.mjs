import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { bindXList } from '../src/main/x-lists.ts';

/**
 * WMB-5137 聚焦测试（Backend 第 2 项：X 预检失败渠道隔离）。
 * 用 stub 浏览器会话（注入 preflight 结果）模拟 2026-08-09 11:41 identifyXAccount
 * 对 SideNav_AccountSwitcher_Button 15s 超时（无 code Error），验证：
 * - 非用户态预检异常逐 X 来源落可追踪 failed 回执（渠道标识 + code + message）；
 * - official_web 照常扫描推进；预检失败不使整个工单 failed；
 * - 全部 blocked 时按 needs_user/failed 聚合（本文件覆盖 failed 聚合；needs_user 聚合由既有用例覆盖）。
 * 无真实平台发布/互动、无真实网络。
 */

async function makeRoot(prefix = 'wmb-daily-preflight-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const workspaceId = `${prefix.replace(/[^a-z]/gi, '')}-workspace`;
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(workspaceId, now, now);
  return { root, database, workspaceId };
}

function website(database, slug) {
  const url = `https://example.com/${slug}`;
  return createWebsiteSource(database, {
    inputText: url,
    name: `Example ${slug}`,
    canonicalUrl: url,
    resolutionStatus: 'ready',
    trialRead: { title: `Example ${slug}`, url, readable: true, summary: 'A readable source page for the preflight isolation test.' }
  });
}

function recordWebsiteSuccess(database, taskId, workspaceId, source, savedCount = 0) {
  return recordSourceScanReceipt(database, {
    taskId, workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId,
    status: 'succeeded', candidateCount: savedCount, savedCount
  });
}

// 2026-08-09 11:41 fixture：identifyXAccount 对 SideNav_AccountSwitcher_Button 15s 超时 → 无 code Error。
const IDENTIFY_X_TIMEOUT_PREFLIGHT = { config: null, preflightError: { code: 'CHANNEL_SCAN_FAILED', message: 'Timeout 15000ms exceeded.' } };

test('X preflight failure records per-source failed receipts and official_web still scans (partial)', async () => {
  const current = await makeRoot('wmb-daily-preflight-');
  try {
    const web = website(current.database, 'preflight-web');
    const bound = bindXList(current.database, {
      accountKey: '@owner', list: { listId: '303', canonicalUrl: 'https://x.com/i/lists/303', ownerHandle: '@owner', name: 'Preflight X list', kind: 'owned' }
    });
    assert.equal(bound.ok, true);
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web', 'x_lists']
    }, {
      preflight: async () => IDENTIFY_X_TIMEOUT_PREFLIGHT,
      scanWebsite: async (database, input) => {
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, web, 1);
      }
    });
    assert.equal(run.shouldRunJudgment, true, '预检失败不阻断判断（库存资料继续）');
    assert.equal(run.aggregation?.status, 'partial', '官网成功 + X 预检失败 = partial');
    assert.equal(run.task.status, 'running', '预检失败不使整个工单 failed（任务继续由判断收尾）');
    const rows = current.database.prepare('SELECT module, source_id AS sourceId, status, error_code AS errorCode, error_message AS errorMessage FROM source_scan_receipts WHERE task_id=?').all(run.task.id);
    const x = rows.find((row) => row.module === 'x_lists');
    assert.ok(x, 'X 渠道回执存在');
    assert.equal(x.sourceId, bound.data.id, '回执带渠道标识（binding id）');
    assert.equal(x.status, 'failed');
    assert.equal(x.errorCode, 'CHANNEL_SCAN_FAILED');
    assert.match(x.errorMessage, /X 浏览器预检失败/);
    assert.match(x.errorMessage, /Timeout 15000ms exceeded/, '回执保留原始原因');
    const webRow = rows.find((row) => row.module === 'official_web');
    assert.ok(webRow, '官网渠道照常扫描并产生回执');
    assert.equal(webRow.status, 'succeeded');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('all X sources preflight-failed aggregate failed and continue on inventory (needs_user/failed 聚合)', async () => {
  const current = await makeRoot('wmb-daily-preflight-all-');
  try {
    const bound = bindXList(current.database, {
      accountKey: '@owner', list: { listId: '404', canonicalUrl: 'https://x.com/i/lists/404', ownerHandle: '@owner', name: 'Only X list', kind: 'owned' }
    });
    assert.equal(bound.ok, true);
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web', 'x_lists']
    }, {
      preflight: async () => IDENTIFY_X_TIMEOUT_PREFLIGHT
    });
    assert.equal(run.shouldRunJudgment, true, '全部渠道预检失败仍基于库存资料继续判断');
    assert.equal(run.aggregation?.status, 'failed', '全部 X 预检失败按 failed 聚合');
    const rows = current.database.prepare('SELECT module, status, error_code AS errorCode, error_message AS errorMessage FROM source_scan_receipts WHERE task_id=?').all(run.task.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].module, 'x_lists');
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].errorCode, 'CHANNEL_SCAN_FAILED');
    assert.match(rows[0].errorMessage, /Timeout 15000ms exceeded/);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});
