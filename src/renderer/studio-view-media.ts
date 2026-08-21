// extracted from studio-view.tsx (structural split)
import type { ContentProjectDetail } from '../main/content';
import type { ContentMediaBinding, ContentMediaBindingDraft } from '../shared/media-bindings';

// ---- WMB-5237 核心媒体布局草稿：detail 读模型 → 草稿（字段名以 src/shared/media-bindings.ts 为准） ----
export function coreBindingsFromDetail(detail: ContentProjectDetail | null): ContentMediaBindingDraft[] {
  const latest = detail?.revisions[0] as (ContentProjectDetail['revisions'][number] & { bindings?: ContentMediaBinding[] }) | undefined;
  const bindings = latest?.bindings;
  if (!bindings || bindings.length === 0) return [];
  return bindings.map((binding) => ({
    assetId: binding.assetId,
    occurrence: binding.occurrence,
    widthPreset: binding.widthPreset,
    align: binding.align,
    caption: binding.caption ?? null,
    linkUrl: binding.linkUrl ?? null
  }));
}

export function coreMediaBindingsEqual(a: ContentMediaBindingDraft[], b: ContentMediaBindingDraft[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.assetId !== y.assetId || x.occurrence !== y.occurrence || x.widthPreset !== y.widthPreset || x.align !== y.align
      || (x.caption ?? null) !== (y.caption ?? null) || (x.linkUrl ?? null) !== (y.linkUrl ?? null)) return false;
  }
  return true;
}
