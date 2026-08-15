import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseAssetImages } from '../../shared/media-token.ts';

// WMB-5237：结构化媒体绑定（核心/平台）+ 派生资产血缘。
// - content_media_bindings：核心图文版本绑定（方案 C：绑定为权威，正文 `wmb-asset://` 只是排版投影）。
// - platform_media_bindings：平台图文版本绑定（顺序/封面/图注覆盖/裁剪派生），随平台版本乐观锁递增；
//   `asset_ids_json` 继续作为发布管线投影（有效 derivedAssetId || assetId 按 ordinal 重建）。
// - asset_provenance：追加式血缘记录（imported / generated / derived_crop）；derived_crop 行以
//   (kind, source_asset_id, derived_asset_id) 幂等，transform_json 存 {cropRegion, width, height}。
// run hook 在迁移事务内安全回填存量数据：content_versions.body 的 wmb-asset 引用 → 核心绑定；
// platform_versions.asset_ids_json → 平台绑定（X 首图 is_cover = 1）。

export const mediaBindingMigrations = [
  {
    version: 62,
    sql: `
      CREATE TABLE content_media_bindings (
        id TEXT PRIMARY KEY,
        content_version_id TEXT NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        ordinal INTEGER NOT NULL,
        occurrence INTEGER NOT NULL DEFAULT 0,
        width_preset TEXT NOT NULL DEFAULT 'full' CHECK (width_preset IN ('small', 'medium', 'large', 'full')),
        align TEXT NOT NULL DEFAULT 'center' CHECK (align IN ('left', 'center', 'right')),
        caption TEXT,
        link_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (content_version_id, ordinal),
        UNIQUE (content_version_id, asset_id, occurrence)
      );
      CREATE INDEX content_media_bindings_version ON content_media_bindings(content_version_id);
      CREATE INDEX content_media_bindings_asset ON content_media_bindings(asset_id);

      CREATE TABLE platform_media_bindings (
        id TEXT PRIMARY KEY,
        platform_version_id TEXT NOT NULL REFERENCES platform_versions(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        ordinal INTEGER NOT NULL,
        caption TEXT,
        is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
        crop_region_json TEXT,
        derived_asset_id TEXT REFERENCES assets(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform_version_id, ordinal),
        UNIQUE (platform_version_id, asset_id)
      );
      CREATE UNIQUE INDEX platform_media_bindings_one_cover ON platform_media_bindings(platform_version_id) WHERE is_cover = 1;
      CREATE INDEX platform_media_bindings_version ON platform_media_bindings(platform_version_id);
      CREATE INDEX platform_media_bindings_asset ON platform_media_bindings(asset_id);

      CREATE TABLE asset_provenance (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        kind TEXT NOT NULL CHECK (kind IN ('imported', 'generated', 'derived_crop')),
        origin TEXT NOT NULL,
        source_asset_id TEXT REFERENCES assets(id),
        derived_asset_id TEXT REFERENCES assets(id),
        transform_json TEXT,
        source_url TEXT,
        source_revision_id TEXT,
        generator TEXT,
        generation_prompt TEXT,
        generation_model TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        CHECK (kind != 'derived_crop' OR (source_asset_id IS NOT NULL AND derived_asset_id IS NOT NULL AND transform_json IS NOT NULL)),
        UNIQUE (kind, source_asset_id, derived_asset_id)
      );
      CREATE INDEX asset_provenance_asset ON asset_provenance(asset_id);
      CREATE INDEX asset_provenance_source ON asset_provenance(source_asset_id);
      CREATE INDEX asset_provenance_derived ON asset_provenance(derived_asset_id);
    `,
    run: (database: DatabaseSync): void => {
      backfillContentMediaBindings(database);
      backfillPlatformMediaBindings(database);
    }
  }
] as const;

function backfillContentMediaBindings(database: DatabaseSync): void {
  const versions = database.prepare('SELECT id, body, created_at AS createdAt FROM content_versions').all() as Array<{
    id: string; body: string; createdAt: string;
  }>;
  if (versions.length === 0) return;
  const assetExists = database.prepare('SELECT 1 FROM assets WHERE id = ?');
  const insert = database.prepare(`INSERT INTO content_media_bindings
    (id, content_version_id, asset_id, ordinal, occurrence, width_preset, align, caption, link_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'full', 'center', ?, NULL, ?, ?)`);
  for (const version of versions) {
    const refs = parseAssetImages(version.body);
    refs.forEach((ref, ordinal) => {
      if (!assetExists.get(ref.assetId)) return;
      insert.run(
        randomUUID(),
        version.id,
        ref.assetId,
        ordinal,
        ref.occurrence,
        ref.alt || null,
        version.createdAt,
        version.createdAt
      );
    });
  }
}

function backfillPlatformMediaBindings(database: DatabaseSync): void {
  const versions = database.prepare('SELECT id, asset_ids_json AS assetIds, platform, created_at AS createdAt, updated_at AS updatedAt FROM platform_versions').all() as Array<{
    id: string; assetIds: string; platform: string; createdAt: string; updatedAt: string;
  }>;
  if (versions.length === 0) return;
  const assetExists = database.prepare('SELECT 1 FROM assets WHERE id = ?');
  const insert = database.prepare(`INSERT INTO platform_media_bindings
    (id, platform_version_id, asset_id, ordinal, caption, is_cover, crop_region_json, derived_asset_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`);
  for (const version of versions) {
    let assetIds: string[];
    try {
      const parsed = JSON.parse(version.assetIds);
      assetIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    } catch {
      assetIds = [];
    }
    const seen = new Set<string>();
    assetIds.forEach((assetId, ordinal) => {
      if (seen.has(assetId) || !assetExists.get(assetId)) return;
      seen.add(assetId);
      const isCover = version.platform === 'x' && ordinal === 0 ? 1 : 0;
      insert.run(randomUUID(), version.id, assetId, ordinal, isCover, version.createdAt, version.updatedAt);
    });
  }
}
