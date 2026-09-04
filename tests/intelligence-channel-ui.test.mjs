import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { dailyAgentSessionId } from '../src/main/agent-tasks.ts';
import { createWebsiteSource, getWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { dailyPreflightMessage } from '../src/renderer/intelligence-channel-ui.ts';

const readiness = (module, values) => ({ module, configuredCount: 0, enabledCount: 0, readyCount: 0, blockedCount: 0, status: 'needs_config', ...values });

test('channel preflight reports only actionable configuration blockers', () => {
  const summary = {
    websites: [], xLists: [], sources: [],
    readiness: [readiness('official_web', { configuredCount: 1, enabledCount: 1, readyCount: 1, status: 'ready' }), readiness('x_lists', { configuredCount: 1, enabledCount: 1, blockedCount: 1, status: 'needs_user' })]
  };
  assert.equal(dailyPreflightMessage({ summary, piConfigured: true }), null);
  assert.equal(dailyPreflightMessage({ summary: { ...summary, readiness: [readiness('official_web', {}), readiness('x_lists', { blockedCount: 1, status: 'needs_user' })] }, piConfigured: true }), '已有来源需要浏览器登录或重新确认。');
  assert.equal(dailyPreflightMessage({ summary, piConfigured: false }), '请先在设置中配置 Pi API。');
});

test('daily session identity remains task-scoped', () => {
  assert.equal(dailyAgentSessionId('2026-08-05', 'task-a'), 'daily-2026-08-05-task-a');
  assert.notEqual(dailyAgentSessionId('2026-08-05', 'task-a'), dailyAgentSessionId('2026-08-05', 'task-b'));
});

test('Today default run freezes all enabled sources before daily scanning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-today-modules-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'workspace-ui', ?, ?, 1)`).run(now, now);
    const website = createWebsiteSource(database, {
      inputText: 'Example', name: 'Example', canonicalUrl: 'https://example.com', resolutionStatus: 'ready',
      trialRead: { title: 'Example', url: 'https://example.com', readable: true }
    });
    const run = await startDailyChannelRun(database, {
      businessDate: '2026-08-03', workspaceId: 'workspace-ui', profileRevision: 1
    }, {
      scanWebsite: async (db, input) => {
        const source = getWebsiteSource(db, input.sourceId);
        assert.ok(source);
        recordSourceScanReceipt(db, { taskId: input.taskId, workspaceId: input.workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId, status: 'succeeded' });
        return { source, receipt: null, sourceIds: [] };
      }
    });
    assert.deepEqual(run.frozen.modules, ['official_web', 'x_lists', 'zhihu_hot']);
    assert.ok(run.frozen.sources.some((source) => source.sourceId === website.id));
    assert.ok(run.frozen.sources.some((source) => source.module === 'zhihu_hot'));
    assert.equal(run.task.piSessionId, dailyAgentSessionId('2026-08-03', run.task.id));
    assert.equal(run.shouldRunJudgment, true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
