import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configureBrowserProfileRegistryPath,
  createInstallationBrowserProfile,
  openBrowserProfileRegistry,
  readBrowserProfileRegistry,
  setDefaultBrowserProfile
} from '../src/main/browser-config.ts';
import { resolveBrowserBinding, workspaceBrowserReady } from '../src/main/bound-browser.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } from '../src/main/workspace-browser-binding.ts';
import { startBrowser } from '../src/main/browser.ts';

test('v1 browser config preserves launch fields but discards stale CDP endpoints', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-v1-'));
  try {
    const configPath = path.join(directory, 'browser-config.json');
    const legacy = {
      id: 'edge:legacy-owner',
      label: 'Owner legacy',
      executablePath: 'legacy-edge.exe',
      userDataDir: path.join(directory, 'outside-registry-profile'),
      profileDirectory: 'Profile 3',
      cdpUrl: 'http://127.0.0.1:9334'
    };
    await writeFile(configPath, `${JSON.stringify({ version: 1, config: legacy })}\n`, 'utf8');
    const registry = readBrowserProfileRegistry(configPath);
    assert.equal(registry.version, 2);
    assert.equal(registry.revision, 1);
    assert.equal(registry.defaultProfileId, legacy.id);
    const expected = { ...legacy }; delete expected.cdpUrl;
    assert.deepEqual(registry.profiles[0], { ...expected, origin: 'v1-upgrade', createdAt: registry.profiles[0].createdAt });
    assert.equal('cdpUrl' in registry.profiles[0], false);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).version, 2);
    await assert.rejects(() => stat(legacy.userDataDir));
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('registry creates opaque installation profiles and persists default by revision CAS', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-registry-'));
  try {
    const configPath = path.join(directory, 'browser-config.json');
    const initial = openBrowserProfileRegistry(configPath);
    const initialProfile = initial.profiles[0];
    assert.match(initialProfile.id, /^[0-9a-f-]{36}$/i);
    assert.equal(initialProfile.userDataDir, path.join(directory, 'browser-profiles', initialProfile.id));
    await assert.doesNotReject(() => stat(initialProfile.userDataDir));

    const created = createInstallationBrowserProfile({ expectedRevision: initial.revision, label: 'Independent', configPath });
    assert.notEqual(created.profile.id, initialProfile.id);
    assert.equal(created.profile.userDataDir, path.join(directory, 'browser-profiles', created.profile.id));
    const selected = setDefaultBrowserProfile({ profileId: created.profile.id, expectedRevision: created.registry.revision, configPath });
    assert.equal(selected.defaultProfileId, created.profile.id);
    assert.equal(readBrowserProfileRegistry(configPath).defaultProfileId, created.profile.id);

    const beforeStale = await readFile(configPath, 'utf8');
    assert.throws(
      () => setDefaultBrowserProfile({ profileId: initialProfile.id, expectedRevision: initial.revision, configPath }),
      { code: 'PROFILE_STALE' }
    );
    assert.equal(await readFile(configPath, 'utf8'), beforeStale);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('registry rejects a dangling default profile', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-dangling-'));
  try {
    const configPath = path.join(directory, 'browser-config.json');
    const registry = openBrowserProfileRegistry(configPath);
    await writeFile(configPath, JSON.stringify({ ...registry, defaultProfileId: 'missing' }), 'utf8');
    assert.throws(() => readBrowserProfileRegistry(configPath), { code: 'BROWSER_PROFILE_MISMATCH' });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('real resolver and readiness consumer use a root non-default binding without installation fallback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-bound-resolver-'));
  try {
    const configPath = path.join(directory, 'browser-config.json');
    const registry = openBrowserProfileRegistry(configPath);
    const nonDefault = createInstallationBrowserProfile({ expectedRevision: registry.revision, label: 'Root-only', configPath }).profile;
    configureBrowserProfileRegistryPath(configPath);
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    initializeWorkspaceBrowserBinding(database, nonDefault.id);
    markWorkspaceBrowserBindingVerified(database, {
      profileId: nonDefault.id,
      expectedBindingRevision: 1,
      account: { platform: 'x', accountKey: 'root-owner', displayName: 'Root Owner', loginState: 'authenticated' }
    });
    const resolved = resolveBrowserBinding(database);
    assert.equal(resolved.profile.id, nonDefault.id);
    assert.notEqual(resolved.profile.id, registry.defaultProfileId);
    assert.equal(workspaceBrowserReady(database, 'x'), true);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('reuses the running browser for the same profile when persisted config has no CDP URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-runtime-'));
  const server = createServer((request, response) => response.writeHead(request.url === '/json/version' ? 200 : 404).end('{}'));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const cdpUrl = `http://127.0.0.1:${address.port}`;
  const config = { id: 'opaque-profile', label: 'Edge', executablePath: process.execPath, userDataDir: directory, profileDirectory: 'Default' };
  try {
    const first = await startBrowser({ ...config, cdpUrl }, { mode: 'visible' });
    const second = await startBrowser(config, { mode: 'visible' });
    assert.equal(first.cdpUrl, cdpUrl); assert.equal(second.cdpUrl, cdpUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
