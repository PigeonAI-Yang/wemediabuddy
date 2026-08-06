import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ownerChannels = [
  'browser-profiles:create',
  'workspace-browser:rebind',
  'workspace-browser:verify',
  'workspace-browser:migrate-legacy'
];

test('browser profile writes are exposed only by the Owner preload surface', async () => {
  const [preload, mcp, settingsIpc] = await Promise.all([
    readFile('src/preload/preload.ts', 'utf8'),
    readFile('src/main/mcp.ts', 'utf8'),
    readFile('src/main/ipc-settings-config.ts', 'utf8')
  ]);
  for (const channel of ownerChannels) {
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(settingsIpc, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(mcp, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(preload, /browser:configure|browser:start/);
  assert.doesNotMatch(settingsIpc, /browser:configure/);
});

test('Owner browser mutations use native Main confirmation without renderer tokens or platform bias', async () => {
  const [owner, preload, globals, settingsIpc, settingsView, browserSettings] = await Promise.all([
    readFile('src/main/browser-profile-owner.ts', 'utf8'),
    readFile('src/preload/preload.ts', 'utf8'),
    readFile('src/renderer/global.d.ts', 'utf8'),
    readFile('src/main/ipc-settings-config.ts', 'utf8'),
    readFile('src/renderer/settings-view.tsx', 'utf8'),
    readFile('src/renderer/browser-settings.tsx', 'utf8')
  ]);
  for (const source of [owner, preload, globals, settingsView, browserSettings]) assert.doesNotMatch(source, /commandToken|requireToken|CREATE_BROWSER_PROFILE|REBIND_BROWSER_PROFILE|VERIFY_BROWSER_ACCOUNT|MIGRATE_LEGACY_PROFILE/);
  assert.match(settingsIpc, /dialog\.showMessageBox/);
  assert.match(settingsIpc, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  for (const binding of ['command=', 'workspace=', 'bindingRevision=', 'registryRevision=', 'target=', 'platform=']) assert.match(settingsIpc, new RegExp(binding));
  assert.match(settingsIpc, /response !== 1/);
  assert.match(browserSettings, /aria-label="账号平台"/);
  assert.match(browserSettings, /platform: browserPlatform/g);
  assert.doesNotMatch(browserSettings, /platforms\.includes\('x'\) \? 'x' : 'wechat'/);
  assert.match(settingsView, /<BrowserSettings/);
});

test('production browser consumers have no installation singleton fallback', async () => {
  const files = [
    'src/main/index.ts', 'src/main/ipc-settings-config.ts', 'src/main/ipc-publishing-results.ts',
    'src/main/x-list-context.ts', 'src/main/mcp.ts', 'src/main/daily-intelligence-channels.ts',
    'src/main/intelligence-channels.ts'
  ];
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /\b(?:readBrowserConfig|discoverBrowserProfiles|saveBrowserConfig|migrateBrowserConfigToInstallation)\b/);
  }
});
