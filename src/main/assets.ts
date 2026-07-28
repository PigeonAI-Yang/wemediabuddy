import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AssetRecord = {
  id: string; relativePath: string; mimeType: string; byteCount: number; sha256: string; origin: string;
  width: number | null; height: number | null; durationMs: number | null; createdAt: string;
};

export function listAssets(database: DatabaseSync): AssetRecord[] {
  return database.prepare(`SELECT id, relative_path AS relativePath, mime_type AS mimeType, byte_count AS byteCount,
    sha256, origin, width, height, duration_ms AS durationMs, created_at AS createdAt
    FROM assets ORDER BY created_at DESC`).all() as AssetRecord[];
}

export async function importAsset(database: DatabaseSync, dataRoot: string, input: { sourcePath: string; mimeType: string; origin: string; width?: number; height?: number; durationMs?: number }): Promise<{ id: string; relativePath: string; reused: boolean }> {
  const bytes = await readFile(input.sourcePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = database.prepare('SELECT id, relative_path AS relativePath FROM assets WHERE sha256 = ?').get(sha256) as { id: string; relativePath: string } | undefined;
  if (existing) return { ...existing, reused: true };
  const extension = path.extname(input.sourcePath).toLowerCase() || '.bin';
  const relativePath = path.posix.join('assets', `${sha256}${extension}`);
  const destination = path.join(dataRoot, ...relativePath.split('/'));
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await copyFile(input.sourcePath, temporary);
  try {
    await rename(temporary, destination);
    const id = randomUUID(); const now = new Date().toISOString(); const byteCount = (await stat(destination)).size;
    database.prepare('INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, relativePath, input.mimeType, byteCount, sha256, input.origin, input.width ?? null, input.height ?? null, input.durationMs ?? null, now, now);
    return { id, relativePath, reused: false };
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(destination, { force: true });
    throw error;
  }
}
