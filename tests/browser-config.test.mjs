import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { discoverBrowserProfiles, readBrowserConfig, saveBrowserConfig, startBrowser } from '../src/main/browser.ts';

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

test('legacy AI browser remains selectable without exposing the retired provider name', () => {
  const options = discoverBrowserProfiles('C:/wmb-root', {
    id: 'edge:pyaireader-default', label: 'Edge · Pyaireader 独立登录态', executablePath: 'edge.exe',
    userDataDir: 'C:/legacy', profileDirectory: 'Default', cdpUrl: 'http://127.0.0.1:9334'
  });
  assert.equal(options.length, 2);
  assert.equal(options[0].label, 'Edge · 旧版共享 X 登录态（仅 AI 工作空间）');
  assert.doesNotMatch(options.map((item) => item.label).join(' '), /pyaireader/i);
});

test('reuses the running browser for the same profile when persisted config has no CDP URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-browser-runtime-'));
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/json/version' ? 200 : 404).end('{}');
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const cdpUrl = `http://127.0.0.1:${address.port}`;
  const config = {
    id: 'edge:pyaireader-workspace-test', label: 'Edge', executablePath: process.execPath,
    userDataDir: directory, profileDirectory: 'Default'
  };
  try {
    const first = await startBrowser({ ...config, cdpUrl }, { mode: 'visible' });
    const second = await startBrowser(config, { mode: 'visible' });
    assert.equal(first.cdpUrl, cdpUrl);
    assert.equal(second.cdpUrl, cdpUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
