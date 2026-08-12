import type { ContentProjectDetail, ContentProjectPlatform } from '../main/content';

export type StudioTab = 'core' | 'versions' | 'sources' | 'assets' | `platform:${ContentProjectPlatform}`;

export const studioPlatformTab = (platform: ContentProjectPlatform): StudioTab => `platform:${platform}`;

export function studioPlatformFromTab(tab: string): ContentProjectPlatform | null {
  if (tab === 'platform:x') return 'x';
  if (tab === 'platform:xiaohongshu') return 'xiaohongshu';
  if (tab === 'platform:wechat') return 'wechat';
  return null;
}

export type StudioPlatformVersion = ContentProjectDetail['platformVersions'][ContentProjectPlatform][number];
export type StudioPlatformDraft = {
  title: string; body: string; assetIds: string[];
  baseTitle: string; baseBody: string; baseAssetIds: string[];
};

export function selectStudioPlatformVersion(versions: StudioPlatformVersion[], selectedId?: string): StudioPlatformVersion | null {
  return versions.find((version) => version.id === selectedId) ?? versions[0] ?? null;
}

export const studioPlatformDraftKey = (platform: ContentProjectPlatform, version: StudioPlatformVersion | null): string => version?.id ?? `new:${platform}`;

export function createStudioPlatformDraft(version: StudioPlatformVersion | null): StudioPlatformDraft {
  const assetIds = [...(version?.assets ?? [])];
  return {
    title: version?.title ?? '', body: version?.body ?? '', assetIds,
    baseTitle: version?.title ?? '', baseBody: version?.body ?? '', baseAssetIds: [...assetIds]
  };
}

export function isStudioPlatformDraftDirty(draft: StudioPlatformDraft): boolean {
  return draft.title !== draft.baseTitle || draft.body !== draft.baseBody
    || draft.assetIds.length !== draft.baseAssetIds.length
    || draft.assetIds.some((id, index) => id !== draft.baseAssetIds[index]);
}
