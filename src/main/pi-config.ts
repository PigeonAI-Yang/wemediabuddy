import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelLimits, modelOption, requireModelLimits, type PiModelOption } from './pi-model.ts';
import type { RoleId as SharedRoleId } from '../shared/agent-capabilities.ts';
import type { RoleModelCandidate as SharedRoleModelCandidate, RoleModelPolicies as SharedRoleModelPolicies, RoleModelPolicy as SharedRoleModelPolicy, RoleModelThinkingLevel } from '../shared/pi-config.ts';

const configKey = 'pi-api-config';
const { app, safeStorage } = electron;

function resolveUserDataPath(): string {
  const acceptanceUserData = process.env.WMB_ACCEPTANCE_USER_DATA?.trim();
  if (acceptanceUserData) return acceptanceUserData;
  if (app && typeof app.getPath === 'function') {
    try {
      return app.getPath('userData');
    } catch {}
  }
  const appData = process.env.APPDATA?.trim();
  if (appData) return path.join(appData, 'WeMediaBuddy');
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || (() => { try { return os.homedir(); } catch { return ''; } })();
  if (home) return path.join(home, 'AppData', 'Roaming', 'WeMediaBuddy');
  throw new Error('无法解析 Pi 配置路径：Electron app.getPath 不可用且未设置用户数据环境变量。');
}
export type RoleId = SharedRoleId;
export const ROLE_IDS: readonly RoleId[] = Object.freeze(['desk', 'reporter', 'planner', 'writer', 'librarian'] as const);

export type PiApiType = 'openai-responses' | 'openai-completions' | 'anthropic-messages';
export type PiThinkingLevel = RoleModelThinkingLevel;
export type ProviderAuthMode = 'bearer' | 'x-api-key' | 'none';
export type ProviderCredentialSource =
  | Readonly<{ kind: 'encrypted'; encryptedValue: string }>
  | Readonly<{ kind: 'environment'; variable: string }>
  | Readonly<{ kind: 'command'; executable: string; args: readonly string[] }>
  | Readonly<{ kind: 'none' }>;
export type ProviderCapabilities = Readonly<{
  text: boolean;
  vision: boolean;
  imageGeneration: boolean;
  nativeSearch: boolean;
  jsonOutput: boolean;
  streaming: boolean;
  modelIdDiscovery: boolean;
}>;
export type ProviderHealth = Readonly<{
  state: 'unknown' | 'healthy' | 'unhealthy';
  lastProbeAt?: string;
  lastError?: string;
}>;

type StoredProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api?: PiApiType;
  authMode?: ProviderAuthMode;
  credentialSource?: ProviderCredentialSource;
  capabilities?: ProviderCapabilities;
  health?: ProviderHealth;
  thinking?: PiThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
};

type MutableRoleModelPolicies = Record<RoleId, { candidates: SharedRoleModelCandidate[] }>;
type StoredStateV4 = {
  version: 4;
  activeId: string | null;
  profiles: StoredProfile[];
  modelPolicyRevision: number;
  roleModelPolicies: MutableRoleModelPolicies;
};
type LegacyStoredProfile = Omit<StoredProfile, 'credentialSource' | 'authMode' | 'capabilities' | 'health'> & { encryptedApiKey?: string; nativeSearch?: boolean };
type LegacyConfig = { baseUrl: string; model: string; encryptedApiKey: string; api?: PiApiType };

export type RoleModelCandidate = SharedRoleModelCandidate;
export type RoleModelPolicy = SharedRoleModelPolicy;
export type RoleModelPolicies = SharedRoleModelPolicies;

export type RoleModelPolicyStateV4 = Readonly<{
  version: 4;
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
  authMode: ProviderAuthMode;
  credentialSourceKind: ProviderCredentialSource['kind'];
  credentialSourceLabel: string;
  capabilities: ProviderCapabilities;
  health: ProviderHealth;
  thinking?: PiThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
  configured: boolean;
  active: boolean;
}>;

export type PiConfig = Readonly<RoleModelPolicyStateV4 & {
  /** Retained as an empty compatibility key; runtime fallback is role-policy-only. */
  fallbackOrder: readonly string[];
  baseUrl: string;
  model: string;
  configured: boolean;
}>;
export type PiConfigV4 = PiConfig;

export type ResolvedPiConfig = Readonly<{
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  authMode: ProviderAuthMode;
  credentialSourceKind: ProviderCredentialSource['kind'];
  capabilities: ProviderCapabilities;
  thinking?: PiThinkingLevel;
  nativeSearch: boolean;
  contextWindow?: number;
  maxTokens?: number;
  apiKey: string;
}>;

export type ModelPolicyProfileSnapshot = Readonly<{
  profileId: string;
  profileName: string;
  baseUrl: string;
  api: PiApiType;
  authMode: ProviderAuthMode;
  credentialSourceKind: ProviderCredentialSource['kind'];
  capabilities: ProviderCapabilities;
  model: string;
  thinking?: PiThinkingLevel;
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
  if (value === 'openai-responses' || value === 'openai-completions' || value === 'anthropic-messages') return value;
  throw new Error(`Pi 接口类型不受支持：${String(value)}。仅支持 OpenAI Responses、OpenAI Chat Completions 或 Anthropic Messages。`);
}

export function requireProviderAuthMode(value: unknown): ProviderAuthMode {
  if (value === 'bearer' || value === 'x-api-key' || value === 'none') return value;
  throw new Error(`Provider 鉴权模式不受支持：${String(value)}。`);
}

function defaultAuthMode(api: PiApiType): ProviderAuthMode {
  return api === 'anthropic-messages' ? 'x-api-key' : 'bearer';
}

function defaultCapabilities(api: PiApiType, nativeSearch = false): ProviderCapabilities {
  return freezeValue({ text: true, vision: true, imageGeneration: false, nativeSearch, jsonOutput: true, streaming: true, modelIdDiscovery: api !== 'anthropic-messages' });
}

function normalizeCredentialSource(value: unknown): ProviderCredentialSource {
  if (!value || typeof value !== 'object') return freezeValue({ kind: 'none' });
  const source = value as Record<string, unknown>;
  if (source.kind === 'encrypted' && typeof source.encryptedValue === 'string' && source.encryptedValue) return freezeValue({ kind: 'encrypted', encryptedValue: source.encryptedValue });
  if (source.kind === 'environment' && typeof source.variable === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.variable)) return freezeValue({ kind: 'environment', variable: source.variable });
  if (source.kind === 'command' && typeof source.executable === 'string' && source.executable.trim() && Array.isArray(source.args) && source.args.every((arg) => typeof arg === 'string')) {
    return freezeValue({ kind: 'command', executable: source.executable.trim(), args: [...source.args] as string[] });
  }
  if (source.kind === 'none') return freezeValue({ kind: 'none' });
  throw new Error('Provider 凭证来源无效。');
}

export function resolveProviderCredential(source: ProviderCredentialSource): string {
  if (source.kind === 'none') return '';
  if (source.kind === 'encrypted') return safeStorage.decryptString(Buffer.from(source.encryptedValue, 'base64')).trim();
  if (source.kind === 'environment') return process.env[source.variable]?.trim() ?? '';
  const result = spawnSync(source.executable, [...source.args], { encoding: 'utf8', windowsHide: true, timeout: 5_000, shell: false });
  if (result.error) throw new Error(`凭证命令执行失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`凭证命令退出码 ${result.status ?? 'unknown'}。`);
  return result.stdout.trim();
}

function credentialSourceLabel(source: ProviderCredentialSource): string {
  if (source.kind === 'encrypted') return '本机加密存储';
  if (source.kind === 'environment') return `环境变量 ${source.variable}`;
  if (source.kind === 'command') return `命令 ${source.executable}`;
  return '无需凭证';
}

function isCredentialConfigured(profile: StoredProfile): boolean {
  if (profile.authMode === 'none') return true;
  const source = profile.credentialSource ?? { kind: 'none' };
  if (source.kind === 'encrypted') return Boolean(source.encryptedValue);
  if (source.kind === 'environment') return Boolean(source.variable);
  if (source.kind === 'command') return Boolean(source.executable);
  return false;
}

export function readPiConfig(configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  const active = state.profiles.find((profile) => profile.id === state.activeId) ?? null;
  const profiles = state.profiles.map((profile) => publicProfile(profile, profile.id === active?.id));
  const roleModelPolicies = publicRoleModelPolicies(state.roleModelPolicies);
  return freezeValue({
    version: 4 as const,
    activeId: active?.id ?? null,
    profiles,
    modelPolicyRevision: state.modelPolicyRevision,
    roleModelPolicies,
    fallbackOrder: Object.freeze([] as string[]),
    baseUrl: active?.baseUrl ?? '',
    model: active?.model ?? '',
    configured: active ? isCredentialConfigured(active) : false
  });
}

export function savePiConfig(input: {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  authMode?: ProviderAuthMode;
  credentialSource?: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>;
  thinking?: PiThinkingLevel;
  text?: boolean;
  vision?: boolean;
  nativeSearch?: boolean;
  imageGeneration?: boolean;
  jsonOutput?: boolean;
  streaming?: boolean;
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
  const authMode = input.authMode === undefined ? current?.authMode ?? defaultAuthMode(api) : requireProviderAuthMode(input.authMode);
  const credentialSource = input.apiKey?.trim()
    ? freezeValue({ kind: 'encrypted', encryptedValue: safeStorage.encryptString(input.apiKey.trim()).toString('base64') } as const)
    : input.credentialSource
      ? normalizeCredentialSource(input.credentialSource)
      : current?.credentialSource ?? freezeValue({ kind: 'none' } as const);
  if (authMode !== 'none' && credentialSource.kind === 'none') throw new Error('请配置 Provider 凭证来源。');

  const profile: StoredProfile = {
    id,
    name,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    model,
    api,
    authMode,
    credentialSource,
    capabilities: freezeValue({
      ...defaultCapabilities(api, input.nativeSearch ?? current?.capabilities?.nativeSearch),
      text: input.text ?? current?.capabilities?.text ?? true,
      vision: input.vision ?? current?.capabilities?.vision ?? true,
      imageGeneration: input.imageGeneration ?? current?.capabilities?.imageGeneration ?? false,
      jsonOutput: input.jsonOutput ?? current?.capabilities?.jsonOutput ?? true,
      streaming: input.streaming ?? current?.capabilities?.streaming ?? true
    }),
    health: current?.health ?? freezeValue({ state: 'unknown' }),
    thinking: input.thinking ?? current?.thinking,
    ...limits
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

/** The former global fallback-order mutation is intentionally unavailable in v4. */
export function setPiFallbackOrder(_ids: string[], configPath = defaultConfigPath()): PiConfig {
  readStored(configPath);
  throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'v4 已移除全局 AI 降级链，请按角色保存模型策略。');
}

export function readRoleModelPolicies(configPath = defaultConfigPath()): Readonly<{
  version: 4;
  modelPolicyRevision: number;
  roleModelPolicies: RoleModelPolicies;
}> {
  const state = readStored(configPath);
  return freezeValue({ version: 4 as const, modelPolicyRevision: state.modelPolicyRevision, roleModelPolicies: publicRoleModelPolicies(state.roleModelPolicies) });
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
  authMode?: ProviderAuthMode;
  credentialSource?: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>;
  apiKey?: string;
}, configPath = defaultConfigPath()): Promise<PiModelOption[]> {
  const api = requirePiApiType(input.api);
  const baseUrl = new URL(input.baseUrl.trim());
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Pi API 地址必须使用 HTTP 或 HTTPS。');
  const stored = input.id ? readStored(configPath).profiles.find((profile) => profile.id === input.id) : null;
  const authMode = input.authMode ?? stored?.authMode ?? defaultAuthMode(api);
  const apiKey = input.apiKey?.trim() || resolveProviderCredential(input.credentialSource ? normalizeCredentialSource(input.credentialSource) : stored?.credentialSource ?? { kind: 'none' });
  if (authMode !== 'none' && !apiKey) throw new Error('Provider 凭证不可用。');
  const headers = providerHeaders(authMode, apiKey, api);
  const response = await fetch(`${baseUrl.toString().replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）。`);
  const body = await response.json() as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
  const models = [...new Map((body.data ?? body.models ?? []).map(modelOption).filter((item): item is PiModelOption => Boolean(item)).map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error('接口没有返回可用模型。');
  return models;
}

function providerHeaders(authMode: ProviderAuthMode, apiKey: string, api: PiApiType): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authMode === 'bearer' && apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (authMode === 'x-api-key' && apiKey) headers['x-api-key'] = apiKey;
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  return headers;
}
export type ProviderDiscoveryCandidate = Readonly<{
  source: 'antigravity-manager' | 'cockpit-codex' | 'cockpit-custom' | 'environment';
  name: string;
  baseUrl: string;
  api: PiApiType;
  authMode: ProviderAuthMode;
  credentialSource: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>;
  capabilities: ProviderCapabilities;
  suggestedModel?: string;
  models?: readonly PiModelOption[];
}>;

function cockpitWireApi(value: unknown): PiApiType | null {
  if (value === 'responses') return 'openai-responses';
  if (value === 'chat_completions') return 'openai-completions';
  if (value === 'anthropic_messages') return 'anthropic-messages';
  return null;
}

export function discoverPiProviders(): ProviderDiscoveryCandidate[] {
  const discovered: ProviderDiscoveryCandidate[] = [];
  const home = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || os.homedir();
  const cockpitRoot = path.join(home, '.antigravity_cockpit');
  const cockpitPath = path.join(cockpitRoot, 'codex_local_access.json');
  if (existsSync(cockpitPath)) {
    try {
      const record = JSON.parse(readFileSync(cockpitPath, 'utf8')) as { enabled?: boolean; port?: number; imageGenerationMode?: string };
      if (record.enabled && Number.isSafeInteger(record.port) && Number(record.port) > 0) {
        const escapedPath = cockpitPath.replace(/'/g, "''");
        discovered.push(freezeValue({
          source: 'cockpit-codex', name: 'Cockpit Codex 本机反代', baseUrl: `http://127.0.0.1:${record.port}/v1`, api: 'openai-responses', authMode: 'bearer',
          credentialSource: { kind: 'command', executable: 'powershell.exe', args: ['-NoProfile', '-Command', `(Get-Content -Raw '${escapedPath}' | ConvertFrom-Json).apiKey`] },
          capabilities: { ...defaultCapabilities('openai-responses'), imageGeneration: record.imageGenerationMode === 'enabled' }, suggestedModel: 'gpt-5.5'
        }));
      }
    } catch { /* malformed external discovery metadata is ignored */ }
  }
  const customProvidersPath = path.join(cockpitRoot, 'codex_model_providers.json');
  if (existsSync(customProvidersPath)) {
    try {
      const records = JSON.parse(readFileSync(customProvidersPath, 'utf8')) as Array<Record<string, unknown>>;
      const escapedPath = customProvidersPath.replace(/'/g, "''");
      for (const record of Array.isArray(records) ? records : []) {
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim().replace(/\/$/, '') : '';
        const api = cockpitWireApi(record.wireApi);
        const keys = Array.isArray(record.apiKeys) ? record.apiKeys as Array<Record<string, unknown>> : [];
        const models = Array.isArray(record.modelCatalog)
          ? [...new Set(record.modelCatalog.filter((model): model is string => typeof model === 'string' && Boolean(model.trim())).map((model) => model.trim()))].map((model) => ({ id: model, ...modelLimits(model) }))
          : [];
        if (!id || !name || !baseUrl || !api || !keys.some((key) => typeof key.apiKey === 'string' && Boolean(key.apiKey.trim()))) continue;
        const escapedId = id.replace(/'/g, "''");
        discovered.push(freezeValue({
          source: 'cockpit-custom', name: `Cockpit 自定义 Provider · ${name}`, baseUrl, api, authMode: defaultAuthMode(api),
          credentialSource: { kind: 'command', executable: 'powershell.exe', args: ['-NoProfile', '-Command', `((Get-Content -Raw '${escapedPath}' | ConvertFrom-Json) | Where-Object { $_.id -eq '${escapedId}' }).apiKeys | Where-Object { $_.apiKey } | Select-Object -First 1 -ExpandProperty apiKey`] },
          capabilities: { ...defaultCapabilities(api), vision: record.supportsVision === true }, suggestedModel: models[0]?.id, models
        }));
      }
    } catch { /* malformed external discovery metadata is ignored */ }
  }
  const managerBaseUrl = process.env.ANTIGRAVITY_MANAGER_BASE_URL?.trim();
  const managerTokenVariable = process.env.ANTIGRAVITY_MANAGER_TOKEN ? 'ANTIGRAVITY_MANAGER_TOKEN' : process.env.ANTIGRAVITY_API_KEY ? 'ANTIGRAVITY_API_KEY' : '';
  if (managerBaseUrl) {
    discovered.push(freezeValue({ source: 'antigravity-manager', name: 'Antigravity Manager', baseUrl: managerBaseUrl.replace(/\/$/, ''), api: 'openai-responses', authMode: managerTokenVariable ? 'bearer' : 'none', credentialSource: managerTokenVariable ? { kind: 'environment', variable: managerTokenVariable } : { kind: 'none' }, capabilities: defaultCapabilities('openai-responses') }));
  }
  const genericBaseUrl = process.env.WMB_PROVIDER_BASE_URL?.trim();
  if (genericBaseUrl) {
    const api = requirePiApiType(process.env.WMB_PROVIDER_PROTOCOL?.trim() || 'openai-responses');
    const variable = process.env.WMB_PROVIDER_API_KEY ? 'WMB_PROVIDER_API_KEY' : '';
    discovered.push(freezeValue({ source: 'environment', name: process.env.WMB_PROVIDER_NAME?.trim() || '环境 Provider', baseUrl: genericBaseUrl.replace(/\/$/, ''), api, authMode: variable ? defaultAuthMode(api) : 'none', credentialSource: variable ? { kind: 'environment', variable } : { kind: 'none' }, capabilities: defaultCapabilities(api), suggestedModel: process.env.WMB_PROVIDER_MODEL?.trim() || undefined }));
  }
  return discovered;
}

export async function probePiProvider(input: {
  id?: string;
  baseUrl: string;
  api: PiApiType;
  authMode?: ProviderAuthMode;
  credentialSource?: Exclude<ProviderCredentialSource, { kind: 'encrypted' }>;
  apiKey?: string;
}, configPath = defaultConfigPath()): Promise<ProviderHealth & { modelCount?: number }> {
  const probedAt = new Date().toISOString();
  try {
    const models = await listPiModels(input, configPath);
    const health = freezeValue({ state: 'healthy' as const, lastProbeAt: probedAt });
    updateStoredHealth(input.id, health, configPath);
    return freezeValue({ ...health, modelCount: models.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const health = freezeValue({ state: 'unhealthy' as const, lastProbeAt: probedAt, lastError: message });
    updateStoredHealth(input.id, health, configPath);
    return health;
  }
}

function updateStoredHealth(id: string | undefined, health: ProviderHealth, configPath: string): void {
  if (!id) return;
  const state = readStored(configPath);
  if (!state.profiles.some((profile) => profile.id === id)) return;
  writeStored(configPath, { ...state, profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, health } : profile) });
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
    if (!isCredentialConfigured(profile)) throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${profile.name}」的凭证不可用。`, { roleId, profileId: candidate.profileId, model: candidate.model, revision: state.modelPolicyRevision });
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
      let apiKey: string;
      try {
        apiKey = resolveProviderCredential(stored.credentialSource ?? { kind: 'none' });
        if (stored.authMode !== 'none' && !apiKey) throw new Error('凭证为空');
      } catch (error) {
        throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${snapshotProfile.profileName}」的凭证无法解析。`, { roleId, profileId: snapshotProfile.profileId, model: snapshotProfile.model, revision: snapshot.revision, cause: error instanceof Error ? error.message : String(error) });
      }
      return freezeValue({
        id: snapshotProfile.profileId,
        name: snapshotProfile.profileName,
        baseUrl: snapshotProfile.baseUrl,
        model: snapshotProfile.model,
        api: snapshotProfile.api,
        authMode: snapshotProfile.authMode,
        credentialSourceKind: snapshotProfile.credentialSourceKind,
        capabilities: snapshotProfile.capabilities,
        nativeSearch: snapshotProfile.capabilities.nativeSearch,
        thinking: snapshotProfile.thinking,
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

type LegacyState = { activeId: string | null; profiles: LegacyStoredProfile[]; fallbackOrder: string[] };

function defaultConfigPath(): string {
  const envPiPath = process.env.WMB_PI_CONFIG_PATH?.trim();
  if (envPiPath) return envPiPath;
  return path.join(resolveUserDataPath(), 'pi-api-config.json');
}

function readStored(configPath: string): StoredStateV4 {
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
    const migrated = migrateV3State(source);
    writeStored(configPath, migrated);
    return migrated;
  }
  if (candidate.version === 4) {
    return validateStoredState({
      version: 4,
      activeId: source.activeId as string | null,
      profiles: source.profiles as StoredProfile[],
      modelPolicyRevision: source.modelPolicyRevision as number,
      roleModelPolicies: source.roleModelPolicies as MutableRoleModelPolicies
    });
  }
  throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'Pi 配置文件版本不受支持。');
}

function emptyStoredState(): StoredStateV4 {
  return { version: 4, activeId: null, profiles: [], modelPolicyRevision: 0, roleModelPolicies: policiesForEmptyState() };
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
    return { activeId: 'default', profiles: [{ id: 'default', name: '默认配置', baseUrl: legacy.baseUrl, model: legacy.model, api: legacy.api ?? 'openai-completions', encryptedApiKey: legacy.encryptedApiKey }], fallbackOrder: [] };
  }
  throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', '旧 Pi 配置缺少模型预设。');
}

function normalizeLegacyProfile(value: unknown, index: number): LegacyStoredProfile {
  if (!value || typeof value !== 'object') throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', `旧 Pi 配置中的模型预设 ${index + 1} 无效。`);
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' ? record.id : '', name: typeof record.name === 'string' ? record.name : '',
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '', model: typeof record.model === 'string' ? record.model : '',
    api: record.api === undefined ? 'openai-completions' : requirePiApiType(record.api), thinking: record.thinking as PiThinkingLevel | undefined,
    nativeSearch: typeof record.nativeSearch === 'boolean' ? record.nativeSearch : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    maxTokens: typeof record.maxTokens === 'number' ? record.maxTokens : undefined,
    encryptedApiKey: typeof record.encryptedApiKey === 'string' ? record.encryptedApiKey : ''
  };
}

function migrateLegacyProfile(profile: LegacyStoredProfile): StoredProfile {
  const api = requirePiApiType(profile.api ?? 'openai-completions');
  return {
    id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, api,
    authMode: defaultAuthMode(api),
    credentialSource: profile.encryptedApiKey ? { kind: 'encrypted', encryptedValue: profile.encryptedApiKey } : { kind: 'none' },
    capabilities: defaultCapabilities(api, profile.nativeSearch), health: { state: 'unknown' },
    thinking: profile.thinking, contextWindow: profile.contextWindow, maxTokens: profile.maxTokens
  };
}

function migrateV2State(source: Record<string, unknown>): StoredStateV4 {
  const legacyProfiles = Array.isArray(source.profiles) ? source.profiles.map((profile, index) => normalizeLegacyProfile(profile, index)) : [];
  const profiles = legacyProfiles.map(migrateLegacyProfile);
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const rawPolicies = source.roleModelPolicies && typeof source.roleModelPolicies === 'object' ? source.roleModelPolicies as Record<string, unknown> : {};
  const roleModelPolicies = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) {
    const rawPolicy = rawPolicies[roleId];
    const profileIds = rawPolicy && typeof rawPolicy === 'object' && Array.isArray((rawPolicy as { profileIds?: unknown }).profileIds) ? (rawPolicy as { profileIds: unknown[] }).profileIds : [];
    roleModelPolicies[roleId] = { candidates: profileIds.map((profileId) => { const id = typeof profileId === 'string' ? profileId : ''; return { profileId: id, model: byId.get(id)?.model ?? '' }; }) };
  }
  return validateStoredState({ version: 4, activeId: source.activeId as string | null, profiles, modelPolicyRevision: source.modelPolicyRevision as number, roleModelPolicies });
}

function migrateV3State(source: Record<string, unknown>): StoredStateV4 {
  const profiles = Array.isArray(source.profiles) ? source.profiles.map((profile, index) => migrateLegacyProfile(normalizeLegacyProfile(profile, index))) : [];
  return validateStoredState({ version: 4, activeId: source.activeId as string | null, profiles, modelPolicyRevision: source.modelPolicyRevision as number, roleModelPolicies: source.roleModelPolicies as MutableRoleModelPolicies });
}

function migrateLegacyState(legacy: LegacyState): StoredStateV4 {
  const profiles = legacy.profiles.map(migrateLegacyProfile);
  const known = new Set(profiles.map((profile) => profile.id));
  const activeId = legacy.activeId && known.has(legacy.activeId) ? legacy.activeId : null;
  const profileIds = sanitizeFallbackOrder([...(activeId ? [activeId] : []), ...legacy.fallbackOrder], profiles, null);
  if (profiles.length && !profileIds.length) throw roleModelError('ROLE_MODEL_POLICY_REQUIRED', '旧 Pi 配置没有可迁移的模型策略。');
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const roleModelPolicies = {} as MutableRoleModelPolicies;
  for (const roleId of ROLE_IDS) roleModelPolicies[roleId] = { candidates: profileIds.map((profileId) => ({ profileId, model: byId.get(profileId)!.model })) };
  return validateStoredState({ version: 4, activeId, profiles, modelPolicyRevision: 1, roleModelPolicies });
}

function validateStoredProfile(value: StoredProfile, index: number): StoredProfile {
  if (!value || typeof value !== 'object') throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设 ${index + 1} 无效。`);
  const profile = { ...value };
  if (typeof profile.id !== 'string' || !profile.id.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设 ${index + 1} 缺少 ID。`);
  if (typeof profile.name !== 'string' || !profile.name.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.id}」名称无效。`);
  if (typeof profile.baseUrl !== 'string' || !profile.baseUrl.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」地址无效。`);
  try { const baseUrl = new URL(profile.baseUrl); if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('protocol'); } catch { throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」地址必须使用 HTTP 或 HTTPS。`, { profileId: profile.id }); }
  if (typeof profile.model !== 'string' || !profile.model.trim()) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」模型名无效。`, { profileId: profile.id });
  const api = requirePiApiType(profile.api);
  const authMode = requireProviderAuthMode(profile.authMode ?? defaultAuthMode(api));
  const credentialSource = normalizeCredentialSource(profile.credentialSource);
  const capabilities = profile.capabilities && typeof profile.capabilities === 'object' ? freezeValue({ ...defaultCapabilities(api), ...profile.capabilities }) : defaultCapabilities(api);
  const health = profile.health && typeof profile.health === 'object' ? freezeValue({ ...profile.health }) : freezeValue({ state: 'unknown' as const });
  if (profile.thinking !== undefined && !isThinkingLevel(profile.thinking)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」思考等级无效。`, { profileId: profile.id });
  requireModelLimits({ contextWindow: profile.contextWindow, maxTokens: profile.maxTokens });
  if (authMode !== 'none' && credentialSource.kind === 'none') throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${profile.name}」尚未配置凭证来源。`, { profileId: profile.id });
  return { id: profile.id.trim(), name: profile.name.trim(), baseUrl: profile.baseUrl.replace(/\/$/, ''), model: profile.model.trim(), api, authMode, credentialSource, capabilities, health, thinking: profile.thinking, contextWindow: profile.contextWindow, maxTokens: profile.maxTokens };
}

function validateStoredState(state: StoredStateV4): StoredStateV4 {
  if (state.version !== 4 || !Number.isSafeInteger(state.modelPolicyRevision) || state.modelPolicyRevision < 0 || !Array.isArray(state.profiles)) throw new RoleModelPolicyError('ROLE_MODEL_CONFIG_INVALID', 'Pi v4 配置格式无效。');
  const profiles = state.profiles.map((profile, index) => validateStoredProfile(profile, index));
  const seenProfileIds = new Set<string>();
  for (const profile of profiles) { if (seenProfileIds.has(profile.id)) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设 ID 重复：${profile.id}。`, { profileId: profile.id }); seenProfileIds.add(profile.id); }
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const activeId = state.activeId === null ? null : (typeof state.activeId === 'string' ? state.activeId : '');
  if (activeId && !byId.has(activeId)) throw roleModelError('ROLE_MODEL_PROFILE_MISSING', `当前激活模型预设不存在：${activeId}。`, { profileId: activeId });
  const roleModelPolicies = normalizeRoleModelPolicies(state.roleModelPolicies, profiles, profiles.length === 0);
  return { version: 4, activeId: activeId || null, profiles, modelPolicyRevision: state.modelPolicyRevision, roleModelPolicies };
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
      if (!profile.capabilities?.text) throw roleModelError('ROLE_MODEL_CONFIG_INVALID', `模型预设「${profile.name}」未声明文本生成能力，不能分配给角色 ${roleId}。`, { roleId, profileId, model });
      if (!isCredentialConfigured(profile)) throw roleModelError('ROLE_MODEL_AUTH_FAILED', `模型预设「${profile.name}」的凭证不可用。`, { roleId, profileId, model });
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
  const credentialSource = profile.credentialSource ?? { kind: 'none' };
  return freezeValue({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    api: requirePiApiType(profile.api),
    authMode: profile.authMode ?? defaultAuthMode(requirePiApiType(profile.api)),
    credentialSourceKind: credentialSource.kind,
    credentialSourceLabel: credentialSourceLabel(credentialSource),
    capabilities: profile.capabilities ?? defaultCapabilities(requirePiApiType(profile.api)),
    health: profile.health ?? { state: 'unknown' },
    thinking: profile.thinking,
    ...modelLimits(profile.model, profile),
    configured: isCredentialConfigured(profile),
    active
  });
}

function snapshotFromStoredProfile(profile: StoredProfile, model = profile.model, thinking = profile.thinking): ModelPolicyProfileSnapshot {
  const api = requirePiApiType(profile.api);
  return freezeValue({
    profileId: profile.id, profileName: profile.name, baseUrl: profile.baseUrl, api,
    authMode: profile.authMode ?? defaultAuthMode(api), credentialSourceKind: profile.credentialSource?.kind ?? 'none',
    capabilities: profile.capabilities ?? defaultCapabilities(api), model, thinking,
    ...modelLimits(model, model === profile.model ? profile : {})
  });
}

function resolvedFromStoredProfile(profile: StoredProfile, model = profile.model): ResolvedPiConfig {
  const api = requirePiApiType(profile.api);
  return freezeValue({
    id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model, api,
    authMode: profile.authMode ?? defaultAuthMode(api), credentialSourceKind: profile.credentialSource?.kind ?? 'none',
    capabilities: profile.capabilities ?? defaultCapabilities(api), nativeSearch: profile.capabilities?.nativeSearch ?? false, thinking: profile.thinking,
    ...modelLimits(model, model === profile.model ? profile : {}),
    apiKey: resolveProviderCredential(profile.credentialSource ?? { kind: 'none' })
  });
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

function validateBeforeWrite(state: StoredStateV4): StoredStateV4 {
  return validateStoredState({
    version: 4,
    activeId: state.activeId,
    profiles: state.profiles.map((profile) => ({ ...profile })),
    modelPolicyRevision: state.modelPolicyRevision,
    roleModelPolicies: Object.fromEntries(ROLE_IDS.map((roleId) => [roleId, {
      candidates: state.roleModelPolicies[roleId].candidates.map((candidate) => ({ ...candidate }))
    }])) as MutableRoleModelPolicies
  });
}

function writeStored(configPath: string, state: StoredStateV4): void {
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
