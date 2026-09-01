import { BrowserWindow, app, dialog, ipcMain, safeStorage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readSettings } from './settings';
import type { BrowserRuntime } from './browser';
import type { BrowserProfileOwner, OwnerBrowserCommand, OwnerBrowserPlatform } from './browser-profile-owner.ts';
import type { McpRuntime } from './mcp';
import type { XhsMcpRuntime } from './xiaohongshu-mcp';
import { activatePiConfig, deletePiConfig, discoverPiProviders, listPiModels, probePiProvider, readPiConfig, requirePiApiType, requireProviderAuthMode, savePiConfig, saveRoleModelPolicies, type PiThinkingLevel, type ProviderCredentialSource, type RoleId } from './pi-config';
import type { RoleModelPolicies } from '../shared/pi-config.ts';
import type { WorkspaceProposal, WorkspaceProposalBinding } from './workspace-proposals';
import { readCurrentWorkspaceSnapshot } from './workspace-mcp';
import { deletePiSkill, listPiSkills, savePiSkill, syncPiSkillsForDataRoots, type PiSkillInput } from './pi-skill-library';
import { getScoringSettings, setScoringSettings } from './zhihu-hot-scoring.ts';
import type { ZhihuScoringSettings } from './zhihu-hot-scoring.ts';

const OWNER_BROWSER_CONFIRMATION_MESSAGES = {
  create: '将创建独立登录环境，并绑定到当前工作空间。',
  rebind: '将把当前工作空间切换到所选登录环境。',
  verify: '将使用当前登录环境验证账号，并更新该工作空间的账号验证状态。',
  'migrate-legacy': '将复制旧登录数据，创建新环境并绑定到当前工作空间。'
} as const;

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
  getRuntimeEpoch: () => string | null;
  browserProfileOwner: BrowserProfileOwner;
};

export function registerSettingsConfigIpc({ loadSelectedDataRoot, chooseDataRoot, listWorkspaces, switchWorkspace, createUkWorkspace, listWorkspaceProposals, selectWorkspaceProposalRoot, confirmWorkspaceProposal, getMcp, getXhs, getBrowser, getRuntimeEpoch, stopPi, browserProfileOwner }: Dependencies): void {
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
    const ownerBrowser = dataRoot ? await browserProfileOwner.read(dataRoot.path) : null;
    const settings = dataRoot ? await readSettings(dataRoot.path, { boundBrowserProfilePath: ownerBrowser?.boundProfile?.userDataDir }) : null;
    if (!settings || !dataRoot) return null;
    const pi = readPiConfig();
    const workspace = await readCurrentWorkspaceSnapshot(dataRoot.path, listWorkspaces, getRuntimeEpoch());
    const browserState = ownerBrowser ?? {
      registry: { profiles: [], defaultProfileId: '', revision: 0 },
      binding: null,
      boundProfile: null,
      legacySource: { path: '', detected: false, metadataDetected: false, entryCount: 0 }
    };
    let zhihuScoring: ZhihuScoringSettings | null = null;
    try {
      const dbScoring = new DatabaseSync(path.join(dataRoot.path, 'wmb.db'), { readOnly: true });
      zhihuScoring = getScoringSettings(dbScoring);
      dbScoring.close();
    } catch {}
    return {
      ...settings,
      mcp: getMcp() ? { status: 'ready', url: getMcp()!.url } : { status: 'not_started', url: null },
      xhs: getXhs?.()?.status() ?? { status: 'not_started', url: null, port: null, pid: null, runtimeDir: null, tools: [], requiredToolsPresent: false, lastError: null },
      browser: getBrowser()
        ? { status: 'ready', pid: getBrowser()!.pid, cdpUrl: getBrowser()!.cdpUrl, profilePath: getBrowser()!.profilePath, mode: getBrowser()!.mode }
        : { status: 'not_started' },
      browserProfiles: browserState.registry.profiles,
      defaultBrowserProfileId: browserState.registry.defaultProfileId,
      browserRegistryRevision: browserState.registry.revision,
      browserBinding: browserState.binding,
      boundBrowserProfile: browserState.boundProfile,
      legacyBrowserSource: browserState.legacySource,
      pi,
      workspace,
      zhihuScoring
    };
  });
  ipcMain.handle('zhihu-scoring:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const db = new DatabaseSync(path.join(dataRoot.path, 'wmb.db'), { readOnly: true });
    try { return getScoringSettings(db); } finally { db.close(); }
  });
  ipcMain.handle('zhihu-scoring:set', async (_event, input: { autoThreshold?: number; boundaryThreshold?: number; targetCount?: number }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const db = new DatabaseSync(path.join(dataRoot.path, 'wmb.db'));
    try { return setScoringSettings(db, input); } finally { db.close(); }
  });
  const requireRoot = async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    return dataRoot;
  };
  const confirmOwnerCommand = async (
    event: IpcMainInvokeEvent,
    command: keyof typeof OWNER_BROWSER_CONFIRMATION_MESSAGES,
    input: OwnerBrowserCommand & { profileId?: string; platform?: OwnerBrowserPlatform; label?: string }
  ) => {
    const dataRoot = await requireRoot();
    const workspace = await readCurrentWorkspaceSnapshot(dataRoot.path, listWorkspaces, getRuntimeEpoch());
    if (workspace.id !== input.workspaceId) throw ownerIpcError('WORKSPACE_NOT_FOUND', 'Owner 命令的工作空间与当前数据根不一致。');
    const state = await browserProfileOwner.read(dataRoot.path);
    if ((state.binding?.bindingRevision ?? 0) !== input.expectedBindingRevision) throw ownerIpcError('PROFILE_STALE', '浏览器 binding 已变化。');
    if (!Number.isInteger(input.expectedRegistryRevision) || state.registry.revision !== input.expectedRegistryRevision) throw ownerIpcError('PROFILE_STALE', '浏览器档案注册表已变化。');
    const platform = command === 'verify' || command === 'migrate-legacy' ? input.platform : undefined;
    if ((command === 'verify' || command === 'migrate-legacy') && platform !== 'x' && platform !== 'wechat' && platform !== 'zhihu') throw ownerIpcError('BROWSER_PROFILE_MISMATCH', 'Owner 命令缺少有效目标平台。');
    if (platform && !workspace.profile.platforms.includes(platform)) throw ownerIpcError('BROWSER_PROFILE_MISMATCH', `当前工作空间未启用 ${platform}。`);
    const targetProfileId = command === 'rebind' ? input.profileId : state.binding?.profileId;
    const targetProfile = targetProfileId ? state.registry.profiles.find((profile) => profile.id === targetProfileId) : null;
    if ((command === 'rebind' || command === 'verify') && !targetProfile) throw ownerIpcError('BROWSER_PROFILE_MISMATCH', 'Owner 命令的目标浏览器档案不存在。');
    const target = command === 'create'
      ? `new installation profile${input.label ? ` (${input.label})` : ''}`
      : command === 'migrate-legacy'
        ? `${state.legacySource.path} -> new installation profile`
        : `${targetProfile!.id} (${targetProfile!.label})`;
    const detail = [
      `command=${command}`,
      `workspace=${workspace.id}`,
      `bindingRevision=${input.expectedBindingRevision}`,
      `registryRevision=${input.expectedRegistryRevision}`,
      `target=${target}`,
      `platform=${platform ?? 'none'}`
    ].join('\n');
    const options = { type: 'warning' as const, title: '确认 Owner 浏览器操作', message: OWNER_BROWSER_CONFIRMATION_MESSAGES[command], detail, buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, noLink: true };
    // Packaged acceptance is headless and cannot click native dialogs; keep the real
    // confirmation gate for normal Owner UI while auto-accepting only under the
    // explicit acceptance env used by EVAL-029 / package runners.
    let response = 1;
    if (process.env.WMB_ACCEPTANCE_HEADLESS !== '1') {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      response = result.response;
    }
    if (response !== 1) throw ownerIpcError('CONFIRMATION_REQUIRED', 'Owner 已取消浏览器操作。');
    return dataRoot;
  };
  ipcMain.handle('browser-profiles:list', async () => browserProfileOwner.read((await requireRoot()).path));
  ipcMain.handle('workspace-browser:get-binding', async () => browserProfileOwner.read((await requireRoot()).path));
  ipcMain.handle('browser-profiles:create', async (event, input: OwnerBrowserCommand & { label?: string }) => {
    const root = await confirmOwnerCommand(event, 'create', input);
    return browserProfileOwner.create(root.path, input);
  });
  ipcMain.handle('workspace-browser:rebind', async (event, input: OwnerBrowserCommand & { profileId: string }) => {
    const root = await confirmOwnerCommand(event, 'rebind', input);
    return browserProfileOwner.rebind(root.path, input);
  });
  ipcMain.handle('workspace-browser:verify', async (event, input: OwnerBrowserCommand & { platform: OwnerBrowserPlatform }) => {
    const root = await confirmOwnerCommand(event, 'verify', input);
    return browserProfileOwner.verify(root.path, input);
  });
  ipcMain.handle('workspace-browser:migrate-legacy', async (event, input: OwnerBrowserCommand & { platform: OwnerBrowserPlatform }) => {
    const root = await confirmOwnerCommand(event, 'migrate-legacy', input);
    return browserProfileOwner.migrateLegacy(root.path, input);
  });
  ipcMain.handle('pi-config:save', async (_event, input: { id?: string; name: string; baseUrl: string; model: string; api: unknown; authMode?: unknown; credentialSource?: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>; thinking?: PiThinkingLevel; text?: boolean; vision?: boolean; nativeSearch?: boolean; imageGeneration?: boolean; jsonOutput?: boolean; streaming?: boolean; contextWindow?: number | null; maxTokens?: number | null; apiKey?: string }) => {
    const api = requirePiApiType(input.api);
    const authMode = input.authMode === undefined ? undefined : requireProviderAuthMode(input.authMode);
    if (input.apiKey?.trim() && !safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密暂不可用。');
    const saved = savePiConfig({ ...input, api, authMode });
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-config:activate', async (_event, id: string) => {
    const saved = activatePiConfig(id);
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-config:delete', async (_event, id: string) => {
    const root = await loadSelectedDataRoot();
    const taskReferences = root ? readPiTaskReferences(root.path, id) : [];
    const saved = deletePiConfig(id, undefined, { taskReferences });
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-config:save-role-policies', async (_event, input: { roleModelPolicies: RoleModelPolicies; expectedRevision?: number }) => {
    if (!input || typeof input !== 'object' || !input.roleModelPolicies || typeof input.roleModelPolicies !== 'object') {
      throw new Error('角色模型策略无效。');
    }
    return saveRoleModelPolicies({
      roleModelPolicies: input.roleModelPolicies,
      expectedRevision: input.expectedRevision
    });
  });
  ipcMain.handle('pi-config:list-models', async (_event, input: { id?: string; baseUrl: string; api: unknown; authMode?: unknown; credentialSource?: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>; apiKey?: string }) => {
    const api = requirePiApiType(input.api);
    const authMode = input.authMode === undefined ? undefined : requireProviderAuthMode(input.authMode);
    return listPiModels({ ...input, api, authMode });
  });
  ipcMain.handle('pi-config:discover', async () => discoverPiProviders());
  ipcMain.handle('pi-config:probe', async (_event, input: { id?: string; baseUrl: string; api: unknown; authMode?: unknown; credentialSource?: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>; apiKey?: string }) => {
    const api = requirePiApiType(input.api);
    const authMode = input.authMode === undefined ? undefined : requireProviderAuthMode(input.authMode);
    return probePiProvider({ ...input, api, authMode });
  });
  const packagedSkillsPath = () => app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.resolve('skills');
  ipcMain.handle('pi-skills:list', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    return listPiSkills(app.getPath('userData'), packagedSkillsPath(), dataRoot.path);
  });
  ipcMain.handle('pi-skills:save', async (_event, input: PiSkillInput) => {
    const saved = await savePiSkill(app.getPath('userData'), packagedSkillsPath(), input);
    const roots = (await listWorkspaces()).workspaces.map((workspace) => workspace.rootPath);
    await syncPiSkillsForDataRoots(app.getPath('userData'), packagedSkillsPath(), roots);
    await stopPi();
    return saved;
  });
  ipcMain.handle('pi-skills:delete', async (_event, name: string) => {
    await deletePiSkill(app.getPath('userData'), name);
    const roots = (await listWorkspaces()).workspaces.map((workspace) => workspace.rootPath);
    await syncPiSkillsForDataRoots(app.getPath('userData'), packagedSkillsPath(), roots);
    await stopPi();
    return { name };
  });
}

function readPiTaskReferences(rootPath: string, profileId: string): Array<{ taskId: string; roleId?: RoleId }> {
  const database = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
  try {
    const rows = database.prepare("SELECT id, context_refs_json AS contextRefsJson FROM agent_tasks WHERE status NOT IN ('succeeded', 'partial', 'failed', 'cancelled')").all() as Array<{ id: string; contextRefsJson: string }>;
    const roleIds = ['desk', 'reporter', 'planner', 'writer', 'librarian'] as const;
    const references: Array<{ taskId: string; roleId?: RoleId }> = [];
    for (const row of rows) {
      try {
        const refs = asRecord(JSON.parse(row.contextRefsJson));
        const snapshot = asRecord(refs?.modelPolicySnapshot);
        const snapshotProfiles = snapshot?.profiles;
        if (!Array.isArray(snapshotProfiles) || !snapshotProfiles.some((profile) => asRecord(profile)?.profileId === profileId)) continue;
        const snapshotRole = snapshot?.roleId;
        const roleId = typeof snapshotRole === 'string' && roleIds.includes(snapshotRole as (typeof roleIds)[number]) ? snapshotRole as RoleId : undefined;
        references.push({ taskId: row.id, ...(roleId ? { roleId } : {}) });
      } catch { /* malformed task refs cannot identify this profile */ }
    }
    return references;
  } finally {
    database.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function ownerIpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, details: { state: 'needs_user' } });
}
