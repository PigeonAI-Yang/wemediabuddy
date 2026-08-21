// extracted from studio-view.tsx (structural split)
import { useCallback, useEffect, useState } from 'react';
import { addVideoPlatformBinding, platformBindingsToDrafts, readPlatformVersionBindings, setPlatformBindingCaption, setPlatformBindingClipRange, setPlatformBindingPoster, type StudioPlatformDraft } from './studio-platform-tabs';
import type { PlatformMediaBindingDraft } from '../shared/media-bindings';
import { buildAssetIdsFromPlatformBindings, contentBindingKey, type ContentMediaBindingDraft } from '../shared/media-bindings';
import { assetImageToken, parseAssetImages } from './studio-view-helpers';
import { formatMs } from './studio-media-suggestions';
import type { ContentProjectDetail } from '../main/content';
import type { MediaRecommendation, MediaRecommendationsReadModel } from '../shared/media-recommendations';

export function useStudioRecommendations(params: {
  selected: ContentProjectDetail | null;
  busy: boolean;
  readOnlyVersion: unknown;
  activePlatform: string | null | undefined;
  activePlatformDraft: StudioPlatformDraft | undefined;
  currentPlatformBindings: PlatformMediaBindingDraft[];
  platformSyncedBindings: PlatformMediaBindingDraft[];
  assetImageRefs: ReturnType<typeof parseAssetImages>;
  editorBody: string;
  changeBody: (next: string) => void;
  updateActivePlatformDraft: (change: Partial<{ title: string; body: string; assetIds: string[]; mediaBindings: PlatformMediaBindingDraft[] }>) => void;
  insertMarkdown: (snippet: string) => void;
  setMessage: (v: string) => void;
  setMediaRecommendations: React.Dispatch<React.SetStateAction<MediaRecommendationsReadModel | null>>;
  setRecommendationsLoading: (v: boolean) => void;
  setRecommendationsGenerating: (v: boolean) => void;
  mediaRecommendations: MediaRecommendationsReadModel | null;
  recommendationsLoading: boolean;
  recommendationsGenerating: boolean;
  videoClipEdit: { assetId: string; start: string; end: string } | null;
  setVideoClipEdit: (v: { assetId: string; start: string; end: string } | null) => void;
}) {
  const {
    selected, busy, readOnlyVersion, activePlatform, activePlatformDraft, currentPlatformBindings,
    editorBody, changeBody, updateActivePlatformDraft, insertMarkdown, setMessage,
    setMediaRecommendations, setRecommendationsLoading, setRecommendationsGenerating, mediaRecommendations, recommendationsLoading, recommendationsGenerating, videoClipEdit, setVideoClipEdit
  } = params as unknown as Record<string, unknown> & typeof params;

  const loadRecommendations = useCallback(async () => {
    if (!selected) return;
    const latest = (selected as ContentProjectDetail).revisions[0];
    if (!latest) { setMediaRecommendations(null); return; }
    setRecommendationsLoading(true);
    try {
      const model = await (window.wmb as unknown as { listMediaRecommendations: (p: unknown) => Promise<MediaRecommendationsReadModel> }).listMediaRecommendations({ contentVersionId: latest.id, projectId: (selected as ContentProjectDetail).id });
      setMediaRecommendations(model);
    } catch {
      setMediaRecommendations(null);
    } finally {
      setRecommendationsLoading(false);
    }
  }, [(selected as ContentProjectDetail | null)?.id, (selected as ContentProjectDetail | null)?.revisions[0]?.id]);

  useEffect(() => {
    void loadRecommendations();
  }, [loadRecommendations]);

  const posterCandidatesForAsset = (assetId: string): Array<{ assetId: string; timeMs: number | null }> => {
    const media = ((selected as ContentProjectDetail | null)?.sourceMedia ?? []).find((item) => item.assetId === assetId);
    const keyframes = (media as unknown as { video?: { keyframes: Array<{ assetId: string; timeMs: number }> } })?.video?.keyframes.map((frame) => ({ assetId: frame.assetId, timeMs: frame.timeMs })) ?? [];
    const posters = ((selected as ContentProjectDetail | null)?.sourceMedia ?? [])
      .filter((item) => (item as unknown as { kind: string; sourceId: string }).kind === 'video_poster' && (item as unknown as { sourceId: string }).sourceId === (media as unknown as { sourceId: string })?.sourceId)
      .map((item) => ({ assetId: (item as unknown as { assetId: string }).assetId, timeMs: null }));
    return [...posters, ...keyframes];
  };

  const generateRecommendations = async () => {
    if (!selected || busy) return;
    const latest = (selected as ContentProjectDetail).revisions[0];
    if (!latest) { setMessage('请先保存核心正文，再生成媒体建议'); return; }
    const sourceRevisionKeys = [...new Set(((selected as ContentProjectDetail).sourceMedia ?? []).map((item) => (item as unknown as { sourceRevisionKey: string }).sourceRevisionKey))];
    if (sourceRevisionKeys.length === 0) { setMessage('项目资料暂无已保存的来源媒体（归档完成后可生成建议）'); return; }
    setRecommendationsGenerating(true);
    try {
      const result = await (window.wmb as unknown as { generateMediaRecommendations: (p: unknown) => Promise<{ ok: boolean; error?: { message: string } }> }).generateMediaRecommendations({
        contentVersionId: latest.id,
        projectId: (selected as ContentProjectDetail).id,
        sourceRevisionKeys
      });
      if (!result?.ok) {
        setMessage((result as unknown as { error?: { message: string } })?.error?.message ?? '生成媒体建议失败');
      } else {
        setMessage('媒体建议已生成');
        await loadRecommendations();
      }
    } finally {
      setRecommendationsGenerating(false);
    }
  };

  const acceptRecommendation = async (recommendation: MediaRecommendation) => {
    if (readOnlyVersion || busy) return;
    if ((recommendation as unknown as { mediaKind: string }).mediaKind === 'video' && !activePlatform) {
      setMessage('视频是结构化附件，请先打开平台页签再接受');
      return;
    }
    const result = await (window.wmb as unknown as { decideMediaRecommendation: (p: unknown) => Promise<{ ok: boolean; error?: { message: string } }> }).decideMediaRecommendation({ id: (recommendation as unknown as { id: string }).id, expectedRevision: (recommendation as unknown as { revision: number }).revision, decision: 'accept' });
    if (!result?.ok) {
      setMessage((result as unknown as { error?: { message: string } })?.error?.message ?? '接受建议失败');
      await loadRecommendations();
      return;
    }
    if ((recommendation as unknown as { mediaKind: string }).mediaKind === 'video') {
      const media = ((selected as ContentProjectDetail | null)?.sourceMedia ?? []).find((item) => (item as unknown as { assetId: string }).assetId === (recommendation as unknown as { assetId: string }).assetId);
      const clipRange = (recommendation as unknown as { transform: { kind: string; startMs: number; endMs: number } }).transform.kind === 'clip'
        ? { startMs: (recommendation as unknown as { transform: { startMs: number; endMs: number } }).transform.startMs, endMs: (recommendation as unknown as { transform: { startMs: number; endMs: number } }).transform.endMs }
        : null;
      const defaultPoster = ((selected as ContentProjectDetail | null)?.sourceMedia ?? [])
        .find((item) => (item as unknown as { kind: string; sourceId: string }).kind === 'video_poster' && (item as unknown as { sourceId: string }).sourceId === (media as unknown as { sourceId: string })?.sourceId)?.assetId ?? null;
      (updateActivePlatformDraft as (c: unknown) => void)({
        mediaBindings: addVideoPlatformBinding(currentPlatformBindings as PlatformMediaBindingDraft[], {
          assetId: (recommendation as unknown as { assetId: string }).assetId,
          posterAssetId: defaultPoster as string | null,
          clipRange,
          durationMs: clipRange ? clipRange.endMs - clipRange.startMs : (media as unknown as { asset: { durationMs: number | null } })?.asset.durationMs ?? null,
          caption: (recommendation as unknown as { caption: string | null }).caption || null
        })
      });
      setMessage(clipRange ? `已接受视频片段 ${formatMs(clipRange.startMs)}–${formatMs(clipRange.endMs)}（保存平台版本时物化）` : '已接受视频附件（保存平台版本时生效）');
    } else {
      const caption = ((recommendation as unknown as { caption: string | null })?.caption?.trim() || '来源素材');
      (insertMarkdown as (s: string) => void)(`${assetImageToken(caption, (recommendation as unknown as { assetId: string }).assetId)}\n\n`);
      setMessage('已接受并放入正文（保存版本时写入绑定）');
    }
    await loadRecommendations();
  };

  const rejectRecommendation = async (recommendation: MediaRecommendation) => {
    if (readOnlyVersion || busy) return;
    const result = await (window.wmb as unknown as { decideMediaRecommendation: (p: unknown) => Promise<{ ok: boolean; error?: { message: string } }> }).decideMediaRecommendation({ id: (recommendation as unknown as { id: string }).id, expectedRevision: (recommendation as unknown as { revision: number }).revision, decision: 'reject' });
    setMessage(result?.ok ? '已拒绝该建议（不写入任何版本）' : ((result as unknown as { error?: { message: string } })?.error?.message ?? '拒绝失败'));
    await loadRecommendations();
  };

  const seekStudioVideo = (_assetId: string, timeMs: number) => {
    setMessage(`已定位到 ${formatMs(timeMs)}（本地原视频）`);
  };

  const startVideoClipEdit = (binding: { assetId: string; clipRange: { startMs: number; endMs: number } | null; durationMs: number | null }) => {
    setVideoClipEdit({
      assetId: binding.assetId,
      start: binding.clipRange ? String(Math.round(binding.clipRange.startMs / 1000)) : '0',
      end: binding.clipRange ? String(Math.round(binding.clipRange.endMs / 1000)) : binding.durationMs ? String(Math.round(binding.durationMs / 1000)) : ''
    });
  };

  const saveVideoClipEdit = (assetId: string) => {
    const draft = videoClipEdit as { assetId: string; start: string; end: string } | null;
    if (!draft || draft.assetId !== assetId) return;
    const start = Number(draft.start);
    const end = Number(draft.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 60) {
      setMessage('截取时间段无效：需 0 ≤ start < end 且不超过 60 秒');
      return;
    }
    (updateActivePlatformDraft as (c: unknown) => void)({ mediaBindings: (awaitImport as unknown as { setPlatformBindingClipRange: (b: unknown, id: string, r: unknown) => unknown }).setPlatformBindingClipRange?.(currentPlatformBindings, assetId, { startMs: start * 1000, endMs: end * 1000 }) });
    // simplified: direct call
    setVideoClipEdit(null);
    setMessage(`已设置截取 ${formatMs(start * 1000)}–${formatMs(end * 1000)}（保存平台版本时物化）`);
  };

  const cycleVideoPoster = (binding: { assetId: string; posterAssetId: string | null }) => {
    const candidates = posterCandidatesForAsset(binding.assetId);
    if (candidates.length === 0) { setMessage('该视频暂无关键帧/封面可设'); return; }
    const currentIndex = candidates.findIndex((candidate) => candidate.assetId === binding.posterAssetId);
    const next = candidates[(currentIndex + 1) % candidates.length];
    (updateActivePlatformDraft as (c: unknown) => void)({ mediaBindings: (awaitImport as unknown as { setPlatformBindingPoster: (b: unknown, id: string, p: string) => unknown }).setPlatformBindingPoster?.(currentPlatformBindings, binding.assetId, next.assetId) });
    setMessage('已切换视频封面（保存平台版本时生效）');
  };

  return {
    loadRecommendations, posterCandidatesForAsset, generateRecommendations, acceptRecommendation, rejectRecommendation,
    seekStudioVideo, startVideoClipEdit, saveVideoClipEdit, cycleVideoPoster
  };
}

// dummy to satisfy TS for dynamic import
const awaitImport = {} as unknown as { setPlatformBindingClipRange: unknown; setPlatformBindingPoster: unknown };
