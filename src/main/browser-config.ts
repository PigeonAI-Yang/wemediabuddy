import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserConfig } from './browser.ts';

const defaultLabel = 'Edge · WMB 默认登录态';
const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let configuredPath: string | null = null;

export type BrowserProfileOrigin = 'installation' | 'legacy-copy' | 'v1-upgrade';
export type BrowserProfile = BrowserConfig & {
  origin: BrowserProfileOrigin;
  createdAt: string;
};
export type BrowserProfileRegistry = {
  version: 2;
  revision: number;
  defaultProfileId: string;
  profiles: BrowserProfile[];
};
type V1Envelope = { version: 1; config: BrowserConfig };

export function configureBrowserProfileRegistryPath(configPath: string): void {
  configuredPath = path.resolve(configPath);
}

export function readBrowserProfileRegistry(configPath = requiredPath()): BrowserProfileRegistry | null {
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) return null;
  const parsed = JSON.parse(readFileSync(resolved, 'utf8')) as V1Envelope | BrowserProfileRegistry;
  if (parsed.version === 1) {
    const upgraded = upgradeV1(parsed);
    writeRegistry(resolved, upgraded);
    return upgraded;
  }
  return validateRegistry(parsed, resolved);
}

export function openBrowserProfileRegistry(configPath = requiredPath()): BrowserProfileRegistry {
  const existing = readBrowserProfileRegistry(configPath);
  if (existing) return existing;
  const id = randomUUID();
  const now = new Date().toISOString();
  const profile: BrowserProfile = {
    id,
    label: defaultLabel,
    executablePath: edgeExecutable,
    userDataDir: browserProfilePath(configPath, id),
    profileDirectory: 'Default',
    origin: 'installation',
    createdAt: now
  };
  mkdirSync(profile.userDataDir, { recursive: true });
  const registry: BrowserProfileRegistry = { version: 2, revision: 1, defaultProfileId: id, profiles: [profile] };
  writeRegistry(path.resolve(configPath), registry);
  return registry;
}

export function createInstallationBrowserProfile(input: {
  expectedRevision: number;
  label?: string;
  executablePath?: string;
  profileDirectory?: string;
  configPath?: string;
}): { registry: BrowserProfileRegistry; profile: BrowserProfile } {
  const configPath = path.resolve(input.configPath ?? requiredPath());
  requireRevision(requireRegistry(configPath), input.expectedRevision);
  const id = randomUUID();
  const profile: BrowserProfile = {
    id,
    label: input.label?.trim() || `Browser Profile ${id.slice(0, 8)}`,
    executablePath: input.executablePath ?? edgeExecutable,
    userDataDir: browserProfilePath(configPath, id),
    profileDirectory: input.profileDirectory ?? 'Default',
    origin: 'installation',
    createdAt: new Date().toISOString()
  };
  mkdirSync(profile.userDataDir, { recursive: true });
  return { registry: registerBrowserProfile(profile, input.expectedRevision, configPath), profile };
}

export function registerCopiedBrowserProfile(input: {
  profileId: string;
  expectedRevision: number;
  label?: string;
  executablePath?: string;
  profileDirectory?: string;
  cdpUrl?: string;
  configPath?: string;
}): { registry: BrowserProfileRegistry; profile: BrowserProfile } {
  const configPath = path.resolve(input.configPath ?? requiredPath());
  const profile: BrowserProfile = {
    id: requireOpaqueId(input.profileId),
    label: input.label?.trim() || `Migrated Browser Profile ${input.profileId.slice(0, 8)}`,
    executablePath: input.executablePath ?? edgeExecutable,
    userDataDir: browserProfilePath(configPath, input.profileId),
    profileDirectory: input.profileDirectory ?? 'Default',
    ...(input.cdpUrl ? { cdpUrl: input.cdpUrl } : {}),
    origin: 'legacy-copy',
    createdAt: new Date().toISOString()
  };
  return { registry: registerBrowserProfile(profile, input.expectedRevision, configPath), profile };
}

export function setDefaultBrowserProfile(input: {
  profileId: string;
  expectedRevision: number;
  configPath?: string;
}): BrowserProfileRegistry {
  const configPath = path.resolve(input.configPath ?? requiredPath());
  const current = requireRegistry(configPath);
  requireRevision(current, input.expectedRevision);
  if (!current.profiles.some((profile) => profile.id === input.profileId)) {
    throw registryError('BROWSER_PROFILE_MISMATCH', '默认浏览器档案不存在。');
  }
  const next = { ...current, revision: current.revision + 1, defaultProfileId: input.profileId };
  writeRegistry(configPath, next);
  return next;
}

export function requireBrowserProfile(profileId: string, configPath = requiredPath()): BrowserProfile {
  const profile = requireRegistry(configPath).profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw registryError('BROWSER_PROFILE_MISMATCH', '浏览器档案不存在。');
  return profile;
}

export function readDefaultBrowserProfile(configPath = requiredPath()): BrowserProfile | null {
  const registry = readBrowserProfileRegistry(configPath);
  if (!registry) return null;
  return registry.profiles.find((profile) => profile.id === registry.defaultProfileId) ?? null;
}

export function browserProfilePath(configPath: string, profileId: string): string {
  return path.join(path.dirname(path.resolve(configPath)), 'browser-profiles', requireOpaqueId(profileId));
}


function registerBrowserProfile(profile: BrowserProfile, expectedRevision: number, configPath: string): BrowserProfileRegistry {
  const current = requireRegistry(configPath);
  requireRevision(current, expectedRevision);
  if (current.profiles.some((candidate) => candidate.id === profile.id)) {
    throw registryError('BROWSER_PROFILE_MISMATCH', '浏览器档案身份已存在。');
  }
  validateOwnedProfile(profile, configPath);
  const next = { ...current, revision: current.revision + 1, profiles: [...current.profiles, profile] };
  writeRegistry(configPath, next);
  return next;
}

function upgradeV1(envelope: V1Envelope): BrowserProfileRegistry {
  const config = { ...envelope.config };
  delete config.cdpUrl;
  const profile = { ...config, origin: 'v1-upgrade' as const, createdAt: new Date().toISOString() };
  return { version: 2, revision: 1, defaultProfileId: profile.id, profiles: [profile] };
}

function validateRegistry(value: BrowserProfileRegistry, configPath: string): BrowserProfileRegistry {
  if (value.version !== 2 || !Number.isInteger(value.revision) || value.revision < 1 || !Array.isArray(value.profiles)) {
    throw registryError('VALIDATION_ERROR', '浏览器档案注册表无效。');
  }
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!profile || typeof profile.id !== 'string' || ids.has(profile.id)) throw registryError('VALIDATION_ERROR', '浏览器档案身份无效。');
    ids.add(profile.id);
    if (profile.origin !== 'v1-upgrade') validateOwnedProfile(profile, configPath);
  }
  if (!ids.has(value.defaultProfileId)) throw registryError('BROWSER_PROFILE_MISMATCH', '默认浏览器档案已悬空。');
  return value;
}

function validateOwnedProfile(profile: BrowserProfile, configPath: string): void {
  requireOpaqueId(profile.id);
  if (path.resolve(profile.userDataDir) !== browserProfilePath(configPath, profile.id)) {
    throw registryError('BROWSER_PROFILE_MISMATCH', '浏览器档案路径不属于当前安装。');
  }
}

function requireOpaqueId(profileId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
    throw registryError('VALIDATION_ERROR', '浏览器档案身份必须是不透明 UUID。');
  }
  return profileId;
}

function requireRegistry(configPath: string): BrowserProfileRegistry {
  const registry = readBrowserProfileRegistry(configPath);
  if (!registry) throw registryError('VALIDATION_ERROR', '浏览器档案注册表尚未初始化。');
  return registry;
}

function requireRevision(registry: BrowserProfileRegistry, expectedRevision: number): void {
  if (registry.revision !== expectedRevision) throw registryError('PROFILE_STALE', '浏览器档案注册表已变化。');
}

function writeRegistry(configPath: string, registry: BrowserProfileRegistry): void {
  validateRegistry(registry, configPath);
  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, configPath);
}

function registryError(code: 'PROFILE_STALE' | 'BROWSER_PROFILE_MISMATCH' | 'VALIDATION_ERROR', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function requiredPath(): string {
  if (!configuredPath) throw registryError('VALIDATION_ERROR', '安装级浏览器配置路径尚未初始化。');
  return configuredPath;
}
