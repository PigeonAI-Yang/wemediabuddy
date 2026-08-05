import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openBrowserProfileRegistry, readBrowserProfileRegistry } from '../src/main/browser-config.ts';
import { migrateLegacyBrowserProfile } from '../src/main/browser-profile-migration.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { initializeWorkspaceBrowserBinding, readWorkspaceBrowserBinding } from '../src/main/workspace-browser-binding.ts';

const account = { platform: 'x', accountKey: 'owner', displayName: 'Owner', loginState: 'authenticated' };
const digest = (content) => createHash('sha256').update(content).digest('hex');

async function fixture(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sourceRootPath = path.join(directory, 'legacy-root');
  const sourceProfilePath = path.join(sourceRootPath, 'browser-profile');
  const registryPath = path.join(directory, 'installation', 'browser-config.json');
  const databasePath = path.join(sourceRootPath, 'wmb.db');
  await mkdir(sourceProfilePath, { recursive: true });
  await writeFile(path.join(sourceProfilePath, 'Cookies'), Buffer.from([0, 1, 2, 3, 255]));
  const registry = openBrowserProfileRegistry(registryPath);
  const database = migrateDatabase(databasePath);
  initializeWorkspaceBrowserBinding(database, registry.defaultProfileId);
  return { directory, sourceRootPath, sourceProfilePath, registryPath, databasePath, registry, database };
}

test('legacy copy waits for the stopped-browser gate, preserves source bytes, and binds only after verification', async () => {
  const item = await fixture('wmb-legacy-success-');
  try {
    const before = await readFile(path.join(item.sourceProfilePath, 'Cookies'));
    let stopped = false;
    const result = await migrateLegacyBrowserProfile({
      sourceRootPath: item.sourceRootPath,
      registryPath: item.registryPath,
      database: item.database,
      expectedRegistryRevision: item.registry.revision,
      expectedBindingRevision: 1,
      ensureBrowsersStopped: async () => { stopped = true; },
      verifyProfile: async (profile) => {
        assert.equal(stopped, true);
        assert.equal(await readFile(path.join(profile.userDataDir, 'Cookies')).then(digest), digest(before));
        return { ok: true, account };
      }
    });
    assert.equal(result.verified, true);
    assert.equal(result.binding.state, 'verified');
    assert.equal(result.binding.profileId, result.profile.id);
    assert.equal(result.binding.expectedAccountSnapshot.x.accountKey, 'owner');
    assert.equal(await readFile(path.join(item.sourceProfilePath, 'Cookies')).then(digest), digest(before));
    assert.equal(result.profile.userDataDir, path.join(path.dirname(item.registryPath), 'browser-profiles', result.profile.id));
    item.database.close();

    const reopenedRegistry = readBrowserProfileRegistry(item.registryPath);
    const reopenedDatabase = migrateDatabase(item.databasePath);
    assert.equal(reopenedRegistry.profiles.some((profile) => profile.id === result.profile.id), true);
    assert.equal(readWorkspaceBrowserBinding(reopenedDatabase).profileId, result.profile.id);
    reopenedDatabase.close();
  } finally {
    try { item.database.close(); } catch {}
    await rm(item.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('verification failure keeps the registered copy in needs_user and a retry can verify a new copy', async () => {
  const item = await fixture('wmb-legacy-retry-');
  try {
    const sourceBefore = await readFile(path.join(item.sourceProfilePath, 'Cookies')).then(digest);
    const failed = await migrateLegacyBrowserProfile({
      sourceRootPath: item.sourceRootPath,
      registryPath: item.registryPath,
      database: item.database,
      expectedRegistryRevision: 1,
      expectedBindingRevision: 1,
      ensureBrowsersStopped: async () => {},
      verifyProfile: async () => ({ ok: false, error: { code: 'BROWSER_NEEDS_USER', message: 'login required' } })
    });
    assert.equal(failed.verified, false);
    assert.equal(failed.binding.state, 'needs_user');
    assert.equal(failed.binding.profileId, failed.profile.id);
    assert.equal(await readFile(path.join(item.sourceProfilePath, 'Cookies')).then(digest), sourceBefore);
    await assert.doesNotReject(() => stat(failed.profile.userDataDir));

    const retry = await migrateLegacyBrowserProfile({
      sourceRootPath: item.sourceRootPath,
      registryPath: item.registryPath,
      database: item.database,
      expectedRegistryRevision: 2,
      expectedBindingRevision: 3,
      ensureBrowsersStopped: async () => {},
      verifyProfile: async () => ({ ok: true, account })
    });
    assert.equal(retry.verified, true);
    assert.equal(retry.binding.bindingRevision, 5);
    assert.equal((readBrowserProfileRegistry(item.registryPath)).profiles.length, 3);
    await assert.doesNotReject(() => stat(failed.profile.userDataDir));
  } finally {
    item.database.close();
    await rm(item.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('blocked and exceptional migrations preserve source bytes and early rejection writes nothing', async () => {
  const blocked = await fixture('wmb-legacy-blocked-');
  try {
    const before = readWorkspaceBrowserBinding(blocked.database);
    const sourceBefore = await readFile(path.join(blocked.sourceProfilePath, 'Cookies')).then(digest);
    await assert.rejects(() => migrateLegacyBrowserProfile({
      sourceRootPath: blocked.sourceRootPath,
      registryPath: blocked.registryPath,
      database: blocked.database,
      expectedRegistryRevision: 1,
      expectedBindingRevision: 1,
      ensureBrowsersStopped: async () => { throw Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY' }); },
      verifyProfile: async () => ({ ok: true, account })
    }), { code: 'WORKSPACE_BUSY' });
    assert.deepEqual(readWorkspaceBrowserBinding(blocked.database), before);
    assert.equal(readBrowserProfileRegistry(blocked.registryPath).profiles.length, 1);
    assert.equal(await readFile(path.join(blocked.sourceProfilePath, 'Cookies')).then(digest), sourceBefore);
  } finally {
    blocked.database.close();
    await rm(blocked.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  const exceptional = await fixture('wmb-legacy-exception-');
  try {
    const sourceBefore = await readFile(path.join(exceptional.sourceProfilePath, 'Cookies')).then(digest);
    await assert.rejects(() => migrateLegacyBrowserProfile({
      sourceRootPath: exceptional.sourceRootPath,
      registryPath: exceptional.registryPath,
      database: exceptional.database,
      expectedRegistryRevision: 1,
      expectedBindingRevision: 1,
      ensureBrowsersStopped: async () => {},
      verifyProfile: async () => { throw new Error('probe crashed'); }
    }), /probe crashed/);
    assert.equal(await readFile(path.join(exceptional.sourceProfilePath, 'Cookies')).then(digest), sourceBefore);
    assert.equal(readBrowserProfileRegistry(exceptional.registryPath).profiles.length, 2);
  } finally {
    exceptional.database.close();
    await rm(exceptional.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('legacy migration rejects nested links without copying or mutating the source', async () => {
  const item = await fixture('wmb-legacy-link-');
  try {
    const outside = path.join(item.directory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'not-owned');
    await symlink(outside, path.join(item.sourceProfilePath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = await readFile(path.join(item.sourceProfilePath, 'Cookies')).then(digest);
    await assert.rejects(() => migrateLegacyBrowserProfile({
      sourceRootPath: item.sourceRootPath,
      registryPath: item.registryPath,
      database: item.database,
      expectedRegistryRevision: 1,
      expectedBindingRevision: 1,
      ensureBrowsersStopped: async () => {},
      verifyProfile: async () => ({ ok: true, account })
    }), { code: 'VALIDATION_ERROR' });
    assert.equal(await readFile(path.join(item.sourceProfilePath, 'Cookies')).then(digest), before);
    assert.equal(readBrowserProfileRegistry(item.registryPath).profiles.length, 1);
  } finally {
    item.database.close();
    await rm(item.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('legacy migration rejects a source tree changed during copy and removes unpublished output', async () => {
  const item = await fixture('wmb-legacy-race-');
  try {
    let stoppedChecks = 0;
    await assert.rejects(() => migrateLegacyBrowserProfile({
      sourceRootPath: item.sourceRootPath,
      registryPath: item.registryPath,
      database: item.database,
      expectedRegistryRevision: 1,
      expectedBindingRevision: 1,
      ensureBrowsersStopped: async () => {
        stoppedChecks += 1;
        if (stoppedChecks === 2) await writeFile(path.join(item.sourceProfilePath, 'Cookies'), 'changed-during-copy');
      },
      verifyProfile: async () => ({ ok: true, account })
    }), { code: 'WORKSPACE_BUSY' });
    assert.equal(stoppedChecks, 2);
    assert.equal(readBrowserProfileRegistry(item.registryPath).profiles.length, 1);
    const profiles = await readdir(path.join(path.dirname(item.registryPath), 'browser-profiles'));
    assert.equal(profiles.some((name) => name.startsWith('.staging-')), false);
  } finally {
    item.database.close();
    await rm(item.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
