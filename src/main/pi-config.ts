import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const configKey = 'pi-api-config';
const { safeStorage } = electron;

type StoredProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api?: PiApiType;
  encryptedApiKey: string;
};
type StoredState = { activeId: string | null; profiles: StoredProfile[] };
type LegacyConfig = { baseUrl: string; model: string; encryptedApiKey: string };

export type PiConfigProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  configured: boolean;
  active: boolean;
};
export type PiApiType = 'openai-responses' | 'openai-completions' | 'anthropic-messages';
export type PiConfig = {
  activeId: string | null;
  profiles: PiConfigProfile[];
  baseUrl: string;
  model: string;
  configured: boolean;
};

export function readPiConfig(database: DatabaseSync): PiConfig {
  const state = readStored(database);
  const active = state.profiles.find((profile) => profile.id === state.activeId) ?? null;
  return {
    activeId: active?.id ?? null,
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      api: profile.api ?? inferApi(profile.baseUrl),
      configured: Boolean(profile.encryptedApiKey),
      active: profile.id === active?.id
    })),
    baseUrl: active?.baseUrl ?? '',
    model: active?.model ?? '',
    configured: Boolean(active?.encryptedApiKey)
  };
}

export function savePiConfig(database: DatabaseSync, input: {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  api: PiApiType;
  apiKey?: string;
}): PiConfig {
  const baseUrl = new URL(input.baseUrl.trim());
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Pi API 地址必须使用 HTTP 或 HTTPS。');
  const name = input.name.trim();
  if (!name) throw new Error('请填写配置名称。');
  const model = input.model.trim();
  if (!model) throw new Error('请填写 Pi 使用的模型名称。');

  const state = readStored(database);
  const id = input.id ?? randomUUID();
  const current = state.profiles.find((profile) => profile.id === id);
  const encryptedApiKey = input.apiKey?.trim()
    ? safeStorage.encryptString(input.apiKey.trim()).toString('base64')
    : current?.encryptedApiKey;
  if (!encryptedApiKey) throw new Error('请填写 Pi API Key。');

  const profile: StoredProfile = {
    id,
    name,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    model,
    api: input.api,
    encryptedApiKey
  };
  writeStored(database, {
    activeId: id,
    profiles: [profile, ...state.profiles.filter((item) => item.id !== id)]
  });
  return readPiConfig(database);
}

export function activatePiConfig(database: DatabaseSync, id: string): PiConfig {
  const state = readStored(database);
  if (!state.profiles.some((profile) => profile.id === id)) throw new Error('API 配置不存在。');
  writeStored(database, { ...state, activeId: id });
  return readPiConfig(database);
}

export function deletePiConfig(database: DatabaseSync, id: string): PiConfig {
  const state = readStored(database);
  const profiles = state.profiles.filter((profile) => profile.id !== id);
  if (profiles.length === state.profiles.length) throw new Error('API 配置不存在。');
  writeStored(database, {
    activeId: state.activeId === id ? (profiles[0]?.id ?? null) : state.activeId,
    profiles
  });
  return readPiConfig(database);
}

export async function listPiModels(database: DatabaseSync, input: {
  id?: string;
  baseUrl: string;
  api: PiApiType;
  apiKey?: string;
}): Promise<string[]> {
  const baseUrl = new URL(input.baseUrl.trim());
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Pi API 地址必须使用 HTTP 或 HTTPS。');
  const stored = input.id ? readStored(database).profiles.find((profile) => profile.id === input.id) : null;
  const apiKey = input.apiKey?.trim()
    || (stored ? safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')) : '');
  if (!apiKey) throw new Error('请先填写 API Key。');

  const response = await fetch(`${baseUrl.toString().replace(/\/$/, '')}/models`, {
    headers: input.api === 'anthropic-messages'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）。`);
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  const models = [...new Set((body.data ?? [])
    .map((item) => typeof item.id === 'string' ? item.id.trim() : '')
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) throw new Error('接口没有返回可用模型。');
  return models;
}

export function resolvePiConfig(database: DatabaseSync): { baseUrl: string; model: string; api: PiApiType; apiKey: string } {
  const state = readStored(database);
  const active = state.profiles.find((profile) => profile.id === state.activeId);
  if (!active) throw new Error('请先在设置中配置 Pi API。');
  return {
    baseUrl: active.baseUrl,
    model: active.model,
    api: active.api ?? inferApi(active.baseUrl),
    apiKey: safeStorage.decryptString(Buffer.from(active.encryptedApiKey, 'base64'))
  };
}

function readStored(database: DatabaseSync): StoredState {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(configKey) as { value: string } | undefined;
  if (!row) return { activeId: null, profiles: [] };
  const value = JSON.parse(row.value) as StoredState | LegacyConfig;
  if ('profiles' in value) return value;
  const id = 'default';
  return {
    activeId: id,
    profiles: [{ id, name: '默认配置', ...value }]
  };
}

function inferApi(baseUrl: string): PiApiType {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'opencode.ai' && url.pathname.startsWith('/zen/go/')) return 'openai-completions';
    return url.hostname.endsWith('anthropic.com') ? 'anthropic-messages' : 'openai-responses';
  } catch {
    return 'openai-responses';
  }
}

function writeStored(database: DatabaseSync, state: StoredState): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, revision=app_meta.revision + 1`)
    .run(configKey, JSON.stringify(state), now, now);
}
