import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pngDimensionsFromBytes } from './png-dimensions.ts';

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

export type StagedAsset = {
  id: string; relativePath: string; mimeType: string; byteCount: number; sha256: string; origin: string;
  width: number | null; height: number | null; durationMs: number | null;
};

export async function stageAssetBytes(dataRoot: string, input: {
  bytes: Buffer; fileName?: string; mimeType?: string; origin: string;
  width?: number | null; height?: number | null; durationMs?: number | null;
}): Promise<StagedAsset> {
  const extension = path.extname(input.fileName || '').toLowerCase()
    || (input.mimeType === 'image/png' ? '.png' : input.mimeType === 'image/jpeg' ? '.jpg'
      : input.mimeType === 'image/webp' ? '.webp' : input.mimeType === 'image/gif' ? '.gif' : '.bin');
  const mimeType = input.mimeType || guessImageMime(extension, 'application/octet-stream');
  // WMB-5237：PNG 字节可直接解析像素尺寸（不依赖 sharp）；未显式传宽高时自动补全。
  let width = input.width ?? null;
  let height = input.height ?? null;
  if (width == null && height == null && mimeType === 'image/png') {
    const dimensions = pngDimensionsFromBytes(input.bytes);
    width = dimensions?.width ?? null;
    height = dimensions?.height ?? null;
  }
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const relativePath = path.posix.join('assets', `${sha256}${extension}`);
  const destination = path.join(dataRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, input.bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { id: randomUUID(), relativePath, mimeType, byteCount: input.bytes.byteLength, sha256, origin: input.origin,
    width, height, durationMs: input.durationMs ?? null };
}

export function registerStagedAsset(database: DatabaseSync, staged: StagedAsset) {
  const existing = database.prepare('SELECT id, relative_path AS relativePath, mime_type AS mimeType FROM assets WHERE sha256 = ?')
    .get(staged.sha256) as { id: string; relativePath: string; mimeType: string } | undefined;
  if (existing) return { ...existing, reused: true, sha256: staged.sha256 };
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(staged.id, staged.relativePath, staged.mimeType, staged.byteCount,
    staged.sha256, staged.origin, staged.width, staged.height, staged.durationMs, now, now);
  database.prepare(`INSERT INTO asset_provenance (id, asset_id, kind, origin, created_at) VALUES (?, ?, 'imported', ?, ?)`)
    .run(randomUUID(), staged.id, staged.origin, now);
  return { id: staged.id, relativePath: staged.relativePath, reused: false, mimeType: staged.mimeType, sha256: staged.sha256 };
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
    // WMB-5237 血缘：新素材注册时同事务写入 imported provenance（追加式血缘；reused 路径已早退，不重复）。
    // SAVEPOINT 保证 assets + asset_provenance 原子（可嵌套在调用方事务内，不与 BEGIN 冲突）。
    database.exec('SAVEPOINT wmb_asset_import');
    try {
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
      database.prepare(`INSERT INTO asset_provenance (id, asset_id, kind, origin, created_at) VALUES (?, ?, 'imported', ?, ?)`)
        .run(randomUUID(), id, input.origin, now);
      database.exec('RELEASE wmb_asset_import');
    } catch (error) {
      try {
        database.exec('ROLLBACK TO wmb_asset_import');
        database.exec('RELEASE wmb_asset_import');
      } catch {
        // 回滚窗口已失效（外层事务已终止）→ 保留原始错误继续抛出
      }
      throw error;
    }
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

// ============================================================
// WMB-5237：非破坏裁切派生 —— 输入边界（纯常量/校验，无新依赖）。
// PNG 解析（magic + IHDR 尺寸）的单一实现是 src/main/png-dimensions.ts；
// 这里只保留裁切载荷的大小边界，解析一律走共享实现，禁止第二套 parser。
// ============================================================

/** 裁切派生 PNG 大小上限（50MB；renderer canvas 导出远小于此，防异常/滥用）。 */
export const MAX_DERIVED_IMAGE_BYTES = 50 * 1024 * 1024;
