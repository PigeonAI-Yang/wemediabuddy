import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readRankingCache, writeRankingCache } from '../src/main/ranking-cache.ts';

const sample = {
  fetchedAt: '2026-07-30T01:02:03.000Z',
  boards: [{
    id: 'github-daily',
    label: '今日',
    kind: 'rankings',
    sourceId: 'github',
    sourceLabel: 'GitHub',
    sourceUrl: 'https://github.com/trending?since=daily',
    status: 'ready',
    items: [{
      rank: 1,
      name: 'owner/repo',
      url: 'https://github.com/owner/repo',
      description: 'sample',
      language: 'TypeScript',
      stars: '100',
      gained: '10 stars today'
    }]
  }]
};

test('ranking_cache persists across reopen and overwrites the single row', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-ranking-cache-'));
  try {
    const databasePath = path.join(directory, 'wmb.db');
    const first = migrateDatabase(databasePath);
    assert.equal(readRankingCache(first), null);
    writeRankingCache(first, sample);
    assert.deepEqual(readRankingCache(first), sample);
    first.close();

    const second = migrateDatabase(databasePath);
    assert.deepEqual(readRankingCache(second), sample);
    const next = {
      ...sample,
      fetchedAt: '2026-07-30T04:05:06.000Z',
      boards: [{
        ...sample.boards[0],
        items: [{ ...sample.boards[0].items[0], name: 'owner/next', stars: '200' }]
      }]
    };
    writeRankingCache(second, next);
    assert.deepEqual(readRankingCache(second), next);
    assert.equal(second.prepare('SELECT COUNT(*) AS count FROM ranking_cache').get().count, 1);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('ranking_cache rejects malformed payload json', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-ranking-cache-bad-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    database.prepare('INSERT INTO ranking_cache (id, payload_json, fetched_at) VALUES (1, ?, ?)').run('{not-json', '2026-07-30T00:00:00.000Z');
    assert.equal(readRankingCache(database), null);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
