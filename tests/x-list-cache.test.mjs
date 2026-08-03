import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { listSourcesByFeed, upsertSource } from '../src/main/sources.ts';
import { readXListIndexCache, writeXListIndexCache } from '../src/main/x-list-cache.ts';
import { clearXListPostCache, readXListPostCache, writeXListPostCache } from '../src/main/x-list-post-cache.ts';
import { readXListTimelineCache, writeXListTimelineCache } from '../src/main/x-list-timeline-cache.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { readXListTimeline, seedListTimelineMemory } from '../src/main/platforms/x-list-browser.ts';

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

test('process caches stay scoped by workspace and account before a hit', async () => {
  const url = 'https://x.com/a/status/99';
  const post = { url, authorHandle: '@a', displayName: 'A', avatarUrl: null, text: 'root A', postedAt: null, images: [], imageThumbs: [], hasVideo: false, videoPoster: null, metrics: { replies: null, reposts: null, likes: null, bookmarks: null, views: null }, replies: [], hasMoreReplies: false };
  writeXListPostCache({ workspaceId: 'root-a', browserId: 'browser-a', accountKey: '@A' }, url, { accountKey: '@A', post });
  assert.equal(readXListPostCache({ workspaceId: 'root-b', browserId: 'browser-a', accountKey: '@A' }, url), null);
  assert.equal(readXListPostCache({ workspaceId: 'root-a', browserId: 'browser-b', accountKey: '@A' }, url), null);
  assert.equal(readXListPostCache({ workspaceId: 'root-a', browserId: 'browser-a', accountKey: '@B' }, url), null);
  assert.equal(readXListPostCache({ workspaceId: 'root-a', browserId: 'browser-a', accountKey: '@A' }, url)?.post.text, 'root A');
  clearXListPostCache();

  seedListTimelineMemory({ workspaceId: 'root-a', browserId: 'test-a', accountKey: '@A', listId: '123', posts: [
    { url: 'https://x.com/a/status/1', text: 'known A' }, { url: 'https://x.com/a/status/2', text: 'only A' }
  ] });
  seedListTimelineMemory({ workspaceId: 'root-b', browserId: 'test-b', accountKey: '@B', listId: '123', posts: [
    { url: 'https://x.com/b/status/1', text: 'known B' }, { url: 'https://x.com/b/status/2', text: 'only B' }
  ] });
  const a = await readXListTimeline({ id: 'test-a', workspaceId: 'root-a', accountKey: '@A' }, '123', 10, { knownUrls: ['https://x.com/a/status/1'] });
  const b = await readXListTimeline({ id: 'test-b', workspaceId: 'root-b', accountKey: '@B' }, '123', 10, { knownUrls: ['https://x.com/b/status/1'] });
  assert.deepEqual([a.accountKey, a.posts.map((item) => item.text)], ['@A', ['only A']]);
  assert.deepEqual([b.accountKey, b.posts.map((item) => item.text)], ['@B', ['only B']]);
});

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

test('timeline cache preserves repost and nested quote structure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-list-social-cache-'));
  let database;
  try {
    database = migrateDatabase(path.join(directory, 'wmb.db'));
    writeXListTimelineCache(database, { accountKey: '@owner', listId: 'social', source: 'live', posts: [{
      url: 'https://x.com/original/status/1', authorHandle: '@original', text: 'original', postedAt: null,
      postKind: 'repost', repostedBy: { handle: '@reposter', displayName: 'Reposter', avatarUrl: 'https://example.com/reposter.jpg' }
    }, {
      url: 'https://x.com/author/status/2', authorHandle: '@author', text: 'comment', postedAt: null,
      postKind: 'quote', quotedPost: {
        url: 'https://x.com/quoted/status/3', authorHandle: '@quoted', text: 'quoted body', postedAt: null,
        postKind: 'tweet', metrics: { replies: 1, reposts: 2, likes: 3, bookmarks: 4, views: 5 }
      }
    }] });
    const posts = readXListTimelineCache(database, '@owner', 'social')?.payload.posts ?? [];
    assert.equal(posts[0]?.postKind, 'repost');
    assert.equal(posts[0]?.repostedBy?.handle, '@reposter');
    assert.equal(posts[1]?.postKind, 'quote');
    assert.equal(posts[1]?.quotedPost?.authorHandle, '@quoted');
    assert.equal(posts[1]?.quotedPost?.metrics?.views, 5);
  } finally {
    database?.close();
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
