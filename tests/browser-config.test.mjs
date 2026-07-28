import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, saveBrowserConfig } from '../src/main/browser.ts';

test('browser profile selection persists in app metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-config-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const config = { id: 'edge:Default', label: 'Edge', executablePath: 'edge.exe', userDataDir: 'User Data', profileDirectory: 'Default' };
    saveBrowserConfig(database, config);
    assert.deepEqual(readBrowserConfig(database), config);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
