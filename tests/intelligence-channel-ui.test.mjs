import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { createWebsiteSource, getWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { dailyPreflightMessage, intelligenceModules } from '../src/renderer/intelligence-channel-ui.ts';

const readiness = (module, values) => ({ module, configuredCount: 0, enabledCount: 0, readyCount: 0, blockedCount: 0, status: 'needs_config', ...values });

test('Today preflight uses the authoritative module readiness and preserves the selected payload', async () => {
  const summary = {
    websites: [], xLists: [], sources: [],
    readiness: [readiness('official_web', { configuredCount: 1, enabledCount: 1, readyCount: 1, status: 'ready' }), readiness('x_lists', { configuredCount: 1, enabledCount: 1, blockedCount: 1, status: 'needs_user' })]
  };
  assert.deepEqual(intelligenceModules, ['official_web', 'x_lists']);
  assert.equal(dailyPreflightMessage({ summary, piConfigured: true, modules: ['official_web'] }), null);
  assert.equal(dailyPreflightMessage({ summary, piConfigured: true, modules: ['x_lists'] }), '已选来源需要浏览器登录或重新确认。');
  assert.equal(dailyPreflightMessage({ summary, piConfigured: false, modules: ['official_web'] }), '请先在设置中配置 Pi API。');
  assert.equal(dailyPreflightMessage({ summary, piConfigured: true, modules: [] }), '请至少选择一个情报模块。');

  const today = await readFile(new URL('../src/renderer/today-library-view.tsx', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const discover = await readFile(new URL('../src/renderer/discover-view.tsx', import.meta.url), 'utf8');
  const channels = await readFile(new URL('../src/renderer/intelligence-channels-view.tsx', import.meta.url), 'utf8');
  assert.match(today, /startDailyIntelligence\(\{ businessDate: planDate, modules: selectedModules \}\)/);
  assert.doesNotMatch(today, /跳过当前来源/);
  assert.match(today, /className="action-go" disabled=\{running \|\| Boolean\(preflightMessage\)\}/);
  assert.match(preload, /startDailyIntelligence: \(input: \{ businessDate: string; modules:/);
  assert.match(main, /businessDate, modules: input\.modules, mcpUrl/);
  assert.match(discover, /IntelligenceChannelsView/);
  assert.match(discover, /: 'channels'/);
  assert.match(today, /trend\.viewsPerHour\.snapshotIds/);
  assert.match(channels, /startXObservation/);
  assert.match(channels, /15\/60\/180 分钟三个观察窗口/);
  assert.match(channels, /停止观察/);
});

test('selected Today modules freeze only their enabled sources before daily scanning', async () => {
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
      businessDate: '2026-08-03', workspaceId: 'workspace-ui', profileRevision: 1, modules: ['official_web']
    }, {
      scanWebsite: async (db, input) => {
        const source = getWebsiteSource(db, input.sourceId);
        assert.ok(source);
        recordSourceScanReceipt(db, { taskId: input.taskId, workspaceId: input.workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId, status: 'succeeded' });
        return { source, receipt: null, sourceIds: [] };
      }
    });
    assert.deepEqual(run.frozen.modules, ['official_web']);
    assert.deepEqual(run.frozen.sources.map((source) => source.sourceId), [website.id]);
    assert.equal(run.shouldRunJudgment, true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
