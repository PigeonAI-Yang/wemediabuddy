import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUpdateManager } from '../src/main/app-update.ts';

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.setFeedOptions = null;
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.quitCalls = 0;
  }

  setFeedURL(options) {
    this.setFeedOptions = options;
  }

  checkForUpdates() {
    this.checkCalls += 1;
  }

  downloadUpdate() {
    this.downloadCalls += 1;
  }

  quitAndInstall() {
    this.quitCalls += 1;
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const DB_BYTES = Buffer.from('wmb-database-bytes');

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-update-'));
  const userDataPath = path.join(parent, 'userData');
  const dataRootPath = path.join(parent, 'data');
  await mkdir(userDataPath, { recursive: true });
  await mkdir(dataRootPath, { recursive: true });
  await writeFile(path.join(dataRootPath, 'wmb.db'), DB_BYTES);
  await writeFile(path.join(userDataPath, 'pi-api-config.json'), JSON.stringify({ version: 1, state: { activeId: 'default', profiles: [], fallbackOrder: [] } }));
  await writeFile(path.join(userDataPath, 'data-root.json'), JSON.stringify({ root: dataRootPath }));
  return {
    parent,
    userDataPath,
    dataRootPath,
    cleanup: () => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  };
}

function makeDeps(fx, overrides = {}) {
  return {
    autoUpdater: new FakeAutoUpdater(),
    getVersion: () => '0.2.0',
    getPlatform: () => 'win32',
    getArch: () => 'x64',
    getUserDataPath: () => fx.userDataPath,
    getDataRootPath: () => fx.dataRootPath,
    prepareForInstall: () => {},
    ...overrides
  };
}

function emitAvailable(updater, version = '0.3.0') {
  updater.emit('checking-for-update');
  updater.emit('update-available', {}, 'notes', version, '2026-08-09T00:00:00.000Z', `https://example.com/update/${version}/WeMediaBuddy-${version}-full.nupkg`);
}

function emitDownloaded(updater, version = '0.3.0') {
  updater.emit('download-progress', {}, { bytesPerSecond: 2048, percent: 42, transferred: 420, total: 1000 });
  updater.emit('update-downloaded', {}, 'notes', version, '2026-08-09T00:00:00.000Z', `https://example.com/update/${version}/WeMediaBuddy-${version}-full.nupkg`);
}

function downloadedState(manager, updater, version = '0.3.0') {
  emitAvailable(updater, version);
  emitDownloaded(updater, version);
}

async function stateFile(fx) {
  return JSON.parse(await readFile(path.join(fx.userDataPath, 'update-state.json'), 'utf8'));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached in time');
}

test('feed URL defaults to update.electronjs.org and honors an injected override', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx);
    const manager = createUpdateManager(deps);
    assert.equal(manager.getFeedUrl(), 'https://update.electronjs.org/PigeonAI-Yang/wemediabuddy/win32-x64/0.2.0');
    manager.start();
    assert.equal(deps.autoUpdater.setFeedOptions.url, 'https://update.electronjs.org/PigeonAI-Yang/wemediabuddy/win32-x64/0.2.0');
    assert.equal(manager.getState().feedUrl, manager.getFeedUrl());
    const overrideDeps = makeDeps(fx, { feedUrl: 'https://acceptance.local/wmb/feed' });
    const override = createUpdateManager(overrideDeps);
    override.start();
    assert.equal(override.getFeedUrl(), 'https://acceptance.local/wmb/feed');
    assert.equal(overrideDeps.autoUpdater.setFeedOptions.url, 'https://acceptance.local/wmb/feed');
  } finally {
    await fx.cleanup();
  }
});

test('updater events drive state transitions and notify subscribers; errors persist and clear on retry', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx);
    const manager = createUpdateManager(deps);
    const seen = [];
    const unsubscribe = manager.subscribe((state) => seen.push(state.status));
    const recovery = manager.start();
    assert.equal(recovery.pending, false);

    await manager.checkForUpdates();
    assert.equal(manager.getState().status, 'checking');
    assert.ok(manager.getState().lastCheckAt);

    emitAvailable(deps.autoUpdater);
    let state = manager.getState();
    assert.equal(state.status, 'available');
    assert.equal(state.availableVersion, '0.3.0');
    assert.equal(state.release.releaseName, '0.3.0');
    assert.equal(state.release.updateUrl, 'https://example.com/update/0.3.0/WeMediaBuddy-0.3.0-full.nupkg');

    emitDownloaded(deps.autoUpdater);
    state = manager.getState();
    assert.equal(state.status, 'downloaded');
    assert.equal(state.availableVersion, '0.3.0');
    assert.equal(state.progress.percent, 42);
    for (const status of ['checking', 'available', 'downloading', 'downloaded']) assert.ok(seen.includes(status), `subscriber saw ${status}`);

    deps.autoUpdater.emit('error', new Error('network failure'));
    state = manager.getState();
    assert.equal(state.status, 'error');
    assert.equal(state.lastError, 'network failure');
    unsubscribe();

    const restarted = createUpdateManager(makeDeps(fx));
    assert.equal(restarted.getState().lastError, 'network failure');
    await restarted.checkForUpdates();
    assert.equal(restarted.getState().lastError, null);
  } finally {
    await fx.cleanup();
  }
});

test('user intents now/on-quit/later are recorded, persisted, and drive the quit decision', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx);
    const manager = createUpdateManager(deps);
    manager.start();
    downloadedState(manager, deps.autoUpdater);

    await manager.installOnQuit();
    assert.equal(manager.getState().userIntent, 'on-quit');
    assert.equal(manager.shouldInstallOnQuit(), true);

    await manager.remindLater();
    assert.equal(manager.getState().userIntent, 'later');
    assert.equal(manager.shouldInstallOnQuit(), false);
    assert.equal(deps.autoUpdater.quitCalls, 0);
    assert.equal((await stateFile(fx)).userIntent, 'later');

    emitAvailable(deps.autoUpdater, '0.4.0');
    await manager.installOnQuit();
    assert.equal(manager.getState().userIntent, 'on-quit');
    assert.equal(manager.getState().status, 'downloading');
    assert.equal(deps.autoUpdater.downloadCalls, 1);
    emitDownloaded(deps.autoUpdater, '0.4.0');
    assert.equal(manager.shouldInstallOnQuit(), true);
    assert.equal(deps.autoUpdater.quitCalls, 0, 'on-quit intent must not install immediately');
  } finally {
    await fx.cleanup();
  }
});

test('installNow backs up wmb.db and userData JSON configs with a SHA-256 manifest and journals pending', async () => {
  const fx = await fixture();
  try {
    let prepared = 0;
    const deps = makeDeps(fx, { prepareForInstall: () => { prepared += 1; } });
    const manager = createUpdateManager(deps);
    manager.start();
    downloadedState(manager, deps.autoUpdater);

    await manager.installNow();
    assert.equal(deps.autoUpdater.quitCalls, 1);
    assert.equal(prepared, 1);
    const state = manager.getState();
    assert.equal(state.userIntent, 'now');
    assert.equal(state.pendingVersion, '0.3.0');
    assert.ok(state.backupPath);

    const manifest = JSON.parse(await readFile(path.join(state.backupPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.sourceVersion, '0.2.0');
    assert.deepEqual(manifest.files.map((entry) => entry.name).sort(), ['data-root.json', 'pi-api-config.json', 'wmb.db']);
    const dbEntry = manifest.files.find((entry) => entry.name === 'wmb.db');
    assert.equal(dbEntry.sha256, sha256Hex(DB_BYTES));
    assert.equal(dbEntry.size, DB_BYTES.length);
    assert.deepEqual(await readFile(path.join(state.backupPath, 'wmb.db')), DB_BYTES);

    const journal = await stateFile(fx);
    assert.equal(journal.pendingVersion, '0.3.0');
    assert.equal(journal.backupPath, state.backupPath);
  } finally {
    await fx.cleanup();
  }
});

test('backup retention keeps only the latest 3 backups', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx);
    const manager = createUpdateManager(deps);
    manager.start();
    for (let index = 0; index < 5; index += 1) {
      const version = `0.3.${index}`;
      downloadedState(manager, deps.autoUpdater, version);
      await manager.installNow();
      assert.equal(deps.autoUpdater.quitCalls, index + 1);
    }
    const backupsRoot = path.join(fx.userDataPath, 'update-backups');
    const backups = (await readdir(backupsRoot)).filter((name) => name.startsWith('backup-'));
    assert.equal(backups.length, 3);
    const newestManifest = JSON.parse(await readFile(path.join(backupsRoot, backups.sort()[backups.length - 1], 'manifest.json'), 'utf8'));
    assert.equal(newestManifest.sourceVersion, '0.2.0');
    assert.equal(newestManifest.files.find((entry) => entry.name === 'wmb.db').sha256, sha256Hex(DB_BYTES));
  } finally {
    await fx.cleanup();
  }
});

test('markBootOk clears pending only when the current version matches the pending version', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx);
    const manager = createUpdateManager(deps);
    manager.start();
    downloadedState(manager, deps.autoUpdater);
    await manager.installNow();

    // Restart on the old version: interrupted pending is exposed, never deleted silently.
    const interrupted = createUpdateManager(makeDeps(fx));
    let recovery = interrupted.getRecovery();
    assert.equal(recovery.pending, true);
    assert.equal(recovery.interrupted, true);
    assert.equal(recovery.installedAndAwaitingBootOk, false);
    assert.ok(recovery.backupPath);
    await interrupted.markBootOk();
    assert.equal(interrupted.getRecovery().pending, true, 'non-matching boot-ok must not clear pending');
    assert.equal(interrupted.getRecovery().bootOkVersion, '0.2.0');

    // Restart on the new version: awaiting boot-ok, then cleared on markBootOk.
    const updated = createUpdateManager(makeDeps(fx, { getVersion: () => '0.3.0' }));
    recovery = updated.getRecovery();
    assert.equal(recovery.pending, true);
    assert.equal(recovery.interrupted, false);
    assert.equal(recovery.installedAndAwaitingBootOk, true);
    await updated.markBootOk();
    recovery = updated.getRecovery();
    assert.equal(recovery.pending, false);
    assert.equal(recovery.pendingVersion, null);
    assert.equal(recovery.bootOkVersion, '0.3.0');
    assert.equal((await stateFile(fx)).pendingVersion, null);

    const clean = createUpdateManager(makeDeps(fx, { getVersion: () => '0.3.0' }));
    assert.equal(clean.getRecovery().pending, false);
    assert.equal(clean.getRecovery().bootOkVersion, '0.3.0');
  } finally {
    await fx.cleanup();
  }
});

test('prepareForInstall failure blocks quitAndInstall and keeps an actionable error', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx, { prepareForInstall: () => { throw new Error('database busy'); } });
    const manager = createUpdateManager(deps);
    manager.start();
    downloadedState(manager, deps.autoUpdater);

    await assert.rejects(() => manager.installNow(), /database|busy/);
    assert.equal(deps.autoUpdater.quitCalls, 0);
    const state = manager.getState();
    assert.equal(state.status, 'error');
    assert.match(state.lastError, /安全结束/);
    assert.match(state.lastError, /database|busy/);

    const restarted = createUpdateManager(makeDeps(fx));
    assert.equal(restarted.getRecovery().lastError, state.lastError);
    await assert.rejects(readdir(path.join(fx.userDataPath, 'update-backups')), (error) => error.code === 'ENOENT');
  } finally {
    await fx.cleanup();
  }
});

test('installNow downloads first when needed and installs once downloaded', async () => {
  const fx = await fixture();
  try {
    const deps = makeDeps(fx);
    const manager = createUpdateManager(deps);
    manager.start();
    emitAvailable(deps.autoUpdater);

    await manager.installNow();
    assert.equal(manager.getState().userIntent, 'now');
    assert.equal(manager.getState().status, 'downloading');
    assert.equal(deps.autoUpdater.downloadCalls, 1);
    assert.equal(deps.autoUpdater.quitCalls, 0);

    emitDownloaded(deps.autoUpdater);
    await waitFor(() => deps.autoUpdater.quitCalls === 1);
    assert.equal(manager.getState().pendingVersion, '0.3.0');
    assert.equal(manager.getState().status, 'downloaded');
  } finally {
    await fx.cleanup();
  }
});
