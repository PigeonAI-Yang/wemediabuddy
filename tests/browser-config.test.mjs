import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { discoverBrowserProfiles, migrateBrowserConfigToInstallation, readBrowserConfig, saveBrowserConfig } from '../src/main/browser-config.ts';
import { startBrowser } from '../src/main/browser.ts';

test('installation browser config persists as one shared Edge identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-config-'));
  try {
    const configPath = path.join(directory, 'browser-config.json');
    const profilePath = path.join(directory, 'browser-profile');
    const saved = saveBrowserConfig({ id: 'legacy', label: 'Legacy', executablePath: 'edge.exe', userDataDir: profilePath, profileDirectory: 'Default' }, configPath);
    assert.equal(saved.id, 'edge:wmb-installation');
    assert.equal(saved.label, 'Edge · WMB 共享登录态');
    assert.deepEqual(readBrowserConfig(configPath), saved);
    assert.deepEqual(discoverBrowserProfiles(saved, configPath), [saved]);
    await assert.doesNotReject(() => stat(profilePath));
    await rm(profilePath, { recursive: true });
    migrateBrowserConfigToInstallation(configPath, []);
    await assert.doesNotReject(() => stat(profilePath));
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('migration adopts the existing logged-in AI profile without copying or deleting root metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-migrate-'));
  const aiRoot = path.join(directory, 'ai'); const ukRoot = path.join(directory, 'uk');
  await Promise.all([mkdir(aiRoot), mkdir(ukRoot)]);
  const ai = migrateDatabase(path.join(aiRoot, 'wmb.db')); const uk = migrateDatabase(path.join(ukRoot, 'wmb.db'));
  const now = new Date().toISOString();
  const aiConfig = { id: 'edge:pyaireader-default', label: 'legacy', executablePath: 'edge.exe', userDataDir: path.join(directory, 'logged-in'), profileDirectory: 'Default', cdpUrl: 'http://127.0.0.1:9334' };
  const ukConfig = { id: 'edge:pyaireader-workspace-uk', label: 'root', executablePath: 'edge.exe', userDataDir: path.join(ukRoot, 'browser-profile'), profileDirectory: 'Default' };
  try {
    for (const [database, config] of [[ai, aiConfig], [uk, ukConfig]]) database.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('browser.config',?,?,?,1)").run(JSON.stringify(config), now, now);
    ai.close(); uk.close();
    const configPath = path.join(directory, 'installation', 'browser-config.json');
    const result = migrateBrowserConfigToInstallation(configPath, [ukRoot, aiRoot]);
    assert.equal(result.migratedFrom, aiRoot);
    assert.equal(result.config.id, 'edge:wmb-installation');
    assert.equal(result.config.userDataDir, aiConfig.userDataDir);
    const aiRead = migrateDatabase(path.join(aiRoot, 'wmb.db')); const ukRead = migrateDatabase(path.join(ukRoot, 'wmb.db'));
    assert.equal(JSON.parse(aiRead.prepare("SELECT value FROM app_meta WHERE key='browser.config'").get().value).id, aiConfig.id);
    assert.equal(JSON.parse(ukRead.prepare("SELECT value FROM app_meta WHERE key='browser.config'").get().value).id, ukConfig.id);
    aiRead.close(); ukRead.close();
  } finally {
    try { ai.close(); } catch {} try { uk.close(); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('reuses the running browser for the same profile when persisted config has no CDP URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-runtime-'));
  const server = createServer((request, response) => response.writeHead(request.url === '/json/version' ? 200 : 404).end('{}'));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const cdpUrl = `http://127.0.0.1:${address.port}`;
  const config = { id: 'edge:wmb-installation', label: 'Edge', executablePath: process.execPath, userDataDir: directory, profileDirectory: 'Default' };
  try {
    const first = await startBrowser({ ...config, cdpUrl }, { mode: 'visible' });
    const second = await startBrowser(config, { mode: 'visible' });
    assert.equal(first.cdpUrl, cdpUrl); assert.equal(second.cdpUrl, cdpUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
