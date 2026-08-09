import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelLimits, modelOption, requireModelLimits, type PiModelOption } from './pi-model.ts';

const configKey = 'pi-api-config';
const { app, safeStorage } = electron;

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
type StoredState = { activeId: string | null; profiles: StoredProfile[]; fallbackOrder: string[] };
type LegacyConfig = { baseUrl: string; model: string; encryptedApiKey: string };
type StoredEnvelope = { version: 1; state: StoredState };

export type PiConfigProfile = {
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
};
export type PiApiType = 'openai-responses' | 'openai-completions';
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PiConfig = {
  activeId: string | null;
  profiles: PiConfigProfile[];
  fallbackOrder: string[];
  baseUrl: string;
  model: string;
  configured: boolean;
};
export type ResolvedPiConfig = {
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
};

export function requirePiApiType(value: unknown): PiApiType {
  if (value === 'openai-responses' || value === 'openai-completions') return value;
  throw new Error(`Pi 接口类型不受支持：${String(value)}。仅支持 OpenAI Responses 或 OpenAI Chat Completions。`);
}

export function readPiConfig(configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  const active = state.profiles.find((profile) => profile.id === state.activeId) ?? null;
  return {
    activeId: active?.id ?? null,
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      api: requirePiApiType(profile.api),
      thinking: profile.thinking,
      nativeSearch: profile.nativeSearch,
      ...modelLimits(profile.model, profile),
      configured: Boolean(profile.encryptedApiKey),
      active: profile.id === active?.id
    })),
    fallbackOrder: sanitizeFallbackOrder(state.fallbackOrder, state.profiles, state.activeId),
    baseUrl: active?.baseUrl ?? '',
    model: active?.model ?? '',
    configured: Boolean(active?.encryptedApiKey)
  };
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
    thinking: input.thinking,
    nativeSearch: input.nativeSearch ?? current?.nativeSearch,
    ...limits,
    encryptedApiKey
  };
  const profiles = [profile, ...state.profiles.filter((item) => item.id !== id)];
  writeStored(configPath, {
    activeId: id,
    profiles,
    fallbackOrder: sanitizeFallbackOrder(state.fallbackOrder, profiles, id)
  });
  return readPiConfig(configPath);
}

export function activatePiConfig(id: string, configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  if (!state.profiles.some((profile) => profile.id === id)) throw new Error('API 配置不存在。');
  writeStored(configPath, {
    ...state,
    activeId: id,
    fallbackOrder: sanitizeFallbackOrder(state.fallbackOrder, state.profiles, id)
  });
  return readPiConfig(configPath);
}

export function deletePiConfig(id: string, configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  const profiles = state.profiles.filter((profile) => profile.id !== id);
  if (profiles.length === state.profiles.length) throw new Error('API 配置不存在。');
  const activeId = state.activeId === id ? (profiles[0]?.id ?? null) : state.activeId;
  writeStored(configPath, {
    activeId,
    profiles,
    fallbackOrder: sanitizeFallbackOrder(state.fallbackOrder.filter((item) => item !== id), profiles, activeId)
  });
  return readPiConfig(configPath);
}

export function setPiFallbackOrder(ids: string[], configPath = defaultConfigPath()): PiConfig {
  const state = readStored(configPath);
  writeStored(configPath, {
    ...state,
    fallbackOrder: sanitizeFallbackOrder(ids, state.profiles, state.activeId)
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
  const apiKey = input.apiKey?.trim()
    || (stored ? safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')) : '');
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
  const chain = resolvePiConfigChain(configPath);
  const active = chain[0];
  if (!active) throw new Error('请先在设置中配置 Pi API。');
  return active;
}

export function resolvePiConfigChain(configPath = defaultConfigPath(), options: { skipProfileIds?: Iterable<string> } = {}): ResolvedPiConfig[] {
  const state = readStored(configPath);
  if (!state.profiles.length) throw new Error('请先在设置中配置 Pi API。');
  const skip = new Set(options.skipProfileIds ?? []);
  const byId = new Map(state.profiles.map((profile) => [profile.id, profile] as const));
  const orderedIds = [
    ...(state.activeId ? [state.activeId] : []),
    ...sanitizeFallbackOrder(state.fallbackOrder, state.profiles, state.activeId)
  ].filter((id, index, all) => Boolean(id) && byId.has(id) && all.indexOf(id) === index && !skip.has(id));
  if (!orderedIds.length) throw new Error('请先在设置中配置 Pi API。');
  return orderedIds.map((id) => {
    const profile = byId.get(id)!;
    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      api: requirePiApiType(profile.api),
      thinking: profile.thinking,
      nativeSearch: profile.nativeSearch,
      ...modelLimits(profile.model, profile),
      apiKey: safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, 'base64'))
    };
  });
}

export function migratePiConfigToInstallation(configPath: string, rootPaths: string[]): { migratedFrom: string | null; profileCount: number } {
  if (existsSync(configPath)) return { migratedFrom: null, profileCount: readStored(configPath).profiles.length };
  const candidates: Array<{ rootPath: string; state: StoredState }> = [];
  for (const rootPath of rootPaths) {
    const databasePath = path.join(rootPath, 'wmb.db');
    if (!existsSync(databasePath)) continue;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const profile = database.prepare("SELECT official_template_id AS templateId FROM workspace_profiles WHERE id='effective'").get() as { templateId?: string } | undefined;
      if (profile?.templateId !== 'official.ai') continue;
      const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(configKey) as { value: string } | undefined;
      if (row) candidates.push({ rootPath, state: normalizeStored(JSON.parse(row.value) as StoredState | LegacyConfig) });
    } finally { database.close(); }
  }
  if (candidates.length > 1 && candidates.some((candidate) => JSON.stringify(candidate.state) !== JSON.stringify(candidates[0].state))) {
    throw new Error('检测到多个不同的 AI 模型预设来源，无法自动迁移。');
  }
  const selected = candidates[0] ?? null;
  writeStored(configPath, selected?.state ?? { activeId: null, profiles: [], fallbackOrder: [] });
  return { migratedFrom: selected?.rootPath ?? null, profileCount: selected?.state.profiles.length ?? 0 };
}

function defaultConfigPath(): string {
  return path.join(app.getPath('userData'), 'pi-api-config.json');
}

function readStored(configPath: string): StoredState {
  if (!existsSync(configPath)) return { activeId: null, profiles: [], fallbackOrder: [] };
  const envelope = JSON.parse(readFileSync(configPath, 'utf8')) as StoredEnvelope;
  if (envelope.version !== 1) throw new Error('Pi 配置文件版本不受支持。');
  return normalizeStored(envelope.state);
}

function normalizeStored(value: StoredState | LegacyConfig | (Omit<StoredState, 'fallbackOrder'> & { fallbackOrder?: string[] })): StoredState {
  if ('profiles' in value) {
    const activeId = value.activeId ?? null;
    const profiles = value.profiles ?? [];
    return {
      activeId,
      profiles,
      fallbackOrder: sanitizeFallbackOrder(value.fallbackOrder ?? [], profiles, activeId)
    };
  }
  const id = 'default';
  return {
    activeId: id,
    profiles: [{ id, name: '默认配置', ...value }],
    fallbackOrder: []
  };
}

function sanitizeFallbackOrder(ids: unknown, profiles: StoredProfile[], activeId: string | null): string[] {
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

function writeStored(configPath: string, state: StoredState): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, state } satisfies StoredEnvelope, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, configPath);
}
