import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  X_LIST_TIMELINE_CACHE_LIMITS,
  clearXListTimelineCache,
  readXListTimelineCache,
  summarizeXListTimelineCache,
  writeXListTimelineCache,
  writeXListTimelineCacheIfImproved
} from '../src/main/x-list-timeline-cache.ts';

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function posts(count, prefix = 'p') {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://x.com/user/status/${prefix}${index}`,
    authorHandle: '@user',
    text: `body ${prefix} ${index} ${'x'.repeat(20)}`,
    postedAt: isoMinutesAgo(index)
  }));
}

test('timeline browse cache roundtrip and failure does not clobber good snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-tl-cache-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    assert.equal(readXListTimelineCache(database, '@A', '1'), null);
    const written = writeXListTimelineCache(database, {
      accountKey: '@A',
      listId: '1',
      posts: posts(3),
      source: 'live',
      fetchedAt: isoMinutesAgo(30),
      detail: { name: 'list', canonicalUrl: 'https://x.com/i/lists/1' }
    });
    assert.equal(written.postsCount, 3);
    assert.equal(written.source, 'live');
    const kept = writeXListTimelineCacheIfImproved(database, {
      accountKey: '@A',
      listId: '1',
      posts: [],
      source: 'live',
      fetchedAt: isoMinutesAgo(1)
    });
    assert.equal(kept?.postsCount, 3);
    assert.equal(readXListTimelineCache(database, '@A', '1', { touch: false })?.postsCount, 3);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('timeline browse cache enforces per-account and global caps', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-tl-cap-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    for (let index = 0; index < X_LIST_TIMELINE_CACHE_LIMITS.maxRowsPerAccount + 5; index += 1) {
      writeXListTimelineCache(database, {
        accountKey: '@A',
        listId: String(index),
        posts: posts(1, `a${index}`),
        source: 'live',
        fetchedAt: isoMinutesAgo(index)
      });
    }
    const accountCount = database.prepare("SELECT COUNT(*) AS count FROM x_list_timeline_cache WHERE account_key='@A'").get().count;
    assert.equal(accountCount, X_LIST_TIMELINE_CACHE_LIMITS.maxRowsPerAccount);

    for (let index = 0; index < X_LIST_TIMELINE_CACHE_LIMITS.maxRowsGlobal + 10; index += 1) {
      writeXListTimelineCache(database, {
        accountKey: `@B${index}`,
        listId: '1',
        posts: posts(1, `b${index}`),
        source: 'collect',
        fetchedAt: isoMinutesAgo(index)
      });
    }
    const summary = summarizeXListTimelineCache(database);
    assert.ok(summary.rows <= X_LIST_TIMELINE_CACHE_LIMITS.maxRowsGlobal);
    const cleared = clearXListTimelineCache(database);
    assert.equal(cleared.deleted, summary.rows);
    assert.equal(summarizeXListTimelineCache(database).rows, 0);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('timeline browse cache truncates posts and drops expired empty rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-tl-trim-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const many = writeXListTimelineCache(database, {
      accountKey: '@A',
      listId: 'big',
      posts: posts(80, 'big'),
      source: 'live',
      fetchedAt: isoMinutesAgo(5)
    });
    assert.equal(many.postsCount, X_LIST_TIMELINE_CACHE_LIMITS.maxPosts);
    assert.ok(many.payloadBytes <= X_LIST_TIMELINE_CACHE_LIMITS.maxPayloadBytes);
    writeXListTimelineCache(database, {
      accountKey: '@A',
      listId: 'empty',
      posts: [],
      source: 'live',
      fetchedAt: isoMinutesAgo(1)
    });
    assert.equal(readXListTimelineCache(database, '@A', 'empty', { touch: false })?.postsCount, 0);
    const later = new Date(Date.now() + X_LIST_TIMELINE_CACHE_LIMITS.emptyTtlMs + 60_000);
    assert.equal(readXListTimelineCache(database, '@A', 'empty', { touch: false, now: later }), null);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
