import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './db/migrations.ts';
import { startBrowser, type BrowserRuntime } from './browser.ts';
import {
  createInstallationBrowserProfile,
  openBrowserProfileRegistry,
  requireBrowserProfile,
  type BrowserProfile,
  type BrowserProfileRegistry
} from './browser-config.ts';
import { migrateLegacyBrowserProfile } from './browser-profile-migration.ts';
import { assertBrowserProfileStopped } from './browser-profile-process-guard.ts';
import { identifyXAccount } from './platforms/x.ts';
import { identifyWechatAccount } from './platforms/wechat.ts';
import {
  markWorkspaceBrowserBindingNeedsUser,
  markWorkspaceBrowserBindingVerified,
  readWorkspaceBrowserBinding,
  rebindWorkspaceBrowserProfile,
  type WorkspaceBrowserBinding
} from './workspace-browser-binding.ts';
import type { AccountIdentity } from './accounts.ts';

export type OwnerBrowserPlatform = Extract<AccountIdentity['platform'], 'x' | 'wechat'>;
export type OwnerBrowserCommand = {
  workspaceId: string;
  expectedBindingRevision: number;
  expectedRegistryRevision: number;
};
export type OwnerBrowserState = {
  registry: BrowserProfileRegistry;
  binding: WorkspaceBrowserBinding | null;
  boundProfile: BrowserProfile | null;
  legacySource: { path: string; detected: boolean; metadataDetected: boolean; entryCount: number };
};

export type BrowserProfileOwner = {
  read: (rootPath: string) => Promise<OwnerBrowserState>;
  create: (rootPath: string, input: OwnerBrowserCommand & { label?: string }) => Promise<unknown>;
  rebind: (rootPath: string, input: OwnerBrowserCommand & { profileId: string }) => Promise<unknown>;
  verify: (rootPath: string, input: OwnerBrowserCommand & { platform: OwnerBrowserPlatform }) => Promise<unknown>;
  migrateLegacy: (rootPath: string, input: OwnerBrowserCommand & { platform: OwnerBrowserPlatform }) => Promise<unknown>;
};

type OwnerDependencies = {
  registryPath: string;
  relaunchCurrentWorkspace: <T>(apply: () => Promise<T>) => Promise<T>;
  stopBrowserSessions: () => Promise<void>;
  setBrowser: (runtime: BrowserRuntime | null) => void;
  identifyAccount?: (profile: BrowserProfile, platform: OwnerBrowserPlatform) => Promise<AccountIdentity>;
};

export function createBrowserProfileOwner(dependencies: OwnerDependencies): BrowserProfileOwner {
  const openWorkspaceDatabase = (rootPath: string, workspaceId: string): DatabaseSync => {
    const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
    const actual = (database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
    if (actual !== workspaceId) {
      database.close();
      throw ownerError('WORKSPACE_NOT_FOUND', 'Owner 命令的工作空间与当前数据根不一致。');
    }
    return database;
  };
  const identify = async (profile: BrowserProfile, platform: OwnerBrowserPlatform): Promise<AccountIdentity> => {
    if (dependencies.identifyAccount) return dependencies.identifyAccount(profile, platform);
    const runtime = await startBrowser(profile, { mode: 'visible' });
    dependencies.setBrowser(runtime);
    return platform === 'x' ? identifyXAccount(runtime.cdpUrl) : identifyWechatAccount(runtime.cdpUrl);
  };

  return {
    read: async (rootPath) => readOwnerBrowserState(rootPath, dependencies.registryPath),
    create: async (rootPath, input) => dependencies.relaunchCurrentWorkspace(async () => {
      const database = openWorkspaceDatabase(rootPath, input.workspaceId);
      try {
        const current = readWorkspaceBrowserBinding(database);
        if ((current?.bindingRevision ?? 0) !== input.expectedBindingRevision) throw ownerError('PROFILE_STALE', '浏览器 binding 已变化。');
        const created = createInstallationBrowserProfile({
          expectedRevision: input.expectedRegistryRevision,
          ...(input.label ? { label: input.label } : {}),
          configPath: dependencies.registryPath
        });
        const binding = rebindWorkspaceBrowserProfile(database, { profileId: created.profile.id, expectedBindingRevision: input.expectedBindingRevision });
        return { profile: created.profile, binding, relaunching: true };
      } finally { database.close(); }
    }),
    rebind: async (rootPath, input) => dependencies.relaunchCurrentWorkspace(async () => {
      if (openBrowserProfileRegistry(dependencies.registryPath).revision !== input.expectedRegistryRevision) throw ownerError('PROFILE_STALE', '浏览器档案注册表已变化。');
      const profile = requireBrowserProfile(input.profileId, dependencies.registryPath);
      const database = openWorkspaceDatabase(rootPath, input.workspaceId);
      try {
        const binding = rebindWorkspaceBrowserProfile(database, { profileId: profile.id, expectedBindingRevision: input.expectedBindingRevision });
        return { profile, binding, relaunching: true };
      } finally { database.close(); }
    }),
    verify: async (rootPath, input) => dependencies.relaunchCurrentWorkspace(async () => {
      if (openBrowserProfileRegistry(dependencies.registryPath).revision !== input.expectedRegistryRevision) throw ownerError('PROFILE_STALE', '浏览器档案注册表已变化。');
      const database = openWorkspaceDatabase(rootPath, input.workspaceId);
      try {
        const binding = readWorkspaceBrowserBinding(database);
        if (!binding?.profileId || binding.bindingRevision !== input.expectedBindingRevision) throw ownerError('PROFILE_STALE', '浏览器 binding 已变化。');
        const profile = requireBrowserProfile(binding.profileId, dependencies.registryPath);
        try {
          const account = await identify(profile, input.platform);
          const verified = markWorkspaceBrowserBindingVerified(database, { profileId: profile.id, expectedBindingRevision: binding.bindingRevision, account });
          return { verified: true, binding: verified, relaunching: true };
        } catch (error) {
          if (errorCode(error) === 'ACCOUNT_MISMATCH') throw error;
          const code = errorCode(error);
          const failed = markWorkspaceBrowserBindingNeedsUser(database, {
            profileId: profile.id,
            expectedBindingRevision: binding.bindingRevision,
            error: { code, message: errorMessage(error) }
          });
          return { verified: false, binding: failed, error: { code, message: errorMessage(error) }, relaunching: true };
        }
      } finally { database.close(); }
    }),
    migrateLegacy: async (rootPath, input) => dependencies.relaunchCurrentWorkspace(async () => {
      const database = openWorkspaceDatabase(rootPath, input.workspaceId);
      try {
        const result = await migrateLegacyBrowserProfile({
          sourceRootPath: path.resolve(rootPath),
          registryPath: path.resolve(dependencies.registryPath),
          database,
          expectedRegistryRevision: input.expectedRegistryRevision,
          expectedBindingRevision: input.expectedBindingRevision,
          ensureBrowsersStopped: async ({ sourceProfilePath }) => {
            await dependencies.stopBrowserSessions();
            dependencies.setBrowser(null);
            await assertBrowserProfileStopped(sourceProfilePath);
          },
          verifyProfile: async (profile) => {
            try {
              const account = await identify(profile, input.platform);
              const current = readWorkspaceBrowserBinding(database);
              const expected = current?.expectedAccountSnapshot[input.platform];
              if (expected && expected.accountKey !== account.accountKey) {
                return { ok: false, error: { code: 'ACCOUNT_MISMATCH', message: '迁移后的浏览器账号与当前工作空间预期账号不一致。' } };
              }
              return { ok: true, account };
            } catch (error) {
              return { ok: false, error: { code: errorCode(error), message: errorMessage(error) } };
            }
          }
        });
        return { ...result, relaunching: true };
      } finally { database.close(); }
    })
  };
}

async function readOwnerBrowserState(rootPath: string, registryPath: string): Promise<OwnerBrowserState> {
  const registry = openBrowserProfileRegistry(registryPath);
  const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
  try {
    const binding = readWorkspaceBrowserBinding(database);
    const legacyMetadata = Boolean(database.prepare("SELECT 1 FROM app_meta WHERE key='browser.config'").get());
    let legacyEntries = 0;
    try { legacyEntries = (await readdir(path.join(rootPath, 'browser-profile'))).length; } catch {}
    return {
      registry,
      binding,
      boundProfile: binding ? registry.profiles.find((profile) => profile.id === binding.profileId) ?? null : null,
      legacySource: { path: path.join(rootPath, 'browser-profile'), detected: legacyMetadata || legacyEntries > 0, metadataDetected: legacyMetadata, entryCount: legacyEntries }
    };
  } finally { database.close(); }
}


function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return 'BROWSER_NEEDS_USER';
  return error.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, details: { state: 'needs_user' } });
}
