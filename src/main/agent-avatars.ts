import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isRoleId, type RoleId } from '../shared/agent-capabilities.ts';
import { registerStagedAsset, stageAssetBytes, getAsset } from './assets.ts';

const META_KEY = 'agent_avatars_v1';

export type AgentAvatarMap = Partial<Record<RoleId, string>>; // roleId -> assetId

function readMap(database: DatabaseSync): AgentAvatarMap {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY) as { value: string } | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const out: AgentAvatarMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRoleId(key) && typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(database: DatabaseSync, map: AgentAvatarMap): void {
  const now = new Date().toISOString();
  const value = JSON.stringify(map);
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(META_KEY) as { revision: number } | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?').run(value, now, META_KEY);
  } else {
    database.prepare(
      'INSERT INTO app_meta(key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)'
    ).run(META_KEY, value, now, now);
  }
}

export function listAgentAvatars(database: DatabaseSync): Array<{ roleId: RoleId; assetId: string; url: string }> {
  const map = readMap(database);
  const out: Array<{ roleId: RoleId; assetId: string; url: string }> = [];
  for (const [roleId, assetId] of Object.entries(map) as Array<[RoleId, string]>) {
    const asset = getAsset(database, assetId);
    if (!asset) continue;
    out.push({ roleId, assetId, url: `wmb-asset://${assetId}` });
  }
  return out;
}

/**
 * 头像落盘规范：
 * - 二进制走现有 assets 管道：`assets/{sha256}.png`（SHA 去重）
 * - 角色映射：`app_meta.agent_avatars_v1` = { desk|reporter|...: assetId }
 * - 可选稳定别名文件：`assets/agent-avatars/{roleId}.png`（覆盖写，便于人工查看）
 */
export async function setAgentAvatar(
  database: DatabaseSync,
  dataRoot: string,
  input: { roleId: string; bytes: Buffer; mimeType?: string; width?: number; height?: number }
): Promise<{ roleId: RoleId; assetId: string; url: string; relativePath: string }> {
  if (!isRoleId(input.roleId)) throw new Error('未知角色。');
  const roleId = input.roleId;
  const mimeType = input.mimeType || 'image/png';
  if (!mimeType.startsWith('image/')) throw new Error('头像必须是图片。');
  if (input.bytes.byteLength > 5 * 1024 * 1024) throw new Error('头像不能超过 5MB。');

  const staged = await stageAssetBytes(dataRoot, {
    bytes: input.bytes,
    fileName: `${roleId}.png`,
    mimeType,
    origin: 'agent-avatar',
    width: input.width ?? 256,
    height: input.height ?? 256
  });
  const registered = registerStagedAsset(database, staged);

  // 稳定可读路径（非权威；权威仍是 assets sha + app_meta）
  const aliasRel = path.posix.join('assets', 'agent-avatars', `${roleId}.png`);
  const aliasAbs = path.join(dataRoot, ...aliasRel.split('/'));
  await mkdir(path.dirname(aliasAbs), { recursive: true });
  await writeFile(aliasAbs, input.bytes);

  const map = readMap(database);
  map[roleId] = registered.id;
  writeMap(database, map);

  return {
    roleId,
    assetId: registered.id,
    url: `wmb-asset://${registered.id}`,
    relativePath: registered.relativePath
  };
}

export function bindAgentAvatarAsset(
  database: DatabaseSync,
  input: { roleId: RoleId; staged: Parameters<typeof registerStagedAsset>[1] }
): { roleId: RoleId; assetId: string; url: string; relativePath: string; reused: boolean } {
  const registered = registerStagedAsset(database, input.staged);
  const map = readMap(database);
  map[input.roleId] = registered.id;
  writeMap(database, map);
  return {
    roleId: input.roleId,
    assetId: registered.id,
    url: `wmb-asset://${registered.id}`,
    relativePath: registered.relativePath,
    reused: Boolean(registered.reused)
  };
}

export function clearAgentAvatarMapping(database: DatabaseSync, roleId: string): void {
  if (!isRoleId(roleId)) throw new Error('未知角色。');
  const map = readMap(database);
  delete map[roleId];
  writeMap(database, map);
}

export async function clearAgentAvatar(database: DatabaseSync, roleId: string): Promise<void> {
  clearAgentAvatarMapping(database, roleId);
}
