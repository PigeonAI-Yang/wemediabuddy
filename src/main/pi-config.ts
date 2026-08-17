import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelLimits, modelOption, requireModelLimits, type PiModelOption } from './pi-model.ts';
import type { RoleId as SharedRoleId } from '../shared/agent-capabilities.ts';
import type { RoleModelCandidate as SharedRoleModelCandidate, RoleModelPolicies as SharedRoleModelPolicies, RoleModelPolicy as SharedRoleModelPolicy, RoleModelThinkingLevel } from '../shared/pi-config.ts';

const configKey = 'pi-api-config';
const { app, safeStorage } = electron;

export type RoleId = SharedRoleId;
export const ROLE_IDS: readonly RoleId[] = Object.freeze(['desk', 'reporter', 'planner', 'writer', 'librarian'] as const);

export type PiApiType = 'openai-responses' | 'openai-completions';
export type PiThinkingLevel = RoleModelThinkingLevel;

type StoredProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api?: PiApiType;
  thinking?: PiThinkingLevel;
  nativeSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  encryptedApiKey: string;
};

type MutableRoleModelPolicies = Record<RoleId, { candidates: SharedRoleModelCandidate[] }>;
type StoredStateV3 = {
  version: 3;
  activeId: string | null;
  profiles: StoredProfile[];
  modelPolicyRevision: number;
  roleModelPolicies: MutableRoleModelPolicies;
};
type LegacyConfig = { baseUrl: string; model: string; encryptedApiKey: string; api?: PiApiType };

export type RoleModelCandidate = SharedRoleModelCandidate;
export type RoleModelPolicy = SharedRoleModelPolicy;
export type RoleModelPolicies = SharedRoleModelPolicies;

export type RoleModelPolicyStateV3 = Readonly<{
  version: 3;
  activeId: string | null;
  profiles: readonly PiConfigProfile[];
  modelPolicyRevision: number;
  roleModelPolicies: RoleModelPolicies;
}>;

export type PiConfigProfile = Readonly<{
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  thinking?: PiThinkingLevel;
  nativeSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  configured: boolean;
  active: boolean;
}>;

export type PiConfig = Readonly<RoleModelPolicyStateV3 & {
  /** Retained as an empty compatibility key; runtime fallback is role-policy-only. */
  fallbackOrder: readonly string[];
  baseUrl: string;
  model: string;
  configured: boolean;
}>;
export type PiConfigV3 = PiConfig;

export type ResolvedPiConfig = Readonly<{
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  thinking?: PiThinkingLevel;
  nativeSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  apiKey: string;
}>;

export type ModelPolicyProfileSnapshot = Readonly<{
  profileId: string;
  profileName: string;
  baseUrl: string;
  api: PiApiType;
  model: string;
  thinking?: PiThinkingLevel;
  nativeSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}>;
export type PolicyProfileSnapshot = ModelPolicyProfileSnapshot;
export type ModelPolicySnapshot = Readonly<{
  revision: number;
  roleId: RoleId;
  profiles: readonly ModelPolicyProfileSnapshot[];
}>;

export type RoleModelPolicyErrorCode =
  | 'ROLE_MODEL_POLICY_REQUIRED'
  | 'ROLE_MODEL_PROFILE_MISSING'
  | 'ROLE_MODEL_AUTH_FAILED'
  | 'ROLE_MODEL_CONFIG_INVALID'
  | 'ROLE_MODEL_CHAIN_EXHAUSTED'
  | 'ROLE_MODEL_PROFILE_IN_USE'
  | 'ROLE_MODEL_POLICY_REVISION_CONFLICT';

export class RoleModelPolicyError extends Error {
  readonly code: RoleModelPolicyErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: RoleModelPolicyErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RoleModelPolicyError';
    this.code = code;
    this.details = details ? freezeValue({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function requirePiApiType(value: unknown): PiApiType {
  if (value === 'openai-responses' || value === 'openai-completions') return value;
  throw new Error(`Pi 接口类型不受支持：${String(value)}。仅支持 OpenAI Responses 或 OpenAI Chat Completions。`);
}

export function readPiConfig(configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  const active = state.profiles.find((profile) => profile.id === state.activeId) ?? null;
  const profiles = state.profiles.map((profile) => publicProfile(profile, profile.id === active?.id));
  const roleModelPolicies = publicRoleModelPolicies(state.roleModelPolicies);
  return freezeValue({
    version: 3 as const,
    activeId: active?.id ?? null,
    profiles,
    modelPolicyRevision: state.modelPolicyRevision,
    roleModelPolicies,
    // The v3 persisted state intentionally has no global fallback chain.
    fallbackOrder: Object.freeze([] as string[]),
    baseUrl: active?.baseUrl ?? '',
    model: active?.model ?? '',
    configured: Boolean(active?.encryptedApiKey)
  });
}

export function savePiConfig(input: {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  thinking?: PiThinkingLevel;
  nativeSearch?: boolean;
  contextWindow?: number | null;
  maxTokens?: number | null;
  apiKey?: string;
}, configPath = defaultConfigPath()): PiConfig {
  const api = requirePiApiType(input.api);
  const baseUrl = new URL(input.baseUrl.trim());
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Pi API 地址必须使用 HTTP 或 HTTPS。');
  const name = input.name.trim();
  if (!name) throw new Error('请填写配置名称。');
  const model = input.model.trim();
  if (!model) throw new Error('请填写 Pi 使用的模型名称。');
  if (input.id !== undefined && !input.id.trim()) throw new Error('API 配置 ID 不能为空。');

  const state = readStored(configPath);
  const id = input.id ?? randomUUID();
  const current = state.profiles.find((profile) => profile.id === id);
  const limits = requireModelLimits({
    contextWindow: input.contextWindow === null ? undefined : input.contextWindow ?? (current?.model === model ? current.contextWindow : undefined),
    maxTokens: input.maxTokens === null ? undefined : input.maxTokens ?? (current?.model === model ? current.maxTokens : undefined)
  });
  const encryptedApiKey = input.apiKey?.trim()
    ? safeStorage.encryptString(input.apiKey.trim()).toString('base64')
    : current?.encryptedApiKey;
  if (!encryptedApiKey) throw new Error('请填写 Pi API Key。');

  const profile: StoredProfile = {
    id,
    name,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    model,
    api,
    thinking: input.thinking ?? current?.thinking,
    nativeSearch: input.nativeSearch ?? current?.nativeSearch,
    ...limits,
    encryptedApiKey
  };
  const profiles = [profile, ...state.profiles.filter((item) => item.id !== id)];
  const roleModelPolicies = state.profiles.length === 0
    ? policiesForFirstProfile(profile)
    : state.roleModelPolicies;
  writeStored(configPath, {
    ...state,
    activeId: id,
    profiles,
    roleModelPolicies
  });
  return readPiConfig(configPath);
}

export function activatePiConfig(id: string, configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  if (!state.profiles.some((profile) => profile.id === id)) throw new Error('API 配置不存在。');
  writeStored(configPath, { ...state, activeId: id });
  return readPiConfig(configPath);
}

export type DeletePiConfigOptions = {
  roleReferences?: readonly RoleId[];
  taskReferences?: readonly { taskId: string; roleId?: RoleId }[];
};

export function deletePiConfig(id: string, configPath = defaultConfigPath(), options: DeletePiConfigOptions = {}): PiConfig {
  const state = readStored(configPath);
  const target = state.profiles.find((profile) => profile.id === id);
  if (!target) throw new Error('API 配置不存在。');

  const roleIds = new Set<RoleId>();
  for (const roleId of ROLE_IDS) {
    if (state.roleModelPolicies[roleId].candidates.some((candidate) => candidate.profileId === id)) roleIds.add(roleId);
  }
  for (const roleId of options.roleReferences ?? []) {
    if (isRoleId(roleId)) roleIds.add(roleId);
  }
  const taskReferences = (options.taskReferences ?? [])
    .filter((reference) => typeof reference?.taskId === 'string' && reference.taskId.trim())
    .map((reference) => ({ taskId: reference.taskId, ...(reference.roleId && isRoleId(reference.roleId) ? { roleId: reference.roleId } : {}) }));
  if (roleIds.size || taskReferences.length) {
    const roleList = ROLE_IDS.filter((roleId) => roleIds.has(roleId));
    const taskList = taskReferences.map((reference) => reference.taskId).join('、');
    const roleListText = roleList.join('、');
    throw new RoleModelPolicyError(
      'ROLE_MODEL_PROFILE_IN_USE',
      `模型预设「${target.name}」仍被角色${roleListText || '策略'}或未终态任务引用，不能删除。${taskList ? `任务：${taskList}` : ''}`,
      { profileId: id, roleIds: roleList, taskReferences }
    );
  }

  const profiles = state.profiles.filter((profile) => profile.id !== id);
  const activeId = state.activeId === id ? (profiles[0]?.id ?? null) : state.activeId;
  writeStored(configPath, { ...state, activeId, profiles });
  return readPiConfig(configPath);
}

/** The former global fallback-order mutation is intentionally unavailable in v3. */
export function setPiFallbackOrder(_ids: string[], configPath = defaultConfigPath()): PiConfig {
  readStored(configPath);
  throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'v3 已移除全局 AI 降级链，请按角色保存模型策略。');
}

export function readRoleModelPolicies(configPath = defaultConfigPath()): Readonly<{
  version: 3;
  modelPolicyRevision: number;
  roleModelPolicies: RoleModelPolicies;
}> {
  const state = readStored(configPath);
  return freezeValue({
    version: 3 as const,
    modelPolicyRevision: state.modelPolicyRevision,
    roleModelPolicies: publicRoleModelPolicies(state.roleModelPolicies)
  });
}

export type SaveRoleModelPoliciesInput = {
  roleModelPolicies: RoleModelPolicies;
  expectedRevision?: number;
};

export function saveRoleModelPolicies(input: SaveRoleModelPoliciesInput, configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  if (input.expectedRevision !== undefined && input.expectedRevision !== state.modelPolicyRevision) {
    throw new RoleModelPolicyError(
      'ROLE_MODEL_POLICY_REVISION_CONFLICT',
      `模型角色策略已发生变化，请刷新后再保存（当前 revision=${state.modelPolicyRevision}）。`,
      { expectedRevision: input.expectedRevision, actualRevision: state.modelPolicyRevision }
    );
  }
  const roleModelPolicies = normalizeRoleModelPolicies(input.roleModelPolicies, state.profiles, state.profiles.length === 0);
  writeStored(configPath, {
    ...state,
    roleModelPolicies,
    modelPolicyRevision: state.modelPolicyRevision + 1
  });
  return readPiConfig(configPath);
}

export async function listPiModels(input: {
  id?: string;
  baseUrl: string;
  api: PiApiType;
  apiKey?: string;
}, configPath = defaultConfigPath()): Promise<PiModelOption[]> {
  requirePiApiType(input.api);
  const baseUrl = new URL(input.baseUrl.trim());
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Pi API 地址必须使用 HTTP 或 HTTPS。');
  const stored = input.id ? readStored(configPath).profiles.find((profile) => profile.id === input.id) : null;
  const apiKey = input.apiKey?.trim() || (stored ? decryptStoredApiKey(stored) : '');
  if (!apiKey) throw new Error('请先填写 API Key。');

  const response = await fetch(`${baseUrl.toString().replace(/\/$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）。`);
  const body = await response.json() as { data?: Array<Record<string, unknown>> };
  const models = [...new Map((body.data ?? [])
    .map(modelOption)
    .filter((item): item is PiModelOption => Boolean(item))
    .map((item) => [item.id, item])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error('接口没有返回可用模型。');
  return models;
}

export function resolvePiConfig(configPath = defaultConfigPath()): ResolvedPiConfig {
  const state = readStored(configPath);
  const activeId = state.activeId ?? state.profiles[0]?.id;
  const profile = activeId ? state.profiles.find((candidate) => candidate.id === activeId) : null;
  if (!profile) throw new Error('请先在设置中配置 Pi API。');
  return resolvedFromStoredProfile(profile);
}

/**
 * Profile lookup retained for image configuration and transitional callers.
 * It deliberately ignores the removed persisted global fallbackOrder.
 */
export function resolvePiConfigChain(configPath = defaultConfigPath(), options: { skipProfileIds?: Iterable<string> } = {}): ResolvedPiConfig[] {
  const state = readStored(configPath);
  if (!state.profiles.length) throw new Error('请先在设置中配置 Pi API。');
  const skip = new Set(options.skipProfileIds ?? []);
  const orderedIds = [
    ...(state.activeId ? [state.activeId] : []),
    ...state.profiles.map((profile) => profile.id)
  ].filter((id, index, all) => Boolean(id) && all.indexOf(id) === index && !skip.has(id));
  if (!orderedIds.length) return [];
  const byId = new Map(state.profiles.map((profile) => [profile.id, profile] as const));
  return orderedIds.map((id) => resolvedFromStoredProfile(byId.get(id)!));
}

export type RolePiConfigResolveOptions = { skipCandidateKeys?: Iterable<string> };

/** Stable identity for one role fallback candidate (provider preset + model). */
export function roleModelCandidateKey(profileId: string, model: string): string {
  return `${profileId}\u0000${model}`;
}

export function resolveRoleModelPolicySnapshot(roleId: RoleId, configPath = defaultConfigPath()): ModelPolicySnapshot {
  requireRoleId(roleId);
  const state = readStored(configPath);
  const policy = state.roleModelPolicies[roleId];
  if (!policy?.candidates.length) throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', `角色 ${roleId} 尚未配置模型策略。`, { roleId, revision: state.modelPolicyRevision });
  const byId = new Map(state.profiles.map((profile) => [profile.id, profile] as const));
  const profiles = policy.candidates.map((candidate) => {
    const profile = byId.get(candidate.profileId);
    if (!profile) throw roleModelError('ROLE_MODEL_PROFILE_MISSING', `角色 ${roleId} 引用的模型预设不存在：${candidate.profileId}。`, { roleId, profileId: candidate.profileId, model: candidate.model, revision: state.modelPolicyRevision });
    if (!profile.encryptedApiKey) throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${profile.name}」尚未配置 API Key。`, { roleId, profileId: candidate.profileId, model: candidate.model, revision: state.modelPolicyRevision });
    return snapshotFromStoredProfile(profile, candidate.model, candidate.thinking ?? profile.thinking);
  });
  return freezeValue({ revision: state.modelPolicyRevision, roleId, profiles });
}

export function resolveRolePiConfigChain(
  roleId: RoleId,
  policySnapshot?: ModelPolicySnapshot,
  configPath = defaultConfigPath(),
  options: RolePiConfigResolveOptions = {}
): ResolvedPiConfig[] {
  requireRoleId(roleId);
  const snapshot = policySnapshot ?? resolveRoleModelPolicySnapshot(roleId, configPath);
  if (!isModelPolicySnapshot(snapshot) || snapshot.roleId !== roleId) {
    throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `角色 ${roleId} 的模型策略快照无效。`, { roleId });
  }
  if (!snapshot.profiles.length) throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', `角色 ${roleId} 尚未配置模型策略。`, { roleId, revision: snapshot.revision });

  const state = readStored(configPath);
  const byId = new Map(state.profiles.map((profile) => [profile.id, profile] as const));
  const skip = new Set(options.skipCandidateKeys ?? []);
  return snapshot.profiles
    .filter((snapshotProfile) => !skip.has(roleModelCandidateKey(snapshotProfile.profileId, snapshotProfile.model)))
    .map((snapshotProfile) => {
      const stored = byId.get(snapshotProfile.profileId);
      if (!stored) {
        throw roleModelError(
          'ROLE_MODEL_PROFILE_MISSING',
          `角色 ${roleId} 的模型策略快照引用不存在的预设：${snapshotProfile.profileId}。`,
          { roleId, profileId: snapshotProfile.profileId, model: snapshotProfile.model, revision: snapshot.revision }
        );
      }
      if (!stored.encryptedApiKey) {
        throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${snapshotProfile.profileName}」尚未配置 API Key。`, { roleId, profileId: snapshotProfile.profileId, model: snapshotProfile.model, revision: snapshot.revision });
      }
      let apiKey: string;
      try {
        apiKey = decryptStoredApiKey(stored);
      } catch (error) {
        throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${snapshotProfile.profileName}」的 API Key 无法解密。`, { roleId, profileId: snapshotProfile.profileId, model: snapshotProfile.model, revision: snapshot.revision, cause: error instanceof Error ? error.message : String(error) });
      }
      // Keep the frozen provider snapshot while explicitly overriding its model
      // from the candidate pair. This allows one preset to occur more than once.
      return freezeValue({
        id: snapshotProfile.profileId,
        name: snapshotProfile.profileName,
        baseUrl: snapshotProfile.baseUrl,
        model: snapshotProfile.model,
        api: snapshotProfile.api,
        thinking: snapshotProfile.thinking,
        nativeSearch: snapshotProfile.nativeSearch,
        contextWindow: snapshotProfile.contextWindow,
        maxTokens: snapshotProfile.maxTokens,
        apiKey
      });
    });
}

export function isModelPolicySnapshot(value: unknown): value is ModelPolicySnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0 || !isRoleId(candidate.roleId)) return false;
  if (!Array.isArray(candidate.profiles) || candidate.profiles.length === 0) return false;
  const seen = new Set<string>();
  return candidate.profiles.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const profile = item as Record<string, unknown>;
    if (typeof profile.profileId !== 'string' || !profile.profileId || typeof profile.model !== 'string' || !profile.model) return false;
    const identity = roleModelCandidateKey(profile.profileId, profile.model);
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (typeof profile.profileName !== 'string' || !profile.profileName || typeof profile.baseUrl !== 'string' || !profile.baseUrl.trim()) return false;
    try {
      requirePiApiType(profile.api);
      const baseUrl = new URL(profile.baseUrl);
      if (!['http:', 'https:'].includes(baseUrl.protocol)) return false;
      requireModelLimits({
        contextWindow: typeof profile.contextWindow === 'number' ? profile.contextWindow : undefined,
        maxTokens: typeof profile.maxTokens === 'number' ? profile.maxTokens : undefined
      });
    } catch {
      return false;
    }
    return profile.thinking === undefined || isThinkingLevel(profile.thinking);
  });
}

export function migratePiConfigToInstallation(configPath: string, rootPaths: string[]): { migratedFrom: string | null; profileCount: number } {
  if (existsSync(configPath)) return { migratedFrom: null, profileCount: readStored(configPath).profiles.length };
  const candidates: Array<{ rootPath: string; state: LegacyState }> = [];
  for (const rootPath of rootPaths) {
    const databasePath = path.join(rootPath, 'wmb.db');
    if (!existsSync(databasePath)) continue;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const profile = database.prepare("SELECT official_template_id AS templateId FROM workspace_profiles WHERE id='effective'").get() as { templateId?: string } | undefined;
      if (profile?.templateId !== 'official.ai') continue;
      const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(configKey) as { value: string } | undefined;
      if (row) candidates.push({ rootPath, state: normalizeLegacyState(JSON.parse(row.value)) });
    } finally { database.close(); }
  }
  if (candidates.length > 1) {
    const first = candidates[0]!.state;
    if (candidates.slice(1).some((candidate) => JSON.stringify(candidate.state) !== JSON.stringify(first))) {
      throw new Error('检测到多个不同的 AI 模型预设来源，无法自动迁移。');
    }
  }
  const selected = candidates[0] ?? null;
  const migrated = selected ? migrateLegacyState(selected.state) : emptyStoredState();
  writeStored(configPath, migrated);
  return { migratedFrom: selected?.rootPath ?? null, profileCount: migrated.profiles.length };
}

type LegacyState = { activeId: string | null; profiles: StoredProfile[]; fallbackOrder: string[] };

function defaultConfigPath(): string {
  return path.join(app.getPath('userData'), 'pi-api-config.json');
}

function readStored(configPath: string): StoredStateV3 {
  if (!existsSync(configPath)) return emptyStoredState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', `Pi 配置文件无法读取：${error instanceof Error ? error.message : String(error)}。`);
  }
  if (!parsed || typeof parsed !== 'object') throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'Pi 配置文件格式无效。');
  const candidate = parsed as Record<string, unknown>;
  const source = candidate.state && typeof candidate.state === 'object' ? candidate.state as Record<string, unknown> : candidate;
  if (candidate.version === 1) {
    const migrated = migrateLegacyState(normalizeLegacyState(source));
    writeStored(configPath, migrated);
    return migrated;
  }
  if (candidate.version === 2) {
    const migrated = migrateV2State(source);
    writeStored(configPath, migrated);
    return migrated;
  }
  if (candidate.version === 3) {
    return validateStoredState({
      version: 3,
      activeId: source.activeId as string | null,
      profiles: source.profiles as StoredProfile[],
      modelPolicyRevision: source.modelPolicyRevision as number,
      roleModelPolicies: source.roleModelPolicies as MutableRoleModelPolicies
    });
  }
  throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'Pi 配置文件版本不受支持。');
}

function emptyStoredState(): StoredStateV3 {
  return {
    version: 3,
    activeId: null,
    profiles: [],
    modelPolicyRevision: 0,
    roleModelPolicies: policiesForEmptyState()
  };
}

function normalizeLegacyState(value: unknown): LegacyState {
  if (!value || typeof value !== 'object') throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', '旧 Pi 配置格式无效。');
  const record = value as Record<string, unknown>;
  if (record.version === 1 && record.state && typeof record.state === 'object') return normalizeLegacyState(record.state);
  if (Array.isArray(record.profiles)) {
    const profiles = record.profiles.map((item, index) => normalizeLegacyProfile(item, index));
    const activeId = typeof record.activeId === 'string' && record.activeId ? record.activeId : null;
    return { activeId, profiles, fallbackOrder: sanitizeFallbackOrder(record.fallbackOrder, profiles, activeId) };
  }
  if (typeof record.baseUrl === 'string' && typeof record.model === 'string') {
    const legacy = record as unknown as LegacyConfig;
    const profile: StoredProfile = {
      id: 'default',
      name: '默认配置',
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      api: legacy.api ?? 'openai-completions',
      encryptedApiKey: typeof legacy.encryptedApiKey === 'string' ? legacy.encryptedApiKey : ''
    };
    return { activeId: 'default', profiles: [profile], fallbackOrder: [] };
  }
  throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', '旧 Pi 配置缺少模型预设。');
}

function normalizeLegacyProfile(value: unknown, index: number): StoredProfile {
  if (!value || typeof value !== 'object') throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', `旧 Pi 配置中的模型预设 ${index + 1} 无效。`);
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' ? record.id : '',
    name: typeof record.name === 'string' ? record.name : '',
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    model: typeof record.model === 'string' ? record.model : '',
    api: record.api === undefined ? 'openai-completions' : requirePiApiType(record.api),
    thinking: record.thinking as PiThinkingLevel | undefined,
    nativeSearch: typeof record.nativeSearch === 'boolean' ? record.nativeSearch : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    maxTokens: typeof record.maxTokens === 'number' ? record.maxTokens : undefined,
    encryptedApiKey: typeof record.encryptedApiKey === 'string' ? record.encryptedApiKey : ''
  };
}

function migrateV2State(source: Record<string, unknown>): StoredStateV3 {
  const profiles = Array.isArray(source.profiles) ? source.profiles as StoredProfile[] : [];
  const byId = new Map<string, StoredProfile>();
  for (const value of profiles) {
    if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') byId.set((value as { id: string }).id, value);
  }
  const rawPolicies = source.roleModelPolicies && typeof source.roleModelPolicies === 'object'
    ? source.roleModelPolicies as Record<string, unknown>
    : {};
  const roleModelPolicies = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) {
    const rawPolicy = rawPolicies[roleId];
    const profileIds = rawPolicy && typeof rawPolicy === 'object' && Array.isArray((rawPolicy as { profileIds?: unknown }).profileIds)
      ? (rawPolicy as { profileIds: unknown[] }).profileIds
      : [];
    roleModelPolicies[roleId] = {
      candidates: profileIds.map((profileId) => {
        const normalizedId = typeof profileId === 'string' ? profileId : '';
        return { profileId: normalizedId, model: byId.get(normalizedId)?.model ?? '' };
      })
    };
  }
  return validateStoredState({
    version: 3,
    activeId: source.activeId as string | null,
    profiles,
    modelPolicyRevision: source.modelPolicyRevision as number,
    roleModelPolicies
  });
}

function migrateLegacyState(legacy: LegacyState): StoredStateV3 {
  const profiles = legacy.profiles.map((profile) => ({ ...profile }));
  const known = new Set(profiles.map((profile) => profile.id));
  const activeId = legacy.activeId && known.has(legacy.activeId) ? legacy.activeId : null;
  const profileIds = sanitizeFallbackOrder([...(activeId ? [activeId] : []), ...legacy.fallbackOrder], profiles, null);
  if (profiles.length && !profileIds.length) throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', '旧 Pi 配置没有可迁移的模型策略。');
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const roleModelPolicies = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) {
    roleModelPolicies[roleId] = {
      candidates: profileIds.map((profileId) => ({ profileId, model: byId.get(profileId)!.model }))
    };
  }
  return validateStoredState({ version: 3, activeId, profiles, modelPolicyRevision: 1, roleModelPolicies });
}

function validateStoredProfile(value: StoredProfile, index: number): StoredProfile {
  if (!value || typeof value !== 'object') throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设 ${index + 1} 无效。`);
  const profile = { ...value };
  if (typeof profile.id !== 'string' || !profile.id.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设 ${index + 1} 缺少 ID。`);
  if (typeof profile.name !== 'string' || !profile.name.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.id}」名称无效。`);
  if (typeof profile.baseUrl !== 'string' || !profile.baseUrl.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」地址无效。`);
  try {
    const baseUrl = new URL(profile.baseUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('protocol');
  } catch {
    throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」地址必须使用 HTTP 或 HTTPS。`, { profileId: profile.id });
  }
  if (typeof profile.model !== 'string' || !profile.model.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」模型名无效。`, { profileId: profile.id });
  let api: PiApiType;
  try {
    api = requirePiApiType(profile.api);
  } catch (error) {
    throw roleModelError('ROLE_MODEL_CONFIG_INVALID', error instanceof Error ? error.message : String(error), { profileId: profile.id });
  }
  if (profile.thinking !== undefined && !isThinkingLevel(profile.thinking)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」思考等级无效。`, { profileId: profile.id });
  if (profile.nativeSearch !== undefined && typeof profile.nativeSearch !== 'boolean') throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」原生搜索开关无效。`, { profileId: profile.id });
  try {
    requireModelLimits({ contextWindow: profile.contextWindow, maxTokens: profile.maxTokens });
  } catch (error) {
    throw roleModelError('ROLE_MODEL_CONFIG_INVALID', error instanceof Error ? error.message : String(error), { profileId: profile.id });
  }
  if (typeof profile.encryptedApiKey !== 'string') throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」密钥存储无效。`, { profileId: profile.id });
  return { ...profile, api };
}


function validateStoredState(state: StoredStateV3): StoredStateV3 {
  if (state.version !== 3 || !Number.isSafeInteger(state.modelPolicyRevision) || state.modelPolicyRevision < 0 || !Array.isArray(state.profiles)) {
    throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'Pi v3 配置格式无效。');
  }
  const profiles = state.profiles.map((profile, index) => validateStoredProfile(profile, index));
  const seenProfileIds = new Set<string>();
  for (const profile of profiles) {
    if (seenProfileIds.has(profile.id)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设 ID 重复：${profile.id}。`, { profileId: profile.id });
    seenProfileIds.add(profile.id);
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const activeId = state.activeId === null ? null : (typeof state.activeId === 'string' ? state.activeId : '');
  if (activeId && !byId.has(activeId)) throw roleModelError('ROLE_MODEL_PROFILE_MISSING', `当前激活模型预设不存在：${activeId}。`, { profileId: activeId });
  const roleModelPolicies = normalizeRoleModelPolicies(state.roleModelPolicies, profiles, profiles.length === 0);
  return { version: 3, activeId: activeId || null, profiles, modelPolicyRevision: state.modelPolicyRevision, roleModelPolicies };
}

function normalizeRoleModelPolicies(input: unknown, profiles: readonly StoredProfile[], allowEmpty: boolean): MutableRoleModelPolicies {
  if (!input || typeof input !== 'object') throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', '五个角色都必须配置模型策略。');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!isRoleId(key)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `未知角色模型策略：${key}。`);
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const result = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) {
    const policy = record[roleId];
    if (!policy || typeof policy !== 'object' || !Array.isArray((policy as { candidates?: unknown }).candidates)) {
      throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', `角色 ${roleId} 缺少模型策略。`, { roleId });
    }
    const candidates = (policy as { candidates: unknown[] }).candidates;
    if (!allowEmpty && candidates.length === 0) throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', `角色 ${roleId} 至少需要一个模型预设。`, { roleId });
    const seen = new Set<string>();
    const normalized: SharedRoleModelCandidate[] = [];
    for (const value of candidates) {
      if (!value || typeof value !== 'object') throw roleModelError('ROLE_MODEL_PROFILE_MISSING', `角色 ${roleId} 的模型候选无效。`, { roleId });
      const candidate = value as { profileId?: unknown; model?: unknown; thinking?: unknown };
      const profileId = typeof candidate.profileId === 'string' ? candidate.profileId.trim() : '';
      const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
      const thinking = candidate.thinking;
      if (!profileId || !model) throw roleModelError('ROLE_MODEL_PROFILE_MISSING', `角色 ${roleId} 的模型候选必须包含预设 ID 和模型名。`, { roleId });
      if (thinking !== undefined && !isThinkingLevel(thinking)) {
        throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `角色 ${roleId} 的模型候选思考等级无效。`, { roleId, profileId, model });
      }
      const identity = roleModelCandidateKey(profileId, model);
      if (seen.has(identity)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `角色 ${roleId} 的模型链包含重复候选：${profileId}（${model}）。`, { roleId, profileId, model });
      seen.add(identity);
      const profile = byId.get(profileId);
      if (!profile) throw roleModelError('ROLE_MODEL_PROFILE_MISSING', `角色 ${roleId} 引用的模型预设不存在：${profileId}。`, { roleId, profileId, model });
      if (!profile.encryptedApiKey) throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${profile.name}」尚未配置 API Key。`, { roleId, profileId, model });
      normalized.push({ profileId, model, ...(thinking === undefined ? {} : { thinking }) });
    }
    result[roleId] = { candidates: normalized };
  }
  return result;
}

function policiesForEmptyState(): MutableRoleModelPolicies {
  const result = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) result[roleId] = { candidates: [] };
  return result;
}

function policiesForFirstProfile(profile: StoredProfile): MutableRoleModelPolicies {
  const result = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) result[roleId] = { candidates: [{ profileId: profile.id, model: profile.model }] };
  return result;
}

function publicRoleModelPolicies(input: MutableRoleModelPolicies): RoleModelPolicies {
  const output = {} as Record<RoleId, RoleModelPolicy>;
  for (const roleId of ROLE_IDS) {
    output[roleId] = freezeValue({
      candidates: Object.freeze(input[roleId].candidates.map((candidate) => freezeValue({ ...candidate })))
    });
  }
  return freezeValue(output);
}

function publicProfile(profile: StoredProfile, active: boolean): PiConfigProfile {
  return freezeValue({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    api: requirePiApiType(profile.api),
    thinking: profile.thinking,
    nativeSearch: profile.nativeSearch,
    ...modelLimits(profile.model, profile),
    configured: Boolean(profile.encryptedApiKey),
    active
  });
}

function snapshotFromStoredProfile(profile: StoredProfile, model = profile.model, thinking = profile.thinking): ModelPolicyProfileSnapshot {
  return freezeValue({
    profileId: profile.id,
    profileName: profile.name,
    baseUrl: profile.baseUrl,
    api: requirePiApiType(profile.api),
    model,
    thinking,
    nativeSearch: profile.nativeSearch,
    ...modelLimits(model, model === profile.model ? profile : {})
  });
}

function resolvedFromStoredProfile(profile: StoredProfile, model = profile.model): ResolvedPiConfig {
  return freezeValue({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model,
    api: requirePiApiType(profile.api),
    thinking: profile.thinking,
    nativeSearch: profile.nativeSearch,
    ...modelLimits(model, model === profile.model ? profile : {}),
    apiKey: decryptStoredApiKey(profile)
  });
}

function decryptStoredApiKey(profile: StoredProfile): string {
  if (!profile.encryptedApiKey) return '';
  return safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, 'base64'));
}

function sanitizeFallbackOrder(ids: unknown, profiles: readonly StoredProfile[], activeId: string | null): string[] {
  if (!Array.isArray(ids)) return [];
  const known = new Set(profiles.map((profile) => profile.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const value of ids) {
    if (typeof value !== 'string' || !value || value === activeId || !known.has(value) || seen.has(value)) continue;
    seen.add(value);
    order.push(value);
  }
  return order;
}

function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value);
}

function requireRoleId(value: unknown): asserts value is RoleId {
  if (!isRoleId(value)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `未知智能体角色：${String(value)}。`, { roleId: value });
}

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

function roleModelError(code: RoleModelPolicyErrorCode, message: string, details?: Record<string, unknown>): RoleModelPolicyError {
  return new RoleModelPolicyError(code, message, details);
}

function freezeValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
  return value;
}

function validateBeforeWrite(state: StoredStateV3): StoredStateV3 {
  return validateStoredState({
    version: 3,
    activeId: state.activeId,
    profiles: state.profiles.map((profile) => ({ ...profile })),
    modelPolicyRevision: state.modelPolicyRevision,
    roleModelPolicies: Object.fromEntries(ROLE_IDS.map((roleId) => [roleId, {
      candidates: state.roleModelPolicies[roleId].candidates.map((candidate) => ({ ...candidate }))
    }])) as MutableRoleModelPolicies
  });
}

function writeStored(configPath: string, state: StoredStateV3): void {
  const validated = validateBeforeWrite(state);
  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'w');
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, configPath);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* preserve the original config if cleanup itself fails */ }
    throw error;
  }
}
