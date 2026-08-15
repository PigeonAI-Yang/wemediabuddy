import { createHash, randomUUID } from 'node:crypto'; import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
export type UpdateUserIntent = 'now' | 'on-quit' | 'later';
export type UpdateProgress = { bytesPerSecond: number; percent: number; transferred: number; total: number };
export type UpdateReleaseInfo = { version: string | null; releaseNotes: string | null; releaseName: string | null; releaseDate: string | null; updateUrl: string | null };
export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  release: UpdateReleaseInfo | null;
  progress: UpdateProgress | null;
  userIntent: UpdateUserIntent | null;
  lastCheckAt: string | null;
  lastError: string | null;
  pendingVersion: string | null;
  backupPath: string | null;
  bootOkVersion: string | null;
  installing: boolean;
  feedUrl: string;
};
export type UpdateRecovery = {
  pending: boolean;
  pendingVersion: string | null;
  backupPath: string | null;
  currentVersion: string;
  bootOkVersion: string | null;
  installedAndAwaitingBootOk: boolean;
  interrupted: boolean;
  lastError: string | null;
  lastCheckAt: string | null;
  userIntent: UpdateUserIntent | null;
};
export type UpdateBackupManifest = { version: 1; createdAt: string; sourceVersion: string; files: Array<{ name: string; sha256: string; size: number }> };
export type QuitInstallResult = { installed: boolean; reason: string | null };
export type AutoUpdaterLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(options: { url: string; serverType?: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  downloadUpdate?(): void;
};
export type UpdateManagerDeps = {
  autoUpdater: AutoUpdaterLike;
  getVersion(): string;
  getPlatform(): string;
  getArch(): string;
  getUserDataPath(): string;
  getDataRootPath(): string | null;
  prepareForInstall?(): void | Promise<void>;
  beforeQuitAndInstall?(): void | Promise<void>;
  cancelPrepareForInstall?(): void | Promise<void>;
  /** Acceptance feed override; defaults to the update.electronjs.org feed. */
  feedUrl?: string;
  /** Optional periodic auto-check, update-electron-app style. */
  updateIntervalMs?: number;
};
export type UpdateManager = {
  /** Binds updater events, restores persisted state, returns startup recovery metadata. */
  start(): UpdateRecovery;
  getState(): UpdateState;
  subscribe(listener: (state: UpdateState) => void): () => void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installNow(): Promise<void>;
  installOnQuit(): Promise<void>;
  remindLater(): Promise<void>;
  performQuitInstall(): Promise<QuitInstallResult>;
  shouldInstallOnQuit(): boolean;
  markBootOk(): Promise<UpdateRecovery>;
  getRecovery(): UpdateRecovery;
  getFeedUrl(): string;
  dispose(): void;
};
const DEFAULT_FEED_BASE = 'https://update.electronjs.org';
const DEFAULT_OWNER = 'PigeonAI-Yang';
const DEFAULT_REPO = 'wemediabuddy';
const STATE_FILE_NAME = 'update-state.json';
const BACKUPS_DIR_NAME = 'update-backups';
const BACKUP_RETAIN = 3;
type PersistedUpdateState = { version: 1; userIntent: UpdateUserIntent | null; lastCheckAt: string | null; lastError: string | null; pendingVersion: string | null; backupPath: string | null; bootOkVersion: string | null };
type BoundListener = { event: string; listener: (...args: unknown[]) => void };
function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return '未知更新错误。';
}
function nowIso(): string {
  return new Date().toISOString();
}
function buildRelease(args: unknown[]): UpdateReleaseInfo {
  const releaseNotes = typeof args[1] === 'string' && args[1] ? args[1] : null;
  const releaseName = typeof args[2] === 'string' && args[2] ? args[2] : null;
  let releaseDate: string | null = null;
  if (args[3] instanceof Date) releaseDate = args[3].toISOString();
  else if (typeof args[3] === 'string' && args[3] && !Number.isNaN(Date.parse(args[3]))) releaseDate = args[3];
  const updateUrl = typeof args[4] === 'string' && args[4] ? args[4] : null;
  return { version: null, releaseNotes, releaseName, releaseDate, updateUrl };
}
function buildProgress(args: unknown[]): UpdateProgress | null {
  const raw = args[1];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const numberOr = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    bytesPerSecond: numberOr(record.bytesPerSecond),
    percent: numberOr(record.percent),
    transferred: numberOr(record.transferred),
    total: numberOr(record.total)
  };
}
function extractVersion(release: UpdateReleaseInfo): string | null {
  if (release.releaseName) {
    const candidate = release.releaseName.replace(/^v/, '');
    if (/^\d+(\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate)) return candidate;
  }
  if (release.updateUrl) {
    try {
      const queryVersion = new URL(release.updateUrl).searchParams.get('version');
      if (queryVersion) return queryVersion;
    } catch {
      // malformed URL: fall through to path parsing
    }
    const match = release.updateUrl.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
    if (match) return match[1];
  }
  return null;
}
function defaultFeedUrl(deps: UpdateManagerDeps): string {
  return `${DEFAULT_FEED_BASE}/${DEFAULT_OWNER}/${DEFAULT_REPO}/${deps.getPlatform()}-${deps.getArch()}/${deps.getVersion()}`;
}
function readPersisted(statePath: string): Partial<PersistedUpdateState> {
  try {
    if (!existsSync(statePath)) return {};
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<PersistedUpdateState>;
    if (parsed.version !== 1) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeFileAtomicSync(targetPath: string, content: string): void {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, content, 'utf8');
  renameSync(temporaryPath, targetPath);
}
async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, targetPath);
}
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}
async function retainBackups(backupsRoot: string, retain: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(backupsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of dirs.slice(retain)) {
    await rm(path.join(backupsRoot, name), { recursive: true, force: true });
  }
}
async function createUpdateBackup(input: { backupsRoot: string; dataRootPath: string; userDataPath: string; sourceVersion: string }): Promise<{ backupPath: string; manifestPath: string; manifest: UpdateBackupManifest }> {
  await mkdir(input.backupsRoot, { recursive: true });
  const createdAt = new Date().toISOString();
  const backupDir = path.join(input.backupsRoot, `backup-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(backupDir, { recursive: true });
  const entries: Array<{ name: string; absolute: string }> = [{ name: 'wmb.db', absolute: path.join(input.dataRootPath, 'wmb.db') }];
  let configEntries: Array<{ isFile(): boolean; name: string }>;
  try {
    configEntries = await readdir(input.userDataPath, { withFileTypes: true });
  } catch {
    configEntries = [];
  }
  for (const entry of configEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === STATE_FILE_NAME) continue;
    entries.push({ name: entry.name, absolute: path.join(input.userDataPath, entry.name) });
  }
  const files: UpdateBackupManifest['files'] = [];
  for (const entry of entries) {
    const info = await stat(entry.absolute);
    await copyFile(entry.absolute, path.join(backupDir, entry.name));
    const sha256 = await sha256File(entry.absolute);
    files.push({ name: entry.name, sha256, size: info.size });
  }
  const manifest: UpdateBackupManifest = { version: 1, createdAt, sourceVersion: input.sourceVersion, files };
  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await retainBackups(input.backupsRoot, BACKUP_RETAIN);
  return { backupPath: backupDir, manifestPath, manifest };
}
class UpdateManagerImpl implements UpdateManager {
  private readonly autoUpdater: AutoUpdaterLike;
  private readonly getVersion: () => string;
  private readonly getPlatform: () => string;
  private readonly getArch: () => string;
  private readonly getUserDataPath: () => string;
  private readonly getDataRootPath: () => string | null;
  private readonly prepareForInstall?: () => void | Promise<void>;
  private readonly beforeQuitAndInstall?: () => void | Promise<void>;
  private readonly cancelPrepareForInstall?: () => void | Promise<void>;
  private readonly feedUrl: string;
  private readonly updateIntervalMs: number | null;
  private readonly statePath: string;
  private readonly backupsRoot: string;
  private state: UpdateState;
  private readonly boundListeners: BoundListener[] = [];
  private readonly subscribers = new Set<(state: UpdateState) => void>();
  private checkingInFlight = false;
  private autoInstallWhenDownloaded = false;
  private installing = false;
  private started = false;
  private interval: NodeJS.Timeout | null = null;
  constructor(deps: UpdateManagerDeps) {
    this.autoUpdater = deps.autoUpdater;
    this.getVersion = deps.getVersion;
    this.getPlatform = deps.getPlatform;
    this.getArch = deps.getArch;
    this.getUserDataPath = deps.getUserDataPath;
    this.getDataRootPath = deps.getDataRootPath;
    this.prepareForInstall = deps.prepareForInstall;
    this.beforeQuitAndInstall = deps.beforeQuitAndInstall;
    this.cancelPrepareForInstall = deps.cancelPrepareForInstall;
    this.feedUrl = deps.feedUrl ?? defaultFeedUrl(deps);
    this.updateIntervalMs = deps.updateIntervalMs ?? null;
    this.statePath = path.join(this.getUserDataPath(), STATE_FILE_NAME);
    this.backupsRoot = path.join(this.getUserDataPath(), BACKUPS_DIR_NAME);
    const persisted = readPersisted(this.statePath);
    this.state = {
      status: 'idle',
      currentVersion: this.getVersion(),
      availableVersion: null,
      release: null,
      progress: null,
      userIntent: persisted.userIntent ?? null,
      lastCheckAt: persisted.lastCheckAt ?? null,
      lastError: persisted.lastError ?? null,
      pendingVersion: persisted.pendingVersion ?? null,
      backupPath: persisted.backupPath ?? null,
      bootOkVersion: persisted.bootOkVersion ?? null,
      installing: false,
      feedUrl: this.feedUrl
    };
  }
  start(): UpdateRecovery {
    if (this.started) return this.getRecovery();
    this.started = true;
    this.autoUpdater.setFeedURL({ url: this.feedUrl, serverType: 'default' });
    this.bindEvents();
    this.notify();
    if (this.updateIntervalMs !== null && this.updateIntervalMs > 0) {
      this.interval = setInterval(() => {
        void this.checkForUpdates().catch(() => {});
      }, this.updateIntervalMs);
    }
    return this.getRecovery();
  }
  getState(): UpdateState {
    return this.state;
  }
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  getFeedUrl(): string {
    return this.feedUrl;
  }
  getRecovery(): UpdateRecovery {
    const s = this.state;
    const pending = s.backupPath !== null;
    const matches = pending && s.pendingVersion !== null && s.pendingVersion === s.currentVersion;
    return {
      pending,
      pendingVersion: s.pendingVersion,
      backupPath: s.backupPath,
      currentVersion: s.currentVersion,
      bootOkVersion: s.bootOkVersion,
      installedAndAwaitingBootOk: matches,
      interrupted: pending && !matches,
      lastError: s.lastError,
      lastCheckAt: s.lastCheckAt,
      userIntent: s.userIntent
    };
  }
  async checkForUpdates(): Promise<void> {
    if (this.checkingInFlight) throw new Error('正在检查更新，请稍候。');
    this.checkingInFlight = true;
    this.mutate({ status: 'checking', lastCheckAt: nowIso(), lastError: null });
    this.persist();
    try {
      this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.checkingInFlight = false;
      const message = errorMessage(error);
      this.mutate({ status: 'error', lastError: message });
      this.persist();
      throw error;
    }
  }
  async downloadUpdate(): Promise<void> {
    if (this.state.status === 'downloaded') return;
    if (this.state.status !== 'available') throw new Error('当前没有可下载的更新。');
    if (typeof this.autoUpdater.downloadUpdate === 'function') {
      this.mutate({ status: 'downloading', progress: null });
      this.autoUpdater.downloadUpdate();
    }
    // Platforms without an explicit download API auto-download after checkForUpdates.
  }
  async installNow(): Promise<void> {
    const s = this.state;
    if (s.status === 'downloaded') {
      const result = await this.performQuitInstall();
      if (!result.installed) throw new Error(result.reason ?? '安装未完成。');
      return;
    }
    if (s.status === 'available' || s.status === 'downloading') {
      this.autoInstallWhenDownloaded = true;
      this.mutate({ userIntent: 'now' });
      this.persist();
      if (s.status === 'available') await this.downloadUpdate();
      return;
    }
    throw new Error(s.status === 'error' ? '上次更新失败，请先重新检查更新。' : '当前没有可安装的更新。');
  }
  async installOnQuit(): Promise<void> {
    const status = this.state.status;
    if (status !== 'available' && status !== 'downloading' && status !== 'downloaded') throw new Error('当前没有可安装的更新。');
    this.mutate({ userIntent: 'on-quit' });
    this.persist();
    if (status === 'available') await this.downloadUpdate();
  }
  async remindLater(): Promise<void> {
    const status = this.state.status;
    if (status !== 'available' && status !== 'downloading' && status !== 'downloaded') throw new Error('当前没有可安装的更新。');
    this.autoInstallWhenDownloaded = false;
    this.mutate({ userIntent: 'later' });
    this.persist();
  }
  async performQuitInstall(): Promise<QuitInstallResult> {
    if (this.installing) return { installed: false, reason: '安装正在进行中，请稍候。' };
    if (this.state.status !== 'downloaded') return { installed: false, reason: '更新尚未下载完成，无法安装。' };
    const dataRootPath = this.getDataRootPath();
    if (!dataRootPath) return { installed: false, reason: '数据根目录未就绪，无法创建更新备份。' };
    this.installing = true;
    this.mutate({ installing: true });
    let prepared = false;
    try {
      if (this.prepareForInstall) {
        try {
          await this.prepareForInstall();
          prepared = true;
        } catch (error) {
          const message = `安装前无法安全结束当前工作：${errorMessage(error)}`;
          this.installing = false;
          this.mutate({ status: 'error', installing: false, lastError: message });
          this.persist();
          return { installed: false, reason: message };
        }
      }
      const backup = await createUpdateBackup({
        backupsRoot: this.backupsRoot,
        dataRootPath,
        userDataPath: this.getUserDataPath(),
        sourceVersion: this.state.currentVersion
      });
      this.mutate({ pendingVersion: this.state.availableVersion, backupPath: backup.backupPath, userIntent: 'now' });
      this.persist();
      if (this.beforeQuitAndInstall) await this.beforeQuitAndInstall();
      this.autoUpdater.quitAndInstall();
      this.installing = false;
      this.mutate({ installing: false });
      return { installed: true, reason: null };
    } catch (error) {
      if (prepared && this.cancelPrepareForInstall) await Promise.resolve(this.cancelPrepareForInstall()).catch(() => {});
      this.installing = false;
      const message = errorMessage(error);
      this.mutate({ status: 'error', installing: false, lastError: message });
      this.persist();
      return { installed: false, reason: message };
    }
  }
  shouldInstallOnQuit(): boolean {
    return this.state.userIntent === 'on-quit' && this.state.status === 'downloaded' && !this.installing;
  }
  async markBootOk(): Promise<UpdateRecovery> {
    const currentVersion = this.getVersion();
    const matches = this.state.pendingVersion !== null && this.state.pendingVersion === currentVersion;
    this.mutate({ bootOkVersion: currentVersion, ...(matches ? { pendingVersion: null, backupPath: null } : {}) });
    this.persist();
    return this.getRecovery();
  }
  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const bound of this.boundListeners) this.autoUpdater.off(bound.event, bound.listener);
    this.boundListeners.length = 0;
  }
  private bindEvents(): void {
    const bind = (event: string, listener: (...args: unknown[]) => void): void => {
      this.autoUpdater.on(event, listener);
      this.boundListeners.push({ event, listener });
    };
    bind('checking-for-update', this.onCheckingForUpdate);
    bind('update-available', this.onUpdateAvailable);
    bind('update-not-available', this.onUpdateNotAvailable);
    bind('download-progress', this.onDownloadProgress);
    bind('update-downloaded', this.onUpdateDownloaded);
    bind('error', this.onError);
  }
  private readonly onCheckingForUpdate = (): void => {
    this.mutate({ status: 'checking' });
  };

  private readonly onUpdateAvailable = (...args: unknown[]): void => {
    this.checkingInFlight = false;
    const release = buildRelease(args);
    this.mutate({ status: 'available', availableVersion: extractVersion(release), release, lastCheckAt: nowIso(), lastError: null });
    this.persist();
  };

  private readonly onUpdateNotAvailable = (): void => {
    this.checkingInFlight = false;
    this.mutate({ status: 'idle', availableVersion: null, release: null, progress: null, lastCheckAt: nowIso(), lastError: null });
    this.persist();
  };

  private readonly onDownloadProgress = (...args: unknown[]): void => {
    const progress = buildProgress(args);
    if (progress) this.mutate({ status: 'downloading', progress });
  };

  private readonly onUpdateDownloaded = (...args: unknown[]): void => {
    const release = buildRelease(args);
    const availableVersion = extractVersion(release);
    this.mutate({ status: 'downloaded', availableVersion: availableVersion ?? this.state.availableVersion, release, lastError: null });
    this.persist();
    if (this.autoInstallWhenDownloaded) {
      this.autoInstallWhenDownloaded = false;
      void this.performQuitInstall();
    }
  };

  private readonly onError = (...args: unknown[]): void => {
    this.checkingInFlight = false;
    const message = errorMessage(args[0]);
    this.mutate({ status: 'error', lastError: message });
    this.persist();
  };

  private mutate(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }
  private notify(): void {
    for (const listener of this.subscribers) listener(this.state);
  }
  private persist(): void {
    const s = this.state;
    writeFileAtomicSync(
      this.statePath,
      `${JSON.stringify(
        {
          version: 1,
          userIntent: s.userIntent,
          lastCheckAt: s.lastCheckAt,
          lastError: s.lastError,
          pendingVersion: s.pendingVersion,
          backupPath: s.backupPath,
          bootOkVersion: s.bootOkVersion
        } satisfies PersistedUpdateState,
        null,
        2
      )}\n`
    );
  }
}
export function createUpdateManager(deps: UpdateManagerDeps): UpdateManager {
  return new UpdateManagerImpl(deps);
}