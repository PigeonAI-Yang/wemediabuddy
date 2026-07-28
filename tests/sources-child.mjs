import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createSourceFeed, getSource, searchSources, upsertSource } from '../src/main/sources.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-sources-'));
try {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const feed = createSourceFeed(database, { name: 'Example', url: 'https://example.com' });
  const first = upsertSource(database, { feedId: feed.id, originalUrl: 'https://example.com/a#section', title: 'First', categories: ['news'] });
  const second = upsertSource(database, { originalUrl: 'https://example.com/a', title: 'Updated', priority: 3 });
  const distinct = upsertSource(database, { originalUrl: 'https://example.com/b', title: 'Distinct URL' });
  const third = upsertSource(database, { title: 'Offline', author: 'A', summary: 'Evidence' });
  const fourth = upsertSource(database, { title: 'Offline', author: 'A', summary: 'Evidence', priority: 2 });
  const updated = getSource(database, first.id);
  const search = searchSources(database, 'Updated');
  const count = database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count;
  const mismatch = !first.created || second.id !== first.id || second.revision !== 2 || updated?.categories[0] !== 'news'
    || updated?.priority !== 3 || search[0]?.id !== first.id || !distinct.created || distinct.id === first.id
    || !third.created || fourth.id !== third.id || count !== 3;
  database.close();
  if (mismatch) throw new Error('source dedupe mismatch');
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
