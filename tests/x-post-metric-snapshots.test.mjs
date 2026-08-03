import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { xMetricEvidenceMap } from '../src/main/platforms/metric-value.ts';
import { collectBoundXListTimeline } from '../src/main/x-list-execution.ts';
import { bindXList, getXListBinding } from '../src/main/x-lists.ts';
import { listXPostMetricSnapshots } from '../src/main/x-post-metrics.ts';

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
