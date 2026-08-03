import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { createWebsiteSource, getWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { dailyPreflightMessage } from '../src/renderer/intelligence-channel-ui.ts';

const readiness = (module, values) => ({ module, configuredCount: 0, enabledCount: 0, readyCount: 0, blockedCount: 0, status: 'needs_config', ...values });

test('Today uses authoritative readiness and always starts all enabled Discover channels', async () => {
  const summary = {
    websites: [], xLists: [], sources: [],
    readiness: [readiness('official_web', { configuredCount: 1, enabledCount: 1, readyCount: 1, status: 'ready' }), readiness('x_lists', { configuredCount: 1, enabledCount: 1, blockedCount: 1, status: 'needs_user' })]
  };
  assert.equal(dailyPreflightMessage({ summary, piConfigured: true }), null);
  assert.equal(dailyPreflightMessage({ summary: { ...summary, readiness: [readiness('official_web', {}), readiness('x_lists', { blockedCount: 1, status: 'needs_user' })] }, piConfigured: true }), '已有来源需要浏览器登录或重新确认。');
  assert.equal(dailyPreflightMessage({ summary, piConfigured: false }), '请先在设置中配置 Pi API。');

  const today = (await Promise.all([
    'today-view.tsx',
    'today-view-parts.tsx',
    'today-view-panels.tsx'
  ].map((name) => readFile(new URL(`../src/renderer/${name}`, import.meta.url), 'utf8')))).join('\n');
  const preload = await readFile(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const workspaceIntelligence = await readFile(new URL('../src/main/workspace-intelligence.ts', import.meta.url), 'utf8');
  const discover = await readFile(new URL('../src/renderer/discover-view.tsx', import.meta.url), 'utf8');
  const channels = await readFile(new URL('../src/renderer/intelligence-channels-view.tsx', import.meta.url), 'utf8');
  assert.match(today, /startDailyIntelligence\(\{ businessDate: planDate \}\)/);
  assert.doesNotMatch(today, /本次情报渠道|selectedModules|configuredCount|enabledCount|blockedCount/);
  assert.doesNotMatch(today, /没有可运行的情报渠道。|前往发现配置|openDiscover|noRunnableChannels/);
  assert.doesNotMatch(today, /跳过当前来源/);
  assert.equal((today.match(/onClick=\{\(\) => void startIntelligence\(\)\}/g) ?? []).length, 1);
  assert.match(preload, /startDailyIntelligence: \(input: \{ businessDate: string \}\)/);
  assert.doesNotMatch(preload, /startDailyIntelligence: \(input: \{ businessDate: string; modules:/);
  assert.match(main, /businessDate, modules: input\.modules, mcpUrl/);
  assert.match(discover, /IntelligenceChannelsView/);
  assert.match(discover, /: 'channels'/);
  assert.match(today, /trend\.viewsPerHour\.snapshotIds/);
  assert.match(channels, /startXObservation/);
  assert.match(channels, /15\/60\/180 分钟三个观察窗口/);
  assert.match(channels, /停止观察/);
  assert.match(today, /channel_scanned: '渠道扫描已完成'/);
  assert.match(today, /judging_opportunities: '正在生成今日运营方案'/);
  assert.match(today, /data-indeterminate=\{judgmentPhase/);
  assert.match(workspaceIntelligence, /phase: 'judging_opportunities'/);
  assert.match(workspaceIntelligence, /setInterval\([\s\S]*15_000\)/);
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
    assert.deepEqual(run.frozen.modules, ['official_web', 'x_lists']);
    assert.deepEqual(run.frozen.sources.map((source) => source.sourceId), [website.id]);
    assert.equal(run.shouldRunJudgment, true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
