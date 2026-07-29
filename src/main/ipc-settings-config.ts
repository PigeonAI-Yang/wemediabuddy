import { ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { discoverBrowserProfiles, readBrowserConfig, saveBrowserConfig, type BrowserRuntime } from './browser';
import type { McpRuntime } from './mcp';
import { activatePiConfig, deletePiConfig, listPiModels, readPiConfig, savePiConfig, type PiThinkingLevel } from './pi-config';

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  chooseDataRoot: () => Promise<DataRoot | null>;
  getMcp: () => McpRuntime | null;
  getBrowser: () => BrowserRuntime | null;
  stopPi: () => Promise<void>;
};

export function registerSettingsConfigIpc({ loadSelectedDataRoot, chooseDataRoot, getMcp, getBrowser, stopPi }: Dependencies): void {
  ipcMain.handle('data-root:get', loadSelectedDataRoot);
  ipcMain.handle('data-root:choose', chooseDataRoot);
  ipcMain.handle('settings:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    const settings = dataRoot ? await readSettings(dataRoot.path) : null;
    if (!settings || !dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const selectedBrowser = readBrowserConfig(database);
    const pi = readPiConfig(database);
    database.close();
    return {
      ...settings,
      mcp: getMcp() ? { status: 'ready', url: getMcp()!.url } : { status: 'not_started', url: null },
      browser: getBrowser()
        ? { status: 'ready', pid: getBrowser()!.pid, cdpUrl: getBrowser()!.cdpUrl, profilePath: getBrowser()!.profilePath }
        : { status: 'not_started' },
      browserOptions: await discoverBrowserProfiles(),
      selectedBrowser,
      pi
    };
  });
  ipcMain.handle('browser:configure', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const config = (await discoverBrowserProfiles()).find((candidate) => candidate.id === id);
    if (!config) throw new Error('浏览器 profile 不存在。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return saveBrowserConfig(database, config); } finally { database.close(); }
  });
  ipcMain.handle('pi-config:save', async (_event, input: { id?: string; name: string; baseUrl: string; model: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; thinking?: PiThinkingLevel; apiKey?: string }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密暂不可用。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const saved = savePiConfig(database, input);
      await stopPi();
      return saved;
    } finally { database.close(); }
  });
  ipcMain.handle('pi-config:activate', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const saved = activatePiConfig(database, id);
      await stopPi();
      return saved;
    } finally { database.close(); }
  });
  ipcMain.handle('pi-config:delete', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const saved = deletePiConfig(database, id);
      await stopPi();
      return saved;
    } finally { database.close(); }
  });
  ipcMain.handle('pi-config:list-models', async (_event, input: { id?: string; baseUrl: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; apiKey?: string }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密暂不可用。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return await listPiModels(database, input); } finally { database.close(); }
  });
}
