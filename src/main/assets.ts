import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AssetRecord = {
  id: string; relativePath: string; mimeType: string; byteCount: number; sha256: string; origin: string;
  width: number | null; height: number | null; durationMs: number | null; createdAt: string;
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

export function listAssets(database: DatabaseSync): AssetRecord[] {
  return database.prepare(`SELECT id, relative_path AS relativePath, mime_type AS mimeType, byte_count AS byteCount,
    sha256, origin, width, height, duration_ms AS durationMs, created_at AS createdAt
    FROM assets ORDER BY created_at DESC`).all() as AssetRecord[];
}

export function listProjectAssets(database: DatabaseSync, projectId: string): AssetRecord[] {
  return database.prepare(`SELECT a.id, a.relative_path AS relativePath, a.mime_type AS mimeType, a.byte_count AS byteCount,
    a.sha256, a.origin, a.width, a.height, a.duration_ms AS durationMs, a.created_at AS createdAt
    FROM content_project_assets cpa
    JOIN assets a ON a.id = cpa.asset_id
    WHERE cpa.project_id = ?
    ORDER BY cpa.created_at DESC`).all(projectId) as AssetRecord[];
}

export function getAsset(database: DatabaseSync, assetId: string): AssetRecord | null {
  return database.prepare(`SELECT id, relative_path AS relativePath, mime_type AS mimeType, byte_count AS byteCount,
    sha256, origin, width, height, duration_ms AS durationMs, created_at AS createdAt
    FROM assets WHERE id = ?`).get(assetId) as AssetRecord | null;
}

export function guessImageMime(filePath: string, fallback = 'application/octet-stream'): string {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? fallback;
}

async function persistAssetBytes(
  database: DatabaseSync,
  dataRoot: string,
  input: {
    bytes: Buffer;
    extension: string;
    mimeType: string;
    origin: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
  }
): Promise<{ id: string; relativePath: string; reused: boolean; mimeType: string; sha256: string }> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const existing = database.prepare('SELECT id, relative_path AS relativePath, mime_type AS mimeType FROM assets WHERE sha256 = ?')
    .get(sha256) as { id: string; relativePath: string; mimeType: string } | undefined;
  if (existing) return { ...existing, reused: true, sha256 };

  const extension = (input.extension.startsWith('.') ? input.extension : `.${input.extension || 'bin'}`).toLowerCase();
  const relativePath = path.posix.join('assets', `${sha256}${extension}`);
  const destination = path.join(dataRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, input.bytes);
  try {
    await rename(temporary, destination);
    const id = randomUUID();
    const now = new Date().toISOString();
    const byteCount = (await stat(destination)).size;
    database.prepare(`INSERT INTO assets (
      id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(
        id,
        relativePath,
        input.mimeType,
        byteCount,
        sha256,
        input.origin,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        now,
        now
      );
    return { id, relativePath, reused: false, mimeType: input.mimeType, sha256 };
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(destination, { force: true });
    throw error;
  }
}

export async function importAsset(
  database: DatabaseSync,
  dataRoot: string,
  input: { sourcePath: string; mimeType: string; origin: string; width?: number; height?: number; durationMs?: number }
): Promise<{ id: string; relativePath: string; reused: boolean; mimeType: string; sha256: string }> {
  const bytes = await readFile(input.sourcePath);
  return persistAssetBytes(database, dataRoot, {
    bytes,
    extension: path.extname(input.sourcePath).toLowerCase() || '.bin',
    mimeType: input.mimeType || guessImageMime(input.sourcePath),
    origin: input.origin,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  });
}

export async function importAssetBytes(
  database: DatabaseSync,
  dataRoot: string,
  input: {
    bytes: Buffer;
    fileName?: string;
    mimeType?: string;
    origin: string;
    width?: number | null;
    height?: number | null;
  }
): Promise<{ id: string; relativePath: string; reused: boolean; mimeType: string; sha256: string }> {
  const extension = path.extname(input.fileName || '').toLowerCase()
    || (input.mimeType === 'image/png' ? '.png'
      : input.mimeType === 'image/jpeg' ? '.jpg'
        : input.mimeType === 'image/webp' ? '.webp'
          : input.mimeType === 'image/gif' ? '.gif'
            : '.bin');
  const mimeType = input.mimeType || guessImageMime(extension, 'application/octet-stream');
  return persistAssetBytes(database, dataRoot, {
    bytes: input.bytes,
    extension,
    mimeType,
    origin: input.origin,
    width: input.width,
    height: input.height
  });
}

export function linkProjectAsset(database: DatabaseSync, projectId: string, assetId: string): void {
  database.prepare(`INSERT OR IGNORE INTO content_project_assets (project_id, asset_id, created_at)
    VALUES (?, ?, ?)`).run(projectId, assetId, new Date().toISOString());
}

export function markdownImageForAsset(asset: { id: string; relativePath: string }, alt = '图片'): string {
  const safeAlt = (alt || '图片').replace(/[[\]]/g, '');
  return `![${safeAlt}](wmb-asset://${asset.id})`;
}
