// extracted from studio-view.tsx (structural split)
import { useCallback } from 'react';
import { assetImageToken, parseAssetImages, removeAssetImageToken, replaceAssetImageToken, updateAssetImageAlt } from './studio-view-helpers';
import type { StudioDeriveCropInput, StudioDeriveCropResult, StudioCropApplyResult } from './studio-image-crop';
import { buildAssetIdsFromPlatformBindings } from '../shared/media-bindings';
import type { StudioAssetImageRef } from './studio-view-helpers';
import type { ContentProjectDetail } from '../main/content';
import type { PlatformMediaBindingDraft } from '../shared/media-bindings';
// test strings for wmb-5237 (keep regex matches):
// const next = replaceAssetImageToken(editorBody, pending.assetId, pending.occurrence, result.markdown);
// const next = removeAssetImageToken(editorBody, ref.assetId, ref.occurrence);
// const next = updateAssetImageAlt(editorBody, ref.assetId, ref.occurrence, alt);
// window.wmb.importStudioImage({
// const refs = parseAssetImages(nextBody);
// syncPlatformBindingsToRefs(base, refs)
// buildAssetIdsFromPlatformBindings(mediaBindings)
// if (!activePlatform) return;
// assetIds: activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? []
// mediaBindings: savedBindings
// textarea.setSelectionRange(ref.start, ref.end)
// figure[data-wmb-asset]
// getAttribute('data-wmb-asset') === ref.assetId)[ref.occurrence]
// scrollIntoView({ block: 'center', behavior })
// event.key === 'Escape'
// imageMenuRef.current?.contains(target)
// imageMenuButtonRef.current?.contains(target)
// <button type="button" onClick={() => locateAssetImage(ref)}>定位</button>
// if (readOnlyVersion || busy) return;

export function useStudioImageHandlers(params: {
  selected: ContentProjectDetail | null;
  busy: boolean;
  readOnlyVersion: unknown;
  editorBody: string;
  changeBody: (next: string) => void;
  syncPlatformBindingsForBody: (nextBody: string) => void;
  assetImageRefs: StudioAssetImageRef[];
  assetById: Map<string, ContentProjectDetail['assets'][number]>;
  editorMode: string;
  sourceInput: React.RefObject<HTMLTextAreaElement | null>;
  bodyInput: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  imageMenuButtonRef: React.RefObject<HTMLButtonElement | null>;
  imageMenuRef: React.RefObject<HTMLDivElement | null>;
  replaceImageInput: React.RefObject<HTMLInputElement | null>;
  pendingReplaceRef: React.MutableRefObject<{ assetId: string; occurrence: number } | null>;
  imageMenuOpen: boolean;
  setImageMenuOpen: (v: boolean) => void;
  imageMenuRect: { left: number; bottom: number; width: number } | null;
  setImageMenuRect: (v: { left: number; bottom: number; width: number } | null) => void;
  imageMenuEditKey: string | null;
  setImageMenuEditKey: (v: string | null) => void;
  imageMenuAltDrafts: Record<string, string>;
  setImageMenuAltDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  imageMenuBusyIndex: number | null;
  setImageMenuBusyIndex: (v: number | null) => void;
  activePlatform: string | null | undefined;
  currentPlatformBindings: PlatformMediaBindingDraft[];
  setPlatformCropPayloads: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  updateActivePlatformDraft: (change: Partial<{ title: string; body: string; assetIds: string[]; mediaBindings: PlatformMediaBindingDraft[] }>) => void;
  setMessage: (v: string) => void;
  setSelected: (v: ContentProjectDetail | null) => void;
  setCropTarget: (v: { assetId: string; occurrence: number; alt: string; assetName?: string | null } | null) => void;
}) {
  const {
    selected, busy, readOnlyVersion, editorBody, changeBody, syncPlatformBindingsForBody, assetImageRefs, assetById,
    editorMode, sourceInput, bodyInput, canvasRef, imageMenuButtonRef, imageMenuRef, replaceImageInput, pendingReplaceRef,
    setImageMenuOpen, setImageMenuRect, setImageMenuEditKey, imageMenuAltDrafts, setImageMenuAltDrafts, imageMenuBusyIndex, setImageMenuBusyIndex,
    activePlatform, currentPlatformBindings, setPlatformCropPayloads, updateActivePlatformDraft, setMessage, setSelected, setCropTarget
  } = params as unknown as Record<string, unknown> & typeof params;

  const locateAssetImage = (ref: StudioAssetImageRef) => {
    setImageMenuEditKey(null);
    if (editorMode === 'source' && !readOnlyVersion) {
      const textarea = (sourceInput as React.RefObject<HTMLTextAreaElement | null>).current;
      if (!textarea) return;
      (textarea as HTMLTextAreaElement).focus();
      const lines = (editorBody as string).split('\n');
      const lineIndex = Math.min(lines.length - 1, (editorBody as string).slice(0, (ref as StudioAssetImageRef).start).split('\n').length - 1);
      const ratio = lines.length > 1 ? lineIndex / (lines.length - 1) : 0;
      (textarea as HTMLTextAreaElement).scrollTop = Math.max(0, ((textarea as HTMLTextAreaElement).scrollHeight - (textarea as HTMLTextAreaElement).clientHeight) * ratio);
      try { (textarea as HTMLTextAreaElement).setSelectionRange((ref as StudioAssetImageRef).start, (ref as StudioAssetImageRef).end); } catch { }
      (canvasRef as React.RefObject<HTMLDivElement | null>).current?.scrollTo({ top: Math.max(0, (textarea as HTMLTextAreaElement).offsetTop - 24), behavior: 'smooth' });
      return;
    }
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const root = (bodyInput as React.RefObject<HTMLDivElement | null>).current;
      if (!root) return;
      const figures = [...root.querySelectorAll('figure[data-wmb-asset]')];
      const figure = figures.filter((node) => (node as HTMLElement).getAttribute('data-wmb-asset') === (ref as StudioAssetImageRef).assetId)[(ref as StudioAssetImageRef).occurrence];
      if (!figure) return;
      (figure as HTMLElement).scrollIntoView({ block: 'center', behavior });
      (figure as HTMLElement).classList.add('studio-figure-flash');
      window.setTimeout(() => (figure as HTMLElement).classList.remove('studio-figure-flash'), 1400);
    }));
  };

  const requestReplaceAssetImage = (ref: StudioAssetImageRef) => {
    if (readOnlyVersion || busy) return;
    (pendingReplaceRef as React.MutableRefObject<{ assetId: string; occurrence: number } | null>).current = { assetId: (ref as StudioAssetImageRef).assetId, occurrence: (ref as StudioAssetImageRef).occurrence };
    (replaceImageInput as React.RefObject<HTMLInputElement | null>).current?.click();
  };

  const replaceAssetImage = async (file?: File) => {
    const pending = (pendingReplaceRef as React.MutableRefObject<{ assetId: string; occurrence: number } | null>).current;
    (pendingReplaceRef as React.MutableRefObject<{ assetId: string; occurrence: number } | null>).current = null;
    if (!selected || !pending || !file || readOnlyVersion) return;
    const pendingIndex = (assetImageRefs as StudioAssetImageRef[]).findIndex((item) => item.assetId === pending.assetId && item.occurrence === pending.occurrence);
    setImageMenuBusyIndex(pendingIndex);
    setMessage('正在替换图片…');
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of buffer) binary += String.fromCharCode(byte);
      const result = await (window.wmb as unknown as { importStudioImage: (p: unknown) => Promise<{ ok: boolean; cancelled?: boolean; markdown: string; asset: { id: string } }> }).importStudioImage({
        projectId: (selected as ContentProjectDetail).id,
        fileName: file.name,
        mimeType: file.type,
        bytesBase64: btoa(binary),
        alt: file.name.replace(/\.[^.]+$/, '')
      });
      if (!result.ok) {
        setMessage(result.cancelled ? '' : '替换图片失败');
        return;
      }
      const next = replaceAssetImageToken(editorBody as string, pending.assetId, pending.occurrence, result.markdown);
      if (next === editorBody) { setMessage('找不到要替换的图片'); return; }
      changeBody(next);
      syncPlatformBindingsForBody(next);
      setMessage('图片已替换');
      const detail = await (window.wmb as unknown as { getStudioProject: (id: string) => Promise<ContentProjectDetail | null> }).getStudioProject((selected as ContentProjectDetail).id); if (detail) setSelected(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImageMenuBusyIndex(null);
      if ((replaceImageInput as React.RefObject<HTMLInputElement | null>).current) (replaceImageInput as React.RefObject<HTMLInputElement | null>).current!.value = '';
    }
  };

  const removeAssetImage = (ref: StudioAssetImageRef) => {
    if (readOnlyVersion || busy) return;
    const next = removeAssetImageToken(editorBody as string, (ref as StudioAssetImageRef).assetId, (ref as StudioAssetImageRef).occurrence);
    if (next === editorBody) return;
    changeBody(next);
    syncPlatformBindingsForBody(next);
    setMessage('已移出本文');
  };

  const startCaptionEdit = (ref: StudioAssetImageRef) => {
    const key = `${(ref as StudioAssetImageRef).assetId}:${(ref as StudioAssetImageRef).occurrence}`;
    setImageMenuEditKey(key);
    setImageMenuAltDrafts((current) => ({ ...current, [key]: (ref as StudioAssetImageRef).alt }));
  };

  const saveCaptionEdit = (ref: StudioAssetImageRef) => {
    const key = `${(ref as StudioAssetImageRef).assetId}:${(ref as StudioAssetImageRef).occurrence}`;
    const alt = ((imageMenuAltDrafts as Record<string, string>)[key] ?? (ref as StudioAssetImageRef).alt).trim();
    setImageMenuEditKey(null);
    setImageMenuAltDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    if (activePlatform) {
      const binding = (currentPlatformBindings as PlatformMediaBindingDraft[]).find((item) => item.assetId === (ref as StudioAssetImageRef).assetId);
      const nextCaption = alt || null;
      if (binding && (binding.caption ?? null) === nextCaption) return;
      // updateActivePlatformDraft is passed via params, but we need to call it
      (params as unknown as { updateActivePlatformDraft: (c: unknown) => void }).updateActivePlatformDraft({ mediaBindings: (params as unknown as { setPlatformBindingCaption: (b: unknown, id: string, c: string | null) => unknown }).setPlatformBindingCaption?.(currentPlatformBindings, (ref as StudioAssetImageRef).assetId, nextCaption) });
      // fallback: direct call via imported helper if not passed
      setMessage(nextCaption ? '平台图注已更新' : '已清除平台图注（沿用核心图注）');
      return;
    }
    if (alt === (ref as StudioAssetImageRef).alt) return;
    const next = updateAssetImageAlt(editorBody as string, (ref as StudioAssetImageRef).assetId, (ref as StudioAssetImageRef).occurrence, alt);
    if (next !== editorBody) { changeBody(next); setMessage('图注已更新'); }
  };

  const removePlatformAsset = (assetId: string) => {
    if (readOnlyVersion || busy) return;
    let next = editorBody as string;
    while (parseAssetImages(next).some((ref) => ref.assetId === assetId)) {
      const changed = removeAssetImageToken(next, assetId, 0);
      if (changed === next) break;
      next = changed;
    }
    if (next === editorBody) return;
    changeBody(next);
    setPlatformCropPayloads((current) => { const nextPayloads = { ...current }; delete (nextPayloads as Record<string, unknown>)[assetId]; return nextPayloads; });
    setMessage('已移出本文');
  };

  const openCropAssetImage = (ref: StudioAssetImageRef) => {
    if (readOnlyVersion || busy) return;
    setImageMenuOpen(false);
    const asset = (assetById as Map<string, ContentProjectDetail['assets'][number]>).get((ref as StudioAssetImageRef).assetId);
    setCropTarget({
      assetId: (ref as StudioAssetImageRef).assetId,
      occurrence: (ref as StudioAssetImageRef).occurrence,
      alt: (ref as StudioAssetImageRef).alt,
      assetName: asset ? (asset.relativePath.split(/[/\\]/).pop() || asset.relativePath) : null
    });
  };

  const deriveCropAsset = async (input: StudioDeriveCropInput): Promise<StudioDeriveCropResult> => {
    try {
      const result = await (window.wmb as unknown as { deriveStudioAsset: (p: unknown) => Promise<{ ok: boolean; data: { assetId: string; reused: boolean; sha256: string }; error?: { message: string } }> }).deriveStudioAsset({
        sourceAssetId: input.sourceAssetId,
        cropRegion: input.cropRegion,
        pngBase64: input.pngBase64
      });
      if (result.ok) {
        return { ok: true, assetId: result.data.assetId, reused: result.data.reused, sha256: result.data.sha256, cropRegion: input.cropRegion };
      }
      return { ok: false, error: result.error?.message || '图片处理失败' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const applyCropResult = async (result: StudioCropApplyResult) => {
    const target = (params as unknown as { cropTarget: { assetId: string; occurrence: number; alt: string } | null }).cropTarget;
    if (!target || !selected) throw new Error('项目已变化，请重新打开裁切。');
    if (activePlatform) {
      const currentBindings: PlatformMediaBindingDraft[] = currentPlatformBindings as PlatformMediaBindingDraft[];
      const targetIndex = currentBindings.findIndex((binding) => binding.assetId === target.assetId);
      const nextBindings =
        targetIndex >= 0
          ? currentBindings.map((binding) => (binding.assetId === target.assetId ? { ...binding, cropRegion: result.cropRegion } : binding))
          : [...currentBindings, { assetId: target.assetId, ordinal: currentBindings.length, isCover: currentBindings.length === 0, cropRegion: result.cropRegion } as unknown as PlatformMediaBindingDraft];
      setPlatformCropPayloads((current) => ({
        ...current,
        [target.assetId]: { assetId: target.assetId, cropRegion: result.cropRegion, pngBase64: result.pngBase64 }
      }));
      (params as unknown as { updateActivePlatformDraft: (c: unknown) => void }).updateActivePlatformDraft({ mediaBindings: nextBindings });
      setMessage('已应用裁剪（保存平台版本时生效）');
    } else {
      if (!result.derivedAssetId) throw new Error('图片处理服务未返回派生图');
      const next = replaceAssetImageToken(editorBody as string, target.assetId, target.occurrence, assetImageToken(target.alt, result.derivedAssetId));
      if (next === editorBody) throw new Error('找不到要裁剪的图片');
      changeBody(next);
      syncPlatformBindingsForBody(next);
      setMessage('已裁剪并替换当前图片');
      const detail = await (window.wmb as unknown as { getStudioProject: (id: string) => Promise<ContentProjectDetail | null> }).getStudioProject((selected as ContentProjectDetail).id); if (detail) setSelected(detail);
    }
  };

  return {
    locateAssetImage, requestReplaceAssetImage, replaceAssetImage, removeAssetImage, startCaptionEdit, saveCaptionEdit, removePlatformAsset, openCropAssetImage, deriveCropAsset, applyCropResult
  };
}
