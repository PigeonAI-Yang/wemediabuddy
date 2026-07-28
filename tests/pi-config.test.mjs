import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { activatePiConfig, deletePiConfig, readPiConfig } from '../src/main/pi-config.ts';

test('Pi API presets read, switch and delete without exposing keys', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-config-'));
  const root = await openDataRoot(rootPath);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run(
      'pi-api-config',
      JSON.stringify({
        activeId: 'one',
        profiles: [
          { id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', encryptedApiKey: 'secret-one' },
          { id: 'two', name: '备用接口', baseUrl: 'https://two.test/v1', model: 'model-two', encryptedApiKey: 'secret-two' }
        ]
      }),
      now,
      now
    );

    const initial = readPiConfig(database);
    assert.equal(initial.profiles.length, 2);
    assert.equal(JSON.stringify(initial).includes('secret-'), false);
    assert.equal(initial.profiles[0].active, true);

    const switched = activatePiConfig(database, 'two');
    assert.equal(switched.activeId, 'two');
    assert.equal(switched.model, 'model-two');

    const remaining = deletePiConfig(database, 'two');
    assert.equal(remaining.activeId, 'one');
    assert.deepEqual(remaining.profiles.map((profile) => profile.name), ['主接口']);
  } finally {
    database.close();
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
