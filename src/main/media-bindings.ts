// WMB-5237: 结构化媒体绑定数据层（Data agent 所有）。
// 职责：核心/平台绑定读取与替换写入（调用方事务内）、核心绑定对账、平台绑定缺省重建、
// 派生裁剪 asset 物化（asset + provenance 原子）、caption 链解析。
// 共享类型与校验在 ../shared/media-bindings.ts；token 解析单一实现在 ../shared/media-token.ts。

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getAsset, registerStagedAsset, stageAssetBytes, type StagedAsset } from './assets.ts';
import {
  buildAssetIdsFromPlatformBindings,
  contentBindingKey,
  isValidCropRegion,
  type ClipRange,
  type ContentMediaBinding,
  type ContentMediaBindingDraft,
  type CropRegion,
  type PlatformMediaBinding,
  type PlatformMediaBindingDraft
} from '../shared/media-bindings.ts';
import { parseAssetImages, referencedAssetIds } from '../shared/media-token.ts';

export type StagedCrop = {
  sourceAssetId: string;
  cropRegion: CropRegion;
  staged: StagedAsset;
};

export function readContentMediaBindings(database: DatabaseSync, contentVersionId: string): ContentMediaBinding[] {
  return database.prepare(`
    SELECT id, content_version_id AS contentVersionId, asset_id AS assetId, ordinal, occurrence,
      width_preset AS widthPreset, align, caption, link_url AS linkUrl, media_kind AS mediaKind,
      created_at AS createdAt, updated_at AS updatedAt
    FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal ASC
  `).all(contentVersionId) as ContentMediaBinding[];
}

export function readProjectContentMediaBindings(database: DatabaseSync, projectId: string): Map<string, ContentMediaBinding[]> {
  const rows = database.prepare(`
    SELECT b.id, b.content_version_id AS contentVersionId, b.asset_id AS assetId, b.ordinal, b.occurrence,
      b.width_preset AS widthPreset, b.align, b.caption, b.link_url AS linkUrl, b.media_kind AS mediaKind,
      b.created_at AS createdAt, b.updated_at AS updatedAt
    FROM content_media_bindings b
    JOIN content_versions v ON v.id = b.content_version_id
    WHERE v.project_id = ? ORDER BY b.content_version_id, b.ordinal ASC
  `).all(projectId) as ContentMediaBinding[];
  const grouped = new Map<string, ContentMediaBinding[]>();
  for (const row of rows) {
    const group = grouped.get(row.contentVersionId) ?? [];
    group.push(row);
    grouped.set(row.contentVersionId, group);
  }
  return grouped;
}

export function readPlatformMediaBindings(database: DatabaseSync, platformVersionId: string): PlatformMediaBinding[] {
  const rows = database.prepare(`
    SELECT id, platform_version_id AS platformVersionId, asset_id AS assetId, ordinal, caption,
      is_cover AS isCover, crop_region_json AS cropRegionJson, derived_asset_id AS derivedAssetId,
      media_kind AS mediaKind, poster_asset_id AS posterAssetId, clip_range_json AS clipRangeJson,
      duration_ms AS durationMs, created_at AS createdAt, updated_at AS updatedAt
    FROM platform_media_bindings WHERE platform_version_id = ? ORDER BY ordinal ASC
  `).all(platformVersionId) as PlatformMediaBindingRow[];
  return rows.map(normalizePlatformMediaBindingRow);
}

type PlatformMediaBindingRow = Omit<PlatformMediaBinding, 'isCover' | 'cropRegion' | 'clipRange'> & {
  isCover: number;
  cropRegionJson: string | null;
  clipRangeJson: string | null;
};

function normalizePlatformMediaBindingRow(row: PlatformMediaBindingRow): PlatformMediaBinding {
  return {
    id: row.id,
    platformVersionId: row.platformVersionId,
    assetId: row.assetId,
    ordinal: Number(row.ordinal),
    caption: row.caption,
    isCover: Number(row.isCover) === 1,
    cropRegion: row.cropRegionJson ? JSON.parse(row.cropRegionJson) as CropRegion : null,
    derivedAssetId: row.derivedAssetId,
    mediaKind: row.mediaKind,
    posterAssetId: row.posterAssetId,
    clipRange: row.clipRangeJson ? JSON.parse(row.clipRangeJson) as ClipRange : null,
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function readProjectPlatformMediaBindings(database: DatabaseSync, projectId: string): Map<string, PlatformMediaBinding[]> {
  const rows = database.prepare(`
    SELECT b.id, b.platform_version_id AS platformVersionId, b.asset_id AS assetId, b.ordinal, b.caption,
      b.is_cover AS isCover, b.crop_region_json AS cropRegionJson, b.derived_asset_id AS derivedAssetId,
      b.media_kind AS mediaKind, b.poster_asset_id AS posterAssetId, b.clip_range_json AS clipRangeJson,
      b.duration_ms AS durationMs, b.created_at AS createdAt, b.updated_at AS updatedAt
    FROM platform_media_bindings b
    JOIN platform_versions v ON v.id = b.platform_version_id
    WHERE v.project_id = ? ORDER BY b.platform_version_id, b.ordinal ASC
  `).all(projectId) as PlatformMediaBindingRow[];
  const grouped = new Map<string, PlatformMediaBinding[]>();
  for (const raw of rows) {
    const row = normalizePlatformMediaBindingRow(raw);
    const group = grouped.get(row.platformVersionId) ?? [];
    group.push(row);
    grouped.set(row.platformVersionId, group);
  }
  return grouped;
}

/** 替换写入核心绑定（调用方事务内）：先删后插，ordinal 连续 0..n-1。 */
export function replaceContentMediaBindings(
  database: DatabaseSync,
  contentVersionId: string,
  drafts: ContentMediaBindingDraft[],
  now = new Date().toISOString()
): void {
  database.prepare('DELETE FROM content_media_bindings WHERE content_version_id = ?').run(contentVersionId);
  if (drafts.length === 0) return;
  const assetExists = database.prepare('SELECT 1 FROM assets WHERE id = ?');
  const insert = database.prepare(`INSERT INTO content_media_bindings
    (id, content_version_id, asset_id, ordinal, occurrence, width_preset, align, caption, link_url, media_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  drafts.forEach((draft, ordinal) => {
    if (!assetExists.get(draft.assetId)) throw new Error(`素材不存在: ${draft.assetId}。`);
    insert.run(
      randomUUID(), contentVersionId, draft.assetId, ordinal, draft.occurrence,
      draft.widthPreset, draft.align, draft.caption ?? null, draft.linkUrl ?? null, draft.mediaKind ?? 'image', now, now
    );
  });
}

/** 替换写入平台绑定（调用方事务内）：先删后插；cropRegion 必须伴随已物化 derivedAssetId。 */
export function replacePlatformMediaBindings(
  database: DatabaseSync,
  platformVersionId: string,
  drafts: PlatformMediaBindingDraft[],
  now = new Date().toISOString()
): void {
  database.prepare('DELETE FROM platform_media_bindings WHERE platform_version_id = ?').run(platformVersionId);
  if (drafts.length === 0) return;
  const assetExists = database.prepare('SELECT 1 FROM assets WHERE id = ?');
  const insert = database.prepare(`INSERT INTO platform_media_bindings
    (id, platform_version_id, asset_id, ordinal, caption, is_cover, crop_region_json, derived_asset_id,
     media_kind, poster_asset_id, clip_range_json, duration_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  drafts.forEach((draft) => {
    if (!assetExists.get(draft.assetId)) throw new Error(`素材不存在: ${draft.assetId}。`);
    const derivedAssetId = draft.derivedAssetId ?? null;
    if (derivedAssetId && !assetExists.get(derivedAssetId)) throw new Error(`派生素材不存在: ${derivedAssetId}。`);
    if (draft.cropRegion && !derivedAssetId) throw new Error('cropRegion 必须伴随已物化的 derivedAssetId（请先经 studio:derive-asset 或本保存的裁切载荷物化）。');
    const mediaKind = draft.mediaKind ?? 'image';
    const posterAssetId = draft.posterAssetId ?? null;
    if (posterAssetId && !assetExists.get(posterAssetId)) throw new Error(`视频封面素材不存在: ${posterAssetId}。`);
    if (draft.clipRange && mediaKind !== 'video') throw new Error('clipRange 只能用于 video 媒体绑定。');
    insert.run(
      randomUUID(), platformVersionId, draft.assetId, draft.ordinal, draft.caption ?? null,
      draft.isCover ? 1 : 0,
      draft.cropRegion ? JSON.stringify(draft.cropRegion) : null,
      derivedAssetId,
      mediaKind,
      posterAssetId,
      draft.clipRange ? JSON.stringify(draft.clipRange) : null,
      draft.durationMs ?? null,
      now, now
    );
  });
}

/**
 * 核心绑定对账（方案 C）：正文 `wmb-asset://` 引用是排版投影，绑定为权威。
 * - 正文有引用而 draft 缺 → 追加到绑定末尾（默认布局 full/center，caption 取 alt）；
 * - draft 有而正文无引用 → 保留（图集语义）；
 * - 引用顺序即 ordinal；布局字段只来自 draft，绝不写回正文 token。
 */
export function reconcileCoreBindingDrafts(
  body: string,
  drafts: ContentMediaBindingDraft[] | null | undefined
): ContentMediaBindingDraft[] {
  const refs = parseAssetImages(body);
  const draftByKey = new Map((drafts ?? []).map((draft) => [contentBindingKey(draft.assetId, draft.occurrence), draft]));
  const result: ContentMediaBindingDraft[] = [];
  const usedKeys = new Set<string>();
  for (const ref of refs) {
    const draft = draftByKey.get(contentBindingKey(ref.assetId, ref.occurrence));
    result.push({
      assetId: ref.assetId,
      occurrence: ref.occurrence,
      widthPreset: draft?.widthPreset ?? 'full',
      align: draft?.align ?? 'center',
      caption: draft?.caption ?? (ref.alt || null),
      linkUrl: draft?.linkUrl ?? null,
      mediaKind: draft?.mediaKind ?? 'image'
    });
    usedKeys.add(contentBindingKey(ref.assetId, ref.occurrence));
  }
  for (const draft of drafts ?? []) {
    const key = contentBindingKey(draft.assetId, draft.occurrence);
    if (!usedKeys.has(key)) result.push({ ...draft });
  }
  return result;
}

/** 裁剪区域幂等键（同一 source + 同一 region 映射同一派生 asset）。 */
export const cropRegionKey = (assetId: string, region: CropRegion): string =>
  `${assetId}|${region.x},${region.y},${region.width},${region.height}`;

/**
 * 平台绑定缺省重建（mediaBindings 未提供时）：绝不静默清空已有绑定。
 * 顺序优先级：显式 assetIds（即使为空也尊重）> 现有绑定顺序（derived||source）> 正文引用（create 兜底）；
 * 同 assetId 的现有 cover/crop/derivedAssetId/caption 原样保留。
 */
export function reconcilePlatformBindingDrafts(
  database: DatabaseSync,
  input: {
    platformVersionId: string | null;
    platform: 'x' | 'xiaohongshu' | 'wechat' | 'zhihu';
    assetIds?: string[] | null;
    body?: string | null;
  }
): PlatformMediaBindingDraft[] {
  const existing = input.platformVersionId ? readPlatformMediaBindings(database, input.platformVersionId) : [];
  const existingByAsset = new Map(existing.map((binding) => [binding.assetId, binding]));
  let order: string[] = [];
  if (input.assetIds !== undefined && input.assetIds !== null) {
    order = [...new Set(input.assetIds)];
  } else if (existing.length > 0) {
    order = buildAssetIdsFromPlatformBindings(existing);
  } else if (input.body) {
    order = referencedAssetIds(input.body);
  }
  const result: PlatformMediaBindingDraft[] = order.map((assetId, ordinal) => {
    const current = existingByAsset.get(assetId);
    return current
      ? {
          assetId,
          ordinal,
          caption: current.caption,
          isCover: current.isCover,
          cropRegion: current.cropRegion,
          derivedAssetId: current.derivedAssetId,
          mediaKind: current.mediaKind,
          posterAssetId: current.posterAssetId,
          clipRange: current.clipRange,
          durationMs: current.durationMs
        }
      : { assetId, ordinal, caption: null, isCover: false, cropRegion: null, derivedAssetId: null };
  });
  // X 平台单图发布边界：封面即首图（ordinal 0）；缺省重建保证首图是封面。
  if (input.platform === 'x' && result.length > 0) {
    result.forEach((draft, ordinal) => { draft.isCover = ordinal === 0; });
  }
  return result;
}

/** 由绑定重建 asset_ids_json 投影（有效 derivedAssetId || assetId，按 ordinal）。 */
export function rebuildAssetIds(database: DatabaseSync, platformVersionId: string): string[] {
  return buildAssetIdsFromPlatformBindings(readPlatformMediaBindings(database, platformVersionId));
}

/** 从 PNG 字节解析像素尺寸（IHDR：偏移 16/20 各 4 字节大端）；非 PNG 返回 null。纯字节解析，不依赖 sharp。 */
import { pngDimensionsFromBytes } from './png-dimensions.ts';
export { pngDimensionsFromBytes } from './png-dimensions.ts';

/**
 * 派生裁剪 asset 物化（standalone：derive IPC 路径）。
 * 文件字节经 stageAssetBytes（sha256 命名、幂等 EEXIST）；asset + provenance 在同一事务原子写入。
 * 重复裁剪（同 source + 同派生字节）幂等：复用既有 asset，provenance 行不重复。
 */
export async function materializeCropAsset(
  database: DatabaseSync,
  dataRoot: string,
  input: {
    sourceAssetId: string;
    cropRegion: CropRegion;
    bytes: Buffer;
    origin: string;
    requestId?: string | null;
    width?: number | null;
    height?: number | null;
  },
  transaction = true
): Promise<{ assetId: string; reused: boolean; sha256: string; width: number | null; height: number | null }> {
  const source = getAsset(database, input.sourceAssetId);
  if (!source) throw new Error(`源素材不存在: ${input.sourceAssetId}。`);
  if (!isValidCropRegion(input.cropRegion)) {
    throw new Error('cropRegion 无效（须 0..1 且 x+width<=1、y+height<=1、width/height>0）。');
  }
  const pngDimensions = pngDimensionsFromBytes(input.bytes);
  const staged = await stageAssetBytes(dataRoot, {
    bytes: input.bytes,
    fileName: 'crop.png',
    mimeType: 'image/png',
    origin: input.origin,
    width: input.width ?? pngDimensions?.width ?? null,
    height: input.height ?? pngDimensions?.height ?? null
  });
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const registered = registerStagedAsset(database, staged);
    insertDerivedCropProvenance(database, {
      sourceAssetId: input.sourceAssetId,
      derivedAssetId: registered.id,
      cropRegion: input.cropRegion,
      width: staged.width,
      height: staged.height,
      origin: input.origin,
      requestId: input.requestId ?? null
    });
    if (transaction) database.exec('COMMIT');
    return { assetId: registered.id, reused: registered.reused, sha256: staged.sha256, width: staged.width, height: staged.height };
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

/** 幂等写入 derived_crop provenance 行（同 source+derived 已存在则跳过）。 */
export function insertDerivedCropProvenance(
  database: DatabaseSync,
  input: {
    sourceAssetId: string;
    derivedAssetId: string;
    cropRegion: CropRegion;
    width: number | null;
    height: number | null;
    origin: string;
    requestId?: string | null;
  }
): void {
  const existing = database.prepare(`SELECT id FROM asset_provenance
    WHERE kind = 'derived_crop' AND source_asset_id = ? AND derived_asset_id = ?`)
    .get(input.sourceAssetId, input.derivedAssetId);
  if (existing) return;
  database.prepare(`INSERT INTO asset_provenance
    (id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json, request_id, created_at)
    VALUES (?, ?, 'derived_crop', ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      input.derivedAssetId,
      input.origin,
      input.sourceAssetId,
      input.derivedAssetId,
      JSON.stringify({ cropRegion: input.cropRegion, width: input.width, height: input.height }),
      input.requestId ?? null,
      new Date().toISOString()
    );
}

/** caption 链：平台图注覆盖 ?? 核心图注 ?? 正文 alt 兜底。 */
export function resolveMediaCaption(
  database: DatabaseSync,
  input: { platformVersionId?: string | null; contentVersionId?: string | null; assetId: string; fallbackAlt?: string | null }
): string | null {
  if (input.platformVersionId) {
    const platformBinding = readPlatformMediaBindings(database, input.platformVersionId)
      .find((binding) => binding.assetId === input.assetId);
    if (platformBinding?.caption) return platformBinding.caption;
  }
  if (input.contentVersionId) {
    const coreBinding = readContentMediaBindings(database, input.contentVersionId)
      .find((binding) => binding.assetId === input.assetId);
    if (coreBinding?.caption) return coreBinding.caption;
  }
  return input.fallbackAlt ?? null;
}
