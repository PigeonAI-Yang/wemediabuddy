import { safeStorage } from 'electron';
import { DatabaseSync } from 'node:sqlite';

const configKey = 'pi-api-config';
type StoredPiConfig = { baseUrl: string; model: string; encryptedApiKey: string };
export type PiConfig = { baseUrl: string; model: string; configured: boolean };

export function readPiConfig(database: DatabaseSync): PiConfig {
  const stored = readStored(database);
  return { baseUrl: stored?.baseUrl ?? '', model: stored?.model ?? '', configured: Boolean(stored?.encryptedApiKey) };
}

export function savePiConfig(database: DatabaseSync, input: { baseUrl: string; model: string; apiKey?: string }): PiConfig {
  const baseUrl = new URL(input.baseUrl.trim());
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Pi API 地址必须使用 HTTP 或 HTTPS。');
  const model = input.model.trim();
  if (!model) throw new Error('请填写 Pi 使用的模型名称。');
  const current = readStored(database);
  const encryptedApiKey = input.apiKey?.trim() ? safeStorage.encryptString(input.apiKey.trim()).toString('base64') : current?.encryptedApiKey;
  if (!encryptedApiKey) throw new Error('请填写 Pi API Key。');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, revision=app_meta.revision + 1`)
    .run(configKey, JSON.stringify({ baseUrl: baseUrl.toString().replace(/\/$/, ''), model, encryptedApiKey }), now, now);
  return readPiConfig(database);
}

export function resolvePiConfig(database: DatabaseSync): { baseUrl: string; model: string; apiKey: string } {
  const stored = readStored(database);
  if (!stored) throw new Error('请先在设置中配置 Pi API。');
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey: safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')) };
}

function readStored(database: DatabaseSync): StoredPiConfig | null {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(configKey) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as StoredPiConfig : null;
}
