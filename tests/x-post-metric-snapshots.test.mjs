import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { xMetricEvidenceMap } from '../src/main/platforms/metric-value.ts';
import { collectBoundXListTimeline } from '../src/main/x-list-execution.ts';
import { bindXList, getXListBinding } from '../src/main/x-lists.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getXPostTrend, listXPostMetricSnapshots, saveXPostMetricSnapshot } from '../src/main/x-post-metrics.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';

test('bound X collection appends truthful idempotent snapshots in one root-local transaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-post-metrics-'));
  let database;
  try {
    database = migrateDatabase(path.join(directory, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','root-a',?,?,1)").run(now, now);
    const bound = bindXList(database, {
      accountKey: '@Owner',
      list: { listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@Owner', name: 'AI', kind: 'owned' }
    });
    assert.equal(bound.ok, true);
    const evidence = xMetricEvidenceMap({ replies: 0, reposts: null, likes: 'hidden', views: '120' }, 'graphql', {
      replies: 'legacy.reply_count', reposts: 'legacy.retweet_count', likes: 'legacy.favorite_count',
      bookmarks: 'legacy.bookmark_count', views: 'views.count'
    });
    const timeline = (capturedAt, url = 'https://x.com/author/status/1') => async () => ({
      accountKey: '@Owner',
      detail: {
        listId: '123', canonicalUrl: 'https://x.com/i/lists/123', name: 'AI', ownerHandle: '@Owner', kind: 'owned',
        description: '', isPrivate: false, memberCount: 1,
        observation: { capturedAt, pageUrl: 'https://x.com/i/lists/123', fingerprint: `fp-${capturedAt}`, visibleText: 'AI' }
      },
      posts: [{
        url, authorHandle: '@author', displayName: 'Author', avatarUrl: null, text: 'post', postedAt: capturedAt,
        images: [], imageThumbs: [], hasVideo: false, videoPoster: null, videoUrl: null,
        metrics: { replies: 0, reposts: null, likes: null, bookmarks: null, views: 120 }, metricEvidence: evidence
      }],
      hasMore: false
    });
    const collect = (capturedAt, observationKey, url) => collectBoundXListTimeline(database, {
      id: 'edge:test', workspaceId: 'root-a', accountKey: '@Owner'
    }, {
      accountKey: '@Owner', listId: '123', expectedBindingId: bound.data.id, expectedRevision: bound.data.revision,
      observationKey, readTimeline: timeline(capturedAt, url)
    });
    const captured1 = new Date(Date.now() - 30 * 60_000).toISOString();
    const captured2 = new Date(Date.now() - 15 * 60_000).toISOString();
    const captured3 = new Date(Date.now() - 5 * 60_000).toISOString();

    const first = await collect(captured1, 'observation-1');
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.snapshotIds.length, 1);
    const sourceId = first.data.sourceIds[0];
    const stored = listXPostMetricSnapshots(database, sourceId);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].normalized, {
      replies: { status: 'value', value: 0 }, reposts: { status: 'unavailable' }, likes: { status: 'parse_failed' },
      bookmarks: { status: 'unavailable' }, views: { status: 'value', value: 120 }
    });
    assert.equal(stored[0].raw.likes.rawValue, 'hidden');
    assert.equal(stored[0].raw.views.rawLabel, 'views.count');
    assert.equal(stored[0].evidence.workspaceId, 'root-a');
    assert.equal(getXListBinding(database, '@Owner', '123').revision, bound.data.revision);

    const replay = await collect(captured1, 'observation-1');
    assert.equal(replay.ok, true);
    assert.equal(listXPostMetricSnapshots(database, sourceId).length, 1);
    const appended = await collect(captured2, 'observation-2');
    assert.equal(appended.ok, true, JSON.stringify(appended));
    assert.equal(appended.data.sourceIds[0], sourceId);
    assert.equal(listXPostMetricSnapshots(database, sourceId).length, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 1);

    database.exec(`CREATE TRIGGER reject_x_snapshot BEFORE INSERT ON x_post_metric_snapshots BEGIN SELECT RAISE(ABORT, 'reject snapshot'); END`);
    const sourceCount = database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count;
    const snapshotCount = database.prepare('SELECT COUNT(*) AS count FROM x_post_metric_snapshots').get().count;
    const failed = await collect(captured3, 'observation-3', 'https://x.com/author/status/2');
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'VALIDATION_ERROR');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, sourceCount);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM x_post_metric_snapshots').get().count, snapshotCount);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('X post trend uses exact two-point velocity and three-point velocity change with stable insufficient reasons', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-post-trend-'));
  let database;
  let mcp;
  try {
    database = migrateDatabase(path.join(directory, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','trend-root',?,?,1)").run(now, now);
    const bound = bindXList(database, {
      accountKey: '@Owner',
      list: { listId: '456', canonicalUrl: 'https://x.com/i/lists/456', ownerHandle: '@Owner', name: 'Trend', kind: 'owned' }
    });
    assert.equal(bound.ok, true);
    insertWorkspaceProfile(database, {
      profileId: 'profile.x-trend', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: 'X trend', audience: 'test', contentGoal: 'test', editorialBrief: 'test',
      intelligencePackId: 'game-news-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    const source = (suffix) => upsertSource(database, {
      feedId: bound.data.sourceFeedId, originalUrl: `https://x.com/author/status/${suffix}`, title: `post ${suffix}`
    }).id;
    const save = (sourceItemId, key, capturedAt, views) => saveXPostMetricSnapshot(database, {
      sourceItemId, accountKey: '@Owner', listId: '456', bindingId: bound.data.id, bindingRevision: bound.data.revision,
      observationKey: key, capturedAt,
      metrics: xMetricEvidenceMap({ views }, 'graphql', { views: 'views.count' }), evidence: { pageUrl: 'https://x.com/i/lists/456' }
    });

    const readyId = source('ready');
    save(readyId, 'ready-1', '2026-08-03T00:00:00.000Z', 100);
    save(readyId, 'ready-2', '2026-08-03T00:15:00.000Z', 160);
    save(readyId, 'ready-3', '2026-08-03T01:00:00.000Z', 400);
    const ready = getXPostTrend(database, readyId);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.viewsPerHour.value, 320);
    assert.equal(ready.velocityChange.value, 80);
    assert.deepEqual(ready.velocityChange.intervals.map((item) => item.viewsPerHour), [240, 320]);
    assert.equal('score' in ready, false);

    const shortId = source('short');
    save(shortId, 'short-1', '2026-08-03T00:00:00.000Z', 1);
    save(shortId, 'short-2', '2026-08-03T00:05:00.000Z', 2);
    assert.equal(getXPostTrend(database, shortId).reason, 'interval_too_short');

    const failedId = source('failed');
    save(failedId, 'failed-1', '2026-08-03T00:00:00.000Z', 1);
    save(failedId, 'failed-2', '2026-08-03T00:15:00.000Z', 'hidden');
    assert.equal(getXPostTrend(database, failedId).reason, 'views_parse_failed');

    const unavailableId = source('unavailable');
    save(unavailableId, 'unavailable-1', '2026-08-03T00:00:00.000Z', 1);
    save(unavailableId, 'unavailable-2', '2026-08-03T00:15:00.000Z', undefined);
    assert.equal(getXPostTrend(database, unavailableId).reason, 'views_unavailable');

    const decreasedId = source('decreased');
    save(decreasedId, 'decreased-1', '2026-08-03T00:00:00.000Z', 10);
    save(decreasedId, 'decreased-2', '2026-08-03T00:15:00.000Z', 9);
    assert.equal(getXPostTrend(database, decreasedId).reason, 'views_decreased');
    const sameTimeId = source('same-time');
    save(sameTimeId, 'same-time-1', '2026-08-03T00:00:00.000Z', 1);
    save(sameTimeId, 'same-time-2', '2026-08-03T00:00:00.000Z', 2);
    assert.equal(getXPostTrend(database, sameTimeId).reason, 'capture_time_not_increasing');
    assert.equal(getXPostTrend(database, source('single')).reason, 'insufficient_samples');
    assert.equal(getXPostTrend(database, 'missing').reason, 'source_not_found');

    database.close(); database = undefined;
    mcp = await startMcp(directory);
    const initialized = await mcpRequest(mcp.url, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x-post-trend-test', version: '1' }
    });
    const listed = await mcpRequest(mcp.url, 'tools/list', {}, initialized.sessionId);
    assert.ok(listed.data.tools.some((tool) => tool.name === 'x_lists.post_metric_snapshots_list'));
    assert.ok(listed.data.tools.some((tool) => tool.name === 'x_lists.post_trend_get'));
    const called = await mcpRequest(mcp.url, 'tools/call', {
      name: 'x_lists.post_trend_get', arguments: { source_id: readyId }
    }, initialized.sessionId);
    const payload = JSON.parse(called.data.content[0].text);
    assert.equal(payload.viewsPerHour.value, 320);
    assert.equal(payload.velocityChange.value, 80);
    assert.equal('score' in payload, false);
  } finally {
    await mcp?.close();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
