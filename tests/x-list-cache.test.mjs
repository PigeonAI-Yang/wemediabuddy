import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { listSourcesByFeed, upsertSource } from '../src/main/sources.ts';
import { readXListIndexCache, writeXListIndexCache } from '../src/main/x-list-cache.ts';
import { bindXList } from '../src/main/x-lists.ts';

const sampleIndex = {
  accountKey: '@KimbomArtist',
  lists: [{
    listId: '2082167416352579643',
    canonicalUrl: 'https://x.com/i/lists/2082167416352579643',
    name: '赚钱信息差博主',
    ownerHandle: '@KimbomArtist',
    kind: 'owned'
  }],
  observation: {
    capturedAt: '2026-07-31T01:02:03.000Z',
    pageUrl: 'https://x.com/KimbomArtist/lists',
    fingerprint: 'abc',
    visibleText: '赚钱信息差博主'
  }
};

test('x_list_index_cache persists and overwrites the single row', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-list-cache-'));
  try {
    const databasePath = path.join(directory, 'wmb.db');
    const first = migrateDatabase(databasePath);
    assert.equal(readXListIndexCache(first), null);
    writeXListIndexCache(first, sampleIndex);
    assert.deepEqual(readXListIndexCache(first), sampleIndex);
    first.close();

    const second = migrateDatabase(databasePath);
    assert.deepEqual(readXListIndexCache(second), sampleIndex);
    const next = {
      ...sampleIndex,
      observation: { ...sampleIndex.observation, capturedAt: '2026-07-31T04:05:06.000Z' },
      lists: [{ ...sampleIndex.lists[0], name: 'AI博主', listId: '1' }]
    };
    writeXListIndexCache(second, next);
    assert.deepEqual(readXListIndexCache(second), next);
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM x_list_index_cache').get().count, 1);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('bound list timeline pages through existing source_items batches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-list-feed-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const bound = bindXList(database, {
      accountKey: '@KimbomArtist',
      list: {
        listId: '2082167416352579643',
        canonicalUrl: 'https://x.com/i/lists/2082167416352579643',
        ownerHandle: '@KimbomArtist',
        name: '赚钱信息差博主',
        kind: 'owned'
      },
      observation: { source: 'test' }
    });
    assert.equal(bound.ok, true);
    for (let index = 0; index < 5; index += 1) {
      upsertSource(database, {
        feedId: bound.data.sourceFeedId,
        originalUrl: `https://x.com/user/status/${1000 + index}`,
        title: `post ${index}`,
        author: '@user',
        summary: `body ${index}`,
        publishedAt: `2026-07-31T0${index}:00:00.000Z`
      });
    }
    const page1 = listSourcesByFeed(database, bound.data.sourceFeedId, { limit: 2, offset: 0 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.hasMore, true);
    const page2 = listSourcesByFeed(database, bound.data.sourceFeedId, { limit: 2, offset: 2 });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.hasMore, true);
    const page3 = listSourcesByFeed(database, bound.data.sourceFeedId, { limit: 2, offset: 4 });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.hasMore, false);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
