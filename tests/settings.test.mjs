import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readSettings } from '../src/main/settings.ts';

test('settings reports actual configured paths, bytes, counts, and current health', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-settings-'));
  try {
    const root = await openDataRoot(path.join(parent, 'data'));
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    database.close();
    await writeFile(path.join(root.path, 'logs', 'wmb.log'), 'log');
    const boundProfile = path.join(parent, 'installation', 'browser-profiles', '11111111-1111-4111-8111-111111111111');
    await mkdir(boundProfile, { recursive: true });
    await writeFile(path.join(boundProfile, 'Cookies'), 'bound');
    await writeFile(path.join(root.path, 'browser-profile', 'Cookies'), 'legacy');
    const settings = await readSettings(root.path, { boundBrowserProfilePath: boundProfile });
    assert.equal(settings.paths.logs, path.join(root.path, 'logs'));
    assert.equal(settings.usage.logs, 3);
    assert.equal(settings.counts.migrations, 44);
    assert.equal(settings.paths.boundBrowserProfile, boundProfile);
    assert.equal(settings.paths.legacyBrowserProfile, path.join(root.path, 'browser-profile'));
    assert.equal(settings.usage.boundBrowserProfile, 5);
    assert.equal(settings.usage.legacyBrowserProfile, 6);
    assert.equal(settings.health.database, 'ready');
    assert.equal(settings.health.browser, 'not_started');
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
