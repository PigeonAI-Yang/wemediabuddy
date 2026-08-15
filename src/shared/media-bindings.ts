// WMB-5237: 图片调整全链路共享契约（Data agent 所有）。
// 纯类型 + 纯函数校验，无 Node 依赖；main / preload / renderer 均可直接导入。
// 数据模型与字段名以本文件为唯一权威（local://wmb-5237-contract 经广播确认）。
// 禁止在 main / renderer 各自维护第二套同名类型或 parser。

export type MediaWidthPreset = 'small' | 'medium' | 'large' | 'full';
export type MediaAlign = 'left' | 'center' | 'right';

/** 绑定媒体种类：图片进入正文 token；视频是结构化附件（绝不进入 `wmb-asset://` 图片 token）；video_poster 跟随视频。 */
export type MediaKind = 'image' | 'video' | 'video_poster';
export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'video_poster'];

/** 视频可引用时间段（毫秒）：0 <= startMs < endMs，endMs - startMs <= 60000（用户物化 Clip 上限）。 */
export type ClipRange = {
  startMs: number;
  endMs: number;
};

/** 视频 Clip 物化载荷：随平台保存事务原子写入（staging 在事务前完成，asset/provenance/binding 同事务）。 */
export type PlatformClipPayload = {
  sourceAssetId: string;
  startMs: number;
  endMs: number;
};

export const MEDIA_WIDTH_PRESETS: readonly MediaWidthPreset[] = ['small', 'medium', 'large', 'full'];
export const MEDIA_ALIGNS: readonly MediaAlign[] = ['left', 'center', 'right'];

/** 用户物化 Clip 的最大时长（毫秒），与设计 §10.9 一致。 */
export const MAX_CLIP_DURATION_MS = 60_000;

/** 归一化矩形裁剪区域：四值均 ∈ [0,1]，width/height > 0，x+width <= 1，y+height <= 1。 */
export type CropRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 核心图文版本绑定写入草稿（renderer key = assetId:occurrence；布局字段只进绑定，绝不塞入正文 token）。 */
export type ContentMediaBindingDraft = {
  assetId: string;
  /** 正文中相同 assetId 的第几次出现（0 起）。 */
  occurrence: number;
  widthPreset: MediaWidthPreset;
  align: MediaAlign;
  caption?: string | null;
  linkUrl?: string | null;
  /** 媒体种类；缺省 'image'（存量/旧 renderer 不传保持图片语义）。 */
  mediaKind?: MediaKind;
};

/** 平台图文版本绑定写入草稿（序 = 平台图序，封面/裁剪/平台图注的正式载体）。 */
export type PlatformMediaBindingDraft = {
  assetId: string;
  /** 平台图序（0 起）。 */
  ordinal: number;
  /** 平台图注覆盖；null = 沿用核心图注。 */
  caption?: string | null;
  /** 封面标记；同一平台版本至多一个 true（X 平台必须位于 ordinal 0）。 */
  isCover?: boolean;
  /** 归一化裁剪区域；非空时必须伴随已物化的 derivedAssetId（或本次保存的 cropPayloads）。 */
  cropRegion?: CropRegion | null;
  /** 裁剪物化后的派生 asset id（sha256 去重，provenance 可回溯）。 */
  derivedAssetId?: string | null;
  /** 媒体种类；缺省 'image'。视频是结构化附件，绝不进入正文 token。 */
  mediaKind?: MediaKind;
  /** 视频封面（video_poster 或派生帧）asset id；仅媒体种类为 video 时使用。 */
  posterAssetId?: string | null;
  /** 用户接受的视频时间段（毫秒）；设置后保存事务物化 derived_clip 并回填 derivedAssetId。 */
  clipRange?: ClipRange | null;
  /** 视频时长（毫秒）；与 clipRange 一并冻结，供平台适配器使用。 */
  durationMs?: number | null;
};

/** 读模型：核心绑定（含版本归属与时间戳）。 */
export type ContentMediaBinding = ContentMediaBindingDraft & {
  id: string;
  contentVersionId: string;
  createdAt: string;
  updatedAt: string;
  mediaKind: MediaKind;
};

/** 读模型：平台绑定（含版本归属与时间戳）。 */
export type PlatformMediaBinding = {
  id: string;
  platformVersionId: string;
  assetId: string;
  ordinal: number;
  caption: string | null;
  isCover: boolean;
  cropRegion: CropRegion | null;
  derivedAssetId: string | null;
  mediaKind: MediaKind;
  posterAssetId: string | null;
  clipRange: ClipRange | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

/** 平台保存附带的裁切载荷：renderer canvas 导出的 PNG（base64），随保存事务原子物化派生 asset。 */
export type PlatformCropPayload = {
  assetId: string;
  cropRegion: CropRegion;
  pngBase64: string;
  /** 导出 PNG 像素尺寸（renderer canvas 实际尺寸）；缺省由 main 侧 IHDR 解析补全，写入 provenance transform_json。 */
  width?: number | null;
  height?: number | null;
};

/** renderer key：`assetId:occurrence`。 */
export const contentBindingKey = (assetId: string, occurrence: number): string => `${assetId}:${occurrence}`;

export function isValidCropRegion(region: CropRegion | null | undefined): region is CropRegion {
  if (!region || typeof region !== 'object') return false;
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  return width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 1 && y + height <= 1;
}

/**
 * 校验视频可引用时间段：毫秒整数、0 <= startMs < endMs、endMs - startMs <= 60000（用户物化 Clip 上限）。
 * 非法输入 fail-closed 返回 false（不写库）。
 */
export function isValidClipRange(range: ClipRange | null | undefined): range is ClipRange {
  if (!range || typeof range !== 'object') return false;
  const { startMs, endMs } = range;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) return false;
  if (startMs < 0 || endMs <= startMs) return false;
  return endMs - startMs <= MAX_CLIP_DURATION_MS;
}

export function normalizeMediaKind(value: unknown): MediaKind {
  if (value === undefined || value === null || value === '') return 'image';
  if (typeof value !== 'string' || !MEDIA_KINDS.includes(value as MediaKind)) {
    throw new Error(`mediaKind 无效: ${String(value)}（允许 ${MEDIA_KINDS.join('/')}）。`);
  }
  return value as MediaKind;
}

function assertMediaWidthPreset(value: MediaWidthPreset): asserts value is MediaWidthPreset {
  if (!MEDIA_WIDTH_PRESETS.includes(value)) throw new Error(`widthPreset 无效: ${String(value)}（允许 ${MEDIA_WIDTH_PRESETS.join('/')}）。`);
}

function assertMediaAlign(value: MediaAlign): asserts value is MediaAlign {
  if (!MEDIA_ALIGNS.includes(value)) throw new Error(`align 无效: ${String(value)}（允许 ${MEDIA_ALIGNS.join('/')}）。`);
}

/** 校验并规范化核心绑定草稿；非法输入 fail-closed 抛错（不写库）。 */
export function normalizeContentMediaBindings(drafts: ContentMediaBindingDraft[] | null | undefined): ContentMediaBindingDraft[] {
  if (!drafts || drafts.length === 0) return [];
  const seen = new Set<string>();
  return drafts.map((draft, index) => {
    if (!draft || typeof draft !== 'object') throw new Error(`内容绑定 #${index} 无效。`);
    if (typeof draft.assetId !== 'string' || !draft.assetId) throw new Error(`内容绑定 #${index} 缺少 assetId。`);
    if (!Number.isInteger(draft.occurrence) || draft.occurrence < 0) throw new Error(`内容绑定 #${index} 的 occurrence 必须是非负整数。`);
    assertMediaWidthPreset(draft.widthPreset);
    assertMediaAlign(draft.align);
    const key = contentBindingKey(draft.assetId, draft.occurrence);
    if (seen.has(key)) throw new Error(`内容绑定 #${index} 重复: ${key}。`);
    seen.add(key);
    return {
      assetId: draft.assetId,
      occurrence: draft.occurrence,
      widthPreset: draft.widthPreset,
      align: draft.align,
      caption: draft.caption == null ? null : String(draft.caption),
      linkUrl: draft.linkUrl == null ? null : String(draft.linkUrl),
      mediaKind: normalizeMediaKind(draft.mediaKind)
    };
  });
}

/** 校验并规范化平台绑定草稿（ordinal 按给定序重排为 0..n-1 连续；isCover 至多一个）。 */
export function normalizePlatformMediaBindings(drafts: PlatformMediaBindingDraft[] | null | undefined): PlatformMediaBindingDraft[] {
  if (!drafts || drafts.length === 0) return [];
  const seenAssets = new Set<string>();
  let coverCount = 0;
  return [...drafts]
    .map((draft, index) => {
      if (!draft || typeof draft !== 'object') throw new Error(`平台绑定 #${index} 无效。`);
      if (typeof draft.assetId !== 'string' || !draft.assetId) throw new Error(`平台绑定 #${index} 缺少 assetId。`);
      if (!Number.isInteger(draft.ordinal) || draft.ordinal < 0) throw new Error(`平台绑定 #${index} 的 ordinal 必须是非负整数。`);
      if (seenAssets.has(draft.assetId)) throw new Error(`平台绑定 #${index} assetId 重复: ${draft.assetId}。`);
      seenAssets.add(draft.assetId);
      if (draft.cropRegion != null && !isValidCropRegion(draft.cropRegion)) {
        throw new Error(`平台绑定 #${index} 的 cropRegion 无效（须 0..1 且 x+width<=1、y+height<=1、width/height>0）。`);
      }
      if (draft.derivedAssetId != null && (typeof draft.derivedAssetId !== 'string' || !draft.derivedAssetId)) {
        throw new Error(`平台绑定 #${index} 的 derivedAssetId 无效。`);
      }
      const mediaKind = normalizeMediaKind(draft.mediaKind);
      if (draft.clipRange != null && !isValidClipRange(draft.clipRange)) {
        throw new Error(`平台绑定 #${index} 的 clipRange 无效（须毫秒整数 0<=start<end<=60000）。`);
      }
      if (draft.clipRange != null && mediaKind !== 'video') {
        throw new Error(`平台绑定 #${index} 的 clipRange 只能用于 video 媒体。`);
      }
      if (draft.posterAssetId != null && (typeof draft.posterAssetId !== 'string' || !draft.posterAssetId)) {
        throw new Error(`平台绑定 #${index} 的 posterAssetId 无效。`);
      }
      if (draft.durationMs != null && (!Number.isSafeInteger(draft.durationMs) || draft.durationMs <= 0)) {
        throw new Error(`平台绑定 #${index} 的 durationMs 必须是正整数毫秒。`);
      }
      const isCover = draft.isCover === true;
      if (isCover) coverCount += 1;
      return {
        assetId: draft.assetId,
        ordinal: draft.ordinal,
        caption: draft.caption == null ? null : String(draft.caption),
        isCover,
        cropRegion: draft.cropRegion ?? null,
        derivedAssetId: draft.derivedAssetId ?? null,
        mediaKind,
        posterAssetId: draft.posterAssetId ?? null,
        clipRange: draft.clipRange ?? null,
        durationMs: draft.durationMs ?? null
      };
    })
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((draft, index) => ({ ...draft, ordinal: index }));
}

/** 由平台绑定重建 asset_ids_json 投影：有效 derivedAssetId || assetId，按 ordinal 升序。 */
export function buildAssetIdsFromPlatformBindings(
  bindings: ReadonlyArray<{ ordinal: number; assetId: string; derivedAssetId?: string | null }>
): string[] {
  return [...bindings].sort((a, b) => a.ordinal - b.ordinal).map((binding) => binding.derivedAssetId || binding.assetId);
}
