import type { ContentProjectDetail, ContentProjectPlatform } from '../main/content';
import type { PlatformMediaBinding, PlatformMediaBindingDraft } from '../shared/media-bindings';
import { parseAssetImages, type StudioAssetImageRef } from '../shared/media-token';

export type StudioTab = 'core' | 'versions' | 'sources' | 'assets' | 'investigation' | `platform:${ContentProjectPlatform}`;

export const studioPlatformTab = (platform: ContentProjectPlatform): StudioTab => `platform:${platform}`;

export function studioPlatformFromTab(tab: string): ContentProjectPlatform | null {
  if (tab === 'platform:x') return 'x';
  if (tab === 'platform:xiaohongshu') return 'xiaohongshu';
  if (tab === 'platform:wechat') return 'wechat';
  if (tab === 'platform:zhihu') return 'zhihu';
  return null;
}

export type StudioPlatformVersion = ContentProjectDetail['platformVersions'][ContentProjectPlatform][number];

// WMB-5237 读模型访问器：字段名以 src/shared/media-bindings.ts 契约为准。
// content.ts 类型落地前（Data worker 施工中）用防御性读取保持编译；落地后自动兼容。
export type StudioPlatformVersionRead = StudioPlatformVersion & { mediaBindings?: PlatformMediaBinding[] };
export const readPlatformVersionBindings = (version: StudioPlatformVersion | null): PlatformMediaBinding[] | undefined =>
  (version as StudioPlatformVersionRead | null)?.mediaBindings;

export type StudioPlatformDraft = {
  title: string; body: string; assetIds: string[];
  /** 平台媒体编排草稿（封面/发布序/裁剪/平台图注），保存时整体替换；数组顺序 = 正文出现序，ordinal = 发布序。 */
  mediaBindings: PlatformMediaBindingDraft[];
  baseTitle: string; baseBody: string; baseAssetIds: string[];
  baseMediaBindings: PlatformMediaBindingDraft[];
};

export function selectStudioPlatformVersion(versions: StudioPlatformVersion[], selectedId?: string): StudioPlatformVersion | null {
  return versions.find((version) => version.id === selectedId) ?? versions[0] ?? null;
}

export const studioPlatformDraftKey = (platform: ContentProjectPlatform, version: StudioPlatformVersion | null): string => version?.id ?? `new:${platform}`;

/** 读模型 → 平台绑定草稿（剥离 id/createdAt/updatedAt；旧 detail 无字段返回 []）。 */
export function platformBindingsToDrafts(bindings: PlatformMediaBinding[] | null | undefined): PlatformMediaBindingDraft[] {
  if (!bindings || bindings.length === 0) return [];
  return bindings.map((binding) => ({
    assetId: binding.assetId,
    ordinal: binding.ordinal,
    caption: binding.caption ?? null,
    isCover: binding.isCover === true,
    cropRegion: binding.cropRegion ?? null,
    derivedAssetId: binding.derivedAssetId ?? null,
    mediaKind: binding.mediaKind ?? 'image',
    posterAssetId: binding.posterAssetId ?? null,
    clipRange: binding.clipRange ?? null,
    durationMs: binding.durationMs ?? null
  }));
}

/** 正文引用 → 默认平台绑定（旧项目无持久化绑定时的推导：每个 asset 至多一个绑定，ordinal = 出现序）。 */
export function platformBindingsFromRefs(refs: StudioAssetImageRef[]): PlatformMediaBindingDraft[] {
  const seenAssets = new Set<string>();
  const bindings: PlatformMediaBindingDraft[] = [];
  for (const ref of refs) {
    if (seenAssets.has(ref.assetId)) continue;
    seenAssets.add(ref.assetId);
    bindings.push({ assetId: ref.assetId, ordinal: bindings.length, isCover: false, caption: null, cropRegion: null, derivedAssetId: null, mediaKind: 'image' });
  }
  return bindings;
}

/**
 * 以正文引用对账平台绑定（替换/删除/插入/图注后调用）：
 * 保留仍被引用的绑定元数据（封面/裁剪/图注/发布序），追加新引用（按正文位置进入发布序），
 * 移除已不在正文的 image asset；video 绑定是结构化附件（不进入正文 token），始终保留；
 * ordinal 稳定重排为 0..n-1（发布序相对顺序不变，数组顺序 = 正文序 + 附件序）。
 */
export function syncPlatformBindingsToRefs(
  current: PlatformMediaBindingDraft[],
  refs: StudioAssetImageRef[]
): PlatformMediaBindingDraft[] {
  const seenAssets = new Set<string>();
  const next: PlatformMediaBindingDraft[] = [];
  for (const ref of refs) {
    if (seenAssets.has(ref.assetId)) continue;
    seenAssets.add(ref.assetId);
    const existing = current.find((binding) => binding.assetId === ref.assetId);
    if (existing) {
      next.push({
        assetId: existing.assetId,
        ordinal: existing.ordinal,
        caption: existing.caption ?? null,
        isCover: existing.isCover === true,
        cropRegion: existing.cropRegion ?? null,
        derivedAssetId: existing.derivedAssetId ?? null,
        mediaKind: existing.mediaKind ?? 'image',
        posterAssetId: existing.posterAssetId ?? null,
        clipRange: existing.clipRange ?? null,
        durationMs: existing.durationMs ?? null
      });
    } else {
      next.push({ assetId: ref.assetId, ordinal: next.length, isCover: false, caption: null, cropRegion: null, derivedAssetId: null, mediaKind: 'image' });
    }
  }
  // 视频结构化附件：无论正文是否引用都保留（设计 §12.2/§12.3；绝不进入 wmb-asset 图片 token）。
  for (const binding of current) {
    if (binding.mediaKind === 'video' && !seenAssets.has(binding.assetId)) {
      seenAssets.add(binding.assetId);
      next.push({ ...binding, ordinal: next.length });
    }
  }
  return renormalizePlatformOrdinals(next);
}

/** 稳定重排：按当前 ordinal 升序（同值按数组序）重写为 0..n-1；数组顺序（正文序）保持不变。 */
export function renormalizePlatformOrdinals(bindings: PlatformMediaBindingDraft[]): PlatformMediaBindingDraft[] {
  if (bindings.length === 0) return [];
  const sorted = bindings
    .map((binding, index) => ({ binding, index }))
    .sort((a, b) => (a.binding.ordinal - b.binding.ordinal) || a.index - b.index);
  const rankByIndex = new Map<number, number>();
  sorted.forEach(({ index }, rank) => rankByIndex.set(index, rank));
  return bindings.map((binding, index) => ({ ...binding, ordinal: rankByIndex.get(index) ?? index }));
}

/**
 * 设置封面：同一平台版本至多一个 true（其余清空）；
 * X 平台封面必须位于 ordinal 0（单图发布边界），设置时自动移至发布序首位。
 */
export function setPlatformCover(
  bindings: PlatformMediaBindingDraft[],
  assetId: string,
  isCover: boolean,
  platform: ContentProjectPlatform
): PlatformMediaBindingDraft[] {
  const next = bindings.map((binding) => ({ ...binding, isCover: binding.assetId === assetId ? isCover : false }));
  if (!isCover) return next;
  if (platform === 'x') return movePlatformBindingToPublishFront(next, assetId);
  return next;
}

/** 把指定 asset 的绑定移到发布序首位（X 封面 ordinal 0 不变式）；数组顺序不变，仅重写 ordinal。 */
export function movePlatformBindingToPublishFront(bindings: PlatformMediaBindingDraft[], assetId: string): PlatformMediaBindingDraft[] {
  const target = bindings.find((binding) => binding.assetId === assetId);
  if (!target || target.ordinal === 0) return bindings;
  const targetOrdinal = target.ordinal;
  return bindings.map((binding) => {
    if (binding.assetId === assetId) return { ...binding, ordinal: 0 };
    return { ...binding, ordinal: binding.ordinal < targetOrdinal ? binding.ordinal + 1 : binding.ordinal };
  });
}

/** 平台发布序相邻交换（delta = -1 上移 / 1 下移）；仅改 ordinal 字段，数组顺序（正文序）不变。 */
export function shiftPlatformBindingOrdinal(
  bindings: PlatformMediaBindingDraft[],
  assetId: string,
  delta: -1 | 1
): PlatformMediaBindingDraft[] {
  const sorted = [...bindings].sort((a, b) => a.ordinal - b.ordinal);
  const index = sorted.findIndex((binding) => binding.assetId === assetId);
  const neighbor = index + delta;
  if (index === -1 || neighbor < 0 || neighbor >= sorted.length) return bindings;
  const a = sorted[index];
  const b = sorted[neighbor];
  return bindings.map((binding) => {
    if (binding.assetId === a.assetId) return { ...binding, ordinal: b.ordinal };
    if (binding.assetId === b.assetId) return { ...binding, ordinal: a.ordinal };
    return binding;
  });
}

/** 更新平台图注覆盖（null = 沿用核心图注）。 */
export function setPlatformBindingCaption(
  bindings: PlatformMediaBindingDraft[],
  assetId: string,
  caption: string | null
): PlatformMediaBindingDraft[] {
  const nextCaption = caption == null ? null : String(caption);
  return bindings.map((binding) => (binding.assetId === assetId ? { ...binding, caption: nextCaption } : binding));
}

/** 设置视频封面（poster_asset_id；仅 video 绑定可用）。 */
export function setPlatformBindingPoster(
  bindings: PlatformMediaBindingDraft[],
  assetId: string,
  posterAssetId: string | null
): PlatformMediaBindingDraft[] {
  return bindings.map((binding) =>
    binding.assetId === assetId && binding.mediaKind === 'video'
      ? { ...binding, posterAssetId: posterAssetId ?? null }
      : binding
  );
}

/** 设置视频可引用时间段（clipRange + durationMs；仅 video 绑定可用；清除时 durationMs 保留）。 */
export function setPlatformBindingClipRange(
  bindings: PlatformMediaBindingDraft[],
  assetId: string,
  clipRange: { startMs: number; endMs: number } | null,
  durationMs?: number | null
): PlatformMediaBindingDraft[] {
  return bindings.map((binding) =>
    binding.assetId === assetId && binding.mediaKind === 'video'
      ? {
          ...binding,
          clipRange: clipRange ?? null,
          durationMs: durationMs === undefined ? (clipRange ? (clipRange.endMs - clipRange.startMs) : binding.durationMs) : durationMs
        }
      : binding
  );
}

/**
 * 追加视频结构化附件绑定（接受视频建议/手动放入平台时调用）。
 * 不进入正文 token；发布序追加到末尾（ordinal 稳定重排）。已存在同 asset 绑定则只更新元数据。
 */
export function addVideoPlatformBinding(
  bindings: PlatformMediaBindingDraft[],
  input: {
    assetId: string;
    posterAssetId?: string | null;
    clipRange?: { startMs: number; endMs: number } | null;
    durationMs?: number | null;
    caption?: string | null;
  }
): PlatformMediaBindingDraft[] {
  const existingIndex = bindings.findIndex((binding) => binding.assetId === input.assetId);
  const existing = existingIndex >= 0 ? bindings[existingIndex] : null;
  // 时间段未显式给时长时按 clipRange 推导（endMs-startMs），保证绑定时长与片段一致。
  const clipRange = input.clipRange ?? existing?.clipRange ?? null;
  const durationMs = input.durationMs != null
    ? input.durationMs
    : clipRange
      ? clipRange.endMs - clipRange.startMs
      : existing?.durationMs ?? null;
  const next: PlatformMediaBindingDraft[] = bindings.map((binding) =>
    binding.assetId === input.assetId && binding.mediaKind === 'video'
      ? {
          ...binding,
          posterAssetId: input.posterAssetId ?? binding.posterAssetId ?? null,
          clipRange: input.clipRange ?? binding.clipRange ?? null,
          durationMs,
          caption: input.caption === undefined ? binding.caption : input.caption
        }
      : binding
  );
  if (existingIndex === -1) {
    next.push({
      assetId: input.assetId,
      ordinal: next.length,
      caption: input.caption ?? null,
      isCover: false,
      cropRegion: null,
      derivedAssetId: null,
      mediaKind: 'video',
      posterAssetId: input.posterAssetId ?? null,
      clipRange: input.clipRange ?? null,
      durationMs: input.durationMs ?? (input.clipRange ? input.clipRange.endMs - input.clipRange.startMs : null)
    });
  }
  return renormalizePlatformOrdinals(next);
}

/** 平台绑定深比较（封面/序/图注/裁剪/派生 asset/媒体种类/封面图/时间段 任一变化即不等）。 */
export function platformMediaBindingsEqual(a: PlatformMediaBindingDraft[], b: PlatformMediaBindingDraft[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.assetId !== y.assetId || x.ordinal !== y.ordinal
      || (x.isCover ?? false) !== (y.isCover ?? false)
      || (x.caption ?? null) !== (y.caption ?? null)
      || (x.derivedAssetId ?? null) !== (y.derivedAssetId ?? null)
      || (x.mediaKind ?? 'image') !== (y.mediaKind ?? 'image')
      || (x.posterAssetId ?? null) !== (y.posterAssetId ?? null)
      || (x.durationMs ?? null) !== (y.durationMs ?? null)
      || !cropRegionsEqual(x.cropRegion, y.cropRegion)
      || !clipRangesEqual(x.clipRange, y.clipRange)) return false;
  }
  return true;
}

function clipRangesEqual(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const ra = a as { startMs: number; endMs: number };
  const rb = b as { startMs: number; endMs: number };
  return ra.startMs === rb.startMs && ra.endMs === rb.endMs;
}

function cropRegionsEqual(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const ra = a as { x: number; y: number; width: number; height: number };
  const rb = b as { x: number; y: number; width: number; height: number };
  return ra.x === rb.x && ra.y === rb.y && ra.width === rb.width && ra.height === rb.height;
}

export function createStudioPlatformDraft(version: StudioPlatformVersion | null): StudioPlatformDraft {
  const assetIds = [...(version?.assets ?? [])];
  const persisted = platformBindingsToDrafts(readPlatformVersionBindings(version));
  const refs = parseAssetImages(version?.body ?? '');
  // 有持久化绑定：与正文对账（保留元数据，增删同步）；无绑定（旧项目）：按正文引用推导默认绑定。
  const mediaBindings = persisted.length > 0 ? syncPlatformBindingsToRefs(persisted, refs) : platformBindingsFromRefs(refs);
  return {
    title: version?.title ?? '', body: version?.body ?? '', assetIds,
    mediaBindings,
    baseTitle: version?.title ?? '', baseBody: version?.body ?? '', baseAssetIds: [...assetIds],
    baseMediaBindings: mediaBindings.map((binding) => ({ ...binding }))
  };
}

export function isStudioPlatformDraftDirty(draft: StudioPlatformDraft): boolean {
  return draft.title !== draft.baseTitle || draft.body !== draft.baseBody
    || !platformMediaBindingsEqual(draft.mediaBindings, draft.baseMediaBindings)
    || draft.assetIds.length !== draft.baseAssetIds.length
    || draft.assetIds.some((id, index) => id !== draft.baseAssetIds[index]);
}
