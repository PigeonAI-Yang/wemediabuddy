import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountIdentity } from './accounts.ts';
import {
  browserProfilePath,
  readBrowserProfileRegistry,
  registerCopiedBrowserProfile,
  type BrowserProfile
} from './browser-config.ts';
import {
  markWorkspaceBrowserBindingNeedsUser,
  markWorkspaceBrowserBindingVerified,
  readWorkspaceBrowserBinding,
  rebindWorkspaceBrowserProfile,
  type WorkspaceBrowserBinding
} from './workspace-browser-binding.ts';

export type LegacyProfileVerification =
  | { ok: true; account: AccountIdentity }
  | { ok: false; error: { code: string; message: string } };

export type LegacyProfileMigrationResult = {
  profile: BrowserProfile;
  binding: WorkspaceBrowserBinding;
  verified: boolean;
};

export async function migrateLegacyBrowserProfile(input: {
  sourceRootPath: string;
  registryPath: string;
  database: DatabaseSync;
  expectedRegistryRevision: number;
  expectedBindingRevision: number;
  ensureBrowsersStopped: (identity: { sourceRootPath: string; sourceProfilePath: string }) => Promise<void>;
  verifyProfile: (profile: BrowserProfile) => Promise<LegacyProfileVerification>;
}): Promise<LegacyProfileMigrationResult> {
  const sourceRootPath = requireResolvedAbsolutePath(input.sourceRootPath, 'legacy source root');
  const registryPath = requireResolvedAbsolutePath(input.registryPath, 'browser registry');
  const sourceProfilePath = path.join(sourceRootPath, 'browser-profile');
  await requireDirectoryWithoutLinks(sourceRootPath, 'Legacy 来源根目录');
  await requireDirectoryWithoutLinks(sourceProfilePath, 'Legacy 浏览器档案来源');

  const registry = readBrowserProfileRegistry(registryPath);
  if (!registry) throw migrationError('VALIDATION_ERROR', '浏览器档案注册表尚未初始化。');
  if (registry.revision !== input.expectedRegistryRevision) throw migrationError('PROFILE_STALE', '浏览器档案注册表已变化。');
  const currentBinding = readWorkspaceBrowserBinding(input.database);
  if ((currentBinding?.bindingRevision ?? 0) !== input.expectedBindingRevision) throw migrationError('PROFILE_STALE', '浏览器 binding 已变化。');
  const inherited = registry.profiles.find((profile) => profile.id === registry.defaultProfileId);
  if (!inherited) throw migrationError('BROWSER_PROFILE_MISMATCH', '默认浏览器档案已悬空。');

  const profileId = randomUUID();
  const targetProfilePath = browserProfilePath(registryPath, profileId);
  const profilesPath = path.dirname(targetProfilePath);
  const stagingPath = path.join(profilesPath, `.staging-${profileId}`);
  let targetMoved = false;
  let registered = false;
  try {
    await mkdir(profilesPath, { recursive: true });
    await input.ensureBrowsersStopped({ sourceRootPath, sourceProfilePath });
    const before = await snapshotTree(sourceProfilePath);
    await cp(sourceProfilePath, stagingPath, { recursive: true, errorOnExist: true, force: false });
    await snapshotTree(stagingPath);
    await input.ensureBrowsersStopped({ sourceRootPath, sourceProfilePath });
    const afterCopy = await snapshotTree(sourceProfilePath);
    requireUnchangedTree(before, afterCopy);
    await rename(stagingPath, targetProfilePath);
    targetMoved = true;
    await input.ensureBrowsersStopped({ sourceRootPath, sourceProfilePath });
    requireUnchangedTree(before, await snapshotTree(sourceProfilePath));

    const { profile } = registerCopiedBrowserProfile({
      profileId,
      expectedRevision: input.expectedRegistryRevision,
      executablePath: inherited.executablePath,
      profileDirectory: inherited.profileDirectory,
      configPath: registryPath
    });
    registered = true;
    const rebound = rebindWorkspaceBrowserProfile(input.database, {
      profileId,
      expectedBindingRevision: input.expectedBindingRevision
    });
    const verification = await input.verifyProfile(profile);
    if (!verification.ok) {
      const binding = markWorkspaceBrowserBindingNeedsUser(input.database, {
        profileId,
        expectedBindingRevision: rebound.bindingRevision,
        error: verification.error
      });
      return { profile, binding, verified: false };
    }
    const binding = markWorkspaceBrowserBindingVerified(input.database, {
      profileId,
      expectedBindingRevision: rebound.bindingRevision,
      account: verification.account
    });
    return { profile, binding, verified: true };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    if (targetMoved && !registered) await rm(targetProfilePath, { recursive: true, force: true });
    throw error;
  }
}

function requireResolvedAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw migrationError('VALIDATION_ERROR', `${label} 必须是已解析的绝对路径。`);
  }
  return value;
}

type TreeEntry = { path: string; type: 'directory' | 'file'; size: number; mtimeMs: number };

async function requireDirectoryWithoutLinks(targetPath: string, label: string): Promise<void> {
  const status = await lstat(targetPath);
  if (status.isSymbolicLink()) throw migrationError('VALIDATION_ERROR', `${label}不能是符号链接、junction 或 reparse point。`);
  if (!status.isDirectory()) throw migrationError('VALIDATION_ERROR', `${label}不是目录。`);
}

async function snapshotTree(rootPath: string): Promise<TreeEntry[]> {
  const snapshot: TreeEntry[] = [];
  const visit = async (targetPath: string, relativePath: string): Promise<void> => {
    const status = await lstat(targetPath);
    if (status.isSymbolicLink()) throw migrationError('VALIDATION_ERROR', `Legacy 浏览器档案包含链接：${relativePath}`);
    if (status.isDirectory()) {
      snapshot.push({ path: relativePath, type: 'directory', size: status.size, mtimeMs: status.mtimeMs });
      const entries = await readdir(targetPath);
      for (const name of entries) await visit(path.join(targetPath, name), relativePath === '.' ? name : path.join(relativePath, name));
      return;
    }
    if (!status.isFile()) throw migrationError('VALIDATION_ERROR', `Legacy 浏览器档案包含不支持的文件类型：${relativePath}`);
    snapshot.push({ path: relativePath, type: 'file', size: status.size, mtimeMs: status.mtimeMs });
  };
  await visit(rootPath, '.');
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

function requireUnchangedTree(before: TreeEntry[], after: TreeEntry[]): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw migrationError('WORKSPACE_BUSY', 'Legacy 浏览器档案在复制期间发生变化，请停止相关进程后重试。');
  }
}

function migrationError(
  code: 'VALIDATION_ERROR' | 'PROFILE_STALE' | 'BROWSER_PROFILE_MISMATCH' | 'WORKSPACE_BUSY',
  message: string
): Error {
  return Object.assign(new Error(message), { code });
}
