import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  createWebsiteSource,
  listSourceScanReceipts,
  readIntelligenceChannelsSummary,
  recordSourceScanReceipt,
  syncOfficialWebsiteSources
} from '../src/main/intelligence-channels.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { createSourceFeed } from '../src/main/sources.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { readCurrentWorkspaceSnapshot } from '../src/main/workspace-mcp.ts';

async function makeRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { root, database: migrateDatabase(path.join(root, 'wmb.db')) };
}

test('website sources are root-local, canonical-unique, and ready-only', async () => {
  const first = await makeRoot('wmb-intel-a-');
  const second = await makeRoot('wmb-intel-b-');
  try {
    const input = {
      inputText: 'Example updates', name: 'Example updates',
      canonicalUrl: 'https://www.example.com/updates/?utm_source=test',
      resolutionStatus: 'ready',
      trialRead: { title: 'Example updates', url: 'https://example.com/updates', readable: true }
    };
    const existingFeed = createSourceFeed(first.database, { name: 'Existing updates', url: 'https://example.com/updates' });
    const feedsBeforeReuse = first.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count;
    const one = createWebsiteSource(first.database, { ...input, sourceFeedId: existingFeed.id });
    assert.equal(one.canonicalUrl, 'https://example.com/updates');
    assert.equal(one.sourceFeedId, existingFeed.id);
    assert.equal(first.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count, feedsBeforeReuse);
    assert.throws(() => createWebsiteSource(first.database, input), /WEBSITE_SOURCE_EXISTS/);
    const two = createWebsiteSource(second.database, input);
    assert.notEqual(one.id, two.id);
    assert.notEqual(one.sourceFeedId, two.sourceFeedId);
    first.database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'workspace-a', ?, ?, 1)`).run(new Date().toISOString(), new Date().toISOString());
    second.database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'workspace-b', ?, ?, 1)`).run(new Date().toISOString(), new Date().toISOString());
    for (const [database, workspaceId, source] of [[first.database, 'workspace-a', one], [second.database, 'workspace-b', two]]) {
      recordSourceScanReceipt(database, { taskId: 'same-logical-task', workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId, checkedAt: '2026-08-03T00:00:00.000Z', status: 'succeeded' });
    }
    assert.equal(listSourceScanReceipts(first.database, { taskId: 'same-logical-task', workspaceId: 'workspace-b' }).length, 0);
    assert.equal(listSourceScanReceipts(second.database, { taskId: 'same-logical-task', workspaceId: 'workspace-a' }).length, 0);
    assert.throws(() => createWebsiteSource(first.database, { ...input, trialRead: { ...input.trialRead, readable: false } }), /WEBSITE_TRIAL_READ_REQUIRED/);
  } finally {
    first.database.close(); second.database.close();
    await Promise.all([rm(first.root, { recursive: true, force: true }), rm(second.root, { recursive: true, force: true })]);
  }
});

test('AI official registry bootstraps root-local website channels exactly once', async () => {
  const { root, database } = await makeRoot('wmb-intel-official-bootstrap-');
  try {
    const skillRoot = path.resolve('skills/wemedia-intelligence-engine');
    const first = syncOfficialWebsiteSources(database, skillRoot);
    assert.ok(first.configured >= 10);
    assert.equal(first.existing, 0);
    const sources = database.prepare(`SELECT w.canonical_url AS canonicalUrl, w.enabled, w.resolution_status AS resolutionStatus,
      w.last_checked_at AS lastCheckedAt, f.registry_id AS registryId
      FROM website_sources w JOIN source_feeds f ON f.id=w.source_feed_id ORDER BY f.registry_id`).all();
    assert.equal(sources.length, first.configured);
    assert.ok(sources.every((source) => source.registryId && source.enabled === 1 && source.resolutionStatus === 'ready'));
    assert.ok(sources.every((source) => source.lastCheckedAt === null));
    const replay = syncOfficialWebsiteSources(database, skillRoot);
    assert.deepEqual(replay, { configured: 0, existing: first.configured });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM website_sources').get().count, first.configured);
  } finally {
    database.close(); await rm(root, { recursive: true, force: true });
  }
});

test('scan receipts replay by task/module/source and project X bindings without copying identity', async () => {
  const { root, database } = await makeRoot('wmb-intel-receipts-');
  try {
    const website = createWebsiteSource(database, {
      inputText: 'Example', name: 'Example', canonicalUrl: 'https://example.com', resolutionStatus: 'ready',
      trialRead: { title: 'Example', url: 'https://example.com', readable: true }
    });
    const bindingResult = bindXList(database, {
      accountKey: '@owner',
      list: { listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@owner', name: 'AI sources', kind: 'owned' }
    });
    assert.equal(bindingResult.ok, true);
    const binding = bindingResult.data;
    const summary = readIntelligenceChannelsSummary(database);
    assert.deepEqual(summary.websites.map((item) => item.id), [website.id]);
    assert.deepEqual(summary.xLists.map((item) => item.id), [binding.id]);
    assert.equal(summary.sources.find((item) => item.module === 'x_lists').sourceId, binding.id);
    assert.equal(summary.sources.find((item) => item.module === 'x_lists').sourceFeedId, binding.sourceFeedId);
    assert.equal(summary.sources.find((item) => item.module === 'x_lists').status, 'needs_user');
    assert.equal(summary.readiness.find((item) => item.module === 'x_lists').status, 'needs_user');
    const configuredSummary = readIntelligenceChannelsSummary(database, true);
    assert.equal(configuredSummary.sources.find((item) => item.module === 'x_lists').status, 'ready');
    assert.equal(configuredSummary.readiness.find((item) => item.module === 'x_lists').status, 'ready');
    database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)`).run('workspace-a', new Date().toISOString(), new Date().toISOString());
    insertWorkspaceProfile(database, {
      profileId: 'profile.uk.test', revision: 1, officialTemplateId: 'official.uk', officialTemplateVersion: 1,
      displayName: '英国生活', audience: '测试受众', contentGoal: '测试目标', editorialBrief: '测试简报',
      intelligencePackId: 'uk-life-content-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1,
      platforms: ['x']
    });
    const snapshot = await readCurrentWorkspaceSnapshot(root, async () => ({ activeWorkspaceId: 'workspace-a', workspaces: [{ id: 'workspace-a', displayName: '英国生活', rootPath: root }] }));
    assert.deepEqual(snapshot.intelligenceChannels.sources, readIntelligenceChannelsSummary(database).sources);
    assert.throws(() => recordSourceScanReceipt(database, {
      taskId: 'bad-web-pair', workspaceId: 'workspace-a', module: 'official_web', sourceId: website.id,
      sourceFeedId: binding.sourceFeedId, status: 'succeeded'
    }), /SOURCE_IDENTITY_MISMATCH/);
    assert.throws(() => recordSourceScanReceipt(database, {
      taskId: 'bad-x-pair', workspaceId: 'workspace-a', module: 'x_lists', sourceId: binding.id,
      sourceFeedId: website.sourceFeedId, status: 'succeeded'
    }), /SOURCE_IDENTITY_MISMATCH/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 0);

    const first = recordSourceScanReceipt(database, {
      taskId: 'task-1', workspaceId: 'workspace-a', module: 'official_web', sourceId: website.id,
      sourceFeedId: website.sourceFeedId, checkedAt: '2026-08-03T00:00:00.000Z', status: 'succeeded', candidateCount: 0, savedCount: 0
    });
    const replay = recordSourceScanReceipt(database, {
      taskId: 'task-1', workspaceId: 'workspace-a', module: 'official_web', sourceId: website.id,
      sourceFeedId: website.sourceFeedId, checkedAt: '2026-08-03T00:00:00.000Z', status: 'succeeded', candidateCount: 0, savedCount: 0
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.revision, first.revision);
    const retry = recordSourceScanReceipt(database, {
      taskId: 'task-1', workspaceId: 'workspace-a', module: 'official_web', sourceId: website.id,
      sourceFeedId: website.sourceFeedId, checkedAt: '2026-08-03T00:01:00.000Z', status: 'failed', candidateCount: 2, savedCount: 1,
      errorCode: 'FETCH_FAILED', errorMessage: 'temporary'
    });
    assert.equal(retry.id, first.id);
    assert.equal(retry.revision, 2);
    assert.deepEqual(listSourceScanReceipts(database, { taskId: 'task-1' }).map(({ status, candidateCount, savedCount, errorCode }) => ({ status, candidateCount, savedCount, errorCode })), [{ status: 'failed', candidateCount: 2, savedCount: 1, errorCode: 'FETCH_FAILED' }]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 1);
    assert.throws(() => recordSourceScanReceipt(database, {
      taskId: 'task-mismatch', workspaceId: 'workspace-b', module: 'official_web', sourceId: website.id,
      sourceFeedId: website.sourceFeedId, status: 'succeeded'
    }), /WORKSPACE_ID_MISMATCH/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 1);
    database.prepare("DELETE FROM app_meta WHERE key='workspace_id'").run();
    assert.throws(() => recordSourceScanReceipt(database, {
      taskId: 'task-missing', workspaceId: 'workspace-a', module: 'official_web', sourceId: website.id,
      sourceFeedId: website.sourceFeedId, status: 'succeeded'
    }), /WORKSPACE_ID_REQUIRED/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 1);
  } finally {
    database.close(); await rm(root, { recursive: true, force: true });
  }
});
