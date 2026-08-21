// extracted from studio-view.tsx (structural split)
import { parseAssetImages } from './studio-view-helpers';
import { platformNames } from './studio-view-helpers';
import type { ContentProjectDetail } from '../main/content';
import type { StudioPlatform } from '../shared/studio-annotations';

export function useStudioSave(params: {
  selected: ContentProjectDetail | null;
  busy: boolean;
  readOnlyVersion: unknown;
  editorBody: string;
  editorTitle: string;
  dirty: boolean;
  activePlatform: StudioPlatform | null | undefined;
  activePlatformVersion: ContentProjectDetail['platformVersions'][StudioPlatform][number] | null | undefined;
  activePlatformDraft: { title?: string; body?: string; assetIds?: string[]; mediaBindings?: unknown[] } | undefined;
  activePlatformDraftKey: string | null;
  platformDrafts: Record<string, unknown>;
  setPlatformDrafts: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setPlatformCropPayloads: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  coreMediaDraft: unknown[];
  setBusy: (v: boolean) => void;
  setPlatformSelections: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSelected: (v: ContentProjectDetail | null) => void;
  loadFirst: (quiet?: boolean) => Promise<void>;
  reload: () => Promise<void>;
  setAnnotationReloadTick: React.Dispatch<React.SetStateAction<number>>;
  syncAnnotationsToBody: (scope: unknown, scopeKey: string, body: string, mode: 'incremental' | 'replacement') => Promise<boolean>;
  annotationScope: unknown;
  annotationScopeKeyValue: string;
  reconcileTimer: React.MutableRefObject<number | undefined>;
  selectedId: string | null;
  latest: ContentProjectDetail['revisions'][number] | undefined;
  platformSyncedBindings: unknown[];
  currentPlatformBindings: unknown[];
  parseAssetImagesRef?: typeof parseAssetImages;
}) {
  const {
    selected, busy, readOnlyVersion, editorBody, editorTitle, dirty, activePlatform, activePlatformVersion, activePlatformDraft, activePlatformDraftKey,
    setPlatformDrafts, platformCropPayloads, setPlatformCropPayloads, coreMediaDraft, setMessage, setBusy, setPlatformSelections, setSelected, loadFirst, reload, setAnnotationReloadTick,
    syncAnnotationsToBody, annotationScope, annotationScopeKeyValue, reconcileTimer, latest, platformSyncedBindings, currentPlatformBindings
  } = params as unknown as Record<string, unknown> & typeof params;

  const save = async () => {
    if (!selected || busy || readOnlyVersion) return;
    if (!(editorBody as string).trim() || (!activePlatform && !(editorTitle as string).trim())) { setMessage(!(editorBody as string).trim() ? '正文不能为空' : '标题不能为空'); return; }
    if (!dirty) {
      setMessage('内容没有改动');
      window.setTimeout(() => setMessage((current) => current === '内容没有改动' ? '' : current as string), 1600);
      return;
    }
    setBusy(true); setMessage('正在保存…');
    const platformNewVersion = Boolean(activePlatform && !activePlatformVersion);
    if (annotationScope && (params as unknown as { rowsScopeKeyRef: React.MutableRefObject<string> }).rowsScopeKeyRef?.current === annotationScopeKeyValue && !platformNewVersion) {
      const annotationsSynced = await syncAnnotationsToBody(annotationScope, annotationScopeKeyValue as string, editorBody as string, 'incremental');
      if (!annotationsSynced) {
        setMessage('批注同步失败，正文尚未保存，请重试');
        setBusy(false);
        return;
      }
    }
    window.clearTimeout((reconcileTimer as React.MutableRefObject<number | undefined>).current);
    try {
      if (activePlatform) {
        if (!latest) { setMessage('请先保存核心正文，再创建平台版本'); return; }
        const draftBindings = (activePlatformDraft as { mediaBindings?: unknown[] })?.mediaBindings;
        const savedBindings = draftBindings ?? platformSyncedBindings;
        const result = await (window.wmb as unknown as { saveStudioPlatform: (p: unknown) => Promise<{ ok: boolean; data?: { id: string; revision: number }; error?: { code?: string; message?: string } }> }).saveStudioPlatform({
          projectId: (selected as ContentProjectDetail).id,
          contentVersionId: (activePlatformVersion as { contentVersionId: string })?.contentVersionId ?? (latest as { id: string }).id,
          platform: activePlatform as string,
          format: (activePlatformVersion as { format?: string })?.format ?? 'text',
          title: (editorTitle as string).trim() || undefined,
          body: editorBody as string,
          assetIds: (activePlatformDraft as { assetIds?: string[] })?.assetIds ?? (activePlatformVersion as { assets?: string[] })?.assets ?? [],
          mediaBindings: savedBindings as never,
          cropPayloads: Object.values(platformCropPayloads as Record<string, unknown>).filter((payload) => (savedBindings as unknown[]).some((binding) => (binding as { assetId: string }).assetId === (payload as { assetId: string }).assetId)),
          clipPayloads: (savedBindings as unknown[]).filter((binding) => (binding as { mediaKind?: string; clipRange?: unknown; derivedAssetId?: string | null }).mediaKind === 'video' && (binding as { clipRange?: unknown }).clipRange && (binding as { derivedAssetId?: string | null }).derivedAssetId == null).map((binding) => ({ sourceAssetId: (binding as { assetId: string }).assetId, startMs: (binding as { clipRange: { startMs: number } }).clipRange.startMs, endMs: (binding as { clipRange: { endMs: number } }).clipRange.endMs })),
          expectedRevision: (activePlatformVersion as { revision?: number })?.revision,
          versionId: (activePlatformVersion as { id?: string })?.id
        });
        if (!result.ok || !result.data) {
          setMessage(result.error?.code === 'REVISION_CONFLICT' ? '平台版本已在其他位置更新，请重新打开项目后再保存' : result.error?.message || '保存失败');
          return;
        }
        const savedId = result.data.id;
        setPlatformSelections((current) => ({ ...current, [activePlatform as string]: savedId }));
        if (activePlatformDraftKey) setPlatformDrafts((current) => { const next = { ...current }; delete next[activePlatformDraftKey as string]; return next; });
        setPlatformCropPayloads({} as Record<string, unknown>);
        const detail = await (window.wmb as unknown as { getStudioProject: (id: string) => Promise<ContentProjectDetail | null> }).getStudioProject((selected as ContentProjectDetail).id); if (detail) setSelected(detail);
        await loadFirst(true);
        setAnnotationReloadTick((tick) => tick + 1);
        setMessage(`已保存${(platformNames as Record<string, string>)[activePlatform as string]}平台版本 · 版本 ${result.data.revision}`);
        return;
      }
      const coreSaveBindings = (coreMediaDraft as unknown[]).length > 0
        ? (coreMediaDraft as unknown[]).flatMap((binding) => {
                    const ref = parseAssetImages(editorBody as string).find((item) => item.assetId === (binding as { assetId: string }).assetId && item.occurrence === (binding as { occurrence: number }).occurrence);
                    if (!ref) return [];
                    return [ref.alt !== ((binding as { caption?: string | null }).caption ?? '') ? { ...(binding as Record<string, unknown>), caption: ref.alt } : binding];
                  })
        : undefined;
      const result = await (window.wmb as unknown as { saveStudioCore: (p: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string } }> }).saveStudioCore({ projectId: (selected as ContentProjectDetail).id, title: (editorTitle as string).trim(), body: editorBody as string, expectedRevision: (selected as ContentProjectDetail).revision, mediaBindings: coreSaveBindings as never });
      setMessage(result.ok ? '已保存' : result.error?.code === 'REVISION_CONFLICT' ? '内容已在其他位置更新，请读取最新内容后再保存' : result.error?.message || '保存失败');
      if (result.ok) { await reload(); setAnnotationReloadTick((tick) => tick + 1); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return { save };
}
