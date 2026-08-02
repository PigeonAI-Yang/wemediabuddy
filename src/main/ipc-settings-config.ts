import { ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import { discoverBrowserProfiles, readBrowserConfig, saveBrowserConfig, type BrowserRuntime } from './browser';
import type { McpRuntime } from './mcp';
import type { XhsMcpRuntime } from './xiaohongshu-mcp';
import { activatePiConfig, deletePiConfig, listPiModels, readPiConfig, requirePiApiType, savePiConfig, type PiThinkingLevel } from './pi-config';
import type { WorkspaceProposal, WorkspaceProposalBinding } from './workspace-proposals';
import { readCurrentWorkspaceSnapshot } from './workspace-mcp';
import { allowsAiOnlyRoutes } from './workspace-profiles';

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  chooseDataRoot: () => Promise<DataRoot | null>;
  listWorkspaces: () => Promise<{ activeWorkspaceId: string | null; workspaces: Array<{ id: string; displayName: string; rootPath: string }> }>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  createUkWorkspace: () => Promise<{ id: string; displayName: string; rootPath: string } | null>;
  listWorkspaceProposals: () => Array<{ proposal: WorkspaceProposal; binding: WorkspaceProposalBinding; selectedRootPath: string | null }>;
  selectWorkspaceProposalRoot: (binding: WorkspaceProposalBinding) => Promise<unknown>;
  confirmWorkspaceProposal: (binding: WorkspaceProposalBinding) => Promise<unknown>;
  getMcp: () => McpRuntime | null;
  getXhs?: () => XhsMcpRuntime | null;
  getBrowser: () => BrowserRuntime | null;
  stopPi: () => Promise<void>;
};

export function registerSettingsConfigIpc({ loadSelectedDataRoot, chooseDataRoot, listWorkspaces, switchWorkspace, createUkWorkspace, listWorkspaceProposals, selectWorkspaceProposalRoot, confirmWorkspaceProposal, getMcp, getXhs, getBrowser, stopPi }: Dependencies): void {
  ipcMain.handle('data-root:get', loadSelectedDataRoot);
  ipcMain.handle('data-root:choose', chooseDataRoot);
  ipcMain.handle('workspaces:list', listWorkspaces);
  ipcMain.handle('workspaces:switch', async (_event, workspaceId: string) => { await switchWorkspace(workspaceId); return { relaunching: true }; });
  ipcMain.handle('workspaces:create-uk', createUkWorkspace);
  ipcMain.handle('workspaces:proposals-list', listWorkspaceProposals);
  ipcMain.handle('workspaces:proposal-select-root', async (_event, binding: WorkspaceProposalBinding) => selectWorkspaceProposalRoot(binding));
  ipcMain.handle('workspaces:proposal-confirm', async (_event, binding: WorkspaceProposalBinding) => confirmWorkspaceProposal(binding));
  ipcMain.handle('settings:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    const settings = dataRoot ? await readSettings(dataRoot.path) : null;
    if (!settings || !dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const selectedBrowser = readBrowserConfig(database);
    const pi = readPiConfig();
    const legacyBrowserAllowed = allowsAiOnlyRoutes(database);
    database.close();
    const workspace = await readCurrentWorkspaceSnapshot(dataRoot.path, listWorkspaces);
    return {
      ...settings,
      mcp: getMcp() ? { status: 'ready', url: getMcp()!.url } : { status: 'not_started', url: null },
      xhs: getXhs?.()?.status() ?? { status: 'not_started', url: null, port: null, pid: null, runtimeDir: null, tools: [], requiredToolsPresent: false, lastError: null },
      browser: getBrowser()
        ? { status: 'ready', pid: getBrowser()!.pid, cdpUrl: getBrowser()!.cdpUrl, profilePath: getBrowser()!.profilePath, mode: getBrowser()!.mode }
        : { status: 'not_started' },
      browserOptions: discoverBrowserProfiles(dataRoot.path, legacyBrowserAllowed ? selectedBrowser : null),
      selectedBrowser,
      pi,
      workspace
    };
  });
  ipcMain.handle('browser:configure', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const selected = allowsAiOnlyRoutes(database) ? readBrowserConfig(database) : null;
      const config = discoverBrowserProfiles(dataRoot.path, selected).find((candidate) => candidate.id === id);
      if (!config) throw new Error('浏览器 profile 不存在。');
      return saveBrowserConfig(database, config);
    } finally { database.close(); }
  });
  ipcMain.handle('pi-config:save', async (_event, input: { id?: string; name: string; baseUrl: string; model: string; api: unknown; thinking?: PiThinkingLevel; apiKey?: string }) => {
    const api = requirePiApiType(input.api);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密暂不可用。');
    const saved = savePiConfig({ ...input, api });
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-config:activate', async (_event, id: string) => {
    const saved = activatePiConfig(id);
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-config:delete', async (_event, id: string) => {
    const saved = deletePiConfig(id);
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-config:list-models', async (_event, input: { id?: string; baseUrl: string; api: unknown; apiKey?: string }) => {
    const api = requirePiApiType(input.api);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密暂不可用。');
    return listPiModels({ ...input, api });
  });
}
