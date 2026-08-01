import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { canonicalizeUrl, createSourceFeed, ensureRegistrySourceFeed, getSource, searchSources, upsertSource } from '../src/main/sources.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-sources-'));
try {
  assert.equal(
    canonicalizeUrl('HTTPS://WWW.Example.com:443/a/b/?utm_source=x&fbclid=1&q=2&a=1#frag'),
    'https://example.com/a/b?a=1&q=2'
  );
  assert.equal(
    canonicalizeUrl('https://mobile.twitter.com/OpenAI/status/1?s=20&ref_src=twsrc'),
    'https://twitter.com/OpenAI/status/1'
  );
  assert.equal(
    canonicalizeUrl('https://m.x.com/OpenAI/status/2/?si=abc'),
    'https://x.com/OpenAI/status/2'
  );
  assert.equal(
    canonicalizeUrl('https://example.com/path?source=newsletter&utm_medium=email&keep=1'),
    'https://example.com/path?keep=1&source=newsletter'
  );
  assert.throws(() => canonicalizeUrl('not-a-url'), /SOURCE_URL_INVALID/);

  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const feed = createSourceFeed(database, { name: 'Example', url: 'https://example.com' });

  const first = upsertSource(database, {
    feedId: feed.id,
    originalUrl: 'https://www.example.com/a?utm_campaign=spring#section',
    title: 'First',
    categories: ['news'],
    verificationStatus: 'verified',
    managementStatus: 'watching'
  });
  assert.equal(first.created, true);

  const created = getSource(database, first.id);
  assert.equal(created?.canonicalUrl, 'https://example.com/a');
  assert.equal(created?.verificationStatus, 'verified');
  assert.equal(created?.managementStatus, 'watching');
  const collectedAt = created?.collectedAt;
  assert.ok(collectedAt);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = upsertSource(database, {
    originalUrl: 'https://example.com/a/',
    title: 'Updated',
    priority: 3
  });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.revision, 2);

  const updated = getSource(database, first.id);
  assert.equal(updated?.title, 'Updated');
  assert.equal(updated?.priority, 3);
  assert.equal(updated?.categories[0], 'news');
  assert.equal(updated?.verificationStatus, 'verified', 'status should survive partial upsert');
  assert.equal(updated?.managementStatus, 'watching');
  assert.equal(updated?.collectedAt, collectedAt, 'collectedAt is create-only');

  const statusFlip = upsertSource(database, {
    originalUrl: 'https://example.com/a?utm_source=repeat',
    title: 'Updated',
    verificationStatus: 'disputed',
    managementStatus: 'active',
    expectedRevision: second.revision
  });
  assert.equal(statusFlip.revision, 3);
  const flipped = getSource(database, first.id);
  assert.equal(flipped?.verificationStatus, 'disputed');
  assert.equal(flipped?.managementStatus, 'active');

  assert.throws(() => upsertSource(database, {
    originalUrl: 'https://example.com/a',
    title: 'stale',
    expectedRevision: 1
  }), /REVISION_CONFLICT/);

  const distinct = upsertSource(database, { originalUrl: 'https://example.com/b', title: 'Distinct URL' });
  assert.equal(distinct.created, true);
  assert.notEqual(distinct.id, first.id);

  const third = upsertSource(database, { title: 'Offline', author: 'A', summary: 'Evidence' });
  const fourth = upsertSource(database, { title: 'Offline', author: 'A', summary: 'Evidence', priority: 2 });
  assert.equal(fourth.id, third.id);
  assert.equal(fourth.created, false);

  const search = searchSources(database, 'Updated');
  assert.equal(search[0]?.id, first.id);


  const feedA = ensureRegistrySourceFeed(database, {
    registryId: 'deepseek-api-docs',
    name: 'DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/?utm_source=x'
  });
  const feedB = ensureRegistrySourceFeed(database, {
    registryId: 'deepseek-api-docs',
    name: 'DeepSeek API Docs Updated',
    url: 'https://www.api-docs.deepseek.com/'
  });
  assert.equal(feedA.created, true);
  assert.equal(feedB.created, false);
  assert.equal(feedA.id, feedB.id);
  const feedRow = database.prepare('SELECT registry_id AS registryId, name, url, revision FROM source_feeds WHERE id = ?').get(feedA.id);
  assert.equal(feedRow.registryId, 'deepseek-api-docs');
  assert.equal(feedRow.name, 'DeepSeek API Docs Updated');
  assert.equal(feedRow.url, 'https://api-docs.deepseek.com/');
  assert.equal(feedRow.revision, 2);

  const linked = upsertSource(database, {
    feedId: feedA.id,
    originalUrl: 'https://api-docs.deepseek.com/',
    title: 'DeepSeek docs heartbeat',
    clientLabel: 'deepseek-api-docs',
    categories: ['official_release']
  });
  const linkedRow = getSource(database, linked.id);
  assert.equal(linkedRow?.feedId, feedA.id);
  assert.equal(linkedRow?.clientLabel, 'deepseek-api-docs');

  const count = database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count;
  assert.equal(count, 4);

  database.close();
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
