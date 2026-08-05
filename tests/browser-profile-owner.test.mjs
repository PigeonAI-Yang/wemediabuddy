import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { openBrowserProfileRegistry } from '../src/main/browser-config.ts';
import { createBrowserProfileOwner } from '../src/main/browser-profile-owner.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } from '../src/main/workspace-browser-binding.ts';
import { writeRootWorkspaceId } from '../src/main/workspaces.ts';

const rows = (database) => ({
  binding: database.prepare("SELECT * FROM workspace_browser_bindings WHERE id='effective'").get(),
  accounts: database.prepare('SELECT * FROM platform_accounts ORDER BY platform').all()
});

test('Owner account mismatch leaves durable binding and platform accounts byte-for-byte unchanged', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-owner-mismatch-'));
  const rootPath = path.join(directory, 'root');
  const databasePath = path.join(rootPath, 'wmb.db');
  const registryPath = path.join(directory, 'installation', 'browser-config.json');
  let database;
  let reopened;
  try {
    await mkdir(rootPath, { recursive: true });
    const registry = openBrowserProfileRegistry(registryPath);
    migrateDatabase(databasePath).close();
    writeRootWorkspaceId(rootPath, 'workspace-owner');
    database = migrateDatabase(databasePath);
    initializeWorkspaceBrowserBinding(database, registry.defaultProfileId);
    const verified = markWorkspaceBrowserBindingVerified(database, {
      profileId: registry.defaultProfileId,
      expectedBindingRevision: 1,
      account: { platform: 'x', accountKey: 'expected-owner', displayName: 'Expected Owner', loginState: 'authenticated' }
    });
    const before = rows(database);
    database.close();
    database = null;

    const owner = createBrowserProfileOwner({
      registryPath,
      relaunchCurrentWorkspace: async (apply) => apply(),
      stopBrowserSessions: async () => {},
      setBrowser: () => {},
      identifyAccount: async () => ({ platform: 'x', accountKey: 'different-owner', displayName: 'Different Owner', loginState: 'authenticated' })
    });
    await assert.rejects(() => owner.verify(rootPath, {
      workspaceId: 'workspace-owner', expectedBindingRevision: verified.bindingRevision,
      expectedRegistryRevision: registry.revision, platform: 'x'
    }), { code: 'ACCOUNT_MISMATCH' });
    reopened = migrateDatabase(databasePath);
    assert.deepEqual(rows(reopened), before);
  } finally {
    reopened?.close();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
