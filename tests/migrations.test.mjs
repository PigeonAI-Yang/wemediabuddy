import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';

test('migrations apply once and survive reopening', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-db-'));
  const databasePath = path.join(directory, 'wmb.db');
  try {
    {
      const first = migrateDatabase(databasePath);
      assert.equal(first.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 14);
      first.close();
    }
    {
      const second = migrateDatabase(databasePath);
      assert.equal(second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 14);
      assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get());
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
